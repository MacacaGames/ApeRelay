# 搬磚猿（ApeRelay）

搬磚猿是一個自架訊息轉發服務：LINE / Discord → Slack。

```
LINE 群組 / 官方帳號  ──→
                          ApeRelay (Docker)  ──→  Slack #external-message-alert
Discord 指定頻道      ──→
```

---

## 事前準備

確認本機已安裝：

- [Node.js 20+](https://nodejs.org/)
- [Docker](https://docs.docker.com/get-docker/) + Docker Compose

---

## 第一步：取得必要的 Token 與 Secret

### Slack Bot

1. 前往 [Slack API Apps](https://api.slack.com/apps) → **Create New App** → From scratch
2. **OAuth & Permissions** → Scopes → Bot Token Scopes → 新增 `chat:write`
3. **Install App to Workspace** → 複製 **Bot User OAuth Token**（格式：`xoxb-...`）
4. 把 Bot 加入目標頻道：在 Slack 頻道內輸入 `/invite @你的Bot名稱`
5. 之後想發到哪個頻道，只要把 Bot 加進去就好，不需要重新建立 webhook

> **好處**：一個 Bot Token 可以發到任何已邀請的頻道，未來分流到不同頻道只要把 Bot 加入該頻道即可。

### LINE Messaging API

1. 前往 [LINE Developers Console](https://developers.line.biz/)
2. 建立 Provider → 建立 **Messaging API channel**
3. Basic settings → 複製 **Channel secret**
4. Messaging API → 複製 **Channel access token**（長期有效）
5. Webhook URL 設為：`https://your-domain.com/webhook/line`
6. 開啟 **Use webhook**；關閉 **Auto-reply messages**

### Discord Bot

1. 前往 [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. Bot → **Reset Token** → 複製 token
3. Bot → 開啟 **Message Content Intent**（必要，才能讀取訊息內容）
4. OAuth2 → URL Generator → Scopes: `bot` → Bot Permissions: `Read Messages/View Channels`、`Read Message History`
5. 用產生的邀請連結把 Bot 加入指定 Server
6. 複製要監聽的 Guild ID 與 Channel ID（Developer Mode 下右鍵頻道可複製）

---

## 第二步：設定環境變數

```bash
cp .env.example .env
```

編輯 `.env`，填入上面取得的值：

```env
PORT=3000
PUBLIC_BASE_URL=https://relay.example.com   # 你的對外網址（LINE webhook 需要 HTTPS）

SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_DEFAULT_CHANNEL="#external-message-alert"    # 若值以 # 開頭，請加雙引號

LINE_CHANNEL_SECRET=你的_channel_secret
LINE_CHANNEL_ACCESS_TOKEN=你的_access_token

DISCORD_BOT_TOKEN=你的_bot_token
DISCORD_ALLOWED_GUILD_IDS=Guild的雪花ID        # 多個用逗號分隔
DISCORD_ALLOWED_CHANNEL_IDS=Channel的雪花ID   # 多個用逗號分隔

TIMEZONE=Asia/Taipei
LOG_LEVEL=info
```

> LINE 目前可先留空；留空時 LINE webhook 會自動停用，不影響服務運行與 Discord 轉發。

> ⚠️ `.env` 已列入 `.gitignore`，絕對不要 commit 進 Git。
>
> 補充：直接執行 [test.sh](test.sh) 時，如果 `.env` 不存在，腳本也會自動從 `.env.example` 建立一份。
>
> 注意：`.env` 中如果值以 `#` 開頭，必須加上雙引號，不然會被當成註解。例如 `SLACK_DEFAULT_CHANNEL="#external-message-alert"`。

---

## 第三步：啟動服務

### 本機開發

```bash
npm install
npm run dev
```

### Docker（可選，正式部署再用）

```bash
docker compose up -d --build
docker compose logs -f
```

服務預設監聽 `http://localhost:3000`。

### GHCR（M5 第一版）

已提供 GitHub Actions workflow：[.github/workflows/ghcr.yml](.github/workflows/ghcr.yml)

- push 到 `master` / `main` 會自動 build 並推送 image 到 GHCR
- 打 tag（例如 `v0.5.0`）會產生對應版本 tag
- PR 只 build 不 push

Image 名稱格式：

```bash
ghcr.io/<github-owner>/<repo>
```

例如：

```bash
ghcr.io/macacagames/aperelay:master
ghcr.io/macacagames/aperelay:latest
ghcr.io/macacagames/aperelay:v0.5.0
```

首次使用請確認：

1. Repository 的 Actions 有啟用
2. Repository 的 package 權限允許推送到 GHCR
3. 若要讓 Unraid 可直接拉取，將 GHCR package visibility 設為可讀（public 或授權 token）

Unraid 部署建議：

1. 在 Unraid Container 設定 image：`ghcr.io/<github-owner>/<repo>:vX.Y.Z`
2. 環境變數直接在 Unraid UI 設定（不要寫入 repo）
3. 掛載資料目錄保存規則檔（例如 `data/relay-rules.json`）
4. 先固定版本 tag，驗證後再升級到新 tag，方便回滾

---

## 第四步：驗證 Slack 轉發是否正常

```bash
./test.sh
```

腳本會：

1. 若 `http://localhost:3000` 尚未啟動，會自動用 Node.js 啟動 app
2. 呼叫 `GET /health`，確認服務存活
3. 呼叫 `POST /webhook/test-slack`，送出一筆測試訊息

如果 `.env` 還不存在，腳本會先自動建立；但若裡面仍是 placeholder，Slack 轉發測試仍會失敗，這是正常的。

正常輸出：

```
→ ApeRelay Start + Verify — http://localhost:3000
----------------------------------------
✓ 服務已啟動（Node.js）

→ GET /health
  {"status":"ok","uptime":12}
✓ Health OK

→ POST /webhook/test-slack
  {"ok":true,"message":"Test notification sent to Slack."}
✓ Slack 測試通知已送出

→ 完成。請確認 Slack 頻道是否收到測試訊息。
```

如果要對遠端服務測試：

```bash
BASE_URL=https://relay.example.com ./test.sh
```

---

## API Endpoints

| Method | Path | 說明 |
|--------|------|------|
| `GET` | `/health` | 存活確認，回傳 `{ status, uptime }` |
| `POST` | `/webhook/line` | LINE Messaging API Webhook 接收端 |
| `POST` | `/webhook/test-slack` | 手動觸發 Slack 測試通知 |
| `GET` | `/admin` | Web Admin 管理介面 |
| `GET` | `/api/admin/discord-rules` | 取得 Discord → Slack 規則清單 |
| `POST` | `/api/admin/discord-rules` | 新增規則 |
| `PUT` | `/api/admin/discord-rules/:id` | 更新規則（例如啟用/停用） |
| `DELETE` | `/api/admin/discord-rules/:id` | 刪除規則 |

---

## Web Admin（多組平行設定）

打開 [http://localhost:3000/admin](http://localhost:3000/admin) 可以管理多組 Discord → Slack 規則。

每組規則都可設定：

- Discord 來源：Guild / Channel（支援下拉選單或手動輸入 ID）
- Slack 目標頻道：`#channel` 或 `C123...`
- 預設標記：可多選（例如 `<!here>` + `<@U123456>`）
- 啟用/停用

規則是平行生效的，系統會依來源比對命中的規則進行轉發。

轉發訊息會附上來源 URL（Discord message link），並把標記對象放在訊息尾端。

圖片/附件訊息也會被處理：若無文字內容會顯示圖片/附件提示，並附上檔案連結。

資料會持久化在本機：`data/relay-rules.json`。

---

## 目錄結構

```
src/
├─ index.ts                  Express 進入點
├─ config.ts                 環境變數驗證與型別
├─ logger.ts                 pino 日誌
├─ types.ts                  UnifiedMessage 共用型別
├─ routes/
│  ├─ health.ts              GET /health
│  └─ testSlack.ts           POST /webhook/test-slack
├─ slack/
│  └─ slackNotifier.ts       Slack Webhook 發送
├─ normalizer/               訊息格式標準化（M2 起加入）
└─ discord/                  Discord Bot 客戶端（M3 起加入）
```

---

## 常見問題

**服務啟動時噴 `Missing required environment variable`**
→ `.env` 尚未建立，或缺少某個必填變數。對照 `.env.example` 補齊。

**`POST /webhook/test-slack` 回傳 500**
→ `SLACK_BOT_TOKEN` 無效，或 Bot 尚未被邀請進 `SLACK_DEFAULT_CHANNEL`。

**LINE Webhook 驗證失敗（403）**
→ `LINE_CHANNEL_SECRET` 填錯，或 Request 不是來自 LINE Platform。

**Discord Bot 上線但不轉發訊息**
→ 確認 `DISCORD_ALLOWED_GUILD_IDS` 與 `DISCORD_ALLOWED_CHANNEL_IDS` 都有填入正確的雪花 ID；並確認 Bot 的 **Message Content Intent** 已開啟。

---

## 開發里程碑

### 目前進度（2026-06-03）

- 已完成 M1：Slack 核心轉發（Bot Token + `chat.postMessage`）、`/health`、`/webhook/test-slack`。
- 已完成本地啟動與驗證流程：`test.sh` 可自動補 `.env`、自動啟動服務、驗證健康檢查與 Slack 測試通知。
- 已完成 VS Code 開發工作流：build task、typecheck task、debug 啟動設定。
- M2 先擱置：LINE 功能改為可選啟用（缺少 LINE env 不會影響服務啟動）。
- M3 已完成：Discord Bot 監聽、白名單過濾、訊息 normalize 並轉送 Slack。
- M4 已完成：Web Admin 多組規則、來源下拉、Slack channel 與 mention 選項、規則編輯。
- M5 已開始：GitHub Actions + GHCR image 發佈流程第一版。
- 下一步目標：補上 Web Admin 認證與部署 SOP。

| Milestone | 狀態 | 內容 |
|-----------|------|------|
| M1 Slack Core | ✅ 完成 | 基礎服務、/health、測試端點、Docker |
| M2 LINE → Slack | ⏸️ 擱置 | LINE webhook、signature 驗證、訊息轉發（可選啟用） |
| M3 Discord → Slack | ✅ 完成 | Discord Bot、頻道監聽、白名單過濾 |
| M4 Web Admin  | ✅ 完成 | WebAdmin 多組規則、下拉選單、標記設定、持久化設定 |
| M5 Production | 🔧 進行中 | GHCR 發佈流程、Unraid 部署文件與版本化升級 |
| M6 SOP | ⬜ 待做 | 團隊使用說明、異常排查 |
