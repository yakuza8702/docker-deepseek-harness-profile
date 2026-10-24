# dsh-cua-vm — a personal Linux VM per workspace

The model gets a real Linux computer to build, test and troubleshoot in, while
the harness keeps `workspace-write`.

## Why a supervisor

The sandbox grants read-write only to `/dev/null`, `/tmp` and the workspace root
(`packages/sandbox/sandbox-local/src/profiles.ts`). QEMU opens `/dev/kvm`
`O_RDWR`, and the VM store must live outside the workspace, so a VM can never be
started from the agent's shell — and shouldn't be.

```
entrypoint.sh
  └── cua-vm-supervisor        (before any Session, outside the sandbox)
        ├── /dev/kvm, QEMU, cua daemon
        └── /cua-vm  (volume: base image, per-workspace deltas, logs)

dsh-cua-vm (this plugin)
  └── tools ── JSON over /tmp/cua-vm/supervisor.sock ──▶ supervisor
```

Nothing in the tool path opens the device or touches the store; the tools only
write to a unix socket under `/tmp`, which `workspace-write` already allows.

## Tools

| Tool | Purpose |
|---|---|
| `cua_vm_status` | which VM exists, its state, tier, last command |
| `cua_vm_ensure` | create or resume the VM for this workspace (idempotent) |
| `cua_vm_exec` | run a shell command, return exit code + stdout/stderr |
| `cua_vm_put` / `cua_vm_get` | copy in / copy the product out |
| `cua_vm_port` | open a forward and publish it at `/vm/port/<name>/` |
| `cua_vm_suspend` | stop, keep the disk |
| `cua_vm_destroy` | delete the VM and disk (explicit user request only) |

One VM per workspace, named `ws-<sha256(workspace)[0:12]>`, recorded in
`/cua-vm/registry.json` — never in the workspace.

## Isolation rules the supervisor enforces

* every host path is resolved and must stay under `CUA_WORKSPACE_ROOT`;
* `vm_put` reads only from the workspace, `vm_get` writes only into it;
* the guest never sees `/workspace` — file transfer is explicit;
* the store is `/cua-vm`, so `docker volume rm <stack>_cua-vm` reclaims all of it.

## Switches

| Variable | Default | Meaning |
|---|---|---|
| `DSH_CUA_VM` | `1` | `0` removes the bundle row and the tools |
| `CUA_VM_STORE` | `/cua-vm` | volume holding images, disks, QEMU, logs |
| `CUA_WORKSPACE_ROOT` | `/workspace` | the only host tree the tools may touch |
| `CUA_VM_TIER` | `slim` | `slim` or `full` guest image |

Runtime policy is **not** environment configuration: `/cua-vm/config.json`
holds `autoSuspend`, `idleSuspendMinutes` (default 30, `0` disables),
`diskQuotaGb` (default 20) and `maxRunning` (default 1), and is edited from the
Plugins page (Personal VM → Settings). The supervisor re-reads it every minute,
so a saved change needs no restart; a command in flight postpones the suspend.
| `CUA_SUPERVISOR_SOCK` | `/tmp/cua-vm/supervisor.sock` | control socket |

## Requirements

* `/dev/kvm` in the container (`compose.emulator.yaml`), nested virt on the host;
* the `cua-vm` volume (created by `compose.yaml`);
* network egress for the first image pull (base disk ~1.3 GB).

QEMU is **not** in the image: the supervisor runs `cua runtime setup qemu` into
`/cua-vm/home/.cua` on first use, then repairs the release bundle's missing
seabios symlinks (QEMU otherwise dies with `could not load PC BIOS
'bios-256k.bin'`). That keeps ~200 MB out of every image layer.

## Notes on cua 0.7.0

The published CLI has no `--headless` flag yet and `--tier` accepts `slim` /
`full` only; the VM therefore always boots its desktop session, and readiness is
waited on `tcp:3211` (the in-guest daemon). `--wait desktop` is available through
`waitForDesktop` when input must be ready. `--kind vm` is QEMU/KVM on Linux; the
in-guest `cua-spacesd` on 3211 is what `exec`, `cp`, `port-forward` and
screenshots go through — no SSH involved.
