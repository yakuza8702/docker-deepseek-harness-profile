# dsh-cua-vm — a personal computer per workspace

The model gets a real computer to build, test and troubleshoot in, while the
harness keeps `workspace-write`. Two kinds exist:

* **Linux** — a QEMU VM through the `cua` CLI (the default, and the only kind
  with disk growth / Android / REA).
* **Windows** — **direct QEMU** (OVMF + swtpm + a qcow2 disk under `/cua-vm`, no
  container runtime), driven over QMP with a noVNC live view at
  `/vm/port/<name>/`. OpenSSH is installed by the answer file, so exec / put /
  get work over SSH like the Linux computer; there is no clipboard, no
  accessibility tree and no window list on the QMP path.

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
`windowsVersion` / `windowsIso` / `windowsKey` / `windowsImageIndex` / `windowsImageName` (optional; evaluation ISOs need
none).

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
| `$STORE/windows` | a Windows computer's `disk.qcow2`, TPM state, credentials |
| `$STORE/iso` | install media, downloaded once and shared by every computer |

The quota counts **real bytes on disk**, never the *virtual* size of a disk. A
qcow2 disk is sparse: `qemu-img create -f qcow2 disk 64G` writes metadata, and
the guest consumes store bytes only as it writes. So a create:

* **reserves nothing** for the disk (`reserveStoreBytes(name, 0)`), which still
  runs under the store lock and refuses when the store's **real usage is already
  over the quota** — `VM store quota reached: 16.0 GB of real store data > 15 GB …`;
* **creates** a disk bigger than the policy and carries
  `warnings[{ code: "disk-over-policy", message }]` (result, registry row and the
  tool text): "requested 64 GB exceeds the 15 GB store quota policy; the disk is
  sparse so creation proceeds, but the guest will hit the real disk ceiling and
  may fail to install — raised policy is recommended".

The `used + requested > quota → refuse` rule is still what protects a
**transient write whose real bytes are known**: the Windows ISO download reserves
its expected size, and the shutdown/checkpoint path reserves the real disk delta
before flattening (a skipped checkpoint is recorded, never fatal). It previously
also charged the *virtual* disk size at create, which refused every Windows
computer on the shipped policy; that sentence ("a 64 GB disk does not fit the VM
store quota") is now forbidden by the gate.

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

## Windows computers (direct QEMU)

A Windows computer is **not** a container. It is `qemu-system-x86_64` started by
the same supervisor that runs the Linux guest: the same `/dev/kvm`, the same
`/cua-vm` store, the same lifecycle locks, the same shutdown/checkpoint/delete
machinery. There is no Docker Engine, no DinD sidecar and no second runtime —
`docker/cua-vm-windows-qemu.mjs` builds the command line and
`docker/windows-oem/` holds the unattended install.

```
$STORE/iso/                              downloaded install media (one per version)
$STORE/windows/<name>/disk.qcow2          the system disk (plain qcow2 → checkpointable)
$STORE/windows/<name>/efi-vars.qcow2      OVMF NVRAM, per computer
$STORE/windows/<name>/tpm/                swtpm TPM2 state, per computer
$STORE/windows/<name>/oem/                Autounattend.xml + $OEM$ scripts (staging)
$STORE/windows/<name>/setup.img          MBR + FAT32 answer disk (mtools; rw, usb-storage removable=on)
$STORE/windows/<name>/credentials.json    generated password + key path, mode 0600
$STORE/windows/<name>/id_ed25519          the SSH key the supervisor uses
$STORE/windows/<name>/serial.log          the console — the install progress
```

### Firmware and devices

| Piece | What runs |
|---|---|
| firmware | **OVMF** (`OVMF_CODE_4M.fd` shared, per-computer `efi-vars.qcow2`), so boot entries survive restarts |
| TPM | **swtpm** on a unix socket, `tpm-crb` in the guest — a real TPM 2.0, not a registry bypass (the Secure Boot check *is* bypassed: OVMF here is the non-secure-boot build, and that is stated in the answer file) |
| disk | qcow2, AHCI by default; **virtio-blk** when a virtio-win ISO is provided |
| NIC | SLIRP user-mode networking, `e1000e` by default; virtio-net with the driver ISO |
| input | `usb-tablet` (absolute pointer — what QMP `input-send-event` needs) + `usb-kbd` |
| display | `VGA` by default. With Enable GPU: `virtio-gpu-gl-pci` + `egl-headless` on the render node **when `qemu -device help` lists `virtio-gpu-gl-pci` and `/dev/dri/renderD128` exists** (the same probe the Linux guest uses); otherwise a plain `virtio-gpu-pci`. The choice is made once at create, stored on the row, and reused by every later boot |
| control | QMP on loopback; VNC on loopback for the live view |

**Windows has no accelerated 3D here, and the GPU option does not change that.**
With Enable GPU the display is `virtio-gpu-gl-pci` + `egl-headless` on the host
render node **when the image's QEMU advertises it** (the same capability probe the
Linux guest uses); otherwise it falls back to a plain `virtio-gpu-pci`
framebuffer. Either way Windows has no accelerated driver for it in this image:
Direct3D runs on **WARP (CPU)** and OpenGL is not hardware-accelerated. Expect 2D
and desktop composition to be fine and anything 3D to be slow. On NVIDIA hosts the
QEMU process may show an EGL handle in `nvidia-smi` — that is the host-side
context of the display device, **not** acceleration inside the guest.

