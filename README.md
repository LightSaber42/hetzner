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
The checked-in UnitC service templates now mirror the live `noteadev` user services: `exact_sos2` on `127.0.0.1:18001`, `fast_linear` on `127.0.0.1:18002`, and `highs_piecewise_milp` on `127.0.0.1:18003`.

## Current Machine Summary

Observed on `2026-04-24` unless noted:

- Hostname: `notea-dev`
- OS: Ubuntu `24.04.4 LTS`
- Kernel: `6.8.0-106-generic`
- Primary user: `developer`
- Current shell groups: `developer`, `nogroup`
- `/etc/group` membership includes `docker:x:1000:developer`
- Repos present under `~/Coding`: `hetzner`, `notea`, `unitc`, `work`
- Current IPv6 netplan file on the host: `/etc/netplan/60-notea-ipv6.yaml` (legacy name; new helper/template use `/etc/netplan/60-hetzner-ipv6.yaml`)
- User service units present: `telegram-codex.service`, `unitc-external-model.service`, `unitc-external-model-fast-linear.service`, `unitc-external-model-highs.service`

### Installed/Configured Tooling

- `git 2.43.0`
- `node v24.14.1`
- `npm 11.11.0`
- `python3 3.12.3`
- `uv 0.11.3`
- `docker 29.4.0`
- `tmux 3.4`
- `jq 1.7`
- `curl 8.5.0`
- `bubblewrap 0.9.0`
- CLI versions:
  - `codex-cli 0.121.0`
  - `railway 4.36.1`

### Python Tooling Baseline

Observed on `2026-04-24`:

- `uv` is now installed on the current box and should be treated as part of the default Python baseline for recreated hosts.
- `scripts/bootstrap_user.sh` installs `uv` if missing.
- Prefer `uv` for Python-based helpers and one-off tools on recreated hosts.

Example checks after bootstrap:

```bash
uv --version
uv tool list
```

### User-Level Dotfiles Observed

- `~/.tmux.conf`: mouse enabled plus `C-a` prefix remap, with backup at `~/.tmux.conf.bak-20260417`
- `~/.bashrc`: mostly Ubuntu default, plus `alias dc="docker compose"`
- `~/.profile`: includes `~/.local/bin` on `PATH` and an explicit Codex-added `PATH` export
- `~/.npmrc`: `prefix=/home/developer/.local`
- `~/.ssh/config`: GitHub host entry pointing at `~/.ssh/id_ed25519_github`, plus a `macbook` Tailscale SSH host alias
- `~/.codex/config.toml`: bootstrap default plus user-specific model selection (`gpt-5.4` with `xhigh`), trusted `~/Coding*` projects, and Railway MCP config

### User-Level State That Should Not Be Treated As Baseline

- `~/.codex/auth.json`: live auth state
- `~/.codex/config.toml`: custom model, trusted project list, and MCP registry beyond the minimal bootstrap default
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

Observed on `2026-04-24`:

- `az` is still not installed on the current host.
- The last known working fallback observed on `2026-04-03` was to install `python3-pip` via apt, then install `azure-cli` from PyPI.

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
- current user services on this host: `telegram-codex.service`, `unitc-external-model.service`, `unitc-external-model-fast-linear.service`, `unitc-external-model-highs.service`

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
The current `notea-dev` host still uses the earlier filename `/etc/netplan/60-notea-ipv6.yaml`; new bootstrap artifacts in this repo standardize on `/etc/netplan/60-hetzner-ipv6.yaml`.

## Files

- `scripts/bootstrap_root.sh`: root-level packages, repositories, services, sysctl
- `scripts/bootstrap_user.sh`: shell, npm global path, Codex/Railway install, `uv` install, Git/SSH templates
- `scripts/configure_hetzner_ipv6.sh`: apply a static Hetzner-style IPv6 netplan config
- `scripts/get_telegram_ids.sh`: resolve `TELEGRAM_CHAT_ID` and `TELEGRAM_USER_ID` from a bot token
- `scripts/codex_telegram_wrapper.sh`: Codex launcher wrapper used for non-git workspace roots like `~/Coding` and for bridge-scoped MCP injection
- `scripts/install_telegram_codex_service.sh`: install the user-level systemd unit and env template
- `scripts/run_telegram_codex_bridge.sh`: local wrapper that launches the Telegram bridge implementation from this repo
- `scripts/telegram_codex_bridge.mjs`: Telegram-to-Codex bridge with resumable shared state and inbound file download support
- `scripts/telegram_file_mcp.mjs`: MCP server that lets any Codex instance send files to the configured Telegram chat and inspect received-file inbox history
- `scripts/resume_telegram_codex.sh`: resume the bridge conversation from another local Codex instance
- `scripts/verify_setup.sh`: post-setup verification
- `cloud-init/*.yaml`: sanitized machine bootstrap templates for first-boot provisioning
- `systemd/telegram-codex.service`: user-level service template for the Telegram Codex bridge
- `systemd/unitc-external-model.service`: user-level service template for the `exact_sos2` UnitC executor
- `systemd/unitc-external-model-fast-linear.service`: user-level service template for the `fast_linear` UnitC executor
- `systemd/unitc-external-model-highs.service`: user-level service template for the `highs_piecewise_milp` UnitC executor
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

Bridge MCP behavior:

- `scripts/codex_telegram_wrapper.sh` injects the `telegram-file` MCP into bridge-owned Codex sessions with `-c mcp_servers.telegram-file...`.
- `telegram-codex.service` and `resume_telegram_codex.sh` therefore work without a prior global `codex mcp add`.
- `scripts/verify_setup.sh` checks MCP visibility through the wrapper so it matches the real bridge execution path.
- The bridge fingerprints the visible MCP set and resets a saved thread automatically if the capability set changes.

Bridge commands currently available over Telegram:

- `/start`, `/help`, `/status`, `/session`, `/new`, `/model`, `/stop`
- `/urgentstop` is accepted as an alias for `/stop`
- `/model <name>` sets a runtime model override for future bridge runs
- `/model default` clears the runtime model override

Optional global registration:

If you also want standalone Codex sessions outside the bridge/resume wrapper to see the same tool, register it globally once:

```bash
codex mcp add telegram-file -- /usr/bin/node /home/developer/Coding/hetzner/scripts/telegram_file_mcp.mjs
codex mcp list
```

Expected global entry:

```text
telegram-file  /usr/bin/node  /home/developer/Coding/hetzner/scripts/telegram_file_mcp.mjs
```

A running Codex session does not hot-load newly added MCP servers. After changing the global MCP config, start or resume a fresh Codex process.

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

Observed on `2026-04-24`:

- `unshare --user --map-root-user /bin/true` succeeded on this host.
- `bwrap --unshare-net ...` also succeeded on this host.
- The earlier loopback/socket failures that motivated this repo were not reproducible during the current check.

On a new host, if `unshare` or `bwrap` fail with uid-map or loopback permission errors, re-apply:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
sudo sysctl --system
```
