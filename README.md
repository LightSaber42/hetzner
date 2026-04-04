# Hetzner Developer Machine

This directory now documents the current Ubuntu developer box and provides scripts to recreate the environment on another host, including AWS EC2.

Repository working copies are expected under `~/Coding`:

- `~/Coding/hetzner`
- `~/Coding/notea`
- `~/Coding/unitc`
- `~/Coding/work` if you use an extra scratch/work repo

## What This Captures

- Base OS assumptions: Ubuntu 24.04.x LTS
- System packages and third-party apt repositories
- Codex sandbox prerequisites
- User-level shell and CLI setup
- Git, SSH, Codex, Docker, and Railway bootstrap steps
- Azure CLI fallback install notes
- Telegram Codex bridge service scaffolding
- Verification commands
- An AWS migration playbook

This repo intentionally does **not** store secrets. Do not copy:

- `~/.codex/auth.json`
- `~/.railway/config.json`
- `~/.ssh/*` private keys
- Any existing cloud, GitHub, or package registry tokens

Re-authenticate on the target machine instead.

## Current Machine Summary

Observed on `2026-04-02`:

- Hostname: `notea-dev`
- OS: Ubuntu `24.04.4 LTS`
- Kernel: `6.8.0-106-generic`
- Primary user: `developer`
- User groups: `developer`, `nogroup`

### Installed/Configured Tooling

- `git 2.43.0`
- `node v24.13.0`
- `npm 11.12.1`
- `python3 3.12.3`
- `docker 29.3.1`
- `tmux`
- `jq`
- `curl`
- `bubblewrap 0.9.0`
- global npm CLIs:
  - `@openai/codex@0.118.0`
  - `@railway/cli@4.35.0`

### User-Level Dotfiles Observed

- `~/.tmux.conf`: `set -g mouse on`
- `~/.bashrc`: mostly Ubuntu default, plus `alias dc="docker compose"`
- `~/.profile`: includes `~/.local/bin` on `PATH` and an explicit Codex-added `PATH` export
- `~/.npmrc`: `prefix=/home/developer/.local`
- `~/.ssh/config`: GitHub host entry pointing at `~/.ssh/id_ed25519_github`

### User-Level State That Should Not Be Treated As Baseline

- `~/.codex/auth.json`: live auth state
- `~/.railway/config.json`: live Railway tokens and linked-project state
- `~/.bash_history`: shell history
- `~/.cache`, `~/.npm`, `~/.gradle`, `.android/cache`: caches
- `~/.config/nextjs-nodejs/config.json`: telemetry state
- `~/.config/ookla/speedtest-cli.json`: acceptance/telemetry state
- `~/.expo/state.json`: generated local UUID

### Third-Party Apt Sources Present

- Docker
- NodeSource (`node_24.x`)
- Cloudflare (`cloudflared`)
- Tailscale

### Azure CLI Note

Observed on `2026-04-03`:

- `azure-cli` was not available from the configured apt repositories on this machine.
- The working fallback is to install `python3-pip` via apt, then install `azure-cli` from PyPI.

Use:

```bash
sudo apt-get install -y python3-pip
python3 -m pip install --user azure-cli
~/.local/bin/az version
```

If `~/.local/bin` is already on `PATH`, `az version` should work directly after opening a new shell.

### Enabled Services Worth Recreating

- `docker`
- `containerd`
- `nginx`
- `tailscaled`
- `fail2ban`
- `cloud-init`
- standard Ubuntu timers and networking services

## Recreate This Environment

Run these in order on a fresh Ubuntu 24.04 host:

```bash
mkdir -p ~/Coding
cd ~/Coding
git clone <your-hetzner-repo-url> hetzner
cd ~/Coding/hetzner
sudo bash scripts/bootstrap_root.sh
bash scripts/bootstrap_user.sh
bash scripts/verify_setup.sh
```

If you want Git identity configured during bootstrap:

```bash
GIT_USER_NAME="Your Name" \
GIT_USER_EMAIL="you@example.com" \
bash scripts/bootstrap_user.sh
```

## Files

- `scripts/bootstrap_root.sh`: root-level packages, repositories, services, sysctl
- `scripts/bootstrap_user.sh`: shell, npm global path, Codex/Railway install, Git/SSH templates
- `scripts/get_telegram_ids.sh`: resolve `TELEGRAM_CHAT_ID` and `TELEGRAM_USER_ID` from a bot token
- `scripts/codex_telegram_wrapper.sh`: Codex launcher wrapper used for non-git workspace roots like `~/Coding`
- `scripts/install_telegram_codex_service.sh`: install the user-level systemd unit and env template
- `scripts/run_telegram_codex_bridge.sh`: local wrapper that launches the Telegram bridge implementation
- `scripts/verify_setup.sh`: post-setup verification
- `systemd/telegram-codex.service`: user-level service template for the Telegram Codex bridge
- `docs/aws-playbook.md`: step-by-step transfer plan from this box to AWS

## Telegram Helper

Create your bot in Telegram with `@BotFather`, send that bot a message once, then run:

```bash
bash scripts/get_telegram_ids.sh <telegram-bot-token>
```

The script prints the `chat_id` and `user_id` values you need for the Telegram Codex bridge.

## Telegram Codex Service

Bootstrap now installs a user-level systemd service template for the Telegram Codex bridge.
This repo owns the service definition and wrapper script. The actual bridge implementation is currently loaded from `~/Coding/notea/scripts/telegram-codex-bridge.mjs` by default, and the default Codex workspace root is `~/Coding`.

The generated env file lives at:

```bash
~/.config/coding/telegram-codex.env
```

Recommended repository root:

```bash
~/Coding
```

After filling in `TELEGRAM_BOT_TOKEN`, start the bridge with:

```bash
systemctl --user start telegram-codex.service
systemctl --user status telegram-codex.service
```

If `notea` is not cloned yet, do that first:

```bash
cd ~/Coding
git clone <your-notea-repo-url> notea
cd notea
npm install
```

## Codex Sandbox Notes

Codex on Ubuntu needs rootless namespace support. The required state on this machine is:

- `bubblewrap` installed
- `kernel.apparmor_restrict_unprivileged_userns = 0`

Verification:

```bash
which bwrap
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns
unshare --user --map-root-user /bin/true
bwrap --unshare-net --ro-bind / / --proc /proc --dev /dev /bin/true
```

Important nuance:

- `unshare` succeeded in-session.
- `bwrap --unshare-net ...` failed inside the Codex sandbox with `Failed to create NETLINK_ROUTE socket: Operation not permitted`.
- The same `bwrap --unshare-net ...` command succeeded when run outside the sandbox on the host.
- On a new AWS instance, re-check this explicitly. The fix may still be required depending on the image, kernel, AppArmor defaults, and VM handling.

That means the host itself is correctly configured, and the earlier failure was sandbox-local rather than a missing host prerequisite.
