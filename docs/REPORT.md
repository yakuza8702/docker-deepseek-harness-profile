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
* **Install rea** — third checkbox in New computer: installs Node 22,
  rea-agents, JDK 21, Ghidra 12.1.4, JADX and the pinned jadx-headless-mcp jar,
  roughly 3.5 GB installed on a 40 GB disk; the Disk field rises to 40 when
  ticked and the card warns when the store quota is below it — the create still
  proceeds (the disk is sparse) and carries `warnings[code: disk-over-policy]`.
  It **installs in the background**: Create returns when the VM is up, the row
  shows `REA…` while the job runs, and a failure shows **REA failed** with a
  **Retry install** button (the row also carries the tail and the retry hint).
  Computers carry an **REA** badge once the kit is verified.
  A verified row also shows the resolved `rea <version>` beside the badge.
  Nothing is pinned for you any more: a new computer installs `rea-agents@latest`
  (Node, Ghidra and JADX stay pinned — REA's doctor refuses other Ghidra builds),
  and `REA_AGENTS_VERSION` pins a version when a workspace wants one.
  **Update rea** on a verified row queues one `rea` step with `update: true`, which
  the supervisor runs as `REA_FORCE_UPDATE=1` — past `/var/lib/cua-rea`, without
  deleting the disk (`POST /cua/provision {"update": true}` is the tool-side twin).
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
| W2 | Accounting = `.cua` + checkpoints + shots + windows + the ISO cache, with the quota charged on **real bytes**: a create refuses only when the store's real usage is already over the policy (a sparse virtual disk is a `disk-over-policy` warning), while a transient write (ISO download) is `used + requested > quota`; a delete **manifest** (sandbox, checkpoints incl. `.restore.qcow2`/`.tmp`, shots, ports + child procs, views, trajectories, `vmm/qemu/<name>`, Windows container + storage, registry row, each reported, cleanup continues when `sb rm` fails); `cua_vm_gc`; boot reconciliation of `ports.json` |
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
| `node tools/check-cua-vm.mjs` | **315** assertions across 16 files (314 in the flat `cua-check` replay) |
| `node tools/check-anchors.mjs` | **14** assertions — both directions, offline |
| `node tools/ci-gates.mjs` | **7 passed, 0 failed, 3 skipped** (baseline was 6/0/3) |
| `node tests/supervisor-smoke.mjs` — throwaway store + stub `cua` (98 assertions) | PASS — registry v1→v2 migration, quota refusal, delete manifest (9 items), GC (orphan kept, artifact removed, restore temp, expired view, promoted interrupted convert), shutdown of a dead QEMU, cold boot from checkpoint, **and the review regressions**: a missing `cua` does not kill the supervisor, `"../.."` names are refused before any path is built, a live no-QMP QEMU makes the shutdown refuse and change nothing while marking its existing restore point stale, that produced marking makes Start boot the base image and clear it, a clean shutdown leaves no marking, `vmSpace` switches the cua target before capturing, and a shutdown survives a concurrent exec burst |
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
| D7 | docs claimed 117 assertions and "21/21" needles | gates now print their own totals (**325** assertions in the checkout, **324** in the flat image tree; **67** REA needles) and the docs quote those; the store-quota rule (real bytes; a sparse disk is never refused) is stated in README §Personal VM and here |

A residual from that round: the `stale` flag was read by `startFromCheckpoint` but
**written nowhere** (the first fix aborted the shutdown before touching the row),
so the refusal was unreachable. The abandoned branch now marks an existing
restore point `{stale: true, staleReason}` in the same registry write as
`lastShutdown.method: "abandoned"`, a clean shutdown always overwrites
`restoreFrom` wholesale, and the smoke test walks the whole path: refuse → marked
stale with a reason → Start boots the base image and says why → marking cleared.
`tools/check-cua-vm.mjs` gained needles for the producer (`row.restoreFrom?.kind
===`, `staleReason:`), so a reader can no longer exist without a writer.

**Superseded in 9.6.9.** This round made the Windows create refuse a 64 GB disk on
a 20 GB policy with an explicit sentence. That refusal charged the *virtual* size
of a sparse disk and was itself the regression reported by a user on a 15 GB
policy; 9.6.9 replaces it with a warning. The sentence it introduced is now
forbidden by `tools/check-cua-vm.mjs`.

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
| S10 | quota check-then-act: two creates could both pass `used + requested` | `reserveStoreBytes` holds a claim under `withLock('@store')` and releases it in `finally`; after 9.6.9 a create reserves **0** virtual bytes (the disk is sparse) and the claim protects the real transient writes (an ISO download), while the real-usage refusal is evaluated under the same lock |
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

> **Historical.** This W-table and §9.5 describe the **removed** container
> backend (dockurr/windows on a DinD engine). The current Windows computer is
> direct QEMU — see §9.6 — so no row below is a statement about today's code.

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
| W10 | docs (REPORT, BRANCH-NOTES, compose header) claimed the dead envs and 7100 | rewritten against the real mapping; both notes now live in `docs/` (`docs/REPORT.md`, `docs/BRANCH-NOTES.md`) |

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

### 9.6.2 Pre-verdict round 2 (F1–F3)

| # | Defect | Fix |
|---|---|---|
| F1 | the c467edb hunk swapped the checkpoint call sites: the Linux shutdown ran `checkpointDiskFile(…windowsPaths…)` (a path that does not exist for Linux → **no Linux checkpoint at all**) while `windowsShutdown` still called the Linux-only `checkpointSandbox` (→ no Windows checkpoint) | each shutdown is back on its own disk: `checkpointSandbox(name)` for Linux, `checkpointDiskFile(name, windowsPaths(STORE, name).disk)` for Windows. Two gate needles pin the pair, and the smoke now asserts BOTH: a Linux shutdown writes `checkpoints/<name>.qcow2` from the vmm disk and records `restoreFrom.kind === 'checkpoint'`, and a Windows shutdown does the same from `$STORE/windows/<name>/disk.qcow2`. `windowsStart` restores from the same file with the stale/torn gates unchanged |
| F2 | user-visible copy still described the container backend | plugin README (§kinds + env table: `DSH_CUA_WINDOWS_IMAGE`/`DSH_CUA_WINDOWS_NETWORK` replaced by the QEMU/OVMF/swtpm/virtio vars) and the panel (`Windows (direct QEMU)`, and the provisioning blurb now says SSH exec/put/get + noVNC live view) |
| F3 | the failed-create port release iterated a `Set` with `Object.values` (always `[]`), so claims leaked; a naive fix would have cleared other creates' claims | `portTriple` is declared before the `try` and the catch releases exactly those three ports |

### 9.6.3 Jury round (K1–K3, H1–H8, M1–M10, L1–L6)

| # | Defect | Fix |
|---|---|---|
| K1 | `usb-storage,bus=xhci.0` appeared **before** `-device qemu-xhci,id=xhci`; QEMU parses argv in order and dies "Bus 'xhci.0' not found" | the controller is emitted first; a **semantic** gate assertion (not a needle) pins the order, and a unit test asserts the indices |
| K2 | 4 of 5 pinned ISO URLs answer HTTP 400 (probed live: only Server 2025 gives 206) | the pinned list is now honest: exactly one URL, the rest `url: null` with the reason; `resolveWindowsIso()` refuses **before** any download, naming the version and both remediations (`windowsIso` URL or local file) |
| K3 | the VNC-banner fallback marked a half-installed Windows `ready` and set `installComplete` | during install `ready()` accepts **SSH only**; the VNC fallback applies to a running, post-install computer |
| H1 | the watcher timed from `createdAt`, so every Start of an old computer went `error` on the first tick | `startedAt` is written at each boot and used for the deadline |
| H2 | the watcher ran outside the lock and clobbered `powered-off`/`suspended` | each tick runs inside `withVmLock(name)` and returns unless the state is `installing`/`booting` |
| H3 | `vmWindowsStart` bypassed the lock; two Starts both booted (`-pidfile` collision, unkillable first QEMU) | the whole start runs under `withVmLock`; a live pid/QMP short-circuits to "already running" |
| H4 | no Windows producer of `restoreFrom.stale`/`mayBeTorn` | `markWindowsShutdownAbandoned()` mirrors the Linux semantics (stale + reason + mayBeTorn + lastShutdown, one write) |
| H5 | `restoreFrom` was deleted before the guest was known to run, and the returned state predated the boot | the start polls for `pidAlive` + QMP `running` before clearing `restoreFrom`, and returns the post-boot state (or a clear failure) |
| H6 | destroy unlinked the Windows tree with no liveness guard | the same `pidAlive` guard as the Linux branch → a `skipped` item (so the delete is correctly "partial"), never an unlink under a live guest |
| H7 | Start reused `meta.ports` unchecked | `reconcileWindowsPorts()` probes all three under `withLock('@ports')`, re-allocates what is taken, and rewrites the row before boot |
| H8 | the ISO download copied 5.5 GB instead of renaming, left the `.part` behind, never checked length | atomic `renameSync` in the same directory, stream destroyed on every exit, `.part` cleared and removed on failure, **short read aborts**, redirects bounded |
| M1 | `$STORE/iso` was invisible to accounting | in `ACCOUNTED_PATHS` (and a semantic gate assertion), reserved on download, and `cua_vm_gc` prunes unreferenced ISOs past the retention policy |
| M2 | `Get-Command python` matched the WindowsApps alias stub | `Get-RealPython` rejects anything under `\WindowsApps\` and fails loudly if no real interpreter exists |
| M3 | provisioning ran twice (SYSTEM + first logon) | the script is idempotent through `C:\cua-provision.json` (completed stages skipped; `-Force` re-runs), and the dead `-Mode` parameter is gone |
| M4 | the 5 s MCP beat could double-connect (45 s connect) | an in-flight promise guards the attach; the beat returns it instead of starting another |
| M5 | Windows `put`/`get` paths went into `scp` unvalidated, and `scp` had no timeout | `assertWindowsGuestPath()` requires an absolute drive path and refuses quotes/`&|<>^`; scp has a timeout + kill (300 s, `DSH_CUA_WIN_SCP_TIMEOUT_MS`) |
| M6 | resume never rebuilt the live view; a new relay overwrote `LIVE_VIEWS` without killing the old websockify | resume calls `ensureWindowsConsoleRelay`; `stopLiveView` is called for an existing child before spawning; `portClose` stops it |
| M7 | `region` was silently dropped on Windows | implemented with ImageMagick (same crop math as Linux) and an explicit "crop unavailable, this is the full frame" message when convert is missing |
| M8 | docs claimed virgl but the argv used a non-GL device with `-display none` | `virtio-gpu-gl-pci` + `egl-headless,rendernode=/dev/dri/renderD128` when the build advertises it, plain `virtio-gpu-pci` otherwise; the WARP/no-acceleration note stands either way |
| M9 | the OEM payload was a **read-write** vvfat share | `fat:ro:` (nothing in the guest writes it) |
| M10 | user-visible container-era strings (`docker pause`, 8006, "container", engine reachability) | swept from the panel, the tool descriptions, the view refusal and the docs; the doctor now prints the real host capabilities |
| L1 | FORBIDDEN matched case-sensitively (`DinD` slipped through) | the haystack is lower-cased |
| L2 | `backend` was `windows` after migration and `qemu` after create | one canonical value: `qemu` for Windows (migration included) |
| L5 | the docs claimed committed tests that lived outside the repo | the suite moved to `tests/{supervisor-smoke,modules-unit,qmp-shutdown}.mjs` with repo-relative paths |

### 9.6.4 Re-jury round (X1–X9, Y1)

| # | Defect | Fix |
|---|---|---|
| X1 | `ensureWindowsConsoleRelay` killed the websockify child **before** looking at the relay row, so the second call (Start end, watcher tick, `view`, `vmWindowsStatus`) left a relay pointing at a dead port — a permanent 502 | reuse-first: a live child + an existing row is returned as-is; only a dead child or a missing row rebuilds, and a genuine rebuild still kills the old child |
| X2 | `handlers.gui` accepted `region`/`scale` but the Windows branch dropped them, so the M7 crop was unreachable | both are forwarded to `windowsGui` |
| X3 | the ISO prune ignored `shotsKeepDays=0` ("keep for ever") | the sweep is inside `if (config.shotsKeepDays > 0)` |
| X4 | the shared virtio-win ISO (referenced by no row) and the pinned fallback ISO were pruned | an always-keep allowlist: `$STORE/iso/virtio-win.iso`, `DSH_CUA_WINDOWS_VIRTIO_ISO`, and every pinned source's filename |
| X5 | `reconcileWindowsPorts` asked only the OS about a port, so it could hand out one that another row or an in-flight create reserves | the reserved set is the union of `CLAIMED_WINDOWS_PORTS` and every other row's ports |
| X6 | the ISO download wrote ~5.5 GB with no reservation | `reserveStoreBytes` around the download (skipped when the ISO is already cached, since it is already counted), released in `finally` |
| X7 | resume unpaused but never rebuilt the preview that suspend closed | `resumeVmLocked` calls `ensureWindowsConsoleRelay` before answering |
| X8 | `vmWindowsStatus` measured elapsed time from `createdAt` | per-attempt `startedAt`, falling back to `createdAt` for legacy rows |
| X9 | the migration header still claimed `backend: 'windows'` is kept | the comment now states the canonical `qemu` normalisation |
| Y1 | the virgl branch was unreachable: the install spec omitted `virgl` and the row had no field, so the post-install boot always passed `false` | the flag is computed once at create (`gpu` **and** `systemQemuSupportsVirgl()` **and** a render node), stored on the row, and reused; the docs now scope each branch |

### 9.6.5 Final-acceptance round (Z1–Z4)

| # | Defect | Fix |
|---|---|---|
| Z1 | `reconcileWindowsPorts` compared `otherName === meta.name`, but a row carries **no `name` field** — so the subject's own qmp/ssh/vnc landed in `reserved` and every cold start re-allocated the whole triple | the subject name is passed in (`reconcileWindowsPorts(name, meta)`), excluded from the reserved set, and its own ports are subtracted; the smoke asserts a cold start reports `portsChanged: false` and keeps `46996/47995/5994` |
| Z2 | create-time claims were released only on error and on delete, never after the row was written — the comment says claims are for "rows not yet written", so they leaked | the claim triple is released in the same flow as the row write; a second start proves nothing lingers (`portsChanged: false`) |
| Z3 | the always-keep allowlist built names with a raw `basename` while the download writes them through `isoFileName` (sanitise + digest) | the allowlist goes through `isoTargetPath`, so both sides agree by construction |
| Z4 | with no websockify no child ever exists in `LIVE_VIEWS`, so every `view`/status tick rebuilt the relay instead of reusing it | a raw relay row that still targets this computer's VNC port **and** is listening is treated as the view (no kill, no rebuild) |

### 9.6.6 CI build failure: upstream bundler drift (post-merge, not ours)

The pushed branch failed GitHub Actions run 43723421276 at `Dockerfile:394`:

```
[plugins-page] ERROR: anchors moved in /opt/dsh-src/packages/client/ui-plugin-manager/lib/client.js
(slot declaration seen 0x, render site: 0.2.1-alpha.2+ 0x, <= 0.2.1-alpha.1 0x; expected 1 each)
```

**Ownership: upstream drift, not this branch.** `git diff 1986ed2..HEAD` over
`tools/patch-plugin-manager-page.mjs`, `tools/patch-sidebar-footer.mjs`,
`tools/probe-anchors.mjs` and the Dockerfile's patch steps is **empty** — the
last change to the patcher predates the branch. Main fails the same way.

**Cause.** The CI `github-tag` channel resolves the newest `dsh-v*` tag
(`dsh-v0.2.2-rc.3` at the time of the run) and that release started publishing a
**minified** `lib/client.js`:

| | before (≤ 0.2.2-rc.1) | rc.2+ |
|---|---|---|
| slot declaration | `"plugins.item": {` newline `kind: "list",` newline `scope: "root"` newline `},` | `"plugins.item":{kind:`list`,scope:`root`},` |
| render site | `renderGroup("basic", t("basicTitle"), basicCards)` | `renderGroup(`basic`,t(`basicTitle`),basicCards)` |

Every anchor was a literal with double quotes and newlines, so it matched 0 times
— and the patcher correctly refused to build.

**Re-anchored (shape, not spelling):**

* `tools/patch-plugin-manager-page.mjs` — the slot declaration is a regex over
  the shape with either quote style and any whitespace; the render site is a
  regex variant list (`basic`, `official`) instead of two literals; the marker
  key keeps the file's quoting. A third shape still fails the build.
* `tools/patch-sidebar-footer.mjs` — same treatment for `sidebar.footer.action`
  and `renderSlot(\`sidebar.settings\`,{wide})`, plus `classNames()`: the bundle no
  longer ships a literal CSS-modules map, so the four class names are
  reconstructed from the stylesheet's own hash prefix (`.hHd-Xa_footArea{…}`),
  with the literal map kept as the old-shape path. The stylesheet literal scan
  now accepts `'` and `` ` `` as well as `"`.
* `tools/probe-anchors.mjs` — the same anchors (it is the ten-second advisory
  probe), and `--from-file` now also probes `--sidebar-from-file` instead of
  silently skipping the sidebar offline.
* A splice-order bug found while testing: the plugin-manager patch replaced the
  declaration (shifting every later index) *before* splicing the render site,
  which dropped `renderSlot(...)` inside the slot object. The render splice now
  happens first, by index, and the declaration is inserted by unique text after.

**New offline guard.** `tools/check-anchors.mjs` (+ `tools/fixtures/*.min.js`,
shaped like the real minified bundles) replays both directions for both patches —
applies cleanly, marker present, output parses, idempotent, and **still exits 1
when an anchor is renamed**. It runs in `ci-gates` as a hard gate and as a
`RUN` step in the Dockerfile, so this class of drift is caught offline in a
second instead of at build time.

**Verified against the real artifacts** (`npm pack` of 0.2.2-rc.3, the exact
bundles the image patches): both patchers exit 0 and their output parses; both
still exit 1 on a renamed anchor; both old-shape fixtures (`pmold2`, `sbold`)
also patch. `probe-anchors --from-file … --sidebar-from-file …` reports every
anchor resolving.

**Second CI failure — the guard itself, in the image layout.** Run 43727653717
died at the NEW step (`Dockerfile:383 RUN node /opt/seek-harness/tools/check-anchors.mjs`)
with "2 anchor self-test(s) failed", while the same gate exited 0 locally. Cause:
the guard ran children with a path **relative to the caller's cwd**
(`run(['tools/probe-anchors.mjs', …])`). In a checkout the cwd is the repo root,
so it resolved; in the image the build runs as `node /opt/seek-harness/tools/check-anchors.mjs`
from `/`, so it looked for `/tools/probe-anchors.mjs` and both "probe-anchors
agrees offline" assertions failed — exactly two. Fix: every path is resolved from
`import.meta.url` (the guard's own directory), children run with `cwd: HERE`, and
a missing sibling now prints a packaging message instead of MODULE_NOT_FOUND.
Re-verified in three layouts — repo (invoked from the repo **and** from `/`), the
flat `/opt/seek-harness/tools/` layout from `/`, and the negative case in both
(a renamed fixture anchor gives exit 1 with 6 failures) — plus a simulation of the
full Dockerfile sequence (383 → 405 → 418) against the real 0.2.2-rc.3 bundles.

### 9.6.7 Change of policy: Windows floors are defaults, not refusals

The three Windows numbers were hard minimums: a create with `diskGb < 64`, RAM
`< 6` or CPU `< 2` was clamped or refused. They are now **defaults and
recommendations**:

| Request | Result |
|---|---|
| `diskGb` omitted | 64 GB |
| `diskGb: 8` | 8 GB, created, with `warnings[code: disk-below-floor]` |
| `memory: 2` | 2 GB, created, with `warnings[code: memory-below-floor]` |
| `cpu: 1` | 1 vCPU, created, with `warnings[code: cpu-below-floor]` |
| the quota | real bytes only: a virtual disk over the policy is created with `warnings[code: disk-over-policy]`; only a store whose real usage is already over the quota is refused (see 9.6.9) |

`warnings` is the one shape (`[{ code, message }]`) and it appears in the create
result, in the registry row (so the panel shows it after a reload) and in the
human-facing text. The warning says what will actually go wrong — a sub-52 GB
disk runs out of space during Windows Update and the install may fail.

Mechanically: `windowsCapacityWarnings({diskGb, memory, cpu})` in
`docker/cua-vm-windows-qemu.mjs` is pure and unit-testable; `normaliseSpec` fills
the **Linux** defaults, so the create path carries `diskGiven`/`memoryGiven`/
`cpuGiven` to tell "omitted" from "chosen". Linux behaviour, the REA 40 GB clamp
and the Windows REA/Android refusals are untouched.

Smoke: a below-floor create returns `ok:true`, the requested sizes
(`8 / 2 / 1`), all three warning codes and the disk warning text; an omitted
create returns `64 / 6 / 2` with `warnings: []`.

### 9.6.8 Windows 11 IoT Enterprise LTSC 2024 as a pinned source

Research (2026-11-15): the Microsoft Evaluation Center page
`https://www.microsoft.com/en-us/evalcenter/download-windows-11-iot-enterprise-ltsc-eval`
offers the x64 ISO behind `https://go.microsoft.com/fwlink/?linkid=2270353`.

| Probe | Result |
|---|---|
| `curl -IL` the fwlink | redirects to `software-static.download.prss.microsoft.com/dbazure/998969d5-…/26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_IOT_LTSC_EVAL_x64FRE_en-us.iso`, HTTP 200 |
| ranged `GET 0-1` on that URL | **HTTP 206**, `Content-Range: bytes 0-1/5060020224` (5.06 GB, ~4.71 GiB) |

Because it answers directly it is **pinned** (`windowsVersion: "11ltsc"`,
alias **`ltsc11`**), unlike 11/10/ltsc10/2022 (which return 400 and refuse with a
remediation). The vhdx/ARM64 media on the same page is a separate link and is not
pinned.

### 9.6.9 The create-time quota counts real bytes — a sparse disk is never refused

**Reported regression.** Creating a Windows computer on a store with a 15 GB
policy failed with:

> a 64 GB disk does not fit the VM store quota (15 GB). Raise Disk Size under
> Plugins → Personal VM (CUA) → Policy, or create the computer with a smaller
> disk.

while the store held a few hundred MB. Root cause: the create-time check called
`reserveStoreBytes(name, diskGb * 1024 ** 3)` (Windows) and
`reserveStoreBytes(name, effectiveDiskGb * 1024 ** 3)` (Linux), and
`refuseOverQuota` compares `used + requested > quota`. A qcow2 disk is created
**sparse** — `qemu-img create -f qcow2 disk 64G` writes metadata, and the guest
consumes bytes only as it writes — so the REQUESTED size was charged as if it
were consumption. On the shipped 20 GB policy (`diskQuotaGb: 20`) that refused
*every* Windows create, and it contradicted both the branch's own accounting
("the quota counts real bytes") and 9.6.7's warnings-not-refusals semantics.

**Fix (one rule, both platforms).**

* A create reserves **zero** bytes: `reserveStoreBytes(name, 0)` /
  `reserveStoreBytes(spec.name, 0)`. The call still runs under the store lock, so
  a store whose **real** usage is already over the policy is refused with the
  same message — which now names real usage:
  `VM store quota reached: 16.0 GB of real store data > 15 GB …`.
* A virtual disk bigger than the policy is **created** and carries
  `warnings[{ code: "disk-over-policy" }]`:
  `requested 64 GB exceeds the 15 GB store quota policy; the disk is sparse so
  creation proceeds, but the guest will hit the real disk ceiling and may fail
  to install — raised policy is recommended`.
  The warning is produced by one pure helper (`diskPolicyWarnings(diskGb,
  config)`), reaches the create result, the registry row and the tool text
  (Windows and Linux), and is gated.
* `reserveStoreBytes` stays for **transient writes whose real bytes are known**:
  the Windows ISO download still reserves `expectedBytes`, and the
  checkpoint-convert guards in the shutdown paths still call `refuseOverQuota`
  with the real disk delta. Those are unchanged.
* The Windows 64 GB default is untouched — it is the requested size; it is just
  no longer charged as real bytes. The REA 40 GB floor is unchanged; on a small
  policy it warns instead of refusing.

**Verified** (`tests/supervisor-smoke.mjs`, 112 assertions):

| Case | Result |
|---|---|
| quota 15, real usage low, Windows default 64 GB | created (`ok:true`, `diskGb:64`) with `disk-over-policy`, row keeps it |
| quota 1, Linux 40 GB REA disk | created with `disk-over-policy` |
| quota 45, two concurrent 50 GB Linux creates | both created, both warn (the virtual size no longer serialises creates) |
| 1.5 GB real file on a 1 GB quota | refused: `1.5 GB of real store data > 1 GB` (no "does not fit") |
| 16 GB real file on a 15 GB quota, Windows create | refused with the same real-bytes sentence; no row half-created |

The offending sentence is now a **forbidden** pattern in
`tools/check-cua-vm.mjs`, and new needles pin `diskPolicyWarnings`, the
`disk-over-policy` code, both `reserveStoreBytes(…, 0)` call sites and the
real-bytes refusal text. Gate totals: **325** assertions in the checkout
(**324** in the flat image tree, where the checkout-only assertion is reported
`n/a`), **67** REA needles, `ci-gates` **8 passed / 0 failed / 3 skipped**.

### 9.6.10 `/dev/kvm` mounted but not openable — two defects, one sentence

**Reported:** "Windows create fails with `the Windows backend needs /dev/kvm
(compose.emulator.yaml)`", on the latest branch image, with
`devices: [- /dev/kvm]` demonstrably in the user's compose and the node visible
inside the container, `group_add` listing only the render/video GIDs.

Two independent defects produced that one sentence:

1. **The probe was wrong for device nodes.** `windowsHostCaps()` asked
   `statSync('/dev/kvm').isFile()`. `/dev/kvm` is a **character device**
   (`crw-rw-rw-`), for which `isFile()` is `false` — measured on this host:
   `isFile('/dev/kvm') === false`, `isCharacterDevice() === true`, mode `0666`.
   So the capability was reported *absent* on a host where the device was
   present, readable and writable. `access(2)` was never consulted, so a DENIED
   node and a MISSING node were indistinguishable.
2. **Even with a correct presence probe, access is separate.** The container runs
   as **uid 1000** (`USER node`); the host's node is normally `root:kvm 0660`,
   and Docker passes it through with that gid. `open(O_RDWR)` then fails
   `EACCES`, and "add `devices: - /dev/kvm`" is exactly the wrong advice: the
   device is already there. Note the image's `USER node` (not `node:node`) keeps
   the image's supplementary groups (`104(kvm)`), which is the mechanism that can
   rescue this without a compose change — but only if the host's gid happens to
   match, which is luck, not a contract.

**The split.** The check and the message now come from one module,
`docker/cua-vm-kvm.mjs`, used by both backends:

| State | Detected by | Message |
|---|---|---|
| `missing` | `stat()` → ENOENT | keeps `add devices: - /dev/kvm (compose.emulator.yaml)`, plus `--force-recreate` and the host-side check |
| `denied` | `stat()` OK, `access(R_OK\|W_OK)` → EACCES/EPERM | names the REAL problem: `mode 0660 owner 0:107`, `uid 1000, gid 1000, supplementary groups 44,105,1000`, the permission class it was refused by, then `stat -c %g /dev/kvm` → `KVM_GID` → `group_add` → `--force-recreate`, and the udev `MODE=0666` alternative |
| `not-device` | `stat()` OK, not a character device | "a regular file at that path means a bind mount / `devices:` entry is wrong" |

The gid is quoted from the device itself (`st_gid`), so the message always
carries the number the user must put in `.env`. Both paths also gained the
preflight: `windowsCreateManaged` refuses **before** the 5.5 GB ISO download and
the qcow2, and `boot()` refuses before swtpm is spawned.

**Linux path.** `cua sb create` is not preflighted here on purpose (that would
change behaviour). Instead a failed create now appends the same diagnosis when
the supervisor can see the device: `linuxKvmFailureHint()` returns `''` when the
device is openable, so a healthy host sees byte-identical output, and a denied
device stops relaying cua's opaque "qemu exited" alone.

**Doctor.** `cua_vm_doctor` reported `kvmUsable` from the *string*
`"666 (writable)"` (`startsWith('6')`), which is true for a device this uid
cannot open. It now reports the probe's own facts: `kvmState`, `kvmMode`,
`kvmOwner`, `kvmGroups`, `kvmReason`, so "present but DENIED" can never read as
"not usable".

**Docs.** README gains `### the Windows backend needs /dev/kvm — but /dev/kvm is
mounted` (the ENOENT/EACCES split, the 5-step gid fix, the udev alternative, the
verification command), the overview says mounting ≠ access, `.env.example` gains
commented `KVM_GID` with `stat -c %g /dev/kvm` instructions, and the plugin
README states the gid requirement for both kinds.

**Verification (run).** `node tools/check-cua-vm.mjs` **382** assertions in the
checkout / **381** in the flat tree (the checkout-only L5 is reported `n/a`);
`node tools/check-cua-rea.mjs` **67**; `node tools/ci-gates.mjs` **9 passed / 1
failed / 1 skipped** — the failure is `check-office.mjs`
(`@deepseek-ai/dsh-skill-office is not installed`), **pre-existing and unrelated**
(reproduced on the stashed tree); `tests/{supervisor-smoke,modules-unit,qmp-shutdown}.mjs`
all PASS; `node --check` clean on every changed `.mjs`. `tests/modules-unit.mjs` exercises both branches with stubbed
`stat`/`access` (no device needed): a 0660 root:107 node refused for uid 1000 →
`EACCES` + `KVM_GID` + `group_add`; the same node granted via supplementary group
`107` → `ok`; ENOENT → the `devices:` message and **no** GID text; a regular file
→ `not-device`. A host with `/dev/kvm` additionally runs the live probe. Gate
needles pin the split texts and `KVM_GID`; `tools/check-cua-vm.mjs` asserts the
new module is in both the runtime path and the flat gate tree.

**NOT RUN, with the reason.** The *denied* branch was not reproduced against a
real device: this host's `/dev/kvm` is `0666` and openable by uid 1000
(`state: ok`), and changing the device's mode needs root on the host. It is
covered exactly — one 0660 `root:107` node with uid 1000 / groups 44,105 →
EACCES + `KVM_GID` + `group_add`; the same node with gid 107 in the group list →
`ok` — with stubbed `stat`/`access`, plus a LIVE `not-device` probe against a real
regular file and a LIVE `missing` create through the real supervisor
(`DSH_CUA_KVM_DEVICE=/dev/dsh-no-such-kvm`). A live Windows install (ISO,
OVMF/swtpm, OOBE) stays NOT RUN as before.

### 9.6.11 Two live-verified boot defects (N1, N2) + the test blind spot (N3)

Both of these were reproduced on the real container with QEMU 10.0.13 — they are
not review findings. A Windows create on this branch failed in two independent
ways, in this order: the 0 ms boot window declared the QEMU dead in ~1 ms, and
once that was fixed the argv itself was rejected by QEMU in ~118 ms.

| # | Defect | Fix |
|---|---|---|
| N1 | **The boot window was 0 ms on every real host.** `qemuBootWindowMs()` did `Number(process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS ?? '')`: an UNSET variable becomes `Number('') === 0`, `0 >= 0` passed the guard, and the `return 15000` fallback was **unreachable**. `waitForQemuBoot` therefore polled once against an already-expired deadline and reported an initializing QEMU as *"died during init (none): no stderr output"* while it was ~1 ms old. `windowsEarlyDeathWindowMs()` (`DSH_CUA_WINDOWS_EARLY_CHECK_MS`, fallback 5000) had the identical `Number(env ?? '')` shape, so the install watchdog's first tick also fired with no wait | both read the **raw** string first and parse only when `raw !== undefined && raw !== ''`; the 15000 / 5000 fallbacks are now reachable. `waitForQemuBoot` additionally clamps the **effective** window to one poll interval (`pollMs`, ≥10 ms, documented in the function): an explicitly-set `0` is still honored as *the shortest window there is*, but the loop always observes one real interval before it may declare a timeout — the deadline is no longer satisfiable before a single observation |
| N2 | **The OEM USB stick could not be attached.** `-drive file=fat:ro:…,format=raw,if=none,id=oem0` + `-device usb-storage,drive=oem0,bus=xhci.0` is a read-only BlockBackend behind a device that needs a **writable** node: QEMU 10.0.13 answered `-device usb-storage,drive=oem0,bus=xhci.0: Block node is read-only` and exited at ~118 ms (pidfile never written, `serial.log` 0 bytes). Adding `read-only=on` to the `-drive` makes the pair boot (verified: pidfile written, serial log non-empty). `fat:rw:` is **not** an option here: this image's rootfs is read-only and vvfat in rw mode wants a temp dir under `/var/tmp` (`EROFS`) | the OEM drive is `file=fat:ro:${p.oemDir},format=raw,read-only=on,if=none,id=oem0`; the `usb-storage` device is unchanged. `read-only=on` marks the **medium** read-only (a write-protected stick, which is what an unattended install medium is) rather than the node |
| N3 | **The suite could not see either one.** `tests/windows-boot.mjs:94` sets `DSH_CUA_WINDOWS_BOOT_SETTLE_MS = '1500'` and `tests/supervisor-smoke.mjs:242` sets both variables — a test that supplies a number can never observe the **default**, so the unset→0 defect was invisible to every green run | `tests/modules-unit.mjs` now **deletes** both variables and asserts `qemuBootWindowMs() === 15000` and the 5000 ms early-death default, then `''` → 15000, explicit `'0'` → 0 (honored), `'1500'` → 1500, unparsable → 15000, `'999999'` → the 120000 cap, plus the `windowMs: 0` poll-interval floor. `tests/supervisor-smoke.mjs` adds a case that runs the **real supervisor with BOTH variables unset** and a stub QEMU that writes its pidfile only after ~100 ms — the exact live shape: it must create successfully and log no "died during init". `tests/windows-boot.mjs` adds the same late-pidfile boot through `backend.boot()` |

Gate needles (added, none deleted): the new OEM argv (`…,read-only=on,if=none,id=oem0`)
in `tools/check-cua-vm.mjs`'s M9 class, the split `fat:ro:`/`read-only=on`
assertion and the "no `fat:rw:`" check in `tests/modules-unit.mjs`, the
`raw !== undefined && raw !== ''` shape of both window readers, and a new **N3**
semantic assertion in `tools/check-cua-vm.mjs` that fails unless the suite really
DELETES the window env and runs a supervisor with both unset. The `usb-storage` device needle is
untouched, so the M9 class keeps both halves.

**Verified live (this container, QEMU 10.0.13, `/dev/kvm` `0666` and openable).**

* `qemuBootWindowMs()`: unset → **15000**, `''` → **15000**, `'0'` → **0**
  (explicit), `'1500'` → 1500, `'nonsense'` → 15000, `'999999'` → 120000;
  `windowsEarlyDeathWindowMs()`: unset → **5000**.
* **Boot replay against `/usr/bin/qemu-system-x86_64`** with a copied store dir
  under `/tmp` (`disk.qcow2` + `oem/`), `gpu: false`, `installPending: false`,
  both env vars unset: `BOOT OK pid=4780 in 177 ms`, `qemu.pid` written and
  readable (`4780`), `serial.log` present, `qemu-stderr.log` **empty** — no
  read-only error. The OEM error was also reproduced and fixed directly:
  `qemu-system-x86_64: -device usb-storage,drive=oem0,bus=xhci.0: Block node is
  read-only` without `read-only=on`; with it, the same argv boots and only stops
  when killed.
* `node tools/check-cua-vm.mjs` → **475** assertions (checkout) / **473** (flat
  tree, L5 + N3 `n/a`), all pass. `node tools/check-cua-rea.mjs` → **67**. `node
  tools/ci-gates.mjs` → **9 passed / 1 failed / 1 skipped**; the failure is
  `check-office.mjs` (`@deepseek-ai/dsh-skill-office is not installed`),
  **pre-existing** and reproduced on the stashed tree.
* `tests/{supervisor-smoke,modules-unit,windows-boot,qmp-shutdown}.mjs` all
  **PASS**, including the three new F3 cases. `node --check` clean on every
  changed file.

**NOT RUN, with the reason.** A full Windows install (ISO download, OVMF/swtpm,
OOBE) is still not attempted here; the replay boots real QEMU with a real OVMF
`NVRAM` and a real vvfat OEM directory, but with an empty disk (no install
medium), so what it proves is that QEMU **accepts the argv and initializes** —
which is exactly the two defects above.

### 9.6.12 Live-verified Windows create failure: a read-only node on `ide-hd` (F1–F4)

Reported against the image built from the previous round: a Windows create failed
with

```
qemu-system-x86_64: -device ide-hd,drive=setup0,bus=ide.2: Block node is read-only
```

and the failure surfaced as a *"swtpm did not create its socket"* cascade: QEMU
exits during option parsing, before device realize, so the TPM chardev socket the
supervisor waits for is never created. The previous round had attached the answer
disk as `-drive file=setup.img,format=raw,if=none,id=setup0,readonly=on` +
`-device ide-hd,drive=setup0,bus=ide.2`. QEMU 10 accepts a read-only block node
behind a **CD-ROM** or **usb-storage** device, but **not** behind an IDE hard
disk; `readonly=on` was carried over from the old OEM stick argv (N2) where the
device class was different. dockur/windows models its SETUP overlay as a
writable hard disk because Setup may write logs/scratch to the medium.

| # | Defect / work item | Fix |
|---|---|---|
| F1 | `setup.img` was attached read-only behind `ide-hd`; QEMU 10 refuses it during option parsing and every create dies before swtpm's socket | the drive is now `file=${p.setupImg},format=raw,if=none,id=setup0` (no `readonly=on`) + the unchanged `ide-hd,drive=setup0,bus=ide.2`. The in-code comment states why: QEMU rejects a read-only node on an ide-hd, and the dockur model is a writable SETUP overlay. `buildSetupImage()` now pins the image to mode **0600** for the runtime uid, so QEMU can open the node read-write. **Rebuild policy decided: rebuild on EVERY create** (fresh answer file). There is deliberately no "skip if it already exists" branch: the medium is writable, Setup may legitimately leave bytes in it, and a re-create of the same computer must start from a byte-exact, mdir/mtype-verified image, never a possibly-modified one. This is documented in `buildSetupImage()`'s doc comment and asserted by a read-back test that first scribbles a guest-like write into the image, then rebuilds and verifies `Autounattend.xml` is listed again |
| F2 | The same class could hide on any `ide-hd` | the argv builder is audited: the only remaining `readonly=on` block nodes are the OVMF **pflash** code drive and the two **cdrom** drives (`media=cdrom`), which QEMU allows. `tests/modules-unit.mjs` now maps every `ide-hd` device to its `drive=` id and fails unless the matching `-drive` line is free of `read-only`/`readonly` |
| F3 | the M9-class gate needle pinned the OLD read-only OEM argv, so a reintroduced `readonly=on` on setup0 would still have passed | retargeted, never deleted: the needle is now `file=${p.setupImg},format=raw,if=none,id=setup0` (the writable line) and the `ide-hd,drive=setup0,bus=ide.2` needle is untouched. The existing `no usb-storage` / `no file=fat:ro:` needles stay. A new **semantic** K1 assertion fails on any `read-?only` appearing before or after `id=setup0`, on `drive=setup0` with a read-only marker, or on the old `id=oem0` stick reappearing — a needle list cannot express "this line must NOT contain X" |
| F4 | tests still asserted the read-only shape | `tests/modules-unit.mjs`: the argv assertion now demands `id=setup0` **without** `readonly=on`, plus F2's mapping check; the real-mtools block adds a read-back assertion that `setup.img` exists with mode `0600`, owner-write bit set and owner = the runtime uid, and that a second `buildSetupImage()` rebuilds it after a guest-style scribble. `tests/supervisor-smoke.mjs`: the create asserts `setup.img` exists **before boot**, is owner-writable and owned by this uid, and that the install argv's setup drive carries no `read-only` marker in the same token sequence |

**Verified live in this container (QEMU 10.0.13, `/dev/kvm` `0666` and openable, `mtools` present).**

Replay script: a real `/tmp` store (`writeOemPayload()` + `buildSetupImage()` +
`qemu-img create` qcow2 disk + OVMF vars qcow2), a real `swtpm socket` on the
computer's TPM socket, a 1 MiB dummy install ISO, `installPending: true` so the
setup disk is attached, `gpu: false` (plain VGA, no EGL/virgl), `-machine
q35,accel=kvm` (KVM was usable, no `accel=tcg` fallback needed), 2.5 s window:

* **old argv** (`readonly=on` re-inserted): exits 1 immediately with the exact
  reported string `qemu-system-x86_64: -device ide-hd,drive=setup0,bus=ide.2:
  Block node is read-only`; `qemu.pid` **absent**, `serial.log` **0 bytes**.
  This is the user's failure reproduced byte-for-byte.
* **fixed argv**: process still **UP** after the 2.5 s window, `qemu.pid`
  written (`1433`, readable), `serial.log` **1336 bytes** (real OVMF output),
  `qemu-stderr.log` **empty** — device realize passed and the VM initialized.

The replay store was removed afterwards; the dummy ISO is not a bootable install
medium, so this proves argv acceptance/initialization, not a completed setup —
the same boundary as the N1/N2 replay.

* `node tools/check-cua-vm.mjs` → **516** assertions (checkout, up from 475);
  flat cua-check replay from `cwd=/` → **514**, with L5 + N3 `n/a` as designed.
* `node tools/check-cua-rea.mjs` → **67**.
* `node tools/ci-gates.mjs` → **9 passed / 1 failed / 1 skipped**; the failure is
  `check-office.mjs` (`@deepseek-ai/dsh-skill-office is not installed`), the
  pre-existing environment failure, unchanged by this round.
* `tests/{supervisor-smoke,modules-unit,windows-boot,qmp-shutdown}.mjs` → all
  **PASS**.
* `node --check` clean on every changed file.

**NOT RUN, with the reason.** A full Windows install (ISO download, OVMF/swtpm,
OOBE) is still not attempted here. This host reproduces the argv rejection and
proves the fixed argv initializes, which is the defect class reported.

### 9.6.13 The next live-verified blocker: a PARTITIONLESS answer disk, and a missing `<InstallFrom>` (F1–F4)

> **SUPERSEDED IN PART by §9.6.14.** The partition table and the `<InstallFrom>` were both
> necessary and are still in place — but they were not sufficient: the medium was also a
> **fixed disk**, and Setup never scans a fixed-disk root for `Autounattend.xml`. The attach
> class (`ide.2`) described below is history; the delivery is now removable USB mass storage.

Reproduced on the user's container with the previous round's image. WinPE reached
the **interactive language screen** on every create, i.e. the answer file was
never read. What blockstats showed:

* `setup0` had been written to **only by the firmware** (114 KB of EDK2 `NvVars`)
  and `disk0` had been touched for 512 B once — **zero install activity**;
* `setup.img` was attached (`ide.2`, writable, in the live argv), well-formed
  FAT32, with a root-level `Autounattend.xml` that was byte-identical, correct
  casing, and schema-valid (DiskID 0, InstallTo partition 3, Extend,
  RunSynchronous bypasses, AutoLogon, FirstLogonCommands).

The structural bug: `setup.img` was a **partitionless FAT32 superfloppy** — VBR at
LBA 0, no MBR and no GPT. (The bytes mtools leaves at 0x1BE in its VBR template
look like a partition entry and are not one.) EDK2 mounts a raw FAT volume from
any block device, which is why the firmware happily wrote its NvVars; **Windows
enumerates fixed disks through their partition table**, so a partitionless fixed
disk is never given a drive letter and WinPE's drive-root search had nothing to
scan. The medium was visible, correct, and unmountable — which is exactly why it
read as "the answer file is ignored".

| # | Defect / work item | Fix |
|---|---|---|
| F1 | the answer medium was a partitionless FAT32 superfloppy: firmware-mountable, never Windows-mountable | `buildSetupImage()` now writes an **MBR** (16-byte entry at `0x1BE`, active flag, type **0x0C** FAT32-LBA, CHS `0xFE/0xFF/0xFF`, LBA start **2048**, length read back from the BPB, signature `0x55AA` at 510) and formats/copies through mtools' partition syntax `-i <img>@@<byte-offset>`, i.e. `@@1048576`, with `-H 2048` so the BPB's hidden-sectors field matches the table. `verifySetupImage()` reads the MBR back first, then lists and byte-compares **through the partition**. The MBR stub is generated in Node (`setupMbrSector()`) because mtools cannot write one — so **no new package** was added to the Dockerfile: no `sfdisk`/`parted` dependency, no util-linux coupling, and the 512 bytes are assertable in a unit test |
| F2 | `<ImageInstall><OSImage>` had **no `<InstallFrom>`**, so even a mounted answer file would have stopped at "Select the operating system you want to install" (the very next page after the language page) | the template carries `{{IMAGE_INSTALL}}` inside `<OSImage>`, **before** `<InstallTo>` (schema order); `writeOemPayload()` resolves it via `resolveWindowsImageSelection()` and refuses to write a file with a surviving placeholder. The selector is resolved **at create time** and validated before the 5 GB download. Which image: `11ltsc` → `/IMAGE/NAME` = `Windows 11 IoT Enterprise LTSC 2024 Evaluation` **read from the pinned ISO's own WIM XML** (single image, `INDEX 1`; note the media's NAME carries the year and "Evaluation", so the download page's label would NOT have matched); `2025` → `/IMAGE/INDEX 2` (Standard Evaluation, Desktop Experience — image 1 is Server Core, no desktop); operator ISO → `/IMAGE/INDEX 1`. Overrides: `windowsImageIndex` (1–999) and `windowsImageName` (wins) |
| F3 | the source comment claimed this "mirrors dockur/windows", which is what made the superfloppy look safe | corrected in `buildSetupImage()`'s doc comment, the argv comment, `README.md` and this report: dockur's overlay is **also** FAT32 but it is a superfloppy, and that works *there* because of how their flow hands the medium to QEMU. The guarantee here is not "same as dockur"; it is "a disk Windows will enumerate", proven by the MBR assertions |
| F4 | nothing asserted the medium's structure, and nothing asserted the edition | `tests/modules-unit.mjs`: the real-mtools build asserts the `0x55AA` signature at 510, the entry at `0x1BE` (type `0x0C`, LBA 2048, non-zero length that fits the image), the BPB hidden-sectors field = 2048, no VBR magic left at byte 0, `mdir -i img@@1048576` listing `Autounattend.xml`, the MBR read-back, and that `verifySetupImage()` **refuses** a partitionless image. F2 asserts the resolved selector per version, the explicit overrides, the single `<MetaData>`, the schema order, and that `writeOemPayload(windowsVersion: '11ltsc')` stages `/IMAGE/NAME`. `tests/supervisor-smoke.mjs`: the mtools stubs now **require** the `@@<offset>` suffix (a regression to whole-file addressing fails them) and the create asserts the medium is partitioned **before boot** and that the staged XML carries `<InstallFrom>` with no placeholder left. `tools/check-cua-vm.mjs`: needle counts retargeted to the partition-offset calls, plus two semantic checks (F1: every `-i` read of setup.img goes through the volume and the MBR is written *and* read back; F2: the template's `<InstallFrom>` sits inside `<OSImage>` before `<InstallTo>`) |

**Verified live in this container (mtools 4.0.48, `file` from libmagic, the real pinned 11ltsc ISO on disk).**

* The 11ltsc edition name was **not guessed**: the pinned evaluation ISO
  `26100.1742…CLIENT_IOT_LTSC_EVAL_x64FRE_en-us.iso` (4.8 GB, present at
  `/cua-vm/iso/`) was read directly. No 7z/wiminfo/pycdlib exists here, so the
  WIM resource header was parsed by hand and the XML resource decoded:
  `<IMAGE INDEX="1"> … <NAME>Windows 11 IoT Enterprise LTSC 2024 Evaluation</NAME>
  … <EDITIONID>IoTEnterpriseSEval</EDITIONID>` — one image, so `INDEX 1` and that
  NAME agree, and the NAME is what the answer file carries.
* A real `writeOemPayload()` + `buildSetupImage()` run in `/tmp/verify-setup`:
  `file setup.img` →
  `DOS/MBR boot sector; partition 1 : ID=0xc, active, start-CHS (0x3ff,254,63), end-CHS (0x3ff,254,63), startsector 2048, 129024 sectors`;
  `mdir -i setup.img@@1048576 ::/` lists 6 entries (`Autounattend.xml`,
  `setupcomplete.cmd`, `cua-firstboot.ps1`, `Unattend.vbs`, `startup.nsh`,
  `$OEM$`); BPB `hidden=2048 total32=129024 sectors/cluster=1`;
  `mtype -i setup.img@@1048576 ::/Autounattend.xml` is SHA-256-identical to the
  staged file.
* `node tools/check-cua-vm.mjs` → **544** assertions (checkout); flat-layout
  replay from `cwd=/` (a writable copy of the image's flat tree, because
  `/opt/seek-harness` is a read-only image layer here) → **542**, with L5 + N3
  `n/a` as designed.
* `node tools/check-cua-rea.mjs` → **67**.
* `node tools/ci-gates.mjs` → **9 passed / 1 failed / 1 skipped**; the failure is
  `check-office.mjs` (`@deepseek-ai/dsh-skill-office is not installed`), the
  pre-existing environment failure, unchanged by this round.
* `tests/{supervisor-smoke,modules-unit,windows-boot,qmp-shutdown}.mjs` → all
  **PASS**.
* `node --check` clean on every changed file.

**NOT RUN, with the reason.** A full Windows install is still not attempted here:
`/dev/kvm` VMs do not boot in this sandbox, there is no OVMF/swtpm guest budget,
and the ISO install is tens of minutes. What IS proven is the defect class: the
medium is now a disk with a partition table (asserted at the byte level and by
`file`), and the answer file names its edition in schema order. The `2025` index
(2) is the one reasoned rather than read value — the media is not on this host —
and is documented as such in `WINDOWS_IMAGE_SELECTIONS` (with the
`windowsImageIndex` override as the escape hatch).

### 9.6.14 The live-verified answer-file delivery bug: WinPE mounted the medium and still never read it (F1–F4)

**The finding, from inside the guest.** Everything upstream of Setup was correct:

* WinPE mounted `setup.img` as **`C:`** — a healthy FAT32 partition on a fixed disk;
* `dir C:\` listed `Autounattend.xml`;
* `more C:\Autounattend.xml` was byte-verified (the `<InstallFrom>` `/IMAGE/NAME`
  block was there);
* **no Panther parse errors** anywhere in the Setup logs — Setup did not reject
  the file, it never opened it;
* and Setup **still** showed its interactive language page.

Screenshots of that forensic round (guest-side captures, referenced by path, not
committed): `$STORE/windows/<name>/shots/winpe-c-root-dir.png`,
`.../winpe-c-root-autounattend-more.png`, `.../setup-language-page.png`; the
guest's own `setupact.log`/`setuperr.log` tails were copied out under
`$STORE/windows/<name>/forensics/`.

**The cause is the DELIVERY CLASS, not the file.** WinPE/Setup searches for
`Autounattend.xml` on **removable-media roots** (and on the boot media), plus
`%WINDIR%\Panther\` / `\$WINNT$.~BT\` and the `HKLM\SYSTEM\Setup\UnattendFile`
registry override. A **fixed-disk root is not scanned at all**. `setup.img` was
attached `ide-hd` (a fixed disk): mounted, listable, correct — and invisible to
the search. The earlier `fat:ro:` vvfat + usb-storage attempt failed for an
unrelated reason (read-only block node) and was abandoned; the medium stayed a
fixed disk, so the *real* failure survived that "fix".

**Root cause #2, in the same round: the cdboot key presses were on the wrong
clock.** The fixed schedule (1.5 / 3.5 / 5.5 s after **spawn**) fired while OVMF
was still enumerating devices — i.e. before `cdboot.efi` had printed "Press any
key to boot from CD or DVD" — so the first boot never dismissed the prompt at
all. A wall-clock delay measured from spawn cannot be the anchor for a window
that opens when the *firmware* reaches the CD.

| # | Defect / work item | Fix |
|---|---|---|
| F1 | the answer medium was a **fixed disk** (`ide-hd`), and Setup never scans a fixed-disk root | the partitioned FAT32 image is unchanged; its delivery is now **`usb-storage,drive=setup0,removable=on,bus=xhci.0`** (device declared after `-device qemu-xhci,id=xhci`, since QEMU resolves `bus=xhci.0` at realize and an earlier declaration is a parse-order trap). `removable=on` is **explicit**: QEMU 10's usb-storage defaults the property to *off* when omitted. The qcow2 stays `ide.0` (Windows **Disk 0** / `DiskID 0`, no change), the install CD stays `ide.1` `bootindex=1`, and the optional driver CD keeps `ide.3`. The drive node is still declared right after the system disk, so the block graph order is unchanged and the image is attached before any device names it. The node stays **writable** (QEMU 10 refuses `readonly=on` behind ide-hd; usb-storage accepts either, verified both ways) |
| F2 | the presses were spawn-relative, so the first boot missed the window entirely | the schedule is anchored on **`serial.log`**: a watcher stats the file and reads its tail, and fires when the log carries the prompt signature (`Press any key to boot from CD` / `BdsDxe: starting Boot0001`) or when first output has appeared +1.5 s. Presses repeat every 0.8 s; a prompt anchor stops after three, a growth anchor retries until the ~8 s window closes. The fixed offsets survive as the fallback for a silent console and for a store where QEMU never created the log (it never created it → the historical schedule runs, unchanged) |
| F3 | docs described the old fixed-time presses and the ide-hd medium as the guarantee | `README.md`: the Windows troubleshooting section now explains the serial anchor (and why the fixed schedule missed), the removable delivery, and Windows' answer-file search order with a table that marks the fixed-disk root as "never scanned". The "OEM payload is missing" section and the bus table were corrected. The dockur comparison is restated correctly: their overlay is a partitionless *superfloppy*, ours is an MBR disk, and neither fact is why their flow works — the medium's **class** is |
| F4 | nothing asserted the attach class or the anchor; the gate needles still pinned `ide-hd,setup0` | `tools/check-cua-vm.mjs`: the needle class was **retargeted, not deleted** — `ide-hd,drive=setup0,bus=ide.2` → `usb-storage,drive=setup0,removable=on,bus=xhci.0`, plus new needles for `CDBOOT_PROMPT_PATTERN`, `cdbootPromptSeen`, `readSerialTail` and `serialLog: p.serialLog`. The K1 semantic still rejects ANY `read-?only` near `setup0`, and now also rejects an `ide-hd,drive=setup0` shape while requiring the removable usb-storage form, declared after both `disk0` and `qemu-xhci`. `tests/modules-unit.mjs`: the argv test demands the removable device and the absence of the ide-hd form; the cdboot tests drive a **stubbed serial timeline** (prompt at 4 s → presses at ~4.1/4.9/5.7 s; first output at 0.6 s, no prompt text → growth anchor + retries; silent console → the fixed fallback; a failing send is non-fatal) and exercise `readSerialTail` on a real file. `tests/supervisor-smoke.mjs`: the create asserts the install argv carries the removable usb-storage shape (and no `ide-hd,drive=setup0`), positioned after xhci, with no `fat:ro:`/`oem0` stick |

**Verified live in this container (QEMU 10.0.13, KVM, real OVMF, real swtpm, real mtools).**

* The device class first, on the raw argv: `-drive file=setup.img,...id=setup0` +
  `-device usb-storage,drive=setup0,removable=on` **starts** with a writable node
  and, separately, with a `readonly=on` node — both accepted (the old ide-hd
  rejection does not apply). `query-block` reports
  `"device":"setup0","removable":true,"inserted":{"ro":false,...}`; with
  `removable=off` — and with the property omitted on 10.0.13 — the same query
  reports `removable:false`. That is why the property is spelled out in the argv.
* A **full boot of the new argv**: a throwaway store under `/tmp/cua-replay`,
  `setup.img` built by the real `writeOemPayload()` + `buildSetupImage()` (the
  image `file` reports as
  `DOS/MBR boot sector; partition 1 : ID=0xc, active, startsector 2048, 129024 sectors`),
  an OVMF vars qcow2, a real swtpm socket, KVM. QEMU stayed up; `query-status`
  → `running`; `query-block` → `setup0 removable:true, ro:false` with the real
  `setup.img` filename; HMP `info usb` →
  `Device 0.1, Port 1, Speed 5000 Mb/s, Product QEMU USB MSD` beside
  `QEMU USB Keyboard` / `QEMU USB Tablet` — i.e. the answer medium enumerates on
  the guest's USB bus as removable media. `serial.log` received **1772 bytes** of
  OVMF output (`BdsDxe: failed to load Boot0001 "UEFI QEMU DVD-ROM"…` /
  `BdsDxe: starting Boot0003 "EFI Internal Shell"` / the shell banner), then the
  shell ran `startup.nsh` — the belt-and-braces path — because the CD in the
  replay is a stub, not an ISO.
* The **anchor, against that real firmware's serial output**: the watcher was run
  live with the real `serial.log` and a stubbed `sendKey`. First output was seen
  at ~809 ms, so it pressed at **2316, 3118, 3919, 4719, 5520, 6321, 7123,
  7924 ms** — the growth anchor plus 0.8 s retries through the ~8 s window, which
  is exactly the behaviour the fixed schedule could not express (its last press
  was at 5.5 s regardless of the firmware).
* `node tools/check-cua-vm.mjs` → **569** assertions (checkout); flat-layout
  replay from `cwd=/` (`--root` over a writable flat copy of the image tree,
  because the image's own check dir is read-only) → **567**, with L5 + N3 `n/a`
  as designed.
* `node tools/check-cua-rea.mjs` → **67**.
* `node tools/ci-gates.mjs` → **9 passed / 1 failed / 1 skipped**; the failure is
  still `check-office.mjs` (the office bundle is not installed in this
  environment), unchanged by this round.
* `tests/{supervisor-smoke,modules-unit,windows-boot,qmp-shutdown}.mjs` → all
  **PASS**. `node --check` clean on every changed file.

**NOT RUN, with the reason.** A real Windows install from the pinned ISO is
still not attempted here: it needs the 4.8 GB media, tens of minutes and a guest
that reaches OOBE, none of which this sandbox provides. What IS proven is the
defect class end to end at the level that was broken: the medium is a real MBR
+FAT32 disk, it is attached as **removable** USB mass storage (QMP and HMP both
say so), and the key schedule is anchored on the firmware's actual serial
timeline instead of on the spawn clock. Whether Setup then reads it is the one
step only a live install can show — and it is now the only remaining unknown.

### 9.6.15 Live-verified Windows-panel UX defects (U1–U4)

Four defects reported from a **live, fully installed Windows computer** (SSH up,
GUI control proven end to end). All four were reproducible on that machine and
none of them is a Windows problem — they are this plugin's.

| # | defect | root cause | fix |
|---|---|---|---|
| U1 | "Hide password" left the password visible | the label followed `secret[name]`, the click always called `revealPassword`; `setSecret` had no clear path; the reveal ALSO interpolated the password into the persistent note banner | `hidePassword()` deletes the key from a copied state and clears the note if it carried the value; the button toggles on `secret[name]`; the reveal note says where the password is, not what it is |
| U2 | clipboard into the guest did nothing | RFB `ClientCutText` is dropped (no guest clipboard agent — a paste delivered the OLD clipboard); `Set-Clipboard` over SSH writes **Session 0**'s clipboard | two on-demand `/it` tasks (`cua-clip-set`, `cua-clip-get`) that run in the interactive session, driven over SSH/scp; panel Clipboard section; noVNC paste box documented as unusable |
| U3 | a blank console window at every logon | the autostart task ran `python.exe` (always allocates a console) with `Hidden=False`, and passed a fictional `--pipe \\.\pipe\dsh-cua` | `pythonw.exe` + `-Hidden` (a hidden PowerShell wrapper when no pythonw exists); the pipe argument is gone, and the limitation is documented |
| U4 | "6.8 GB free on C:" — the warning was real | the panel showed the VIRTUAL disk size only; nothing ever read the guest's free space | `freeSpace` on the status payload (`Get-PSDrive C` over SSH, throttled 60 s), printed on the spec line with the below-floor warning (10 GB) |

**The clipboard is the interesting one**, because two "obvious" paths both
*succeed* and do nothing, which is worse than failing:

* RFB `ClientCutText` — QEMU accepts the message and the guest drops it; the
  paste then delivers whatever the guest already had. Proven on the live VM.
* `Set-Clipboard` over SSH — sshd is in Session 0; the command exits 0 and the
  user's session clipboard never changes.

The only context that owns the visible clipboard is the logged-on session, so the
bridge is two **on-demand, interactive** (`/sc ondemand /it /rl LIMITED`) tasks
running `Set-Clipboard` / `Get-Clipboard` there. Three invariants make it honest:

1. the text file is written **before** the task is run (the file's `schtasks /run`
   only QUEUES the task — ordering is the whole protocol);
2. the task's **`Last Result`** is polled with `/query /fo LIST /v`, so a non-zero
   exit is reported as *"the clipboard was NOT set"* with the code, never as a
   success;
3. the read direction **deletes `clip-read.txt` first**, so a task that did not
   run cannot be answered with yesterday's clipboard.

Text never travels on a command line (`&`, `|`, `;`, quotes would be re-parsed by
`cmd.exe`): it is scp'd as a file, capped at 1 MiB. The `ssh`/`scp` transport is
**injected** into the backend, so the protocol is driven by a stub in
`tests/modules-unit.mjs` and the ORDER is asserted, not commented.

**U3's honest limitation, recorded here as a follow-up.** Upstream
`dsh_cua.server main()` takes **no** `--pipe` argument, so the named pipe the
firstboot task referenced was never created. The consequence is documented
instead of papered over:

* the MCP attach keeps working as it really does — an independent stdio server
  per SSH session, 19 tools;
* **one shared session-2 server cannot be reached from Session 0 yet**, which is
  why the clipboard does not ride that channel (the `/it` tasks above exist);
* if upstream grows a pipe server, the firstboot task registers it and
  `win-mcp.js` proxies to it. Until then this is a **documented limitation**, and
  the visible console window — the user-visible half — is gone.

Also relabelled: the panel's **"Terminal"** button is a one-shot exec form (one
command, captured output) with no pty. It is now **"Run command"**, with a title
that says exactly that. A real pty needs a bidirectional stream plus a resize
path on both backends — not a rename, so it is not attempted.

**Verification actually run** (this round):

* `node tools/check-cua-vm.mjs` → **PASS**, **663** assertions over 18 files
  (was 604), and the same gate replayed from `cwd=/` against a flat tree
  assembled exactly as the image assembles `/opt/seek-harness/cua-check` → **PASS,
  661/18** (the flat layout has no `Dockerfile`, by design).
* `node tools/check-cua-rea.mjs` → **67** needles, PASS.
* `node tools/ci-gates.mjs` → 9 passed, 1 skipped (image artifact), **1 failed:
  `check-office.mjs`** — pre-existing and unrelated (the office bundle/CLI are not
  installed in this sandbox; it failed identically before this round).
* `node tests/modules-unit.mjs` → **PASS**, **31** new assertions: the hide-password
  state transition (and that the reveal note never interpolates the value), the
  clipboard protocol against a stub transport (order, `Last Result`, stale-file
  clearing, missing-file failure, no-transport, >1 MiB refusal), the two
  firstboot task registrations (on-demand/`/it`/LIMITED/hidden), `pythonw.exe` +
  `-Hidden` and the absent `--pipe`, and the free-space parser/formatter.
* `node tests/supervisor-smoke.mjs` → **PASS**, **8** new assertions: the three new ops
  refuse an unknown computer, a not-ready row answers `available:false` **with
  the reason** (the panel's disabled state), and a status poll carries
  `freeSpace` without failing on it.
* `node tests/windows-boot.mjs` → PASS; `node tests/qmp-shutdown.mjs` → PASS.
* `node --check` clean on every changed file.

**Note on `module.exports.__test`**: the client now exports two pure helpers
(`hideSecretEntry`, `noteAfterHide`) plus `clean`, used only by the unit test.
The defect was a state transition ("hide" cleared nothing), and a renderer test
would not have named it.

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
10. **FOLLOW-UP (U3): a shared session-2 dsh-cua server over a named pipe.** With
    a stdio-only upstream (`main()` takes no `--pipe`), each SSH attach starts its
    own server and nothing can reach a listener in the user's session. The
    clipboard works around it with two `/it` tasks; a general fix needs upstream
    to accept a pipe (or a socket) so ONE long-lived session-2 server exists.
    Recorded as a documented limitation in `plugins/dsh-cua-vm/README.md`, not as
    a pending bug, and no fake flag is registered for it.
11. **The clipboard bridge is verified against a stub transport, not a live
    guest.** The order (`clip.txt` before `schtasks /run`), the `Last Result`
    check, the stale-file delete and the missing-file failure are all asserted;
    what a live run would add is the Windows-side task plumbing itself
    (`/it` session routing, `Last Result` semantics on that build).
