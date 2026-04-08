# Hetzner Developer Machine

This directory documents the Ubuntu developer box and provides scripts and templates to recreate the environment on another host, including Hetzner and AWS EC2.

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
- Git, SSH, Codex, Docker, Railway, and `uv` bootstrap steps
- cloud-init templates for first-boot machine setup
- IPv6 helper script for Hetzner-style statically assigned IPv6
- Azure CLI fallback install notes
- Telegram Codex bridge service scaffolding
- Verification commands
- An AWS migration playbook

This repo intentionally does **not** store secrets. Do not copy:

- `~/.codex/auth.json`
- `~/.railway/config.json`
- `~/.ssh/*` private keys
- any live Tailscale auth keys or Cloudflare tunnel tokens
- any existing cloud, GitHub, or package registry tokens

Re-authenticate on the target machine instead.

## Compute Server Pattern

For UnitC-style private compute workers, the preferred shape is:

- Ubuntu 24.04 host
- one non-root admin user such as `developer`
- Tailscale on the host
- the model executor bound only to `127.0.0.1`
- `tailscale serve` exposing the local executor to the tailnet
- Railway routing to the executor through env vars

This is the pattern now proven on `noteadev`. Use the dedicated playbook in [`docs/unitc-compute-server.md`](docs/unitc-compute-server.md) when bringing up additional compute nodes.

## Current Machine Summary

Observed on `2026-04-02` through `2026-04-04`:

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

### Python Tooling Baseline

Observed on `2026-04-04`:

- `uv` was **not** installed yet on the current box.
- This repo now installs `uv` during `scripts/bootstrap_user.sh` so future hosts have a consistent Python tool runner and package manager.
- Prefer `uv` for Python-based helpers and one-off tools on recreated hosts.

Example checks after bootstrap:

```bash
uv --version
uv tool list
```

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
```

Then open a new shell and run:

```bash
cd ~/Coding/hetzner
bash scripts/verify_setup.sh
```

If you want Git identity configured during bootstrap:

```bash
GIT_USER_NAME="Your Name" \
GIT_USER_EMAIL="you@example.com" \
bash scripts/bootstrap_user.sh
```

## Cloud-Init Templates

Sanitized first-boot templates now live in `cloud-init/`.
These are intended for new Hetzner or AWS Ubuntu hosts and must be reviewed before use.

Available templates:

- `cloud-init/notea-dev-cloud-init-safe-placeholders.yaml`: safe baseline with placeholder secrets
- `cloud-init/notea-dev-cloud-init-safe-with-ipv6.yaml`: safe baseline plus placeholder IPv6 values
- `cloud-init/notea-dev-cloud-init-noninteractive-placeholders.yaml`: non-interactive variant that auto-connects only when placeholders are replaced before first boot
- `cloud-init/notea-dev-cloud-init-with-tailscale-cloudflare.yaml`: interactive-leaning template with manual post-install guidance

Before using any template:

- replace SSH key placeholders
- replace any Tailscale or Cloudflare placeholders
- replace hostname and server-specific IPv6 values where applicable
- do not commit live credentials back into this repo

## Hetzner IPv6 Helper

For existing hosts that need manual static IPv6 netplan setup after first boot, use:

```bash
sudo bash scripts/configure_hetzner_ipv6.sh '<IPV6_ADDRESS_WITH_PREFIX>' '<IPV6_GATEWAY_LINK_LOCAL>'
```

Example:

```bash
sudo bash scripts/configure_hetzner_ipv6.sh '2a01:4f9:c013:d106::1/64' 'fe80::1'
```

The script backs up common netplan files, writes `/etc/netplan/60-hetzner-ipv6.yaml`, runs `netplan generate`, applies the config, and prints the resulting IPv6 addresses and routes.

## Files

- `scripts/bootstrap_root.sh`: root-level packages, repositories, services, sysctl
- `scripts/bootstrap_user.sh`: shell, npm global path, Codex/Railway install, `uv` install, Git/SSH templates
- `scripts/configure_hetzner_ipv6.sh`: apply a static Hetzner-style IPv6 netplan config
- `scripts/get_telegram_ids.sh`: resolve `TELEGRAM_CHAT_ID` and `TELEGRAM_USER_ID` from a bot token
- `scripts/codex_telegram_wrapper.sh`: Codex launcher wrapper used for non-git workspace roots like `~/Coding`
- `scripts/install_telegram_codex_service.sh`: install the user-level systemd unit and env template
- `scripts/run_telegram_codex_bridge.sh`: local wrapper that launches the Telegram bridge implementation from this repo
- `scripts/telegram_codex_bridge.mjs`: Telegram-to-Codex bridge with resumable shared state and inbound file download support
- `scripts/telegram_file_mcp.mjs`: MCP server that lets any Codex instance send files to the configured Telegram chat and inspect received-file inbox history
- `scripts/resume_telegram_codex.sh`: resume the bridge conversation from another local Codex instance
- `scripts/verify_setup.sh`: post-setup verification
- `cloud-init/*.yaml`: sanitized machine bootstrap templates for first-boot provisioning
- `systemd/telegram-codex.service`: user-level service template for the Telegram Codex bridge
- `systemd/unitc-external-model.service`: user-level service template for a UnitC external model executor
- `docs/aws-playbook.md`: step-by-step transfer plan from this box to AWS
- `docs/unitc-compute-server.md`: provider-agnostic playbook for tailnet-only compute servers used by Railway

## Telegram Helper

Create your bot in Telegram with `@BotFather`, send that bot a message once, then run:

```bash
bash scripts/get_telegram_ids.sh <telegram-bot-token>
```

The script prints the `chat_id` and `user_id` values you need for the Telegram Codex bridge.

## Telegram Codex Service

Bootstrap now installs a user-level systemd service template for the Telegram Codex bridge.
This repo now owns the service definition, wrapper script, bridge implementation, MCP helper, and resume helper. The default Codex workspace root remains `~/Coding`.

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

Resume the same Telegram conversation in another local Codex instance with:

```bash
/home/developer/Coding/hetzner/scripts/resume_telegram_codex.sh
```

Telegram file behavior:

- Text messages are forwarded to Codex with resumable context.
- Incoming Telegram files are downloaded to `~/.local/state/coding/telegram-codex/inbox/<chat>-<user>/` and the saved local path is injected into the Codex prompt.
- Bridge state is written to `~/.config/coding/telegram-codex-state-<chat>-<user>.json`, which stores the current `thread_id`, workdir, and resume command for other Codex instances.

Register the MCP server once so any Codex instance on the machine can send files back to Telegram and inspect the received-file inbox:

```bash
codex mcp add telegram-file -- node /home/developer/Coding/hetzner/scripts/telegram_file_mcp.mjs
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