### Install media

**An operator-supplied ISO is the primary path, and that is deliberate.** Of the
five Microsoft evaluation URLs this module originally pinned, only **Server 2025**
still answered (probed 2026-11-15: HTTP 206; the other four return HTTP 400 —
those editions are behind a session-token download page). A sixth, **Windows 11
IoT Enterprise LTSC 2024**, was added from Microsoft's own Evaluation Center
(`microsoft.com/en-us/evalcenter/download-windows-11-iot-enterprise-ltsc-eval`):
its x64 button is `go.microsoft.com/fwlink/?linkid=2270353`, which resolves to a
static `software-static.download.prss.microsoft.com` object that answered
**HTTP 206** with 5,060,020,224 bytes — so it is pinned and installs without an
operator ISO. So:

* `windowsVersion` lists six, but only **`2025`** and **`11ltsc`** (Windows 11 IoT
  Enterprise LTSC 2024, alias `ltsc11`) have pinned URLs — both were probed with a
  live ranged GET (HTTP 206). Selecting another one **refuses immediately**,
  naming the version and both remediations — it does not fail inside a 5.5 GB
  download.
* `windowsIso` is how you install 11/10/ltsc10/2022: an `http(s)` URL (downloaded
  into `$STORE/iso/` with progress and a timeout, `DSH_CUA_WINDOWS_ISO_TIMEOUT_MS`
  default 1 h) or a local `.iso` inside `$STORE` or the workspace, attached
  directly as a QEMU drive.
* The download is verified: a short read aborts and removes the `.part` file, the
  rename into place is atomic, and a stale `.part` is cleared first — so a
  truncated ISO can never be reused as "cached".
* The cache is **shared** by every computer and **counted by the store quota**
  (`$STORE/iso/` is part of the accounted store). `cua_vm_gc` prunes ISOs no row
  references once they are older than the screenshot retention policy.

An optional `virtio-win.iso` (`$STORE/iso/virtio-win.iso` or
`DSH_CUA_WINDOWS_VIRTIO_ISO`) switches the disk and NIC to virtio; without it
stock Windows installs from its own AHCI/e1000e drivers.

### The unattended install, and OpenSSH on every computer

`docker/windows-oem/Autounattend.xml` does the partitioning, creates the local
administrator **cua** with the generated password (shown in the panel, stored
0600), enables autologon — which is what keeps an INTERACTIVE session alive — and
runs `cua-firstboot.ps1` at first logon. That script installs:

* **OpenSSH.Server**, started automatically, with the supervisor's public key in
  `administrators_authorized_keys` (password auth stays on as the human fallback);
* **Python** from python.org (silent install);
* **dsh-cua** via pip;
* a **scheduled task in the interactive session** running `dsh-cua-server` on a
  named pipe.

It writes `C:\cua-provision.json` as its marker.

#### Two firstboot layers, because one copy step can silently fail

The install is unattended and lands on the desktop, but the provisioning that
makes the computer *usable* (`cua_vm_exec`, and therefore the Windows MCP) rides
on two different mechanisms now:

1. **`$OEM$` + `<UseConfigurationSet>true</UseConfigurationSet>`.** Windows Setup
   copies `<answer medium>\$OEM$\$$\Setup\Scripts\*` into
   `C:\Windows\Setup\Scripts` **only** when the windowsPE
   `Microsoft-Windows-Setup` component sets `UseConfigurationSet` ([MS Learn:
   UseConfigurationSet]; dockur/windows' `answer.sh` inserts the same element in
   the same place). Without it the `$OEM$` tree is inert and the oobeSystem
   `FirstLogonCommand` runs against a directory Setup never populated — the
   reported desktop error was exactly
   `Windows Script Host — Can not find script file
   "C:\Windows\Setup\Scripts\Unattend.vbs"`, which meant **no OpenSSH, no
   python, no dsh-cua**. `assertAnswerFileUsesConfigurationSet()` refuses a
   staged answer file without it, so this fails at create time with the reason
   instead of on the guest's desktop.
