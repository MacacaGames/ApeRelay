# ApeRelay 已實作功能總結（截至 2026-06-08）

- 支援多來源轉發到 Slack：LINE、Discord、Generic Webhook。
- 已建立來源解耦架構：Source Adapter + Relay Pipeline，來源邏輯與轉發邏輯分離。
- 具備統一訊息模型（UnifiedMessage），可在不同來源套用一致轉發流程。
- 提供健康檢查端點：`GET /health`。
- 提供 Slack 測試端點：`POST /webhook/test-slack`。
- 提供 Generic Webhook 端點：`POST /webhook/generic`。
- 提供 LINE Webhook 端點：`POST /webhook/line`（含來源資料整合與診斷狀態）。

- Discord 來源規則功能已完成：
- 可依 Guild/Channel 進行規則比對。
- 可設定單條規則目標 Slack 頻道。
- 可設定單條規則通知對象（mentions）。
- 可設定單條規則排除作者。
- 可設定單條規則排除身份組（Discord Role ID）。
- 支援 Discord 全域排除作者。
- 支援 Discord 全域排除身份組（Discord Role ID）。
- 執行期排除名單採 union：ENV + Global + Rule。
- 當有啟用規則但未命中時，會跳過轉發（不 fallback）。

- LINE 來源規則功能已完成：
- 可依 LINE 群組建立與比對規則。
- 可設定單條規則目標 Slack 頻道。
- 可設定單條規則通知對象（mentions）。
- 名單邏輯已改為「預設排除對象」`excludedSpeakerIds`。
- 支援 LINE 全域排除名單 `globalExcludedLineSpeakerIds`。
- 執行期排除名單採 union：LINE Global + Rule。
- 未命中 LINE 規則時不轉發。
- 已支援最近收到群組與最近發言者清單。

- Web Admin 管理介面已完成：
- 提供管理入口驗證（`ADMIN_PASSWORD`）與登入/登出/狀態檢查 API。
- 提供 Discord/LINE 規則新增、編輯、刪除、啟用/停用。
- 提供共享規則總覽（Discord + LINE 同表檢視）。
- 規則流程採 Source → Target 對稱設計。
- 提供 Slack 候選資源載入（頻道、使用者、群組）。
- 提供 Discord 來源、近期作者與身份組下拉。
- 提供 LINE 最近群組與最近發言者下拉。
- 提供 Discord 全域排除設定與 LINE 全域排除設定。
- 支援規則匯出（JSON）。
- 支援規則匯入（JSON），可選 merge 或 replace。
- 提供 LINE Webhook 診斷頁面。

- Mention Trigger / 對象映射管理已升級：
- 已改為 Slack 使用者為主的映射模型（1 Slack mention 對多個 Discord/LINE UID）。
- 支援整表批次編輯與儲存（bulk API），降低逐筆手動維護成本。
- 支援從近期 Discord/LINE 作者清單快速套用 UID 到多筆映射。
- 舊版 Discord/LINE mappings 仍保留相容讀取。

- Slack 發送內容已升級：
- 使用 Block Kit 顯示重點欄位。
- 通知對象獨立為「通知對象」區塊，不再放在訊息最前端。
- 平台顯示已精簡為 emoji + 短標籤（例如：🟢 LINE、🎮 Discord）。
- 支援來源連結按鈕（可開啟原始訊息）。
- LINE 來源支援 deeplink（`line://nv/chat`）快速開啟聊天室。
- 連續訊息已加入明顯視覺分界，避免多則通知混在一起。
- 保留 fallback text，並同步通知對象資訊。

- 穩定性與容錯已升級：
- Slack options 取得流程已補上錯誤攔截與降級回傳，避免 fetch 失敗導致服務 crash。

- 規則資料持久化已完成：
- 儲存於 `data/relay-rules.json`。
- 支援 Discord 規則、LINE 規則、全域排除設定。
- 已支援 Discord 身份組排除欄位（全域與規則層）。
- 已支援匯入匯出格式中 LINE 全域排除欄位。

- 部署與開發流程已可用：
- 本機開發：`npm run dev`。
- 型別檢查：`npm run typecheck`。
- 建置：`npm run build`。
- Docker Compose 啟動。
- GitHub Actions GHCR workflow（build/push）已建置。
