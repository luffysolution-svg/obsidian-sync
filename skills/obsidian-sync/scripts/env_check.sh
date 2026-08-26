#!/usr/bin/env bash
# env_check.sh - obsidian-sync 环境一键检测（macOS/Linux，只读）
# 用法：bash env_check.sh
# 输出：单个 JSON（与 Windows 的 env_check.ps1 字段一致）
set -u

node_v=$(node --version 2>/dev/null || echo "MISSING")
npm_v=$(npm --version 2>/dev/null || echo "MISSING")
git_v=$(git --version 2>/dev/null | head -1 || echo "MISSING")

lark="MISSING"
lark_identity="unknown"
if command -v lark-cli >/dev/null 2>&1; then
  lark=$(lark-cli --version 2>/dev/null | head -1)
  lark_identity=$(lark-cli auth status 2>/dev/null | grep -o '"identity"[^,]*' | head -1 | sed 's/.*: *"\([^"]*\)"/\1/')
  [ -z "$lark_identity" ] && lark_identity="unknown"
fi

ima_cid="MISSING"
if [ -n "${IMA_OPENAPI_CLIENTID:-}" ] || [ -n "${IMA_CLIENT_ID:-}" ] || [ -f "$HOME/.config/ima/client_id" ]; then
  ima_cid="set"
fi
ima_key="MISSING"
if [ -n "${IMA_OPENAPI_APIKEY:-}" ] || [ -n "${IMA_API_KEY:-}" ] || [ -f "$HOME/.config/ima/api_key" ]; then
  ima_key="set"
fi

cat <<EOF
{
  "node": "$node_v",
  "npm": "$npm_v",
  "git": "$git_v",
  "lark_cli": "$lark",
  "lark_auth_identity": "$lark_identity",
  "ima_client_id": "$ima_cid",
  "ima_api_key": "$ima_key"
}
EOF