2. **A drive-scanning fallback.** The same `FirstLogonCommands` block carries a
   second command that looks for `cua-firstboot.ps1` on the roots of `C:`–`H:` and
   runs it straight off the SETUP medium:

   ```bat
   cmd /c for %d in (c d e f g h) do @if exist "%d:\cua-firstboot.ps1" powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%d:\cua-firstboot.ps1"
   ```

   The SETUP volume's letter is assigned by Windows (it was `C:` in WinPE and is
   usually `D:`/`E:` after installation), so it cannot be hardcoded on the host.
   The script is idempotent through `C:\cua-provision.json`: whichever layer runs
   first wins and the other is a no-op. **This layer does not depend on the
   `$OEM$` copy at all** — that is the point of having it.

`assertAnswerFileFirstbootLayers()` requires both layers in the staged file, and
`tests/windows-boot.mjs` asserts them against the template (plus a negative
control: a file with either layer removed is refused).

#### When is the install really done?

Three signals, in order, all visible in the panel:

| Stage | Proof | Badge / sentence |
|---|---|---|
| Setup | serial log shows the install CD / `Windows Setup is starting` | `installing (N min): QMP running…` |
| **booted** | serial log shows `Boot0004 "Windows Boot Manager"` from `HD(…,GPT` — i.e. the **installed disk** booted | *"Windows booted from the installed disk; waiting for OpenSSH (installed by firstboot) — if this never answers, firstboot failed (see the Unattend.vbs error on the desktop)"* |
| **ready** | QMP `running` **and** the SSH banner answers | `ready` |

* The boot-from-disk signal is `windowsBootedFromDisk()` (pure, unit-tested). It
  is why a successful install can never be mistaken for "still installing": the
  row keeps the `installing` state (so the panel still offers Force delete) but
  its sentence changes, and `installStage: "booted"` + `bootedMinutes` appear in
  `cua_vm_status`.
* **The deadline follows the stage.** Before the disk boots the 60-minute
  `windowsInstallTimeoutMinutes` window applies. After it boots, OpenSSH gets its
  own window (`DSH_CUA_WINDOWS_SSH_GRACE_MIN`, default 15 min) measured from the
  boot, so a slow install that booted at minute 55 is not marked `error` five
  minutes later while firstboot is still downloading python.
* After five minutes past the boot with no SSH banner the sentence becomes
  *"OpenSSH did not answer — the firstboot script likely failed; use the noVNC
  view to check, and Force delete + recreate to retry"*, and the eventual
  `error` distinguishes **"installed but SSH missing"** from **"never installed"**.
  When firstboot is the failure, the Windows MCP cannot attach (it needs SSH) —
  the fix is the guidance above, not a different MCP configuration.

#### The install media leave when the install is done

An install-phase QEMU boots the Microsoft ISO (`cd0`) and the answer medium
(`setup0`, a removable usb-storage stick), and that **same process** keeps
running after Setup finishes. Without cleanup a freshly `ready` computer still
showed the Windows DVD and the **SETUP (D:)** volume. At the ready transition the
supervisor now calls `detachInstallMedia()`:

1. `query-block` (so an already-clean session is silent),
2. QMP `eject` on `cd0` with `force: true`,
3. QMP `device_del` on the stick's qdev id (`id=setupusb` in the argv — the
   reason the id is explicit).

It is **non-fatal by contract**: an already-ejected tray or an old QEMU without
the id is logged, never fatal, and `installMediaDetached` makes it once-only
(the watcher and the status poll both trigger it). Every later start builds its
argv from `installPending: false`, which attaches **neither** the CD nor
`setup.img`, so the computer comes back with only its system disk.

**Why the interactive task matters:** SSH lands in **Session 0**, where there is
no desktop. pywinauto can only drive windows in the user's own session, so the
SSH side proxies to the interactive `dsh-cua-server` instead of driving the UI
itself.

### The agent surface

