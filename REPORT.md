# Report — CUA personal computers for the DeepSeek Harness

Branch: `rea` (REA in the personal computer, from `feat/tool-trim`) · head `31d1913` · base `@deepseek-ai/dsh` 0.2.1-rc.2
Image: built from this branch with `WITH_VIRGL_QEMU=1` (6.43 GB) · GPU adds virgl QEMU
`main` keeps the old emulator/APK build; this branch deliberately drops it.

This file is a handoff: what exists, what was discovered the hard way, what is
verified, and what is still open. Start with §4 if you only read one section.

---

## 1. What this is

The harness gives the model its own Linux computer per workspace: a QEMU/KVM
guest owned by a supervisor that lives **outside** the agent sandbox, plus a
left-sidebar page (**Personal VM (CUA)**) to create, start, watch and delete
those computers. The agent reaches the VM through tools, never through
`/dev/kvm`, so it can keep running under `workspace-write`; disks live in the
`cua-vm` volume, so the workspace stays clean.

```
agent shell (workspace-write, no /dev/kvm)
      │
      ▼
cua_vm_* tools ──unix socket /tmp/cua-vm/supervisor.sock──► supervisor (owns KVM, QEMU, policy)
                                                             │
                                                             ▼
                                                        Linux VM (cua-spacesd :3211)
browser ─ /vm/view/<name>/  and  /vm/port/<name>/ ─ proxy.mjs ─┘
```

Components:

| Path | Role |
|---|---|
| `docker/cua-vm-supervisor.mjs` | UDS JSON supervisor: status/ensure/exec/put/get/port, vmCreate/Start/Stop/Delete/List/Metrics, gui/pointer/screenshot, config, checkpoint+restore, GPU provisioning |
| `plugins/dsh-cua-vm/index.js` | `cua_vm_status\|create\|ensure\|exec\|put\|get\|port\|suspend\|destroy\|gui` + prompt section `tool:cua_vm` (order 120) |
| `plugins/dsh-cua-vm/client.js` | left-nav page: Computers / Policy, New computer, Start↔Shutdown, Terminal, Metrics, Delete, viewer (video + frames) |
| `docker/proxy.mjs` | `/vm/view/*` (incl. `media`, `ws`, `api`, `session` service segments), `/vm/port/*`, `/vm/gate`, CSP rewrite |
| `compose.yaml` / `compose.gpu.yaml` | `/cua-vm` volume, GPU devices, `DSH_CUA_VM_GPU=virgl`, NVIDIA reservation |
| `.github/workflows/docker-build.yml` | `workflow_dispatch` input `virgl` → `WITH_VIRGL_QEMU=1` |

---

## 2. UI (Personal VM (CUA))

* **Computers**: per-VM state badge (+ `GPU`, `Android` and `REA` badges),
  Start/Shutdown, Show VM, Terminal, Metrics, Delete. Terminal and Metrics are
  **toggles**.
* **New computer**: name, vCPU, RAM (GB), Image, **Enable GPU** — one row.
  Shutdown asks "Do you want to shutdown <name>?" first.
* **Enable REA** — third checkbox in New computer: installs Node 22,
  rea-agents, JDK 21, Ghidra 12.1.4, JADX and the pinned jadx-headless-mcp jar,
  roughly 3.5 GB installed on a 40 GB disk; the Disk field rises to 40 when
  ticked and the card warns when the store quota is below it. Computers carry an
  **REA** badge.
* **Policy**: auto-suspend, idle minutes, **Disk Size (GB)**, max running.
  "Shutdown frees a slot, disks are untouched."
* **Viewer**: `Video` (cua stream, HTTPS) or `Frames (http)`; the agent's cursor
  is drawn over **both** (the capture never contains the X pointer).

---

## 3. Current state — verified

Round 2 verified all of this on the RTX 3060 host (omv-docker, kernel 6.12,
NVIDIA 610.57) with a computer created at 4 vCPU / 8 GB / 40 GB / GPU:

| Area | Evidence |
|---|---|
| VM lifecycle | create → ready, start/unstart, checkpoint/recreate, delete |
| **Desktop resolution** | provisioning sets 1200×750 and the XF86 mode sticks (`xrandr` → `current 1200 x 750`) |
| **Screenshot = display** | `cua do screenshot` → `1200x750`; capture is 1:1, so image pixels *are* display pixels |
| **Pointer mapping** | `cua_vm_gui click x:600,y:375` → pointer reported at `600,375` (was `640,400` before the fix) |
| **GPU** | guest `glxinfo -B` → `virgl (NVIDIA GeForce RTX 3060/PCIe/SSE2)`; OpenGL 4.3 core with the session override |
| **Blender 4.0.2** | starts on the GPU (window `(Unsaved) - Blender 4.0`), no `LIBGL_ALWAYS_SOFTWARE` needed |
| **Nested KVM** | guest `/dev/kvm` is `0666`; `KVM_GET_API_VERSION` → 12 inside the guest |
| **Workspace share** | 9p mount at `/workspace`; `echo x > /workspace/f` in the guest appears in the harness workspace at once (bidirectional, node-owned) |
| **Disk growth** | QMP `block_resize` 20→40 GB under the live QEMU, `growpart` + `resize2fs` online → `40G 36G free`, no reboot |
| **Android** | SDK + platform-tools + emulator 37.2.12 + `system-images;android-35;google_apis;x86_64` + AVD; `cua-emulator -no-window` boots **Android 15** inside the VM with `sys.boot_completed=1`, `system_server` running, `adb shell` + `screencap` (1080×2400) working — KVM nested, not software |
| Crops / zoom | `screenshot {region}` prints the inverse mapping; `zoom <window>` crops to a window and keeps coordinates valid |
| a11y | still absent for Blender; falls back to display + window list with bounds from `cua do window ls` |
| Panel | themed (dark/light), left-nav entry, self-updating list |
| **Chromium WebGL** | works on the accelerated desktop — the page renders WebGL on the Xorg/virgl session, so the round-1 llvmpipe failure does not come back |

