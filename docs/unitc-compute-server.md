# UnitC Compute Server Playbook

This playbook documents the recommended shape for a private third-party model executor that Railway can reach over Tailscale.

It is based on the working `noteadev` setup and is intended to be reused for future compute nodes on Hetzner, AWS, or similar Ubuntu hosts.

## Target Shape

Use:

- Ubuntu 24.04 LTS
- one non-root admin user, preferably `developer`
- Tailscale on the host
- the UnitC backend running host-native in a dedicated Python venv
- one user service per bound model
- a shared runtime env file at `/srv/unitc-external-model/model.env`
- local bind only on `127.0.0.1`
- `tailscale serve` for tailnet-only ingress
- Railway env vars to select the external model endpoint and API key

Do not make raw host ports or public ingress the default path. Keep the executor private to the tailnet unless there is a specific reason not to.

## Why This Shape

- It avoids exposing solver infrastructure directly to the public internet.
- It works well when the compute host is IPv6-only but still reachable over Tailscale.
- It keeps Railway-to-compute traffic on the tailnet.
- It avoids an unnecessary reverse-proxy layer when `tailscale serve` already handles the access boundary cleanly.

## Provider Notes

### Hetzner

Hetzner nodes may have IPv6 but no native public IPv4. That does not block Railway-to-compute traffic over Tailscale.

Only add a Tailscale exit node if the compute host itself must call an IPv4-only upstream service.

### AWS

AWS works the same way for this pattern. The main difference is provisioning, not the runtime architecture.

## Ownership Boundary

This repo owns the host bootstrap assets, service templates, and reusable compute-host playbook.
Keep app-specific remote deploy helpers in the `unitc` repo because they operate on application branches and runtime code, not on machine bootstrap state.

## Current `noteadev` Reference Layout

The live `noteadev` host currently uses:

- app working dir: `~/Coding/unitc/backend`
- venv: `~/.venvs/unitc-external-model`
- shared env file: `/srv/unitc-external-model/model.env`
- `unitc-external-model.service`: `127.0.0.1:18001` -> `exact_sos2`
- `unitc-external-model-fast-linear.service`: `127.0.0.1:18002` -> `fast_linear`
- `unitc-external-model-highs.service`: `127.0.0.1:18003` -> `highs_piecewise_milp`
- tailnet URL: `http://notea-dev-hetzner.tailcd5aec.ts.net/`
- Railway-facing solve endpoint: `http://notea-dev-hetzner.tailcd5aec.ts.net/solve/external`

## Phase 1: Bootstrap The Host

Use this repo first:

```bash
mkdir -p ~/Coding
cd ~/Coding
git clone <your-hetzner-repo-url> hetzner
cd ~/Coding/hetzner
sudo bash scripts/bootstrap_root.sh
bash scripts/bootstrap_user.sh
bash scripts/verify_setup.sh
```

Then clone the app repo:

```bash
cd ~/Coding
git clone <your-unitc-repo-url> unitc
```

## Phase 2: Prepare The Executor Runtime

Install the backend runtime dependencies on the host:

```bash
sudo apt-get install -y coinor-cbc python3-venv
mkdir -p ~/.venvs
uv venv ~/.venvs/unitc-external-model
uv pip install --python ~/.venvs/unitc-external-model/bin/python --upgrade pip
uv pip install --python ~/.venvs/unitc-external-model/bin/python -r ~/Coding/unitc/backend/requirements.txt
```

Create the runtime directories:

```bash
sudo mkdir -p /srv/unitc-external-model/data
sudo chown -R "$USER:$USER" /srv/unitc-external-model
```

Create the env file:

```bash
cat >/srv/unitc-external-model/model.env <<'EOF'
EXTERNAL_MODEL_API_KEY=<shared-secret>
DISABLE_AUTH=true
DATA_DIR=/srv/unitc-external-model/data
REQUIRE_PERSISTENT_DATA_DIR=false
AUTO_RESUME_ENABLED=false
EOF
```

Notes:

- `DISABLE_AUTH=true` is correct here because this backend is not public-facing.
- `EXTERNAL_MODEL_API_KEY` is still required and should match Railway.
- keep this env file off git.

## Phase 3: Install The User Services

This repo ships three service templates:

- [`systemd/unitc-external-model.service`](../systemd/unitc-external-model.service): `exact_sos2` on `18001`
- [`systemd/unitc-external-model-fast-linear.service`](../systemd/unitc-external-model-fast-linear.service): `fast_linear` on `18002`
- [`systemd/unitc-external-model-highs.service`](../systemd/unitc-external-model-highs.service): `highs_piecewise_milp` on `18003`

Install them into `~/.config/systemd/user/`:

