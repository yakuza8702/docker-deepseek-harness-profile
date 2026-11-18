# dsh-cua-vm — a personal computer per workspace

The model gets a real computer to build, test and troubleshoot in, while the
harness keeps `workspace-write`. Two kinds exist:

* **Linux** — a QEMU VM through the `cua` CLI (the default, and the only kind
  with disk growth / Android / REA).
* **Windows** — **direct QEMU** (OVMF + swtpm + a qcow2 disk under `/cua-vm`, no
  container runtime), driven over QMP with a noVNC live view at
  `/vm/port/<name>/`. OpenSSH is installed by the answer file, so exec / put /
  get work over SSH like the Linux computer. The clipboard is bidirectional
  through a guest agent (`cua-clip-agent.ps1`) and the noVNC bridge
  (`cua-vnc-clip.mjs`); there is no accessibility tree and no window list on the
  QMP path — element work goes through the guest's dsh-cua tools.

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
| `cua_vm_shutdown` | real ACPI powerdown, answered in seconds → `powered-off` immediately, the checkpoint convert runs in the background (deferred) |
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

**The panel/button answers in seconds; the checkpoint convert runs in the
background.** A Windows shutdown used to run steps 2–5 *before* answering, so a
10 GB system disk held the harness tool call — and the Shutdown button — for
minutes, on a computer the row already said was powered off. The order is now:

1. a **bounded QMP phase** — `WINDOWS_STOP_BUDGET_MS` = **8 s** (of which
   `WINDOWS_STOP_QMP_MS` = 5 s is the handshake): an already-off computer answers
   at once, a guest that exits is recorded as powered-off, and one still flushing
   is handed to the backend's full window **in the background** — nothing is
   force-quit merely for being slower than the budget;
2. the **row is written at once**: `state: "powered-off"`, `lastShutdown`
   (`method`, `reason`) and `restoreFrom: { kind: "image", image: "windows" }` —
   the disk Start cold-boots — plus a `checkpointPending.token`;
3. the answer carries `checkpoint: "deferred"` (a WORD, never a path: a path
   cannot exist yet), and the detached task
   (`scheduleDeferredWindowsCheckpoint` → `checkpointDiskFileAsync`) later
   **upgrades** `restoreFrom` to
   `{ kind: "checkpoint", file: "$STORE/checkpoints/<name>.qcow2" }` and sets
   `lastShutdown.checkpointStatus: "saved"`. It holds the computer's lifecycle
   lock (a Start can never boot a disk that is mid-`convert`) and is
   token-guarded (a computer started again keeps the truth its Start wrote).

**If the store quota cannot hold it, `checkpointSkipped` is recorded and the
computer still boots its installed disk next Start.** The decision is taken
*before* the convert: a `quota` refusal (or `checkpointPolicy: "never"` →
`policy`) writes `checkpointSkipped: { reason, detail }` and
`lastShutdown.checkpointStatus: "skipped:<reason>"`, leaves
`restoreFrom.kind: "image"`, and the badge still shows powered-off immediately.
A **guest-initiated** shutdown is recorded even when its checkpoint fails: the
state is written first, the checkpoint in its own try/catch.

**A guest can also shut itself down, and the row follows.** `shutdown /s` in the
console, Windows Update, a user in the noVNC page — none of those pass through
this process, so the row used to keep claiming `ready`. While the row is live a
QMP poll asks `query-status` every **3 s** (`DSH_CUA_VM_STATE_POLL_S`, clamped
1–30): `shutdown` finalises it as `powered-off` with
**`method: "guest-shutdown"`**, running the same checkpoint + `restoreFrom`
bookkeeping the ACPI path uses (same quota/policy refusals), so Start cold-boots
from a real restore point; `paused` becomes `suspended` (reversible — never a
checkpoint of a live disk); a vanished QEMU is an unconfirmed `powered-off`
(`mayBeTorn`, no clean restore point).

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
`docker/windows-oem/` holds the unattended install. Both the QEMU argv and the
**swtpm argv** escape every interpolated path through `qemuEscapeOptionValue()`
(a comma doubles: `a,b` → `a,,b`): `--ctrl path=`, `--tpmstate dir=`, `--pid
file=` and `--log file=` are parsed by swtpm's own comma-splitting grammar, so an
unescaped store path used to mean a truncated socket/state path and "could not
open pid file".

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
| disk | qcow2 on the q35 ICH9 **AHCI** controller (`ide-hd`, an IDE-class disk whose driver is inbox since Vista) for every Windows code |
| NIC | SLIRP user-mode networking with **`e1000e`** (inbox) — the guest gets a lease and OpenSSH with no extra media. `DSH_CUA_WINDOWS_VIRTIO=1` (AND `virtio: true` on the create) swaps BOTH to `virtio-blk-pci` + `virtio-net-pci` for an image that carries the virtio-win drivers |
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