Still un-re-verified: the video viewer over HTTPS (the frames fallback is what
plain HTTP gets).

---

## 4. Discoveries (the expensive ones)

1. **The toggle used to deliver only a device.** `--gpu virgl` gives
   `/dev/dri` + Mesa virgl, but the guest desktop ran **Xvfb**, which ignores
   the DRM node: `glxinfo` stayed llvmpipe while `eglinfo` said virgl. Anything
   that creates its own EGL context was accelerated; the visible desktop was not.
2. **Xorg fixes that only with an explicit config.** Auto-config dies with
   `Cannot run in framebuffer mode`; modesetting needs
   `Option "kmsdev" "/dev/dri/card0"` + a Screen + a ServerLayout.
3. **Xorg refuses non-console users** (`Xorg.wrap: Only console users are
   allowed to run the X server`). Launch it as `sudo -n /usr/bin/Xorg` and set
   `/etc/X11/Xwrapper.config` to `allowed_users=anybody`.
4. **A fresh CUA disk has no usable apt sources** — `ubuntu.sources` carries
   `UNAVAILABLE` placeholders, so `apt-get install` fails silently and the
   desktop silently stays Xvfb. Repair noble/updates/security first.
5. **`renderD128` is `root:render 0660`** and the guest user is not in
   `render`, so EGL apps (Chromium, emulator) fall back to llvmpipe even on an
   accelerated desktop. `chmod 0666` + a udev rule fixes it.
6. **The image preview is scaled, the file is not.** The screenshot is
   1280×800; the model is shown a normalized copy (it measured 1200×750) and
   started deriving a 1.0667 factor. Fractional clicks remove the arithmetic.
7. **The capture never contains the X pointer.** cua ships an
   `Cua.AgentCursorOverlay.default` window, but it only animates for input that
   goes through spacesd, while our clicks use `xdotool`. The panel must draw its
   own cursor.
8. **`cua_vm_get` reads guest paths.** Screenshots written to `/cua-vm/shots`
   on the host are a dead end for the model; copy them into the guest.
9. **A swapped QEMU wrapper outlives the image.** A store that was used with a
   virgl image keeps a wrapper pointing at `/usr/bin/qemu-system-x86_64`; in an
   image without it every sandbox dies with `exec: … not found`. Back up cua's
   wrapper and restore it when the binary is absent.
10. **Checkpoints must be flattened.** Copying the qcow2 preserved its backing
    chain and restore failed with `Too many open files`; `qemu-img convert -O
    qcow2` is the working flatten.
11. **The client wrapper hid the store.** A shell `HOME` of `/workspace` made
    every `cua` call look in the wrong state dir; the image wraps the CLI with
    `HOME=/cua-vm/home`.
12. **cua 0.7.0 never runs the `.cua/bin/qemu-system-x86_64` wrapper.** It
    resolves `qemu-system-x86_64` from **PATH**. Every "swap cua's wrapper"
    trick in round 1 was therefore a no-op — virgl worked all along because the
    distro QEMU happened to be on PATH, and the 9p/venus args that were
    appended to that wrapper never reached QEMU (proved with a shim that logs
    its argv: nothing, while a shim in a PATH prefix logged 44 args). The
    supervisor now owns a real shim at `/cua-vm/bin/qemu-system-x86_64` and
    prepends that directory to `PATH` for every cua call.
13. **The capture is not the screen.** cua caps a capture at ~900k pixels:
    1280×800 comes back as **1200×750** (factor 0.9375). The old code took the
    screenshot from cua and clicked with `xdotool` in *display* pixels, so every
    click landed 6% short — that was the whole "mouse control is unreliable"
    report. cua's own `do` verbs take **screenshot pixels** and map them
    (`cua do click 600 375` → pointer `640,400`); all input now goes through
    them.
14. **virgl caps the *reported* GL version at 4.2, not the feature set.** The
    4.3 extensions are all present (`GL_ARB_compute_shader`,
    `GL_ARB_shader_storage_buffer_object`, `GL_ARB_program_interface_query`,
    `GL_ARB_multi_bind`), so Blender 4.x refuses on the version string alone.
    `MESA_GL_VERSION_OVERRIDE=4.3FC` in the desktop **and** `cua-spacesd`
    drop-ins makes both GUI and `cua sb exec` see 4.3 — GPU rendering instead of
    the llvmpipe fallback.
15. **Venus is out of reach on this host.** virtio-gpu blob resources need
    `/dev/udmabuf`, which the container does not have (kernel 6.12, no module),
    so `venus=on`/`blob=on` cannot be enabled and zink has no Vulkan ICD to
    bind. GL 4.2/4.3 virgl + llvmpipe for the rest is the ceiling here.
16. **Nested KVM already works; permissions were the only block.** `-cpu host`
    passes `vmx` and `/dev/kvm` exists in the guest, but it is `root:kvm 0660`
    and `cua` is not in `kvm`. A udev rule + `chmod 0666` makes the official
    Android emulator hardware-accelerated inside the VM.
