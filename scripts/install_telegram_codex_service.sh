#!/usr/bin/env bash

set -euo pipefail

HOME_DIR="${HOME}"
SYSTEMD_USER_DIR="${HOME_DIR}/.config/systemd/user"
CONFIG_DIR="${HOME_DIR}/.config/coding"
ENV_FILE="${CONFIG_DIR}/telegram-codex.env"
SERVICE_NAME="telegram-codex.service"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_TEMPLATE="${REPO_ROOT}/systemd/${SERVICE_NAME}"

mkdir -p "${SYSTEMD_USER_DIR}" "${CONFIG_DIR}"
chmod 700 "${CONFIG_DIR}"

install -m 0644 "${SERVICE_TEMPLATE}" "${SYSTEMD_USER_DIR}/${SERVICE_NAME}"
chmod 0755 "${REPO_ROOT}/scripts/run_telegram_codex_bridge.sh"
chmod 0755 "${REPO_ROOT}/scripts/codex_telegram_wrapper.sh"

if [[ ! -f "${ENV_FILE}" ]]; then
  cat >"${ENV_FILE}" <<'EOF'
TELEGRAM_BOT_TOKEN=paste-token-here
TELEGRAM_CHAT_ID=
TELEGRAM_USER_ID=
CODEX_WORKDIR=__HOME__/Coding
CODEX_BIN=__HOME__/Coding/hetzner/scripts/codex_telegram_wrapper.sh
TELEGRAM_BRIDGE_SCRIPT=__HOME__/Coding/notea/scripts/telegram-codex-bridge.mjs
CODEX_PROGRESS_UPDATES=1
EOF
  sed -i "s|__HOME__|${HOME_DIR}|g" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
fi

systemctl --user daemon-reload
systemctl --user enable "${SERVICE_NAME}"

cat <<EOF
Installed ${SERVICE_NAME}.

Service file:
  ${SYSTEMD_USER_DIR}/${SERVICE_NAME}

Env file:
  ${ENV_FILE}

Start the service with:
  systemctl --user start ${SERVICE_NAME}

Check status with:
  systemctl --user status ${SERVICE_NAME}
EOF
