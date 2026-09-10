// 封包進度板 · 本機 server，零 npm 依賴（只用 Node 內建模組）
// 啟動：node server.mjs（或雙擊 start.ps1）

import { createServer } from "node:http";
import {
  readFile,
  writeFile,
  readdir,
  mkdir,
  rename,
  unlink,
} from "node:fs/promises";
import { watch } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOARDS_DIR = join(__dirname, "boards");
const ARCHIVE_DIR = join(BOARDS_DIR, "archive");
const PUBLIC_DIR = join(__dirname, "public");
const PORT = Number(process.env.PORT) || 4242;

const TYPES = new Set([
  "infra",
  "api",
  "bug",
  "test",
  "research",
  "data",
  "ui",
]);
const STATUSES = new Set([
  "todo",
  "active",
  "half",
  "done",
  "blocked",
  "skipped",
]);
// 一個目標 ≒ 一個 AI 對話。live 代表對話還開著，ended 代表已收工。
// 「閒置」不寫進檔案，由畫面依 beatAt 距現在多久自己推出來
const SESSION_STATES = new Set(["live", "ended"]);

// ---------- 小工具 ----------

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Windows 繁中的 shell（cmd、非 UTF-8 的 PowerShell 主機）會把中文以 Big5 送出，
// 硬用 UTF-8 解就變成一串 U+FFFD 且救不回來——所以先驗 UTF-8，不合法才退回 Big5。
// 這是自動的，呼叫端不用做任何事、也不用記得指定編碼
function decodeText(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("big5").decode(bytes);
    } catch {
      return bytes.toString("utf8");
    }
  }
}

// new URL() 會在解析階段就把非 UTF-8 的 %XX 序列吃成 U+FFFD，
// 位元組拿不回來，所以 query 自己從 raw url 解一次
function percentToText(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "%") {
      const hex = s.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    if (c === "+") {
      bytes.push(0x20);
      continue;
    }
    bytes.push(s.charCodeAt(i) & 0xff); // req.url 是 latin1 語意
  }
  return decodeText(Buffer.from(bytes));
}

function queryOf(rawUrl) {
  const at = rawUrl.indexOf("?");
  const out = new Map();
  if (at === -1) return out;
  for (const pair of rawUrl.slice(at + 1).split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = eq === -1 ? pair : pair.slice(0, eq);
    const v = eq === -1 ? "" : pair.slice(eq + 1);
    const key = percentToText(k);
    if (!out.has(key)) out.set(key, percentToText(v));
  }
  return out;
}

function safeId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw httpError(400, `board id 格式不對：${id}`);
  }
  return id;
}

function boardPath(id, dir = BOARDS_DIR) {
  return join(dir, `${safeId(id)}.json`);
}

// 同一個 board 檔案的讀寫排成一條隊列，避免併發寫入互相覆蓋
const locks = new Map();
function withLock(id, task) {
  const prior = locks.get(id) || Promise.resolve();
  const result = prior.then(task, task);
  locks.set(
    id,
    result.then(
      () => {},
      () => {},
    ),
  );
  return result;
}

async function readBoard(id, dir = BOARDS_DIR) {
  let raw;
  try {
    raw = await readFile(boardPath(id, dir), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") throw httpError(404, `找不到目標「${id}」`);
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(500, `目標「${id}」的檔案 JSON 格式壞掉了`);
  }
}

// 翻狀態、加封包本身就是「對話還活著」的證據，順手蓋一次心跳，
// 這樣就算 AI 忘了打 /api/session，燈也不會誤報成閒置
function touchSession(data) {
  data.session = {
    ...(data.session || {}),
    state: "live",
    beatAt: new Date().toISOString(),
  };
}

async function writeBoard(id, data) {
  await mkdir(BOARDS_DIR, { recursive: true });
  await writeFile(boardPath(id), JSON.stringify(data, null, 2), "utf8");
}

async function listBoardIds(dir = BOARDS_DIR) {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name.slice(0, -5));
}

function summarize(id, board) {
  const packets = Array.isArray(board.packets) ? board.packets : [];
  const live = packets.filter((p) => p.status !== "skipped");
  const done = live.filter((p) => p.status === "done").length;
  const active = live.filter(
    (p) => p.status === "active" || p.status === "half",
  ).length;
  const pct = live.length ? Math.round((done / live.length) * 100) : 0;
  return {
    id,
    title: board.title || id,
    updatedAt: board.updatedAt || null,
    session: board.session || null,
    pct,
    total: packets.length,
    done,
    active,
    todo: live.length - done - active,
    packets: packets.map((p) => ({
      id: p.id,
      type: p.type,
      status: p.status,
    })),
  };
}

// ---------- SSE 廣播 ----------

const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

function handleEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  clients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clients.delete(res);
    }
  }, 25000);
  req.on("close", () => {
    clients.delete(res);
    clearInterval(heartbeat);
  });
}