17. **A disk cannot be grown with `qemu-img`.** cua has no `stop` (suspend
    pauses QEMU and keeps the qcow2 open). QMP `block_resize` on the live
    machine, then `growpart`/`resize2fs` in the guest, grows it online.

---

## 5. Fixes shipped (newest first)

* **REA kit + gated awareness.** `rea: true` provisions the stack through its
  own idempotent script/marker; the prompt gains an REA paragraph only when a
  computer in the workspace has it, via a sync cache over vmList that never
  touches the socket on the prompt path. Also fixes `ensure()` dropping
  `gpu`/`android`/`diskGb`/`image`. Build gate: `tools/check-cua-rea.mjs`.

| Commit | Fix |
|---|---|
| round 2 | **input through `cua do`**: every click/dblclick/move/drag/type/key/hotkey/scroll is a cua verb taking screenshot pixels, so the 0.9375 capture factor cannot shift a click; one priming screenshot per VM makes the mapping deterministic; `zoom`/`unzoom`; window list with bounds |
| round 2 | **PATH QEMU shim** at `/cua-vm/bin` (`-virtfs` + distro build) — the only injection point cua 0.7.0 honours |
| round 2 | **9p workspace share**: guest `/workspace` *is* the harness workspace, bidirectional |
| round 2 | **1:1 desktop** (1200×750 via an Xorg modeline autostart) so screenshot pixels are display pixels |
| round 2 | **GPU provisioning rewritten as `docker/cua-guest-provision.sh`** (real file, not a base64 blob): apt repair, packages, render/kvm udev + groups, Xorg, GL override for the desktop *and* spacesd, 9p mount, marker with renderer/kvm |
| round 2 | **`MESA_GL_VERSION_OVERRIDE=4.3FC`**: Blender 4.x on virgl instead of llvmpipe |
| round 2 | **`cua_vm_disk`** (QMP `block_resize` + `growpart`/`resize2fs`, online) and `diskGb` on create |
| round 2 | **tool catalogue trimmed**: `docker/mcp-slim.mjs` drops the Brave verbs Playwright already offers and compresses both browser catalogues (12.8k → 6.5k tok measured in the image); CUA descriptions rewritten (1.4k → 0.7k) |
| round 2 | **MCP-manager rows filtered in the proxy** (`/dsh-mcp-manager/api`), so a plugin install can no longer reveal `browser-mcp` / `brave-devtools-mcp` |
| round 2 | panel: Install Android switch + per-VM GPU/Android/disk badges, Android in light green, and **no cursor of our own in the video view** (the viewer draws the pointer; Frames keeps its marker and the readout) |
| round 2 | **`cua_vm_android`** (`docker/cua-guest-android.sh`): SDK, platform-tools, emulator, system image, AVD, `cua-emulator` launcher |
| round 2 | provisioning runs on every start (version-checked) and has an explicit `provision` op |
| `da91f4b` | fractional clicks (`relative`), server-side `region` crops with printed mapping, screenshot size in the result, `sb exec` retries while spacesd restarts |
| `1543a44` | screenshots saved in the guest, `get` creates destination dirs, `a11y` degrades to geometry, stale QEMU wrapper restored |
| `ce10243` | agent cursor in the **video** view (mapped onto the viewer canvas), focus+pointer reported after every input action |
| `aac04c3` | provisioning repairs `UNAVAILABLE` apt sources, `chmod 0666` on `renderD*`, udev rule, `cua` added to `render` |
| `bedb3c1` | a GPU computer provisions Xorg + mesa-utils in the guest (idempotent, reverts to Xvfb if the renderer is not virgl) |
| `bd0642c` | GPU toggle per computer (beside Image), tool `cua_vm_create`, prompt rule for Android/3D, Terminal/Metrics toggles, Shutdown confirm, Policy wording |
| `b2c1d94` | prompt: when to use the desktop instead of the shell |
| `8269e0c` | CLI wrapper forces the VM store regardless of shell `HOME` |
| `6e588f5` | CI builds with `WITH_VIRGL_QEMU` on request |
| `639b753` | opt-in virgl GPU path |
| `80f2a88` | flatten the disk into a checkpoint before recreating |
| `11992c3` | draw the agent cursor (frames view) |
| earlier | viewer gate/ticket (`/vm/gate`, `x-cua-env-authorization`), CSP `frame-ancestors 'self'`, dotted gRPC service routing, seabios symlinks, `/dev/kvm` udev, theme tokens, prompt section order |

---

## 6. Deploy

```bash
git checkout feat/cua-web
docker build --build-arg DSH_VERSION=0.2.1-rc.3 \
  --build-arg WITH_VIRGL_QEMU=1 -t dsh-harness:trim-cua .
docker compose -f compose.yaml -f compose.gpu.yaml up -d
```

GPU compose needs: `devices: [/dev/kvm, /dev/dri]`, `group_add` with the host
`render`/`video` GIDs, `DSH_CUA_VM_GPU=virgl`, and the NVIDIA reservation with
`capabilities: [gpu, utility, graphics, video, compute]`.

Env knobs the supervisor reads:

| Variable | Default | Meaning |
|---|---|---|
| `DSH_CUA_VM_GPU` | unset | `virgl` = pass `--gpu virgl` on create |
| `DSH_CUA_VM_SHARE_WORKSPACE` | `1` | mount the workspace into the guest over 9p |
| `DSH_CUA_VM_SHARE_TAG` | `dshworkspace` | 9p mount tag |
| `DSH_CUA_VM_RESOLUTION` | `1200x750` | desktop geometry (900k pixels = 1:1 capture) |
| `DSH_CUA_PROVISION_SCRIPT` | `/usr/local/bin/cua-guest-provision.sh` | guest provisioning |
| `DSH_CUA_ANDROID_SCRIPT` | `/usr/local/bin/cua-guest-android.sh` | Android bootstrap |
| `MCP_SLIM` | `1` | trim the browser MCP tool catalogue (`0` = full upstream surface). No `DSH_` prefix: the MCP client strips those from a child env |
| `MCP_SLIM_VERBOSE` | unset | `1` logs the per-server tool/char/token delta to stderr |

