#!/usr/bin/env bash

set -euo pipefail

HOME_DIR="${HOME}"
NPM_GLOBAL_DIR="${HOME_DIR}/.local"
BASHRC="${HOME_DIR}/.bashrc"
PROFILE="${HOME_DIR}/.profile"
SSH_DIR="${HOME_DIR}/.ssh"
GITCONFIG="${HOME_DIR}/.gitconfig"
TMUXCONF="${HOME_DIR}/.tmux.conf"

mkdir -p "${HOME_DIR}/.local/bin" "${HOME_DIR}/.local/lib" "${SSH_DIR}"
chmod 700 "${SSH_DIR}"

npm config set prefix "${NPM_GLOBAL_DIR}"

if ! grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "${BASHRC}"; then
  printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >>"${BASHRC}"
fi

if ! grep -Fq 'alias dc="docker compose"' "${BASHRC}"; then
  printf 'alias dc="docker compose"\n' >>"${BASHRC}"
fi

if ! grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "${PROFILE}"; then
  printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >>"${PROFILE}"
fi

npm install -g @openai/codex @railway/cli

if [[ ! -f "${GITCONFIG}" ]]; then
  cat >"${GITCONFIG}" <<EOF
[init]
    defaultBranch = main
[pull]
    ff = only
[push]
    autoSetupRemote = true
[core]
    editor = vim
EOF
fi

if [[ -n "${GIT_USER_NAME:-}" ]]; then
  git config --global user.name "${GIT_USER_NAME}"
fi

if [[ -n "${GIT_USER_EMAIL:-}" ]]; then
  git config --global user.email "${GIT_USER_EMAIL}"
fi

if [[ ! -f "${SSH_DIR}/config" ]]; then
  cat >"${SSH_DIR}/config" <<'EOF'
Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_github
    IdentitiesOnly yes
EOF
  chmod 600 "${SSH_DIR}/config"
fi

mkdir -p "${HOME_DIR}/.codex" "${HOME_DIR}/.railway"

if [[ ! -f "${HOME_DIR}/.codex/config.toml" ]]; then
  cat >"${HOME_DIR}/.codex/config.toml" <<'EOF'
approvals_reviewer = "user"
EOF
  chmod 600 "${HOME_DIR}/.codex/config.toml"
fi

if [[ ! -f "${TMUXCONF}" ]]; then
  cat >"${TMUXCONF}" <<'EOF'
set -g mouse on
EOF
fi

cat <<'EOF'
User bootstrap completed.

Manual follow-up:
1. Open a new shell so ~/.local/bin and docker group membership apply.
2. Set Git identity if not passed as env vars:
   git config --global user.name "Your Name"
   git config --global user.email "you@example.com"
3. Create or copy an SSH key, then add the public key to GitHub:
   ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_github -C "you@example.com"
4. Authenticate CLIs:
   codex
   railway login
   tailscale up
5. If you use Docker as a non-root user, verify after re-login:
   docker ps
EOF
