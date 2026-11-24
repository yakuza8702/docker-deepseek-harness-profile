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

`cua_vm_status` also carries two computed fields per computer (additive JSON, no
new tool): `holds` — which resource the state still keeps (`memory+disk`,
`memory+disk (suspended; resume is instant)`, `disk only (checkpoint)`, or
`unverified` for a torn/vanished disk) — and `health` — a per-computer verdict
(`ok` | `degraded`) with six checks (`state-fresh`, `lock-free`, `gpu`, `share`,
`restore-point`, `media`) plus the one guide sentence for the first failing check.
A `null` check means "not observable here" and never counts as a failure; a
healthy computer prints no `health=` segment at all. (`unknown` exists only as
the rule's defensive floor — `state-fresh` and `lock-free` are always observable,
so a real row never reports it.)

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

**The same contract is on the wire now.** `cua_vm_status` (and the panel, which
reads the same decorated rows) carries `holds: { memory, disk, text }` per
computer — `memory+disk` while it runs, `memory+disk (suspended; resume is
instant)` after a suspend, `disk only (checkpoint)` after a shutdown, and
`unverified` (both `null`) for a torn or vanished disk, because "I do not know" is
not "no". The status line prints it as `holds=disk only (checkpoint)`, and the two
tool answers say it in words (`Memory is freed; the disk survives in the
checkpoint` / `Memory and the QEMU process are kept; resume is instant`). The
`health` field next to it carries the per-computer verdict and its one guide
sentence; see `## Tools`.

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

**The create path WALKS that chain.** Until this release the table above was the
*intent* while the download used `resolveWindowsIso()` — deliberately static-only,
so `windowsVersion: '11'` always took the `link1` mirror and a recreate never
re-resolved anything. `cua_vm_create` now calls
`ensureIsoForSource(resolveWindowsIsoSources(code))`, walking the order the table
above shows. **`11` and `10` start at `mido`** — its `productEditionId` is read
**live on every create**, so a recreate picks up Microsoft's newest release.
`11e`/`10e` start at the ESD catalog, `11l` and `2025`–`2012` at their pinned
`midoDirect` object (a Microsoft CDN build, but a FIXED one), and
`7u`/`core11`/`tiny11`/`tiny10` at the mirrors they have — those four have no
Microsoft page this code can drive at all. The row records which strategy won
(`isoSourceId`, `isoMedia: "chain"`). A medium the
chain delivered is referenced by its row and nothing else, so `cua_vm_gc` prunes
it once that computer is deleted and the retention window passes — a stale 5.5 GB
ISO is not kept for ever. An explicit `windowsIso` is a **deliberate pin**: it is
downloaded as one object and recorded as `isoMedia: "pinned"`, and the status
`health` check says so. `DSH_CUA_WINDOWS_ISO_MIDO=0` restores the static-only
order for an isolated network, where the four extra HTTPS round trips are pure
cost.

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
| `cua_vm_put` / `cua_vm_get` | `scp` over the same key and port — **`-P`**, not ssh's `-p`; the local file is the source for a put and the destination for a get |
| `cua_vm_gui` | QMP: `screendump` for a frame, `input-send-event` for clicks/keys |
| `cua_vm_port` / Show VM | the **live view**: noVNC served by `cua-vnc-clip` (websockify as the fallback) and relayed at `/vm/port/<name>/` |
| `cua_vm_suspend` | QMP `stop` (the VM pauses with its RAM); Start `cont`s it |
| `cua_vm_shutdown` | QMP `system_powerdown` → a bounded 8 s wait → `powered-off` answered at once → the disk checkpoint converts in the background |
| `cua_vm_disk`, Android, REA | not available (Linux-only), refused by name |

**`put`/`get` are `scp`, and the port flag is the whole contract.** There is no 9p
share on a Windows computer, so a copy rides the guest's OpenSSH server with the
same per-computer key and the same forwarded port as `exec`. ssh's port flag is
`-p PORT`; **scp's is `-P PORT`**, and scp's own `-p` means "preserve
times/modes" and takes **no value**. A reused `sshBaseArgs()` (minus `-T`) therefore
never consumed the port, and OpenSSH put it in a **positional** slot — and since
scp reads positionals back-to-front (last = destination, the rest = sources) the
port became a source file:

```
scp: stat local "47000": No such file or directory
```