Verify:

```bash
docker exec <c> tail -n 40 /cua-vm/supervisor.log    # "qemu: shim -> … + 9p share …"
docker exec <c> cat /cua-vm/bin/qemu-system-x86_64   # the shim
# inside the VM:
DISPLAY=:1 xrandr | head -2          # current 1200 x 750
DISPLAY=:1 glxinfo -B | grep renderer # virgl (NVIDIA …)
echo $MESA_GL_VERSION_OVERRIDE        # 4.3FC (spacesd drop-in)
mountpoint /workspace && ls /workspace
ls -l /dev/kvm                        # crw-rw-rw-
cat /var/lib/cua-provision            # version=6 … kvm=yes
```

---

## 7. Open issues

1. **The GL override is a report, not a capability.** virgl exposes the 4.3
   extension set but reports 4.2; the session lifts the string. If an app uses a
   function that is genuinely missing, it will fail on the GPU instead of
   falling back. That is still better than the old behaviour (refuse to start,
   or run at llvmpipe speed), and `LIBGL_ALWAYS_SOFTWARE=1` remains the escape
   hatch.
2. **The scratch mode is copy-then-build.** 9p is fine for source and results,
   not for object files; the prompt tells the model to build in the VM's own
   `/tmp/build` when a build writes thousands of files.
3. **Video needs HTTPS.** On plain HTTP the viewer falls back to frames. Behind
   Pangolin, `Bypass Auth` is required on `/vm/view/media`.
4. **A container restart kills QEMU**; the supervisor recreates from the
   flattened checkpoint, so files survive but running processes do not.
5. **Debian/Arch are not Cua disks.**
6. **The MCP manager needs no patch any more.** The rows are filtered from
   `/dsh-mcp-manager/api` in the proxy, so installing or updating the plugin
   cannot bring `browser-mcp` / `brave-devtools-mcp` back.
7. **Android needs the disk grown first.** The bootstrap refuses with a clear
   message under 12 GB free; `diskGb: 40` on create is the intended path.
8. **`cua_vm_android` downloads ~3.5 GB.** It is one-off per computer and the
   script is idempotent, but a slow link makes the first run long.

---

## 8. Next

1. Re-run the Blender + emulator round trip on a built image (not the patched
   container): Blender viewport interaction, then `cua-emulator` +
   `adb install` + a Compose screenshot.
2. Decide whether the 9p share stays default-on for every deployment (it gives
   the guest write access to the workspace, which is the point, but it is a
   wider surface than the copy-in model).
3. VM over MCP (`cua mcp` behind a stdio→HTTP bridge at `/vm/mcp`) so other
   agents can use the same per-workspace computer.
4. HTTPS in front of the harness so Show VM uses the real viewer everywhere.

---

## 9. Branch `cua-vm-improve` — real shutdown, real accounting, a second kind

Branch: `cua-vm-improve`, from `main` (`1986ed2`). Six work items, each committed
green. This section is the delta a reader of the older sections needs.

### 9.1 The three bugs this branch exists for

1. **"Shutdown" only suspended.** `cua sb` has no power command, so the button
   called `suspend` — the QEMU process, its RAM and its disk handles lived on,
   and the panel said "powered off". Worse, once a VM *was* powered off (the
   sandbox removed), `cua sb resume` answered "sandbox not found" for ever and
   every Start was a dead end that ended in a rebuild.
2. **The store was measured with `du` of one directory.** Checkpoints (6 GB
   each, flattened), screenshots and Windows storage were invisible, so the
   accounting said "0.0 GB of 20 GB" while the volume filled — and the next
   create died at ENOSPC mid-download. The quota test was `used > quota`, not
   `used + requested > quota`.
3. **The click space was guessed.** cua captures at most ~900k px, so a
   1280x800 desktop is delivered as a 1200x750 PNG; the tool resolved fractions
   with `sqrt(900000 / area)` — a guess at the capture size — and clicked
   display pixels. Every "the click landed 6% off" report was this.

### 9.2 What changed, by work item