**`gpu: true` for Windows means "a virtio display", full stop.** There is **no
NVIDIA (or any) 3D acceleration** in the guest and no plan to pretend otherwise;
GPU passthrough (**VFIO**) is not implemented — it is a roadmap item
(`docs/cua-capability-roadmap.md`) and would need an IOMMU group, a second GPU and
a host driver handoff this image does not perform.

### Install media

**Sixteen codes, one ordered source chain each.** The five-version list is gone:
`windowsVersion` is the dockur/windows vocabulary (`11`, `11l`, `11e`, `10`,
`10l`, `10e`, `7u`, `xp`, `2025`, `2022`, `2019`, `2016`, `2012`, `core11`,
`tiny11`, `tiny10`), so "Windows 11 Enterprise" or "Server 2019" has a spelling
instead of forcing an operator ISO. The full table — disk size, firmware profile,
image selection — is in the repository README; the per-code URLs, byte counts and
SHA-256s are in `docs/windows-iso-sources.md`.

**A version is a CHAIN, not a pinned URL.** One pinned object per version was a
bet on a Microsoft CDN object staying alive, and four of the five lost it (HTTP
400 on 2026-11-15: those editions moved behind a session-token page). Each code
now carries an ordered list:

| strategy | what it is |
|---|---|
| `mido` | Microsoft's own live download page, driven by the four calls its JavaScript makes (`tags` → `mdt` → `reply` → `sku` → `link`) — the only strategy that yields an official, current media URL |
| `esd` | the ESD catalog CAB behind `go.microsoft.com/fwlink` — read ONLY when `7z`/`cabextract` is already in `PATH`; otherwise `skipped: no cab extractor` and the chain moves on |
| `link1`/`link2`/`link6` | pinned mirrors (`dl.bobpony.com`, `files.dog/MSDN`, `archive.org/download`), each with its byte count and SHA-256 |
| `midoDirect` | the static `software-static.download.prss.microsoft.com` object the page resolves to |

**Verification:** the `Content-Length` and the streaming SHA-256 of every pinned
entry are checked before the file is booted; a mismatch is
`code: iso-digest-mismatch` and the ISO is not used. A verified download writes a
`.sha256` sidecar, so the next create re-uses it without re-hashing 5.5 GB; a
sidecar that disagrees with the pin makes the file NOT a cache.
`DSH_CUA_WIN_ISO_SHA256=0` switches the DIGEST comparison off (the size is still
checked, only `'0'` does it, and the answer then says `verified: false` with a
`note` naming the switch — a skipped check is visible, never silent). A cache
with no pin and no sidecar is refused as `unpinned-cache` and downloaded again.

