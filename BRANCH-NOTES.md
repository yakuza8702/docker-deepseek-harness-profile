# Branch `feat/cua-web` — a personal computer for the model

A smaller harness image that gives the model its own Linux computer, keeps the
agent inside `workspace-write`, and adds a **Personal VM (CUA)** page in the
left sidebar with a shared desktop a human can take over.

Upstream base: `@deepseek-ai/dsh` **0.2.1-rc.2** (npm `latest` on 2026-10-23),
which is what `.github/workflows/docker-build.yml` resolves when
`DSH_VERSION_PIN=""`. The build below pins that version explicitly so the image
is reproducible.

## 1. Cut: Android emulator (~5.16 GB uncompressed)

Removed from the image:

* Dockerfile emulator block (`WITH_EMULATOR`, `EMU_*`, `KVM_GID`,
  `emulator-toolchain.sh`, the AVD env, the build-time check);
* `docker/emulator-toolchain.sh`, `docker/emulator-tools.sh`, `docker/emulator.md`;
* `tools/check-emulator-toolchain.mjs`;
* `provision_emulator_avd()` and its boot-time call;
* `compose.emulator.yaml` now carries **only** the KVM device for the VM
  supervisor (same filename, new purpose).

Measured before the cut: `system-images` 4.3 GB + `emulator` 863 MB.

## 2. Cut: APK static toolchain (~1.27 GB uncompressed)

Removed: the Dockerfile APK block (JDK, jadx, apktool, SDK build-tools,
`apk-tools` venv, `JAVA_HOME`/`ANDROID_*`/PATH env, build-time check),
`docker/apk-toolchain.sh`, `apk-tools.sh`, `apk-unpack.sh`, `apk-tools.md`,
`tools/check-apk-toolchain.mjs`.

APK work, if it comes back, belongs in the VM base disk, not in every harness
image.

## 3. CUA: a personal VM per workspace

New files:

* `docker/cua-vm-supervisor.mjs` — owns `/dev/kvm`, QEMU, the cua daemon and
  `/cua-vm`; exposes newline-JSON over `/tmp/cua-vm/supervisor.sock`;
* `plugins/dsh-cua-vm/` — `cua_vm_*` tools (status/ensure/exec/put/get/port/
  suspend/destroy), a prompt section, a bundle patch, and a client half that
  registers the Personal VM page;
* `plugins/dsh-cua-vm/README.md` — architecture and limits.

Wiring:

* entrypoint starts the supervisor **before** the harness, outside the sandbox
  (`start_cua_supervisor`), seeds the bundle (`seed_cua_vm_bundle`), and stops
  it on shutdown;
* `compose.yaml` gains `cua-vm:/cua-vm`, the `DSH_CUA_VM*` env and a one-shot
  `cua-init` that fixes the volume's ownership;
* the Dockerfile installs the `cua` CLI (45 MB) and copies the plugin into both
  `node_modules` roots and the installation manifest.

Why the split matters: `workspace-write` grants read-write only to
`/dev/null`, `/tmp` and the workspace root, so the shell can never open
`/dev/kvm`; the tools only write to a socket in `/tmp`, and VM disks never enter
the workspace. QEMU itself is fetched into the volume on first use
(`cua runtime setup qemu`), keeping ~200 MB out of the image.

## 4. Build and run

```bash
docker build --build-arg DSH_VERSION=0.2.1-rc.2 -t dsh-harness:trim-cua .
docker compose -f compose.yaml -f compose.emulator.yaml up -d   # second file = /dev/kvm
```

## 5. Verify

```bash
docker exec <c> cua --version
docker exec <c> ls -l /tmp/cua-vm/          # supervisor socket
docker exec <c> tail -20 /cua-vm/supervisor.log
docker exec <c> cua sb ls --local --json    # after the first start
```

## 6. The Personal VM (CUA) page