| Tool | How it works on Windows |
|---|---|
| `cua_vm_exec` | SSH → `cmd.exe` (the SSH key is per computer; `cwd` is `cd /d`) |
| `cua_vm_put` / `cua_vm_get` | `scp` over the same key and port |
| `cua_vm_gui` | QMP: `screendump` for a frame, `input-send-event` for clicks/keys |
| `cua_vm_port` / Show VM | the **live view**: noVNC + websockify relayed at `/vm/port/<name>/` |
| `cua_vm_suspend` | QMP `stop` (the VM pauses with its RAM); Start `cont`s it |
| `cua_vm_shutdown` | QMP `system_powerdown` → wait → `quit` → checkpoint → `powered-off` |
| `cua_vm_disk`, Android, REA | not available (Linux-only), refused by name |

**Ceilings, stated plainly:** QMP typing is **ASCII-only** (physical keycodes —
no `é`, no `中`) and there is **no clipboard**, no accessibility tree and no
window list on this path. There is also **no cursor overlay**: the CUA agent
cursor is an X11 overlay on the Linux guest and nothing equivalent exists here,
so the pointer you see in a frame is the real one (VNC draws it for a human).

### Live view

The display is QEMU VNC on `127.0.0.1:<allocated>`. The supervisor starts
`websockify` in front of it serving the image's own noVNC page and relays THAT
port through the existing preview pipeline, so **Show VM** streams the same
screen the model drives and a human can take over. Nothing is published raw.

### Networking

SLIRP gives the guest outbound internet (Windows Update, pip, site testing) and
reaches **host services at `10.0.2.2`** — a site the model serves on the harness
at `:3079` is `http://10.0.2.2:3079/` inside Windows. SSH is forwarded from
`127.0.0.1:<allocated>` to guest `:22`.

A tap/bridge is possible for real LAN presence but needs `CAP_NET_ADMIN` and a
host bridge, so it is **not** the default and is not wired here; the harness keeps
`cap_drop ALL`.

### dsh-cua tools (element actions, lazily attached)

While a Windows computer is `ready`, the plugin attaches the guest's MCP tool
list through
`ssh … python -m dsh_cua.server --stdio --pipe \\.\pipe\dsh-cua`
(`plugins/dsh-cua-vm/win-mcp.js`). The tools appear as `cua_win__<name>` and are
**disposed** within ~5 s of the computer stopping, being switched away from, or
being deleted (the attach check runs on a 5 s beat, not the 30 s cache beat —
a stale `cua_win__*` call against a stopped computer is a confusing SSH error).
**Nothing is written to the profile.**

Why it is worth its cost: `find_elements` + `type_text` return a compact JSON
receipt (`action_sent`, `effect_verified`) in a few hundred bytes, where the
screenshot loop costs a PNG per attempt. The cost is the schema: **~3-8k tokens
while attached**, zero when no Windows computer is active.

**It attaches only when the row is `ready` over SSH**, so it needs D1 fixed: a
computer whose firstboot never ran has no `sshd`, never answers the banner, never
becomes ready, and the MCP stays detached by design (the tool call says the guest
SSH server is not answering). Fixing `$OEM$`/`UseConfigurationSet` is what makes
this surface appear — it is not an MCP configuration problem.

Kill switch: `DSH_CUA_VM_WIN_MCP=0` disables the whole path (no SSH bridge, no
tools, no tokens). The same bridge can also be used as a plain MCP stdio server
(`node plugins/dsh-cua-vm/win-mcp.js --stdio --port <sshPort> --key <path>`) if
you prefer a `dsh-mcp-client` row.

### Lifecycle states

`installing` → `booting` → `ready`, plus `suspended`, `powered-off`,
`shutting-down` and `error` (with `errorLog`, the last 40 serial lines).
`ready` = QMP says `running` **and** an endpoint answers — SSH banner first, VNC
accept as the fallback. A paused guest is not ready.

