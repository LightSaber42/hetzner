#!/usr/bin/env bash

set -euo pipefail

HOME_DIR="${HOME}"
BRIDGE_SCRIPT="${TELEGRAM_BRIDGE_SCRIPT:-${HOME_DIR}/Coding/notea/scripts/telegram-codex-bridge.mjs}"

if [[ ! -f "${BRIDGE_SCRIPT}" ]]; then
  echo "Missing bridge script: ${BRIDGE_SCRIPT}" >&2
  echo "Clone notea under ~/Coding/notea or set TELEGRAM_BRIDGE_SCRIPT in ~/.config/coding/telegram-codex.env" >&2
  exit 1
fi

exec /usr/bin/env node "${BRIDGE_SCRIPT}"