A first-class left-sidebar panel next to **Plugins** and **Automation tasks**
(`sidebar.panellist` + `main`, the public seats `ui-schedule` also uses), not a
settings card buried in Plugins. It lists every computer with live state, spec
and image, and offers:

* **Start** → **Starting…** → **Shutdown**. `cua` reports a fresh boot as
  `running` and a resumed one as `ready`; both count as running. The list polls
  while a machine starts and the transient note clears when it is up.
* **Show VM**, left of Delete — the shared desktop (section 7).
* **Terminal** (one command, inline output), **Metrics** (guest load / memory /
  disk / vCPU), **Delete** (confirmed).
* **New computer** — name, vCPU, RAM, image. Debian and Arch are not Cua disks:
  they need `cua images build` and a pinned reference, and the panel says so
  instead of substituting Ubuntu. The model is told to ask for name/spec/image
  through `ask_user_question` before creating one.
* **Policy** tab — the values in `/cua-vm/config.json`.

`vmStart` rebuilds a VM whose QEMU process is gone (a container restart) from
the spec in the registry, so Start is never a dead end.

## 7. Show VM: the shared desktop

The supervisor runs `cua sb view --no-open --json`, records host port + path in
`/cua-vm/views.json`, and the proxy serves the desktop at `/vm/view/<name>/`
with the ticket kept in the URL fragment — the browser holds it, the proxy
never sees it. The page frames it same-origin with a header that says what it
is: *"You and the model share this screen. Input from either side lands in the
same session."* A human can type a password the model never reads.

Three proxy details matter: the viewer ships `frame-ancestors 'none'`
(rewritten to `'self'`); spacesd routes its gRPC services at **root** paths that
the viewer resolves against `/vm/view/`, so dotted service segments are
forwarded to the newest viewer instead of being read as a VM name; and the
media socket is `/vm/view/media?ticket=…`, a bare segment with no dot — it is
matched explicitly, because a 502 there is what makes the viewer loop on
"Reconnecting…" forever.

**Plain HTTP / LAN.** The video path needs a secure context, which
`http://192.168.x.x` is not. The viewer therefore offers **Frames (http)**: the
supervisor grabs `cua sb screenshot` (PNG, base64), the page refreshes it every
1.2 s, the image is clickable (coordinates scaled to the guest's resolution),
and a type box plus Enter/Tab/Esc drive `xdotool` inside the guest. Over HTTPS
the video view is interactive on its own and the frames button is unnecessary.

## 8. Port previews: `/vm/port/<name>/`

`cua_vm_port` does not return a bare loopback address. The supervisor starts a
real `cua sb port-forward`, records it in `/cua-vm/ports.json`, and the proxy
serves:

```
http://<harness>/vm/port/<vm-name>/...   ->   127.0.0.1:<localPort>/...
```

Same origin as the harness, inherits the proxy's auth, HTTP and WebSocket. The
forward lives until `portClose`, suspend or destroy; a harness restart keeps it
as long as the VM does. A missing preview answers 502 with the file to inspect.

## 9. VM policy is configuration, not code

`/cua-vm/config.json` (written by the supervisor, edited from the page's Policy
tab):

| Key | Default | Meaning |
|---|---|---|
| `autoSuspend` | `true` | run the idle timer at all |
| `idleSuspendMinutes` | `30` | minutes without `exec`/`put`/`get`/`port` before a VM is suspended; `0` disables |
| `diskQuotaGb` | `20` | store budget (base image + QEMU + every disk); a create above it is refused, nothing is deleted |
| `maxRunning` | `1` | running VMs; a suspended VM frees the slot and keeps its disk |

The timer is checked once a minute and reads the file each time, so a saved
change applies without a restart; a command in flight postpones the suspend.
The image carries defaults, never the user's policy.

## 10. Built-in MCP rows hidden from the MCP manager

`browser-mcp` and `brave-devtools-mcp` are bundle-owned and switched on the
Plugins page. `tools/patch-mcp-manager.mjs` filters those loader-owned rows out
of `@xxxyz/dsh-mcp-manager`'s list (idempotent, content-anchored, never blocks
boot). Override with `DSH_MCP_MANAGER_HIDDEN` (empty = show everything).