The chain that replaces it is deliberately small: `WINDOWS_SSH_OPTS` is the ONE
option list both builders read (so `BatchMode`, the host-key policy,
`ConnectTimeout` and `ServerAliveInterval` cannot drift), `scpBaseArgs(meta)` emits
`[…opts…, -P, port]` (no `-T`: that is ssh-only), and
`buildScpArgv(meta, localPath, guestPath, { direction })` owns the positional pair —
`to-guest` is `[LOCAL, user@host:GUEST]`, `from-guest` is the mirror. The whole
argv is built in one place, which is what makes the shape assertable without a
guest: `tools/scp-argv-check.mjs` points `DSH_CUA_SCP_BIN`/`DSH_CUA_SSH_BIN` at
stub binaries, drives the real supervisor over its real socket (`put`, `get`, the
clipboard's temp-file copies) and parses the recorded argv with OpenSSH's grammar —
48 checks, including a control that replays the OLD argv and reproduces the error
string above. `tests/modules-unit.mjs` pins the pure builder (`-P` holds the port,
`-p` absent, `47000` never a positional, the same `-o` list in both directions) and
`tools/check-cua-vm.mjs` pins the chain that feeds it.

**Ceilings, stated plainly:** QMP typing is **ASCII-only** (physical keycodes —
no `é`, no `中`), there is no accessibility tree and no window list on this path,
and the clipboard does **not** ride QMP: it goes through the guest agent and the
RFB bridge (or, forced, the panel's Clipboard section — see
[the clipboard, both ways](#the-clipboard-both-ways)). There is also **no cursor
overlay**: the CUA agent cursor is an X11 overlay on the Linux guest and nothing
equivalent exists here, so the pointer you see in a frame is the real one (VNC
draws it for a human).

**The guest installs a pinned build, and the two numbers that used to lie are
measured.** Firstboot installs `dsh-cua==0.4.1` — not a floating `dsh-cua`;
`DSH_CUA_WINDOWS_DSH_CUA` still overrides the spec — installs `pywin32`, runs
`pywin32_postinstall -install -silent` when `import win32ui` fails, and then
**executes** `import win32ui, win32gui` and `import pywinauto.controls.uiawrapper`
before the step reports `ok: true` (a `find_spec()` never imported a submodule, so
a pywin32 with no DLLs passed the gate and failed at the first element action).
The scale arithmetic in `dsh_cua.bridge` is corrected **in place under a hash
gate** — version `0.4.1` **and** `sha256(bridge.py) == 59280ee9…f9209` **and**
both anchors occurring exactly once — and proven by a no-window probe that
returns `SCALE_BAD` on the shipped wheel (`scale_x 1.333333`, `scale_y 1.5` for a
64×48 buffer cropped to 48×32) and `SCALE_OK` after it (`1.0` / `1.0`, `width` =
the crop's width). When the gate refuses, nothing is written and the reason is
recorded **twice, in two different vocabularies** (spelled out in
[the element lane](#the-element-lane)): the provisioning **marker**
`C:\cua-provision.json` (step `dsh-cua-scale`) says one of
`skipped:version-mismatch`, `skipped:hash-mismatch`, `skipped:anchor-missing`,
`skipped:anchor-ambiguous`, `skipped:write-failed`, `skipped:import-failed`,
`skipped:probe-failed`, `skipped:no-python` or `skipped:no-file` — and `already`
when an earlier pass applied it — while the **published fact the model reads**,
`desktop.scaleFix`, says `skipped:anchor` (the installed source carries no
`base_w`) or `unverified:<why>` (it could not be read). Every `skipped:*` and
`unverified:*` means **NOT patched**, and when the published value starts with
`skipped:` the doctor's verdict also warns that `scale_x`/`scale_y` are
**expected** to disagree on this guest — do not click from image pixels there. The
three refusals that had to UNDO a write keep their `skipped:<why>` value and add
an additive **`restoreOk`** boolean to the same marker row (`false` = the rollback
failed too, `bridge.py` may be left patched — see
[the element lane](#the-element-lane)). The same honesty covers boot:
`exec`/`put`/`get` wait for a booting guest's sshd and answer `exit 125` +
`code: booting`, never ssh's bare `255`.

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
keeps watching (a 15 s fast path at connect, plus a nudge from every 10 s state
poll), so a relay that comes up later upgrades that attach instead of leaving it
blind (see [the relay](#the-interactive-session--the-mcp-server-lives-there-now-the-relay)).
**Nothing is written to the profile.**

#### The namespace is the harness's

| name | what it is |
|---|---|
| `mcp__windows__<guest tool>` | one per guest tool — `tool_click_at`, `find_elements`, `tool_type_text`, … The prefix is `TOOL_PREFIX = "mcp__windows__"` and `windowsToolName()` is the only place it is added (a name that arrives prefixed is not prefixed twice) |
| `windows_desktop` | **reveal** — no arguments; unhides this session's bridged tools and returns their names, descriptions and parameters (an empty `tools` list with a `code` until they are really visible, and `blind` + `blindReason` when the lane cannot see a desktop) |
| `windows_mcp_doctor` | **diagnostics** — target, online state, the names this bridge registered, the raw `mcp__windows__*` prefix surface on the global registry (`prefixSchemas`, always) and its OFFLINE residue (`leaks`, empty whenever the bridge is online), `bootRace`, the grants, the keepalive and the last error — plus the **verdict** (`status: ok\|blind\|unresponsive\|leaking` — precedence `leaking → blind → unresponsive → ok`, `blindReason` including `boot-race`, `verdict`), `desktopWarning`, the functional probe's own `relayFunctional` answer, `pluginVersion` (**0.2.3** in this release), the payload identity (`expectedRelayHash`/`relayHash`/`skew`/`portMismatch`, plus `expectedGuardHash`/`guardHash`/`guardPresent` and the one-field verdict `stale`), the last `repair` record and the guest's measured `desktop` facts (`measured`, `elementLaneOk`, `workDir`, `workDirWritable`, `scaleFix`); `{"repair": true}` forces one attempt first, `{"functional": false}` skips the 20 s functional probe |

Why it is worth its cost: `find_elements` + `type_text` return a compact JSON
receipt (`action_sent`, `effect_verified`) in a few hundred bytes, where the
screenshot loop costs a PNG per attempt. The cost is the schema: **~3-8k tokens
while attached**, zero when no Windows computer is active.

#### The budget ladder: one 45 s constant was doing three jobs

The **attach** handshake is 45 s wide on purpose (SSH + the guest's python coming
up). It ALSO used to be the per-call `timeoutMs` and the body's race deadline,
which meant two things at once: a slow-but-alive guest call was indistinguishable
from a dead attach (it burned 45 s and then said `tool call timed out`), and the
client's own 60 s request timer could never win — so the model never saw a
transport timeout, and no call was ever retried.

The per-call budget is now a **ladder**, and every rung above the first is
*derived* from it (never an independent constant):

| rung | value | what it is |
|---|---|---|
| guest `WEDGE_DEADLINE_MS` | 20 000 | the relay kills a wedged child and answers `child-wedged` |
| host `WIN_MCP_CALL_TIMEOUT_MS` | 25 000 (`DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS`, call time, clamped 200..120 000) | one request inside `callTool` |
| host `WIN_MCP_CALL_ENVELOPE_MS` | 26 000 = `call + 1 000` | the budget `boundedExecute` races the body against |
| host `WIN_MCP_CALL_RETRY_BUDGET_MS` | 56 000 = `2 × envelope + 4 000` | a **retried** (read-only) tool's whole call |
| host `WIN_MCP_CALL_GUARD_MS` | 30 000 = `envelope + 4 000` | the registered ceiling of a single-attempt tool |
| attach `WIN_MCP_ATTACH_TIMEOUT_MS` | 45 000 | the handshake ONLY |

**The ordering is structural, not cosmetic:** the guest's clock starts *after* the
host's, so the host budget must be **larger** than the guest deadline — otherwise
`child-wedged` could never reach the model, and a local `timeout` would replace it
every time. The gate asserts the inequality across the two files (`S2`) and the
three derivations, so `20 000` here and `25 000` there cannot drift apart.

`boundedExecute` keeps its 250 ms lead (`TIMEOUT_LEAD_MS`) over the harness
guard, so the *branchable* code wins instead of the generic "tool call timed out". The numbers are read **once per CALL**, not once per attach:
`winMcpCallNumbers()` composes `call`/`envelope`/`attempts`/`total` from a single
`winMcpCallTimeoutMs()` reading and every rung routes through it, so a session
that changes `DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS` cannot get a body race cut at the
old envelope while the transport waits on the new budget — the split that used to
turn `code: relay-unresponsive` into a generic `tool-timeout`.

#### The two tool sets: retry is for the read-only, `[DEGRADED]` is for the lane

Two frozen, **disjoint** sets (both are guest names; every entry resolves through
`windowsToolName()`):

| set | members | what it drives |
|---|---|---|
| `WIN_MCP_ELEMENT_LANE_TOOLS` (5) | `find_elements`, `tool_invoke`, `tool_get_text`, `tool_set_value`, `tool_wait_for` | the tools that need **`win32ui`**. This is the set that carries `[DEGRADED]` when the desktop MEASURED the lane dead |
| `WIN_MCP_CALL_RETRY_TOOLS` (3) | `tool_list_windows`, `tool_capture_window`, `tool_read_clipboard` | **read-only AND not element-lane**: the only calls that get ONE retry |

**Disjointness is the point.** A retry exists for a *transient* timeout; an
element call on a dead lane fails in **milliseconds** with `ImportError`, so
retrying it is noise — and doubling the cost of the one class of call that cannot
recover by waiting is exactly what the rule forbids. A mutating tool is never
retried at all: the first attempt may have landed, and the guest's own
`child-wedged` sentence says so ("the call did not return, so its effect is
UNKNOWN"). The retry is a JSON-RPC request retry **on the same session** — the
documented `reconnect {500 ms, 30 000 ms, 10 attempts}` policy is untouched.

#### The three codes the model branches on

| `code:` line | when | what the model should do |
|---|---|---|
| `relay-unresponsive` | no answer inside the per-call budget, or a transport `timeout` | the relay is listening, the child is not answering. The text carries a `hint:` naming `windows_mcp_doctor` (it runs the functional probe) and one retry |
| `child-wedged` | the guest answered `{"code": -32000, "message": "child-wedged: …"}` | the guest's sentence travels **verbatim**: its effect is UNKNOWN — re-observe the screen before retrying |
| `tool-failed` | everything else (with the client's own code when it has one) | unchanged from before |

The `code:` line is repeated **in the text** because the harness error payload
does not hand `code` to the model — the same reason `toolTimeoutError()` does.

#### `[DEGRADED]`, and `desktopWarning`

The five element tools advertised a focus-free lane on guests where `win32ui`
cannot import, and they fail with `ImportError` in milliseconds — three calls
spent discovering a lane that was never installed. So when the desktop facts
**measured** a dead lane (`measured === true && elementLaneOk === false`), the
five descriptions are prefixed with one frozen sentence, first in the string,
before the guest's prose and before the contract note:

> `[DEGRADED] the element lane is unavailable on this computer (win32ui missing):
> this tool will fail with ImportError - use tool_click_at + tool_type_text, or
> tool_list_windows, until the guest is rebuilt.`

* **exactly five tools, exactly when measured.** `measured: false` produces **no**
  prefix: unknown is not degraded, and claiming otherwise sends the model to a
  fallback for a lane nobody measured.
* the prefix is applied by **re-registering** those five once per generation,
  after the attach's own facts read settles (`degradedAt` latches it; a healthy
  guest re-registers nothing). The registration and `windows_desktop`'s `tools[]`
  are rendered by the **same function**, at read time, so a reveal served seconds
  later cannot hand back the pre-render sentence.
* the other fourteen descriptions stay **byte-identical**.

**`desktopWarning`** is the sibling field, and it exists because the state the
tested image was actually in — `measured: false`, facts file unreadable — was
**silent everywhere**: 19 tools handed over with no word that the desktop those
tools drive had never been measured. It is `windowsDesktopWarnings({desktop}).join(' ') || null`
computed **once** and published by both `windows_desktop` and
`windows_mcp_doctor`, so the field and the sentence cannot disagree. `null` means
"nothing measured yet / nothing to warn about" — a read is in flight or the
desktop is healthy — and `measured: false` is a **warning** naming the guest's own
error, because "nobody looked" is not "nothing is broken".

#### The gate: grant → reveal → guard

Cost and consent are two different problems, so there are three layers and every
one of them lives in the plugin's process (module-level state, not per-mount):

1. **the grant** — Computer Use is **ON by default**, in memory, per session. It
   is a per-session safety default, not a boundary (`WIN_MCP_AUX.grantDefault`):
   the same-origin page API, the SSH-only guest bridge, the guard below and the
   per-session target binding are what actually stand between a session and the
   desktop, and the grant only decides whether a fresh session needs one manual
   round trip before it may click. **Denying is explicit and unchanged**: Personal
   VM → **Computer Use**, or
   `POST /dsh-cua-vm/cua-grant {"grant": false, "sessionId": "…"}` (same-origin
   only); `GET /dsh-cua-vm/cua-grant` reports `default`/`on`/`off`, and `grant-off`
   is still the refusal code that deny produces. A restart forgets all of it. The
   offline layer hides the 19 names **regardless of the grant**: the deny set is
   rebuilt from `online && granted && revealed && target`, so no grant makes a
   stopped computer's tools visible.
2. **the reveal** — with the grant on, the names are still hidden until
   `windows_desktop` is called for that session. `restrict({ deny })` is what
   hides them, and the deny set is every name this bridge registered. **A bind
   reveals, and the grant stays the veto**: a session that binds a computer
   (`cua_vm_exec`, `cua_vm_gui`, `cua_vm_ensure`) while `grantFor(agent) === true`
   is revealed in the same beat, so the first desktop call after a bind needs no
   manual `windows_desktop` round trip. Nothing about the safety story changes —
   a deny still comes back as `grant-off`, and a session that binds **nothing**
   under `implicit-single-target` still gets `reveal-required` (the veto stays
   reachable: the allowance covers *which* computer, never *whether* it may see
   one). `windows_desktop` itself returns `tools: []` with `revealed: false` and
   a `code` until the names are really visible, so a hidden bridge inventories
   nothing.
3. **the guard** — `tools.guard` vetoes the CALL at dispatch time, so a name that
   is still visible (a race, a step admission captured before a teardown) is
   **refused, never run**, with a structured `code:` line the model can branch on:
   `attaching`, `vm-offline`, `grant-off`, `reveal-required`.

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

#### What the receipts mean

The 19 guest tools are upstream `dsh-cua` tools, and the plugin publishes
upstream's descriptions **verbatim** — before this change it appended only
`" (dsh-cua, Windows computer <name>)"`. So the model was reading a contract
nobody had checked, and three of those descriptions implied more than the receipt
proves — while a fourth receipt (`tool_type_text`) was not generous but **wrong**.
The fix is the honest sentence in the description, not a wrapper around the
result: the relay is a byte bridge and the plugin rewrites nothing
(`open_application` has no polling surface to wrap, and inventing a
`path_redirected` flag for a redirect that does not exist would be a second lie).

| tool | what the receipt really is |
|---|---|
| `tool_open_application` | `os.startfile(target)` returns when the SHELL accepted the association. `success: true` does **not** mean a window appeared, and a retry launches a **second instance** — two Notepads is the expected, described outcome |
| `tool_send_keys` | the success branch returns `hwnd/keys/arbiter/time_ms` and **no** `effect_verified` (unlike `tool_type_text`). Success means the keys were injected into the FOREGROUND window, not that the app acted on them |
| `tool_type_text` | the receipt is an **exact** compare: `ok: true, effect_verified: true` only when the control's text is EXACTLY `before + text`. A truncated insert (a focus race drops the tail) is `effect_verified: false, reason: "short-insert", missing: "<the tail that never landed>"`, the tail is posted again up to `TYPE_TEXT_RETRY = 2` times, and a recovered insert reports `recovered: true, retries: n`. A terminal failure **restores** the control to `before` and reports the MEASURED `restoreOk` (a read-back, not an intention). The old `after != before` called a lost character a success |
| `tool_capture_window` | an EMPTY `save_path` is a documented default (`%TEMP%\win32_mcp_shots`); a NON-empty one must be under the allow-list (`C:\cua-work` or `%TEMP%\win32_mcp_shots`, or below them), whose missing directory the tool **creates** and reports as `created_dir: true` (plus `saved_dir`). Outside those roots it fails closed with a sentence naming both roots (`success: false, created_dir: false`); it never raises and never relocates the path |

`tool_type_text` is the one row that is not a description note at all: it is
**guest-side behaviour**, patched into `bridge.py` by firstboot
(`dsh-cua-typetext`, below), and its description still says what the tool does not
promise. `tool_capture_window`'s row is both — the note is a description note,
the allow-list and `created_dir` are the guest patch (`dsh-cua-savepath`, below).
The three notes are frozen in `WINDOWS_TOOL_CONTRACT` (`win-mcp.js`), keyed by
guest tool name and appended **before** the `(dsh-cua, Windows computer <name>)`
suffix. `windowsToolContract()` returns `''` for every other tool, so the other
sixteen descriptions stay byte-identical — that is how the scope of the change is
provable, and `windows_desktop`'s `tools[]` and the registry cannot disagree
because they call the same function:

> **`tool_open_application`** — Contract: returns when Windows ACCEPTED the launch, not when a window appeared — poll tool_list_windows and dedupe by pid before retrying, or a retry starts a second instance.
>
> **`tool_send_keys`** — Contract: success means the keys were injected into the FOREGROUND window, not that the app acted on them (this receipt has no effect_verified) — confirm with tool_capture_window or a tool_list_windows read-back before assuming it worked.
>
> **`tool_capture_window`** — Contract: an EMPTY save_path writes under %TEMP%\win32_mcp_shots (that is the default, not a redirect); a non-empty save_path that cannot be written FAILS with PermissionError and does not fall back — use C:\cua-work\... inside the guest.

#### The element lane

The focus-free path — `find_elements`, `tool_element_action`,
`tool_element_action_at` — goes through pywinauto's UIA wrapper, and
`pywinauto.controls.uiawrapper` imports **`win32ui`** unguarded. So a pywin32
whose DLLs were never copied imports as a *package*, passes a `find_spec()` gate
(a submodule finder never imports anything), and dies at the first pattern action
with `ImportError: DLL load failed while importing win32ui`; upstream returns that
verbatim as `reason: "action_failed", action_sent: false`. The read verbs
(`skyshot`, `find_elements`) never touch that wrapper, which is why they kept
working on the same guest.

Two things changed. **The install is pinned and executed, not found:** firstboot
installs `dsh-cua==0.4.1` (not a floating `dsh-cua`; `DSH_CUA_WINDOWS_DSH_CUA`
still overrides the spec), installs `pywin32`, runs
`pywin32_postinstall -install -silent` when the import fails, and then *runs*
`import win32ui, win32gui` and `import pywinauto.controls.uiawrapper` before the
step reports `ok: true` — a failure throws, so the logon pass retries and the
marker records `ok: false` with the DLL error. **And the lane is measured where
it is used:** the relay's `--serve` entry starts one background self-check (bound
20 s, never blocks the listener, never raises) and writes
`C:\cua-work\cua-desktop-facts.json`, falling back to
`%TEMP%\cua-desktop-facts.json`; `win-mcp.js` reads it with one bounded SSH
(`8 s`, 60 s TTL, never throws) and both public tools report it as `desktop`:

| field | meaning |
|---|---|
| `measured` | `true` only when the guest actually measured. `false` means **every other field is unknown** (a pre-change guest, no file, an unreadable one) — never "false" |
| `win32ui`, `uiaLane` | the two imports, executed by the interpreter that runs the server |
| `elementLaneOk` | `win32ui && uiaLane` — the one field to branch on |
| `dshCuaVersion`, `pywin32Version`, `python` | what the guest really has (the version the patch gate reads) |
| `workDir`, `workDirWritable`, `profileRootWritable` | the write probes, from the desktop token — see [Where to save](#where-to-save) |
| `scaleFix` | the patch as the **installed source** shows it: `applied`, or a not-applied code (`skipped:no-file` · `skipped:anchor` · `unverified:*`). The marker's own, finer vocabulary is below |
| `source`, `at`, `stale`, `error` | which file was read, when, and why nothing was |

**`scaleFix` has two producers, and they do not speak the same vocabulary.**
`desktop.scaleFix` is the relay's **source read** of the module the server
imports, and it is what the model is told: `applied` when that `bridge.py`
contains `base_w`; `skipped:no-file` when nothing importable with a source origin
could be found (not installed at all, or only a `.pyc`); `skipped:anchor` when
the source exists but carries no `base_w` (**not patched**); and
`unverified:no interpreter`, `unverified:unreadable source` or
`unverified:not measured` when it could not be checked. The firstboot **marker**
(`C:\cua-provision.json`, step `dsh-cua-scale`) records the gate's own decision,
which is finer — `applied` · `already` (an earlier pass applied it; the file was
not written again) · `skipped:no-python` · `skipped:no-file` ·
`skipped:version-mismatch` · `skipped:hash-mismatch` · `skipped:anchor-missing` ·
`skipped:anchor-ambiguous` · `skipped:write-failed` · `skipped:import-failed` ·
`skipped:probe-failed`. **A refusal that had to UNDO a write keeps its
`skipped:<why>` value and adds `restoreOk` (a boolean) to the same marker row** —
the three rollback-attempting ones (`skipped:write-failed`,
`skipped:import-failed`, `skipped:probe-failed`): `restoreOk: true` means the
original bytes are **measured** back (the SHA-256 is re-checked against the
pre-patch hash and the stale `bridge.pyc` cleared, so "reverted" is a measurement
and not an intention); `restoreOk: false` means the rollback failed too —
`bridge.py` may be truncated or left **patched**, the guest log says
`NOT RESTORED … reinstall dsh-cua==0.4.1`, and the marker is the only thing that
knows. There is deliberately **no rollback-failure code of its own**: the doctor's
pixel warning fires on a `scaleFix` that **starts with `skipped:`**
(`windowsDesktopWarnings()`), so a new prefix for "the revert failed" would
silence exactly the sentence a half-restored guest needs — the rollback fact
therefore rides `restoreOk`, and `scaleFix` keeps the frozen `skipped:` family.
Read the pair as: **`applied` is patched now, `already` is patched from an
earlier pass, and every `skipped:*` / `unverified:*` is NOT patched.** The marker
is where the *why* lives (read it in the guest); the published fact is what the
doctor reports and what the model branches on. **The one case where they disagree
by design:** `restoreOk: false` leaves the patched file in place, so the relay's
source read can say `applied` while the marker says `skipped:probe-failed` — when
the marker reports a failed rollback, trust the marker and reinstall.

**When `elementLaneOk` is `false`, stop retrying the element tools.** Use the
pair that does not need the wrapper — `tool_click_at` with the numbers a capture
reports, and `tool_type_text` into the focused window — then verify with
`tool_capture_window`. The doctor's `verdict` says that sentence with the same
facts, and `windows_desktop`'s payload carries `desktop` too, so a dead lane is a
sentence rather than 19 identical `ImportError`s. And since 0.2.2 the **five element tools say it themselves**: their registered
descriptions start with the frozen `[DEGRADED]` sentence (see
[`[DEGRADED]` and `desktopWarning`](#degraded-and-desktopwarning)), re-registered
once per generation when the facts **measured** the lane dead. A guest provisioned before this
change answers `measured: false`: the documented upgrade is a **re-create**
(nothing re-stages the relay or re-runs pip on start).

#### The three guest patch steps, and why they are patched instead of wrapped

`dsh-cua==0.4.1` ships three behaviours this harness cannot live with, and the
relay is a byte bridge — it rewrites nothing — so firstboot patches the installed
wheel in place, one step per defect, in the same style as `dsh-cua-scale`:

| step | file / anchors | gate before any write | what it fixes |
|---|---|---|---|
| `dsh-cua-typetext` | `dsh_cua/bridge.py` (the `type_text` signature, the effect-receipt block, the out-dict) | dsh-cua `0.4.1`, SHA-256 `59280ee9…`, `count == 1` per anchor | `effect_verified = after != before` called a **truncated** insert a success. The replacement is an exact compare, the `missing` tail, `TYPE_TEXT_RETRY = 2`, the `short-insert` receipt and a measured `restoreOk` |
| `dsh-cua-savepath` | `dsh_cua/server.py` (the `save_path` open block, the `@mcp.tool(description="Capture a window screenshot and SAVE IT TO A FILE.` descriptor, the success payload) | dsh-cua `0.4.1`, SHA-256 `29668590…`, `count == 1` | a non-empty `save_path` whose directory did not exist raised `PermissionError`. `_ensure_save_dir()` creates it **inside the two-root allow-list** and reports `created_dir`; outside it fails closed, naming both roots |
| `desktop-token-probe` | a generated, **hidden** `C:\ProgramData\cua\desktop-probe.ps1`, run as an `/it` `/rl LIMITED` task | the python interpreter and the provisioned account | nothing ever proved the **desktop token** could see an interactive session — the costliest blind lane in the report. The probe records `session`, `win32ui`, `uiaLane`, `workDirWritable` and its own `scriptSha256` into `C:\cua-work\cua-desktop-probe.json`, and the step **throws** on a missing or stale marker (that is the logon retry mechanism) |

**The order is the contract:** `dsh-cua` → `dsh-cua-scale` → `dsh-cua-typetext`
→ `dsh-cua-savepath` → `desktop-token-probe` → `clipboard-tasks`. The two patch
steps edit the same two files, so a reorder makes the next step's `count == 1`
anchor gate depend on luck — the gate asserts the order (`S6`).

**The marker vocabulary is the `scale` step's family**, plus the probe's own
value: `typeTextFix` / `savePathFix` are `applied` · `already` ·
`skipped:no-python` · `skipped:no-file` · `skipped:version-mismatch` ·
`skipped:hash-mismatch` · `skipped:anchor-missing` · `skipped:anchor-ambiguous` ·
`skipped:no-change` · `skipped:write-failed` · `skipped:import-failed` ·
`skipped:probe-failed`, with `typeTextProbe` / `savePathProbe`
(`TYPE_TEXT_OK` / `TYPE_TEXT_BAD…`) as the **executed** proof that the patched
module imports and behaves; `desktopProbe` is `ok` · `failed:<why>`, beside
`desktopSession` and `desktopScriptSha256`. **A refusal that had to UNDO a write
keeps its `skipped:<why>` and adds `restoreOk`** — the same rule the scale step
documents: `restoreOk: true` means the original bytes are measured back,
`false` means the rollback failed too and the guest needs
`reinstall dsh-cua==0.4.1`. The idempotence sentinel (`if expected is not None:`,
`_ensure_save_dir`) is checked **before** the hash gate, because a second pass
cannot hash-match a file the first pass rewrote.

`tests/guest-patch.mjs` (≥29 checks) applies the here-strings to the pinned 0.4.1
evidence copies, AST-extracts the patched functions and runs them against stubs —
including the **unpatched** copy, which still reports `effect_verified: true` for a
dropped character. That is the proof the defect was real, not a story.

#### Where to save

`C:\Users\cua` is **not** a save target. The SSH login is `cua`, but the account
is in Administrators, so `ssh cua@…` lands on the **high-integrity** token while
the relay and the desktop run `/rl LIMITED` — the filtered token the user's own
PowerShell gets. A Medium-IL process cannot write the profile root; that is one
account with two tokens, not two accounts (a `C:\Users\CUA~1.CUA` in an error
message is the same profile seen through its 8.3 short name).

firstboot creates one directory it explicitly grants, and labels it Medium so the
filtered token can write it:

```
icacls C:\cua-work /inheritance:r /grant SYSTEM:(OI)(CI)F /grant Administrators:(OI)(CI)F /grant "%COMPUTERNAME%\cua:(OI)(CI)F"
icacls C:\cua-work /setintegritylevel (OI)(CI)M
```

The relay then proves the write **from the desktop token** (create and delete
`.cua-write-probe`) and publishes `workDir` + `workDirWritable`. The rule for
`save_path` is therefore one line:

| `save_path` | where the bytes go | `created_dir` |
|---|---|---|
| `C:\cua-work\shot.jpg` | there, and `success: true` (the directory already exists) | `false` |
| `C:\cua-work\shots\today\shot.jpg` (directories missing) | there — the tool **creates** the levels and says so | `true` |
| empty | `%TEMP%\win32_mcp_shots` (`os.path.join(os.environ.get("TEMP", "."), "win32_mcp_shots")`, with yesterday's shots pruned) — the documented DEFAULT (the tool's own choice), never a silent redirect of a path you gave; with `include_data_uri: true` no file is written and the bytes come back inline | `false` |
| anything outside the allow-list (e.g. `C:\Users\cua\shot.jpg`) | **fails closed**, `success: false`, with a sentence naming `C:\cua-work` **and** `%TEMP%\win32_mcp_shots`; nothing is created and nothing is relocated | `false` |

The allow-list is exactly two roots — `C:\cua-work` and `%TEMP%\win32_mcp_shots`,
matched with **normalisation** (`\` vs `/`, case, a trailing separator), so the
predicate is testable off Windows. `created_dir` is `true` only when *this* call
made the directory (a caller can tell "it was already there" from "I created it"),
and a save that fails to write after the directory was created reports
`created_dir: true` with `error: "save_path could not be written: …"` — the
directory stayed, the file did not. `saved_dir` names the directory on success.
A write failure is a **receipt**, not an exception: `PermissionError` used to
escape as a traceback, which the model could not branch on.

`workDirWritable: false` means the ACL or the label did not take (a guest created
before this change, or a hand-edited DACL): the verdict names `C:\cua-work` and
the `%TEMP%` default, and `save_path` should stay empty until the guest is
re-created. The facts file follows the same rule — `C:\cua-work\…` first,
`%TEMP%\…` second, and `source` (`"cua-work"` \| `"temp"`) records which one was
used.

#### Attaching is not not-the-target

`not-the-target` used to be the answer to **two** different situations: "no
Windows computer is attached" and "an attach is in flight right now". The second
is a boot race — the SSH handshake needs up to 45 s and a relay's logon task can
take ~25 s — and answering it with the sentence for "nothing is attached" sent
the reader to fix nothing. The in-flight ticket now has its own code, and it is
strictly additive: the `not-the-target` texts below are byte-identical to before,
and `attaching` is unreachable without a live ticket.

| code | when | what it means / next |
|---|---|---|
| `attaching` | an attach is in flight for a computer this session is bound to (or for the only known one). `attach.pendingName` names it | **not a failure**: the handshake is still dialling. `attach.retryAfterMs ∈ [1000, 20000]`, `attach.pendingSinceMs` is the age, and the verdict says `attaching to <name>: … retry in ~<n>s` |
| `not-the-target` | the bridge is attached to another computer, this session bound a different one (or nothing), or nothing is attached at all | unchanged texts — `this session is bound to <a>; the Windows bridge is attached to <b>; bind this session first` · `this session is bound to nothing; the Windows bridge is attached to <b>; bind this session first (…)` · `no Windows computer is attached to this bridge right now` |
| `vm-offline` | the guard fires on a name that survived a teardown | the computer is not online; `cua_vm_start`, then `windows_desktop` — or `cua_vm_gui` for a screenshot loop |
| `grant-off` | Computer Use is denied for this session | the user turns it back on (Personal VM panel, or `POST /dsh-cua-vm/cua-grant {"grant": true}`); it is ON by default and memory-only |
| `reveal-required` | granted, not revealed for this session, and the `implicit-single-target` allowance does not apply | call `windows_desktop` (no arguments) first |

One string, four surfaces: the doctor's `viewer.code` + `verdict`, the guard's
refusal (`code:` line), `windows_desktop`'s `code` (with `tools: []` while it
holds — nothing was measured, so `blind`/`blindReason` stay `null`), and
`attach.retryAfterMs`. They agree because each one reads the same
`targetMatchFor()`, and a session bound to a DIFFERENT computer still gets the
exact `not-the-target` sentence. The supervisor's half of the same race is
answered the same way: `cua_vm_exec` during boot waits for sshd (default
`DSH_CUA_WINDOWS_SSH_WAIT_MS=60000`, retried 3 000 ms apart) and then answers
`exit: 125` with `code: booting` + `next: retry in ~15 s`; `cua_vm_put`/`get`
answer `available: false, code: "booting"` with a `message`. ssh's bare `255`, and
the old `126` "no guest agent", are never the answer for a Windows computer that
exists.

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
`online`, `registered`, the raw prefix surface (`prefixSchemas`), the grants,
the revealed sessions, the keepalive and `gateError`.

**`prefixSchemas` is the surface; `leaks` is the residue.** Two fields, one
source, and the difference is the state of the bridge:

| field | online | offline |
|---|---|---|
| `prefixSchemas` | the full `mcp__windows__*` surface — **always** (19 names on a complete attach) | the same surface |
| `leaks` | **empty** | the same surface (`= prefixSchemas`) |

So offline, `leaks` MUST be empty; anything else is `status: "leaking"` and is
exactly the bug this gate exists for — and ONLINE, `leaks` is empty **by
definition**, because a visible tool of this plugin is a registration that is
working, not a leak. Reading `leaks` online (as this page and an earlier version
of `windows_mcp_doctor` did) reported 19 healthy registrations as 19 leaks; that
is the defect the `prefixSchemas` field exists to end. The two pinned
expressions that decide `leaking` and `status` are untouched by the split, and
they stay correct: when `online === true` their first conjunct is already false.

**Its verdict is computed FIRST, and a probe may never raise it.** The order of the
sources is the contract:

1. the supervisor's own `vm-state` stream — first-hand, newest, for the attached
   computer (`newestVmStateFor`);
2. the plugin's own state — `WIN_MCP.online` and the registration map;
3. the cached probe answer — **diagnostic detail**, aged and labelled.

`online` is `streamSaysOffline !== true && WIN_MCP.online === true`, so a
`vm-state` carrying any of `WIN_MCP_NOT_ONLINE_STATES` (`powered-off`,
`powering-off`, `stopped`, `suspended`, `deleting`, `error`, …) is final. The
probe still runs — one fast round trip, never a second SSH session — but it is
reported as `probeAgeMs`, `probe.ageMs`, `probe.stale` (past
`WIN_MCP_PROBE_STALE_MS = 5000`) and `probe.overridden`, and `onlineSource` can
only be `stream:<state>`, `plugin`, `plugin+probe` or `offline` — **never a bare
`probe`**. This is the fix for a doctor that said `online: true / state: ready / 19
tools` for seconds after a power-off: the probe used to be merged over the answer,
and a handshake that answered five seconds ago is not evidence about a computer
that is going down. The payload also carries `stream.stateEvents` and
`stream.lastState`, so "why did it say offline?" is answerable from the payload
itself.

**It attaches only when the row is `ready` over SSH**, so it needs firstboot fixed:
a computer whose `$OEM$` copy never ran has no `sshd`, never answers the banner,
never becomes ready, and the MCP stays detached by design (the tool call says the
guest SSH server is not answering). Fixing `$OEM$`/`UseConfigurationSet` is what
makes this surface appear — it is not an MCP configuration problem.

Kill switch: `DSH_CUA_VM_WIN_MCP=0` disables the whole path (no SSH bridge, no
tools, no tokens). The same bridge can also be used as a plain MCP stdio server
(`node plugins/dsh-cua-vm/win-mcp.js --stdio --port <sshPort> --key <path>`) if
you prefer a `dsh-mcp-client` row.

## Two desktop paths, one rule

The guest VM has exactly **one** desktop path: SSH exec + QMP input + the noVNC
live view at `/vm/port/<name>/`, surfaced as `cua_vm_gui` and the lazily revealed
`tool_*` element tools. `dsh-windows-mcp` is a **different** path: it drives the
**host** desktop (the PC DSH runs on) through `CursorTouch/Windows-MCP` and
registers `mcp__windows__*`. It is **opt-in**, and it is never enabled next to the
guest bridge in one session — two cursors fighting one desktop, doubled schemas
and a `serverName` rename that invalidates the prompt cache prefix. The capability
table, the rule and the Session-0 doctrine are in
[`docs/desktop-paths.md`](../../docs/desktop-paths.md); `cua_vm_doctor` prints the
one-line version of it (`desktop paths: …`).

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
* the **client's** probe is a HANDSHAKE, not a subcommand. The carrier is
  `py -3 -c "exec(__import__('base64').b64decode('…').decode())"`, and the decoded
  program connects `127.0.0.1:<port>` (1.5 s), sets a 2 s read timeout, sends
  `RELAY_PING`, **accumulates exactly 8 bytes**, prints one of `RELAY_OK` /
  `RELAY_BAD` / `RELAY_DOWN`, and exits 0. Nothing in it imports the relay or names
  a mode of it — that independence is the fix, not a convenience. Base64 is the
  carrier because the one-liner has to survive `ssh → cmd.exe → python`, and
  cmd.exe is where a `"` splits, a `%` expands and a `^` is eaten; the base64
  alphabet cannot smuggle any of them. The accumulate loop is the same lesson
  firstboot's `Test-RelayPing` documents: `RELAY_OK` is eight bytes **on the
  wire**, not eight bytes in one `recv()`, and a legal short read must never turn
  a healthy relay into "down" (that false negative once started a second listener,
  which died on `WinError 10048`).
* **three candidates, one budget, first token wins** — `py -3 -c "<program>"` →
  `python -c "<program>"` → the **legacy**
  `py -3 C:\ProgramData\cua\mcp-relay.py --ping <port>`. The legacy form is a mode
  of the guest payload, which is staged at machine-create and never refreshed, so
  it is the last question instead of the first: on the measured guest the payload
  was **26,573 B with zero `--ping` occurrences**, and that command answered
  **exit 2, 0 bytes on stdout, a usage line on stderr** while the relay was
  answering `RELAY_OK`. The handshake on the same guest answered `RELAY_OK` in
  **1,250 ms** including the SSH round trip. The wall is **12 s**
  (`RELAY_PROBE_TIMEOUT_MS`) shared by all three — one deadline, so the candidates
  cannot triple it — and the interpreter that answered is the interpreter the
  session command uses (`<interpreter> … --connect`), which closes the
  `py`/`python` split.
* **an answer without a token is `RELAY_SKEW` only when the PAYLOAD answered.**
  `RELAY_SKEW` means the relay script replied with something the probe could not
  read: a usage line, an unknown/invalid option, or a cannot-find that **names the
  relay script** (`mcp-relay.py` / `cua-mcp-relay`). A carrier failure — `'py' is
  not recognized`, `command not found`, `The system cannot find the path
  specified`, or a bare exit code 2 that names no relay script — is `RELAY_DOWN`,
  because the interpreter never ran and nothing about the payload was measured;
  reading it as skew would diagnose a payload mismatch on a guest that has no
  python at all, and (since SKEW outranks DOWN downstream) would hide a repair
  that had measured `session=0` or `hash=` empty. `relayOk` stays boolean;
  `relayStatus` / `probeMode` / `relayDetail` carry the truth, and the probe
  answer keeps `interpreterMissing` so "this guest has no interpreter" can be
  said without reading `RELAY_DOWN` as "the relay is stopped"; only a skew
  record gets `SESSION0_SKEW_REASON` ("…the guest relay answered, but the harness
  probe could not read it: payload mismatch; desktop automation will be blind")
  instead of the `RELAY_DOWN` sentence.
* the log: one line per event in `C:\ProgramData\cua\mcp-relay.log`
  (`DSH_CUA_MCP_RELAY_LOG`), which is the only diagnosis a `pythonw.exe` task has.

**Lane preference, re-decided on every attach** (the logon task can start minutes
after the boot that made sshd reachable):

| probe | command the SSH child runs | `transport` | `transportText` |
|---|---|---|---|
| `RELAY_OK` | `<the interpreter that answered> C:\ProgramData\cua\mcp-relay.py --connect` | `interactive-relay` | `windows mcp transport: interactive-relay (port 47999, relay up)` |
| `RELAY_SKEW` | `python -m dsh_cua.server --stdio` | `session-0-direct` | `windows mcp transport: session-0 fallback: the guest relay answered, but the harness probe could not read it: payload mismatch; desktop automation will be blind` |
| `RELAY_DOWN` / `RELAY_BAD` | `python -m dsh_cua.server --stdio` | `session-0-direct` | `windows mcp transport: session-0 fallback: … interactive relay not running; desktop automation will be blind` |

The fallback still speaks MCP and cannot see the desktop, so it is recorded, never
hidden: `relayOk: false`, the `SESSION0_FALLBACK_REASON` (or `SESSION0_SKEW_REASON`)
sentence in `transportReason`, a log line per attach, and the same facts in
`windows_mcp_doctor` (`transport`, `relayPort`, `relayOk`, `relayStatus`,
`probeMode`, `relayDetail`, `interpreter`, `interpreterMissing`,
`transportCommand`, `transportReason`, `transportText`) — all from the client's
synchronous, side-effect-free `doctorFacts()`, which never opens an SSH session of
its own.
**The lane fields have aliases, and they are the same facts, not two
measurements:** the canonical names are `transportCommand` / `transportReason`
(what the doctor emits, and what this page uses), while `command` / `reason` are
kept as **aliases for existing consumers** — the module-level `relayDoctorFacts()`
emits both spellings, and the client's own `state` uses `reason`.
`DOCTOR_FACTS_FIELDS` spells the canonical set and the alias pairs; a consumer may
read whichever spelling its surface offers, and reading them as two independent
fields is the mistake.
Before an attach the fields are `null` and the text says
`not attached yet (no lane decided in this process)`.

#### The cheap probe proves the accept loop; `RELAY_FN` proves the child

`RELAY_OK` answers one question — **is a listener on this port** — and it is
answered *before* the session lock, which is exactly what makes it cheap and
exactly why it cannot answer the other one. A relay whose MCP child is **wedged**
(a `PostMessage`/`WM_GETTEXT`/UIA call that will never return) or **gone** still
answers `RELAY_OK`: the accept loop is fine, the thing behind it is not. During
session 5 that was a seven-minute-per-call outage reported as a healthy lane.

So there are two probes, and they answer different questions:

| probe | what the client sends | what it proves | where it is used |
|---|---|---|---|
| **cheap** | `RELAY_PING` (10 bytes) | the accept loop is up — the *lane* question, in milliseconds | every attach, the lane-preference table above, the 10 s state poll |
| **functional** | `RELAY_FN` (8 bytes in, one JSON line back) | the **child** answered a real `initialize` + `tools/list` round trip through the session | `windows_mcp_doctor` (default on, `{"functional": false}` to skip), after a `{"repair": true}` attempt |

* `RELAY_FN` is its own token, **not** a `RELAY_PING` prefix: a token spelled
  `RELAY_PING_FN` would be answered by the 10-byte cheap path the moment its
  prefix had arrived, before its own trailing bytes were ever seen. The relay
  compares against a **token set** (`PROBES`), not one prefix.
* the answer is **one JSON line** carrying the relay's live counters —
  `mode`, `at`, `childPid`, `childRestarts`, `lastSuccessfulCallAgeMs`,
  `outstandingRequestAgeMs`, `lastWedgeAt`, `wedgeDeadlineMs`, `busy`, `attached`.
  A `null` is a fact ("no successful call yet", "nothing outstanding"), never a
  zero. Failing to serialise answers `{"mode": "functional", "error": …}`, not
  silence.
* the client's **functional** program is carried the same way the cheap one is —
  `py -3 -c "exec(__import__('base64').b64decode('…').decode())"` — deliberately
  with **no `--functional` flag**, so a stale guest payload cannot answer a probe
  it does not implement (its `usage()` stays byte-identical). It writes an
  `initialize` (id `900001`), `notifications/initialized` and `tools/list` (id
  `900002`) — the same three frames `connect()` sends — and prints exactly two
  lines: the token and the JSON answer. `RELAY_OK` is the token of the
  **measured** success only when both ids answered and `tools >= 1`; the one
  short-circuit below (`session-busy`) also prints it, with `measured: false`.

**What the functional probe can actually answer.** This table is the PRODUCERS,
not the intent: `win-mcp.js`'s program has exactly six exits, and a reader who
learns the reasons anywhere else will invent a seventh:

| branch | token | `measured` | `reason` | exit (the program's own) |
|---|---|---|---|---|
| TCP never connected, no line, or a JSON line this probe cannot parse | `RELAY_UNRESPONSIVE` | `false` | `no-evidence` | 3 |
| **TCP accepted, `RELAY_FN` sent, ZERO bytes back** (the relay predates the token) | `RELAY_UNRESPONSIVE` | `false` | **`probe-unsupported`** | 3 |
| the relay's evidence says `busy === true` | **`RELAY_OK`** | **`false`** | **`session-busy`** | 4 |
| both ids answered and `tools >= 1` | `RELAY_OK` | `true` | `''` | 0 |
| the child closed the socket while waiting | `RELAY_UNRESPONSIVE` | `false` | `child-eof` | 3 |
| the budget ended without both answers, or `tools == 0` | `RELAY_UNRESPONSIVE` | `false` | `child-silent` | 3 |

**`session-busy` is not a health verdict, and it is not rank 3.** It is the one
answer the probe gives about ITSELF rather than about the child: the relay's
evidence says `busy === true`, meaning the attached session (a real `tools/call`
in flight, or another probe) already holds the child — so the program returns
**before** it opens a second socket and never runs the
`initialize`/`tools/list` round trip. The token is `RELAY_OK` because the _lane_
is demonstrably fine, `measured` is `false` because **nobody measured the child**,
and `relayOk` is therefore **true on an answer that proves nothing about the
child** — `relayAnswerRelayOk()` reads the status only, by design, because the
lane really is usable.

That is the trap this paragraph exists to close: a busy answer must never be
allowed to conclude health. It still carries the relay's own evidence, so the
verdict is decided from the numbers, not the token — `lastSuccessfulCallAgeMs`
(how long since ANY call succeeded), `outstandingRequestAgeMs` (how long the id
somebody else's session owns has been open) and `childRestarts` — which is
exactly the evidence the doctor's `unresponsive` branch consumes and prints
(`lastSuccessfulCallAgeMs=…, outstandingRequestAgeMs=…, childRestarts=…`). Read it
as: **busy = "the lane is up, the child is somebody else's question right now"** —
re-probe when the session frees, and until then a busy answer with an aged or
absent `lastSuccessfulCallAgeMs` is evidence of an overdue child, not a clean
bill of health.

**A fourth token, and it is not a fifth failure mode:**

| token | rank | meaning |
|---|---|---|
| `RELAY_OK` | 0 | the cheap probe answered; or the functional one answered and the child listed tools (`measured: true`); or it answered `session-busy` (`measured: false` — lane up, child unmeasured) |
| `RELAY_SKEW` | 1 | the payload answered something unreadable — a payload mismatch, not a dead relay |
| `RELAY_DOWN` | 2 | the transport never delivered a token: nothing ran |
| `RELAY_UNRESPONSIVE` | 3 | **the relay answered and its child did not** — `reason` is `child-silent`, `child-eof`, `no-evidence` or `probe-unsupported`, and **never** `session-busy`. (`probe-unsupported` is a PAYLOAD fact, not a dead child — see the deviation below) |

**The `reason` set is exactly the producers — six members, nothing surplus.**
`RELAY_FN_REASONS` (`win-mcp.js`) is the frozen list `''`, `child-silent`,
`child-eof`, `session-busy`, `no-evidence`, `probe-unsupported`: one member for
each of the six exits above and nothing else. A value from OUTSIDE the set is
normalized to `no-evidence` rather than forwarded — an unrecognised word means
"the evidence did not arrive", not a seventh diagnosis.

**`probe-unsupported` is the one reason that dates the guest.** It is proven by
the program's own flags — connected, `RELAY_FN` sent, zero bytes back — and it
means *the relay is healthy and older than the token*, never *the child is
broken*. The verdict must therefore name the right verb: for this reason (and for
`payload.stale: true`) the next action is **re-create the computer**, not
"re-register the relay task" — re-registering a task that is already running
changes nothing about a payload that predates the probe.

**…and it does NOT move `status`.** This is a deliberate deviation (`D7`), stated
where a consumer will read it: the doctor's `status` stays **`ok`** for a
`probe-unsupported` answer, because the lane is genuinely up and the status field
answers the lane question. The staleness is carried by
`relayFunctional.reason: "probe-unsupported"`, `payload.skew: true`,
`payload.stale`/`payload.guardHash`, and by the **verdict sentence**, which names
re-create in *both* the `unresponsive` and the `ok` branch (`windowsStalePayloadClause`).
A consumer that reads only `status` will see `ok` on that guest; that is the
documented trade (no fifth status value), not an oversight. Read the sentence, or
`payload.stale`, before concluding a stale guest is healthy.

**The retired member.** `wedge` was once listed and never emitted: the relay's
evidence object carries no `reason` field at all, and a wedge is `event('wedge', …)`
in the log plus `lastWedgeAt` in the evidence. It is gone from the constant, and
`tests/modules-unit.mjs` D-9 pins both halves — the exact five, frozen, and an
answer that claims `wedge` arriving as `no-evidence`.

`RELAY_UNRESPONSIVE` outranks every other token because it is the strongest
statement available: the lane exists, the process behind it does not answer.
`relayOk` stays **false** for it (rank-3 evidence is not a usable lane), and the
doctor reports `status: "unresponsive"` with the evidence numbers — see
*The three codes the model branches on* below — and the `status` precedence is
`leaking → blind → unresponsive → ok`.

#### The wedged child: the 20 s deadline, the kill, and `child-wedged`

The relay pairs every outbound request id with an inbound answer **passively**,
from the bytes it already forwards (`_observe_outbound` / `_observe_inbound` —
they can only append to and pop from `pending`, and both are wrapped so the
bridge stays raw). That pairing is what makes a wedge measurable at all.

* **the trigger** is age, not a guess: one request outstanding longer than
  `WEDGE_DEADLINE_MS` (20 000, or `DSH_CUA_MCP_WEDGE_DEADLINE_MS`) is a *wedged*
  child — not slow, never coming back. `0` disables the watchdog (the old
  behaviour: the call waits forever); anything else is clamped to
  `200..600000`, read at **call time** so a test can scale it.
* **the order is the contract**: log the wedge (`event('wedge', 'id=… age=…')`),
  **kill** the child (`TerminateProcess`, `self.proc` cleared *before* the kill so
  the dying child's own EOF is not read as "my client is gone"), **then** answer.
  An answer before the kill lets the client retry into the same wedged process.
* **every pending id is answered once, ascending, on the same socket** the client
  is already reading — a re-connect would lose the session the wedge just saved.
  The error is `{"id": n, "error": {"code": -32000, "message": "child-wedged: the
  MCP server did not answer in <n> ms; killed pid <p> (restart #<r>); the call did
  not return, so its effect is UNKNOWN - re-observe before retrying"}}`. The
  `-32000` is the guest's own code; `win-mcp.js` rethrows it as
  `code: 'child-wedged'` and the plugin publishes it to the model **verbatim**,
  because that sentence is the only thing that says the effect is UNKNOWN.
* **the lane heals without a reconnect**: the next client spawns a fresh child
  (`childRestarts` increments, `childPid` changes) and the next request succeeds.
  `_fn_evidence()` reports both, which is why the doctor can say "it restarted
  twice" instead of "it is unresponsive".

#### The facts file has a cadence, and it is not one number

`publish_desktop_facts()` writes the file **atomically** (a temp file in the same
directory + `os.replace`, so a reader never sees a torn JSON) and adds
`refreshMs` — the interval the measurement just earned — plus the `relay` block
(C3's counters). The interval is `facts_refresh_interval(facts)`:

| facts | interval | why |
|---|---|---|
| every fact true (lane, work dir, scale) | `FACTS_FULL_REFRESH_MS` = 900 000 (15 min) | a healthy desktop does not change on its own |
| any fact not true | `FACTS_REFRESH_MS` = 60 000 | a half-working guest is the one worth re-measuring |
| 5 consecutive **identical** suspect passes | back to 900 000 | `FACTS_SUSPECT_MAX`: a permanently half-broken guest must not cost an SSH child every minute forever |

Both cadences are overridable (`DSH_CUA_MCP_FACTS_REFRESH_MS`,
`DSH_CUA_MCP_FACTS_FULL_REFRESH_MS`), and the loop sleeps in 250 ms slices so
`stop.set()` is honoured promptly instead of after a 15-minute nap.

**A stale payload is visible, not fatal.** The guest's copies of
`cua-firstboot.ps1` and `cua-mcp-relay.py` are frozen at machine-create, so an old
computer is the normal case, not an accident. The doctor carries
`payload { expectedRelayHash, relayHash, relayPresent, skew, port, portMismatch }`,
derived from the client's canonical payload
`{ measured, relayHash, expectedRelayHash, port, portMeasured, skew }` (the set
`DOCTOR_FACTS_FIELDS` names). The identity fields mean different things:

* `measured` is the marker that makes the rest readable: it lives on the client
  payload and on the repair record (`repair.measured`), and the doctor states it
  as `relayPresent`. `measured: false` + `relayHash: null` is **"nobody looked"** (no
  repair ran, or the attempt never reached the guest); a measured record that read
  the guest's relay file reports its SHA-256, and the same measured record reports
  `relayHash: ''` when there is **no relay script at all**. So `relayPresent` is
  `true` (hash read), `false` (measured and absent — the fact behind
  `relay-missing`) or `null` (not measured): "no hash yet" and "the guest has no
  relay" are not the same fact.
* `expectedRelayHash` is the **SHA-256 of the relay script this build ships**
  (lower-case hex — the same format the guest's `Get-FileHash` writes), produced
  from the harness-side file the OEM payload stages. It is **null when this build
  cannot say** (an installed bundle that carries no `docker/` tree): null means
  **unknown** — never "no relay" and never "different". Compare it with
  `relayHash` only when both are non-null; a differing pair is reported as
  `relayHash` vs `expectedRelayHash`, and the comparison is never folded into
  `skew`.
* `skew` is **true only when the guest relay ANSWERED and the harness probe could
  not read it** — the exported `PAYLOAD_SKEW_SEMANTICS` in one sentence: the
  `RELAY_SKEW` token, a `RELAY_BAD` answer, a guest repair record whose own
  `reason` is `probe-skew`, **or the functional probe answered
  `probe-unsupported`** (TCP accepted, `RELAY_FN` sent, zero bytes back — a relay
  that predates the token). The constant and this paragraph move together (C3):
  the third producer is the round's addition, and a skew flag that omits it would
  report a stale payload as a readable-but-mismatched one. It is **not** a hash
  comparison: a differing hash is
  `relayHash` ≠ `expectedRelayHash`, and a **missing interpreter** is
  `RELAY_DOWN` plus `interpreterMissing` — never skew.
* `port` / `portMeasured` are the port the guest relay was **measured answering
  on** — after the repair's ensure step the record emits `port=$answerPort`, so
  this is the answer port, not the port the harness asked for; it is null with
  `portMeasured: false` when the guest could not say. The harness port the attempt
  targeted is the client repair record's `targetPort` (never reported as a
  measurement), and `portMismatch` compares the guest's answer port with the
  harness port **only when the guest measurement exists**. That is what makes the mismatch
  meaningful: the record no longer echoes the harness's own number back at it.

Nothing re-stages the payload on start — the handshake removed the *lane's*
dependence on it, so a stale relay is a fact to report (`payload.relayHash`,
`payload.portMismatch`) and re-create is the documented upgrade when a *feature*
(not the lane) needs a newer relay.

**The mismatch can be repaired from the harness.** When the forced probe is not
`RELAY_OK` and the lane is `session-0-direct`, one repair attempt may be issued: a
self-contained PowerShell script that is **generated in `win-mcp.js`, not read from
the guest** — a script that depends on a guest file cannot repair a guest file —
staged into `C:\ProgramData\cua\cua-relay-repair.b64` by **4 × 6 000-character
`cmd /c echo` appends** and started by a short decoder, and it does five things in
order (the single `-EncodedCommand` that used to carry it was **36 667** characters
— 13 721-char script → 36 592 base64 (UTF-16LE) → 36 667 with the
`powershell … Bypass <marker> ` prefix, the live report's own arithmetic — past
`cmd.exe`'s 8 191-character line, and sshd refused it with `exec request failed on
channel 0`):

1. **handshake first** — the port is the only truth, so a live relay is never
   restarted (the `WinError 10048` race cannot start);
2. **session** — the console session id for the account (`0` when there is none);
3. **task** — `schtasks /query /tn cua-mcp-host /xml`, bound iff `InteractiveToken`
   + the account + `mcp-relay-host.vbs`; re-created when missing or mis-bound as
   `/sc onlogon /ru <user> /it /rl LIMITED` (`/it` **without** `/ru` binds to the
   caller — SYSTEM — and is refused; the same create with `/ru <user>` succeeded
   from Session 0, exit 0);
4. **launcher** — regenerated when absent **or when it names another port**, with
   `--serve --port <port>` written in: an interactive session has no
   `DSH_CUA_MCP_RELAY_PORT`, so the port has to live in the launcher, which is what
   closes the port-divergence split;
5. **start + wait** — `schtasks /run` only when the port is silent, then ≤8 s for
   the handshake.

One record line comes back, space-separated, `CUA_RELAY` first —
`CUA_RELAY ok=1 port=47999 task=1 running=1 session=2 probe=RELAY_OK hash=<sha256> mode=handshake reason=`
— and the exit code is 0 iff `ok=1`. The parser tolerates a missing tail field but
**never** treats a missing `ok` as success. `task`/`running` come from
`schtasks /query` and a live check, not from `/run`; `session` is what decides
`no-interactive-session`; `reason` is a `blindReason` value or empty.

The attempt is throttled and single-flight: one per `RELAY_REPAIR_INTERVAL_MS`
(**60 s**), a `RELAY_REPAIR_TIMEOUT_MS` (**25 s**) wall for the SSH child, and
after `RELAY_REPAIR_FAILURES_BEFORE_BACKOFF` (**3**) consecutive failures the
interval becomes `RELAY_REPAIR_BACKOFF_MS` (**5 min**) until one succeeds. A
concurrent caller awaits the in-flight attempt instead of queueing a second one, it
never throws, and a success drops the 10 s probe cache — the cached `DOWN` is
exactly what would otherwise keep the next attach blind. **`DSH_CUA_VM_WIN_MCP_REPAIR=0`
spawns nothing**, and the record says so without claiming to know anything about the
guest: `skipped: true`, `disabled: true`, `measured: false`, `unmeasured: 'repair-disabled'`
(`unmeasured: 'bridge-disabled'` when `DSH_CUA_VM_WIN_MCP=0` is the switch that
fired), and **`reason: ''` — empty on purpose**. `reason` is the guest's
`blindReason` vocabulary, so putting `repair-disabled` there would preempt the probe
evidence and turn the verdict into `repair-disabled` when the measured answer is
`relay-stopped`; the switch state travels in `disabled` + `unmeasured` instead, and
`detail` names the variable (`DSH_CUA_VM_WIN_MCP_REPAIR=0`). Every record carries
that measurement marker, so `unmeasured` also says `throttled`, `no-record`,
`bridge-disabled` or `exception` when there was nothing to measure — and `reason`
stays empty on all of those paths. The doctor keeps saying `blind` (its `repair`
facts read `enabled: false`); `repair-disabled` becomes the `blindReason` itself
only when nothing else is known, because a measured failure (`relay-stopped`,
`no-interactive-session`) always wins.
The doctor's `{"repair": true}` forces ONE attempt before
the report — it bypasses the poll window, never the client's kill switch, timeout or
in-flight guard.

**The boot guard re-asserts the lane on every boot.** `relay-guard-task` stages
`cua-relay-guard.ps1` to `C:\ProgramData\cua\` and registers it as
`cua-mcp-host-guard` — `/sc onstart /ru SYSTEM /rl HIGHEST /f`, a hidden
`powershell.exe -File … -Boot -Port <port>` action (no nested quotes in `/tr`, for
the same reason the relay's command lives in a `.vbs`). In `-Boot` it re-asserts
`HKLM\…\Winlogon\AutoAdminLogon` when missing or 0, waits **≤90 s** for an `Active`
console session for the user, probes the handshake first, and registers/runs
`cua-mcp-host` only when it is missing or silent — one line per run in
`C:\ProgramData\cua\relay-guard.log`, exit 0 iff the handshake answered. firstboot
shares the implementation instead of copying it: its `mcp-relay-reassert` step is
the **one** step declared `-Always`, invokes the same guard in `-Ensure` mode
(10 s) on every invocation, and `C:\cua-provision.json` now records
`scriptVersion`, `scriptSha256` and a per-step `attempts` count, so "was this pass
even the payload I think it is" is a fact in the marker. The supervisor adds the
host-side half: on a `ready` Windows row (with `ssh` on) it fires one
`schtasks /run /tn cua-mcp-host` (20 s timeout, at most one per computer per
**15 s**), logs the exit code, and never waits for it.

**The verdict: `ok` | `blind` | `unresponsive` | `leaking`.** `status` used to be
`leaking | ok` only, so an online bridge on the blind lane reported `ok` — the
report read as a pass. Precedence is `leaking` (offline + leaked schemas,
unchanged) → `blind` (online, but not on the interactive relay) →
`unresponsive` (on the relay, but its MCP child did not answer the functional
probe) → `ok`. The last one is the session-5 addition: the cheap probe used to
vouch for it, so a wedged child read `ok` through a seven-minute-per-call outage:

| situation | `status` | `transport` | `blindReason` |
|---|---|---|---|
| attached through the relay, child answers | `ok` | `interactive-relay` | `null` |
| attached through the relay, child silent | `unresponsive` | `interactive-relay` | `null` |
| attached on session-0 **inside the boot window**, nothing measured yet | `blind` | `session-0-direct` | **`boot-race`** (`laneUpgrading: true`) |
| attached, probe failed, task/session fine | `blind` | `session-0-direct` | `relay-stopped` / `probe-skew` |
| attached, no `Active` console session | `blind` | `session-0-direct` | `no-interactive-session` |
| attached, lane never decided | `blind` | `null` | `lane-unknown` |
| not attached, computer ready | `ok` (`online: false`) | `null` | `null` |
| not attached, prefixed schemas alive | `leaking` | `null` | `null` |

`blindReason` is a **closed set — seven** — `probe-skew`, `relay-missing`,
`relay-stopped`, `no-interactive-session`, `lane-unknown`, `repair-disabled`,
`boot-race` — and nothing else is ever written into it; the doctor also prints a `verdict` sentence
built from the same fields, so the sentence and the JSON cannot disagree.
`windows_desktop` says `blind` with the same reason in its note, and its `tools`
list is empty until the names are really visible. Both doctors report
**`pluginVersion: "0.2.3"`** — this README describes `dsh-cua-vm 0.2.3`, and
`package.json` must equal `PLUGIN_VERSION` (the gate compares the two strings, so
"the fix is not in your plugin" is a fact rather than a guess). 0.2.3 is the
cold-boot round: the 90 s boot-race window with its `boot-race` blind reason, the
sixth probe reason `probe-unsupported`, the harness-side payload-freshness repair
(guard staging) with the one-field `payload.stale` verdict, the
`facts-file-absent` error code, and `leaks` narrowed to the offline residue.
0.2.2 was the session-5 release (the functional probe, the wedge watchdog, the
per-call budget ladder, `[DEGRADED]`, `desktopWarning`, the fourth doctor status
and the three guest patch steps).

#### The boot window: `boot-race` is an interval, not a verdict

A Windows computer reports `ready` when the OS is up, but the relay starts at
**logon** — the guard waits up to 90 s for an `Active` console session and then up
to 20 s for the listener. Between those two moments the lane is genuinely
session-0, and the old doctor called that `blind` + `relay-stopped`, i.e. it sent
the operator to repair a task that was about to start on its own.

The window is now modelled, bounded and self-healing, and it changes **no status
value** — the closed set stays `ok | blind | unresponsive | leaking`; what changes
is `blindReason` and the next action:

| constant | value | what it is |
|---|---|---|
| `BOOT_RACE_WINDOW_MS` | `90000` | the guard's own budget, mirrored (not a new number) |
| `BOOT_RACE_ATTACH_MS` | `24000` | the whole attach-side ladder, and `24000 < 45000` leaves the handshake its budget |
| `BOOT_RACE_PROBE_TIMEOUT_MS` | `4000` | one rung's probe |
| `BOOT_RACE_PROBE_OFFSETS_MS` | `[0, 8000, 20000]` | frozen, ascending; the last rung still fits the ladder |
| `BOOT_RACE_UPGRADE_INTERVAL_MS` | `10000` | the in-window upgrade throttle |

`bootRaceFacts()` is pure and decides everything the doctor reports:

* **the anchor is `readyAt`** — the newest `vm-state:<name>:ready` event for THIS
  computer, not the stream's own subscription handshake;
* `source` is `'stream'` (that event), `'attach'` (only the client's first attach is
  known) or `'none'` — and `live` is **false** for `'none'`, because without an
  anchor there is no window and the honest answer stays `relay-stopped`;
* `live === true` iff there is a non-negative age **inside** the window and
  **nothing was measured**. A MEASURED fact outranks the window: a measured
  `session=0` or `hash=''` must never be relabelled "wait a bit";
* the ladder runs only with `bootWindow.live === true` (and no command override),
  every probe in it passes `force: true` (the cheap probe caches for 10 s, and an
  unforced re-probe would answer from cache), and it is bounded by
  `BOOT_RACE_ATTACH_MS`;
* the 15 s watch interval is **untouched**; only the interval handed to the pure
  upgrade guard changes (10 s inside the window), so a relay that binds at
  ready+50 s is picked up at ready+50 s instead of being locked out until
  ready+99 s.

The action sentence for the reason is frozen:

> `next: nothing — the computer reported ready inside its boot window and the relay starts at logon; the re-probe rides the poll, so call windows_mcp_doctor again if the lane is still session-0 after it.`

#### `payload.stale` — the one field that dates a guest

A guest is built from the payload the image had **at machine-create**
(`setupcomplete.cmd` is one-shot), so an already-created computer can run a
firstboot and a relay older than the plugin. Nothing in the old doctor could say
so; the diagnosis had to date the guest by comparing byte counts. There are now
two comparable pairs — the relay and the guard — and one verdict:

| comparable pairs | `stale` |
|---|---|
| at least one pair measured on both sides, and at least one differs | `true` |
| at least one pair measured on both sides, and every comparable pair agrees | `false` |
| nothing comparable (`expectedRelayHash === null`, or no measured hash) | `null` |

`null` means **this build cannot say** — never `false`, the same rule
`expectedRelayHash` already documents. `payload.stale` is not `skew`: skew is "the
relay answered and the probe could not read it"; stale is "the bytes on the guest
are not this build's".

> **`PAYLOAD_STALE_SEMANTICS`** — `payload.stale` is true only when BOTH sides of at least one hash pair were measured and they differ (relay or guard); false when every comparable pair agrees; null when no pair is comparable (a build without the payload source cannot call a guest stale). It is not skew: skew is "the relay answered and the probe could not read it".

#### The payload-freshness repair: the guard, over SSH, gated

The harness can bring a pre-`e2f0efd` guest to "guard exists" without a rebuild and
without touching the relay's 93 937 bytes (which do not fit a doctor call — that
is a reprovision, and the fields say so):

* **the bytes are this build's**: `expectedGuardHash()` reads
  `../../docker/windows-oem/cua-relay-guard.ps1` by the same `import.meta.url`
  two-layout probe the relay hash uses, and returns **`null`** (never `''`, never
  `'mismatch'`) on a bundle that ships no `docker/` tree;
* **the carrier is `cmd /c echo <chunk> >>file` — NOT a PowerShell child.** On the
  live 2-vCPU guest a `powershell -Command` child costs ≈2.9 s and a `cmd /c` child
  ≈0.15 s (provenance: the pre-fix 36 667-char refusal and the ≈2.5–3 s PowerShell
  children are archived in `.live-verify/REPORT-live-verification.md`; the post-fix
  ≈0.15 s `cmd /c` figure is agent-5's follow-up run on the same guest, quoted here
  with its source rather than as this page's own measurement), so twelve PowerShell
  children could not fit the doctor's 30 s envelope
  and the `register` step lost its turn. The carrier therefore became cheap and the
  decisions stayed in PowerShell. `echo` is safe for base64 (`A-Za-z0-9+/=`: none
  of it is interpreted by cmd.exe), the decoder is whitespace-insensitive
  (`-replace '\s',''`, which strips the trailing space `echo` writes and the CRLF it
  appends — measured on the guest: `QUJD` + `REVG` → `ABCDEF`), and chunk 0
  TRUNCATES with `>`. There is no resume state: a half-written carrier from an
  interrupted run is replaced, never continued.
* **geometry, per carrier.** The guard is 32 590 B → 43 456 base64 chars
  (`ceil(32590/3)*4` = 10 864 quads × 4) → **8 chunks of 6 000** + decode + verify +
  register. The LAUNCHER repair is smaller: **4 chunks of 6 000** (max child
  6 056 chars) + one short decoder — down from a single 36 667-character
  `-EncodedCommand` that sshd refused with `exec request failed on channel 0`.
  Never `-EncodedCommand` (a `cmd.exe` line is 8 191 chars), never stdin
  (`runSshCapture` spawns with `stdio: ['ignore', …]`), never `scp` (that is the
  supervisor's `cua_vm_put`).
* **measure before you write, and REGISTRATION IS NOT CONDITIONAL ON THE FILE.**
  The first step measures the staged guard's hash **and** the scheduled task, and
  the plan is decided from both facts:

  | measured | plan |
  |---|---|
  | hash differs from this build's | measure + 8 appends + decode + verify + register (**12** children) |
  | hash matches, task absent **or unknown** | measure + register (**2**) |
  | hash matches, task present | measure only (**1** — nothing to write) |

  Only `taskPresent === true` lets the plan stop: unknown is not "present". That
  is deliberate — the live round found the exact hole, a guest whose guard FILE
  matched and whose `cua-mcp-host-guard` task was absent, where a file-only plan
  was `[measure]` and the task could therefore never be created, permanently.
* **staging is opt-in**: `repairRelay({ payloadRepair: true })`. The 15 s upgrade
  watch calls `repairRelay()` *without* it, because a poll that could stage would
  push **up to seventeen SSH children a minute** for the life of the machine (12
  payload children: measure, 8 appends, decode, verify, register — plus the
  launcher carrier's 5: 4 appends and one exec).
* **budgets, two of them, and both are walls.** `RELAY_PAYLOAD_REPAIR_TIMEOUT_MS =
  25000` bounds the payload staging (enforced between chunks);
  `RELAY_REPAIR_TOTAL_MS = 28 000` bounds the **whole forced repair** — launcher
  carrier plus payload plan — and ends 2 000 ms before `index.js`'s
  `WIN_MCP_FORCE_REPAIR_MS = 30 000`. The measured work on the live guest is
  **10 050 ms + 3 500 ms ≈ 13 550 ms** (provenance: agent-5's post-fix run on
  `win-test`, 2026-11-21, two phases — launcher carrier, then payload plan), which
  is also what the worst-case formula gives (`4 × 2 900 + 13 × 150`), so the budget
  carries ~2× margin. Running out
  reports `staged: 'incomplete'` and the next call **truncates and redoes** the
  carrier.
* `record.payload.staged` is a closed set of five — `none` (not requested),
  `current` (measured equal, nothing written), `staged` (written **and** verified),
  `incomplete` (deadline, malformed answer, or the verify disagreed — the one value
  that means "try again"), `absent` (this build cannot say the hash). Only `staged`
  may be read as "the guard is on disk". Beside it, **`payload.task`** is the
  guard TASK as the same child measured it (`schtasks /query` exit 0), three-valued
  exactly like `guardPresent` — `null` when the line did not carry `task=`, never
  `false` by omission;
* the outcome travels on a **second marker line** with its own parser
  (`CUA_PAYLOAD guard=… relay=… stale=0|1 staged=… task=0|1`), and `stale` is C6's
  table computed **on the guest** from the two comparable pairs (empty when no pair
  is comparable, which the harness reads as `null`) — so the guest's own verdict and
  the harness's `payload.stale` agree by construction rather than by luck; the frozen `CUA_RELAY` line is
  untouched, because extending it would break every fixture at once for no gain.

#### `facts-file-absent`: one fact instead of two lines of cmd noise

`desktop.error` used to be the guest's own stderr, so a guest with no facts
**writer** (a payload older than the probe) reported two localized cmd lines. It
now carries a closed-set `errorCode` — `''`, `facts-file-absent`,
`facts-unparsable`, `ssh-failed`, `read-error` — classified **language-free** and
**first match wins**: a connection-level failure is `ssh-failed` (a read that
never reached the guest also has empty stdout, and must not be called a missing
file); then empty stdout with no parsed object is `facts-file-absent`; then a
non-empty unparsable stdout is `facts-unparsable`; a thrown read is `read-error`.
The absent case is exactly one sentence —

> `facts-file-absent: C:\cua-work\cua-desktop-facts.json (the guest payload may predate the facts writer)`

— and `desktop.error` keeps its free-text semantics on every other path, so
nothing that reads it breaks.

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

**The heal also rides the 10 s state poll.** The 15 s watch covers a relay that
starts seconds late, not one that starts a minute late (the logon task can fire
long after the attach), and that was the reported residue: the computer was fine and
the session stayed blind. So every poll beat that still sees a CONNECTED
`session-0-direct` attach nudges the client's own `maybeUpgradeTransport()` again
(`nudgeRelayUpgrade`) — the same probe, the same 60 s throttle, the same in-flight
guard and the same teardown of the client's child, because the plugin calls the
client's method instead of re-implementing the decision. A late relay is therefore
healed within **≤60 s** (one throttle window) on top of the 15 s fast path, and
`DSH_CUA_VM_WIN_MCP_UPGRADE=0` silences this path too. That one call is also where
the repair lives: if the forced probe still fails on the blind lane, it issues ONE
`repairRelay()` (throttled inside the client) and one forced re-probe before
deciding, so the same ≤60 s bound covers a relay that **died** and not just one
that started late.

| Variable | Default | Meaning |
|---|---|---|
| `DSH_CUA_MCP_RELAY_PORT` | `47999` | relay port on both sides of the wire; the guest launcher gets `--serve --port <this>` written into it, because an interactive session has no environment variable of its own; garbage falls back to the default rather than building a broken command |
| `DSH_CUA_MCP_RELAY_LOG` | `C:\ProgramData\cua\mcp-relay.log` | the relay's event log |
| `DSH_CUA_VM_WIN_MCP_UPGRADE` | `1` | `0` disables the relay upgrade on both paths (the 15 s watch and the 10 s poll nudge), keeping a blind `session-0-direct` attach on that lane |
| `DSH_CUA_VM_WIN_MCP_REPAIR` | `1` | `0` disables the repair: **no repair SSH child is ever spawned**, the record comes back `disabled: true`, `measured: false`, `unmeasured: 'repair-disabled'`, `reason: ''` (empty — `reason` speaks the guest's `blindReason` vocabulary, so the switch must not overwrite a measured `relay-stopped`), and `detail: 'DSH_CUA_VM_WIN_MCP_REPAIR=0'`; the doctor keeps saying `blind` instead of claiming a heal. The bridge and the reveal are unaffected |

The repair's three budgets are **module constants, not environment variables** —
`RELAY_REPAIR_INTERVAL_MS` (`60_000`), `RELAY_REPAIR_TIMEOUT_MS` (`25_000`) and
`RELAY_REPAIR_BACKOFF_MS` (`300_000`, after
`RELAY_REPAIR_FAILURES_BEFORE_BACKOFF` = `3` failures); a caller may narrow the
wall per attempt, but the throttle is the client's own. `RELAY_REPAIR_COMMAND_MARKER`
(`'cua-relay-repair.b64'`) is the **carrier filename** that makes a repair child
recognisable to a test — not an operator switch, and no guest variable selects the
repair transport. Every child of the repair carrier names that file in its command
line, which is what separates a repair child from a probe (`-c "exec(…)"`) and from
the relay lane (`--connect`). It was `'-EncodedCommand'` while the whole repair
script rode one argument on one command line; that shape was refused by sshd (past
`cmd.exe`'s 8 191-character limit), so the script is staged into this file in
6 000-character chunks and the marker moved with it.

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
| `DSH_CUA_WINDOWS_ISO_MIDO` | `1` | `1` walks the code's chain in its declared order — `11`/`10` start at Microsoft's live page (`mido`, re-read on every create), the other codes at their pinned objects; `0` restores the static-only order (faster on an isolated network, stale by construction) |
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
