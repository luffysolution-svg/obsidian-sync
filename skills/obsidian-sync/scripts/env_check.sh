#!/usr/bin/env bash
# env_check.sh - obsidian-sync 环境一键检测（macOS/Linux，只读）
# 用法：bash env_check.sh
# 输出：单个 JSON，字段结构与 Windows 的 env_check.ps1 完全一致
set -u

node_v=$(node --version 2>/dev/null || echo "MISSING")
npm_v=$(npm --version 2>/dev/null || echo "MISSING")
git_v=$(git --version 2>/dev/null | head -1 || echo "MISSING")

lark_path=""
lark_ver="MISSING"
lark_identity="unknown"
lark_bot="unknown"
lark_user="unknown"
lark_hint=""
if command -v lark-cli >/dev/null 2>&1; then
  lark_path=$(command -v lark-cli)
  lark_ver=$(lark-cli --version 2>/dev/null | head -1)
  auth_raw=$(lark-cli auth status 2>/dev/null)
  # 提取 identity / identities.bot.status / identities.user.status / user.hint
  lark_identity=$(printf '%s' "$auth_raw" | grep -o '"identity"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*: *"\([^"]*\)"/\1/')
  lark_bot=$(printf '%s' "$auth_raw" | grep -o '"bot"[[:space:]]*:[[:space:]]*{[^}]*"status"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/')
  lark_user=$(printf '%s' "$auth_raw" | grep -o '"user"[[:space:]]*:[[:space:]]*{[^}]*"status"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/')
  lark_hint=$(printf '%s' "$auth_raw" | grep -o '"hint"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*: *"\([^"]*\)"/\1/')
  [ -z "$lark_identity" ] && lark_identity="unknown"
  [ -z "$lark_bot" ] && lark_bot="unknown"
  [ -z "$lark_user" ] && lark_user="unknown"
fi

ima_cid="MISSING"
if [ -n "${IMA_OPENAPI_CLIENTID:-}" ] || [ -n "${IMA_CLIENT_ID:-}" ] || [ -f "$HOME/.config/ima/client_id" ]; then
  ima_cid="set"
fi
ima_key="MISSING"
if [ -n "${IMA_OPENAPI_APIKEY:-}" ] || [ -n "${IMA_API_KEY:-}" ] || [ -f "$HOME/.config/ima/api_key" ]; then
  ima_key="set"
fi

notion_token="MISSING"
if [ -n "${NOTION_TOKEN:-}" ] || [ -n "${NOTION_API_KEY:-}" ] || [ -f "$HOME/.config/notion/token" ]; then
  notion_token="set"
fi
notion_proxy="unset"
[ -n "${NOTION_PROXY:-}" ] && notion_proxy="set"

cat <<EOF
{
  "node": "$node_v",
  "npm": "$npm_v",
  "git": "$git_v",
  "lark_cli": {
    "path": "$lark_path",
    "version": "$lark_ver"
  },
  "lark_auth": {
    "identity": "$lark_identity",
    "bot": "$lark_bot",
    "user": "$lark_user",
    "user_hint": "$lark_hint"
  },
  "ima": {
    "client_id": "$ima_cid",
    "api_key": "$ima_key"
  },
  "notion": {
    "token": "$notion_token",
    "proxy": "$notion_proxy"
  }
}
EOF
