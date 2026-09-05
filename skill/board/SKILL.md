---
name: board
description: 用本機「封包進度板」（畫面 http://localhost:4242）追蹤一件大工作的真實進度：宣告目標、把工作拆成封包、做的過程中用一行 curl 翻狀態，畫面即時更新。一個目標 ≒ 一個 AI 對話，對話還活著靠心跳顯示。只要使用者提到進度板、封包板、開個板、追蹤進度、把進度標上去、看板子、標記完成、標記收工，或說出「這件事拆一下追蹤」這類意思，都要用這個 skill。接到跨多波次、拆得出十幾件以上可獨立驗證的事的大工程（模組對齊、功能重構、全面盤點）時，主動問使用者要不要開板——但不要默默建。不要只在聊天室裡口頭回報進度，那些留不下來也看不到。
argument-hint: 目標代號或要追蹤的工作描述（可省略）
user-invocable: true
---

# 封包進度板

本機即時進度追蹤工具，零 npm 依賴，畫面 <http://localhost:4242>。

**權威說明是專案根目錄的 `USAGE.md`**，這份 skill 是它的跨專案摘要。那邊的功能改了，
這裡要跟著更新；操作細節有疑慮就去讀那份。

> 安裝時把下面的 `<BOARD_DIR>` 換成你自己 clone 的路徑（例如 `C:\tools\board`
> 或 `~/code/board`），這份指南裡出現的每一處都要換。

## 什麼時候用

- **使用者明講就用**：提到進度板、開個板、追蹤進度、標上去、標記收工。
- **大工程先問一句**：接到跨多波次、拆得出十幾件以上可獨立驗證的事的工作（模組對齊、
  功能重構、全面盤點），問「要不要開個板追蹤」再動手。
- **小工作不要建板**。改一支 CSS、修一個 bug 建板只會在畫面上留垃圾。使用者得自己在
  畫面右上角「封存」裡清那些東西，很煩。

## 先確認 server 活著

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:4242/api/boards
```

回 `200` 就是活的，跳過下一步。回 `000` 是連不上（server 沒在跑），不是指令壞了。

沒在跑才啟動。cwd 通常不是 board 專案，所以路徑寫絕對：

```bash
# macOS / Linux / Git Bash
cd <BOARD_DIR> && nohup node server.mjs > /tmp/board.log 2>&1 &
```

```powershell
# Windows PowerShell：nohup、disown 在這裡都不存在，不要貼上面那條
Start-Process node -ArgumentList "server.mjs" -WorkingDirectory "<BOARD_DIR>" -WindowStyle Hidden
```

`start.cmd` 是給使用者自己雙擊的（前景執行、結尾有 pause），**你不要跑它**，會把你的 shell 卡住。

## 開工前先看已經有哪些目標，別重複建

```bash
curl -s http://localhost:4242/api/boards
```

同一件工作可能上一個對話已經開過板了——**接續既有的，不要開第二個**。看到相近的標題
就讀完整內容確認：`curl -s http://localhost:4242/api/board/<代號>`。

## 宣告一個目標

一個 board = 一件有明確範圍的大工作。代號用 `<模組>-<主題>`，英文小寫 kebab-case，
例如 `search-rewrite`、`auth-cleanup`、`docs-i18n`。

```bash
curl -X PUT http://localhost:4242/api/board/<代號> \
  -H "Content-Type: application/json" \
  -d '{
    "title": "這個目標的名稱",
    "groups": [{ "id": "wave1", "label": "第一波：盤點" }],
    "packets": [
      { "id": "t1", "group": "wave1", "type": "research", "status": "todo", "title": "盤點舊版行為" }
    ]
  }'
```

PowerShell：

```powershell
Invoke-RestMethod -Uri "http://localhost:4242/api/board/<代號>" -Method Put -ContentType "application/json" -Body '{"title":"...","groups":[...],"packets":[...]}'
```

## 一個封包 = 一件「能被獨立驗證完成」的事

判準不是碰了幾個檔案：

- 幾個檔案一起改才有意義（改一半驗不出東西）→ **維持一個封包**
- 每一片都能單獨驗證完成 → **拆成多片，共用同一個 `frag`**

同 `frag` 的片段畫面會用一條底線串成一組，底線本身就是那組的進度條（完成染綠、
進行中染黃，下方標 `F1 2/3`）。片段在 `packets` 陣列裡不必相鄰。

## 做的過程中翻狀態——不是在聊天室裡口頭說做完了

```bash
curl "http://localhost:4242/api/set?board=<代號>&id=<封包id>&status=active"
# ...實際做、實際驗證...
curl "http://localhost:4242/api/set?board=<代號>&id=<封包id>&status=done"
```

中途發現新的待辦：

```bash
curl "http://localhost:4242/api/add?board=<代號>&id=<新id>&type=<類型>&title=<標題>&group=<分組id>"
```

## 一個目標 ≒ 一個對話：心跳與收工

畫面用心跳判斷這個對話還在不在，燈是 **綠＝15 分鐘內有心跳**、**黃＝閒置 N 分**、
**灰＝已收工**。

- 翻狀態、加封包、宣告目標**都會自動蓋心跳**，不用另外做事。
- 一整回合都沒動到任何封包（純討論、純讀 code）才手動打一下，否則畫面會以為對話停了：
  `curl "http://localhost:4242/api/session?board=<代號>"`
- 這個對話要結束、或使用者說收工了：
  `curl "http://localhost:4242/api/session?board=<代號>&state=ended"`

心跳刻意不動 `updatedAt`——那欄位代表「進度最後一次真的變了」。

## 資料模型

| 欄位 | 值 | 決定什麼 |
|---|---|---|
| `type` | `infra` `api` `bug` `test` `research` `data` `ui` | 方塊顏色 |
| `status` | `todo` `active` `half` `done` `blocked` `skipped` | 方塊外觀（空框／脈動／半填／實心／斜紋／點線框） |
| `frag` | 自訂字串，例如 `"F1"` | 同一件事拆成多片時共用同一個值，畫面用底線串成一組 |

## 唯一的硬規則：board 要反映真實狀態

- 正在做才標 `active`，做完**且驗證過**才標 `done`。不要為了好看先標。
- 不確定某件事有沒有做完，就標 `todo` 或 `blocked`，不要猜。
- 不需要做了標 `skipped`（暫緩），不要偷偷把它標成 done。
- 這個板是給人看「現在真正進度」的，不是任務清單的裝飾品。

## 端點總覽

| 方法 | 路徑 | 用途 |
|---|---|---|
| GET | `/api/boards` | 列出所有目標＋進度摘要 |
| GET | `/api/board/:id` | 讀單一目標完整內容 |
| PUT | `/api/board/:id` | 宣告／整批覆寫一個目標 |
| GET | `/api/set?board=&id=&status=` | 翻轉單一封包狀態（熱路徑） |
| GET | `/api/add?board=&id=&type=&title=&group=` | 新增一個封包 |
| GET | `/api/session?board=&state=live\|ended` | 對話心跳／標記收工（`state` 預設 `live`） |
| DELETE | `/api/board/:id` | 封存目標（移到 `boards/archive/`） |
| GET | `/api/archive` | 列出封存的目標 |
| POST | `/api/archive/:id/restore` | 把封存的目標搬回進行中 |
| DELETE | `/api/archive/:id` | **永久刪除**封存的目標（檔案直接消失） |

封存的還原與刪除，使用者在畫面右上角「封存」按鈕裡自己操作（刪除要按兩下確認）。
**不要主動幫他封存或刪除任何目標**，除非他明講要刪哪一個。
