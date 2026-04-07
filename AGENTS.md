# Agent Notes

## Repo Purpose

This repo owns machine-bootstrap assets for the Ubuntu developer environment:

- reproducible host bootstrap scripts
- cloud-init templates
- host networking helpers
- Telegram Codex service scaffolding
- migration notes for AWS or other providers

Do not leave these artifacts in app repos like `notea` once they clearly belong here.

## Python Tooling

Use `uv` as the default Python tool runner and package manager for this repo.

Expect recreated hosts to install `uv` via `scripts/bootstrap_user.sh`.
When adding Python helpers here:

- prefer `uv tool install ...` for standalone CLI tools
- prefer `uv venv` and `uv pip install ...` over ad hoc global `pip install`
- keep Python dependencies explicit and documented
- do not assume `requests` or other third-party modules are preinstalled unless this repo installs them

## Cloud-Init And Secrets

Cloud-init templates in `cloud-init/` must stay sanitized.

Never commit:

- live Tailscale auth keys
- live Cloudflare tunnel tokens
- real private SSH keys
- provider-specific secrets copied from a machine

Use placeholders and document replacement steps in `README.md`.

## Codex Sandbox On Hetzner

This machine required host-level fixes before Codex sandboxing worked reliably.

Symptoms:
- Codex repeatedly asked to retry commands without sandbox
- sandboxed commands failed with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`

Required machine state:
- `bubblewrap` installed
- `kernel.apparmor_restrict_unprivileged_userns = 0`

Checks:

```bash
which bwrap
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns
unshare --user --map-root-user /bin/true
bwrap --unshare-net --ro-bind / / --proc /proc --dev /dev /bin/true
```

If `unshare` or `bwrap` fail with uid-map or loopback permission errors, re-apply:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
sudo sysctl --system
```