```bash
mkdir -p ~/.config/systemd/user
cp ~/Coding/hetzner/systemd/unitc-external-model.service ~/.config/systemd/user/unitc-external-model.service
cp ~/Coding/hetzner/systemd/unitc-external-model-fast-linear.service ~/.config/systemd/user/unitc-external-model-fast-linear.service
cp ~/Coding/hetzner/systemd/unitc-external-model-highs.service ~/.config/systemd/user/unitc-external-model-highs.service
systemctl --user daemon-reload
systemctl --user enable --now unitc-external-model.service
systemctl --user enable --now unitc-external-model-fast-linear.service
systemctl --user enable --now unitc-external-model-highs.service
systemctl --user status unitc-external-model.service
systemctl --user status unitc-external-model-fast-linear.service
systemctl --user status unitc-external-model-highs.service
```

Expected binds:

- `127.0.0.1:18001` -> `exact_sos2`
- `127.0.0.1:18002` -> `fast_linear`
- `127.0.0.1:18003` -> `highs_piecewise_milp`

Quick local validation:

```bash
curl -sf http://127.0.0.1:18001/healthz
curl -sf http://127.0.0.1:18002/healthz
curl -sf http://127.0.0.1:18003/healthz
```

## Phase 4: Expose It To The Tailnet

Grant the working user operator control once:

```bash
sudo tailscale set --operator="$USER"
```

Expose the local backend with Tailscale Serve:

```bash
tailscale serve --bg --http=80 http://127.0.0.1:18001
tailscale serve --bg --http=18002 http://127.0.0.1:18002
tailscale serve --bg --http=18003 http://127.0.0.1:18003
tailscale serve status
```

This produces a tailnet-only URL like:

```text
http://<hostname>.<tailnet>.ts.net/
```

The Railway-facing solve endpoint should then be:

```text
http://<hostname>.<tailnet>.ts.net/solve/external
```

Validation from another tailnet client:

```bash
curl -sf http://<hostname>.<tailnet>.ts.net/healthz
curl -sf http://<hostname>.<tailnet>.ts.net:18002/healthz
curl -sf http://<hostname>.<tailnet>.ts.net:18003/healthz
```

Notes:

- The `80 -> 18001` mapping is enough for the primary `/solve/external` endpoint.
- The `18002` and `18003` listeners are useful when you want direct health checks or per-port access to the additional bound-model services.

## Phase 5: Wire Railway To The Compute Host

On the Railway backend service, set:

```env
TAILSCALE_ENABLED=true
TAILSCALE_AUTHKEY=<railway-node-auth-key>
TAILSCALE_STATE_DIR=/data/tailscale
TAILSCALE_HOSTNAME=<railway-node-name>
TAILSCALE_STARTUP_TIMEOUT_SECONDS=45

UNITC_EXTERNAL_MODEL_URL=http://<hostname>.<tailnet>.ts.net/solve/external
UNITC_EXTERNAL_MODEL_API_KEY=<same shared-secret>

DEFAULT_EXTERNAL_MODEL_ENABLED=true
DEFAULT_EXTERNAL_MODEL_URL=env:UNITC_EXTERNAL_MODEL_URL
DEFAULT_EXTERNAL_MODEL_API_KEY=env:UNITC_EXTERNAL_MODEL_API_KEY
DEFAULT_EXTERNAL_MODEL_ID=<stable-model-id>
DEFAULT_EXTERNAL_MODEL_LABEL=<display-name>
```

Important:

- the UnitC Railway backend reaches the tailnet through its local Tailscale HTTP proxy
- app traffic uses that proxy automatically when `TAILSCALE_ENABLED=true`
- ad hoc `railway ssh` shells do not automatically inherit the app process export, so manual curl and requests tests should pass `http://127.0.0.1:1055` explicitly as the proxy

Example manual validation from the Railway container:

```bash
curl --proxy http://127.0.0.1:1055 -sf http://<hostname>.<tailnet>.ts.net/healthz
```

## Exit Node Guidance

Do not configure an exit node by default.

Use an exit node only if the compute host must make outbound requests to IPv4-only services. If you do need one:

- choose a stable server node
- avoid using a phone, TV, or intermittently online device
- prefer a dedicated AWS or always-on Linux node

Example:

```bash
sudo tailscale set --exit-node=<stable-exit-node-name> --exit-node-allow-lan-access=true
```

## Operational Checklist

- Host bootstrapped with this repo
- `unitc` cloned under `~/Coding`
- venv created at `~/.venvs/unitc-external-model`
- runtime env file created at `/srv/unitc-external-model/model.env`
- `unitc-external-model.service` enabled and healthy
- optional `unitc-external-model-fast-linear.service` enabled if you need the fast CBC model
- optional `unitc-external-model-highs.service` enabled if you need the HiGHS model
- `tailscale serve status` shows the local proxy
- Railway backend vars set to the tailnet URL and shared API key
- Railway staging or production can complete `/solve/external` successfully
