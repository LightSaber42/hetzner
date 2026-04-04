#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <telegram-bot-token>" >&2
  echo "Example: $0 123456:ABCDEF" >&2
  exit 1
fi

BOT_TOKEN="$1"
API_URL="https://api.telegram.org/bot${BOT_TOKEN}/getUpdates"

if ! command -v curl >/dev/null 2>&1; then
  echo "Missing required command: curl" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Missing required command: jq" >&2
  exit 1
fi

RAW_RESPONSE="$(curl -fsS "${API_URL}")"

if [[ "$(jq -r '.ok' <<<"${RAW_RESPONSE}")" != "true" ]]; then
  jq <<<"${RAW_RESPONSE}" >&2
  exit 1
fi

RESULT_COUNT="$(jq '.result | length' <<<"${RAW_RESPONSE}")"
if [[ "${RESULT_COUNT}" -eq 0 ]]; then
  echo "No updates found." >&2
  echo "Send your bot a test message in Telegram, then rerun this script." >&2
  exit 1
fi

jq -r '
  .result[]
  | select(.message.chat.id? and .message.from.id?)
  | [
      "update_id=\(.update_id)",
      "chat_id=\(.message.chat.id)",
      "user_id=\(.message.from.id)",
      "chat_type=\(.message.chat.type // "unknown")",
      "from_username=\(.message.from.username // "")",
      "text=\(.message.text // "")"
    ]
  | @tsv
' <<<"${RAW_RESPONSE}"