## 11. Troubleshooting: KVM behind a dind sidecar

The VM needs `/dev/kvm` **and** the engine that runs the container must be able
to open it. A dind sidecar that runs with a user namespace (uid_map
`0 → 165536`) cannot: the host's `/dev/kvm` (`root:kvm 0660`) appears inside as
`nobody:nogroup`, and even root inside gets `Permission denied` on open —
adding a group does not help, because gid 104 has no mapping in that namespace.
Sysbox (`runtime: sysbox-runc`) behaves the same way; `--userns=host` and
`--privileged` are not supported there.

Check:

```bash
docker run --rm --device /dev/kvm alpine:3.20 sh -c 'ls -l /dev/kvm; exec 3<>/dev/kvm && echo KVM_OK'
```

Fix (used on this deployment): make the device world-accessible on the host,
since the namespace cannot express the owning group —

```bash
# /etc/udev/rules.d/99-kvm.rules
KERNEL=="kvm", MODE="0666"
```

then reload the rule (or `chmod 0666 /dev/kvm` for the current boot) and
recreate the container. Inside, `/dev/kvm` shows `crw-rw-rw- nobody nobody` and
`exec 3<>/dev/kvm` succeeds. Running the harness stack directly on the host
avoids the extra namespace entirely.

## 12. Known limits

* cua 0.7.0 has no `--headless`: the VM always boots its desktop session
  (readiness waits on `tcp:3211`);
* first start pulls the base image into the volume, then QEMU — one-off and
  outside the image;
* a container restart kills QEMU, and cua cannot start such a VM again; Start
  falls back to deleting and recreating it, so the disk delta of that machine is
  lost (idle suspend inside a live container is safe);
* the video/input viewer needs a secure context (HTTPS or localhost); plain
  HTTP gets the frames fallback;
* the Android emulator's dynamic-analysis capability is gone from this branch,
  and APK tooling belongs in a VM disk rather than every image;
* the MCP-manager patch targets a third-party plugin's bundle; a plugin update
  that moves the anchor logs a warning and leaves the list unfiltered until the
  anchor is refreshed.

## 13. Next: VM over MCP, and the workspace question

**VM over MCP.** An agent that is not this harness can use the same
per-workspace VM the way BoxCompute exposes `https://mcp.boxcompute.ai/mcp`:
`cua mcp` speaks MCP over stdio; wrap it with a stdio→HTTP bridge, publish it at
`/vm/mcp` behind the same auth fence as `/vm/port/`, bind it to 127.0.0.1 and
require a boot-minted token (`/cua-vm/mcp-token`), and scope it to the same
socket so an external agent cannot create a second computer for one workspace.

**BoxCompute's model is not ours.** BoxCompute runs the agent's shell *inside*
the VM, so its VM is the workspace. This harness keeps the agent's shell in
`/workspace` and treats the VM as a second computer you copy into. Matching
BoxCompute means either sharing `/workspace` into the guest (virtiofs needs
`/dev/fuse`, absent here; 9p needs custom QEMU args) or routing the shell and
file tools to `cua_vm_exec` / `cua_vm_put` / `cua_vm_get`. That is a mode, not a
setting, so it is written down rather than half-done.

## The VM gate: protecting the desktop behind an SSO/passkey

`/vm/view/*` and `/vm/port/*` are the only surfaces that must be reachable when
an upstream proxy handles auth, because a WebSocket upgrade cannot follow an
auth redirect. They are not left open: the harness proxy sets an HttpOnly
`dsh_vm_gate` cookie on any page it serves (so the visitor has already passed
whatever guards the app) and answers 403 on the VM surfaces without it — HTTP
and WebSocket alike.

