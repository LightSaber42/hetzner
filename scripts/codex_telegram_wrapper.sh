#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TELEGRAM_FILE_MCP_SCRIPT="${TELEGRAM_FILE_MCP_SCRIPT:-${SCRIPT_DIR}/telegram_file_mcp.mjs}"

CODEX_BRIDGE_CONFIG_ARGS=(
  '-c' 'mcp_servers.telegram-file.command="/usr/bin/node"'
  '-c' "mcp_servers.telegram-file.args=[\"${TELEGRAM_FILE_MCP_SCRIPT}\"]"
  '-c' 'mcp_servers.telegram-file.startup_timeout_sec=60'
)

if [[ "${1:-}" == "--search" ]]; then
  shift
  exec codex "${CODEX_BRIDGE_CONFIG_ARGS[@]}" --search exec --skip-git-repo-check "$@"
fi

if [[ "${1:-}" == "exec" ]]; then
  shift
  exec codex "${CODEX_BRIDGE_CONFIG_ARGS[@]}" exec --skip-git-repo-check "$@"
fi

exec codex "${CODEX_BRIDGE_CONFIG_ARGS[@]}" "$@"
