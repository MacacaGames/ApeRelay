# ApeRelay

自架訊息轉發服務：LINE / Discord → Slack。

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
SLACK_DEFAULT_CHANNEL=#external-message-alert    # 預設發送頻道

LINE_CHANNEL_SECRET=你的_channel_secret
LINE_CHANNEL_ACCESS_TOKEN=你的_access_token

DISCORD_BOT_TOKEN=你的_bot_token
DISCORD_ALLOWED_GUILD_IDS=Guild的雪花ID        # 多個用逗號分隔
DISCORD_ALLOWED_CHANNEL_IDS=Channel的雪花ID   # 多個用逗號分隔

TIMEZONE=Asia/Taipei
LOG_LEVEL=info
```

> ⚠️ `.env` 已列入 `.gitignore`，絕對不要 commit 進 Git。
>
> 補充：直接執行 [test.sh](test.sh) 時，如果 `.env` 不存在，腳本也會自動從 `.env.example` 建立一份。

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

| Milestone | 狀態 | 內容 |
|-----------|------|------|
| M1 Slack Core | ✅ 完成 | 基礎服務、/health、測試端點、Docker |
| M2 LINE → Slack | 🔧 進行中 | LINE webhook、signature 驗證、訊息轉發 |
| M3 Discord → Slack | ⬜ 待做 | Discord Bot、頻道監聽、白名單過濾 |
| M4 Production | ⬜ 待做 | Caddy HTTPS、log volume、部署文件 |
| M5 SOP | ⬜ 待做 | 團隊使用說明、異常排查 |
