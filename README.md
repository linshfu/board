# 封包進度板

給 AI 對話用的本機即時進度板。零 npm 依賴，一個 `node server.mjs` 就跑起來。

## 這是要解決什麼

叫 AI 做一件跨好幾天、拆得出十幾件事的大工程時，進度只存在於聊天室的文字裡：
往上捲才找得到、關掉對話就沒了、而且「做完了」是 AI 自己說的，沒有痕跡。

這個工具把進度搬出聊天室：AI 開工前把工作拆成一格一格的**封包**，做的過程中用一行
`curl` 翻狀態，瀏覽器畫面即時跟著變。你不用讀完整段對話，瞄一眼就知道現在做到哪、
哪幾件卡住、這個對話還活著沒。

## 特色

- **零依賴** — `server.mjs` 只用 Node 內建模組，沒有 `package.json`，不用 `npm install`。
- **單檔前端** — `public/index.html` 一個檔案，無框架、無 build step。
- **檔案就是資料庫** — 一個目標一個 JSON，可以直接用編輯器改、可以進版控、可以手動備份。
- **即時更新** — 後端 `fs.watch` 監看檔案 + SSE 推播，改檔案畫面就跟著動，不用重整。
- **心跳燈號** — 一個目標 ≒ 一個 AI 對話。綠燈＝15 分內有動作、黃燈＝閒置、灰燈＝已收工。
- **AI 友善的 API** — 熱路徑（翻狀態、加封包）都是 GET，AI 打一行 `curl` 就好。

## 跑起來

需要 Node.js 18+（用到 `node:fs/promises`、內建 `fetch` 世代的 API）。

```bash
git clone https://github.com/linshfu/board.git
cd board
node server.mjs
```

打開 <http://localhost:4242>。Windows 也可以直接雙擊 `start.cmd`。
單一目標的直接連結是 `/b/<代號>`，例如 <http://localhost:4242/b/example>。

換 port：`PORT=8080 node server.mjs`。

第一次跑會看到附的 `boards/example.json` 示範板——各種 `type`、`status`、
以及 `frag` 把一件事拆成多片的畫面長怎樣，都在那張板子上。

## 資料模型

一個 **board**（目標）= 一件有明確範圍的大工作，底下切成幾個 **group**（波次），
每個波次裝若干 **packet**（封包）。

| 欄位 | 值 | 決定什麼 |
|---|---|---|
| `type` | `infra` `api` `bug` `test` `research` `data` `ui` | 方塊顏色 |
| `status` | `todo` `active` `half` `done` `blocked` `skipped` | 方塊外觀（空框／脈動／半填／實心／斜紋／點線框） |
| `frag` | 自訂字串，例如 `"F1"` | 同一件事拆成多片時共用同一個值，畫面用一條底線把它們串成一組，底線本身就是那組的進度條 |

**一個封包 = 一件「能被獨立驗證完成」的事**，判準不是碰了幾個檔案：幾個檔案得一起改
才驗得出東西 → 維持一個封包；每一片都能單獨驗證 → 拆成多片、共用同一個 `frag`。

## API

| 方法 | 路徑 | 用途 |
|---|---|---|
| GET | `/api/boards` | 列出所有目標＋進度摘要 |
| GET | `/api/board/:id` | 讀單一目標完整內容 |
| PUT | `/api/board/:id` | 宣告／整批覆寫一個目標 |
| GET | `/api/set?board=&id=&status=` | 翻轉單一封包狀態（熱路徑） |
| GET | `/api/add?board=&id=&type=&title=&group=` | 新增一個封包 |
| GET | `/api/session?board=&state=live\|ended` | 對話心跳／標記收工 |
| GET | `/events` | SSE，畫面靠這條即時更新 |
| DELETE | `/api/board/:id` | 封存目標（移到 `boards/archive/`） |
| GET | `/api/archive` | 列出封存的目標 |
| POST | `/api/archive/:id/restore` | 把封存的目標搬回進行中 |
| DELETE | `/api/archive/:id` | 永久刪除封存的目標 |

宣告一個目標：

```bash
curl -X PUT http://localhost:4242/api/board/demo \
  -H "Content-Type: application/json" \
  -d '{
    "title": "示範目標",
    "groups": [{ "id": "wave1", "label": "第一波" }],
    "packets": [
      { "id": "t1", "group": "wave1", "type": "test", "status": "todo", "title": "補測試" }
    ]
  }'
```

做的時候翻狀態：

```bash
curl "http://localhost:4242/api/set?board=demo&id=t1&status=active"
# ...實際做、實際驗證...
curl "http://localhost:4242/api/set?board=demo&id=t1&status=done"
```

寫入同一個 board 檔案的請求會排成隊列處理，不會併發互相蓋掉。

## 讓 AI 會用它

`skill/board/SKILL.md` 是給 AI 讀的使用指南。用 Claude Code 的話複製過去就生效：

```bash
cp -r skill/board ~/.claude/skills/board
```

其他 AI 工具（Cursor、Copilot…）指南該放哪才生效，各家不一樣——把那份 Markdown
交給你的 AI，叫它放到自己會讀到的位置。

`USAGE.md` 是更完整的操作說明，SKILL.md 是它的摘要版。

## 為什麼進度板的內容不進版控

`.gitignore` 把 `boards/*.json` 排除掉了（只留 `example.json`）。那些是各自機器上的
真實工作紀錄，通常帶著公司內部的專案名稱與細節，不該跟著程式碼一起公開。

## License

MIT
