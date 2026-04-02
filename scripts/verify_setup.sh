#!/usr/bin/env bash

set -euo pipefail

check_cmd() {
  local name="$1"
  if command -v "${name}" >/dev/null 2>&1; then
    printf "[ok] %s -> %s\n" "${name}" "$(command -v "${name}")"
  else
    printf "[missing] %s\n" "${name}"
  fi
}

echo "System"
sed -n '1,6p' /etc/os-release
echo

echo "Commands"
for cmd in git node npm python3 docker railway codex tmux jq curl unzip zip bwrap unshare; do
  check_cmd "${cmd}"
done
echo

echo "Versions"
git --version || true
node --version || true
npm --version || true
python3 --version || true
docker --version || true
railway --version || true
codex --version || true
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
