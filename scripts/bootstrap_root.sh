#!/usr/bin/env bash

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/bootstrap_root.sh" >&2
  exit 1
fi

TARGET_USER="${SUDO_USER:-developer}"
TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"

if [[ -z "${TARGET_HOME}" ]]; then
  echo "Could not resolve home directory for user ${TARGET_USER}" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

install_keyring() {
  local url="$1"
  local output="$2"
  curl -fsSL "${url}" | gpg --dearmor -o "${output}"
  chmod 0644 "${output}"
}

mkdir -p /etc/apt/keyrings
chmod 0755 /etc/apt/keyrings

if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod 0644 /etc/apt/keyrings/docker.asc
fi

if [[ ! -f /usr/share/keyrings/cloudflare-main.gpg ]]; then
  install_keyring "https://pkg.cloudflare.com/cloudflare-main.gpg" "/usr/share/keyrings/cloudflare-main.gpg"
fi

if [[ ! -f /usr/share/keyrings/tailscale-archive-keyring.gpg ]]; then
  install_keyring "https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg" "/usr/share/keyrings/tailscale-archive-keyring.gpg"
fi

if [[ ! -f /etc/apt/keyrings/nodesource.gpg ]]; then
  install_keyring "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" "/etc/apt/keyrings/nodesource.gpg"
fi

cat >/etc/apt/sources.list.d/docker.list <<'EOF'
deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable
EOF

cat >/etc/apt/sources.list.d/cloudflared.list <<'EOF'
deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared noble main
EOF

cat >/etc/apt/sources.list.d/tailscale.list <<'EOF'
# Tailscale packages for ubuntu noble
deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu noble main
EOF

cat >/etc/apt/sources.list.d/nodesource.sources <<'EOF'
Types: deb
URIs: https://deb.nodesource.com/node_24.x
Suites: nodistro
Components: main
Architectures: amd64
Signed-By: /etc/apt/keyrings/nodesource.gpg
EOF

apt-get update
apt-get install -y \
  apt-transport-https \
  bash-completion \
  bubblewrap \
  build-essential \
  ca-certificates \
  cloudflared \
  curl \
  fail2ban \
  git \
  gnupg \
  jq \
  make \
  nginx \
  python3-pip \
  python3-venv \
  nodejs \
  tmux \
  tailscale \
  unzip \
  zip \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

cat >/etc/sysctl.d/99-codex-userns.conf <<'EOF'
kernel.apparmor_restrict_unprivileged_userns = 0
EOF

sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
sysctl --system >/dev/null

systemctl enable --now docker
systemctl enable --now containerd
systemctl enable --now fail2ban
systemctl enable --now nginx
systemctl enable --now tailscaled

if getent group docker >/dev/null 2>&1; then
  usermod -aG docker "${TARGET_USER}" || true
fi

mkdir -p "${TARGET_HOME}/.local/bin" "${TARGET_HOME}/.npm-global"
chown -R "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.local" "${TARGET_HOME}/.npm-global"

echo "Root bootstrap completed for ${TARGET_USER} (${TARGET_HOME})."
echo "Next: run 'bash scripts/bootstrap_user.sh' as ${TARGET_USER}."