A row that is still `installing` also carries **`installStage`**: `installing`
while Setup runs, `booted` once the installed disk has booted and OpenSSH has not
answered yet (`bootedAt`/`bootedMinutes` say how long). `booted` is a stage, not
a state: the computer stays `installing` until the SSH banner answers, so the
panel keeps offering the action that actually resolves a failed firstboot (Force
delete). A booted computer that never gets SSH is reported as **"installed but
firstboot failed"**, not as a failed install.

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
`diskQuotaGb: 20`, the 40 GB disk is created anyway (it is sparse) and carries
`warnings[code: disk-over-policy]`; the panel says the guest may hit the real
disk ceiling and recommends raising Disk Size in the Policy tab. Only a store
whose real usage is already over the quota refuses the create.

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
| `DSH_CUA_WINDOWS_QEMU` | `/usr/bin/qemu-system-x86_64` | the hypervisor the Windows backend drives |
| `DSH_CUA_WINDOWS_OVMF_CODE` | `/usr/share/OVMF/OVMF_CODE_4M.fd` | UEFI firmware (shared, read-only) |
| `DSH_CUA_WINDOWS_OVMF_VARS` | `/usr/share/OVMF/OVMF_VARS_4M.fd` | template for the per-computer NVRAM |
| `DSH_CUA_WINDOWS_SWTPM` | `/usr/bin/swtpm` | the TPM2 emulator |
| `DSH_CUA_WINDOWS_VIRTIO_ISO` | *(unset)* | a virtio-win ISO; without it the disk is AHCI and the NIC e1000e |
| `DSH_CUA_WINDOWS_ISO_TIMEOUT_MS` | `3600000` | bound on the one-time ISO download |
| `DSH_CUA_VM_WIN_MCP` | `1` | `0` disables the guest dsh-cua tools (and their token cost) |
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
* Windows: `~80 GB`, `/dev/kvm` for the Windows VM itself, and **the device's
  gid**: a Windows computer is direct QEMU, so there is no container runtime to
  ask. `compose.windows.yaml` passes `devices: [/dev/kvm, /dev/dri]` and
  `group_add: ["${KVM_GID:-kvm}", …]`.
* **Mounting the device is not access to it.** The container runs as uid 1000
  (`USER node`), while a host's `/dev/kvm` is normally `root:kvm 0660`. Pass the
  gid — `KVM_GID=$(stat -c %g /dev/kvm)` on the host, then
  `group_add: ["${KVM_GID:-…}"]` in the service and `--force-recreate` (groups
  are fixed at container create; a restart keeps the old ones). Without it QEMU's
  `open(O_RDWR)` fails `EACCES` and the create says so explicitly — the error
  quotes `mode`, `owner`, this process's supplementary groups and the exact
  `group_add` snippet. `cua_vm_doctor` distinguishes `kvm: DENIED (…)` from
  `kvm: absent (device not mounted)`.

QEMU is **not** in the image: the supervisor runs `cua runtime setup qemu` into
`$CUA_HOME/.cua` on first use, then repairs the release bundle's missing seabios
symlinks (QEMU otherwise dies with `could not load PC BIOS 'bios-256k.bin'`) and
writes the PATH shim that adds the 9p share. That keeps ~200 MB out of every
image layer.

## Troubleshooting: `the Windows backend needs /dev/kvm` while it is mounted

The sentence is only correct for one of three cases; the error text now names
which one it found (`docker/cua-vm-kvm.mjs`):

| `cua_vm_doctor` says | Meaning | Fix |
|---|---|---|
| `kvm: absent (device not mounted)` | the node is not in the container | `docker compose -f compose.yaml -f compose.windows.yaml up -d --force-recreate` |
| `kvm: DENIED (mode 0660 owner 0:107, not openable by uid 1000)` | mounted, but this uid is not in the device's group | `KVM_GID` + `group_add` + recreate (below) |
| `kvm: NOT a device` | something else sits at `/dev/kvm` | pass the real character device |

The gid fix (membership is set when the container is **created**, so recreate):

```bash
stat -c %g /dev/kvm                                  # on the HOST — e.g. 107
echo "KVM_GID=$(stat -c %g /dev/kvm)" >> .env
# the compose service already reads it:
#   group_add: ["${KVM_GID:-kvm}"]
docker compose -f compose.yaml -f compose.windows.yaml up -d --force-recreate
docker compose exec seek-harness sh -c 'id; ls -l /dev/kvm; exec 3<>/dev/kvm && echo KVM_OK'
```

Alternative (no compose change): a host udev rule with `MODE="0666"` for
`KERNEL=="kvm"`, then reload the rules. The Linux path (`cua sb create`) carries
the same diagnosis when an existing sandbox create fails on a denied device; it
does not refuse up front on purpose.

## Notes on cua 0.7.0

The published CLI has no `--headless` flag yet and `--tier` accepts `slim` /
`full` only; the VM therefore always boots its desktop session, and readiness is
waited on `tcp:3211` (the in-guest daemon). `--wait desktop` is available through
`waitForDesktop` when input must be ready. `--kind vm` is QEMU/KVM on Linux; the
in-guest `cua-spacesd` on 3211 is what `exec`, `cp`, `port-forward` and
screenshots go through — no SSH involved. It has no `stop`: a power-off is QMP
+ `sb rm` + a cold boot from the checkpoint (see above).