`VM_GATE_SECRET` pins the value (otherwise it is minted per boot and a reload
re-issues it). Scripts may present `x-dsh-vm-gate: <secret>` or `?gate=<secret>`
instead of the cookie.

The viewer's own gRPC client does not send cookies, so the gate also accepts the
minted ticket (`x-cua-env-authorization: Bearer …`, or `?ticket=` on the media
socket). The supervisor stores the ticket's SHA-256 when it mints the link, and
the proxy compares hashes — a header that merely looks like a ticket is refused
(403). That is what keeps the SSO bypass to `/vm/view/media` usable without
leaving the surface open. With Pangolin in front, the only rule needed is
`Bypass Auth` on `/vm/view/media`; the socket is then still gated by this cookie
*and* by the signed `?ticket=` from the authenticated `/cua/view` call.

## Why the agent's pointer was invisible

X11 paints the cursor as an overlay that the capture path does not composite:
`xdotool getmouselocation` reports the agent's position, but neither
`cua sb screenshot` nor the spacesd stream contains the cursor. That is the same
reason Cua Driver draws a cursor of its own ("the agent gets its own cursor
overlay").

`/cua/pointer` returns the live position, the panel polls it twice a second and
draws a cursor over the frames view, and the viewer header shows `pointer x,y` —
which is also the quickest way to tell whether the model actually moved the
mouse or just ran a shell command.

## Surviving a container recreate: VM checkpoints

cua cannot cold-boot a QEMU VM whose process died, and the old recovery deleted
the sandbox — so every `docker compose down && up` produced a blank computer and
lost whatever the model had installed.

Before deleting a dead sandbox the supervisor now flattens its writable overlay
with `qemu-img convert -O qcow2` into `/cua-vm/checkpoints/<name>.qcow2` and
recreates the computer from that disk (`cua sb create <path>`). A plain copy is
not enough: it keeps the backing chain, and a disk created from the previous
restore turns the chain into a cycle ("Too many open files"). Verified: a marker
file written before a container restart is readable afterwards.

The checkpoint is taken from whatever the disk held at recovery time, so it
survives `down/up`, image updates and host reboots as long as the `/cua-vm`
volume does. It is not a backup: deleting the volume still deletes the computer.

## GPU in the VM: virgl, not passthrough

`cua sb create --gpu virgl` is the paravirtual path: the host GPU is shared, the
VM gets a virtio-gpu-gl device, and it is OpenGL/GLES, not CUDA. Two things were
missing and are now solved:

* cua's own QEMU has no `virtio-gpu-gl-pci` (verified). The distro build does —
  but only with `qemu-system-modules-opengl`, which ships
  `hw-display-virtio-gpu-pci-gl.so`. The image installs both behind
  `--build-arg WITH_VIRGL_QEMU=1`.
* `DSH_CUA_VM_GPU=virgl` makes the supervisor overwrite cua's QEMU wrapper with
  the system binary (it re-applies after every `runtime setup`) and add
  `--gpu virgl` to creates.

`compose.gpu.yaml` carries the host side: `/dev/dri`, the render/video GIDs, the
NVIDIA toolkit reservation with the `graphics` capability, and
`NVIDIA_DRIVER_CAPABILITIES=all`. Without a render node the create fails with
"No GPU render node (/dev/dri/renderD*)" — a clear refusal, not a silent
software fallback. CUDA inside the VM still requires VFIO and a dedicated GPU.

---

## Round 2: input that lands, a shared workspace, Android in the VM

The first round could draw a desktop but not reliably *use* one: clicks landed
6% off, Blender refused on OpenGL, nothing reached the guest but copies, and the
Android emulator was out of the image with no path back. Each of those was a
concrete bug, not a mystery.

### 1. One coordinate space: the screenshot

cua caps a capture at ~900k pixels, so a 1280×800 desktop is delivered as a
**1200×750** PNG (factor 0.9375). cua's input verbs take **screenshot pixels**
and map them to the display (`cua do click 600 375` → pointer `640,400`), but
the first implementation captured with cua and clicked with `xdotool` in display
coordinates. That mismatch is the entire "mouse control is unreliable" report.

Now:

* every pointer action is a `cua do` verb (`click`, `dclick`, `move`, `drag`,
  `scroll`) with screenshot pixels;
* one priming screenshot per VM makes cua's mapping deterministic (its first
  click in a fresh daemon session is unscaled);