| Item | Change |
|---|---|
| W1 | Registry **v2** (`{version:2, vms:{}}`) with a read-migration of v1 rows; four new policy keys (`shutdownTimeoutSec`, `checkpointPolicy`, `shotsKeepDays`, `windowsInstallTimeoutMinutes`); Windows credentials in `$STORE/windows/<name>/credentials.json`, mode 0600, never in the registry |
| W2 | Accounting = `.cua` + checkpoints + shots + windows, and `used + requested > quota` refused on both create paths; a delete **manifest** (sandbox, checkpoints incl. `.restore.qcow2`/`.tmp`, shots, ports + child procs, views, trajectories, `vmm/qemu/<name>`, Windows container + storage, registry row, each reported, cleanup continues when `sb rm` fails); `cua_vm_gc`; boot reconciliation of `ports.json` |
| W3 | Real `vmShutdown`: close ports → QMP `system_powerdown` (socket parsed from `vmm/qemu/<name>/cmdline`) → wait for exit/`query-status=shutdown` up to `shutdownTimeoutSec` → `quit` → flatten to a checkpoint (`mayBeTorn` on timeout) → `sb rm --force` → `powered-off` + `restoreFrom`; `start` cold-boots from the checkpoint and deletes the restore temp; `stop` = shutdown (`DSH_CUA_VM_LEGACY_STOP=1` restores the suspend alias); an ACPI refusal falls back to suspend *explicitly* |
| W4 | New `docker/cua-vm-space.mjs`: display from the guest, capture from the PNG's own IHDR, `scale = display/screenshot`, 30 s cache invalidated on resume/restart/zoom; clicks prime one capture then `cua do click` in screenshot pixels, xdotool fallback at `round(x*scale)`; the `sqrt` guess is gone; every pointer/typing result prints `screenshot WxH · display WxH · scale N` plus "do not rescale" when scaled; >900k px refused unless `DSH_CUA_VM_RESOLUTION_ALLOW_SCALE=1`; guest provision **v7** (`apt_ok=`, `display=`, `space_helper=1`, marker written on a broken apt too, exit 2); ImageMagick in the image; shots now under `$STORE/shots` |
| W5 | `DSH_CUA_VM_GPU` is live: `virgl` makes virgl the default for a create that omits `gpu` (explicit `false` wins, gated on `systemQemuSupportsVirgl`); one `normaliseSpec` + shared `createManaged` so `ensure` carries image/gpu/diskGb/android/rea and a rebuild restores them; `cua_vm_start` tool; `cua_vm_port` prints the URL **and** the loopback port (`result.target` was always `undefined`) |
| W6 | New `docker/cua-vm-windows.mjs`: Docker Engine API over `DOCKER_HOST`, pinned `dockurr/windows:4.35`, the env mapping the image actually reads (VERSION or a URL, DISK_SIZE/DISK_FMT/RAM_SIZE/CPU_CORES with 64 GB / 6 GB / 2 vCPU floors, GPU/RENDERNODE, MANUAL, USERNAME/PASSWORD, a local ISO as `/boot.iso`), `usb-tablet` + QMP on **7101** (dockurr owns 7100; neither is published), `NET_ADMIN`, `/storage` bind, labels, no restart policy; `installing` → `ready` only on RDP-accept **and** `query-status == running`, timeout with the last 40 log lines; console 8006 relayed into `ports.json` as `backend:"relay"`; 3389 opt-in only; `DSH_CUA_VM_WINDOWS=0` removes the option |
| W7 | Windows agent surface: `screendump` frames (`space.source='qmp'`), `input-send-event` clicks/keys (ASCII only), and structured "not available" for exec/put/get/disk with the console/RDP hint; the proxy rewrites root-path HTML/JS for relay rows; `compose.windows.yaml`, env pass-through in `compose.yaml`, `.env.example` |
| W9 | Docs + `tools/check-cua-vm.mjs` (**207 assertions**, the gate prints its own total; registered in `ci-gates.mjs`); `check-cua-rea.mjs` updated in the same commit for the three needle spellings the refactor moved (create flags → spec normaliser, `diskGb` → `spec.diskGb`, recovery row merge → `fresh.vms[name] || known`), none deleted; four new tools; the panel gained kind/version selection, per-kind gating, a Shutdown/Suspend split, installing/error badges, a Space line, Clean up, and password reveal |

### 9.3 Verification actually run

| Check | Result |
|---|---|
| `node --check` on every `.mjs` (supervisor, space, windows, plugin, proxy, gates) | green |
| `bash -n` on `docker/cua-guest-provision.sh` | green |
| `node tools/check-cua-rea.mjs` | **67** needles across 5 files (after the three spelling updates) |
| `node tools/check-cua-vm.mjs` | **270** assertions across 16 files |
| `node tools/ci-gates.mjs` | **7 passed, 0 failed, 3 skipped** (baseline was 6/0/3) |
| Supervisor smoke against a **throwaway store + stub `cua`** (82 assertions) | PASS — registry v1→v2 migration, quota refusal, delete manifest (9 items), GC (orphan kept, artifact removed, restore temp, expired view, promoted interrupted convert), shutdown of a dead QEMU, cold boot from checkpoint, **and the review regressions**: a missing `cua` does not kill the supervisor, `"../.."` names are refused before any path is built, a live no-QMP QEMU makes the shutdown refuse and change nothing while marking its existing restore point stale, that produced marking makes Start boot the base image and clear it, a clean shutdown leaves no marking, `vmSpace` switches the cua target before capturing, and a shutdown survives a concurrent exec burst |
| Shutdown against a **real QEMU** (`qemu-system-x86_64 -S`, KVM present) | PASS — `system_powerdown`, 10 s timeout, `quit`, process exit, `mayBeTorn`, `powered-off` |
| ACPI-refusal fallback against a protocol-level QMP peer | PASS — `fallback:"acpi-unsupported"`, `state:"suspended"` |
| `cua-vm-space` / `cua-vm-windows` unit tests (real PNG, tar, key map, password, cache TTL) | PASS (26 assertions) |
| A real guest boot, guest provisioning, Windows install, container create | **NOT RUN** — no `cua` runtime image store, no `qemu-img`, and creating a Windows container is a mutation on a shared engine |

**Measured on the host that carried this work** (read-only observation of a live
`/cua-vm`): `/cua-vm/home/.cua` 8.11 GB, `/cua-vm/checkpoints` **11.19 GB**
(one checkpoint *plus* one `.restore.qcow2` boot temp), shots 0.03 GB. The old
accounting reported **8.11 GB**; the real usage was **19.33 GB of a 20 GB
quota** — a 58% under-report, one create away from ENOSPC, and 6 GB of it is
exactly what `cua_vm_gc` now drops (a restore temp that no shutdown removed).

