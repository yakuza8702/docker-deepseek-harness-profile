# dsh-cua-vm — a personal computer per workspace

The model gets a real computer to build, test and troubleshoot in, while the
harness keeps `workspace-write`. Two kinds exist:

* **Linux** — a QEMU VM through the `cua` CLI (the default, and the only kind
  with exec / file copy / disk growth / Android / REA).
* **Windows** — a `dockurr/windows` container on a Docker engine (DinD overlay),
  driven over QMP. Desktop only: no guest agent, so no exec, no put/get, no
  clipboard, no accessibility tree.

## Why a supervisor

The sandbox grants read-write only to `/dev/null`, `/tmp` and the workspace root
(`packages/sandbox/sandbox-local/src/profiles.ts`). QEMU opens `/dev/kvm`
`O_RDWR`, and the VM store must live outside the workspace, so a VM can never be
started from the agent's shell — and shouldn't be.

```
entrypoint.sh
  └── cua-vm-supervisor        (before any Session, outside the sandbox)
        ├── /dev/kvm, QEMU, cua daemon
        ├── Docker engine at DOCKER_HOST (Windows only)
        └── $STORE  (volume: base image, disks, checkpoints, shots, windows)

dsh-cua-vm (this plugin)
  └── tools ── JSON over /tmp/cua-vm/supervisor.sock ──▶ supervisor
```

Nothing in the tool path opens the device or touches the store; the tools only
write to a unix socket under `/tmp`, which `workspace-write` already allows.

## Tools

| Tool | Purpose |
|---|---|
| `cua_vm_status` | which computers exist, their state, spec, last command |
| `cua_vm_ensure` | create or resume the computer for this workspace (idempotent, carries the full spec) |
| `cua_vm_create` | new computer: `name`, `kind`, vCPU, RAM, image, `gpu`, `diskGb`, `android`, `rea` (Windows: `windowsVersion` / `windowsIso`) |
| `cua_vm_start` | start: resumes a suspended computer, **cold-boots** a powered-off one from its checkpoint |
| `cua_vm_shutdown` | real ACPI powerdown → checkpoint → sandbox removed → `powered-off` |
| `cua_vm_suspend` | pause, keep the sandbox; resume is instant |
| `cua_vm_gc` | clean the store: orphan checkpoints (newest kept), restore temps, old shots, stale rows |
| `cua_vm_doctor` | host facts: `/dev/kvm`, render node, QEMU virgl, Docker engine, store accounting, policy |
| `cua_vm_gui` | drive the desktop: screenshot, geometry, click/drag, type/key, windows, a11y, zoom, launch |
| `cua_vm_disk` | grow the disk online (QMP `block_resize` + `growpart`), no reboot, cannot shrink |
| `cua_vm_android` | install the Google Android SDK + AVD inside the Linux guest |
| `cua_vm_exec` | run a shell command, return exit code + stdout/stderr |
| `cua_vm_put` / `cua_vm_get` | copy in / copy the product out |
| `cua_vm_port` | open a forward and publish it at `/vm/port/<name>/` (prints the URL *and* the loopback port) |
| `cua_vm_destroy` | delete the computer and everything it left in the store |

One computer per workspace by default, named `ws-<sha256(workspace)[0:12]>`,
recorded in `$STORE/registry.json` (schema v2) — never in the workspace.

## Registry v2, and the migration

`registry.json` is `{ "version": 2, "vms": { … } }`. Every row carries `kind`
(`linux` | `windows`) and `backend`; a Windows row also carries
`windowsVersion` / `windowsIso`.

A v1 file (`{ "name": { … } }`, no version) is **migrated on read**: rows are
upgraded, a row that already said `backend: "windows"` keeps its kind, the result
is written back, and the next `cua_vm_status` already answers v2. Nothing has to
be deleted, and an unknown field on a row is preserved.

## Shutdown, suspend, and the trap between them

`cua sb suspend` pauses QEMU and keeps the qcow2 open. It is fast and it resumes
exactly where it was — but it is **not** a power-off: the process, the RAM and
the device handles all stay.

`cua_vm_shutdown` is the real thing, in this order:

1. close the port previews;
2. QMP `system_powerdown` (the guest runs its own shutdown hooks);
3. wait for the process to exit or `query-status` to answer `shutdown`, up to
   `shutdownTimeoutSec` (default 120);
4. on timeout, QMP `quit`, and mark the row `mayBeTorn` (a convert of a live
   qcow2 is not guaranteed consistent);
5. flatten the disk into `$STORE/checkpoints/<name>.qcow2` (`qemu-img convert`,
   so the checkpoint has no backing chain);
