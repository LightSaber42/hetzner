#!/usr/bin/env bash

set -euo pipefail

ENV_FILE="${TELEGRAM_BRIDGE_ENV_FILE:-${HOME}/.config/coding/telegram-codex.env}"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

CHAT_ID="${TELEGRAM_CHAT_ID:-}"
USER_ID="${TELEGRAM_USER_ID:-${CHAT_ID}}"
STATE_FILE="${TELEGRAM_BRIDGE_STATE_FILE:-${HOME}/.config/coding/telegram-codex-state-${CHAT_ID}-${USER_ID}.json}"

if [[ ! -f "${STATE_FILE}" ]]; then
  echo "Missing bridge state file: ${STATE_FILE}" >&2
  exit 1
fi

THREAD_ID="$(node -e "const fs=require('fs'); const s=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(String(s.thread_id || ''));" "${STATE_FILE}")"
WORKDIR="$(node -e "const fs=require('fs'); const s=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(String(s.workdir || process.cwd()));" "${STATE_FILE}")"
CODEX_BIN="${CODEX_BIN:-codex}"

if [[ -z "${THREAD_ID}" ]]; then
  echo "No active thread_id recorded in ${STATE_FILE}" >&2
  exit 1
fi

exec "${CODEX_BIN}" resume --include-non-interactive -C "${WORKDIR}" "${THREAD_ID}" "$@"
