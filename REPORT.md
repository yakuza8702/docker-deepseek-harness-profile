# Report — CUA personal computers for the DeepSeek Harness

Branch: `feat/cua-web` · head `da91f4b` · base `@deepseek-ai/dsh` 0.2.1-rc.2
Image: `dsh-harness:trim-cua-20261024` (6.29 GB) · GPU image adds virgl QEMU
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

| Area | Evidence |
|---|---|
| VM lifecycle | create → ready, start/stop, checkpoint/recreate, delete |
| GPU passthrough (virgl) | host `nvidia-smi` shows the QEMU process; guest `eglinfo` → `virgl (NVIDIA GeForce RTX 3060)` |
| Accelerated desktop | after provisioning: `Xorg :1` + `glxinfo -B` → `virgl (NVIDIA GeForce RTX 3060/PCIe/SSE2)` |
| Capture | PNG 1280×800 of the guest desktop; `cua-desktop` stays active |
| Screenshots to the model | saved in the guest (`/home/cua/shots/…`), fetchable with `cua_vm_get` |
| `cua_vm_get` | creates missing local dirs (`test/house/shots/…` works) |
| Clicks | absolute **and** fractional: `x:0.5,y:0.5,relative:true` → pointer `640,400` on 1280×800 |
| Crops | `screenshot {region:{x,y,width,height,scale}}` → 100×100@4x = 400×400, with the inverse mapping printed |
| a11y | falls back to display size + window list when AT-SPI is absent (Blender) |
| Panel | themed (dark/light), left-nav entry, self-updating list |

Not yet re-verified after the Xorg switch: Chromium WebGL inside the desktop
(previous failure was on Xvfb/llvmpipe), and Blender GUI interaction end to end.

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

---

## 5. Fixes shipped (newest first)

| Commit | Fix |
|---|---|
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
git checkout feat/cua-web          # head da91f4b
docker build --build-arg DSH_VERSION=0.2.1-rc.2 \
  --build-arg WITH_VIRGL_QEMU=1 -t dsh-harness:trim-cua .
docker compose -f compose.yaml -f compose.gpu.yaml up -d
```

GPU compose needs: `devices: [/dev/kvm, /dev/dri]`, `group_add` with the host
`render`/`video` GIDs, `DSH_CUA_VM_GPU=virgl`, and the NVIDIA reservation with
`capabilities: [gpu, utility, graphics, video, compute]`.

Verify:

```bash
docker exec <c> tail -n 40 /cua-vm/supervisor.log      # "qemu: using … (virgl enabled)"
docker exec <c> cua sb ls --local
# inside the VM, for a GPU computer:
DISPLAY=:1 glxinfo -B | head -3      # renderer: virgl …
eglinfo -B | head -3                 # core profile renderer: virgl …
cat /var/log/cua-gpu-provision.log   # provisioning transcript
```

Then **Personal VM (CUA) → New computer → Enable GPU**. The first start takes
1–2 minutes longer (apt + Xorg switch); the VM is usable during it.

---

## 7. Open issues

1. **Chromium WebGL on the accelerated desktop is unverified.** The observed
   failure (`ANGLE (Mesa, llvmpipe …)`, `BindToCurrentSequence failed`) came from
   the Xvfb session. If it persists on Xorg, suspect the GPU sandbox
   (`--disable-gpu-sandbox`) before virgl. This build rejects `--use-gl=egl`;
   only `angle=default` is allowed, so use the default or
   `--use-gl=angle --use-angle=gl`.
2. **Menu hunting is still visual.** AT-SPI does not exist for custom-drawn apps
   (Blender), so the model reads pixels. Cheap mitigations are in place
   (geometry, fractional clicks, one-shot crops); the structural fix is to
   prefer keyboard/programmatic control for authoring tools and the browser tool
   for web pages.
3. **Video needs HTTPS.** On plain HTTP the viewer falls back to frames. Behind
   Pangolin, `Bypass Auth` is required on `/vm/view/media` (the stream), while
   `/api/*`, `/cua/*`, `/desktop/*` stay protected.
4. **The Xorg switch patches a guest file** (`/opt/cua/desktop/start-desktop.sh`,
   backup `.orig`, marker `/var/lib/cua-gpu`). A future cua image that rewrites
   that script must be re-checked; the script is idempotent and verifies the
   renderer before keeping the change.
5. **A container restart kills QEMU**; cua 0.7.0 cannot start it again. The
   supervisor recreates it from the checkpoint (flat qcow2), so guest files
   survive, but the running processes do not.
6. **Debian/Arch are not Cua disks** — the dropdown offers Ubuntu slim/full; a
   custom disk needs `cua images build`.
7. **The MCP-manager filter is content-anchored** against a third-party bundle;
   a plugin update that moves the anchor logs a warning and leaves the list
   unfiltered.

---

## 8. Next

1. Re-run the Blender test on `da91f4b`: confirm the cursor is visible in the
   video view, clicks land where the model looks, and the focus line replaces
   trial and error.
2. Re-test Chromium WebGL on the Xorg desktop; decide whether the GPU sandbox
   flag belongs in the guest's Chromium defaults.
3. HTTPS in front of the harness so Show VM uses the real viewer everywhere.
4. VM over MCP: `cua mcp` behind a stdio→HTTP bridge at `/vm/mcp` with the same
   gate, so other agents can use the same per-workspace computer.