### 9.4 Review fixes (second round)

Seven defects were found in review; all are fixed on the same branch, with
regression tests where the bug was testable without a VM.

| # | Defect | Fix |
|---|---|---|
| D1 | `runCua`'s spawn `error` handler read a property off `done()`'s `undefined` return and threw **inside the listener** — any image without `cua` on PATH killed the supervisor on the first tool call | both spawn failure channels (sync throw, async `error`) resolve the same `{code:-1, stderr}` via a single-shot `done()`; no `uncaughtException` band-aid |
| D2 | `vmDelete`/`destroy` accepted any `name`, and `path.join(WINDOWS_DIR, name)` / `vmm/qemu/<name>` / `trajectories/local_<name>` then became `rmSync(recursive)` targets — `"../.."` deleted arbitrary host directories | one `assertVmName()` (the create regex) called from the **request dispatcher** (no op can forget it) *and* from every path helper (`windowsCredentialsPath`, `checkpointFilesFor`, `shotFilesFor`, `qmpTarget`, `qemuPid`, `destroyVm`, `shutdownVm`, `startFromCheckpoint`, …) |
| D3 | the "QMP unreachable" branch checkpointed without proving QEMU was dead — a live QEMU's open qcow2 was converted and advertised as a clean restore point | `pidAlive(qemuPid(name))` decides. Alive ⇒ the shutdown is **refused**: no checkpoint, no `sb rm`, no `powered-off` (removing the sandbox while QEMU runs would let Start build a second QEMU on the same disk); the row records `lastShutdown.method: "abandoned"` and the error says the computer is still running. **In the same write**, an existing `restoreFrom` checkpoint is marked `{ stale: true, staleReason: "shutdown abandoned while QEMU held the disk …" }` — that marking is the *producer* for Start's refusal, which otherwise read a field nobody wrote. A clean shutdown always writes a fresh `restoreFrom`, so a stale marking cannot survive one |
| D4 | `space.capture` captured whatever `cua do` was last pointed at | it now runs `do switch local:<name>` before the screenshot (and drops the cached space + prime flag on a switch), exactly like the gui path |
| D5 | registry read-modify-write across `await`s: a finishing `exec` could write a pre-shutdown snapshot back and resurrect `state: "ready"` | every mutation goes through `mutateRegistry()` — a tiny critical section under `withLock('@registry')` that **re-reads** inside the lock |
| D6 | a failure between container-create and start left an orphan container holding the name, with no registry row | both failure paths `DELETE` the container before the error travels |
| D7 | docs claimed 117 assertions and "21/21" needles | gates now print their own totals (**216** assertions, **67** needles) and the docs quote those; the Windows 64 GB quota requirement is stated in README §Personal VM and here |

A residual from that round: the `stale` flag was read by `startFromCheckpoint` but
**written nowhere** (the first fix aborted the shutdown before touching the row),
so the refusal was unreachable. The abandoned branch now marks an existing
restore point `{stale: true, staleReason}` in the same registry write as
`lastShutdown.method: "abandoned"`, a clean shutdown always overwrites
`restoreFrom` wholesale, and the smoke test walks the whole path: refuse → marked
stale with a reason → Start boots the base image and says why → marking cleared.
`tools/check-cua-vm.mjs` gained needles for the producer (`row.restoreFrom?.kind
===`, `staleReason:`), so a reader can no longer exist without a writer.

The Windows quota requirement is not cosmetic: `diskQuotaGb` defaults to 20 GB
and a Windows disk floors at 64 GB, so a fresh install must raise the policy
first. The create now refuses with that exact sentence (and the field to change)
instead of the generic "store quota reached".

### 9.5 Round 3: depth review (supervisor) and Windows source audit

Sixteen supervisor defects and ten Windows defects from a review against the
pinned image's own sources. All fixed; the ones a test can express without a VM
are covered in the smoke suite.

**Supervisor**

| # | Defect | Fix |
|---|---|---|
| S1 | GC raced the lifecycle: it could delete a `.tmp` a convert was writing or a `.restore.qcow2` a create was about to boot | GC runs under `withLock('@gc')` **and** takes `withVmLock(name)` per computer, the same lock every lifecycle op now holds; restore temps and checkpoint groups are decided inside it |
| S2 | `mayBeTorn` was written and never read — a torn checkpoint cold-booted silently | `startFromCheckpoint` reads both `stale` and `mayBeTorn`; either one boots the base image and says which reason applied |
| S3 | Start/Shutdown/Delete/Suspend/Resume/idle-suspend took no per-computer lock while ensure/create did | one re-entrant `withVmLock` (AsyncLocalStorage) around every lifecycle handler, so shutdown→suspend and stop→shutdown cannot deadlock and two chains cannot interleave |
| S4 | `destroyVm` deleted `vmm/qemu/<name>` even when `sb rm` failed or QEMU was alive | the QEMU directory is removed only when `pidAlive` says the process is gone; otherwise it is reported `skipped` |
| S5 | a failed `sb rm` still deleted the row → orphan sandbox + a name nobody can create or delete | the row is kept and marked `orphaned`; `cua_vm_gc` reconciles it against `sb ls` and drops it only when cua stops listing the sandbox (unmanaged sandboxes are reported, never touched) |
| S6 | rebuild paths passed `meta.image` unguarded (a v1 row has no image → `sb create undefined`) | `image` defaults to `linux` in the migration, the normaliser and every rebuild path |
| S7 | the base-image fallback after a failed checkpoint boot had no `sb rm`, unlike the first attempt | both fallbacks (start and ensure) remove the half-created record first |
| S8 | `readRegistry` swallowed every error as an empty map, and the next mutation persisted it — one EACCES wiped the store | only ENOENT means empty; anything else throws, and the throw happens before any write |
| S9 | the v1→v2 migration wrote outside the registry lock | migration runs once at boot through `mutateRegistry` |
| S10 | quota check-then-act: two creates could both pass `used + requested` | `reserveStoreBytes` holds the claim under `withLock('@store')` for the whole create (both kinds) and releases it in `finally` |
| S11 | shutdown could convert a checkpoint into a store with no room for it | the requirement (new file minus the one it replaces) is checked first; a skip is recorded in `lastShutdown.checkpointSkipped` and the notes |
| S12 | after a `quit` timeout the path converted and removed the sandbox without re-checking QEMU | a QEMU that survives `quit` is treated exactly like an unreachable monitor: no convert, no `sb rm`, no clean restore point |
| S13 | previews were closed before the outcome and never restored on the abandoned path | the preview is snapshotted and reopened when the shutdown aborts |
| S14 | one unguarded step (`writeViews`) could throw out of the delete manifest and skip the rest | every manifest step is its own try/catch and reports `failed` |
| S15 | `vmDelete` reported success even when items failed | the result carries `complete`, `deleted` (false on a partial), and the `failed` list; the tool and the panel print it |

