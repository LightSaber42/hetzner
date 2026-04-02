# Agent Notes

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
