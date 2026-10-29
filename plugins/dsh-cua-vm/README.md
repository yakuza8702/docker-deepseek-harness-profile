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
| `cua_vm_create` | New computer: name, vCPU, RAM, image, `gpu`, `diskGb`, `android`, `rea` |
| `cua_vm_gui` | drive the desktop: screenshot, geometry, click/drag, type/key, windows, a11y, zoom, launch |
| `cua_vm_disk` | grow the disk online (QMP `block_resize` + `growpart`), no reboot, cannot shrink |
| `cua_vm_android` | install the Google Android SDK + AVD inside the VM, boot with `cua-emulator` |
| `cua_vm_exec` | run a shell command, return exit code + stdout/stderr |
| `cua_vm_put` / `cua_vm_get` | copy in / copy the product out |
| `cua_vm_port` | open a forward and publish it at `/vm/port/<name>/` |
| `cua_vm_suspend` | stop, keep the disk |
| `cua_vm_destroy` | delete the VM and disk (explicit user request only) |

One VM per workspace, named `ws-<sha256(workspace)[0:12]>`, recorded in
`/cua-vm/registry.json` — never in the workspace.

## REA in the computer

`cua_vm_create` with `rea: true` (or **Enable REA** in New computer) installs
the reverse-engineering kit *inside* the guest, from
`docker/cua-guest-rea.sh` — a real file, not a blob in the supervisor, so it can
be read, diffed and run by hand.

| Component | What lands in the guest |
|---|---|
| Node | `v22.23.4` in `/opt/node22`, symlinked into `/usr/local/bin` (`node`, `npm`, `npx`) |
| `rea-agents` | CLI + MCP server from npm (global root), entry `…/rea-agents/scripts/rea.mjs` |
| JDK | `openjdk-21-jdk-headless` — Ghidra and JADX both run on it |
| Ghidra | `12.1.4` unpacked at `/opt/ghidra`, `support/analyzeHeadless` + the native `decompile` binary |
| JADX | `1.5.6` plus the pinned `jadx-headless-mcp-0.7.1-all.jar` (sha256-verified) in `/opt/rea/android` |
| `procps` | `ps`/`top` for the doctor's process probes |

**Disk floor: 40 GB.** Ghidra unpacks to ~1.4 GB and the JDK, JADX, Node and
`rea-agents` add up to roughly 3.5 GB installed; on a stock 20 GB disk the unzip
dies with `ENOSPC`, which reads like a corrupt download rather than a sizing
mistake. So the floor exists in three places: the panel raises the Disk field to
40 when the box is ticked, the supervisor clamps `effectiveDiskGb` to
`REA_MIN_DISK_GB` and reports `diskGbRaised`, and the tool schema says so. The
store quota is *not* raised automatically — if `/cua-vm/config.json` still has
`diskQuotaGb: 20`, the create is refused and the panel says: "The VM store quota
is N GB, so a 40 GB REA disk cannot be created. Raise Disk Size in the Policy
tab first."

**The environment reaches the guest three ways.** `/etc/profile.d/rea.sh` for
login shells (`JAVA_HOME`, `GHIDRA_INSTALL_DIR`, `REA_ANALYSIS_PROVIDER=ghidra`,
`REA_JADX_MCP_JAR`, and `/opt/node22/bin` prepended to `PATH`),
`/etc/environment` as `KEY="value"` for PAM sessions, and
`/etc/systemd/system/cua-spacesd.service.d/20-rea.conf` for the desktop session
— which is the one that matters, because `cua sb exec` children inherit *that*
session, not the provisioning shell. The drop-in is applied with a detached
`setsid sh -c 'sleep 5; systemctl daemon-reload; systemctl restart cua-spacesd'`,
so restarting spacesd does not kill the script that is restarting it.

**Registration is non-interactive.** `rea setup --client dsh --yes --json` writes
the MCP row itself; if it does not, the script appends the same fragment by hand
to `/home/cua/.dsh/cordis.patch.yml` — row `id: rea-mcp`, `name:
'@deepseek-ai/dsh-mcp-client'`, `serverName: rea`, stdio through the pinned
`node` with `GHIDRA_INSTALL_DIR`/`JAVA_HOME`/`REA_ANALYSIS_PROVIDER`/
`REA_JADX_MCP_JAR` in `env`. `rea setup --skill --yes --json` installs the
skills. Note what this is **not**: the harness image needs no MCP row of its own
— agents reach REA through `cua_vm_exec`, and the row belongs to a DSH instance
running *inside* the guest.

The marker `/var/lib/cua-rea` is written **last**, only after
`rea doctor --provider ghidra --json` passes, so a half-installed kit is retried
instead of remembered as done.

Verify from the model side:

```
cua_vm_status                     # the row carries rea=yes
cua_vm_exec → node -v             # v22.23.4
cua_vm_exec → rea --version
cua_vm_exec → rea doctor --provider ghidra --json
cua_vm_exec → java -version       # 21
cua_vm_exec → ls -l $GHIDRA_INSTALL_DIR/support/analyzeHeadless
cua_vm_exec → ls -l $REA_JADX_MCP_JAR
cua_vm_exec → cat /var/lib/cua-rea   # version/node/rea/ghidra/jdk/jadx/registered
```

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
| `CUA_SUPERVISOR_SOCK` | `/tmp/cua-vm/supervisor.sock` | control socket |
| `DSH_CUA_REA_SCRIPT` | `/usr/local/bin/cua-guest-rea.sh` | Guest script path (debugging) |

Runtime policy is **not** environment configuration: `/cua-vm/config.json`
holds `autoSuspend`, `idleSuspendMinutes` (default 30, `0` disables),
`diskQuotaGb` (default 20) and `maxRunning` (default 1), and is edited from the
Plugins page (Personal VM → Policy). The supervisor re-reads it every minute,
so a saved change needs no restart; a command in flight postpones the suspend.

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
