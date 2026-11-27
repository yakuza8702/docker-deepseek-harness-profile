# Personal VM (`cua`) and `/dev/kvm`

The personal computer the agent drives: Linux containers and Windows QEMU computers, the tool surfaces, the Windows relay and the clipboard, and the honest limits. See the [README](../README.md) for the one-line quick start.

The image ships `cua`, the Linux VM the agent builds and tests in. It needs the host's
`/dev/kvm`, which an image cannot carry; `compose.emulator.yaml` is the override that
passes the device through — the filename is historical, it used to feed the Android
emulator, which this image no longer ships:

```bash
docker compose -f compose.yaml -f compose.emulator.yaml up -d
```

That is the only requirement for *mounting* the device — but mounting is not
access. The container runs as uid 1000, and the host node is normally
`root:kvm 0660`, so the `kvm` group's gid has to be passed as well
(`KVM_GID` in `.env`, `group_add` in the compose service — both overrides already
carry it). Without it the device is visible and every open fails EACCES; see
[`the Windows backend needs /dev/kvm` — but `/dev/kvm` **is** mounted](#the-windows-backend-needs-devkvm--but-devkvm-is-mounted)
for the exact commands.

The panel is the sidebar panel **Personal VM (CUA)**; the
model drives the same computer through `cua_vm_*`. Its **Policy** tab is where
the store policy lives — raise the quota in the sidebar panel "Personal VM (CUA)"
→ Policy → Store quota (GB); the store readout beside it shows the **used** bytes
against that quota, and a saved change applies to the next create (the supervisor
re-reads `config.json` every minute). Disks live in the `cua-vm` volume, never in
the workspace.

### One computer, two kinds

| Kind | Backend | Has |
|---|---|---|
| `linux` (default) | QEMU through `cua`, guest agent on `:3211` | exec, put/get, disk growth, Android, REA, the whole desktop |
| `windows` | **direct QEMU** (OVMF + swtpm + qcow2), no container runtime | exec/put/get over SSH, the desktop over QMP, a live VNC view, element actions via dsh-cua |

Windows is opt-in and needs `compose.windows.yaml`, which only adds devices:

```bash
docker compose -f compose.yaml -f compose.windows.yaml up -d
```

It passes `/dev/kvm` (and `/dev/dri` for the display), the render/video GIDs and
`DSH_CUA_VM_WINDOWS=1`. There is **no DinD service and no privileged sidecar**:
the supervisor runs `qemu-system-x86_64` itself, under the same hardening as the
Linux guest (`cap_drop ALL`, read-only rootfs, `no-new-privileges`).

**What a Windows computer is.** A firmware chosen from a PROFILE (OVMF with a
per-computer NVRAM and an swtpm TPM2 — or, for media that predate UEFI,
`pc`/SeaBIOS with no TPM and IDE/e1000e devices), a plain qcow2 disk under
`/cua-vm/windows/<name>/`, an install medium from that version's ordered source
chain (downloaded once into `/cua-vm/iso/`), or `windowsIso`, and an unattended
answer file that installs OpenSSH, Python and dsh-cua. The guest's only network is
QEMU user-mode (SLIRP): outbound internet, host services at `10.0.2.2`, SSH
forwarded to loopback. A bridge/tap is possible but not default — it needs
`CAP_NET_ADMIN`.

**Files in and out are `scp`, and the port flag is `-P`.** A Windows computer has
no 9p share, so `cua_vm_put`/`cua_vm_get` copy over the guest's OpenSSH server
with the same per-computer key and the same port `exec` uses. The trap is the flag
itself: ssh takes **`-p PORT`** (lowercase, with a value), scp takes **`-P PORT`**
(capital), and scp's own `-p` means "preserve times/modes" and takes **no value**.
Reusing ssh's argument list therefore left the port unconsumed, and OpenSSH — which
reads positionals back-to-front, last = destination, everything before = source —
put it in a source slot. The copy failed with exactly:

```
scp: stat local "47000": No such file or directory
```

The two builders now share ONE option list (`WINDOWS_SSH_OPTS`: `BatchMode`, the
host-key policy, `ConnectTimeout`, `ServerAliveInterval`) and `buildScpArgv(meta,
localPath, guestPath, { direction })` owns the whole argv, so `to-guest` is
`[…opts…, -P, PORT, LOCAL, user@host:GUEST]`, `from-guest` is its exact mirror, and
the option list cannot drift back into ssh's spelling. `tools/scp-argv-check.mjs`
drives the real supervisor over its real socket against stub `scp`/`ssh` binaries
and parses the recorded argv with OpenSSH's own grammar — the port is never a
positional, and the OLD argv is replayed as a control that still reproduces the
error string (48 checks).

**The hardware is INBOX-DRIVER hardware, for every code.** The disk is `ide-hd`
on the q35 ICH9 **AHCI** controller and the NIC is **`e1000e`** — both drivers
ship inside Windows itself, so a consumer image needs no extra media to see its
disk or its network. This is not cosmetic: the earlier UEFI default was
`virtio-blk` + `virtio-net-pci`, and a stripped variant (`tiny10`/`tiny11`/
`core11`) has no virtio driver at all — the guest then installs with no network,
never answers SSH, and the row sits at `installing` forever while every symptom
points at Setup. `DSH_CUA_WINDOWS_VIRTIO=1` opts back into `virtio-blk-pci` +
`virtio-net-pci` for an operator whose image really carries the virtio-win
drivers; the opt-in alone is not enough — the create must also ask for virtio.
The 7u legacy profile has always been `ide-hd`/`e1000e` (an inbox Windows 7
driver and nothing else), so both firmwares now take the same decision.

**A comma in a path is not an option separator.** Both QEMU's QemuOpts splitter
and swtpm's own option grammar cut a value on commas, so a store path like
`/srv/vms,beta/…` used to truncate `file=`/`path=`/`dir=` and hand the tool a
mystery option (a disk from the wrong file, or "could not open pid file"). Every
interpolated value — the OVMF pair, the system disk, setup.img, the ISO and the
driver ISO, the TPM socket **and** `swtpm --ctrl path=`, `--tpmstate dir=`,
`--pid file=`, `--log file=` — goes through `qemuEscapeOptionValue()`, which
doubles the comma (`a,b` → `a,,b`). That is the only escape those parsers honour;
quoting does not work because the split happens first.

#### The sixteen versions

`windowsVersion` takes the dockur/WinBoat vocabulary — sixteen codes, one catalog
row each, and every row carries the store reservation, the firmware profile and
the image Setup must install. Sizes are the **virtual disk** the create reserves,
not the ISO size.

| code | installs | disk | firmware | image selection |
|---|---|---|---|---|
| `11` | Windows 11 Pro | 7.9 GB | OVMF | `/IMAGE/INDEX` 1 |
| `11l` | Windows 11 IoT Enterprise LTSC 2024 (Evaluation) | 4.7 GB | OVMF | `/IMAGE/NAME` `Windows 11 IoT Enterprise LTSC 2024 Evaluation` — **verified** from the media |
| `11e` | Windows 11 Enterprise (Evaluation) | 6.6 GB | OVMF | `/IMAGE/INDEX` 1 |
| `10` | Windows 10 Pro (22H2) | 5.7 GB | OVMF | `/IMAGE/INDEX` 1 |
| `10l` | Windows 10 Enterprise LTSC 2021 | 4.6 GB | OVMF | `/IMAGE/INDEX` 1 |
| `10e` | Windows 10 Enterprise (Evaluation) | 5.2 GB | OVMF | `/IMAGE/INDEX` 1 |
| `7u` | Windows 7 Ultimate SP1 | 3.1 GB | **SeaBIOS** | `/IMAGE/NAME` `Windows 7 Ultimate` — verified |
| `xp` | Windows XP Professional | 0.6 GB | SeaBIOS | **refused** — see below |
| `2025` | Windows Server 2025 (Standard, Desktop Experience) | 7.6 GB | OVMF | `/IMAGE/INDEX` 2 (mirrors pin `Windows Server 2025 SERVERSTANDARD` by NAME) |
| `2022` | Windows Server 2022 | 6.0 GB | OVMF | `/IMAGE/INDEX` 2 |
| `2019` | Windows Server 2019 | 5.3 GB | OVMF | `/IMAGE/INDEX` 2 |
| `2016` | Windows Server 2016 | 6.5 GB | OVMF | `/IMAGE/INDEX` 2 |
| `2012` | Windows Server 2012 R2 | 4.3 GB | OVMF | `/IMAGE/INDEX` 2 |
| `core11` | Tiny11 Core (25H2) | 3.0 GB | OVMF | `/IMAGE/INDEX` 1 |
| `tiny11` | Tiny11 (25H2) | 5.3 GB | OVMF | `/IMAGE/INDEX` 1 |
| `tiny10` | Tiny10 (23H2) | 3.6 GB | OVMF | `/IMAGE/INDEX` 1 |

**The firmware is a profile, not a boolean.** `ovmf` is q35 + UEFI + TPM2;
`seabios` is `pc` (i440FX/PIIX) + no pflash + no TPM. BOTH now name the same
**inbox** device class — `ide-hd` (q35 ICH9 AHCI is IDE-class to Windows) and
`e1000e` — because every Windows code must install with no extra driver media; the
virtio pair is an explicit opt-in (`DSH_CUA_WINDOWS_VIRTIO=1`).
Handing OVMF to a Windows 7 ISO reaches "Press any key", then finds no bootable
device and drops into the EFI Shell; handing pflash to a BIOS guest is QEMU's
"unsupported machine configuration". The create also records the firmware in
`firmware.json` next to the disk, so the **second** boot (a restart, a later
Start) picks the same profile even though the row does not carry
`windowsVersion` — and the media file name is the last fallback
(`en_windows_7_with_sp1_x64.iso` is not ambiguous). `DSH_CUA_WIN_LEGACY_BIOS=0`
refuses the BIOS path outright instead of quietly changing firmware.

**`xp` is listed and refused, on purpose.** Answering "Windows XP" with "unknown
version" would be a lie about the catalog. The row exists so the refusal can name
the real obstacle: XP has no UEFI and no `Autounattend.xml` path — its Setup reads
`winnt.sif` from a floppy/ISO root, which this OEM payload does not build. The
refusal is `code: legacy-installer-unsupported`, it happens in
`resolveWindowsIso()`/`buildQemuArgs()` **before** anything is downloaded or
spawned, and every surface (tool, panel, CLI) quotes the same sentence. Use
`windowsIso` with your own answer medium on a host that can run a BIOS machine.

Aliases still work and canonicalise into the sixteen codes: `ltsc11`/`11ltsc` →
`11l`, `ltsc10` → `10l`, `win11`, `win7`, `winxp`, `'25'`, `'22'`, `tiny11core`,
`'core 11'`, … An unknown spelling throws with the full code list — it never
silently falls back to Windows 11.

#### Where the install medium comes from

One pinned URL per version was a bet on a Microsoft CDN object staying alive, and
the bet lost: on 2026-11-15 four of the five URLs answered **HTTP 400**, because
the evaluation media moved behind a session-token page. A version is an **ordered
chain** now, tried in order, each attempt cheap and each failure named:

| strategy | what it is | when it is used |
|---|---|---|
| `mido` | Microsoft's own live download page, driven by the four calls its JavaScript makes (`tags` → `mdt` → `reply` → `sku` → `link`) | first wherever that page still publishes an ISO (`11`, `10`) |
| `esd` | the ESD catalog CAB behind `go.microsoft.com/fwlink?linkid=2156292` / `?LinkId=841361` | only when `7z`/`cabextract` is **already** in `PATH`; otherwise it reports `skipped: no cab extractor` and the chain moves on — nothing is installed to read a catalog |
| `link1`/`link2`/`link6` | pinned mirrors: `dl.bobpony.com`, `files.dog/MSDN`, `archive.org/download` | last, and each pinned with its byte count **and** SHA-256, so "somebody else's copy" is still the exact bytes this build expects |
| `midoDirect` | the static `software-static.download.prss.microsoft.com` object the page resolves to | when the live handshake fails but the object is known |

**Verification is not optional.** Every entry states the byte count and the
SHA-256 it must have (`bytes: 0` / `sha256: ''` mean "not known" — an entry only
skips the assertion it cannot make). The download is checked against the
`Content-Length` before 8 GB are written, the body is hashed while it streams, and
a mismatch is `code: iso-digest-mismatch` — a throw, because "do not boot this" is
not a boolean. A verified download writes a `.sha256` **sidecar** next to the ISO,
so the next boot re-uses the file without re-hashing 5.5 GB; a sidecar that
disagrees with the pin, or a size that does not match, makes the file **not a
cache** and it is fetched again. `DSH_CUA_WIN_ISO_SHA256=0` turns the digest comparison off
(faster, and it gives up the only evidence that the media is the one asked for):
the size is still enforced, `'0'` is the only value with that effect, and the
answer says `verified: false` with `note: "digest check disabled by
DSH_CUA_WIN_ISO_SHA256=0"` rather than pretending it checked. An unpinned cache
is never a pass either: with no pin the sidecar is hashed against the file, and a
cache with neither is refused as `unpinned-cache` and downloaded again.

The cache file name is a **function of the URL** again
(`<stem>-<sha1(url)[:8]>.iso`): it used to append random bytes, so the quota
reservation and the actual write named different paths and every restart
downloaded a second 5.5 GB copy. Full per-code URLs, sizes and digests:
[`docs/windows-iso-sources.md`](windows-iso-sources.md). Provenance of the
strategy vocabulary and the mirror set is dockur/windows' `mido`/ESD approach —
cited there.

A code whose chain cannot run here is reported **before** the download as
`no-public-link` with the remediation, not as a 400 halfway through.

**The live view** is QEMU VNC on loopback, relayed at `/vm/port/<name>/`:
*Show VM* streams the same screen the model drives and a human can take over. The
front door is the image's own **`cua-vnc-clip`** bridge (static noVNC + the
WebSocket handshake + an RFB clipboard), and it falls back to websockify if that
binary is absent, `DSH_CUA_VNC_CLIP=0`, or the bridge never listens — a broken
bridge can never cost you the console. The relay is opened **at create, right
after the row is written** (non-fatal: a failure is one log line and the install
watcher retries it at Ready), so the port serves for the whole 20–40 minutes
Setup runs — the window in which a human most wants to watch — instead of only
existing once the computer is `ready`. It is then built once and REUSED: asking
for the view again (a status poll, a second Start) returns the same row instead
of restarting the front door. The handshake **negotiates the WebSocket
subprotocol**: `Sec-WebSocket-Protocol` is answered only when the client offered
a supported one (Debian's noVNC 1.6.0 offers none, and naming `binary` anyway is
a handshake the browser must abort — the page loaded and the console said "not
connected"). See [the clipboard, both ways](#the-clipboard-both-ways).

**The GPU branch, precisely.** With Enable GPU, a Windows computer gets
`virtio-gpu-gl-pci` + `egl-headless` on `/dev/dri/renderD128` **if** the image's
QEMU lists `virtio-gpu-gl-pci` in `qemu -device help` and the render node exists
(the same capability probe the Linux guest uses); otherwise it gets a plain
`virtio-gpu-pci` framebuffer. The decision is made at create and stored on the
row. Neither branch gives Windows accelerated 3D — see the ceilings below.

**Honest ceilings:** for Windows, `gpu: true` means a **virtio display** — it is
not, and does not become, an NVIDIA (or any) 3D accelerator. Windows has **no
accelerated 3D driver** here: Direct3D falls back to WARP (CPU), and an EGL handle
in `nvidia-smi` is the host-side QEMU context, not guest acceleration. GPU
passthrough (VFIO) is **not implemented** — it is on the roadmap
(`docs/cua-capability-roadmap.md`), and it would need an IOMMU group, a second
GPU and a host driver handoff that this image does not do (see [Image provenance & known gaps](#image-provenance--known-gaps-linux)
for what happens when the render node is missing). QMP typing is ASCII-only, no
accessibility tree, no window list and **no cursor overlay** (the pointer in the
frame is the real one). The clipboard is **bidirectional through the guest's
interactive session** — the RFB path only works because firstboot now registers a
clipboard agent there; without it QEMU accepts a `ClientCutText` and drops it,
and `Set-Clipboard` over SSH lands in Session 0 (empty). See
[the clipboard, both ways](#the-clipboard-both-ways). The disk free space of a
ready Windows computer is read over SSH (`Get-PSDrive C`, 60 s) and shown on its
row, with a warning below 10 GB. `cua_vm_suspend` is QMP `stop`; `cua_vm_shutdown` is the
same ACPI → checkpoint → `powered-off` path as Linux. The dsh-cua element tools
attach lazily over SSH only while a Windows computer is ready (~3-8k tokens), and
`DSH_CUA_VM_WIN_MCP=0` removes them.

### A Windows install that never boots, or reads "not alive" while QMP says running

Four separate defects were verified live on a real container and are fixed here.
They are documented together because from the panel they all looked like "the
install is stuck".

**1. The install CD's "Press any key to boot from CD or DVD" is now pressed for
you — anchored on the prompt itself, re-armed if the firmware prints it again.**
OVMF reached the DVD, `cdboot.efi 10.0.26100.1` printed that prompt, nobody
pressed a key within its 5 s window, and the firmware printed `EFI_TIMEOUT` and
fell into the **EFI Internal Shell** — a dead end no answer file can leave.
`boot()` sends **Enter over QMP** (`input-send-event`, the same path the GUI
uses), fired by a watcher on `$STORE/windows/<name>/serial.log`:

* **the prompt is the anchor.** The log is polled every **300 ms** and the presses
  fire on the poll that sees `Press any key to boot from CD` (or `BdsDxe: starting
  Boot0001`). The window is **90 s**, because a cold q35/OVMF boot prints cdboot
  well after the old 8 s bound — the wait used to end before the prompt existed.
* **the spawn-relative guess is OFF in production.** The first-output growth
  anchor (`+1.5 s` after the OVMF banner) is disabled at the call site
  (`armDelayMs: 0`); it survives only for a caller that opts into it, because for
  this guest it is the guess that was measured wrong. The fixed 1.5/3.5/5.5 s
  offsets survive only as the fallback for a console that stays silent.
* **a re-printed prompt is served again.** BDS re-enters the DVD when nobody
  answers and prints the prompt anew; the watcher re-arms on it, for at most
  **12 cycles inside a 180 s watch**, and stops early when the QEMU exits.
* **a refused press is a MISS, not a press.** The QMP primitive RESOLVES the
  monitor's refusal (`{error:{desc}}`) instead of throwing it, so the scheduler
  reads the RESULT: a refusal is logged as `could not press enter …` and never
  counted as sent. Each press gets **3 s** (`DSH_CUA_WINDOWS_CDBOOT_PRESS_MS`),
  not the 15 s monitor default — one busy-monitor collision used to consume the
  whole prompt window; the 0.8 s retry does the retrying instead.

Knobs: `DSH_CUA_WINDOWS_CDBOOT_PROMPT_MS` (prompt window, 90 s),
`DSH_CUA_WINDOWS_CDBOOT_CYCLES` / `_WATCH_MS` (re-arm budget), `_PRESS_MS` (one
press), `_KEYS_MS` (the silent-console fallback offsets), and `_KEYS=0` to switch
the whole feature off. It is **gated on the install phase**: booting an
already-installed disk never types into the guest. A failed or refused send is
logged and skipped, never fatal.

**2. The boot order now follows the phase.** The argv used to put the disk at
`bootindex=1` and the CD at `bootindex=2` while a comment claimed the ISO booted
first — so OVMF created a `Boot0002` HDD entry, tried it, printed *HDD Not
Found*, and only then reached the DVD. While installing the **CD is
`bootindex=1`** and the disk second; after install the **disk is first** and no
CD is attached.

**3. Rows now carry their `name`.** The registry is keyed by name and its rows
had no `name` field, while every backend helper read `spec.name` — so the pidfile
path was `/cua-vm/windows/undefined/qemu.pid`, nothing was ever alive there, and
the install watch printed **`QEMU not alive (see qemu-stderr.log tail)`** forever
while QMP answered `running`. New rows are written with `name`, and
`migrateRegistryRow` injects the map key into every row already on disk, so an
existing store is repaired on the next read.

**4. The QMP call signatures are joined.** The backend dials
`qmp(host, port, commands, opts)`; the supervisor's one implementation is
`qmpCommands(port, commands, { timeoutMs, host })`. Passing the raw primitive in
put the **host string in the port argument**, the dial threw before a byte
reached the monitor, and every probe answered *"not answering"* — so even with 3
fixed, the computer never became ready. `windowsQmpAdapter` joins the two, and
`tools/check-cua-vm.mjs` + `tests/modules-unit.mjs` prove it with a faithful stub
(the test first reproduces the throw, then shows the adapter fixing it).

**4b. Two timers, because there are two failures, and a per-call budget.** A
monitor whose socket never opens and a monitor that accepts and then says nothing
are different failures, and they used to share one 15 s budget — so every probe
against a computer whose monitor had gone away waited the full window, and since
the Windows backend presses a key per call, that was 15 s **per press**. The
connect now fails on its own **2 s** budget (`QMP_CONNECT_TIMEOUT_MS`, and
immediately on `ECONNREFUSED`); the answer keeps the old 15 s default and accepts
a per-call `defaultTimeout` (the spelling the backend uses for `-press-ms`).

**Belt and braces (6):** the answer medium's root now also gets a `startup.nsh`
that tries `\efi\boot\bootx64.efi` on every mapped filesystem (`FS0`..`FS5`). If a
key press is ever missed, the EFI Shell chain-loads the install media instead of
stopping at a prompt. It is a fallback, not the mechanism — the key press is what
gets an install onto the CD.

**The answer file rides on a real, PARTITIONED disk — delivered as REMOVABLE
media.** Setup no longer sees a `vvfat` USB stick: a 64 MiB image
`$STORE/windows/<name>/setup.img` is built with `mtools`, attached **writable**,
and it is a real disk — an MBR with one active FAT32-LBA partition at LBA 2048 —
not a partitionless superfloppy. That distinction is the difference between a
disk WinPE can mount and one it cannot: the firmware (EDK2) mounts a raw FAT
volume from any block device, but **Windows does not mount a partitionless fixed
disk at all**. (dockur/windows' overlay is a superfloppy too; it works there
because of how their flow hands the medium to QEMU, so "we mirror dockur" was
never the guarantee — see `buildSetupImage()`.)

That was still not enough, and the next round was verified **inside the guest**:
WinPE mounted `setup.img` as `C:`, `dir C:\` listed `Autounattend.xml`, `more
C:\Autounattend.xml` byte-matched, there were **no Panther parse errors** — and
Setup still showed its interactive language page. The delivery class was wrong:
**Setup searches for an answer file on REMOVABLE-media roots (and the boot
media), never on a fixed-disk root.** An `ide-hd` is a fixed disk — mounted and
listed, never scanned. `setup.img` is now a **usb-storage device with
`removable=on`** (on the same `qemu-xhci` controller the pointer and keyboard
use), so Windows classifies it as removable media and scans its root.
`removable=on` is explicit because QEMU 10's usb-storage defaults it to *off*
when omitted (verified with `query-block`: omitted → `removable:false`;
`removable=on` → `removable:true`). The image itself is unchanged: MBR + FAT32
partition, `Autounattend.xml` at the root, rebuilt fresh on every create.

**And they leave when Setup finishes COPYING, not when the computer is ready.**
The ready transition needs the SSH banner, and a guest whose NIC has no driver
never answers SSH — so before this change the row stayed `installing` with
**SETUP (D:)** mounted for the life of the session, on a computer that had
finished installing. A watcher re-reads the serial tail every 15 s and ejects the
DVD and `setup0` on the first copy-done evidence (`Windows Setup is
complete/completed/finished`, `Setup has finished copying`, `Setup is applying
system settings`, or a boot-from-disk line), before SSH or MCP are up. It stops
the cdboot presses first (a re-armed cycle must not type into the disk boot),
requires QMP `running` (a paused guest queues the eject and the tray never
opens), and is bounded by `DSH_CUA_WINDOWS_EJECT_WATCH_MIN` (90 min); on any
failure the ready transition keeps its backstop role.

Windows' documented answer-file search order, and where this lands:

| # | Location Windows looks at | This medium |
|---|---|---|
| 1 | root of every **removable** drive | **✓ here** — usb-storage + `removable=on` |
| 2 | root of the **boot media** (the install DVD) | not used (untouched Microsoft ISO) |
| 3 | `%WINDIR%\Panther\Unattend.xml`, `\$WINNT$.~BT\` on the target disk | belt-and-braces via `$OEM$` / `setupcomplete.cmd` |
| 4 | `HKLM\SYSTEM\Setup` → `UnattendFile` (registry override) | not used |
| — | a **fixed-disk** root (the old `ide-hd` attach) | **never scanned** — the bug |

| QEMU bus | Device | Windows sees |
|---|---|---|
| `ide.0` | `disk.qcow2` (fixed disk) | **Disk 0** — what `Autounattend.xml`'s `<DiskID>0</DiskID>` targets |
| `ide.1` | install CD-ROM | boot device during install |
| `ide.3` | virtio-win CD-ROM (optional) | not a disk |
| `xhci.0` (USB) | `usb-storage,drive=setup0,removable=on` → `setup.img` | removable media — the answer medium |

The build is `mformat -F -H 2048 -i setup.img@@1048576` → write the MBR (type
`0x0C`, start LBA 2048, CHS `0xFE/0xFF/0xFF`, signature `0x55AA`) → `mcopy -s -i
setup.img@@1048576`. `@@` takes a **byte** offset (mtools 4.0.48), so 1 048 576 =
LBA 2048. The MBR is generated in Node (16-byte entry, 512-byte sector) because
mtools cannot write one and no partitioner is installed in the image — one fewer
runtime dependency, and the bytes are assertable in a test.

`buildSetupImage()` reads the image back before QEMU starts: the MBR signature
and partition entry must be there, `mdir -i setup.img@@1048576` must list
`Autounattend.xml` at the volume root, and `mtype` must return bytes identical to
the staged file. The root also holds `startup.nsh`, and
`$OEM$/$$/Setup/Scripts/` carries `setupcomplete.cmd`, `cua-firstboot.ps1` and
`Unattend.vbs` (the hidden launcher both Setup passes use, with exit passthrough).

**The edition is named in the answer file.** `<ImageInstall><OSImage>` carries an
`<InstallFrom>` block with exactly one `<MetaData>`, *before* `<InstallTo>` (the
schema order). Without it Setup stops at "Select the operating system you want to
install" — the second interactive page after the language page. Which image:

| version | selector | value |
|---|---|---|
| `11l` (alias `11ltsc`/`ltsc11`; pinned EVAL ISO) | `/IMAGE/NAME` | `Windows 11 IoT Enterprise LTSC 2024 Evaluation` — read from that ISO's own WIM XML (single image, `INDEX 1`) |
| `7u` (pinned mirror) | `/IMAGE/NAME` | `Windows 7 Ultimate` — verified against the media |
| `2025` (pinned EVAL ISO) | `/IMAGE/INDEX` | `2` — Standard Evaluation (Desktop Experience); image 1 is Server Core and has no desktop |
| `2022`/`2019`/`2016`/`2012` | `/IMAGE/INDEX` | `2` |
| every other code (`11`, `11e`, `10`, `10l`, `10e`, `core11`, `tiny11`, `tiny10`) | `/IMAGE/INDEX` | `1` |
| any `windowsIso` (operator ISO) | `/IMAGE/INDEX` | `1` |

The table is DERIVED from the catalog (`WINDOWS_CATALOG[code].selection`), so a
code cannot carry two different answers. A chain entry may pin its own selection
(a mirror that serves `SERVERSTANDARD` by NAME does), and the caller's explicit
`windowsImageName`/`windowsImageIndex` still wins.

Override with `windowsImageIndex` (1–999) or `windowsImageName` (exact, must match
the media or Setup refuses the install). A licensed operator ISO may also pass
`windowsKey`; it becomes a `<ProductKey>` block with
`<WillShowUI>Never</WillShowUI>`. The pinned media are EVALUATION images and need
no key (they ignore it).

### The Windows dsh-cua tools, and the gate that keeps them honest

A Windows guest has no cua sandbox agent, so its *element-level* tools come from
`dsh-cua` (pywinauto) **inside the guest**, over the SSH channel the supervisor
already has. The plugin attaches that MCP server lazily while a Windows computer
is ready, and registers its tools on the harness's global registry under the
names the harness itself uses:

| name | what it is |
|---|---|
| `mcp__windows__<guest tool>` | one per guest tool (`tool_click_at`, `find_elements`, `tool_type_text`, … 19 of them). `TOOL_PREFIX` is `mcp__windows__` — the old `cua_win__*` spelling was not an MCP name at all |
| `windows_desktop` | the **reveal**: no arguments; unhides this session's bridged tools and returns their names, descriptions and schemas |
| `windows_mcp_doctor` | diagnostics: target, online state, registered names, the raw prefix surface, grants, keepalive and the last error |

**`save_path` belongs under `C:\cua-work`.** The desktop token — the filtered,
Medium-integrity one the relay runs as — cannot write `C:\Users\cua`, so
`tool_capture_window(save_path)` should name `C:\cua-work\…`: an EMPTY
`save_path` writes under `%TEMP%\win32_mcp_shots` (the tool's own documented
default, not a redirect), and a non-empty path that cannot be written fails with
`PermissionError` instead of being relocated.

**Nothing is attached unless a session named the computer.** The bridge binds to
a Windows computer a session asked for (`cua_vm_create`, `cua_vm_ensure`,
`cua_vm_start`, `cua_vm_exec`, `cua_vm_gui`) — it never adopts "the first ready
row". One process has ONE attached guest, so the attachment is a global resource;
the TOOLS are still per session, and the rule is enforced on every call:

* a session that bound a computer may use it, and nothing else — a session bound
  to `winbox` calling a tool while the bridge is attached to `winbox2` gets a
  structured `not-the-target` refusal whose text names **both** computers and the
  fix (`bind this session first`), and its 19 names go back to hidden;
* a session that never bound anything is refused the same way, with
  `not-the-target` and `this session is bound to nothing; …`;
* **one declared relaxation**: when exactly ONE Windows computer is known to the
  bridge, a session that never bound anything may use it. The doctor records it
  (`viewer.via: "implicit-single-target"`, `implicitTarget.sessions`), so it is
  never a silent pass, and a SECOND computer withdraws the allowance immediately.

**Three gates, and they are all in the plugin's process:**

1. **the grant** — Computer Use is **ON by default**, in memory, per session. It
   is a per-session safety default, not a boundary (the page API is same-origin,
   the guest bridge is SSH-only, and the guard plus the target binding decide every
   call), and shipping it off cost every first-boot test a manual panel step
   before its first click. Denying is still explicit and still works: Personal VM
   panel → **Computer Use**, or
   `POST /dsh-cua-vm/cua-grant {"grant": false, "sessionId": "…"}` (same-origin
   only; `GET` reports `default`/`on`/`off`, and `grant-off` stays a real refusal
   code). A restart forgets all of it. What the grant can never do is make a
   stopped computer's tools visible: **offline hides the 19 names regardless of the
   grant**, because the gate is `online && granted && revealed && target`.
2. **the reveal** — even with the grant on, the names stay hidden until
   `windows_desktop` is called for that session. This is cost control: the guest's
   schema is ~3-8k tokens.
3. **the guard** — `tools.guard` vetoes the CALL at dispatch time, so a name that
   is still visible (a race, a step admission captured before a teardown) is
   **refused, never run**, with a `code:` line the model can branch on
   (`vm-offline`, `grant-off`, `reveal-required`).

**Offline means the tools are GONE, not dead — and it is the STREAM that makes it
fast.** The plugin holds ONE long-lived subscription on the supervisor's own
socket:

```
→ {"op":"subscribe","events":["vm-state","vm-removed"]}
← {"event":"ready","events":[…]}
← {"event":"vm-state","name":"…","state":"…"}
← {"event":"vm-removed","name":"…"}
```

A delete or a shutdown therefore reaches `teardown()` in **milliseconds**, not on
the next poll beat: the observed shutdown-to-disposed latency is single-digit ms
on a local socket, and the old "up to 10 s" claim is withdrawn. The subscription
reconnects with backoff after a socket error, and a supervisor that does not speak
the op answers `unknown op` (or closes without `ready`): the plugin then marks the
stream unsupported, stops asking, and the state poll is the belt — so an older
supervisor behaves exactly as before. The poll keeps running either way
(`DSH_CUA_MCP_STATE_POLL_MS`), as a second, slower answer.

Every entry point funnels into one idempotent `teardown()`, which calls every
disposer it kept, so no `mcp__windows__*` schema survives on the global registry
and **every session's** tool list shrinks at once. `windows_mcp_doctor` reports
that surface (`leaks` is the raw prefix list, and offline it MUST be empty —
`status: "leaking"` otherwise), plus the stream's own state (`stream.live`,
`stream.supported`, `stream.events`, `stream.lastEvent`). The keepalive is
`ServerAliveInterval=10` × `ServerAliveCountMax=2`, so a suspended or dead guest
fails a call inside ~20 s with `vm-offline` instead of hanging on a half-open
socket.

**The doctor is verdict-first: a probe is detail, never the answer.**
`windows_mcp_doctor` decides `online` from the plugin's own state — the stream's
newest `vm-state` for the attached computer first, then its own `WIN_MCP.online`
and registration map — and only then reports the live probe, as detail:
`probeAgeMs`, `probe.ageMs`, `probe.stale` (past `WIN_MCP_PROBE_STALE_MS = 5000`)
and `probe.overridden` (the probe still claimed a handshake and lost).
`onlineSource` is therefore `stream:<state>`, `plugin`, `plugin+probe` or
`offline` — there is deliberately no bare `probe` value, because a probe must
never be the only thing holding a dead bridge online. A `vm-state` carrying a
not-online state (`powered-off`, `powering-off`, `suspended`, `deleting`, …) is
final: the probe cannot raise `online` back to true over it. That order is the fix
for a doctor that reported `online: true / state: ready / 19 tools` for seconds
after a power-off — the cached probe was merged *over* the verdict, and "the
handshake answered five seconds ago" is not evidence about a computer that is
going down. The probe still runs (one fast round trip, no second SSH session), so
the payload gains detail without ever contradicting the state machine. The same
`guiNote` line says which lane is which: the `mcp__windows__*` tools are the
element-level surface, `cua_vm_gui` screenshots are the noVNC stream.

`DSH_CUA_VM_WIN_MCP=0` disables the whole path (no tools, no attach).
`DSH_CUA_MCP_STATE_POLL_MS` (default 10000, floor 1000) is the state-poll beat.
`tests/windows-mcp-gate.mjs` drives the real gate with a fake guest and asserts
all of the above — 19 registrations, every disposer called, the deny set on every
live agent, the guard's refusal text, and the pre-step self-heal.

### The MCP server runs in the interactive session — the loopback relay

`dsh-cua` (pywinauto) is the only thing that can find a Windows element and prove
an action landed, and for a while the SSH command started it directly:

```
harness ──ssh──▶ guest: sshd (a SERVICE, Session 0) ──▶ python -m dsh_cua.server --stdio
```

That server answers MCP perfectly and is **blind**, because UIA is per session:
`sshd` runs as a service, so the command inherits Session 0, which owns no
desktop. This was measured, not assumed:

| what was asked | what Session 0 (the SSH session) answered |
|---|---|
| `list_windows` | **0** windows |
| a notepad started by a tool | created **in "Services"** — invisible to the logged-on user |
| `SendInput` | delivered to a desktop nobody is looking at |

No amount of retrying fixes a session, so the fix is not a retry. The
**transport** was never the problem either, so the transport did not change: a
stdio relay keeps the SSH channel exactly as it was and moves only the *server*.

```
harness ──ssh stdio──▶ [relay --connect] ──127.0.0.1:47999──▶ [relay --serve] ──▶ python -m dsh_cua.server --stdio
                        the SSH child:                     firstboot's `cua-mcp-host`   a child of the /it task,
                        no desktop, moves bytes            task (`/sc onlogon /it`)     so it sees the real desktop
```

Both halves are **one file**, `docker/cua-mcp-relay.py`, which firstboot stages to
`C:\ProgramData\cua\mcp-relay.py`. Like the clipboard agent it ships in the OEM
payload on the medium's root *and* in `$OEM$/$$/Setup/Scripts` (which Setup copies
into `C:\Windows\Setup\Scripts`), because firstboot can only stage what the medium
carries.

* **`--serve`** — binds **127.0.0.1 only**, one client at a time, and keeps the
  child across reconnects: an MCP client that reconnects must not throw away the
  windows it is mid-way through, nor pay a fresh pywinauto warm-up each time. A
  child that **died** is restarted for the next client, and its death is noticed by
  the reader thread — so the client sees EOF immediately instead of a silent hang.
  The child is spawned with pipes, `bufsize=0` and **no console**: a `python.exe`
  child of an interactive task would leave a permanently blank window on the very
  desktop it automates.
* **`--connect`** — the process the SSH command starts: stdin/stdout ↔ the loopback
  socket, raw bytes, no pty, no line translation (a pty would rewrite CR/LF and
  mangle the JSON). It touches no desktop, so running in Session 0 is fine by
  design.
* **the health probe** — a connection whose first bytes are exactly `RELAY_PING` is
  answered `RELAY_OK` (**eight bytes**) and closed *before a child is touched*. A
  real MCP client sends `{"jsonrpc":…` first, so the two are unambiguous, and the
  probe is handled outside the single-session lock, so a health check can neither
  block nor be blocked by a live session. The guest-side counterpart is firstboot's
  `Test-RelayPing` (an 8-byte buffer, compared whole), and it is what makes the task
  idempotent: the port is the evidence, so a re-run does not start a second
  listener that then dies on `WinError 10048` while the marker still reads
  `ok: true`.
* **the probe the client runs** — `py -3 C:\ProgramData\cua\mcp-relay.py --ping
  <port>`, one SSH round trip, answered in milliseconds: the relay answers
  `RELAY_OK` or `RELAY_DOWN`, and the command prints exactly one token. It replaced
  a PowerShell one-liner that was *correct and too slow*: `powershell.exe` starts a
  CLR before its first socket call (~4.6 s cold on a tiny10 guest), so right after
  boot that cold start raced the then-8 s budget and reported a **live** relay as
  `RELAY_DOWN`, pinning the attach to the blind lane. The wall is now **12 s**
  (`RELAY_PROBE_TIMEOUT_MS`) — enough for a cold ssh plus a cold `py`, and a
  genuinely dead relay still costs only that, because the probe settles the instant
  an answer lands.
* **the log** — one line per event, appended to
  `C:\ProgramData\cua\mcp-relay.log` (`DSH_CUA_MCP_RELAY_LOG` overrides it).
  `pythonw.exe` has no console, so that file is the only diagnosis there is: child
  start/exit, connects, ping answers, spawn failures.

**The lane is decided on every attach, not once at boot** — the logon task can come
up minutes after the boot that made sshd reachable, so a cached decision would pin
a session to the blind lane for its whole life:

| probe answer | what the SSH child runs | what `windows_mcp_doctor` says |
|---|---|---|
| `RELAY_OK` | `py -3 C:\ProgramData\cua\mcp-relay.py --connect` | `transport: "interactive-relay"`, `relayPort: 47999`, `relayOk: true`, `transportText: "windows mcp transport: interactive-relay (port 47999, relay up)"` |
| `RELAY_DOWN` / `RELAY_BAD` | `python -m dsh_cua.server --stdio` (**Session 0**) | `transport: "session-0-direct"`, `relayOk: false`, `transportText: "windows mcp transport: session-0 fallback: … desktop automation will be blind"` |

The fallback still answers MCP — which is exactly why it is dangerous: it looks
like a working bridge and behaves blind. So the reason is recorded
(`SESSION0_FALLBACK_REASON`), logged on attach, and carried in the doctor payload,
and nothing pretends that lane can drive a desktop. `DSH_CUA_WIN_MCP_COMMAND` still
wins verbatim; the doctor then says that the override bypassed (or forced) the
relay lane instead of silently rewriting it. `py -3` rather than `python` is
deliberate: on the live guest `python.exe` is not on the non-interactive PATH while
the launcher resolves.

**A relay that starts late heals the session instead of being missed.** Deciding
per attach is not enough on its own: the logon task can fire *after* the attach
that found it down, and before this the fallback was final for the life of the
session. So a live `session-0-direct` attach polls the same probe every 15 s
(`RELAY_UPGRADE_WATCH_MS = 15000`); the moment it answers `RELAY_OK`, the client
logs `upgrading mcp transport to the interactive relay`, tears down **its own** SSH
child and lets the plugin's sync re-attach through the relay (the probe answer is
cached, so the re-attach lands on the interactive lane). A relay that came up two
seconds late is therefore picked up within ~15 s. It is bounded: at most one
attempt per 60 s (`RELAY_UPGRADE_INTERVAL_MS = 60000`, so a flapping relay cannot
become a reconnect storm), never while a `tools/call` is in flight — closing the
child under a call the model is waiting on would fail that call — and
`DSH_CUA_VM_WIN_MCP_UPGRADE=0` turns the watch off.

**The upgrade also rides the 10 s poll, so a late relay is not missed.** One 15 s
window at connect time cannot cover a logon task that fires a minute later, and
that was the whole failure: the computer had a working relay and the session stayed
blind. So every state-poll beat (`DSH_CUA_MCP_STATE_POLL_MS`, 10 s) that still sees
a CONNECTED `session-0-direct` attach calls the client's own
`maybeUpgradeTransport()` again (`nudgeRelayUpgrade`) — nothing is re-implemented,
and the throttling, in-flight and teardown rules above are the ones that apply. A
relay that starts late therefore heals the session within **≤60 s** (one throttle
window) instead of never, on top of the 15 s fast path, and
`DSH_CUA_VM_WIN_MCP_UPGRADE=0` disables this path as well as the watch.

`windows_mcp_doctor` reports the facts from the client's own **synchronous,
zero-SSH** `doctorFacts()` — the doctor has its own probe budget and never opens a
second SSH session to answer a question: `transport`, `relayPort`, `relayOk`, plus
the one-line `transportText`, which is built from the same object that is spread
into the payload so the sentence and the fields cannot disagree. Before an attach
they are `null` (`transportText: "not attached yet (no lane decided in this
process)"`), never a guess — a guessed `interactive-relay` would report a blind
bridge as healthy in exactly the case the doctor exists for.

| Variable | Default | Meaning |
|---|---|---|
| `DSH_CUA_MCP_RELAY_PORT` | `47999` | the loopback port `--serve` binds and `--connect` dials. Unparseable or out-of-range values fall back to `47999` on **both** sides of the wire instead of building a broken command |
| `DSH_CUA_MCP_RELAY_LOG` | `C:\ProgramData\cua\mcp-relay.log` | where the relay appends its one-line-per-event log |
| `DSH_CUA_VM_WIN_MCP_UPGRADE` | `1` | `0` disables the relay upgrade on BOTH paths (the 15 s watch and the 10 s poll nudge), so a `session-0-direct` attach stays on that lane even if the relay comes up later |

The chain is gated, not assumed: `tools/check-cua-vm.mjs` asserts the relay's modes,
the `--ping` mode and its `PING_BUDGET`/`read_probe_answer` reader, the probe pair
(including the **8-byte** answer), the client's `py -3 … --ping <port>` command and
its 12 s wall, the upgrade watch (`shouldUpgradeToRelay`, `maybeUpgradeTransport`,
`startUpgradeWatch`, the one log line, the env escape hatch) and the poll-side nudge
that heals a late relay (`nudgeRelayUpgrade`), both task names
(`mcp-relay-task` and the `cua-mcp-host` logon task), the `py -3 … --connect`
default, the fallback reason, the doctor's `transport`/`transportText` lines, the
Dockerfile COPYs and the uid-1000 readability proof; `tests/modules-unit.mjs` pins
the pure parts (the probe constants on both sides, the port rule, the `--ping`
command shape, the upgrade decision, `doctorFacts()` answering `null` before an
attach); `tests/windows-mcp-gate.mjs` drives the gate end to end.

### The clipboard, both ways

A clipboard is per **interactive session**. `sshd` runs in Session 0, which has
its own (empty) clipboard, so `Set-Clipboard` over SSH exits 0 and changes
nothing; and QEMU's VNC server accepts a `ClientCutText` and drops it unless the
guest runs an agent on that channel. Both of those "work" and do nothing, which is
why this is built the way it is:

| piece | where it runs | what it does |
|---|---|---|
| `cua-clip-agent.ps1` | the **user's** session, registered by firstboot as `cua-clip-agent` (`/sc onlogon /it /rl LIMITED`) | the ambient loop: watches the clipboard, writes `clip-current.txt`, polls `outbox\*.json` and puts the payload on the clipboard, echoing a `clip-ack.json` with the seq, the SHA-256 and `equal` |
| `cua-clip-set` / `cua-clip-get` | the user's session, on demand (`/sc ondemand /it`) | the fallback the panel has always used: `clip.txt` → `Set-Clipboard`, and `Get-Clipboard -Raw` → `clip-read.txt`; the task's own `Last Result` is the exit code |
| `cua-vnc-clip.mjs` | the container, `127.0.0.1` only | the noVNC front door + WebSocket + RFB clipboard: a `ClientCutText` becomes a `vmWindowsClipboardSet`, and a guest copy comes back as a `ServerCutText` |
| the panel's **Clipboard** section | the page | calls `POST /cua/windowsClipboardSet` / `windowsClipboardGet`; the **authoritative** path, and the one that keeps working when the live view does not |

**The agent path is verified, not hoped.** The fast path drops a job carrying the
digest of the text, waits for the agent's ack and checks **all three** facts —
`seq`, `sha256` and the agent's own `equal` — then reads `clip-current.txt` back
and hashes THAT. A partial match is a mismatch (`reason: "ack-mismatch"`), and the
answer says `verified: false`; it never reports "pasted" for bytes it could not
confirm. With no agent (an older guest, a failed firstboot, `DSH_CUA_CLIP_AGENT=0`)
the call falls back to `cua-clip-set` and reports `fastPathReason` — "pasted,
slowly" and "pasted, verified" are different facts about the guest and both are
named. Three refusals are their own answers rather than a generic failure:

* **`agent-error:<code>`** — the agent itself said no (`{ ok: false }` and/or a
  non-empty `error`). The backend does not call that a digest mismatch; the code
  (or a one-line, truncated message) is carried into `reason`, so the reader is
  sent to the agent's complaint instead of to hashing;
* **`too-large`** — the agent's limit is the JOB FILE, not the text. The outbox
  budget is `1 MiB − 2048` bytes of wrapper (`CLIP_OUTBOX_WRAPPER_BUDGET`), checked
  before any round trip, and the exact serialized size is re-checked after the
  JSON is built (escaping is not linear). The fast path declines; the schtasks
  path (a 1 MiB text limit) still delivers, and the answer says which happened;
* **`nulTruncated`** — a U+0000 in the text truncates the Windows clipboard. The
  paste stays `ok: true` (the prefix really landed) but it is `verified: false`
  and carries `nulTruncated: { landed, total }`.

**Ordering, and the files it writes.** The agent writes the read-back
(`clip-current.txt`) **before** the ack, and the backend re-reads the ack and the
copy up to three times, 250 ms apart, keeping the LAST ack whose `seq` matches —
otherwise a single immediate read could describe the PREVIOUS payload on a paste
that already worked (a false `readBackEqual: false`). The `seq` is a
`Date.now()` stamp (~1.79e12), so every PowerShell parameter and local that holds
it is `[long]` from the first assignment; `[int]` would overflow. Files are
per-session: `clip-state-<session>.json`, `clip-ack-<session>.json`,
`clip-current-<session>.txt` and `outbox-<session>\`, with the **canonical**
un-suffixed `clip-state.json` / `clip-ack.json` / `clip-current.txt` still written
by the same owner (identical bytes, so a reader on either path sees one truth).
Only the session holding the freshest state owns the clipboard; a second logon
does not share the outbox, which is what made two sessions overwrite each other.

**Encoding.** The RFB wire is bytes: the bridge sends **latin1** when every code
point fits in one byte (so the decode on the other side is exact) and **UTF-8**
otherwise, with the length header counting BYTES, not characters. A CJK or emoji
paste therefore travels as UTF-8 and is labelled as such;
`DSH_CUA_VNC_CLIP_POLL_MS` (default 1200) is how often the bridge reads the guest
clipboard.

**The three clipboard/environment knobs, as they are actually implemented (all
LIVE — each one is read at use time, and each is asserted by a test):**

| variable | what it really does | what you see |
|---|---|---|
| `DSH_CUA_CLIP_AGENT=0` | **the switch is live in all three hops.** (1) the BACKEND stages the sentinel file `clip-agent-disabled` beside the OEM payload and into `$OEM$/$$/Setup/Scripts` (log: `clip agent disabled by DSH_CUA_CLIP_AGENT=0 (sentinel staged)`), and it rides into `setup.img`'s root too; an unset knob **unlinks** a stale root sentinel so a re-created machine is not stuck off. (2) `cua-firstboot.ps1` searches `$PSScriptRoot`, `C:\Windows\Setup\Scripts`, `C:\ProgramData\cua` and the removable roots, COPIES one into `C:\ProgramData\cua\` before its check, then refuses to register the task and records `skipped: true, reason: 'clip-agent-disabled'` — never a bare `ok: true`. (3) `cua-clip-agent.ps1` exits on the same path (and its embedded fallback copy does the same search-then-stage hop), so a machine registered before the switch was flipped also stops | the writer logs the staging; the firstboot state shows the step skipped; pastes fall back to the on-demand tasks (`fastPathReason: "no-agent"`) |
| `DSH_CUA_WIN_ISO_SHA256=0` | disables the DIGEST comparison and nothing else. `expectedBytes` is still enforced before and after the transfer, `'0'` is the only value that does it (unset and `'1'` keep the full check), and every skipped result says `verified: false` **plus** `note: "digest check disabled by DSH_CUA_WIN_ISO_SHA256=0"` — a skipped check is visible in the answer | `vmWindowsStatus`/download log print `verified: false` and the note, never a silent pass |
| `DSH_CUA_VNC_CLIP_POLL_MS` | how often the console bridge reads the guest clipboard. Read by the SUPERVISOR at bridge start and passed as `--poll-ms`; clamped to **200–60000 ms**, rounded to an integer, and a non-numeric value means the default 1200 (not "0 = fastest") | the bridge's argv and log show the clamped value; a 12.5 or 99999 typo cannot become a busy loop or a dead channel |

**Turning it off.** `DSH_CUA_VNC_CLIP=0` reverts the live view to plain
websockify: the console is unchanged, but the RFB clipboard is gone and only the
panel's Clipboard section can move text.

### What the panel shows, and how you know a Windows install finished

**The spec is the one you asked for.** A Windows computer's row displays the
`diskGb` / `memory` / `cpu` that were requested — 20 GB / 4 GB / 2 vCPU stays
20 / 4 / 2. 64 GB disk and 6 GB RAM are the *recommended* defaults; asking for
less creates the smaller computer and attaches a `disk-below-floor` /
`memory-below-floor` warning that names the floor. Omitting a field still gets the
Windows default for that field (20 for Linux, 64 for Windows).

**While it installs**, the row carries the elapsed time, the last ~5 non-empty
lines of the serial console (Windows Setup prints there) and the two readiness
signals being watched:

| Watched while Setup runs | Answers when |
|---|---|
| the serial-log tail | Windows Setup prints (drives the progress lines) |
| QMP `query-status` | QEMU is up — it is, from the first second |
| the guest SSH banner | the answer file has installed and started OpenSSH |

The badge flips to **Ready** the moment the SSH banner answers AND QMP says
`running`; `/vm/port/<name>/` then becomes the noVNC stream you can drive. The
same sentence, tail and signals are in `vmWindowsStatus` (the panel polls it every
5 s while a computer installs) and in `cua_vm_status` for an agent, so nobody has
to read the supervisor log to tell "still installing" from "stuck".

**A stuck install** (the row says `installing` but no QEMU process is running) is
reported as such, and the panel offers **Force delete**.

### Delete, and Force delete

`Delete` runs one manifest: ports/relay, the cua sandbox, checkpoints, screenshots,
viewer row, trajectories, the QEMU directory, the Windows tree (disk, NVRAM, TPM,
credentials, OEM payload) and the registry row — one step per item, every item
reported. **A Windows computer has no cua sandbox**, so its `sb rm` step is
recorded as *not applicable* instead of failing the manifest (that failure used to
leave the name undeletable).

If an item is **kept** (a disk whose QEMU still holds it) or **failed**, the delete
is *partial* and the row stays reachable. Then:

* the panel shows **Force delete**, and
* `cua_vm_destroy` takes `force: true`.

Force delete **kills the QEMU/swtpm/websockify processes first**, verifies they are
gone by pid, and only then re-runs the same manifest — killing after unlinking is
how a store gets corrupted. Items that still fail are reported honestly (the same
`failed` / `kept` lists). The confirmation says what it does: *"This kills the VM
process and removes its disks even if the delete reported failures — the row,
container/QEMU, swtpm, websockify, disks, ports and registry row are all removed."*

### `the OEM payload is missing from this image` when creating a Windows computer

The unattended install is four data files that ship **inside the image** at
`/usr/local/share/cua-vm/windows-oem/`: `Autounattend.xml`, `setupcomplete.cmd`,
`cua-firstboot.ps1` and `Unattend.vbs`. The create path stages them into
`/cua-vm/windows/<name>/oem/`, builds them into `setup.img` — an MBR plus one
FAT32 partition at LBA 2048 (mtools) — and attaches that image as a **writable
removable usb-storage stick** before QEMU starts, so a missing file stops the
computer before the first boot — it is an **image** problem, not a setting:

* your image was built **before the Windows backend existed** (a `main`-branch
  build: `main` has no Windows code at all), or
* the image's `COPY` and the supervisor's `DSH_CUA_WINDOWS_OEM_DIR` disagree.

The medium is attached **writable** *and as removable media*, and both are
deliberate. QEMU 10 rejects a read-only block node on an IDE hard-disk device
(`-device ide-hd,drive=setup0: Block node is read-only`) and the create dies
before QEMU reaches device realize — which surfaced as the misleading *"swtpm did
not create its socket"* cascade. It is legal behind usb-storage (both writable
and read-only nodes were verified on QEMU 10.0.13), but the node stays writable
because Setup may write logs/scratch to it. The **removable** half is what makes
Setup read it at all: a fixed-disk root is never scanned for an answer file, so
`usb-storage,drive=setup0,removable=on` (QEMU 10 defaults that property to *off*)
is the delivery class that works. The image is rebuilt fresh on every create (and
its answer file byte-verified), so writes left by one install never reach the
next. The image needs **mtools in the image**; without it a create refuses with a
message naming the package, not a QEMU that cannot boot.

Pull or build a newer image from this branch with the virgl QEMU, then recreate
the container **keeping the `/cua-vm` volume** (the store and every existing
computer survive — only the container is replaced):

```bash
# build (or: Actions → docker-build on cua-vm-improve, channel=github-tag, virgl=true)
git fetch origin && git checkout cua-vm-improve
docker build --build-arg WITH_VIRGL_QEMU=1 -t ghcr.io/yakuza8702/docker-deepseek-harness-profile:local .
# …or pull the published branch build
docker pull ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest

# recreate against the new image, same compose env (compose.windows.yaml adds the devices)
docker compose -f compose.yaml -f compose.windows.yaml up -d --force-recreate

# verify — all three files must be listed
docker compose exec seek-harness ls -l /usr/local/share/cua-vm/windows-oem/Autounattend.xml \
  /usr/local/share/cua-vm/windows-oem/setupcomplete.cmd /usr/local/share/cua-vm/windows-oem/cua-firstboot.ps1
```

Two safety nets: `DSH_CUA_WINDOWS_OEM_FALLBACK_DIRS` (colon-separated, default
`/opt/seek-harness/cua-check`, which carries the same three files) is tried when
the primary directory is incomplete, and `tools/check-cua-vm.mjs` pins the
Dockerfile's `COPY` **destination** to the supervisor's runtime default, so a
drift fails the build instead of the first create.

### `Permission denied` on that directory — the files are there, the mode is wrong

If step 3 above answers **`ls: /usr/local/share/cua-vm/windows-oem/: Permission
denied`** (or `docker compose exec seek-harness ls -ld …` shows `drw-r--r--`
instead of `drwxr-xr-x`), the payload is in the image and the **directory** cannot
be traversed. That was a real defect and it is fixed here: `COPY --chmod=0644
docker/windows-oem/ …` applies `--chmod` to every entry it copies, the
directories it creates included, so a hardened container running as uid 1000
(`USER node`) got EACCES on a directory of data files — and because `existsSync`
answers `false` on EACCES, the panel reported it as a *missing* payload. The
image now creates the parent 0755, copies with `--chown=1000:1000`, normalises the
copied modes with `chmod -R a+rX`, and **proves it at build time** by re-reading
all three files as uid 1000 (`setpriv`).

The runtime error for this case is its own message (`present but NOT READABLE by
uid … — EACCES …`, with the mode/owner of the first readable ancestor and the
fix) rather than the pull-a-newer-image text.

On a container that predates the fix, **rebuild** — `chmod` cannot help there,
because `read_only: true` makes the image filesystem read-only (`chmod: …
Read-only file system`). If a rebuild is not possible right now, shadow the
directory with a read-only bind mount from a checkout (the mount's own modes are
used, so the image's `drw-r--r--` no longer applies):

```yaml
services:
  seek-harness:
    volumes:
      - ./docker/windows-oem:/usr/local/share/cua-vm/windows-oem:ro
```

```bash
docker compose -f compose.yaml -f compose.windows.yaml up -d
docker compose exec seek-harness ls -l /usr/local/share/cua-vm/windows-oem/
```

The proper fix is the image change: the parent is created 0755, the copy carries
`--chown=1000:1000`, the copied modes are normalised with `chmod -R a+rX`, and the
build re-reads all three files as uid 1000 before it can succeed.

### `the Windows backend needs /dev/kvm` — but `/dev/kvm` **is** mounted

Two different defects used to print that one sentence, and the fix is different for
each. The error now names the case it found, with the device's observed mode,
owner and this process's supplementary groups.

```bash
# which case is it? run inside the container
docker compose exec seek-harness sh -c 'ls -l /dev/kvm; id; test -r /dev/kvm && test -w /dev/kvm && echo RW-OK'
```

**(a) the node is not in the container (`ENOENT`).** The `devices:` entry is
missing from the compose command line that actually created the container. An
override only counts if it is on the *same* `docker compose` invocation:

```bash
docker compose -f compose.yaml -f compose.emulator.yaml up -d --force-recreate
```

**(b) the node is there and this uid may not open it (`EACCES`) — the reported
bug.** `devices: - /dev/kvm` mounts the node but does not grant access: Docker
passes it through with the host's own `uid:gid`, normally `root:kvm 0660`, while
the container runs as **uid 1000** (`USER node`). QEMU opens `/dev/kvm` `O_RDWR`,
so it fails with `EACCES` — and because the old probe asked
`statSync('/dev/kvm').isFile()`, which is **false for a character device**, the
capability check reported "absent" and the message told you to mount a device
that was already mounted. `group_add` listing only the render/video GIDs is the
tell: there is no `kvm` entry.

The fix is the device's **group**, and it applies at *container create* time:

```bash
# 1. on the HOST — the gid of /dev/kvm (the kvm group is resolved on the host,
#    never inside the image, so a NAME cannot be trusted)
stat -c %g /dev/kvm          # e.g. 107   (or: getent group kvm | cut -d: -f3)

# 2. record it in .env
echo "KVM_GID=$(stat -c %g /dev/kvm)" >> .env

# 3. the compose service passes it (already present in compose.emulator.yaml
#    and compose.windows.yaml; add the same two lines to a hand-written override)
#      group_add:
#        - "${KVM_GID:-107}"

# 4. recreate — a restart inherits the OLD groups
docker compose -f compose.yaml -f compose.windows.yaml up -d --force-recreate

# 5. verify: the gid must appear in id's group list, and the device must open RW
docker compose exec seek-harness sh -c 'id; ls -l /dev/kvm; exec 3<>/dev/kvm && echo KVM_OK'
```

Alternative when the compose file cannot be changed — make the node
world-accessible **on the host** (Docker passes the node with the mode it has):

```
# /etc/udev/rules.d/99-kvm.rules
KERNEL=="kvm", GROUP="kvm", MODE="0666"
```
```bash
sudo udevadm control --reload-rules && sudo udevadm trigger /dev/kvm   # or chmod 0666 for this boot
```

`cua_vm_doctor` distinguishes the two cases (`kvm: 0660 ...` vs
`kvm: DENIED (mode 0660 owner 0:107, not openable by uid 1000)` vs
`kvm: absent (device not mounted)`), and the same device split applies to the
**Linux** path (`cua sb create`): its failure now carries the same diagnosis when
the supervisor can see that the device is mounted and refused.

### Shutdown, suspend, and why Start cold-boots

`cua sb suspend` pauses QEMU and keeps its sandbox: fast, and it resumes exactly
where it was. `cua sb` has no power command, so **Shutdown** is the supervisor's
own sequence — ACPI `system_powerdown` over QMP, wait (up to
`shutdownTimeoutSec`, default 120), `quit` on timeout, flatten the disk into
`$STORE/checkpoints/<name>.qcow2`, remove the sandbox, record `powered-off`.
Windows uses the same sequence, with QMP bound to the row's own port.

**The panel/button answers in seconds; the checkpoint convert runs in the
background.** A Windows shutdown used to run that whole sequence *before*
answering, so a 10 GB system disk held the harness tool call (and the Shutdown
button) for minutes — on a computer the registry already said was powered off.
That is an ORDER defect, not a timeout one, and the order is now:

1. a **bounded QMP phase** — `WINDOWS_STOP_BUDGET_MS` = **8 s** (the handshake
   gets `WINDOWS_STOP_QMP_MS` = 5 s): an already-off computer answers instantly, a
   guest that exits is recorded as powered-off, and a guest still flushing is
   handed to the backend's full window **in the background** — nothing is
   force-quit merely for being slower than the budget;
2. the **row is written at once**, because it is what the panel badge, Start and
   the doctor read: `state: "powered-off"`, `lastShutdown` (`method`, `reason`)
   and `restoreFrom: { kind: "image", image: "windows" }` — the disk Start boots —
   plus a `checkpointPending.token`;
3. the answer carries `checkpoint: "deferred"` (a **word**, never a path: the file
   cannot exist yet), and the detached task
   (`scheduleDeferredWindowsCheckpoint` → `checkpointDiskFileAsync`) **upgrades**
   the row when the convert lands: `restoreFrom: { kind: "checkpoint", file:
   "$STORE/checkpoints/<name>.qcow2" }` and `lastShutdown.checkpointStatus:
   "saved"`. It holds the computer's lifecycle lock, so a Start can never boot a
   disk that is mid-`convert`, and it is token-guarded, so a computer started again
   keeps the truth its Start wrote.

**If the store quota cannot hold it, `checkpointSkipped` is recorded and the
computer still boots its installed disk next Start.** The decision is taken
*before* the convert: a `quota` refusal (or `checkpointPolicy: "never"` →
`policy`) writes `checkpointSkipped: { reason, detail }` and
`lastShutdown.checkpointStatus: "skipped:<reason>"`, leaves
`restoreFrom.kind: "image"`, and the badge still shows powered-off immediately. A
**guest-initiated** shutdown is recorded even when the checkpoint fails — the
state is written first, the checkpoint in its own try/catch — which is why a
quota-refused guest power-off no longer leaves a `ready` row offering a desktop
that is gone.

A powered-off computer has **no sandbox left**, so `cua sb resume` can never work
on it — that was the "stopped VM can never resume" dead end. `cua_vm_start`
therefore cold-boots it from the checkpoint (and deletes the `.restore.qcow2`
temp afterwards). `DSH_CUA_VM_LEGACY_STOP=1` restores the old behaviour where
`stop` meant suspend.

**A guest can shut ITSELF down, and the row notices.** Windows Update, a user in
the console, `shutdown /s` — none of those come through this supervisor, so the
row used to keep saying `ready` (and the panel kept offering a Shutdown button
for a computer that was already off). A per-computer QMP poll now asks
`query-status` every **3 s** (`DSH_CUA_VM_STATE_POLL_S`, clamped 1–30) while the
row is live: `shutdown` finalises the row as `powered-off` with
**`method: "guest-shutdown"`**, running the SAME checkpoint + `restoreFrom`
bookkeeping (and the same quota/policy refusals) the ACPI path uses, so Start
cold-boots from a real restore point; `paused` finalises as `suspended`
(reversible, never a checkpoint of a live disk); a vanished QEMU is an unconfirmed
`powered-off` (`mayBeTorn`, no clean restore point). The poll is unref'd and stops
on the first non-transient verdict.

### GPU

`DSH_CUA_VM_GPU=virgl` (set by `compose.gpu.yaml`) makes virgl the **default**
for a create that does not mention `gpu`; an explicit `gpu: false` still wins, and
the flag is only offered when the installed QEMU actually has
`virtio-gpu-gl-pci`. Build with `--build-arg WITH_VIRGL_QEMU=1` and pass
`/dev/dri` (`compose.gpu.yaml`).

### Coordinates

cua captures at most ~900k pixels, so the default desktop is **1200x750** —
exactly that budget, which makes the screenshot and the click the same space. A
larger `DSH_CUA_VM_RESOLUTION` is refused at create time unless
`DSH_CUA_VM_RESOLUTION_ALLOW_SCALE=1` accepts a scaled capture; either way every
desktop result prints `screenshot WxH · display WxH · scale N` and says "do not
rescale" when the two differ.

### The store

`diskQuotaGb` (default 20) counts **real bytes**: cua's own tree, checkpoints,
screenshots, Windows storage and the ISO cache. A disk is a sparse qcow2, so its
*virtual* size is never charged — a Windows computer created with the default
64 GB disk on a 15 GB policy is **created**, with
`warnings[code: disk-over-policy]`, because the bytes only appear as the guest
writes. Only a store whose real usage is already over the quota refuses a create;
a transient write (the ISO download, a checkpoint convert) still has to fit and
is checked first. **Clean up** in the panel (or `cua_vm_gc`) removes orphan
checkpoints (newest kept), boot temps, screenshots older than `shotsKeepDays`
(7), stale viewer rows and dead port rows.

`cua_vm_destroy` removes a whole manifest — sandbox, checkpoints, shots, port
rows and their child processes, viewer row, trajectory and QEMU directories, the
Windows container and its storage, and the registry row — reporting each item,
and finishing even when `sb rm` fails.

`cua_vm_doctor` reports what only the supervisor can see: `/dev/kvm` — and
whether **this uid can open it**, which is a different fact from whether the node
is mounted — the render node, whether the installed QEMU has `virtio-gpu-gl-pci`,
whether `DOCKER_HOST` answers, and the itemised store usage.

### Image provenance & known gaps (Linux)

The Linux guest is the one every session gets, so its failures are the ones nobody
reports. These are the facts the code can PROVE, and the ones it can only state —
kept together because "it works" was the previous answer to all of them.

**Disk growth is MEASURED.** `cua_vm_disk` (and the automatic grow at create)
resizes the qcow2 over QMP (`block_resize`), then grows the partition and the
filesystem **in the guest** (`growpart` + `resize2fs`), then reads the guest's own
`df -B1 --output=size,avail /` and answers with **what the filesystem reports** —
never with what was asked for. `growpart` exiting 1 with `NOCHANGE` is success (the
partition already fills the device); a refused `resize2fs` is
`reason: guest-resize-failed`, a filesystem that grew less than 95 % of the
request is `short-grow`, and both carry the command output. The registry only
records a grow that changed something, so the row cannot show 40 GB next to a
20 GB filesystem. The old code ended both commands with `|| true` and reported the
requested size — which is how "grew to 40 GB" and the next ENOSPC coexisted.

*Not grown:* a Windows computer. Its size is fixed at create time (there is no
guest `growpart` on this channel), and `cua_vm_disk` says so instead of pretending.

**A checkpoint is a file and a reason, or it did not happen.** A shutdown flattens
the disk with `qemu-img convert` into `$STORE/checkpoints/<name>.qcow2` (a
self-contained disk, not a copy that keeps a backing chain — a chain that points
at its own previous restore file becomes a cycle). The result is
`{ ok, path, bytes }` or `{ ok: false, reason }` with a reason the row keeps:
`policy` (`checkpointPolicy: never`), `quota` (not enough room), `no-disk`,
`unknown`. `checkpointSkipped` on the row is that record, and the delete/GC paths
treat a `.tmp` as an interrupted convert to **promote**, never as garbage — the
last copy of a disk must not be deleted because a `kill -9` landed mid-convert.
The `linux-checkpoint-layout` doctor check reports whether the vmm directory a
checkpoint needs even exists; a computer whose checkpoint never existed now says
why instead of looking identical to one whose checkpoint was skipped for space.

**The GPU may degrade, the accelerator may not.** If a `gpu: true` boot dies with
an EGL/render-node error, the start retries **once** with the GPU-less argv
(`-display none`, plain VGA) and records `gpu-fallback` plus `gpuDegraded` on the
row — Windows then runs Direct3D on WARP (CPU). A KVM failure is **never**
degraded that way: silently falling back to TCG would turn "your host cannot
virtualise" into a computer that is 20× slower with no explanation. The doctor's
`gpu-degraded` check names a `gpu: true` row whose renderer is software.

**The 9p share is a fact about THIS boot, not a setting.** `/workspace` reaches
the guest through QEMU's `-virtfs` mount, and the cmdline QEMU actually runs is
the only proof. `doctor` reports `share` and a `9p-share-not-attached` check when a
running row's cmdline carries no `-virtfs`; a create with
`DSH_CUA_VM_SHARE_WORKSPACE=0` says `share: "missing"` up front instead of letting
a build fail on a path that is not there. When the share is missing,
`cua_vm_put`/`cua_vm_get` still work — they scp, they do not need the mount.

**There is no digest pin on the base image.** `cua sb create <alias>` resolves the
alias inside the CLI and the image lives in cua's own store, so the doctor reports
`baseImage: "cua-managed (no digest pin: …)"` rather than inventing one. The QEMU
binary that runs IS hashed (`provenance.qemuSha256`), and so is the Microsoft
media (per-source SHA-256, see above) — but the guest disk image is only as
reproducible as the `cua` release inside this image. Treat a guest that behaves
differently after a rebuild as an image change first, and check
`cua_vm_doctor`'s `provenance` block before anything else.

**Deferred work** (design drafts, prerequisites and acceptance criteria):
[`docs/cua-capability-roadmap.md`](cua-capability-roadmap.md).