6. `sb rm --force` — the sandbox is removed *because* the computer is off;
7. `state: "powered-off"` + `restoreFrom: { kind: "checkpoint" | "image" }`.

**The trap:** `cua sb resume` only works while cua still knows the sandbox. A
powered-off computer has none, so `resume` answers "sandbox not found" for ever
and every Start button was a dead end. `cua_vm_start` therefore *never* resumes a
`powered-off` row: it copies the checkpoint to `<name>.qcow2.restore.qcow2`,
`sb create`s from it, and deletes the temp. (A resurrected `stop` alias:
`DSH_CUA_VM_LEGACY_STOP=1` makes `stop` mean suspend again.)

**ACPI refused?** A guest that will not take `system_powerdown` (QEMU answers
with an error, e.g. a machine without an ACPI PM) is **suspended instead**, and
the answer says `fallback: "acpi-unsupported"` — Start resumes it where it was.
Silently pretending a shutdown happened would be the worst option.

## Coordinates: one measured space

cua captures at most ~900k pixels. A 1280x800 desktop comes back as a 1200x750
PNG, and every "the click landed 6% off" report was that ratio.

`docker/cua-vm-space.mjs` **measures** it instead of assuming:

* display size from the guest (`/usr/local/bin/cua-space`, then `xdotool`);
* screenshot size from the PNG's own IHDR (24 bytes, zero dependencies);
* `scale = display / screenshot`, cached 30 s and invalidated by resume,
  restart, zoom and unzoom.

Every pointer and typing result prints one line:

```
screenshot 1200x750 · display 1280x800 · scale 1.0667
image px = 0.9375 × display px; cua maps it — do not rescale
```

`cua do click` takes **screenshot** pixels, so the model clicks what it sees.
The xdotool fallback (only when `cua do` fails) multiplies by the measured scale,
`round(x * scale)`, and says so in the answer.

A desktop above the capture budget is **refused at create time** with a sentence
that names the number — unless the operator accepts the mapping with
`DSH_CUA_VM_RESOLUTION_ALLOW_SCALE=1`. 1200x750 is exactly 900k px, which is why
it is the default.

## The store, its accounting, and GC

Bytes counted against `diskQuotaGb`:

| Root | What lives there |
|---|---|
| `$CUA_HOME/.cua` | base image, per-workspace deltas, QEMU |
| `$STORE/checkpoints` | one flattened disk per computer (`<name>.qcow2`) plus boot temps |
| `$STORE/shots` | screenshots (`<name>-<stamp>.png`, `-crop`) |
| `$STORE/windows` | a Windows container's `/storage` (64 GB+) and its credentials |

The rule is `used + requested > quota → refuse, before anything is created`, on
**both** create paths. The old check (`used > quota`) let the last computer start
at any size and discover the overrun as ENOSPC inside a download.

`cua_vm_destroy` removes a **manifest**, not just a sandbox: `sb rm --force`,
every `checkpoints/<name>.qcow2*` (`-restore`, `.tmp`), `shots/<name>-*`, the
port rows and their child processes, the viewer row, `trajectories/local_<name>`,
`vmm/qemu/<name>`, the Windows container and its storage, and the registry row.
Each item is reported, and a failed `sb rm` never stops the rest.

`cua_vm_gc` (Clean up in the panel) removes: orphan checkpoints *keeping the
newest* per name, all `*.restore.qcow2` boot temps, unrecognised artifacts
(`<name>.qcow2.bak`), screenshots older than `shotsKeepDays` (default 7, `0`
disables), viewer rows for computers that are gone or expired, and port rows
whose forward is dead. A checkpoint that is only a `.tmp` because a convert was
killed is **promoted**, never deleted: the data is complete, `rename` was the
step that never ran.

At boot the supervisor reconciles `ports.json`: every forward child died with the
previous container, so a row pointing at a dead loopback port is dropped instead
of answering 502 for a preview the panel shows as open.

## Windows computers

The backend lives in `docker/cua-vm-windows.mjs` and speaks the Docker Engine API
over `DOCKER_HOST` (`tcp://dind:2375` in `compose.windows.yaml`). It is off
unless `DSH_CUA_VM_WINDOWS=1`; `0` removes the option entirely (tools refuse,
panel hides it).

**The container spec** (everything is derived from one spec object):