// 外部直接編輯 boards/*.json（例如我用 Edit 工具改檔案）時，
// 用檔案監看抓到變化並推播，不用等下一次 HTTP 呼叫
const debounceTimers = new Map();
function watchBoards() {
  watch(BOARDS_DIR, { persistent: true }, (_eventType, filename) => {
    if (!filename || !filename.endsWith(".json")) return;
    const id = filename.slice(0, -5);
    clearTimeout(debounceTimers.get(id));
    debounceTimers.set(
      id,
      setTimeout(async () => {
        try {
          const board = await readBoard(id);
          broadcast("board-replaced", { board: id, data: board });
        } catch {
          broadcast("board-removed", { board: id });
        }
      }, 150),
    );
  });
}

// ---------- 靜態檔 ----------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function serveStatic(res, filePath) {
  try {
    const data = await readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf("."));
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(
          chunks.length
            ? JSON.parse(decodeText(Buffer.concat(chunks)))
            : {},
        );
      } catch {
        reject(httpError(400, "body 不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

// ---------- API ----------

async function apiListBoards() {
  const ids = await listBoardIds();
  const boards = [];
  for (const id of ids) {
    try {
      boards.push(summarize(id, await readBoard(id)));
    } catch {
      // 壞掉的檔案先跳過，不要讓整個列表掛掉
    }
  }
  // 最近更新的排最前面，讓正在動的目標自然浮上來，不用另外設定「預設目標」
  boards.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return boards;
}

async function apiSet(q, res) {
  const board = q.get("board");
  const id = q.get("id");
  const status = q.get("status");
  if (!board || !id || !status) {
    throw httpError(400, "board、id、status 為必填");
  }
  if (!STATUSES.has(status)) {
    throw httpError(400, `status 必須是：${[...STATUSES].join(" / ")}`);
  }

  const packet = await withLock(board, async () => {
    const data = await readBoard(board);
    const p = (data.packets || []).find((x) => x.id === id);
    if (!p) throw httpError(404, `board「${board}」裡找不到封包「${id}」`);
    p.status = status;
    const detail = q.has("detail") ? q.get("detail") : null;
    if (detail !== null) p.detail = detail;
    touchSession(data);
    data.updatedAt = new Date().toISOString();
    await writeBoard(board, data);
    return p;
  });

  broadcast("packet-set", { board, packet });
  json(res, { ok: true, packet });
}

async function apiAdd(q, res) {
  const board = q.get("board");
  const id = q.get("id");
  const type = q.get("type");
  const title = q.get("title");
  const group = q.get("group");
  if (!board || !id || !type || !title || !group) {
    throw httpError(400, "board、id、type、title、group 為必填");
  }
  if (!TYPES.has(type)) {
    throw httpError(400, `type 必須是：${[...TYPES].join(" / ")}`);
  }
  const status = q.get("status") || "todo";
  if (!STATUSES.has(status)) {
    throw httpError(400, `status 必須是：${[...STATUSES].join(" / ")}`);
  }
  const groupLabel = q.get("groupLabel");
  const frag = q.get("frag") || undefined;
  const detail = q.get("detail") || undefined;

  const packet = await withLock(board, async () => {
    const data = await readBoard(board);
    data.packets ??= [];
    data.groups ??= [];
    if (data.packets.some((p) => p.id === id)) {
      throw httpError(409, `封包 id「${id}」已經存在`);
    }
    if (!data.groups.some((g) => g.id === group)) {
      data.groups.push({ id: group, label: groupLabel || group });
    }
    const p = { id, group, type, status, title };
    if (frag) p.frag = frag;
    if (detail) p.detail = detail;
    data.packets.push(p);
    touchSession(data);
    data.updatedAt = new Date().toISOString();
    await writeBoard(board, data);
    return p;
  });

  broadcast("packet-added", { board, packet });
  json(res, { ok: true, packet });
}

async function apiPutBoard(req, res, id) {
  const body = await readJsonBody(req);
  if (!body || typeof body !== "object") {
    throw httpError(400, "body 必須是 JSON 物件");
  }
  if (!Array.isArray(body.packets)) {
    throw httpError(400, "packets 必須是陣列");
  }
  if (!Array.isArray(body.groups)) body.groups = [];
  touchSession(body);
  body.updatedAt = new Date().toISOString();

  await withLock(id, () => writeBoard(id, body));

  broadcast("board-replaced", { board: id, data: body });
  json(res, { ok: true });
}

// 對話狀態：AI 每回合打一次當心跳，收工時帶 state=ended
async function apiSession(q, res) {
  const board = q.get("board");
  if (!board) throw httpError(400, "board 為必填");
  const state = q.get("state") || "live";
  if (!SESSION_STATES.has(state)) {
    throw httpError(400, `state 必須是：${[...SESSION_STATES].join(" / ")}`);
  }
  const label = q.has("label") ? q.get("label") : null;

  const session = await withLock(board, async () => {
    const data = await readBoard(board);
    touchSession(data);
    data.session.state = state;
    if (label !== null) data.session.label = label;
    // 心跳刻意不動 updatedAt：那欄位代表「進度最後一次真的變了」，卡片排序也吃它
    await writeBoard(board, data);
    return data.session;
  });

  broadcast("session-set", { board, session });
  json(res, { ok: true, session });
}

async function apiArchiveBoard(res, id) {
  await mkdir(ARCHIVE_DIR, { recursive: true });
  await withLock(id, async () => {
    try {
      await rename(boardPath(id), boardPath(id, ARCHIVE_DIR));
    } catch (err) {
      if (err.code === "ENOENT") throw httpError(404, `找不到目標「${id}」`);
      throw err;
    }
  });
  broadcast("board-removed", { board: id });
  broadcast("archive-changed", { board: id, action: "archived" });
  json(res, { ok: true });
}

async function apiListArchive() {
  const ids = await listBoardIds(ARCHIVE_DIR);
  const boards = [];
  for (const id of ids) {
    try {
      boards.push(summarize(id, await readBoard(id, ARCHIVE_DIR)));
    } catch {
      // 壞掉的檔案先跳過，不要讓整個列表掛掉
    }
  }
  boards.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return boards;
}

async function apiRestoreBoard(res, id) {
  await withLock(id, async () => {
    // 同代號的目標還在進行中就不要蓋掉它
    try {
      await readFile(boardPath(id), "utf8");
      throw httpError(409, `目標「${id}」已經在進行中的列表裡了`);
    } catch (err) {
      if (err.status) throw err;
      if (err.code !== "ENOENT") throw err;
    }
    try {
      await rename(boardPath(id, ARCHIVE_DIR), boardPath(id));
    } catch (err) {
      if (err.code === "ENOENT") throw httpError(404, `封存區裡找不到「${id}」`);
      throw err;
    }
  });
  broadcast("archive-changed", { board: id, action: "restored" });
  json(res, { ok: true });
}

// 真的刪掉檔案，救不回來——畫面上要二次確認過才會打到這裡
async function apiDeleteArchived(res, id) {
  await withLock(id, async () => {
    try {
      await unlink(boardPath(id, ARCHIVE_DIR));
    } catch (err) {
      if (err.code === "ENOENT") throw httpError(404, `封存區裡找不到「${id}」`);
      throw err;
    }
  });
  broadcast("archive-changed", { board: id, action: "deleted" });
  json(res, { ok: true });
}

// ---------- 路由 ----------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    if (req.method === "GET" && pathname === "/") {
      return serveStatic(res, join(PUBLIC_DIR, "index.html"));
    }
    if (req.method === "GET" && pathname.startsWith("/b/")) {
      // 單頁應用：/b/:id 跟 / 是同一個檔案，選中哪個 board 由前端 JS 讀 URL 決定
      return serveStatic(res, join(PUBLIC_DIR, "index.html"));
    }
    if (req.method === "GET" && pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "GET" && pathname === "/events") {
      return handleEvents(req, res);
    }

    if (req.method === "GET" && pathname === "/api/boards") {
      return json(res, await apiListBoards());
    }
    if (req.method === "GET" && pathname === "/api/set") {
      return await apiSet(queryOf(req.url), res);
    }
    if (req.method === "GET" && pathname === "/api/add") {
      return await apiAdd(queryOf(req.url), res);
    }
    if (req.method === "GET" && pathname === "/api/session") {
      return await apiSession(queryOf(req.url), res);
    }
    if (req.method === "GET" && pathname === "/api/archive") {
      return json(res, await apiListArchive());
    }

    const restoreMatch = pathname.match(/^\/api\/archive\/([^/]+)\/restore$/);
    if (restoreMatch && req.method === "POST") {
      return await apiRestoreBoard(res, decodeURIComponent(restoreMatch[1]));
    }
    const archivedMatch = pathname.match(/^\/api\/archive\/([^/]+)$/);
    if (archivedMatch && req.method === "DELETE") {
      return await apiDeleteArchived(res, decodeURIComponent(archivedMatch[1]));
    }

    const boardMatch = pathname.match(/^\/api\/board\/([^/]+)$/);
    if (boardMatch) {
      const id = decodeURIComponent(boardMatch[1]);
      if (req.method === "GET") return json(res, await readBoard(id));
      if (req.method === "PUT") return await apiPutBoard(req, res, id);
      if (req.method === "DELETE") return await apiArchiveBoard(res, id);
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (err) {
    const status = err.status || 500;
    json(res, { error: err.message || "internal error" }, status);
  }
});

server.listen(PORT, () => {
  console.log(`封包進度板已啟動 → http://localhost:${PORT}`);
});

watchBoards();