**Round 3 residuals** (a second pass over the same defects):

| # | Defect | Fix |
|---|---|---|
| R1 | the delete verdict counted a `skipped` item as complete: deleting a computer with a live QEMU returned `deleted:true` while `vmm/qemu/<name>` was deliberately kept, so the panel said "destroyed" about a disk that was still on the volume and no longer reachable (the row had been dropped) | `complete` requires every item **removed**; a kept item makes the delete partial, the row is kept and marked orphaned (so the disk stays reachable), and `cua_vm_gc` reclaims it once cua drops the sandbox **and** the QEMU pid is gone — the panel says "partially deleted — disk kept, run Clean up" |
| R2 | the registry step was outside `step()`, so an unreadable registry threw out of `destroyVm` after the checkpoints/shots/vmm were already unlinked, and the caller got a bare error with no `items`/`failed`/`complete` | the row write is a manifest step like every other one: it reports `failed` and the structured result still comes back |
| R3 | a corrupt registry killed the supervisor at boot: the listen callback read it unguarded for the Windows-resume loop, so the socket existed and then the process exited 1 | both boot-time reads are guarded (listen callback, idle timer): the failure is logged, the Windows watches are skipped for this boot, and every tool still answers |

**Windows (checked against `dockurr/windows:4.35` and its `qemux/qemu:7.12` base)**

| # | Defect | Fix |
|---|---|---|
| W1 | QMP on 7100 collided with dockurr's own HMP monitor (second bind → EADDRINUSE at boot), and dockurr's graceful path speaks HMP there | our QMP moved to **7101**; 7100 stays dockurr's and is never dialled; documented in the module, compose header and README |
| W2 | there is no `ISO` variable in v4.35 — `windowsIso` was a silent no-op | an http(s) URL becomes `VERSION=<url>`; a local ISO is bind-mounted at `/boot.iso` (and must live inside the store); the comment and the tool text say so |
| W3 | `VRAM_SIZE` and `SHUTDOWN` do nothing on the pinned image | both removed, with the reason in the module; the gate now **forbids** them and asserts the real mapping |
| W4 | a container created before a failing credentials/registry write stayed behind | create → credentials → registry is guarded, and a failure removes the container and its storage before the error travels |
| W5 | `cua_vm_suspend` on a Windows computer ran `cua sb suspend` on a nonexistent sandbox | `docker pause` / `unpause`, `state: suspended`, and Start unpauses |
| W6 | `readyProbe` counted `paused`/`suspended` as running, so a paused guest reported ready | only `query-status == running` counts |
| W7 | `screenshot()` returned `{file}` after unlinking that file | the field is gone from the contract; callers use `saveTo` |
| W8 | two screendumps in the same millisecond shared a filename and one unlinked the other's frame | monotonic counter + random suffix |
| W9 | `save` on Windows was silently ignored | refused with a sentence that names the working path |
| W10 | docs (REPORT, BRANCH-NOTES, compose header) claimed the dead envs and 7100 | rewritten against the real mapping |

### 9.6 Architecture change: Windows is direct QEMU (replaces the container backend)

The Docker/DinD Windows backend was **removed**. Windows is now what Linux
already was: `qemu-system-x86_64` started by the supervisor, with the same
`/dev/kvm`, the same `/cua-vm` store and the same lifecycle machinery.

| Piece | Before | Now |
|---|---|---|
| runtime | `dockurr/windows` container on a DinD engine | direct QEMU in the harness container (`docker/cua-vm-windows-qemu.mjs`) |
| firmware | the image's own QEMU/SeaBIOS | **OVMF** with a per-computer `efi-vars.qcow2` + **swtpm** TPM2 |
| disk | container `/storage` bind | `$STORE/windows/<name>/disk.qcow2` (plain qcow2 → checkpointable) |
| install | the image's unattended install | pinned Microsoft ISOs in `$STORE/iso/` + `docker/windows-oem/` (Autounattend, setupcomplete, firstboot) |
| agent | none (desktop only) | **OpenSSH on every install** → exec/put/get over SSH; dsh-cua MCP lazily attached |
| display | noVNC console 8006 | QEMU VNC on loopback behind websockify+noVNC, relayed at `/vm/port/<name>/` |
| control | Docker API + QMP | QMP only (`screendump`, `input-send-event`, `query-status`, `system_powerdown`, `quit`) |
| GPU | `GPU=Y` env of the image | `virtio-gpu-pci` backed by `/dev/dri/renderD128`; **WARP** 3D, documented |
| network | bridge of the container | SLIRP + `10.0.2.2` host gateway; bridge/tap documented, not default |

