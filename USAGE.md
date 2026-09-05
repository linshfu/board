# 封包進度板 — 給 AI 看的使用說明

本機即時進度追蹤工具。畫面：http://localhost:4242

## 先確認伺服器活著

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:4242/api/boards
```

回 `200` 就是活的，跳過下一步。回 `000` 是連不上（server 沒在跑），**不是指令壞了**。
這條 PowerShell 和 Git Bash 都能跑，用的是 Windows 內建的 `curl.exe`。

沒在跑才啟動。**PowerShell（預設終端）用這條**：

```powershell
Start-Process node -ArgumentList "server.mjs" -WorkingDirectory "<BOARD_DIR>" -WindowStyle Hidden
```

**只有 Git Bash 能用下面這條** —— `nohup`、`disown` 在 PowerShell 不存在，`<BOARD_DIR>` 這種 POSIX 路徑
也不是 Windows 認得的寫法，貼到 PowerShell 一定壞：

```bash
cd <BOARD_DIR> && nohup node server.mjs > /tmp/board.log 2>&1 &
disown
```

（Windows 雙擊 `start.cmd` 也可以，server 跑在那個視窗裡，關掉視窗就停。）

## 開工前先看已經有哪些目標，別重複建立

```bash
curl -s http://localhost:4242/api/boards
```

## 宣告一個目標（board）

一個 board = 一件有明確範圍的大工作。把預計要做的事拆成「封包」（packet）列出來：

```bash
curl -X PUT http://localhost:4242/api/board/<代號> \
  -H "Content-Type: application/json" \
  -d '{
    "title": "這個目標的名稱",
    "groups": [{ "id": "wave1", "label": "第一波" }],
    "packets": [
      { "id": "t1", "group": "wave1", "type": "test", "status": "todo", "title": "補測試" }
    ]
  }'
```

PowerShell：

```powershell
Invoke-RestMethod -Uri "http://localhost:4242/api/board/<代號>" -Method Put -ContentType "application/json" -Body '{"title":"...","groups":[...],"packets":[...]}'
```

## 做事的時候，用一行指令翻狀態——不是在聊天室裡口頭說做完了

```bash
curl "http://localhost:4242/api/set?board=<代號>&id=<封包id>&status=active"
# ...實際做、實際驗證...
curl "http://localhost:4242/api/set?board=<代號>&id=<封包id>&status=done"
```

PowerShell：

```powershell
irm "http://localhost:4242/api/set?board=<代號>&id=<封包id>&status=done"
```

## 讓畫面知道這個對話還活著

**一個目標 ≒ 一個 AI 對話。** 畫面用心跳判斷這個對話還在不在：

- 翻狀態（`/api/set`）、加封包（`/api/add`）、宣告目標（`PUT`）都會自動蓋一次心跳，不用另外做事。
- 一整回合都沒動到任何封包（純討論、純讀 code）就手動打一下，否則畫面會以為你停了：

```bash
curl "http://localhost:4242/api/session?board=<代號>"
```

- 這個對話要結束了，明確收工：

```bash
curl "http://localhost:4242/api/session?board=<代號>&state=ended"
```

畫面上的燈：**綠色＝15 分鐘內有心跳**、**黃色＝超過 15 分鐘沒動作（閒置 N 分）**、**灰色＝已收工**。
心跳刻意不動 `updatedAt`——那欄位代表「進度最後一次真的變了」。

## 中途發現新的待辦

```bash
curl "http://localhost:4242/api/add?board=<代號>&id=<新id>&type=<類型>&title=<標題>&group=<分組id>"
```

## 資料模型

| 欄位 | 值 | 決定什麼 |
|---|---|---|
| `type` | `infra` `api` `bug` `test` `research` `data` `ui` | 方塊顏色 |
| `status` | `todo` `active` `half` `done` `blocked` `skipped` | 方塊外觀 |
| `frag` | 自訂字串，例如 `"F1"` | 同一件事拆成多片時共用同一個值，畫面會用一條底線把它們串成一組 |

`frag` 的底線本身就是那一組的進度條：完成的比例染綠、進行中染黃，底線下面標 `F1 2/3`。
組裡只要有一片在進行中，整條底線會亮起來。片段在 `packets` 陣列裡不用相鄰，同 `frag` 就會收成同一組。

**一個封包 = 一件「能被獨立驗證完成」的事。** 判準不是碰了幾個檔案：

- 幾個檔案一起改才有意義（改一半驗不出東西）→ 維持一個封包
- 每一片都能單獨驗證完成 → 拆成多片，共用同一個 `frag`

## 唯一的硬規則：board 要反映真實狀態

- 正在做才標 `active`，做完且驗證過才標 `done`。不要為了好看先標。
- 不確定某件事有沒有做完，就標 `todo` 或 `blocked`，不要猜。
- 這個 board 是給人看「現在真正進度」的，不是任務清單的裝飾品。

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
| DELETE | `/api/archive/:id` | **永久刪除**封存的目標（檔案直接消失，救不回來） |

封存的還原與刪除，畫面右上角「封存」按鈕裡就能操作，刪除要按兩下確認。
不要主動幫使用者刪東西——那是他自己按的。

想看完整的寫法，直接讀附的示範板：`boards/example.json`（含各種 `type`、`status`，以及 `frag` 拆片的用法）。
