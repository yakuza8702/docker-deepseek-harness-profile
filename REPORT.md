# Report — CUA personal computers for the DeepSeek Harness

Branch: `feat/cua-web` · head `da91f4b` · base `@deepseek-ai/dsh` 0.2.1-rc.2
Image: `dsh-harness:trim-cua-v2` (6.43 GB, round 2, built with `WITH_VIRGL_QEMU=1`) · GPU adds virgl QEMU
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

* **Computers**: per-VM state badge (+ `GPU` badge), Start/Shutdown, Show VM,
  Terminal, Metrics, Delete. Terminal and Metrics are **toggles**.
* **New computer**: name, vCPU, RAM (GB), Image, **Enable GPU** — one row.
  Shutdown asks "Do you want to shutdown <name>?" first.
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

Not re-verified: Chromium WebGL on the Xorg desktop, and the video viewer over
HTTPS (both unchanged from round 1).

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

| Commit | Fix |
|---|---|
| round 2 | **input through `cua do`**: every click/dblclick/move/drag/type/key/hotkey/scroll is a cua verb taking screenshot pixels, so the 0.9375 capture factor cannot shift a click; one priming screenshot per VM makes the mapping deterministic; `zoom`/`unzoom`; window list with bounds |
| round 2 | **PATH QEMU shim** at `/cua-vm/bin` (`-virtfs` + distro build) — the only injection point cua 0.7.0 honours |
| round 2 | **9p workspace share**: guest `/workspace` *is* the harness workspace, bidirectional |
| round 2 | **1:1 desktop** (1200×750 via an Xorg modeline autostart) so screenshot pixels are display pixels |
| round 2 | **GPU provisioning rewritten as `docker/cua-guest-provision.sh`** (real file, not a base64 blob): apt repair, packages, render/kvm udev + groups, Xorg, GL override for the desktop *and* spacesd, 9p mount, marker with renderer/kvm |
| round 2 | **`MESA_GL_VERSION_OVERRIDE=4.3FC`**: Blender 4.x on virgl instead of llvmpipe |
| round 2 | **`cua_vm_disk`** (QMP `block_resize` + `growpart`/`resize2fs`, online) and `diskGb` on create |
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

1. **Chromium WebGL on the accelerated desktop is still unverified.** Try the
   default ANGLE path first; this Chromium build rejects `--use-gl=egl`
   (`--use-gl=angle --use-angle=gl` is the allowed spelling).
2. **The GL override is a report, not a capability.** virgl exposes the 4.3
   extension set but reports 4.2; the session lifts the string. If an app uses a
   function that is genuinely missing, it will fail on the GPU instead of
   falling back. That is still better than the old behaviour (refuse to start,
   or run at llvmpipe speed), and `LIBGL_ALWAYS_SOFTWARE=1` remains the escape
   hatch.
3. **The scratch mode is copy-then-build.** 9p is fine for source and results,
   not for object files; the prompt tells the model to build in the VM's own
   `/tmp/build` when a build writes thousands of files.
4. **Video needs HTTPS.** On plain HTTP the viewer falls back to frames. Behind
   Pangolin, `Bypass Auth` is required on `/vm/view/media`.
5. **A container restart kills QEMU**; the supervisor recreates from the
   flattened checkpoint, so files survive but running processes do not.
6. **Debian/Arch are not Cua disks.**
7. **The MCP-manager filter is content-anchored** against a third-party bundle.
8. **Android needs the disk grown first.** The bootstrap refuses with a clear
   message under 12 GB free; `diskGb: 40` on create is the intended path.
9. **`cua_vm_android` downloads ~3.5 GB.** It is one-off per computer and the
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
