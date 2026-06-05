# ApeRelay Quick Start（Unraid / Docker）

這份文件是給「要快速上線」的人用，重點放在：

- 必填環境變數
- Volume 持久化（避免更新 image 後規則消失）

---

## 1) Image 建議

建議先用固定版本 tag，不要直接用 `latest`：

```text
ghcr.io/macacagames/aperelay:v0.5.0
```

先驗證再升級，回滾比較容易。

---

## 2) 環境變數設定

可參考 repo 根目錄的 `.env.example`。

### 必填（服務啟動需要）

| 變數 | 說明 |
|---|---|
| `SLACK_BOT_TOKEN` | Slack Bot Token（`xoxb-...`） |
| `SLACK_DEFAULT_CHANNEL` | 預設 Slack 頻道，例如 `"#external-message-alert"`（在 `.env` 格式中，值以 `#` 開頭時要加雙引號，避免被當註解） |
| `DISCORD_BOT_TOKEN` | Discord Bot Token |

### 建議填寫（Discord 過濾）

| 變數 | 說明 |
|---|---|
| `DISCORD_ALLOWED_GUILD_IDS` | 允許轉發的 Guild ID（多個逗號分隔） |
| `DISCORD_ALLOWED_CHANNEL_IDS` | 允許轉發的 Channel ID（多個逗號分隔） |
| `DISCORD_EXCLUDED_USER_IDS` | 排除的 Discord User ID（可留空） |

### 可選（LINE）

| 變數 | 說明 |
|---|---|
| `LINE_CHANNEL_SECRET` | LINE Channel Secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Access Token |

> LINE 兩個值都正確時才會啟用。若為空或仍是 placeholder（例如 `.env.example` 內的 `your_line_channel_secret`、`your_line_channel_access_token`），LINE 來源會自動停用。

### 其他常用

| 變數 | 預設/範例 |
|---|---|
| `PORT` | `3000` |
| `PUBLIC_BASE_URL` | `https://relay.example.com`（LINE webhook 對外網址，使用 LINE 時建議設定） |
| `ADMIN_PASSWORD` | 建議設定強密碼 |
| `TIMEZONE` | `Asia/Taipei` |
| `LOG_LEVEL` | `info` |

---

## 3) Volume 重點（最重要）

ApeRelay 規則檔會寫到容器內：

```text
/app/data/relay-rules.json
```

如果沒掛 volume，更新 image / 重建 container 後，規則就會消失。

### 至少要掛這兩個

| Host Path（Unraid） | Container Path | 用途 |
|---|---|---|
| `/mnt/user/appdata/aperelay/data` | `/app/data` | 持久化 relay rules |
| `/mnt/user/appdata/aperelay/logs` | `/app/logs` | 保留 log（建議） |

---

## 4) docker-compose 參考

repo 根目錄的 `docker-compose.yml` 目前只有 `logs` volume。若用 Docker Compose 正式部署，建議補上 `data`：

```yaml
volumes:
  - ./logs:/app/logs
  - ./data:/app/data
```

---

## 5) 更新流程建議

1. 匯出一次 Admin 規則（或備份 host 上的 `relay-rules.json`）
2. 更新 image tag
3. 重建 container
4. 檢查 `/admin` 規則是否仍在

若更新後規則消失，優先檢查 `/app/data` volume 是否正確掛載且可寫。

---

## 6) 截圖說明

本版先不附截圖；若後續 UI 欄位名稱有調整，或團隊回報文字版仍容易誤設定，再補上 Unraid 設定畫面截圖。