| Env | Value |
|---|---|
| `VERSION` / `ISO` | `windowsVersion` (11/10/ltsc10/2022/2025) **xor** `windowsIso` |
| `DISK_SIZE` | `diskGb`, floored at 64 GB (`diskGbRaised`) |
| `DISK_FMT` | `qcow2` |
| `RAM_SIZE` | `memory`, floored at 6 GB (`memoryRaised`) |
| `CPU_CORES` | floored at 2 |
| `GPU` / `RENDERNODE` / `VRAM_SIZE` | `Y`/`N` ← Enable GPU; `/dev/dri/renderD128` (`CUA_WINDOWS_RENDERNODE`); `4G` |
| `SHUTDOWN` / `MANUAL` | `Y` / `N` |
| `USERNAME` / `PASSWORD` | `cua` / generated (20 url-safe chars) |
| `ARGUMENTS` | `-device usb-tablet -qmp tcp:0.0.0.0:7100,server=on,wait=off` |

`HostConfig`: devices `/dev/kvm` (+ `/dev/dri` when GPU), `CapAdd:
["NET_ADMIN"]`, bind `$STORE/windows/<name>:/storage`, labels
`dsh.cua.vm=<name>` + `dsh.cua.kind=windows`, and **no restart policy** (a
deliberately stopped computer must not resurrect itself).

**Storage quota.** A Windows disk floors at 64 GB and the default policy is
`diskQuotaGb: 20`, so the first Windows create is refused until you raise it
(Personal VM → Policy → Disk Size ≥ 64). The message names the number and the
field; it is a policy decision, not something the plugin silently raises.

**Ready** = RDP accepting on the published 3389 **and** QMP `query-status`
saying `running`. Both halves matter: RDP opens while the install is still
rebooting, and QMP says `running` before the guest exists. Until then the row is
`installing`, with a live `docker logs` tail; past
`windowsInstallTimeoutMinutes` (default 60) it becomes `error` with the last 40
log lines.

**Exposure.** The console (8006) is published on the DinD host and **relayed by
the supervisor** into `ports.json` as `backend: "relay"` (with an informational
`target` the proxy ignores) → `/vm/port/<name>/`. The proxy rewrites the
console's root-absolute URLs (`prefixRootPaths`) so an app served at `/` works
under the prefix; WebSockets were already tunnelled. QMP **7100 is never
published** — it is reached on the container's own address, which is why the
container joins `DSH_CUA_WINDOWS_NETWORK`. RDP on 3389 is opt-in in
`compose.windows.yaml` and documented there as a real LAN exposure.

**What does not exist on Windows**, on purpose (structured "not available", with
the paths that do work): `cua_vm_exec` (exit 126), `cua_vm_put`/`cua_vm_get`,
`cua_vm_disk`, clipboard, accessibility tree, window list, `launch`. Screenshots
come from QMP `screendump` (`space.source = "qmp"`, no capture budget, scale
always 1) and a frame is written into `<workspace>/.cua-vm/shots/` because that
is the only filesystem both sides see. Clicks and keys are QMP
`input-send-event` (absolute pointer **needs** `usb-tablet`), ASCII only — a
physical keyboard has no key for `é` or `中`.

**Stretch, documented only:** exec/put over an OpenSSH OEM script
(`/oem/...`, `OpenSSH.Server`), which needs a DinD host and a rebuilt image to
test; it is not wired, and nothing pretends it is.

## REA in the computer

`cua_vm_create` with `rea: true` (or **Enable REA** in New computer) installs
the reverse-engineering kit *inside* the guest, from `docker/cua-guest-rea.sh` —
a real file, not a blob in the supervisor, so it can be read, diffed and run by
hand. It is Linux-only: the Windows backend refuses it by name.

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
store quota is *not* raised automatically — if `$STORE/config.json` still has
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

## Guest provisioning (v7)

`docker/cua-guest-provision.sh` turns a fresh Cua disk into a workstation:
repairs the placeholder apt sources, installs Xorg + mesa + xdotool + imagemagick
tools of the desktop layer, opens the render node and `/dev/kvm` to the desktop
user, mounts the 9p share, forces a capture-sized desktop, and — on a GPU
computer — moves the desktop from Xvfb to Xorg and lifts the reported GL version
to 4.3 (`MESA_GL_VERSION_OVERRIDE=4.3FC`).

**The marker is a report, not a checkmark.** v7 writes
`/var/lib/cua-provision` even when apt is broken, and records what was achieved:

```
version=7
apt_ok=0|1
reason=…            (why apt failed, when it did)
display=WxH         (the geometry the desktop actually got)
space_helper=1      (/usr/local/bin/cua-space exists — the measured space)
```

and it **exits 2** on the broken-apt path, so the supervisor reports
`provisioned: false` with that reason on this start and every later one. v6 wrote
the marker only on success, which meant a guest with unfixable apt sources
re-ran a ten-minute script on every start and failed on the same line.