`windowsIso` still takes an `http(s)` URL (downloaded into `$STORE/iso/` with
progress and a timeout derived from the version's size) or a local `.iso` inside
`$STORE` or the workspace, attached directly as a QEMU drive. The cache is shared
by every computer and is part of the accounted store; `cua_vm_gc` prunes ISOs no
row references once they are older than the screenshot retention policy.

`xp` is **listed and refused** (`code: legacy-installer-unsupported`) before
anything is downloaded: XP has no UEFI and its Setup reads `winnt.sif` from a
floppy/ISO root, which this OEM payload does not build. A refused code is not an
unknown code — the difference is the sentence you get.

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
* a **scheduled task in the interactive session** running `dsh-cua-server` —
  with `pythonw.exe` (no console window) and `-Hidden`, and **without** a pipe
  argument (see the honest limitation below);
* **two on-demand, interactive clipboard tasks** (`cua-clip-set`,
  `cua-clip-get`) — the only clipboard path that works on Windows.

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

**The install CD's prompt is dismissed on the PROMPT, not on a clock.** A cold
q35/OVMF boot prints `Press any key to boot from CD or DVD` well after device
enumeration, so the old spawn-relative 1.5/3.5/5.5 s presses landed before the
prompt existed and the firmware fell into the EFI Shell (`EFI_TIMEOUT`). The
watcher now polls the serial log every **300 ms** for up to **90 s** and fires
Enter on the poll that sees it; the first-output growth anchor is **disabled at
the call site** (`armDelayMs: 0`), the fixed offsets survive only as the
silent-console fallback, and a re-printed prompt (BDS re-entering the DVD) is
served again for at most **12 cycles / 180 s**. A press the monitor REFUSES
answers `{error}` as a result — it is now logged as `could not press enter …`
and never counted as sent — and each press gets **3 s**, not the 15 s monitor
default that let one collision consume the whole window.

#### The install media leave when the install is done

An install-phase QEMU boots the Microsoft ISO (`cd0`) and the answer medium
(`setup0`, a removable usb-storage stick), and that **same process** keeps
running after Setup finishes. Without cleanup a freshly `ready` computer still
showed the Windows DVD and the **SETUP (D:)** volume.

**They leave when Setup finishes COPYING, not at Ready.** Ejecting at the ready
transition needs the SSH banner, and a guest whose NIC has no driver never
answers SSH — so the row stayed `installing` with SETUP (D:) mounted for the life
of the session. A watcher re-reads the serial tail every 15 s and triggers on the
first copy-done evidence (`Windows Setup is complete/completed/finished`, `Setup
has finished copying`, `Setup is applying system settings`, or a boot-from-disk
line), BEFORE SSH/MCP are up. It stops the cdboot presses first (a re-armed cycle
must not type into the disk boot), requires QMP `running`, and is bounded by
`DSH_CUA_WINDOWS_EJECT_WATCH_MIN` (90 min). The ready transition re-runs
`detachInstallMedia()`, which is idempotent:

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
| `cua_vm_port` / Show VM | the **live view**: noVNC served by `cua-vnc-clip` (websockify as the fallback) and relayed at `/vm/port/<name>/` |
| `cua_vm_suspend` | QMP `stop` (the VM pauses with its RAM); Start `cont`s it |
| `cua_vm_shutdown` | QMP `system_powerdown` → a bounded 8 s wait → `powered-off` answered at once → the disk checkpoint converts in the background |
| `cua_vm_disk`, Android, REA | not available (Linux-only), refused by name |

**Ceilings, stated plainly:** QMP typing is **ASCII-only** (physical keycodes —
no `é`, no `中`), there is no accessibility tree and no window list on this path,
and the clipboard does **not** ride QMP: it goes through the guest agent and the
RFB bridge (or, forced, the panel's Clipboard section — see
[the clipboard, both ways](#the-clipboard-both-ways)). There is also **no cursor
overlay**: the CUA agent cursor is an X11 overlay on the Linux guest and nothing
equivalent exists here, so the pointer you see in a frame is the real one (VNC
draws it for a human).

### Live view

The display is QEMU VNC on `127.0.0.1:<allocated>`. The supervisor starts a front
door in front of it and relays THAT port through the existing preview pipeline, so
**Show VM** streams the same screen the model drives and a human can take over.
Nothing is published raw, and the front door is loopback-only.

The preferred front door is the image's own **`cua-vnc-clip.mjs`** — static noVNC,
the WebSocket handshake, the TCP client to QEMU and the RFB clipboard path, in one
Node process with no Python and no `websockify`. It is feature-detected in both
directions: `DSH_CUA_VNC_CLIP=0`, a missing binary, or a child that never listens
falls back to `websockify` (or to the raw VNC relay when even that is absent), so a
broken bridge can never cost you the console. The relay row records what it got:
`view: "novnc-clip" | "novnc" | "websockify" | "vnc-raw"` and a `clipboard`
object saying whether the console clipboard is up and why not.

Two details of that front door are contracts now:

* **the relay exists from the first second.** `windowsCreateManaged` opens it
  right after the row is written (non-fatal — one log line, and the install
  watcher retries at Ready), so `/vm/port/<name>/` serves during the whole
  20–40 minute Setup instead of only after `ready`;
* **the subprotocol is negotiated.** `Sec-WebSocket-Protocol` is answered only
  when the client OFFERED a supported protocol (`WS_SUBPROTOCOLS = ["binary"]`).
  Debian's noVNC 1.6.0 offers none, and a server naming one the client did not
  offer is a handshake RFC 6455 says the browser must abort — which is exactly
  the reported "page loads, console says *not connected*".

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
list through the **interactive relay** — `ssh … py -3
C:\ProgramData\cua\mcp-relay.py --connect` (`plugins/dsh-cua-vm/win-mcp.js`), 19
tools. The server on the other end of that socket is `python -m
dsh_cua.server --stdio`, started by the `cua-mcp-host` logon task **in the user's
session**, which is the only session whose desktop UIA can see; see
[The interactive session](#the-interactive-session--the-mcp-server-lives-there-now-the-relay).
When the probe says the relay is not listening, the attach falls back to starting
its own Session 0 server (MCP works, the desktop is blind) and records why — and
keeps watching, so a relay that comes up later upgrades that attach instead of
leaving it blind (see [the relay](#the-interactive-session--the-mcp-server-lives-there-now-the-relay)).
**Nothing is written to the profile.**

#### The namespace is the harness's

| name | what it is |
|---|---|
| `mcp__windows__<guest tool>` | one per guest tool — `tool_click_at`, `find_elements`, `tool_type_text`, … The prefix is `TOOL_PREFIX = "mcp__windows__"` and `windowsToolName()` is the only place it is added (a name that arrives prefixed is not prefixed twice) |
| `windows_desktop` | **reveal** — no arguments; unhides this session's bridged tools and returns their names, descriptions and parameters |
| `windows_mcp_doctor` | **diagnostics** — target, online state, the names this bridge registered, the raw `mcp__windows__*` surface on the global registry (`leaks`), the grants, the keepalive and the last error |

Why it is worth its cost: `find_elements` + `type_text` return a compact JSON
receipt (`action_sent`, `effect_verified`) in a few hundred bytes, where the
screenshot loop costs a PNG per attempt. The cost is the schema: **~3-8k tokens
while attached**, zero when no Windows computer is active.

#### The gate: grant → reveal → guard

Cost and consent are two different problems, so there are three layers and every
one of them lives in the plugin's process (module-level state, not per-mount):

1. **the grant** — Computer Use is **off** by default, in memory, per session.
   The user turns it on in Personal VM → **Computer Use**, or with
   `POST /dsh-cua-vm/cua-grant {"grant": true, "sessionId": "…"}`;
   `GET /dsh-cua-vm/cua-grant` reports the state. Mutating the grant is
   same-origin only, and a restart forgets it.
2. **the reveal** — with the grant on, the names are still hidden until
   `windows_desktop` is called for that session. `restrict({ deny })` is what
   hides them, and the deny set is every name this bridge registered.
3. **the guard** — `tools.guard` vetoes the CALL at dispatch time, so a name that
   is still visible (a race, a step admission captured before a teardown) is
   **refused, never run**, with a structured `code:` line the model can branch on:
   `vm-offline`, `grant-off`, `reveal-required`.

#### Which computer, and which session

One process attaches ONE Windows computer (one SSH session, one set of 19 tools);
the attachment is global, but the RIGHT to use it is per session, and the rule is
re-checked on every call and on every gate application:

* the session that bound the attached computer may use it;
* a session bound to a DIFFERENT computer is refused with a structured
  `code: not-the-target` whose text names both computers and the fix — and its 19
  names are put back into the deny set, so the mismatch is a list, not one failed
  call at a time;
* a session that never bound anything is refused the same way
  (`this session is bound to nothing; the Windows bridge is attached to …`);
* the ONE declared relaxation — `implicit-single-target`: when exactly one Windows
  computer is known to the bridge (the supervisor's `vmList` registry, refreshed by
  the same 30 s call that keeps the REA cache warm), a never-bound session may use
  it. The doctor records it (`viewer.via`, `implicitTarget.sessions`), so it is
  never silent, and a second computer withdraws it immediately.

#### Offline means GONE, not dead — and the stream is why it is fast

A delete, a shutdown, a switch to another computer or a dead SSH session all funnel
into one idempotent `teardown()`: the registration map is emptied **before** the
disposers run, every disposer is called, and the gate is re-applied to an empty
deny set. So no `mcp__windows__*` schema survives on the host-global registry and
**every session's** tool list shrinks at once.

The fast path is a real subscription, not a hope: the plugin keeps ONE long-lived
connection on the supervisor's socket and sends
`{"op":"subscribe","events":["vm-state","vm-removed"]}`; the supervisor answers
`{"event":"ready",…}` and then one line per transition. A shutdown or a delete
therefore reaches `teardown()` in **milliseconds** (the observed latency on a
local socket is single-digit ms, not "up to 10 s"), and the client reconnects with
backoff after a socket error. A supervisor that does not implement the op answers
`unknown op` (or closes without `ready`): the plugin records
`stream.supported: false`, stops asking, and the poll below is the belt — the same
behaviour as before this change. `windows_mcp_doctor` reports `stream.live`,
`stream.supported`, `stream.events`, `stream.lastEvent` and `stream.error`.

Four things can trigger the teardown, and all four are the same code: the state
stream, the state poll (`DSH_CUA_MCP_STATE_POLL_MS`, default 10000 ms, floor 1000
— still running behind the stream), the guest client's own `onClosed`, and the
per-agent `agent/pre-step` self-heal (which never swallows the step — `next()`
runs on every path).

#### Online gate and keepalive

`win-mcp.js` asks the plugin `isOnline()` **before every call** (10 s cache): a
suspended or stopped computer fails with `code: vm-offline` instead of paying an
SSH timeout. The SSH channel is opened with `ServerAliveInterval=10` and
`ServerAliveCountMax=2`, so a half-open socket (a suspended QEMU) is dropped in
~20 s and the next call is refused by name. `ForwardAgent`, `ForwardX11` and
`PermitLocalCommand` are off — this channel only ever carries one stdio MCP
server.

`windows_mcp_doctor` is the one call that answers "which side is broken": target,
`online`, `registered`, the raw prefix surface (`schemas`, `leaks`), the grants,
the revealed sessions, the keepalive and `gateError`. Offline, `leaks` MUST be
empty; anything else is `status: "leaking"` and is exactly the bug this gate
exists for.

**It attaches only when the row is `ready` over SSH**, so it needs firstboot fixed:
a computer whose `$OEM$` copy never ran has no `sshd`, never answers the banner,
never becomes ready, and the MCP stays detached by design (the tool call says the
guest SSH server is not answering). Fixing `$OEM$`/`UseConfigurationSet` is what
makes this surface appear — it is not an MCP configuration problem.

Kill switch: `DSH_CUA_VM_WIN_MCP=0` disables the whole path (no SSH bridge, no
tools, no tokens). The same bridge can also be used as a plain MCP stdio server
(`node plugins/dsh-cua-vm/win-mcp.js --stdio --port <sshPort> --key <path>`) if
you prefer a `dsh-mcp-client` row.

### The clipboard, both ways

A Windows clipboard belongs to the **interactive session**. Two obvious routes are
dead, and both were tried on a live VM:

* **RFB `ClientCutText`** — QEMU's VNC server accepts it and drops it, because the
  guest runs no clipboard agent. noVNC's paste box therefore "succeeds" and pastes
  the guest's **previous** clipboard, which is worse than a failure.
* **`Set-Clipboard` over SSH** — `sshd` runs in **Session 0**, which owns a
  different (empty) clipboard than the session a human sees. The command exits 0
  and nothing changes.

So the guest side is a real agent in the user's session, and the host side is a
bridge in front of noVNC:

| piece | session | what it does |
|---|---|---|
| `cua-clip-agent.ps1` | the user's, registered by firstboot as `cua-clip-agent` (`/sc onlogon /it /rl LIMITED`) | the ambient LOOP: watches the clipboard, writes `C:\ProgramData\cua\clip-current.txt`, polls `outbox\clip-<seq>.json`, puts the text on the clipboard and writes `clip-ack.json` with the seq, the SHA-256 and `equal` |
| `cua-clip-set` / `cua-clip-get` | the user's, on demand | the original contract and the FALLBACK: `clip.txt` → `Set-Clipboard`, `Get-Clipboard -Raw` → `clip-read.txt`, with the task's own `Last Result` as the exit code |
| `cua-vnc-clip.mjs` | the container, `127.0.0.1` only | the noVNC front door + RFB clipboard: `ClientCutText` → `vmWindowsClipboardSet`, and a guest copy → `ServerCutText` to the browser |

#### What the model and the panel call

| op | panel route | answer |
|---|---|---|
| `vmWindowsClipboardSet` | `POST /cua/windowsClipboardSet {"name","text"}` | `{ ok, verified, via: "agent"\|"task", bytes, seq, sha256, readBackEqual, fastPathReason?, detail }` |
| `vmWindowsClipboardGet` | `POST /cua/windowsClipboardGet {"name"}` | `{ ok, verified, via, text, sha256, state, detail }` |

`available: false` with a reason means the computer is not `ready` or SSH is
switched off — the panel renders that as a **disabled** section, not as an error.

#### The agent path is verified, not hoped

The fast path drops a job carrying the digest of the text, waits for the agent's
ack and checks **all three** facts — `seq`, `sha256`, and the agent's own `equal`
— then reads `clip-current.txt` back and hashes THAT (`readBackEqual`). A partial
match is a mismatch (`reason: "ack-mismatch"`; the answer says `verified: false`).
The old ack is deleted before the job is written, so a surviving ack from the
previous sequence cannot answer for this one.

With no agent (an older guest, a failed firstboot, `DSH_CUA_CLIP_AGENT=0`) the call
falls back to `cua-clip-set` and reports `fastPathReason` — "pasted, slowly" and
"pasted, verified" are different facts about the guest and both are named.

Three answers that used to be one generic failure are now their own:

* `reason: "agent-error:<code>"` — the agent reported `ok: false` and/or a
  non-empty `error`. That is not a digest mismatch, and the reason says so with
  the agent's code (or a one-line message) instead of sending the reader to
  hashing;
* `reason: "too-large"` — the agent's limit is the JOB FILE. The outbox budget is
  `1 MiB − 2048` bytes (`CLIP_OUTBOX_WRAPPER_BUDGET`), checked before ANY round
  trip, and the serialized job is re-checked after escaping. The fast path
  declines; the schtasks fallback (text limit 1 MiB) still delivers, and the
  answer names the decline;
* `nulTruncated: { landed, total }` — a U+0000 truncates the Windows clipboard.
  The paste is `ok: true` (the prefix landed) but `verified: false`, and the
  answer says how many characters survived.

**Order and files.** The agent writes `clip-current.txt` **before** the ack; the
backend re-reads the ack and the copy up to three times, 250 ms apart, and keeps
the LAST matching ack (one immediate read could describe the previous payload on
a paste that actually worked). `seq` is a `Date.now()` stamp, so it is `[long]`
everywhere in PowerShell — an `[int]` overflowed. The files are per-session
(`clip-state-<id>.json`, `clip-ack-<id>.json`, `clip-current-<id>.txt`,
`outbox-<id>\`) with the canonical un-suffixed copies written by the same owner,
byte-for-byte; a single-owner lock (60 s window) stops two logons from serving
each other's payload.

Three details make the fallback honest rather than apparently-working:

1. **the file is written BEFORE the task runs** — otherwise the task reads the
   previous paste, which is the same "old clipboard" symptom one layer up;
2. **the task's own `Last Result` is read** (`/query /fo LIST /v`) — `schtasks
   /run` only QUEUES the task, so a non-zero exit is reported as "the clipboard
   was NOT set" with the code, never as a success;
3. **the read direction deletes `clip-read.txt` first**, so a task that did not
   run cannot be answered with yesterday's clipboard.

Text is never placed on a command line (a `&`, `|`, `;` or quote would be
re-parsed by `cmd.exe`); it travels as a file, and the payload is capped at 1 MiB
— a bigger paste is a file transfer, so use `cua_vm_put`.

#### Encoding, and turning the bridge off

The RFB wire is bytes: `encodeCutText` sends **latin1** when every code point fits
in one byte (the decode on the other side is then exact) and **UTF-8** otherwise,
with the length header counting BYTES, not characters. `parseClientCutText`
decodes UTF-8 when the bytes are valid UTF-8 and latin1 otherwise — reversible
either way. `DSH_CUA_VNC_CLIP_POLL_MS` (default 1200) is how often the bridge reads
the guest clipboard.

`DSH_CUA_VNC_CLIP=0` reverts the console to plain websockify: the screen is
unchanged, the RFB clipboard is gone, and the panel's Clipboard section is the only
path.

**The three environment knobs are LIVE, and these are their exact contracts:**
`DSH_CUA_CLIP_AGENT=0` is a **staging variable that becomes a file**, because the
guest cannot read the host's environment. The backend writes
`clip-agent-disabled` beside the OEM payload and into
`$OEM$/$$/Setup/Scripts` (and `buildSetupImage` carries it into `setup.img`'s
root) with the log line `clip agent disabled by DSH_CUA_CLIP_AGENT=0 (sentinel
staged)`; an unset knob unlinks a stale root sentinel, so a re-created computer
does not stay off. `cua-firstboot.ps1` then searches `$PSScriptRoot`,
`C:\Windows\Setup\Scripts`, `C:\ProgramData\cua` and the removable roots and
COPIES a staged sentinel to `C:\ProgramData\cua\` BEFORE its off-switch check —
the hop that turns "a file on the medium" into the path the consumers test. Both
consumers use that path: the registrar does not register the task and reports
`skipped: true, reason: 'clip-agent-disabled'` (the sentinel is an OPTIONAL entry,
so an unset knob is never "incomplete payload"), and the agent exits early, with
its embedded copy running the same search-then-stage hop. `DSH_CUA_WIN_ISO_SHA256=0` disables the digest comparison only —
the byte count is still enforced, `'0'` is the only value with that effect, and
every skipped download answers `verified: false` plus
`note: "digest check disabled by DSH_CUA_WIN_ISO_SHA256=0"`. `DSH_CUA_VNC_CLIP_POLL_MS`
is read by the supervisor and passed to the bridge as `--poll-ms`, clamped to
200–60000 ms and rounded; a non-numeric value is the default 1200, never 0.

### Disk free space, on the spec line

`diskGb` is the **virtual** size the user asked for; it cannot say that a 64 GB
disk has 6.8 GB left, which is the state Windows Update fails in and Setup gets
blamed for. A ready Windows row therefore carries `freeSpace` — read inside the
guest with `Get-PSDrive C`, throttled to **60 s** — and the panel prints it on
the spec line with the below-floor warning (**10 GB**) in the error colour. A
probe that cannot answer says `available: false` and why; it never prints 0 GB
and never fails the status call.

### The interactive session — the MCP server lives there now (the relay)

`sshd` on Windows is a **service**, so anything it starts inherits Session 0. UIA
is per session, and that is not a detail: from Session 0 `list_windows` enumerated
**0** windows while `notepad.exe` was running, and a notepad started by a tool was
created in "Services" — invisible to the logged-on user. Measured, not inferred, and
not fixable by retrying.

So the stdio transport stayed exactly as it was and the **server** moved:
`docker/cua-mcp-relay.py` is a two-mode byte bridge, staged by firstboot to
`C:\ProgramData\cua\mcp-relay.py` (payload: the medium's root and
`$OEM$/$$/Setup/Scripts`, like `cua-clip-agent.ps1`).

```
harness ──ssh stdio──▶ relay --connect ──127.0.0.1:47999──▶ relay --serve ──▶ python -m dsh_cua.server --stdio
                        the SSH child, no desktop,           firstboot's `cua-mcp-host`   a child of the /it task,
                        raw bytes each way                   task: /sc onlogon /it        so UIA sees the desktop
```

* `--serve` binds **loopback only**, one client at a time, and keeps its child
  across reconnects (a reconnect must not discard the windows the desktop is
  mid-way through); a dead child is restarted for the next client and its death
  ends the client's read with EOF instead of a hang. The child gets pipes,
  `bufsize=0` and **no console** — `pythonw.exe`/`CREATE_NO_WINDOW`, because a
  console on an interactive task is the blank-window defect again.
* `--connect` is what the SSH command runs: stdin/stdout ↔ the socket, raw bytes, no
  pty (a pty would rewrite CR/LF and mangle the JSON). It touches no desktop.
* the probe: a connection whose first bytes are exactly `RELAY_PING` gets
  `RELAY_OK` (**8 bytes**) and is closed before any child is touched; a real client
  starts with `{"jsonrpc":`, so the two are unambiguous, and the probe is answered
  outside the session lock. firstboot's `Test-RelayPing` is the guest-side twin —
  its 8-byte buffer is what makes `mcp-relay-task` idempotent (the port is the
  evidence; a second listener would die on `WinError 10048`).
* the **client's** probe: `py -3 C:\ProgramData\cua\mcp-relay.py --ping <port>`, one
  SSH round trip that prints exactly one token (`RELAY_OK` / `RELAY_DOWN`). It
  replaced a PowerShell one-liner that was correct and too slow — `powershell.exe`
  starts a CLR before its first socket call (~4.6 s cold on a tiny10 guest), so
  right after boot it raced the then-8 s budget and called a **live** relay DOWN,
  which pinned the attach to the blind lane. The wall is now **12 s**
  (`RELAY_PROBE_TIMEOUT_MS`): a cold ssh plus a cold `py`, with a dead relay still
  costing only that because the probe settles the moment an answer arrives.
* the log: one line per event in `C:\ProgramData\cua\mcp-relay.log`
  (`DSH_CUA_MCP_RELAY_LOG`), which is the only diagnosis a `pythonw.exe` task has.

**Lane preference, re-decided on every attach** (the logon task can start minutes
after the boot that made sshd reachable):

| probe | command the SSH child runs | `transport` | `transportText` |
|---|---|---|---|
| `RELAY_OK` | `py -3 C:\ProgramData\cua\mcp-relay.py --connect` | `interactive-relay` | `windows mcp transport: interactive-relay (port 47999, relay up)` |
| `RELAY_DOWN` / `RELAY_BAD` | `python -m dsh_cua.server --stdio` | `session-0-direct` | `windows mcp transport: session-0 fallback: … desktop automation will be blind` |

The fallback still speaks MCP and cannot see the desktop, so it is recorded, never
hidden: `relayOk: false`, the `SESSION0_FALLBACK_REASON` sentence in
`transportReason`, a log line per attach, and the same facts in
`windows_mcp_doctor` (`transport`, `relayPort`, `relayOk`, `transportText`) — all
from the client's synchronous, side-effect-free `doctorFacts()`, which never opens
an SSH session of its own. Before an attach the fields are `null` and the text says
`not attached yet (no lane decided in this process)`.

**A late relay heals the live session.** Re-deciding per attach does not cover the
case that actually bit: the `cua-mcp-host` logon task firing *after* the attach
that found it down. A live `session-0-direct` attach therefore re-probes every
15 s (`RELAY_UPGRADE_WATCH_MS`), and on `RELAY_OK` it logs
`upgrading mcp transport to the interactive relay`, kills its own SSH child and
lets the sync re-attach through the relay (the answer is cached, so the re-attach
lands on the interactive lane). Picked up within ~15 s instead of staying blind for
the whole session. Bounded: one attempt per `RELAY_UPGRADE_INTERVAL_MS` (60 s),
never while a `tools/call` is in flight, and `DSH_CUA_VM_WIN_MCP_UPGRADE=0` disables
the watch entirely.

| Variable | Default | Meaning |
|---|---|---|
| `DSH_CUA_MCP_RELAY_PORT` | `47999` | relay port on both sides of the wire; garbage falls back to the default rather than building a broken command |
| `DSH_CUA_MCP_RELAY_LOG` | `C:\ProgramData\cua\mcp-relay.log` | the relay's event log |
| `DSH_CUA_VM_WIN_MCP_UPGRADE` | `1` | `0` keeps a blind `session-0-direct` attach on that lane instead of chasing a relay that starts later |

`DSH_CUA_WIN_MCP_COMMAND` still overrides the command verbatim (the doctor records
that the relay was bypassed on purpose). The relay's limits are honest ones: it
forwards MCP only — the clipboard stays on its own `/it` tasks, and the live view
stays on VNC.

**Run command, not Terminal.** The panel's button opens a ONE-SHOT command form:
one line, Run, and the captured output. It has no pty, no prompt, no job control
and no working directory that survives the call (Windows runs it through `sshd`
in Session 0; Linux through `sb exec`). It used to be labelled "Terminal", which
promised a shell the panel does not have. A real pty would need a bidirectional
stream and a resize path on both backends — not a rename, so the label is the
honest fix.

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
disk ceiling and recommends raising Store quota in the Policy tab. Only a store
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
| `DSH_CUA_WINDOWS_VIRTIO` | *(unset)* | `1` + `virtio: true` swaps the inbox AHCI disk/`e1000e` NIC for `virtio-blk-pci`/`virtio-net-pci` (only for an image that carries the drivers) |
| `DSH_CUA_WINDOWS_EJECT_WATCH_MIN` | `90` | how long the media watcher waits for "Setup finished copying" before it leaves the eject to the ready transition (clamped 1–600 min) |
| `DSH_CUA_VM_STATE_POLL_S` | `3` | QMP `query-status` interval while a Windows row is live (clamped 1–30); this is how a guest-initiated shutdown becomes `powered-off` |
| `DSH_CUA_WINDOWS_CDBOOT_PROMPT_MS` | `90000` | how long the serial log is watched for the cdboot prompt (300 ms poll; presses fire on the poll that sees it) |
| `DSH_CUA_WINDOWS_CDBOOT_PRESS_MS` | `3000` | the QMP budget for ONE Enter press — the 15 s default let one busy-monitor collision consume the whole window |
| `DSH_CUA_WINDOWS_CDBOOT_CYCLES` / `_WATCH_MS` | `12` / `180000` | re-arm budget when BDS reprints the prompt, bounded by the watch and by the QEMU staying alive |
| `DSH_CUA_VM_WIN_MCP` | `1` | `0` disables the guest dsh-cua tools (and their token cost) |
| `DSH_CUA_REA_SCRIPT` | `/usr/local/bin/cua-guest-rea.sh` | guest script path (debugging) |

Runtime policy is **not** environment configuration: `$STORE/config.json` holds
`autoSuspend`, `idleSuspendMinutes` (30, `0` disables), `diskQuotaGb` (20),
`maxRunning` (1), `shutdownTimeoutSec` (120), `checkpointPolicy`
(`shutdown` | `always` | `never`), `shotsKeepDays` (7) and
`windowsInstallTimeoutMinutes` (60), and is edited from the sidebar panel
"Personal VM (CUA)" → Policy → Store quota (GB) (the same tab shows the store
readout: bytes **used** against the quota). The supervisor re-reads it every
minute, so a saved change needs no restart; a command in flight postpones the
suspend.

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
