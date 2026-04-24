#!/usr/bin/env bash

set -euo pipefail

check_cmd() {
  local name="$1"
  local resolved=""
  if resolved="$(resolve_cmd "${name}")"; then
    printf "[ok] %s -> %s\n" "${name}" "${resolved}"
  else
    printf "[missing] %s\n" "${name}"
  fi
}

resolve_cmd() {
  local name="$1"
  if command -v "${name}" >/dev/null 2>&1; then
    command -v "${name}"
    return 0
  fi

  if [[ -x "${HOME}/.local/bin/${name}" ]]; then
    printf "%s\n" "${HOME}/.local/bin/${name}"
    return 0
  fi

  return 1
}

print_version() {
  local name="$1"
  local resolved=""
  if resolved="$(resolve_cmd "${name}")"; then
    "${resolved}" --version || true
  fi
}

echo "System"
sed -n '1,6p' /etc/os-release
echo

echo "Commands"
for cmd in git node npm python3 uv docker railway codex tmux jq curl unzip zip bwrap unshare; do
  check_cmd "${cmd}"
done
echo

echo "Telegram Codex service files"
if [[ -f "${HOME}/.config/systemd/user/telegram-codex.service" ]]; then
  echo "[ok] ~/.config/systemd/user/telegram-codex.service"
else
  echo "[missing] ~/.config/systemd/user/telegram-codex.service"
fi

if [[ -f "${HOME}/.config/coding/telegram-codex.env" ]]; then
  echo "[ok] ~/.config/coding/telegram-codex.env"
else
  echo "[missing] ~/.config/coding/telegram-codex.env"
fi

if [[ -f "${HOME}/Coding/hetzner/scripts/telegram_codex_bridge.mjs" ]]; then
  echo "[ok] ~/Coding/hetzner/scripts/telegram_codex_bridge.mjs"
else
  echo "[missing] ~/Coding/hetzner/scripts/telegram_codex_bridge.mjs"
fi

if [[ -f "${HOME}/Coding/hetzner/scripts/telegram_file_mcp.mjs" ]]; then
  echo "[ok] ~/Coding/hetzner/scripts/telegram_file_mcp.mjs"
else
  echo "[missing] ~/Coding/hetzner/scripts/telegram_file_mcp.mjs"
fi

if [[ -x "${HOME}/Coding/hetzner/scripts/resume_telegram_codex.sh" ]]; then
  echo "[ok] ~/Coding/hetzner/scripts/resume_telegram_codex.sh"
else
  echo "[missing] ~/Coding/hetzner/scripts/resume_telegram_codex.sh"
fi
echo

echo "Workspace root"
if [[ -d "${HOME}/Coding" ]]; then
  echo "[ok] ~/Coding"
else
  echo "[missing] ~/Coding"
fi
echo

echo "Versions"
git --version || true
node --version || true
npm --version || true
python3 --version || true
print_version uv
docker --version || true
print_version railway
print_version codex
bwrap --version || true
echo

echo "Codex sandbox prerequisites"
printf "kernel.apparmor_restrict_unprivileged_userns="
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns
unshare --user --map-root-user /bin/true && echo "unshare_ok"
bwrap --unshare-net --ro-bind / / --proc /proc --dev /dev /bin/true && echo "bwrap_ok"
echo

echo "Docker"
if docker ps >/dev/null 2>&1; then
  echo "docker_user_access_ok"
else
  echo "docker_user_access_failed"
  echo "If this is a fresh machine, re-login after being added to the docker group."
fi
echo

echo "User service"
systemctl --user is-enabled telegram-codex.service 2>/dev/null || true
systemctl --user is-active telegram-codex.service 2>/dev/null || true
echo

echo "Bridge Codex MCP"
if [[ -x "${HOME}/Coding/hetzner/scripts/codex_telegram_wrapper.sh" ]] && "${HOME}/Coding/hetzner/scripts/codex_telegram_wrapper.sh" mcp list 2>/dev/null | grep -Eq '^telegram-file[[:space:]]'; then
  echo "[ok] telegram-file MCP visible via codex_telegram_wrapper.sh"
else
  echo "[missing] telegram-file MCP visible via codex_telegram_wrapper.sh"
fi
echo

echo "Global Codex MCP (optional)"
if command -v codex >/dev/null 2>&1 && codex mcp list 2>/dev/null | grep -Eq '^telegram-file[[:space:]]'; then
  echo "[ok] telegram-file MCP registered globally"
else
  echo "[info] telegram-file MCP not registered globally"
fi