## Switches

| Variable | Default | Meaning |
|---|---|---|
| `DSH_CUA_VM` | `1` | `0` removes the bundle row and the tools |
| `CUA_VM_STORE` | `/cua-vm` | volume holding images, disks, checkpoints, shots, windows |
| `CUA_WORKSPACE_ROOT` | `/workspace` | the only host tree the tools may touch |
| `CUA_VM_TIER` | `slim` | `slim` or `full` guest image |
| `CUA_SUPERVISOR_SOCK` | `/tmp/cua-vm/supervisor.sock` | control socket |
| `DSH_CUA_VM_GPU` | *(unset)* | `virgl` makes virgl the **default** for a create that omits `gpu` (an explicit `false` still wins); gated on the installed QEMU actually having `virtio-gpu-gl-pci` |
| `DSH_CUA_VM_RESOLUTION` | `1200x750` | desktop geometry |
| `DSH_CUA_VM_RESOLUTION_ALLOW_SCALE` | *(unset)* | `1` accepts a desktop above cua's capture budget |
| `DSH_CUA_VM_SHARE_WORKSPACE` | `1` | `0` removes the 9p share |
| `DSH_CUA_VM_LEGACY_STOP` | *(unset)* | `1` makes `stop` mean suspend again |
| `DSH_CUA_VM_WINDOWS` | `0` | `1` adds the Windows kind (needs `compose.windows.yaml`) |
| `DSH_CUA_WINDOWS_IMAGE` | `dockurr/windows:4.35` | pinned on purpose; a floating tag changes the unattended install |
| `DSH_CUA_WINDOWS_NETWORK` | *(compose project)* | network a Windows container joins, so its QMP port is reachable |
| `CUA_WINDOWS_RENDERNODE` | `/dev/dri/renderD128` | render node passed to the guest when GPU is enabled |
| `DSH_CUA_REA_SCRIPT` | `/usr/local/bin/cua-guest-rea.sh` | guest script path (debugging) |

Runtime policy is **not** environment configuration: `$STORE/config.json` holds
`autoSuspend`, `idleSuspendMinutes` (30, `0` disables), `diskQuotaGb` (20),
`maxRunning` (1), `shutdownTimeoutSec` (120), `checkpointPolicy`
(`shutdown` | `always` | `never`), `shotsKeepDays` (7) and
`windowsInstallTimeoutMinutes` (60), and is edited from the Plugins page
(Personal VM → Policy). The supervisor re-reads it every minute, so a saved change
needs no restart; a command in flight postpones the suspend.

Windows credentials are **not** in the registry: they live in
`$STORE/windows/<name>/credentials.json`, mode `0600`, and the panel's Reveal
reads them through the supervisor. The registry is the file that ends up in a bug
report.

## Isolation rules the supervisor enforces

* every host path is resolved and must stay under `CUA_WORKSPACE_ROOT`;
* `vm_put` reads only from the workspace, `vm_get` writes only into it;
* a Windows frame is the one thing written *into* the workspace (`.cua-vm/shots/`),
  because it is the only bridge that computer has;
* the store is `$STORE`, so `docker volume rm <stack>_cua-vm` reclaims all of it.

## Requirements

* Linux: `/dev/kvm` in the container (`compose.emulator.yaml`), nested virt on
  the host; network egress for the first image pull (base disk ~1.3 GB).
* Windows: a Docker engine at `DOCKER_HOST` (`compose.windows.yaml`), `~80 GB`,
  `/dev/kvm` for the Windows VM itself.

QEMU is **not** in the image: the supervisor runs `cua runtime setup qemu` into
`$CUA_HOME/.cua` on first use, then repairs the release bundle's missing seabios
symlinks (QEMU otherwise dies with `could not load PC BIOS 'bios-256k.bin'`) and
writes the PATH shim that adds the 9p share. That keeps ~200 MB out of every
image layer.

## Notes on cua 0.7.0

The published CLI has no `--headless` flag yet and `--tier` accepts `slim` /
`full` only; the VM therefore always boots its desktop session, and readiness is
waited on `tcp:3211` (the in-guest daemon). `--wait desktop` is available through
`waitForDesktop` when input must be ready. `--kind vm` is QEMU/KVM on Linux; the
in-guest `cua-spacesd` on 3211 is what `exec`, `cp`, `port-forward` and
screenshots go through — no SSH involved. It has no `stop`: a power-off is QMP
+ `sb rm` + a cold boot from the checkpoint (see above).
