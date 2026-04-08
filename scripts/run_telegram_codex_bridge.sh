#!/usr/bin/env bash

set -euo pipefail

HOME_DIR="${HOME}"
BRIDGE_SCRIPT="${TELEGRAM_BRIDGE_SCRIPT:-${HOME_DIR}/Coding/hetzner/scripts/telegram_codex_bridge.mjs}"

if [[ ! -f "${BRIDGE_SCRIPT}" ]]; then
  echo "Missing bridge script: ${BRIDGE_SCRIPT}" >&2
  echo "Set TELEGRAM_BRIDGE_SCRIPT in ~/.config/coding/telegram-codex.env if you want to override the default path." >&2
  exit 1
fi

exec /usr/bin/env node "${BRIDGE_SCRIPT}"
