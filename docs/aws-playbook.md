# AWS Transfer Playbook

This playbook moves the current Hetzner-style developer environment onto AWS while keeping secrets out of source control.

## Target Shape

Use:

- AWS EC2
- Ubuntu 24.04 LTS
- one non-root admin user, preferably `developer`
- SSH access only
- EBS-backed root volume

Recommended starting point:

- `t3.large` or `t3.xlarge` for general dev
- `30-80 GB` gp3 root volume
- security group allowing:
  - `22/tcp` from your IP
  - any app-specific ports only if intentionally exposed

## Phase 1: Build the New Host

1. Launch an Ubuntu 24.04 EC2 instance.
2. Attach an SSH key pair you control.
3. Allocate and attach an Elastic IP if you want a stable public address.
4. SSH in as the Ubuntu default user.
5. Create the long-lived working user:

```bash
sudo adduser developer
sudo usermod -aG sudo developer
```

6. Copy this repo to the machine:

```bash
sudo mkdir -p /home/developer/Coding
sudo chown -R developer:developer /home/developer
```

Then clone or sync the repo into `/home/developer/Coding/hetzner`.

## Phase 2: Recreate the Base Environment

As `root`:

```bash
cd /home/developer/Coding/hetzner
sudo bash scripts/bootstrap_root.sh
```

As `developer`:

```bash
cd /home/developer/Coding/hetzner
bash scripts/bootstrap_user.sh
```

If you want Git identity configured in one pass:

```bash
GIT_USER_NAME="Your Name" \
GIT_USER_EMAIL="you@example.com" \
bash scripts/bootstrap_user.sh
```

Open a new shell after bootstrap so `PATH` and `docker` group membership apply.

If you need Azure CLI on the new host, note that on the source machine as of `2026-04-03`, `azure-cli` was not available from the configured apt repositories. The fallback that worked there was:

```bash
sudo apt-get install -y python3-pip
python3 -m pip install --user azure-cli
~/.local/bin/az version
```

If `~/.local/bin` is on `PATH`, `az version` should work directly after opening a new shell.

## Phase 3: Restore Identity and Access

Do these manually. Do not copy token files from the old machine unless you explicitly accept the security tradeoff.

### GitHub SSH

Generate a fresh key on AWS:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_github -C "you@example.com"
cat ~/.ssh/id_ed25519_github.pub
```

Add the public key to GitHub, then verify:

```bash
ssh -T git@github.com
```

### Codex

Authenticate normally on the new host:

```bash
codex
```

Do not copy `~/.codex/auth.json`.

### Railway

Authenticate normally:

```bash
railway login
```

Then link each project locally again:

```bash
cd /path/to/project
railway link
railway environment
railway service
```

Do not copy `~/.railway/config.json` because it contains refresh and access tokens.

### Tailscale

Bring the node into your tailnet with a fresh auth flow:

```bash
sudo tailscale up
```

### Cloudflare Tunnel

If this machine needs Cloudflare Tunnel, re-authenticate and re-create the tunnel config rather than copying credentials blindly.

## Phase 4: Restore Repositories and Workspaces

Clone working repos fresh:

```bash
mkdir -p /home/developer/Coding
cd /home/developer/Coding
git clone git@github.com:ORG/hetzner.git
git clone git@github.com:ORG/notea.git
git clone git@github.com:ORG/unitc.git
```

Only copy local uncommitted work if you actually need it. Preferred order:

1. Push branches from the source machine.
2. Pull them on AWS.
3. Copy uncommitted diffs only as a last resort.

## Phase 5: Verify

Run:

```bash
cd /home/developer/Coding/hetzner
bash scripts/verify_setup.sh
```

Also verify:

```bash
docker ps
ssh -T git@github.com
railway --version
codex --version
```

## Migration Checklist

- Provision EC2 Ubuntu 24.04
- Create `developer` user
- Sync this `hetzner` repo
- Put working repos under `/home/developer/Coding`
- Run `scripts/bootstrap_root.sh`
- Run `scripts/bootstrap_user.sh`
- Re-login
- Generate fresh SSH keys
- Re-auth Codex
- Re-auth Railway
- Reconnect Tailscale
- Clone repos
- Run `scripts/verify_setup.sh`

## Notes Specific To This Source Machine

Observed here:

- Node comes from NodeSource `node_24.x`
- Docker comes from Docker's apt repo
- `cloudflared` and `tailscale` are installed from vendor repos
- `uv` is part of the current baseline and is installed by `scripts/bootstrap_user.sh`
- `bubblewrap` and `kernel.apparmor_restrict_unprivileged_userns=0` are required for Codex sandboxing on Ubuntu; both `unshare --user --map-root-user /bin/true` and `bwrap --unshare-net ...` succeeded on the source host on `2026-04-24`
- `az` is not installed on the source machine; the last known working install path observed on `2026-04-03` was `python3-pip` plus `python3 -m pip install --user azure-cli`
- even when the source machine is healthy, still verify `bwrap --unshare-net ...` on AWS because VM/kernel behavior can differ across providers and images
- the `docker` group entry includes `developer`, but Docker access should still be verified after a fresh login because session state and socket permissions can differ during bootstrap
- Android-related dot-directories existed, but `java`, `adb`, and `gradle` were not installed system-wide, so Android tooling is not part of the reproducible baseline yet
- `~/.tmux.conf` now enables mouse mode and remaps the prefix to `C-a`

## What Not To Migrate Blindly

Avoid machine-to-machine copies of:

- `~/.ssh/id_*`
- `~/.railway/config.json`
- `~/.codex/auth.json`
- shell history files
- editor state databases
- any cached project secrets

Recreate credentials and trust relationships cleanly on AWS.