**What is reused, unchanged:** registry v2 (`kind: 'windows'`, `backend: 'qemu'`),
`withVmLock`, the quota reservation, the shutdown state machine (ACPI →
checkpoint → `powered-off`), the delete manifest (now removing the Windows tree
and the swtpm socket), GC, and the port-relay pipeline.

**New files:** `docker/cua-vm-windows-qemu.mjs` (command builder + lifecycle),
`docker/windows-oem/{Autounattend.xml,setupcomplete.cmd,cua-firstboot.ps1}`,
`plugins/dsh-cua-vm/win-mcp.js` (MCP over SSH, library + `--stdio` CLI).
**Deleted:** `docker/cua-vm-windows.mjs` (the Docker-API backend) and the DinD
service in `compose.windows.yaml`.

**Honest ceilings (also in the READMEs):** no accelerated 3D (WARP), no cursor
overlay, ASCII-only QMP typing, no clipboard/a11y/window list, SSH lands in
Session 0 so dsh-cua runs as an interactive logon task and the SSH side proxies
to it, and an `nvidia-smi` EGL handle is the host-side QEMU context.

### 9.6.1 Pre-verdict fixes (B1–B3, D4–D11)

| # | Defect | Fix |
|---|---|---|
| B1 | `-vnc 127.0.0.1:<port>`: QEMU reads the suffix as a **display number** and binds 5900+port, so the relay/probe/websockify all missed | the argv now carries `vncDisplayFor(spec.vncPort)`; a gate needle and a unit test pin the display form (and that the raw port never appears) |
| B2 | the Windows checkpoint called the Linux-only helper, always returned null, and the quota guard protected a file that was never written | one writer (`checkpointDiskFile`) fed from `$STORE/windows/<name>/disk.qcow2`; Start converts the checkpoint back over the disk (skipping stale/torn ones) |
| B3 | plugin copy still described the container backend (DinD, 8006 console, "exec not available", ISO bind-mounted at /boot.iso) | rewritten: SSH exec/put/get, noVNC live view, URL-or-local ISO |
| D4 | the install watcher never set `installComplete`, so every later Start re-attached the install ISO | set in the ready transition |
| D5 | an aborted shutdown reopened the relay to the websockify it had just killed, and claimed success | `replaceLiveView` rebuilds the view and the message reflects whether it worked |
| D6 | `boot()` could throw after swtpm started, leaking the TPM and breaking the next boot | `stopSwtpm` on every failure path, plus a belt-and-braces stop in the create catch |
| D7 | a rejected `openRelay` leaked the websockify child | the child is killed before the rejection propagates |
| D9 | two concurrent creates could take the same "free" port (the registry lacks the row being built) | allocation under `withLock('@ports')` with an in-memory claim set, released on failure/delete |
| D10 | `cua-firstboot.ps1` claimed `vmWindowsStatus` reads the marker | the header now says what the marker is (an audit trail; readiness is the SSH banner) |
| D11 | the guest's tools lingered up to 30 s after a stop/delete | 5 s attach beat |
| D8 | answer-file children were out of schema order and used deprecated OOBE skips | reordered (DiskConfiguration→ImageInstall→RunSynchronous→UserData; AutoLogon→FirstLogonCommands→OOBE→UserAccounts), deprecated switches removed, order pinned by gate needles |

### 9.7 What is still open (TBC)

1. **A real guest round trip** on a built image: boot, provision v7 (`space_helper=1`),
   screenshot, click, shutdown, Start, and confirm `powered-off → ready` from the
   checkpoint. Needs `cua runtime setup qemu` and a 1.3 GB image pull.
2. **`qemu-img` absent on the test host**, so the checkpoint *convert* itself is
   unexercised (the state machine around it is tested).
3. **Windows**: the container spec is asserted statically and the Docker client is
   exercised only via `/_ping`; a full create → install → ready cycle needs a DinD
   host and ~80 GB, and is deliberately not attempted here.
4. **W8 (OpenSSH OEM script)** is documented only: exec/put on Windows stays
   "not available".
5. `prefixRootPaths` is a heuristic. It is applied only to `backend:"relay"` rows,
   but a console that builds URLs at runtime from a config string (not a literal)
   would still need a `<base>`-style fix.
6. The registry lock is per-process. Two supervisors on the same store (a
   misconfigured deployment, not a supported one) would still interleave; the
   store has no cross-process lock, and `flock` is the obvious next step.
7. **A real Windows install** — ISO download, OVMF/swtpm boot, OOBE and the
   OpenSSH/python/dsh-cua provisioning — needs egress and ~6 GB, and is a
   mutation; it is **NOT RUN** here.
8. **The dsh-cua runtime handshake** (MCP initialize/tools/list against a booted
   guest) is **NOT RUN**: the client is unit-shaped, the guest does not exist in
   this environment.
9. **The VNC end-to-end path** through websockify is **NOT RUN** (no guest to
   display), and the noVNC page's exact URL depends on the shipped noVNC build.
   The display-number conversion itself is pinned by a unit test (`-vnc :31` for
   port 5931), which is the part that was wrong.
