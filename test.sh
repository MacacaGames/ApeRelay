#!/usr/bin/env bash
# ApeRelay 啟動 + 驗證腳本
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
START_TIMEOUT="${START_TIMEOUT:-60}"
APP_STARTED_BY_SCRIPT=0

GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; }
info() { echo -e "${CYAN}→ $1${NC}"; }

ensure_env_file() {
  if [[ -f ".env" ]]; then
    return 0
  fi

  if [[ ! -f ".env.example" ]]; then
    fail "找不到 .env.example，無法自動建立 .env"
    return 1
  fi

  cp .env.example .env
  info "已自動建立 .env（從 .env.example 複製）"
  info "若尚未填入真實 Slack / LINE / Discord 憑證，後續轉發測試可能失敗"
}

wait_for_health() {
  local elapsed=0
  while (( elapsed < START_TIMEOUT )); do
    if curl -sf "${BASE_URL}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

start_with_node() {
  if ! command -v npm >/dev/null 2>&1; then
    return 1
  fi

  info "偵測到服務未啟動，使用 Node.js 啟動中..."

  if [[ ! -d "node_modules" ]]; then
    info "安裝依賴 npm install"
    npm install
  fi

  npm run build
  nohup npm start > ./.aperelay-local.log 2>&1 &
  APP_STARTED_BY_SCRIPT=1
  wait_for_health
}

echo ""
info "ApeRelay Start + Verify — ${BASE_URL}"
echo "----------------------------------------"

# 0. Start app if needed
if ! curl -sf "${BASE_URL}/health" >/dev/null 2>&1; then
  if [[ "${BASE_URL}" == "http://localhost:3000" || "${BASE_URL}" == "http://127.0.0.1:3000" ]]; then
    if ! ensure_env_file; then
      exit 1
    fi

    if start_with_node; then
      pass "服務已啟動（Node.js）"
    else
      fail "無法自動啟動服務。請確認已安裝 npm。"
      exit 1
    fi
  else
    fail "${BASE_URL} 無法連線（遠端模式不會自動啟動服務）"
    exit 1
  fi
else
  pass "服務已在運行中"
fi

echo ""

# 1. Health check
info "GET /health"
HEALTH=$(curl -sf "${BASE_URL}/health") || { fail "/health 無法連線，請確認服務已啟動"; exit 1; }
echo "  ${HEALTH}"
echo "$HEALTH" | grep -q '"status":"ok"' && pass "Health OK" || fail "Health 回應異常"

echo ""

# 2. Test Slack notification
info "POST /webhook/test-slack"
SLACK_RESP=$(curl -sf -X POST "${BASE_URL}/webhook/test-slack" \
  -H "Content-Type: application/json") || { fail "/webhook/test-slack 失敗"; exit 1; }
echo "  ${SLACK_RESP}"
echo "$SLACK_RESP" | grep -q '"ok":true' && pass "Slack 測試通知已送出" || fail "Slack 送出失敗"

echo ""
info "完成。請確認 Slack 頻道是否收到測試訊息。"
if [[ "${APP_STARTED_BY_SCRIPT}" -eq 1 ]]; then
  info "本次由腳本自動啟動服務，若要停止可執行：pkill -f 'node dist/index.js'"
fi
echo ""