* `zoom <window>` / `unzoom` crop to a window through cua, so small controls
  stay clickable and coordinates stay valid;
* `geometry` lists windows **with bounds** from `cua do window ls`;
* provisioning sets the desktop to 1200×750 (an Xorg modeline; Xorg ignores the
  config's `Modes` because the virtio EDID does not advertise it), which makes
  the capture 1:1 — image pixels are display pixels, `xdotool` and `a11y`
  bounds line up too.

### 2. The QEMU shim lives on PATH, not in `.cua/bin`

cua 0.7.0 does not execute `$CUA_HOME/.cua/bin/qemu-system-x86_64`; it resolves
`qemu-system-x86_64` through **PATH** (proved by a shim that logs its argv).
Round 1's "swap the wrapper for virgl" was therefore a no-op — virgl worked
because the distro build happened to be first on PATH, and any argument added to
that wrapper never reached QEMU.

The supervisor now writes `/cua-vm/bin/qemu-system-x86_64` and prepends that
directory to `PATH` for every `cua` call. The shim:

* execs the distro QEMU (virtio-gpu-gl-pci) when the image has it, otherwise
  cua's own build;
* appends `-virtfs local,path=/workspace,mount_tag=dshworkspace,
  security_model=none,multidevs=remap`;
* is rewritten on every start, so `cua runtime setup` cannot drop it.

### 3. `/workspace` is the same directory on both sides

The guest mounts the 9p share at `/workspace` (fstab entry, `nofail`), so a file
the model writes in the VM is a workspace file the harness can read — verified
both ways. 9p is for source and results; the prompt says to copy into
`/tmp/build` for a build that writes thousands of files.

Turn it off with `DSH_CUA_VM_SHARE_WORKSPACE=0`; `cua_vm_put`/`cua_vm_get` stay
as the explicit bridge.

### 4. OpenGL 4.3 on virgl

virgl reports **4.2** although every 4.3 extension is present
(`GL_ARB_compute_shader`, `GL_ARB_shader_storage_buffer_object`,
`GL_ARB_program_interface_query`, `GL_ARB_multi_bind`). Blender 4.x refuses on
the version string, so round 1's answer was `LIBGL_ALWAYS_SOFTWARE=1` — a GPU
computer rendering on the CPU.

`MESA_GL_VERSION_OVERRIDE=4.3FC` is now set in two places:

* `cua-desktop.service` → the whole XFCE session (GUI launches);
* `cua-spacesd.service` → `cua sb exec` children (`blender -b`, `glxinfo`,
  tests), which otherwise see the un-overridden value.

The provision script restarts spacesd **detached** (it is the channel the script
itself runs on) and the supervisor waits for `$MESA_GL_VERSION_OVERRIDE` to
appear before reporting success.

Venus/zink is not an option on this host: blob resources need `/dev/udmabuf`,
which the container does not have.

### 5. Nested KVM and the Android emulator

The VM already runs with `-cpu host`, so `vmx` reaches the guest and `/dev/kvm`
exists there — it was only `root:kvm 0660` with `cua` outside `kvm`. A udev rule
plus `chmod 0666` fixes it; `KVM_GET_API_VERSION` returns 12 inside the guest.

`docker/cua-guest-android.sh` installs the official SDK (command-line tools,
platform-tools, emulator, `system-images;android-35;google_apis;x86_64`), creates
an AVD and a `cua-emulator` launcher (`-gpu swiftshader_indirect -no-audio
-no-boot-anim -no-snapshot`, `-no-window` for adb-driven runs). Nothing Android
lives in the harness image.

Create with `cua_vm_create {gpu: true, cpu: 4, memory: 8, diskGb: 40}`, then
`cua_vm_android`. The bootstrap refuses under 12 GB free with a clear message.

### 6. Growing a disk without stopping the computer

cua has no `stop` (suspend pauses QEMU and keeps the qcow2 open), so
`qemu-img resize` has no window. The supervisor talks QMP to the running machine
(`block_resize` on `disk0`), then `growpart /dev/vda 3` + `resize2fs /dev/vda3`
in the guest. Verified 20 → 40 GB online with the filesystem at 40 G and 36 G
free. `cua_vm_disk` exposes it; `diskGb` does it during create.

### 7. Provisioning is a file now

`docker/cua-guest-provision.sh` and `docker/cua-guest-android.sh` are real
scripts copied into the image, run through `sudo -n bash` over base64. The old
version was a base64 blob inside the supervisor: unreadable, untestable, and
impossible to debug when the guest rejected a line. The script is versioned
(`/var/lib/cua-provision`) and re-runs when the version changes, so an existing
computer gets the fixes on its next Start.

---

## Trimming the static tool catalogue

Every tool schema rides in the static context of every request, so a verbose
description is paid on each turn of every session. Five plugins on the Plugins
page put that catalogue around **19.6k tokens**; most of it was prose.

The model-facing surface is unchanged in capability — the trimming removes
*words*, and only removes *tools* where a sibling server already offers the same
verb better.

### What changed

| Where | Change | Measured |
|---|---|---|
| `docker/mcp-slim.mjs` | stdio MCP proxy in front of both browser servers; rewrites only the `tools/list` reply | — |
| Playwright row (`browser-mcp`) | all 24 tools kept; descriptions to one sentence, boolean param docs dropped | 4,626 → 3,672 tok (−21%) |
| Brave DevTools row (`brave-devtools-mcp`) | keeps what Playwright cannot do: Lighthouse, perf traces + insights, CPU/network emulation, console with source-mapped stacks, CSS cascade, heap snapshots, network detail. Drops the driving verbs Playwright already has | 6,776 → 2,135 tok (−68%), 30 → 11 tools |
| `plugins/dsh-cua-vm` | 12 tool descriptions rewritten from prose to one line | 1,426 → 661 tok (−54%) |

Total: **12,828 → 6,468 tokens** of tool schema, i.e. ~6.4k off a 19.6k
catalogue. The office bundle and the opt-in Browser-Use provider are untouched
(third-party tool definitions, and Browser-Use is not enabled by default here).

### How the proxy works

It spawns the real server, pipes stdin/stdout/stderr through untouched, and
rewrites only the `tools/list` **reply**: drop names in the policy, apply a
hand-written override when the policy has one, otherwise keep the first sentence
(stripping "This tool is used to…"), cap it, and delete a boolean parameter's
description because the name and type already say it. A parse or rewrite error
forwards the original bytes, so it can never break a handshake.

* `MCP_SLIM=0` — bypass the proxy entirely (full upstream surface).
* `MCP_SLIM_VERBOSE=1` — one line per server: tools before/after, chars,
  estimated tokens.

Neither name starts with `DSH_` on purpose: the MCP client builds a child
environment by dropping every `DSH_*` name, so a `DSH_MCP_SLIM` set in compose
would never reach the wrapper. `MCP_SLIM` survives the scrub.

### The gate

`tools/check-tool-trim.mjs` runs both policies against a synthetic 27-tool
catalogue (no browser, no network) and fails when a dropped tool survives, a
description exceeds its cap, or the JSON-RPC stream is disturbed. The Dockerfile
runs it at build time. The Brave plugin's own gate runs with `MCP_SLIM=0`,
because it asks whether the *wrapper* reaches a working server — what the model
sees is the trimmed catalogue, and that is what this gate measures.
