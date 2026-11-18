# Branch `feat/cua-web` — a personal computer for the model

A smaller harness image that gives the model its own Linux computer, keeps the
agent inside `workspace-write`, and adds a **Personal VM (CUA)** page in the
left sidebar with a shared desktop a human can take over.

Upstream base: `@deepseek-ai/dsh` **0.2.1-rc.2** (npm `latest` on 2026-10-23),
which is what `.github/workflows/docker-build.yml` resolves when
`DSH_VERSION_PIN=""`. The build below pins that version explicitly so the image
is reproducible.

> **`rea` (from `feat/tool-trim`, `9d8033c`).** This branch adds the REA
> reverse-engineering kit to the personal VM (§14). Everything above §14 is the
> untouched `feat/cua-web` history; the tool-trim work landed in its own
> section and is inherited through `feat/tool-trim`.

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
* **Run command** (one command, inline output — NOT a pty: no prompt, no job
  control, no working directory that survives the call; the button used to say
  "Terminal", which promised a shell the panel does not have), **Metrics** (guest
  load / memory / disk / vCPU), **Delete** (confirmed).
* **Reveal / Hide password** (Windows only) — the label and the click now agree:
  hiding DELETES the value from the page state and clears the note that used to
  quote it.
* **Clipboard** (Windows only) — a textarea + **Paste to guest** +
  **Read guest clipboard**, driving the guest's interactive-session tasks. The
  noVNC paste box does not work on Windows (no clipboard agent in the guest).
* **Free space** on the spec line (Windows, ready) — `Get-PSDrive C` over SSH,
  throttled 60 s, with a warning below 10 GB.
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
description exceeds its cap, or the JSON-RPC stream is disturbed. The drop list
is checked against a frozen copy of the pinned servers' catalogues — never
against the policy itself — so a typo'd or renamed verb is a red gate instead of
a silent no-op (a name the pinned package defines only behind an opt-in flag is
listed as such, and the row enables neither), and a literal `__proto__` parameter
is pushed through the proxy to prove the rewrite keeps it as data. The Dockerfile
runs it at build time. The Brave plugin's own gate runs with `MCP_SLIM=0`,
because it asks whether the *wrapper* reaches a working server — what the model
sees is the trimmed catalogue, and that is what this gate measures.

---

## Hiding the built-in MCP rows from the MCP manager

`browser-mcp` and `brave-devtools-mcp` are owned by the image's bundles and
switched on the Plugins page. The MCP manager lists every loader-owned row
read-only, which gives the same capability two controls, one of them inert.

The first fix patched `@xxxyz/dsh-mcp-manager`'s own `lib/index.js` at boot.
That held until the plugin was **installed or updated**, which rewrites that
file — measured: the manager's file was rewritten at 14:17 by a plugin install,
the boot patch had already run at 11:13, and both rows stayed visible until the
next container start. A boot-time patch cannot survive a live dependency update.

It is a response filter in `docker/proxy.mjs` now: for `/dsh-mcp-manager/api`
the proxy buffers the JSON and drops rows where `readOnlyReason === 'loader'`
and the id is in `DSH_MCP_MANAGER_HIDDEN` (default
`browser-mcp,brave-devtools-mcp`). Live, version-independent, no restart, and
`DSH_MCP_MANAGER_HIDDEN=""` shows everything again. The boot patch is still
there as a belt-and-braces for the server-side list the tools read.

---

## §14 REA in the personal VM

The model can already build and test inside the computer. What it could not do
is answer *"how does this app work?"* with evidence: a stripped binary, an APK,
a `.dll`, an Electron `app.asar`, a model file. REA (`rea`, Reverse Engineer
Anything) is that answer, and it is a heavy one — its own Node, a JDK, Ghidra
and JADX, ~3.5 GB installed.

### Why it is a separate layer

The desktop provisioning (`docker/cua-guest-provision.sh`, marker
`/var/lib/cua-provision`, `MARKER_VERSION=6`) is about making a usable Linux
machine: Xorg on virgl, 1200×750, the 9p share, KVM access. REA is a specialty
toolchain that most workspaces never touch, and folding it in would charge every
computer ~3.5 GB and several minutes for something it does not need. So it lives
in `docker/cua-guest-rea.sh` with its **own marker, `/var/lib/cua-rea`**, versioned
by `REA_MARKER_VERSION` (default `1`, independent of the provision script's `6`)
and written **last**, only after `rea doctor --provider ghidra --json` passes.
Two markers, two lifecycles: bumping the desktop provision to 7 must not
re-download Ghidra, and fixing a JADX pin must not re-run Xorg. A computer
created without `rea: true` never runs the script at all; Start on a RE
computer re-runs it, and the marker makes that a no-op when nothing changed.

### The 40 GB floor exists in three places

Ghidra unpacks to ~1.4 GB; with the JDK, JADX, Node and `rea-agents` the kit is
roughly 3.5 GB installed. On a stock 20 GB disk the unzip dies with `ENOSPC`,
which looks like a corrupt download, not a sizing decision. So:

* **the panel** raises the Disk field to 40 the moment *Enable REA* is ticked,
  and floors the input at 40 while it is ticked (client-side, so the number on
  screen is the number sent);
* **the supervisor** clamps independently — `REA_MIN_DISK_GB = 40`,
  `effectiveDiskGb = rea === true ? Math.max(wantedDiskGb, REA_MIN_DISK_GB) : wantedDiskGb`
  — and returns `diskGbRaised`, so a tool-created computer is floored even with
  no panel in the loop;
* **the tool schema** says `Disk size in GB (Android and REA: 40)` and the `rea`
  property says it is raised to 40.

The **store quota is deliberately not raised**. `diskQuotaGb` is the user's
budget for the whole volume, and silently spending another 20 GB of their disk
would be the wrong fix. On a small policy the 40 GB disk is still created (it is
sparse) and carries `warnings[code: disk-over-policy]`; the panel explains that
the guest may hit the real disk ceiling — see 15.10.

### Awareness is gated, so a non-REA workspace pays nothing

A paragraph telling the model to reach for Ghidra is worth its tokens on a
reverse-engineering turn and is noise on every other one — worse, it would point
at a `rea` binary the computer does not have. But the prompt path is
synchronous and must never wait on a socket.

So `index.js` keeps `reaCache = { at: 0, vms: [] }` filled out of band, and the
section is a closure:

* `text: () => …` reads `reaCache.vms` synchronously; when the cache is older
  than `REA_CACHE_TTL_MS` (30 s) it schedules a refresh with `void` and answers
  from what it already knows;
* one initial `vmList` plus a 30 s interval, both inside `ctx.effect`, the timer
  `unref()`'d and cleared by the effect's disposer, so the cache is warm for a
  session that never opens the page and cannot keep the process alive;
* the cheap write-through points — `/cua/state` (which the panel already polls),
  `/cua/create`, `/cua/start`, `/cua/delete`, and `cua_vm_create` — call
  `refreshReaCache()`, so creating a RE computer adds the paragraph immediately
  and deleting the last one removes it;
* a refresh that fails does not retry per assembly: it moves `at` forward and
  keeps the names it had.

Empty cache, ordinary prompt: byte-identical to before, no socket, no tokens.
One or more RE computers, and exactly one extra paragraph names them.

### The registry-persistence trap

`ensure()` rebuilds a VM by re-creating it from the registry row. Its recovery
path used to write a **fresh literal** for the rebuilt entry — dropping
`gpu`, `android`, `diskGb` and `image` — so a RE computer that recovered from a
dead QEMU process came back as a plain desktop and quietly lost its kit. Both
literals now start from `...(known || {})` and the recovery path re-provisions
with `known?.rea === true` (`rea: rea === true` is kept in the created row, so
the next Start sees it). One thing is still out of scope: the recovered disk is
the base image, so a computer bigger than 20 GB does **not** get its disk grown
back automatically — `cua_vm_disk` is the explicit fix, and the size is still in
the row for the panel to show before it is grown.

### The build gate

`tools/check-cua-rea.mjs` asserts the chain hop by hop, because every hop is a
string: the guest script's marker, pin and doctor call; the supervisor's
`DSH_CUA_REA_SCRIPT`, `REA_MIN_DISK_GB`, `provisionReaGuest` call sites and
`...(known || {})` spreads; the Dockerfile's `COPY` of the script and its `RUN`
of the checker; and — the two files that only agree by spelling — `client.js`
(`rea: false`, `rea: draft.rea`) and `index.js`
(`rea: { type: 'boolean'`, `input.rea === true`). It accepts `--root` for the
flat image layout and prints every missing needle at once.

The Dockerfile copies the script at build time, and at the bottom of the stage
copies the five files flat into `/opt/seek-harness/cua-check/` and runs
`node /opt/seek-harness/check-cua-rea.mjs --root /opt/seek-harness/cua-check`,
then removes only the Dockerfile copy (`rm -f
/opt/seek-harness/cua-check/Dockerfile`, which is there to prove the two lines
above still exist); the other four flat copies stay in the image. A renamed
script or a dropped `rea` field fails the build instead of shipping a plain
desktop that reads like a RE workstation.

### Evidence

Stage 1 (`9d8033c`, guest script + supervisor + gate + Dockerfile): `bash -n`
on both new/edited scripts green, `node --check` on the supervisor green,
`node tools/check-cua-rea.mjs` at **60/66** — the three stage-1 files fully green
and exactly the six stage-2 needles (three in `client.js`, three in `index.js`)
red, which is what a gate is supposed to look like before its half exists.
This commit closes those six: the gate is **66/66** with `node --check` green on
both plugin files.

---

## 15. Branch `cua-vm-improve` — shutdown that powers off, accounting that adds up

From `main` (`1986ed2`). Six items, each green and committed; the full handoff is
REPORT.md §9, the plugin's own documentation is `plugins/dsh-cua-vm/README.md`.

### 15.1 The two state machines

`registry.json` is v2 (`{version:2, vms:{}}`) and migrates v1 **on read**: a row
gains `kind`/`backend` (a `backend:"windows"` row keeps its kind), the file is
rewritten, and no one has to delete their store. Every row also records
`restoreFrom` after a shutdown, which is the field `cua_vm_start` reads.

The shutdown state machine is the piece that was missing:

```
ready ──suspend──▶ suspended ──resume──▶ ready
ready ──shutdown─▶ close ports → system_powerdown → wait → [quit] → checkpoint → sb rm
                                                    └──▶ powered-off ──start──▶ create from checkpoint → ready
```

`powered-off` deliberately has **no** edge back through `resume`: the sandbox is
gone, so `cua sb resume` can only fail. That is the "stopped VM can never resume"
trap, and it is why `cua_vm_start` exists as its own tool.

### 15.2 Why the store line moved

`du -sb $CUA_HOME/.cua` was the whole story when the store held one image and one
delta. It is not any more: a checkpoint is a flattened 6 GB disk, screenshots
accumulate, and a Windows computer keeps its sparse disk under `$STORE/windows`.
The line adds five disjoint roots (`Windows` and the ISO cache included), and the
quota is charged on **real bytes**: a transient write whose real size is known
(the ISO download, a checkpoint convert) is `used + requested > quota`, refused
before it is written — the old `used > quota` let the last create discover the
overrun as ENOSPC inside a download. Create-time is different: a qcow2 disk is
sparse, so the virtual size is never charged; see 15.10.

### 15.3 The coordinate contract, in one sentence

`cua do click` takes **screenshot** pixels and maps them itself, so the tool
measures the two spaces (`xdotool` geometry vs the PNG's IHDR, cached 30 s) and
prints `screenshot WxH · display WxH · scale N` — and, when they differ, "image px
= 0.9375 × display px; cua maps it — do not rescale".

### 15.4 The Windows kind, and what it is not

`dockurr/windows` on a DinD engine is a real Windows computer for the *desktop*:
QMP `screendump` for frames, `input-send-event` for clicks and ASCII keys, and the
container's own 8006 console relayed to `/vm/port/<name>/`. The monitor is on
**7101**, not 7100: the pinned image already binds 7100 for its own HMP monitor,
and a second bind kills QEMU at boot. A local ISO is `/boot.iso` (there is no
`ISO` variable in v4.35); `VRAM_SIZE` and `SHUTDOWN` are not set because the
image ignores them. Suspend is `docker pause`. It is **not** a cua
sandbox: no guest agent means no exec, no put/get, no disk growth, no clipboard,
no a11y tree and no window list — each of those answers "not available for
Windows" with the paths that do work, instead of a timeout the model reads as a
broken VM. `DSH_CUA_VM_WINDOWS=0` removes the option entirely.

### 15.5 Gates

* `tools/check-anchors.mjs` — **14 assertions**, offline: both build-time bundle
  patches apply to minified fixtures and still refuse a moved anchor.
* `tools/check-cua-vm.mjs` — **315 assertions** across 16 files (the gate prints
  its own total, so a doc cannot drift from it): registry v2 + the
  migration, the four policy keys, the 0600 credentials, the accounting roots and
  the quota rule, the delete manifest, GC, the shutdown/QMP/checkpoint/start
  chain, the spec normaliser and the GPU default, the measured space (including a
  `FORBIDDEN` rule for `/cua-vm/shots` and `Math.sqrt(900000`), the Windows env
  mapping and QMP arguments, the proxy's relay rewrite, and the compose wiring.
* `tools/check-cua-rea.mjs` — **67 needles** across 5 files, with exactly
  **three** spellings changed in the same commit because the refactor moved where
  they live (the create flags into the spec normaliser, `diskGb` into
  `createManaged`, the recovery-row merge into `fresh.vms[name] || known`). No
  needle was deleted.
* `tools/ci-gates.mjs` — registered, so a bare checkout answers it in seconds:
  **7 passed / 0 failed / 3 skipped** (up from 6).

### 15.6 Evidence

`node --check` on all seven `.mjs`, `bash -n` on the guest script, both gates
green (315 assertions / 67 needles), `ci-gates` 7/0/3, and the runtime suite in `tests/`
that need no image: a supervisor smoke on a throwaway store with a stub `cua`
(82 assertions: migration, quota, manifest, GC, shutdown, cold boot, and the
review regressions — missing `cua`, traversal names, an abandoned QEMU that
must not be touched, target switching, a concurrent exec burst), a real `qemu-system-x86_64 -S` shutdown
(timeout → quit → `mayBeTorn`), an ACPI-refusal fallback against a
protocol-level QMP peer, and unit tests for the two new modules. A real guest
boot and a Windows install are **NOT RUN** — no `cua` runtime store, no
`qemu-img`, and creating a Windows container is a mutation on a shared engine;
both are listed as TBC in REPORT.md §9.5.

### 15.7 Review round 3 — depth and source audit

Sixteen supervisor defects (S1 GC/lifecycle races, S2 unread `mayBeTorn`, S3
missing per-computer locks, S4 unguarded `vmm/qemu` removal, S5 row deleted after
a failed `sb rm`, S6 missing `image` default, S7 missing fallback cleanup, S8
registry errors swallowed as empty, S9 migration outside the lock, S10 quota
check-then-act, S11 no quota before a checkpoint, S12 no re-check after `quit`,
S13 previews not restored, S14 unguarded manifest step, S15 success reported for
a partial delete) and ten Windows defects (W1 QMP port collision with dockurr's
7100 HMP, W2 nonexistent `ISO` variable, W3 dead `VRAM_SIZE`/`SHUTDOWN`, W4
uncompensated container on a failed registration, W5 no Windows suspend, W6
`paused` counted as ready, W7 dead `file` field, W8 screendump name race, W9
silently ignored `save`, W10 overstated docs). The per-defect table is
REPORT.md §9.5; the gate gained a needle or a FORBIDDEN rule for every mapping
change (notably: VRAM_SIZE, SHUTDOWN and ISO are now forbidden strings).

Three residuals from that round: R1 the delete verdict counted a `skipped` item
as complete (a disk kept under a live QEMU was reported "destroyed" and became
unreachable) — `complete` now requires every item removed, the row stays orphaned
while the disk does, and `cua_vm_gc` reclaims it once cua and the pid agree it is
safe; R2 the registry write moved inside the manifest's step wrapper, so a corrupt
registry yields a structured partial result instead of a bare throw; R3 the
boot-time and timer-time registry reads are guarded, so a corrupt file logs and
skips the Windows watches instead of killing the process after the socket exists.

### 15.8 Architecture change — Windows is direct QEMU

The Docker/DinD Windows backend is gone. Windows is a first-class QEMU computer:
OVMF + swtpm + qcow2 under `/cua-vm`, a pinned Microsoft ISO (downloaded once or
`windowsIso`), an unattended answer file that installs OpenSSH/Python/dsh-cua, QMP
for frames+input, VNC relayed as the live view, SLIRP networking with the host at
`10.0.2.2`. It reuses registry v2 (`backend: 'qemu'`), the locks, the quota
reservation, the shutdown/checkpoint path and the delete manifest (which now
removes the Windows tree and the swtpm socket).

Agent surface: exec/put/get over SSH (Session 0, cmd.exe), the desktop over QMP
(ASCII-only, no clipboard, no a11y, no cursor overlay), and the guest's dsh-cua
MCP tools attached lazily over SSH only while a Windows computer is ready
(`DSH_CUA_VM_WIN_MCP=0` disables it; ~3-8k tokens while attached, zero otherwise).
The live view is noVNC over websockify through the existing relay pipeline.
Honest ceilings and the nvidia-smi host-handle note are in the READMEs.

### 15.8.1 Pre-verdict fixes

Eleven defects from the pre-verdict review, all fixed in `cua-vm-improve`:
VNC display-vs-port (QEMU binds 5900+display — the argv now passes the display,
pinned by a unit test), the Windows checkpoint writing the Linux path (one
writer, fed from `$STORE/windows/<name>/disk.qcow2`; Start converts it back),
plugin copy still describing the container backend, `installComplete` never set,
an aborted shutdown reopening a relay to a killed websockify, a leaked swtpm on a
failed boot, a leaked websockify on a rejected relay, the port-allocation race
(now under `withLock('@ports')` + an in-memory claim), the firstboot header
claiming a consumer that does not exist, a 30 s tool linger (now 5 s), and the
answer file's schema order (reordered, deprecated OOBE skips removed, order
pinned by needles).

### 15.8.2 Pre-verdict round 2

F1 was a regression introduced by the first fix: the call sites were swapped, so
the Linux shutdown looked for a Windows path (no checkpoint at all) and the
Windows one looked in the cua vmm tree. Each shutdown is back on its own disk,
the pair is pinned by gate needles, and the smoke asserts both directions (with a
`qemu-img` stub, since this host has none). F2 cleared the last user-visible
container copy (plugin README kinds + env table, the panel's kind picker and
provisioning blurb). F3 fixed the failed-create port release — `Object.values` of
a `Set` is `[]`, so it had been a no-op; it now releases exactly the three ports
that create claimed.

### 15.8.3 Jury round

Thirteen defects from the three-juror pass: the xhci arg order (QEMU parses argv
left to right — a semantic gate assertion now pins it), the four dead ISO URLs
(only Server 2025 is pinned; the rest refuse by name and require `windowsIso`),
the VNC-banner readiness lie during Setup (SSH-only until post-install), the
watcher's timestamps/locking/state guard, the unlocked Start (double boot on one
pidfile), the missing `stale`/`mayBeTorn` producer, no post-boot verification,
the unguarded Windows unlink in destroy, port reconciliation on start, ISO
download integrity (short-read abort, atomic rename, no stale `.part`), ISO
accounting + GC, `python.exe` alias detection, double provisioning (idempotent
marker), the MCP in-flight guard, scp path/timeout hardening, the live view on
resume, region crops, virgl honesty, read-only vvfat, the container-string sweep,
case-insensitive FORBIDDEN, canonical `backend: 'qemu'`, and the tests committed
under `tests/`.

### 15.8.4 Re-jury round

Ten residuals: the live view was killed on every second call (reuse-first now),
`region`/`scale` never reached the Windows branch, the ISO prune ignored the
"keep for ever" policy and would have deleted the shared virtio-win ISO, port
reconciliation ignored other rows' reservations, the ISO download was
unreserved, resume never rebuilt the preview, the status page timed from
`createdAt`, the migration comment lied about the backend value, and the virgl
branch was unreachable because nothing ever set the flag — it is now decided once
at create (capability probe + render node), stored on the row and reused.

### 15.8.5 Final-acceptance round

Z1 was a real regression with a subtle cause: rows carry no `name` field, so the
"skip the subject" comparison in the port reconciliation never matched and every
Windows cold start re-allocated all three ports. The name is now passed in and
the subject's own ports are subtracted, which the smoke proves (`portsChanged:
false`, same triple on two consecutive starts). Z2 releases the create's port
claim when the row is written (the row is the source of truth), Z3 derives the
ISO allowlist through the same name normalisation the download uses, and Z4
treats an existing raw relay as the live view when websockify is absent.

### 15.8.6 CI drift: the bundle patch anchors

The pushed branch failed its image build at `Dockerfile:394`. It was not this
branch: `git diff 1986ed2..HEAD` over the two patchers, the probe and the
Dockerfile patch steps is empty. `dsh-v0.2.2-rc.3` (the tag CI resolves) began
shipping a MINIFIED `lib/client.js` — backtick literals, one line — and every
anchor was a literal with double quotes and newlines (`"plugins.item": {` …).

Re-anchored as SHAPES (either quote style, any whitespace) in
`patch-plugin-manager-page.mjs`, `patch-sidebar-footer.mjs` and
`probe-anchors.mjs`; the sidebar's CSS-modules map is now reconstructed from the
stylesheet's hash prefix because the literal map is gone. A splice-order bug in
the plugin-manager patch (declaration replaced before the render site, shifting
the index) was found and fixed by the same tests.

The guard then failed its own first CI run (43727653717) in the image layout: it
spawned children with cwd-relative paths, so from `/` (docker build's default) the
probe looked for `/tools/probe-anchors.mjs` and exactly two assertions failed.
Every path now comes from `import.meta.url` and children run with `cwd: HERE`;
verified from the repo, from `/`, in a flat `/opt/seek-harness/tools/` layout, and
negatively in both.

New: `tools/check-anchors.mjs` with minified fixtures under `tools/fixtures/`
— it applies both patches, re-runs them (idempotent), and proves the refusal
still fires when an anchor is renamed. Hard gate in `ci-gates`, and a `RUN` step
before the real patches in the Dockerfile.

### 15.8.7 Policy change: Windows floors are warnings

`windowsCreateManaged` no longer clamps or refuses a below-floor Windows computer.
64 GB / 6 GB / 2 vCPU are the **defaults**; asking for less creates it anyway and
carries `warnings[]` (`disk-below-floor` / `memory-below-floor` /
`cpu-below-floor`) in the result and in the registry row. The quota was described
here as "refuses a disk that does not fit" — that part is superseded by 15.10:
the create refuses only real usage over the policy, and a virtual disk bigger
than it is created with `disk-over-policy`. The REA 40 GB clamp and the Windows
REA/Android refusals are unchanged. The advice is one pure function
(`windowsCapacityWarnings`), and the smoke covers both directions (below-floor
create warns; omitted create returns the defaults with no warnings).

Also added: **Windows 11 IoT Enterprise LTSC 2024** as `windowsVersion: "11ltsc"`
(alias `ltsc11`), pinned from Microsoft's Evaluation Center link and probed live
(HTTP 206, 5,060,020,224 bytes). The other four versions still refuse with a
remediation because their evaluation media answers 400.

### 15.9 Review round 2

Seven defects fixed on this branch (D1 spawn crash, D2 path traversal through
`name`, D3 unproven-dead checkpoint, D4 capture on the wrong target, D5 registry
write races, D6 orphan container, D7 doc counts), plus the residual that the D3
fix left behind: the `stale` flag was READ by `startFromCheckpoint` and written
nowhere, so the refusal was dead code. The abandoned branch now marks an existing
restore point `{stale: true, staleReason}` in the same write as
`lastShutdown.method: "abandoned"`, a clean shutdown overwrites `restoreFrom`
wholesale, and the gate asserts both the producer and the reader. The reasoning is
in REPORT.md §9.4 and five of the seven are covered by new assertions — `runCua` and
`assertVmName` and `mutateRegistry` and the abandoned-shutdown branch are now
gate needles, so none of them can be refactored away silently.

### 15.10 A sparse disk is not bytes: the create-time quota regression

User report: creating a Windows computer on a 15 GB policy failed with "a 64 GB
disk does not fit the VM store quota (15 GB)" while the store held a few hundred
MB. The create paths charged the **virtual** requested size
(`reserveStoreBytes(name, diskGb * 1024 ** 3)` and
`reserveStoreBytes(name, effectiveDiskGb * 1024 ** 3)`), and `refuseOverQuota`
compares `used + requested > quota` — so the 64 GB default refused every Windows
create on the shipped 20 GB policy, contradicting the branch's own "the quota
counts real bytes" rule and the warnings-not-refusals change in 15.8.7.

Now, on **both** create paths:

* the disk reservation is `reserveStoreBytes(name, 0)` — no virtual bytes are
  charged, and the call still runs under the store lock, so a store whose **real**
  usage already exceeds the policy is refused with a sentence that names the real
  bytes (`16.0 GB of real store data > 15 GB`), not the virtual request;
* a requested disk bigger than the policy is **created** with
  `warnings[{ code: "disk-over-policy", message }]` (result, registry row, tool
  text), built by one pure helper `diskPolicyWarnings(diskGb, config)`; Linux
  gets the same warning (a 40 GB REA disk on a 20 GB policy);
* `reserveStoreBytes` remains for transient writes whose real bytes are known
  (the Windows ISO download), and the shutdown/checkpoint guards keep calling
  `refuseOverQuota` with the real disk delta — unchanged;
* the Windows 64 GB default is still the requested value, it is just no longer
  mistaken for consumption.

The old sentence is a **forbidden** pattern in `tools/check-cua-vm.mjs`, and new
needles pin the helper, the warning code, both zero-byte reservations and the
real-bytes refusal text. The gate total moved 315 → **325** assertions in the
checkout (**324** in the flat image tree), and `tests/supervisor-smoke.mjs`
carries the reported case end to end: quota 15 + real usage low + default 64 GB
→ created with `disk-over-policy`; real usage over the quota → refused without
creating a row.

### 15.11 `--chmod=0644` on a directory: the Windows OEM permission bug

User report, on a freshly pulled and recreated hardened container
(`cap_drop ALL`, `read_only` rootfs, `USER node`): `ls
/usr/local/share/cua-vm/windows-oem/` answered **Permission denied**, and every
Windows computer create failed — while the three files were verifiably present
in the pushed layers.

**Who runs the supervisor.** `docker/entrypoint.sh` starts
`node /usr/local/bin/cua-vm-supervisor` **as the container user**, and the
Dockerfile ends with `USER node` (uid/gid 1000; `USER node`, not `node:node`, so
the supplementary `kvm` group survives). There is no uid-0 supervisor and no
`group_add` that could help here: the payload is read by uid 1000.

**The defect.** `COPY --chmod=0644 docker/windows-oem/ <dest>/` does not only
mode the FILES — Docker applies `--chmod` to **every** entry it copies, the
directories it creates included, and to the intermediate `/usr/local/share/cua-vm`
parents it invents. Measured against this base image the destination arrived as
`drw-r--r-- root:root`: files 0644 (fine), **directories 0644 (not traversable)**.
A 0644 directory denies `openat`/`getdents` to every non-root process, so `ls`
said "Permission denied" and `writeOemPayload` died in `readFileSync`.
`existsSync()` answers **false** on EACCES, so `resolveOemSourceDir()` also
concluded the payload was *missing* and the user was told to pull a newer image —
the wrong fix for a mode-bits defect, and the reason this looked like a missing
layer rather than a permission bug. The same trap existed on the `/opt/seek-harness/cua-check`
COPY (the supervisor's runtime OEM fallback), on `COPY --chmod=0644 office-skills`
(`DSH_BUNDLED_SKILL_DIR`, including its `pdf-documents/` subdirectory), and on the
single-file COPYs whose destination directory they create themselves
(`/opt/office-native`, `/opt/ocr-tools`).

**The fix (no extra capability, no root, read-only rootfs untouched).**

* `RUN install -d -m 0755 /usr/local/share/cua-vm` before the copy;
* `COPY --chown=1000:1000 --chmod=0644 docker/windows-oem/ …` — files stay data
  files (0644) and are owned by the runtime uid;
* `RUN chmod -R a+rX /usr/local/share/cua-vm/windows-oem` — `a+rX` is the exact
  semantics needed: read for all, execute only where traversal requires it
  (directories, plus files that already were executable). `COPY` into the tree
  and this normalisation are what make it correct for subdirectories a future
  payload file adds;
* the same three-part treatment for `/opt/seek-harness/cua-check`,
  `/opt/dsh-office/office-skills`, `/opt/office-native` and `/opt/ocr-tools`;
* `COPY --chmod=0644 office-skills` also had to lose its directory stamp — the
  entrypoint exports that tree as `DSH_BUNDLED_SKILL_DIR`, so an untraversable
  `office-skills/` silently hid the PDF skill.

**The error text was part of the bug.** `oemPayloadDirStatus()` now separates
"absent" (ENOENT/ENOTDIR) from "denied" (EACCES/EPERM), `oemPayloadDeniedDir()`
picks the candidate to blame, and `writeOemPayload()` throws
`oemPayloadDeniedError` — naming the uid, the path, the mode/owner of the first
entry it *can* describe (walking up past an untraversable parent), the
`install -d` / `--chown` / `chmod -R a+rX` fix, and the honest no-rebuild
workaround (a read-only bind mount from a checkout — `chmod` cannot work under
`read_only: true`) — instead of the pull-a-newer-image advice. `existsSync` is gone from that decision path for exactly this reason.

**Verification.** A uid-1000 proof runs at the end of the stage, so this can never
ship again:

```dockerfile
RUN set -eux; for dir in /usr/local/share/cua-vm/windows-oem /opt/seek-harness/cua-check; do
      setpriv --reuid=1000 --regid=1000 --clear-groups sh -c "test -x '$dir' && test -r '$dir'" …
```

It reads all three files in both the runtime path and the fallback tree.
Replaying the old COPY line through the same RUN reproduces
`EACCES: /usr/local/share/cua-vm/windows-oem is not traversable by uid 1000 (dir mode 644 root:root)`
and fails the build; with the fix the same image answers `drwxr-xr-x node node`
and `writeOemPayload` succeeds as uid 1000 (`OEM payload written (3 files + $OEM$ scripts)`).
New gate needles (338 → **346** assertions in the checkout, **345** in the flat image tree) pin the `install -d`,
the `--chown`, the `a+rX` normalisation, the `setpriv` proof and its two failure
strings; **K6** asserts the EACCES classification exists at all, and
`tests/modules-unit.mjs` reproduces the defect with a `chmod 0o644` directory
(root is skipped as NOT RUN, since it bypasses DAC).

## 16. Branch `cua-vm-improve` — a Windows create that dies must say why

**The report (live, read-only forensics on the user's container).** A
`cua_vm_create` with `kvm: true, cpu: 4, memory: 8, diskGb: 40` for
`kind: "windows"` produced a row that never moved: `supervisor.log` ended at
`windows: win-test qemu started (pid 906, installing)`, pid 906 was gone,
`$STORE/windows/win-test/serial.log` was **0 bytes**, `disk.qcow2` stayed a
193 KiB empty header for 21+ minutes, `qemu.pid` was **never written** and
`swtpm.log` said `Data client disconnected` ~60 ms after the serial device was
opened. The row then sat at `installing (N min): undefined answering, QMP not
running` — a sentence that was wrong **twice** — for the full 60-minute timeout
and flipped to `error` with an empty serial tail.

**Why nothing on the host explained it.** Two independent bugs and one
misleading reporter:

1. **QEMU's stderr went to `/dev/null`.** `spawn(WINDOWS_QEMU, argv, { stdio:
   'ignore' })` — and `-serial file:` records the **guest** console, not QEMU.
   A QEMU that rejects its own argv (an unusable `-display egl-headless,
   rendernode=…`, a `/dev/kvm` this uid cannot open, a missing firmware file)
   explains itself on **stderr**, so the diagnosis was discarded at the source.
2. **"spawn returned a pid" was treated as "it is installing".** `boot()`
   returned `{ pid }` and the watcher waited 15 s at a time for 60 minutes,
   never asking whether the pidfile QEMU writes **after init** existed.
3. **The progress formatter interpolated a raw field.** `ready()` early-returns
   `{ ready: false, phase, ...state }` — **without** `endpoint` — when
   `state.alive` is false, and the watch loop printed
   ``${verdict.endpoint} answering`` → `undefined answering`; `status: ''`
   became `QMP not running` through `||`.

**The fixes.**

* **F1 — capture.** `qemu-stderr.log` (and `qemu-stderr-retry.log` for the
  degraded retry) under `$STORE/windows/<name>/`, opened per attempt with
  `openSync(…, 'w')` and handed to the child as **both** stdout and stderr. Every
  failure path (create, start, watchdog) puts the last ~20 lines into the row
  (`error`/`errorLog`), the supervisor log and the thrown error, and names the
  file.
* **F2 — a short boot window, then the truth.** `waitForQemuBoot()` requires the
  **pidfile** to exist *and* its pid to be alive within `qemuBootWindowMs()`
  (15 s, `DSH_CUA_WINDOWS_BOOT_SETTLE_MS` for tests), resolving **early** when
  the child exits. `boot()` now **throws** `QEMU_INIT_FAILED` for a dead init
  instead of returning a pid. The install watcher takes its **first** tick after
  `windowsEarlyDeathWindowMs()` (5 s) and flips the row to `state: 'error'` with
  the captured stderr immediately — no 60-minute wait. It distinguishes "not yet"
  from "never" via the child's own exit state (`childState`), so a QEMU that has
  not written its pidfile yet is not declared dead.
* **F3 — the display may degrade, the accelerator may not.** A start that fails
  with an EGL/render-node/virgl error retries **once** with the `gpu: false` argv
  shape (`-display none` + `VGA,vgamem_mb=32`) and records
  `warnings[{ code: 'gpu-fallback', message: 'virgl/EGL display unavailable on
  this host (<captured line>); continuing without GPU display — Windows renders on
  emulated VGA/WARP as documented' }]`; the row stores `virgl: false` and
  `gpuFallback: true`. A **KVM** failure (classified first, so a mixed
  EGL+KVM message still counts as KVM) is **never** degraded — the preflight owns
  that fix and the captured stderr is surfaced.
* **F4 — a sentence with two honest headlines.** `formatWindowsInstallDetail()`
  is the only place the progress line is built: `QEMU not alive (see
  qemu-stderr.log tail)` when the pid is gone, and, when the guest is alive but
  no endpoint answers, `waiting for SSH on 127.0.0.1:<port>` plus the serial tail
  and the readiness signals. A last-line `.replace(/\bundefined\b/g, 'unknown')`
  makes the reported artifact impossible. `vmWindowsStatus` also answers a
  sentence for a row that never got one (the old `meta.installDetail` path could
  return `undefined` for a start that died before the first tick).
* **F5** was already fixed on this branch: `vmCreate` carries the
  `diskGiven/memoryGiven/cpuGiven` flags (`normaliseSpec` fills the LINUX
  defaults, so the panel's `create` used to look like "nothing was given") and
  the row stores the requested `diskGb/cpu/memory`; this round keeps those
  needles and adds the `requested: { diskGb, memory, cpu }` echo.

**Verification.** `tests/windows-boot.mjs` (new) drives `boot()` against a stub
QEMU and pins F1–F3 directly: a clean start, an EGL failure that retries with
`display=none` (argv log proves **one** retry and the exact shape), the warning
text, the captured `qemu-stderr.log`, a KVM failure that throws with the excerpt
and is **not** retried, plus `waitForQemuBoot`/`classifyQemuInitFailure` units.
`tests/supervisor-smoke.mjs` adds a create that dies at init (fails with the
stderr inline, no row left) and a start that dies just after boot (row `error`
with `errorLog` = the captured line), and `tests/modules-unit.mjs` pins the two
formatter headlines. Gate needles: `check-cua-vm` 428 → **470** assertions in the
checkout (469 flat), including three new **FORBIDDEN** rules — `stdio: 'ignore'`
for the Windows QEMU spawn, the `undefined answering` template, and (existing)
the virtual-disk quota sentence.

## N1–N3 — two live-verified boot defects, and the blind spot that hid them

Both were reproduced on the container with QEMU 10.0.13, in the order a real
Windows create hit them.

**N1 — the boot window was 0 ms on every real host.** `qemuBootWindowMs()` read
`Number(process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS ?? '')`. An UNSET variable
becomes `Number('') === 0`; `0 >= 0` passed the guard; the function returned 0
and the `return 15000` fallback was **unreachable**. `waitForQemuBoot` then
polled once against an already-expired deadline and reported a QEMU that was
~1 ms old as *"died during init (none): no stderr output"* — the exact live
message. `windowsEarlyDeathWindowMs()` had the same `Number(env ?? '')` shape, so
the install watchdog's first tick also fired with no wait.

*Fix:* both read the **raw** string and parse only when
`raw !== undefined && raw !== ''`, so unset and `''` reach the 15000 / 5000
fallbacks while an explicit `'0'` is still honored as 0. `waitForQemuBoot` also
clamps the **effective** window to one poll interval (`pollMs`, ≥10 ms): a zero
window no longer means "check once, immediately", it means the shortest window
there is — the loop always observes one real interval before a timeout, and a
pidfile that lands during it is accepted.

**N2 — the OEM USB stick could not be attached.** `fat:ro:` vvfat is a
read-only BlockBackend and `usb-storage` needs a writable node, so
`-device usb-storage,drive=oem0,bus=xhci.0` was refused with
`Block node is read-only` at ~118 ms (pidfile never written, `serial.log` 0
bytes). *Fix:* `read-only=on` on the `-drive`, which marks the **medium**
read-only (a write-protected stick) instead of the node; the device is
unchanged. Verified bootable on QEMU 10.0.13. `fat:rw:` is not an alternative —
this image's rootfs is read-only and vvfat in rw mode wants `/var/tmp` (EROFS).

**N3 — the blind spot.** `tests/windows-boot.mjs:94` sets the settle window and
`tests/supervisor-smoke.mjs:242` sets both variables, and a test that supplies a
number can never observe the default. The new assertions **delete** them instead:
`tests/modules-unit.mjs` (unset → 15000 + 5000, `''` → 15000, `'0'` → 0,
`'1500'` → 1500, unparsable → 15000, `'999999'` → the 120000 cap, and the
`windowMs: 0` poll floor), `tests/supervisor-smoke.mjs` (a real supervisor with
**both unset** and a stub QEMU that writes its pidfile only after ~100 ms — the
live failure shape, through the create handler), and `tests/windows-boot.mjs`
(the same late pidfile through `backend.boot()`).

Gate needles (added, none deleted): the new OEM argv in the M9 class of
`tools/check-cua-vm.mjs`; in `tests/modules-unit.mjs` the `read-only=on` argv
match plus "no `fat:rw:`", and the `raw !== undefined && raw !== ''` shape of the
early-death reader. `usb-storage,drive=oem0,bus=xhci.0` is untouched, so M9 still
pins both halves.

**Verification.** Live replay against `/usr/bin/qemu-system-x86_64` with a store
copied under `/tmp` and both env vars unset: `BOOT OK pid=4780 in 177 ms`,
`qemu.pid` written, `serial.log` present, `qemu-stderr.log` empty. Gate **475**
(checkout) / **473** (flat, L5 + N3 `n/a`), `check-cua-rea` **67**, `ci-gates` 9/1/1
(`check-office` is pre-existing), and all four suites PASS. No Windows *install*
(OOBE) was attempted: the replay proves QEMU accepts the argv and initializes.

## 17. Branch `cua-vm-improve` — 2026-11-17: sixteen versions, two firmwares, a gated bridge, a real clipboard

Six packages landed together because they share one seam: the Windows computer is
a **catalog row** (what it installs, how it boots, which media) and everything the
model touches on it is **gated state** (which tools exist, for which session, for
how long). Each package below is problem → change → the command that proves it.

### A. The sixteen-code catalog, and an ISO chain instead of a URL

**Problem.** `windowsVersion` knew six spellings and only two of them could
actually download anything: the five-version list was an artefact of the
Evaluation Center, and on 2026-11-15 four of its five pinned URLs answered
**HTTP 400** (the media moved behind a session-token page). "Windows 11
Enterprise" and "Server 2019" had no spelling at all, so every caller had to hand
in a `windowsIso`. A refusal for a spelling that exists reads as a make-believe
catalog; a 400 halfway through 5.5 GB is worse than no pin.

**Change.**
* `WINDOWS_VERSIONS` is the dockur/windows vocabulary — `11, 11l, 11e, 10, 10l,
  10e, 7u, xp, 2025, 2022, 2019, 2016, 2012, core11, tiny11, tiny10` — one
  `WINDOWS_CATALOG` row each, carrying `sizeGb` (the store reservation), `bios`
  (the firmware profile) and `selection` (the `<InstallFrom>` Setup installs).
* `WINDOWS_VERSION_ALIASES` is frozen and maps the old spellings into it
  (`ltsc11`/`11ltsc` → `11l`, `ltsc10` → `10l`, …); an unknown one throws with the
  full list instead of defaulting to Windows 11.
* `xp` is **listed and refused** with `code: legacy-installer-unsupported` — its
  Setup waits for `winnt.sif` from a floppy/ISO root, which this payload does not
  build. The refusal fires before a download or a spawn.
* A version is an ORDERED chain (`mido` → `esd` → `link1/link2/link6` →
  `midoDirect`), each entry pinned by byte count and SHA-256. The download is
  checked against `Content-Length` and hashed while it streams; a mismatch throws
  `iso-digest-mismatch`, and a verified file gets a `.sha256` sidecar so the next
  create does not re-hash it. `isoFileName` is a function of the URL again (it
  used to append random bytes, so the reservation and the write named different
  paths and every restart re-downloaded).

**Verify.**
```bash
node tools/check-cua-vm.mjs --root .        # catalog + sources sections, and the
                                            # semantic "sixteen codes / xp refuses" block
node tests/modules-unit.mjs                 # per-code chains, tiny10 = archive.org only,
                                            # verifyIsoDigest (right/wrong hash), isoFileName
node tests/windows-boot.mjs                 # xp refuses BEFORE spawn (no argv line)
```
Data, per code, with URLs and digests: `docs/windows-iso-sources.md`.

### B. Firmware is a profile, not a boolean

**Problem.** The backend was written for Windows 11 and hard-coded its firmware:
q35 + OVMF + swtpm + virtio-blk + virtio-net. Windows 7 x64 Setup boots under
**BIOS only** — handed OVMF it reaches "Press any key", finds no bootable device
and drops into the EFI Shell — and the swtpm is a device its installer has never
heard of. Five separate decisions had to move together; leaving any one at its
UEFI value produces a QEMU that starts and a guest that never boots, which reads
as "the ISO is corrupt".

**Change.** `WINDOWS_FIRMWARE_PROFILES` names the two computers: `ovmf` (q35, UEFI,
TPM2, virtio) and `seabios` (`pc`/i440FX, no pflash, no TPM, IDE, e1000e).
`buildQemuArgs()` branches on `firmware.bios` for the machine spec, the pflash
pair, the TPM trio, the disk model and the NIC. The profile is resolved once per
boot (`spec.firmware` → declared version → the `firmware.json` marker the create
wrote → the MEDIA FILE NAME → OVMF), so a Windows 7 computer that restarts without
a `windowsVersion` on its row still comes back on `pc`. `DSH_CUA_WIN_LEGACY_BIOS=0`
refuses the BIOS path instead of quietly changing firmware.

**Verify.**
```bash
node tests/modules-unit.mjs   # 7u profile = seabios/pc/no-tpm/ide-hd/e1000e;
                              # 7u argv has no pflash and no TPM; 11 argv keeps both
node tests/windows-boot.mjs   # a real boot on the stub: -machine pc,accel=kvm,
                              # no if=pflash, no swtpm socket created, IDE disk,
                              # and the staged answer file still has <InstallFrom>
```

### C. The Windows MCP bridge: a namespace, three gates, and a teardown that cannot leak

**Problem.** The bridge registered ~19 tools on the HOST-GLOBAL registry and its
only teardown was a 5 s heartbeat inside one `apply()`. A computer deleted or
stopped still left 19 dead `mcp__windows__*` schemas in **every** session's tool
list, costing context and answering "connection refused"; a second ctx or a
reloaded plugin could not take them down at all. It also attached whatever row
happened to be `ready`, so a session could drive the wrong computer, and the names
it invented (`cua_win__*`) were not MCP names.

**Change.**
* `WIN_MCP` is module-level process state, with `registrations: Map<name,
  dispose>` filled by hand — so `teardown()` can run from the state poll, the
  guest client's `onClosed`, a plugin dispose or a per-agent pre-step, and always
  removes exactly what it registered (the map is emptied BEFORE the disposers run).
* `vmWindowsMcp({ name })` REQUIRES a name (no "first ready row"), and
  `vmWindowsMcpState({ name })` is the cheap read the poll uses (registry + ports,
  never SSH). The supervisor also grew a real push stream (`subscribe` →
  `vm-state` / `vm-removed` / `ping`).
* Three gates, all in the plugin: the **grant** (Computer Use, in memory, per
  session, OFF by default, `/dsh-cua-vm/cua-grant`), the **reveal**
  (`windows_desktop`), and the **guard** (`tools.guard`, which refuses a name that
  is still visible with `code: vm-offline | grant-off | reveal-required`).
* Naming: `TOOL_PREFIX = 'mcp__windows__'` through `windowsToolName()`, plus
  `windows_mcp_doctor` reporting the raw prefix surface so a leak is visible.
  Keepalive `ServerAliveInterval=10` × `CountMax=2`.

**Verify.**
```bash
node tools/check-cua-vm.mjs --root .   # index/winMcp/supervisor sections + the
                                       # FORBIDDEN "no first-ready fallback" regex
node tests/windows-mcp-gate.mjs        # 19 registrations; powered-off and removed
                                       # both call EVERY disposer and leave zero
                                       # prefixed schemas; every agent's deny set is
                                       # all 19; guard returns vm-offline; the
                                       # pre-step self-heal clears a leaked session
                                       # and calls next() once
```

### D. The clipboard: an agent in the user's session, and a bridge in front of noVNC

**Problem.** Two obvious routes are dead and both were tried live: an RFB
`ClientCutText` is accepted by QEMU and dropped (no clipboard agent in the guest,
so the paste "succeeds" and pastes the PREVIOUS clipboard), and `Set-Clipboard`
over SSH lands in Session 0's empty clipboard. The panel's two on-demand tasks
worked but could not prove anything: `schtasks /run` only QUEUES, so the body's
exit had to be polled, and the content was never verified.

**Change.**
* `docker/cua-clip-agent.ps1` — an in-session loop registered by firstboot as
  `cua-clip-agent` (`/sc onlogon /it /rl LIMITED`): watches the clipboard, writes
  `clip-current.txt`, polls `outbox\clip-<seq>.json`, sets the clipboard and
  writes `clip-ack.json` with `seq`, `sha256` and `equal`.
* The backend tries the agent first (`~250 ms`, verified by seq + digest + `equal`
  + a read-back hash) and falls back to `cua-clip-set`/`cua-clip-get`, reporting
  `fastPathReason` — "pasted, slowly" and "pasted, verified" are different facts
  and both are named.
* `docker/cua-vnc-clip.mjs` — the image's own noVNC front door: static files, the
  WebSocket handshake (`258EAFA5-…`), an RFB-aware TCP client and the clipboard in
  both directions over the supervisor's own control socket. Loopback only, no new
  dependency, no Python. The supervisor prefers it and falls back to websockify if
  it is missing, `DSH_CUA_VNC_CLIP=0`, or it never listens.
* Encoding is reversible: latin1 when every code point fits a byte, UTF-8
  otherwise, with the RFB length header counting BYTES.

**Verify.**
```bash
node tests/modules-unit.mjs        # ServerCutText frame bytes [3,0,0,0,0,0,0,2,104,105],
                                   # ClientCutText parse, wsAccept, encoding label,
                                   # clipAckMatches, and the task-path ORDER
node tests/supervisor-smoke.mjs    # agent path verified:true on an equal ack;
                                   # ack-mismatch never reports verified; no agent
                                   # → cua-clip-set with fastPathReason 'no-agent'
node tools/check-cua-vm.mjs --root .  # vncClip section + the Dockerfile COPYs
```

### E. Effects and captures: a read-back, or an honest "unverifiable"

**Problem.** "The click worked" was a claim with no evidence. The old answer could
not distinguish "the pointer moved", "the window changed" and "nobody looked", and
a click computed from an older screenshot landed on whatever had moved into that
pixel.

**Change.** Every action may carry an `effect` (`before`/`after` for the pointer,
the active window, an element read-back, or a frame change) and a `verified` of
`confirmed | unverifiable` — never `changed: false` for a side nobody read.
`captureIdFor()` names each frame (`<name>:<epochMs>:<sha1(png)[:8]>`),
`latestCapture()` expires it after 15 minutes, and a click citing anything else is
refused with `code: stale-capture`. `DSH_CUA_VM_EFFECTS=0` turns the read-back off
and says so in the answer.

**Verify.**
```bash
node tools/check-cua-vm.mjs --root .   # captureIdFor/latestCapture/stale-capture
                                       # and the verified: confirmed|unverifiable form
grep -n "stale-capture" docker/cua-vm-supervisor.mjs   # the refusal has a code
```

### F. Linux fixes, and the hardening that keeps the seam honest

**Problem.** Three Linux answers were guesses. `cua_vm_disk` ended both guest
commands with `|| true` and reported the REQUESTED size, so a failed `resize2fs`
still said "grew to 40 GB" and the next ENOSPC had no explanation. A checkpoint
was "path or null", which collapsed "no disk", "no room" and "qemu-img refused"
into one silent `no disk to checkpoint`. And the doctor answered questions nobody
could check: which QEMU is this, did this boot get the 9p share, is a `gpu: true`
row actually software-rendered.

**Change.**
* `growGuestDisk` resizes the qcow2 (`block_resize`), grows the partition and the
  filesystem in the guest, then READS `df -B1 --output=size,avail /` and answers
  with the measured number. `NOCHANGE` is success; a refused `resize2fs` is
  `guest-resize-failed`, a refused `growpart` is `guest-growpart-failed`, and a
  filesystem below 95 % of the request is `short-grow` — with the command output.
  The registry only records a grow that changed something.
* `checkpointDiskFile` returns `{ ok, path, bytes }` or `{ ok: false, reason }`
  (`policy`, `quota`, `no-disk`, `unknown`), the row keeps `checkpointSkipped`, an
  interrupted convert is PROMOTED (not deleted), and shutdown/start respect it.
* The doctor reports `provenance` (the `cua` version, the real QEMU path **and its
  SHA-256**, and the honest `baseImage: "cua-managed (no digest pin)"`), a
  `linux-checkpoint-layout` check, a `gpu-degraded` check for a `gpu: true` row
  whose renderer is software, and a `9p-share-not-attached` check read from the
  cmdline QEMU actually ran.
* Hardening unchanged and re-proved: `cap_drop ALL`, read-only rootfs,
  `no-new-privileges`, no Docker socket on the Windows path, QMP/VNC/SSH bound to
  loopback, the credentials file 0600 and never in the registry, and the new
  clipboard bridge loopback-only (its `--http-port`/`--vnc-port` refuse anything
  else).

**Verify.**
```bash
node tests/supervisor-smoke.mjs   # grow success = measured GB; resize2fs failure
                                  # = guest-resize-failed (no || true); growpart
                                  # failure = guest-growpart-failed; short grow
                                  # = short-grow and the row keeps the old size
node tests/modules-unit.mjs       # parseGuestDf (the supervisor's own parser)
node tests/qmp-shutdown.mjs       # the shutdown/suspend split is unchanged
```

### What is NOT claimed

Windows XP does not install (refused by name). There is no per-window capture, no
background invoke, no image clipboard and no OCR on a frame — the design drafts,
prerequisites and acceptance criteria for those live in
`docs/cua-capability-roadmap.md`. The guest's base disk image has no digest pin
(the doctor says so); the Microsoft media do, per source.

## 18. Branch `cua-vm-improve` — 2026-11-17 (jury fix round)

The jury round found **21 consolidated defects** across the three juries
(J20-1…5, J21-1…6, J22-1…13; where two juries filed the same behaviour under
different numbers it is listed once and both numbers are named). Each entry is
problem → fix → the command that proves it. Nothing in `docker/*` is touched by
the test writer except where the fix itself was the source; the proof lives in
`tests/*`, `tools/check-cua-vm.mjs` and `docs/`.

### 1. J20-1 (a/b/c) — three documented knobs were dead

**Problem.** `DSH_CUA_WIN_ISO_SHA256=0` was documented as the way to accept a
mirror that serves byte-identical media, but nothing read it; `verified` was
always `true` or the download always threw. `DSH_CUA_VNC_CLIP_POLL_MS` was
documented and **never passed** to the bridge, so the written interval and the
real one (the bridge's own 1200 ms) could disagree silently. And the opt-out, when
added, had to be decided once per download or the size check, the streaming digest
and the answer's `note` could disagree with each other.
**Fix.** `isoDigestCheckDisabled()` accepts exactly the string `'0'`; the decision
is made once at the top of `ensureIso()` and once in `inspectCachedIso()`; every
skipped result returns `verified: false` plus `ISO_DIGEST_DISABLED_NOTE`. The
supervisor reads `DSH_CUA_VNC_CLIP_POLL_MS` in `vncClipPollMs()`, clamps it to
200–60000 ms, rounds it, and passes `--poll-ms` to the bridge.
**Verify.** `node tests/modules-unit.mjs` (J1-5 unpinned-cache block);
`node tests/supervisor-smoke.mjs` (J20-1c clamp: 99999→60000, `abc`→1200,
and the real bridge argv `fix-bridge:60000`); `node tools/check-cua-vm.mjs --root .`
(needles `isoDigestCheckDisabled`, `DSH_CUA_VNC_CLIP_POLL_MS`).

### 2. J20-2 / J1-1, J1-3 — a redirect that loses the socket, a comma that splits an option

**Problem.** A `Location` header the URL parser rejects threw out of a socket
callback (leaving a `.part` behind and no attempt accounting); and every path
interpolated into a QEMU option string (`file=`, `path=`) was raw, so an operator
medium named `win11,beta.iso` — or a store path containing a comma — became
`file=win11` plus a mystery option that QEMU parsed as something else.
**Fix.** Redirects go through the same `fail()` as any other hop error
(`code: bad-redirect`, `.part` unlinked, the next strategy tried).
`qemuEscapeOptionValue()` is the single export every interpolation calls, and it
is applied to OVMF code, EFI vars, the system disk, setup.img, the ISO, the
driver ISO and the TPM socket path — **and to swtpm's own argv** (`--ctrl
path=`, `--tpmstate dir=`, `--pid file=`, `--log file=`), which uses the same
comma-splitting grammar: an unescaped store path there produced a truncated
socket/state path, a log written somewhere else and "could not open pid file".
Both option grammars only understand `,,`.
**Verify.** `node tests/modules-unit.mjs` (`qemuEscapeOptionValue('a,b') ===
'a,,b'`); `node tools/check-cua-vm.mjs --root .` (the escaped `file=`/`path=` needles for
QEMU AND for swtpm's `--ctrl/--tpmstate/--pid/--log`, `bad-redirect`).

### 3. J20-2 (second half) / J1-4, J1-5, J1-6 — a cache that verified nothing, a preflight that demanded the wrong firmware, a doc nobody checked

**Problem.** Three separate lies on the create path. (a) A cached ISO with no
pin returned `ok: true` having verified nothing, and a matching `.sha256` sidecar
was trusted without hashing the file — so a half-written or substituted ISO was
"cached". (b) The create preflight demanded qemu + OVMF (both files) + swtpm from
EVERY Windows create, while a `7u` row boots pc/SeaBIOS with no pflash and no TPM:
a host that could run Windows 7 was refused for two files the boot spec never
opens. (c) `docs/windows-iso-sources.md` claimed to be "kept honest" by the tests,
but no assertion compared it to the module.
**Fix.** (a) The sidecar is hashed against the file; no pin and no valid sidecar
is `unpinned-cache` and a re-download. (b) `requiredCaps` comes from the same
`windowsFirmwareProfile()` the boot spec uses: `seabios` needs only `qemu`, UEFI
needs `qemu, ovmfCode, ovmfVars, swtpm`, and the refusal names the missing set.
(c) The gate's `J1-6` block imports `WINDOWS_ISO_SOURCES` and diffs every chain row
against the markdown table on all five columns, failing with the first divergent
code and field.
**Verify.** `node tests/modules-unit.mjs` (J1-5 refuses the unpinned cache and
re-downloads); `node tests/supervisor-smoke.mjs` (J1-4: a 7u create without
OVMF/swtpm gets past the caps check; an 11 create names `ovmfCode`);
`node tools/check-cua-vm.mjs --root .` (`J1-6 … matches ISO_SOURCE_CHAINS on all
five columns (45 chain row(s))`).

### 4. J20-3 — the state bus was polled, never consumed

**Problem.** The supervisor had a `subscribe` op that pushed `vm-state` /
`vm-removed` lines, but the plugin never opened it: a delete or a shutdown was
discovered on the next 10 s poll, so dead `mcp__windows__*` schemas survived for
up to a turn. The README even described the poll as the push.
**Fix.** `startWindowsStateStream()` holds ONE long-lived subscription
(`{"op":"subscribe","events":["vm-state","vm-removed"]}`), parses the `ready` line,
reconnects with backoff, and turns a transition into the same idempotent
`teardown()` the poll uses. A supervisor that answers `unknown op` (or closes
without `ready`) marks the stream unsupported and the poll remains the belt. The
doctor reports `stream.live/supported/events/lastEvent`.
**Verify.** `node tests/windows-mcp-gate.mjs` (the fake supervisor answers the
subscription op; the state/removal checks complete in ms) and
`node tests/supervisor-smoke.mjs` (`WP-4: subscribe announces the stream …`).

### 5. J20-4 — a delete that landed mid-handshake resurrected 19 schemas

**Problem.** `WIN_MCP.name` is `''` until the 45 s SSH handshake finishes, so a
delete (or a shutdown) during that window compared `'' !== name`, skipped
teardown, and the attach then registered 19 schemas of a computer that no longer
existed — until the next beat.
**Fix.** Every attach mints a ticket `{ generation, name, dead, at }` and bumps
`WIN_MCP.generation` in teardown. `forgetSessionTarget()` kills a ticket whose
NAME matches even while the attach is in flight, and every write (`connect`
return, before each `register`) re-checks `isDead()` and aborts without leaving a
name, client or `online` behind. The doctor shows `attach.pendingName` /
`attach.pendingDead`.
**Verify.** `node tests/windows-mcp-gate.mjs` (J20-4 block: held handshake, delete
mid-flight, ticket dead, generation bumped, 0 registrations afterwards).

### 6. J20-5 — session B clicked on session A's desktop

**Problem.** The guard asked "is the grant on for you", never "is that machine
yours". With one process, one attached computer and many sessions, a session that
had bound nothing (or another computer) could drive someone else's guest.
**Fix.** `targetMatchFor()` implements the ordered rule: a session's binding must
be the attached name, else `not-the-target` with both names in the text; no
binding is refused too — except `implicit-single-target`, when exactly ONE Windows
computer is known and the session never bound anything. The relaxation is recorded
in the doctor (`viewer.via`, `implicitTarget.sessions`) and withdrawn by a second
computer. The reveal and the deny list both consult the same rule.
**Verify.** `node tests/windows-mcp-gate.mjs` (two-computer refusal text, the
implicit allowance, its withdrawal with two computers).

### 7. J21-1a — the agent's clock had three spellings

**Problem.** `readClipState()` read only `ts`. The shipped `cua-clip-agent.ps1`
writes `at`; an earlier build and the test stubs write `ts`; JSON convention says
`updatedAt`. A live agent was therefore evaluated as age 0 → `Infinity` → "stale",
the fast path never ran, and every paste silently took the slow schtasks path.
**Fix.** The stamp is the first of `at`, `ts`, `updatedAt` that is a positive
finite number; a MISSING stamp stays `0` and is reported as `stampMissing` +
`agent-stale` — freshness is never invented from `undefined`.
**Verify.** `node tests/modules-unit.mjs` (three accepted spellings + missing =
agent-stale).

### 8. J21-2 — an agent's own failure was reported as a digest mismatch

**Problem.** The verdict looked only at `equal`/`seq`/`sha256`, so
`{ ok: false, error: 'clipboard is locked by another process' }` fell through to
the generic `ack-mismatch` — sending the reader to hashing and encoding instead of
the agent's complaint.
**Fix.** `clipAckVerdict()` is the new exported verdict. An explicit `ok: false`,
or a non-empty `error`, answers `agent-error:<code>` (code first, else a one-line
truncated message); `undefined` is NOT `false`, so agents that predate the field
still pass. `clipAckMatches()` remains the boolean half.
**Verify.** `node tests/modules-unit.mjs` (E_LOCK, message-only, legacy `ok`
missing, whitespace-only error).

### 9. J21-3 (also filed as J22-1) — the paste passed one object, not the text

**Problem.** `windowsBackend.clipboardSet({ ...meta, name })` passed ONE argument.
The backend's signature is `clipboardSet(rawSpec, text)`, so EVERY host→guest
paste — the panel route and the noVNC bridge's control-socket write — failed with
"clipboardSet needs the text to paste" after the whole SSH task had been prepared.
**Fix.** The supervisor passes `clipboardSet({ ...meta, name }, text)` (the spec
stays an object the backend normalises). The test seam starts the REAL supervisor
with a resolve hook that wraps only `createWindowsBackend`, recording the raw
positional arguments.
**Verify.** `node tests/supervisor-smoke.mjs` (`J21-3 … the backend received the
text as the SECOND POSITIONAL argument`, `argCount === 2`).

### 10. J21-4 — the ack is written before the copy, so one read could see the old payload

**Problem.** The agent writes `clip-ack.json` before it rewrites
`clip-current.txt`. A single immediate read of the copy could therefore describe
the PREVIOUS payload while the ack (and the clipboard) already held ours: a false
`readBackEqual: false` on a paste that worked.
**Fix.** The read-back and the ack are re-read up to `CLIP_ACK_READ_ATTEMPTS = 3`
times, 250 ms apart; the LAST ack whose `seq` matches is the final word, and a
newer matching ack that reports a failure wins over the older success.
**Verify.** `node tests/modules-unit.mjs` (the agent-path checks exercise the
three-round read); `node tests/supervisor-smoke.mjs` (`readBackEqual === true`
end-to-end).

### 11. J21-5c — a too-large text cost a round trip to be refused

**Problem.** The agent refuses a JOB FILE, not a text. A text legal for the task
path (up to 1 MiB) could exceed the JSON job's limit after wrapper + escaping, so
the backend uploaded a job the agent then dropped as `too-large` — one wasted SSH
round trip, reported as an agent bug.
**Fix.** `CLIP_OUTBOX_WRAPPER_BUDGET = 2048` is subtracted from the agent's limit
and checked BEFORE the first round trip; the exact serialized size is re-checked
after the JSON is built (escaping is not linear). The fast path declines with
`reason: 'too-large'`; the schtasks fallback (1 MiB text) still delivers and names
the decline.
**Verify.** `node tests/modules-unit.mjs` (J21-5: `via: task`,
`fastPathReason: too-large`, **0** clip-state/clip-ack calls and **0** outbox
uploads).

### 12. J21-6 — a NUL in the text was reported as a clean paste

**Problem.** The Windows clipboard (and every C-string reader of it) stops at the
first U+0000, so `ok: true` claimed bytes that never landed.
**Fix.** A NUL keeps `ok: true` (the prefix DID land) but sets `verified: false`
and returns `nulTruncated: { landed, total }`, counted in code points, with a
detail sentence naming both numbers.
**Verify.** `node tests/modules-unit.mjs` (J21-6: `landed === 1`, `total === 4`).

### 13. J22-2 / J22-3 — the seq is a Date.now() stamp, and both scripts held it in an Int32

**Problem.** The supervisor's `seq` is `Date.now()` (~1.79e12). Both
`cua-clip-agent.ps1` and `cua-firstboot.ps1` declared it as an `[int]`, so the
value overflowed on assignment and every ack was compared against a truncated
number — an ack that could never match.
**Fix.** `[long]$seq` is the first assignment in both scripts, and the value is
carried as `[long]` on every path that reads it back.
**Verify.** `node tools/check-cua-vm.mjs --root .` (`[long]$seq` in BOTH ps1
sections); `node tests/windows-boot.mjs` (the answer-file contract is unchanged).

### 14. J22-4 — read-back before the ack (the paste order)

**Problem.** A failed `clip-current.txt` write (permissions, a full disk) was
ignored and the ack still claimed `equal: true`. An ack could name a copy that
did not hold the text.
**Fix.** The contract is SET → READ BACK → write `clip-current.txt` → ack →
delete, and the read-back is written BEFORE the ack. A failed copy write refuses
with a named reason instead of acknowledging.
**Verify.** `node tools/check-cua-vm.mjs --root .` (`# TEXT FIRST, THEN THE STATE
THAT VOUCHES FOR IT`); `node tests/supervisor-smoke.mjs` (agent path
`readBackEqual`).

### 15. J22-5 — the size test was on the escaped JSON file, and refusals had no sha

**Problem.** The agent tested the length of the JSON FILE, so a legal text whose
escaping inflated it was refused while the backend believed it was fine; and a
too-large refusal acked without a digest, so it could not be told from an empty
reply.
**Fix.** The test is on the TEXT in chars; the SHA-256 is computed BEFORE any
refusal, and every refusal carries its code.
**Verify.** `node tools/check-cua-vm.mjs --root .` (`THE SIZE TEST IS ON THE
TEXT, IN CHARS`, `$error = 'too-large'`); `node tests/modules-unit.mjs` (the
too-large answer is a named reason, not a bare failure).

### 16. J22-6 — the privacy off-switch read as "registered"

**Problem.** `C:\ProgramData\cua\clip-agent-disabled` was honoured by the agent
(`exit 0`) but the firstboot step recorded `ok: true`, so the state file said the
task had been registered when it never was.
**Fix.** The switch is now materialized in three hops, because the guest cannot
read the host environment. (1) The BACKEND is the writer:
`CLIP_AGENT_SENTINEL_FILE` is staged beside the OEM payload when
`DSH_CUA_CLIP_AGENT=0`, copied into `$OEM$/$$/Setup/Scripts`, and carried into
`setup.img`'s root through `SETUP_IMAGE_OPTIONAL` (so an unset knob is not
"incomplete payload"); an unset knob unlinks a stale root sentinel, and the writer
logs `clip agent disabled by DSH_CUA_CLIP_AGENT=0 (sentinel staged)`. (2)
`cua-firstboot.ps1` SEARCHES the same locations, COPIES a staged sentinel to
`C:\ProgramData\cua\` before its check, then refuses to register the task and
records `skipped: true, reason: 'clip-agent-disabled'`. (3) The agent (and its
embedded fallback copy) runs the same search-then-stage hop and exits on the
path.
**Verify.** `node tests/modules-unit.mjs` (J22-6: `=0` stages root + Scripts, the
real setup.img carries it, unset stages nothing and still builds/verifies, the
stale root sentinel is unlinked); `node tools/check-cua-vm.mjs --root .`
(`CLIP_AGENT_SENTINEL_FILE`, `SETUP_IMAGE_OPTIONAL`, the log line, the firstboot
search-then-stage block, the embedded hop).

### 17. J22-7 — SIGTERM left the live-view children holding their ports

**Problem.** `server.close()` closes the unix socket and nothing else. The
websockify / `cua-vnc-clip.mjs` children in `LIVE_VIEWS` survived the container
stop, keeping their loopback ports and (worse) relaying to a bridge whose
supervisor socket was gone — every clipboard write then failed with a
control-socket error the user reads as "paste does nothing". A killed boot also
left its swtpm behind.
**Fix.** `sweepLiveViews()` SIGTERMs every child on SIGTERM/SIGINT and the process
exits only after they are reaped (or after the unref'd
`SHUTDOWN_LIVE_VIEW_DEADLINE_MS = 2000`). `stopBootResidue()` sweeps swtpm for a
boot that was killed.
**Verify.** `node tests/supervisor-smoke.mjs` (J22-7: exit 0, both stub bridges
recorded a `stop`, 0 late stops); `node tools/check-cua-vm.mjs --root .`
(`sweepLiveViews`, `stopBootResidue`).

### 18. J22-8 — the front-door kind was assumed, not read

**Problem.** The supervisor reported `kind: 'novnc-clip'` the moment the port
answered. An image without a noVNC tree served a WS-only bridge that the panel
rendered as a page which 404s, and the clipboard triple claimed a channel the page
did not have.
**Fix.** The bridge prints `[cua-vnc-clip] <kind> on http://…` to stderr; the
supervisor captures that line across write chunks, requires
`novnc-clip`/`novnc-clip-bare`, re-probes the listener after the wait, and falls
back to websockify/raw when the line never arrives or the child dies.
**Verify.** `node tests/supervisor-smoke.mjs` (J22-8: `novnc-clip`,
`novnc-clip-bare` honoured, a silent listener is NOT the view and its child is
killed).

### 19. J22-9 / J22-13 — `schtasks /run` was taken as proof the agent is alive

**Problem.** `/run` only QUEUES a task; its exit code says the queue accepted the
request. firstboot declared the clipboard agent live without ever seeing a fresh
`clip-state.json`.
**Fix.** `/run` is followed by a freshness proof on `clip-state.json` (≤10 s); a
task that started but never wrote state fails with `task-started-but-no-state`,
and the waiter is a `[long]` window, not a bare loop.
**Verify.** `node tests/supervisor-smoke.mjs` (the clipboard contract checks
treat a task with no state as a failure);
`node tools/check-cua-vm.mjs --root .` (`task-started-but-no-state`,
`[long]$seq`).

### 20. J22-10 / J22-11 — two logon sessions shared one outbox

**Problem.** Every clipboard file was a single global path. A second logon (RDP,
a reconnect, autologon plus a human) wrote the same `outbox`, served each other's
payload, and one session's restart re-announced a clipboard the backend had
already accepted.
**Fix.** Session-derived paths (`clip-state-<id>.json`, `clip-ack-<id>.json`,
`clip-current-<id>.txt`, `outbox-<id>\`) plus the canonical un-suffixed copies
written by the SAME owner (`Write-JsonPair` / `Write-TextPair` — identical bytes,
so a reader on either path sees one truth). A single-owner lock (60 s freshness
window) means only the freshest session drives the clipboard; the backend keeps
reading the canonical paths, unchanged.
**Verify.** `node tools/check-cua-vm.mjs --root .` (both per-session path needles,
`Write-*-Pair`, the ownership window).

### 21. J22-12 — a reopened preview came back without its clipboard

**Problem.** `restorePorts()` reopened the TCP relay after an aborted shutdown but
told `openRelay` neither `view` nor `clipboard`. The live view came back and the
paste controls did not — exactly the moment the user is still looking at the
console.
**Fix.** `relayCapabilities(snapshot, rawVncPort)` recomputes the triple from the
recorded front door with the same rules a fresh `ensureWindowsConsoleRelay` uses
(bridge → clipboard up; noVNC/websockify → page without clipboard; raw VNC →
neither; no recorded view → infer raw from the target port), and `restorePorts`
passes both to `openRelay`.
**Verify.** `node tests/supervisor-smoke.mjs` (J22-12: `relayCapabilities` cases
plus the live relay row's `view`/`clipboard`);
`node tools/check-cua-vm.mjs --root .` (`view: capabilities.view, clipboard:
capabilities.clipboard`).

### What the round does NOT claim

The `too-large` pre-check protects the JOB path only: a text over the outbox
budget but under 1 MiB still pastes through the documented schtasks fallback, and
the answer says so (`fastPathReason: "too-large"`). `implicit-single-target` is a
deliberate relaxation, not a guarantee: two computers, or one binding, withdraw
it. And `relayCapabilities` is exercised as a function (it is module-scope in the
supervisor, not exported); the call site is pinned by the gate needle rather than
by a second process. The sentinel's stale guard unlinks the payload-ROOT copy; a
sentinel already written into an existing `$OEM$/$$/Setup/Scripts` tree is only
replaced while the knob is `0` (the normal create/delete paths build that tree
from scratch, and the medium root is rebuilt on every install boot).
`DSH_CUA_CLIP_AGENT` is read at staging time only, so flipping it on a running
computer takes effect on the next re-stage, not on the fly.

## 19. Branch `cua-vm-improve` — 2026-11-18: the quota control is findable

**Problem.** Every quota refusal ended with "raise the quota under **Plugins →
Personal VM (CUA) → Policy**", and the two READMEs sent the reader to the same
place. There is no Policy section under the Plugins page: the panel is a SIDEBAR
panel (`sidebar.panellist`, label "Personal VM (CUA)"), and its Policy tab is
inside it. A refusal that names a path which does not exist is worse than no path
— the reader concludes the quota cannot be raised at all, and a 64 GB create stays
refused on a store whose only real problem is a 20 GB cap. The field was also
labelled "Disk Size (GB)" next to a store that reports quota in GB, which read as
a per-computer disk rather than a store-wide cap.

**Change.**
* The refusal sentence and both READMEs now name the real control: **sidebar panel
  "Personal VM (CUA)" → Policy → Store quota (GB)**, and say that a saved change
  applies to the NEXT create (the supervisor re-reads `config.json` every minute)
  rather than implying the refused create retries itself.
* The Policy tab relabels its field to **Store quota (GB)** with a description
  that names every consumer (base image, QEMU, disks, checkpoints, screenshots,
  the shared ISO cache), and the header line shows the store readout as **used /
  quota** (`store 16.1 GB / 20 GB`), so the number the refusal quotes and the
  number the user can change are visible on one screen.
* `tools/check-cua-rea.mjs` no longer pins the dead path; its needle is the new
  destination sentence, so a future refusal message cannot drift back to a
  section that does not exist.

**Verify.**
```bash
node tools/check-cua-rea.mjs --root .   # the supervisor's refusal names the real path
node tools/check-cua-vm.mjs --root .    # nothing else in the chain moved
grep -rn 'Plugins → Personal VM (CUA) → Policy' README* plugins/ docker/ tools/ docs/
                                       # must print nothing (0 hits)
```

## 20. Branch `cua-vm-improve` — 2026-11-18: the boot prompt, the dead monitor, the dropped socket

Three runtime fixes that all presented as "the Windows computer is stuck": the CD
prompt was never dismissed, a dead monitor cost 15 s per probe (and per key), and
the console page loaded but said *not connected*. Each is problem → change →
verify, with the anchor of the shipped code.

### A. The cdboot scheduler presses on the PROMPT, re-arms, and reports refusals

**Problem.** Three separate lies in one 40-line watcher. (1) It pressed at 1.5 /
3.5 / 5.5 s after **spawn**, while OVMF was still enumerating — before `cdboot`
printed its prompt — so the 5 s window expired and the firmware fell into the EFI
Shell (`EFI_TIMEOUT`). (2) A QMP refusal is a RESULT (`{error:{desc}}`), not a
throw; the code only caught throws, so a run of refused presses logged *"pressed
enter at ~1.7 s"* while the guest never saw a key. (3) Each press waited the 15 s
monitor default, so ONE collision consumed the whole prompt window; and a prompt
BDS re-printed (it re-enters the DVD when unanswered) was never served again.

**Change** (`docker/cua-vm-windows-qemu.mjs`):
* `runCdbootKeys()` (:878) is prompt-anchored: the serial log is polled every
  **300 ms** (`pollMs`) for up to **90 s** (`cdbootPromptWindowMs`, :1154), and
  the presses fire on the poll that sees the prompt signature (:4284).
* the first-output growth anchor is **disabled at the call site**
  (`armDelayMs: 0`, :4285); its `+1.5 s` survives only for a caller that opts in.
* a re-printed prompt re-arms the schedule for at most `cdbootRearmCycles()`
  (**12**, :1159) inside `cdbootRearmWatchMs()` (**180 s**, :1164), stopping early
  when the QEMU child exits.
* `cdbootPressFailure(result)` (:1116) reads the monitor's refusal out of a
  `{error}` entry (string, `{desc}`, `{class}`, or an array containing one); a
  refused press is logged `could not press enter …` and never counted as sent
  (:926, :4597).
* one press gets `cdbootPressTimeoutMs()` = **3 s** (:1176), passed as the
  per-press QMP budget (:4302).
* knobs: `DSH_CUA_WINDOWS_CDBOOT_PROMPT_MS`, `_CDBOOT_PRESS_MS`, `_CDBOOT_CYCLES`,
  `_CDBOOT_WATCH_MS`, all clamped, junk → the default (never 0).

**Verify.** `node tests/modules-unit.mjs` (R6: a refused result is not sent and
says so; `cdbootPressFailure` shapes; 90 s / 12 / 180 s / 3 s defaults and clamps);
`node tools/check-cua-vm.mjs --root .` (the four helpers, `armDelayMs: 0`,
`maxWindowMs: cdbootPromptWindowMs()`, `timeoutMs: cdbootPressTimeoutMs()`).

### B. A dead monitor costs 2 s, not 15 — and the console exists during Setup

**Problem.** `qmpCommands()` used one 15 s budget for two different failures: a
socket that never opens and a monitor that accepts and stays silent. Every probe
against a computer whose monitor had gone away waited the full window — and the
Windows backend presses a key per call, so a boot could spend 15 s *per press*
waiting for a refusal. Separately, the create answer advertised
`console: /vm/port/<name>/`, but the relay was only created by the install watcher
at the READY transition: for the 20–40 minutes Setup ran, the proxy answered
*"not connected"* on the one screen a human most wants to watch.

**Change** (`docker/cua-vm-supervisor.mjs`):
* `QMP_CONNECT_TIMEOUT_MS = 2000` (:2165) is its own budget; a refused port also
  fails immediately on the socket's `error` event. The answer wait keeps the old
  15 s default and accepts a per-call `defaultTimeout` (:2195), which is the
  spelling the backend uses for `--press-ms`.
* `windowsCreateManaged` opens `ensureWindowsConsoleRelay(name)` right after the
  row write, inside a `try` (:4933): success logs
  `live view ready at /vm/port/<name>/ … while Setup runs`, failure is one log
  line and the install watcher retries at Ready. The create answer keeps
  `console: /vm/port/<name>/` either way.

**Verify.** `node tools/check-cua-vm.mjs --root .` (the 2 s constant, the
`defaultTimeout` signature and fallback line, the create-site relay and its two
log lines); `node tests/supervisor-smoke.mjs` (the shutdown/probe paths still
answer against a dead monitor inside their own budgets).

### C. The WebSocket subprotocol is negotiated, not announced

**Problem.** The console bridge answered `Sec-WebSocket-Protocol: binary` on
EVERY upgrade. RFC 6455 §4.2.2: a server naming a protocol the client did not
offer is a handshake the CLIENT must abort. Debian's noVNC 1.6.0 sends no
subprotocol header, so the browser dropped the socket — the page rendered, the
canvas never did, and noVNC reported *not connected*. Nothing in the logs said
why, because the bridge considered the handshake a success.

**Change** (`docker/cua-vnc-clip.mjs`):
* `WS_SUBPROTOCOLS = ["binary"]` (:92) and `selectSubprotocol(headerValue,
  supported)` (:110): no offer → `null`; an offer → the client's first listed
  protocol we support, echoed with the CLIENT's own spelling.
* the handshake pushes the header only when `protocol !== null` (:697); the
  unconditional constant is gone.

**Verify.** `node tests/modules-unit.mjs` (J22-8b: `undefined`/empty →
`null`; `'base64, binary'` → `'binary'`; `'BINARY'` echoed as `'BINARY'`;
unsupported offer → `null`; **a real loopback upgrade** with no offer gets 101
and NO header, an offer of `binary` gets it once, an unsupported offer gets
none); `node tools/check-cua-vm.mjs --root .` (R8: exactly one emission, inside
the guard, sourced from `selectSubprotocol(request.headers[...])`, and no
unconditional constant anywhere).

## 21. Branch `cua-vm-improve` — 2026-11-18: media that leave on time, hardware that has drivers, a guest that can power itself off

Three fixes from the same live round, all consequences of one wrong assumption:
"the install finishes when the ready transition fires". It does not — a guest can
finish installing and never answer SSH, and a guest can shut itself down without
telling this supervisor. Each entry is problem → change → verify, with the anchor
of the shipped code.

### P1 — the media leave when Setup finishes COPYING

**Problem.** `detachInstallMedia()` ran only at the READY transition, and READY
needs the SSH banner. A guest whose NIC has no driver (the very case P2 fixes)
never answers SSH, so the row stayed `installing` with the Microsoft DVD and
**SETUP (D:)** mounted for the life of the session — media nobody needs, on a
computer that had finished installing. Every exemption sent the reader to Setup.

**Change** (`docker/cua-vm-windows-qemu.mjs`):
* `WINDOWS_SETUP_COPY_DONE_PATTERN` (:580) + `windowsSetupCopyFinished()` (:583)
  read the serial evidence: `Windows Setup is complete/completed/finished`,
  `Setup has finished copying`, `Setup is applying system settings`, and a
  boot-from-disk line all mean the copy is done.
* `startMediaWatcher()` (:4425) re-reads the serial tail every
  `WINDOWS_MEDIA_EJECT_POLL_MS` (15 s), bounded by
  `windowsMediaEjectWatchMs()` (:601, `DSH_CUA_WINDOWS_EJECT_WATCH_MIN`, default
  90 min, clamped 1–600).
* before ejecting it sets `mediaGate.setupCopied` (so a re-armed cdboot cycle
  cannot type into the disk boot), requires QMP `running` (a paused guest queues
  the eject and the tray never opens), then calls the SAME idempotent
  `detachInstallMedia()` the ready transition uses; success logs
  `install media detached after Setup finished copying (before SSH/MCP)` (:4450).
* armed on BOTH boot paths — the first attempt (:4499) and the GPU-fallback retry
  (:4564). Non-fatal: on any failure the ready transition keeps its backstop.

**Verify.** `node tests/modules-unit.mjs` (P1: the pattern, the booted-from-disk
shortcut, no-eject signals, 90 min default and `DSH_CUA_WINDOWS_EJECT_WATCH_MIN`
clamps); `node tools/check-cua-vm.mjs --root .` (the watcher, both call sites and
the log line).

### P2 — the hardware is INBOX-driver hardware, for every code

**Problem.** UEFI guests got `virtio-blk` + `virtio-net-pci`. A consumer Windows
has no virtio driver in the box and a stripped variant (`tiny10`/`tiny11`/
`core11`) has almost nothing else either: the guest installed with **no network**,
never answered SSH, and the row sat at `installing` while every symptom pointed at
Setup rather than at the NIC.

**Change** (`docker/cua-vm-windows-qemu.mjs`):
* ONE decision, taken once (:1773–1775): `wantVirtio = DSH_CUA_WINDOWS_VIRTIO ===
  '1' && spec.virtio === true`; `diskDevice = wantVirtio ? 'virtio-blk-pci' :
  firmware.disk`, `nicDevice = wantVirtio ? 'virtio-net-pci' : firmware.nic`.
* both profiles now name `disk: 'ide-hd', nic: 'e1000e'` (:3103–3104) — q35's ICH9
  AHCI is IDE-class to Windows and its driver is inbox since Vista; `e1000e` is
  the same NIC Windows 7 already needed.
* `DSH_CUA_WINDOWS_VIRTIO=1` (AND `virtio: true`) opts back in for an image that
  really carries the virtio-win drivers; the opt-in alone is not enough.

**Verify.** `node tests/modules-unit.mjs` (P2: with the knob unset even
`virtio: true` gets `ide-hd` on `ide.0` + `e1000e`; with it set, `virtio-blk-pci`
and `virtio-net-pci`; the profile table; the 11 profile is now "q35, TPM2, inbox
AHCI disk + e1000e NIC"); `node tools/check-cua-vm.mjs --root .` (the single
decision and both device strings).

### P4 — a guest that shuts itself down is OBSERVED, not inferred

**Problem.** `shutdown /s` in the console, Windows Update, a user in the noVNC
page — none of those come through the supervisor. The row kept saying `ready`, the
panel kept offering Shutdown, and the next Start tried to resume a process that
was gone.

**Change** (`docker/cua-vm-supervisor.mjs`):
* `startQmpStatePoll()` (:4297) asks `query-status` every
  `QMP_STATE_POLL_DEFAULT_S = 3` s (:4281, `DSH_CUA_VM_STATE_POLL_S`, clamped
  1–30, unref'd), only while the row is live, and stops on the first
  non-transient verdict.
* `shutdown` → `finaliseGuestShutdown()` (:5816): `state: powered-off`,
  **`method: 'guest-shutdown'`**, and the SAME `windowsCheckpointPlan()` (:5770)
  checkpoint + `restoreFrom` bookkeeping (and the same quota/policy refusals) the
  ACPI path uses, so Start cold-boots from a real restore point. A vanished QEMU
  is an unconfirmed `powered-off` (`mayBeTorn`, no clean restore point).
* `paused` → `finaliseGuestPause()` (:5876): `state: suspended` — reversible,
  never a checkpoint of a live disk (QMP `stop` must not look like a power-off).

**Verify.** `node tools/check-cua-vm.mjs --root .` (the 3 s default, the clamp,
the poll starter, both finalisers, `windowsCheckpointPlan`, `method:
'guest-shutdown'` and the `{ reason: 'guest-shutdown' }` write);
`node tests/supervisor-smoke.mjs` (the shutdown/state machine still passes with
the poll present).

### P5 — what `gpu: true` means for Windows, stated plainly

For a Windows computer `gpu: true` selects a **virtio display** (`virtio-gpu-gl-
pci` + `egl-headless` when the image's QEMU advertises it and the render node
exists, otherwise a plain `virtio-gpu-pci`). It is **not** NVIDIA acceleration and
there is **no accelerated 3D in the guest**: Direct3D runs on **WARP (CPU)** and
OpenGL is not hardware-accelerated. An EGL handle in `nvidia-smi` is the
host-side QEMU context, not guest acceleration. GPU passthrough (**VFIO**) is
**not implemented** — it is on the roadmap (`docs/cua-capability-roadmap.md`) and
would need an IOMMU group, a second GPU and a host driver handoff this image does
not perform. Both READMEs say this next to the feature, not in a footnote.

### Version confidence

All **eleven** consumer/Server codes (`11`, `11l`, `11e`, `10`, `10l`, `10e`,
`2025`, `2022`, `2019`, `2016`, `2012`) share ONE pipeline: the same firmware
profile, the same inbox device class, the same answer file, the same P1/P2/P4
paths. There is therefore **no per-version testing requirement** — a green run on
one of them exercises the code every one of them uses, and the per-code data
(image selection, ISO chain, sizes) is already asserted by the gate against the
module.

**Residual risk, named honestly:** the `7u` legacy path (pc/SeaBIOS, no TPM, a
pre-UEFI installer) and the stripped media (`tiny11`, `core11`) are the two places
where the shared pipeline meets an image that does not behave like a normal
consumer Windows. Spot-check exactly those two before a release; nothing else in
the catalog has a different code path.

## 22. Branch `cua-vm-improve` — 2026-11-18: the MCP server moves into the session that has the desktop

One defect, four shipped pieces, and a package that keeps them joined. The defect
is not a bug in a function: `dsh-cua`'s MCP server was being started **in the wrong
session**, and every symptom that looked like "UIA is broken" or "the click did
nothing" was that one fact wearing different clothes.

### R1 — the defect: the server ran in Session 0, which owns no desktop

**Problem.** `win-mcp.js` started the guest server with the SSH command itself:

```
ssh cua@HOST "python -m dsh_cua.server --stdio"
```

`sshd` on Windows is a **service**, so the child inherits the SSH service's
session — Session 0. UIA is per session. Measured on the live guest, not inferred:

| what was asked from that server | what came back |
|---|---|
| `list_windows` | **0** windows (`count: 0`, no error) |
| a notepad started by a tool | created **in "Services"** — the logged-on user never sees it |
| `SendInput` / `tool_click_at` | delivered to a desktop nobody is looking at |

Every one of those is a **successful** MCP call returning a well-formed answer.
That is why the failure survived so long: the transport was healthy, so nothing in
the harness, the gate or the logs said "wrong session". Retrying cannot fix a
session, and no argument shape can either.

### R2 — the fix chain: a loopback relay, not a new transport

**Change.** `docker/cua-mcp-relay.py` (NEW, 623 lines, stdlib only, ASCII only) is
ONE file with two modes, so both halves of the bridge cannot drift apart:

```
harness ──ssh stdio──▶ relay --connect ──127.0.0.1:47999──▶ relay --serve ──▶ python -m dsh_cua.server --stdio
                        (the SSH child: no desktop,       (firstboot's `cua-mcp-host`   (a child of the /it task →
                         raw bytes both ways)              task, /sc onlogon /it)        the user's own session)
```

* `--serve` (:449) binds **loopback only** (:449 `listener.bind((LOOPBACK, self.port))`),
  one client at a time under a session lock, and **keeps its child across
  reconnects** — an MCP client that reconnects must not discard the windows the
  desktop is mid-way through, nor pay a fresh pywinauto warm-up. A child that died
  is restarted for the next client (:275 `child()`), and its death is noticed by the
  reader thread, which ends the attached client with EOF instead of a silent hang
  (:295–:329).
* `--connect` (:511) is what the SSH command runs: stdin/stdout ↔ the socket, raw
  bytes, no pty, no line translation. It touches no desktop, so Session 0 is fine
  by design — that is the whole trick: only the SERVER needs a desktop.
* the probe pair (:85–:86): a connection whose first bytes are exactly
  `b'RELAY_PING'` is answered `b'RELAY_OK'` (**8 bytes**) and closed **before a child
  is spawned** (`classify()`, :350). A real client sends `{"jsonrpc":…` first, so
  the two are unambiguous; the probe is handled outside the session lock, so a
  health check can neither block nor be blocked by a live session.
* the log (:107, `log_path()`): one line per event, appended to
  `C:\ProgramData\cua\mcp-relay.log` (`DSH_CUA_MCP_RELAY_LOG` overrides; `event()`
  never throws, because a broken log must not break the pump). `pythonw.exe` has no
  console, so this file is the only diagnosis a logon task has.
* the child is spawned with pipes, `bufsize: 0` and `CREATE_NO_WINDOW` (:226,
  `spawn_child`): a `python.exe` child of an interactive task allocates a console,
  and that console would sit on the user's desktop as a permanently blank window —
  the U3 defect one process over.

**Guest side** (`docker/windows-oem/cua-firstboot.ps1`, step `mcp-relay-task`, :755):

1. the script is **staged from the payload, searched exactly where
   `cua-clip-agent.ps1` is** — `$PSScriptRoot`, `C:\Windows\Setup\Scripts`, the
   removable roots `C:`..`H:` (:766–:781). Nothing found and nothing already in
   `C:\ProgramData\cua` **fails the step**
   (`cua-mcp-relay.py is in neither the OEM payload nor C:\ProgramData\cua; the
   relay would be a task that does nothing`) instead of registering a task whose
   `-File` points at nothing.
2. the interpreter follows the same real-python rule as the provisioning steps
   (`Get-RealPython`, then the `py -3` launcher as a second chance — the documented
   way to ask Windows for ITS python when PATH does not carry one yet), and
   `pythonw.exe` is preferred beside it when it exists.
3. `schtasks /create /tn "cua-mcp-host" /sc onlogon /it /rl LIMITED /f /tr …`
   (:863). **`/it` is the entire point** — without it the task runs in Session 0
   again and the relay faithfully forwards JSON-RPC to a server that still sees no
   window. `/rl LIMITED` keeps the user's own token, i.e. the same desktop and
   integrity level as the windows the server will drive.
4. **idempotency is the PORT, not the task**: `if (Test-RelayPing $relayPort)`
   (:874) means "already up, start nothing" — a `/run` here would race the logon
   instance for the bind and the loser dies on `WinError 10048` while the marker
   still reads `ok:true`. When it does start the task, `/run` only proves
   ACCEPTANCE, so the step polls the probe 20 × 500 ms and fails with
   `task-started-but-relay-not-listening` (:887) — J22-13's lesson, applied to a
   process that publishes no file.

**Why a `.vbs` launcher and not the command in `/tr`.** `schtasks /tr` is ONE
command line that Windows **re-parses**. python.org installs under
`"C:\Program Files\Python3xx\…"`, so the generated action would be

```
/tr ""C:\Program Files\Python311\pythonw.exe" C:\ProgramData\cua\mcp-relay.py --serve"
```

— doubled quotes that no two parsers agree on, and this repository already has the
scars: **a nested quote in `/tr` silently truncates the action**, producing a task
that exists, "starts", and does nothing. Rather than bet on which parser wins, the
quoting lives in a file that is **not** re-parsed and `/tr` names that file by a
path with no spaces (`C:\ProgramData\cua\mcp-relay-host.vbs`, :837). The launcher
is **VBScript, not `.cmd`**, because `cmd.exe` is a console process and its window
would flash on the very desktop this task exists to automate; `wscript.exe` is
GUI-subsystem and `Run …, 0, False` starts the relay hidden (:838) — the same trick
as the image's existing `Unattend.vbs`. Two smaller traps are documented in place:
the `schtasks` call goes through a generated `.cmd` file because Windows PowerShell
5.1 passes a variable containing spaces to a native program **unquoted** (:868), and
the `@( )` array needs its `("'   " + $relayCommand)` item **parenthesised** because
inside `@( )` the comma binds tighter than `+` (:847).

**Backend / payload** (`docker/cua-vm-windows-qemu.mjs`):
* `OEM_MCP_RELAY_FILE = 'cua-mcp-relay.py'` (:2727) is the ONE name staging, the
  medium's root, the `$OEM$` copy and the byte-compare read;
  `OEM_PAYLOAD_FILES = [...OEM_PAYLOAD_REQUIRED, OEM_CLIP_AGENT_FILE,
  OEM_MCP_RELAY_FILE]` (:2760) — and it is **not** in `OEM_PAYLOAD_REQUIRED`,
  because a checkout keeps it beside `docker/windows-oem/` and only the location of
  the bytes differs.
* one parameterised resolver (`resolveOemPayloadSourceFile()`, :2784) serves both
  scripts — the clipboard agent's chain was the same shape, and two copies would
  drift invisibly.
* `stagePayloadFile(OEM_MCP_RELAY_FILE, 'MCP relay', …)` (:3934) copies it into
  `$STORE/windows/<name>/oem/`; `SETUP_IMAGE_ENTRIES` (:2825) puts it at the
  medium's root beside the answer file, and the `$OEM$/$$/Setup/Scripts` copy
  (:3981) is what Setup turns into `C:\Windows\Setup\Scripts`. `verifySetupImage()`
  now **requires and byte-compares it on both routes** (:3593, :3606) — a medium
  that silently lacks it is exactly the "firstboot runs its embedded floor" failure.

**Image** (`Dockerfile`): the runtime COPY (:937), the flat gate tree (:1017) and
the uid-1000 proof loop `for f in … cua-clip-agent.ps1 cua-mcp-relay.py` (:1033) —
a COPY that lands unreadable is the K6 defect one file over, so the proof reads it
as the runtime user.

### R3 — the lane: probe → `interactive-relay`, else a RECORDED fallback

**Change** (`plugins/dsh-cua-vm/win-mcp.js`):

* `RELAY_COMMAND = 'py -3 C:\ProgramData\cua\mcp-relay.py --connect'` (:153). It
  says `py -3`, not `python`: on the live guest `python.exe` is not on the
  non-interactive PATH while the launcher resolves — tested, not guessed.
* `relayProbe()` (:244) runs `relayProbeCommand()` (:211) — ONE powershell round
  trip that connects, writes the ten literal bytes `RELAY_PING`, reads **8**, and
  prints `RELAY_OK` / `RELAY_BAD` / `RELAY_DOWN`; the exit status is always 0, so
  the ANSWER is what is parsed. Answers are cached per SSH target **and port** for
  `RELAY_PROBE_TTL_MS` (10 s), because the logon task can come up minutes after the
  boot that made sshd reachable — a cached "down" that outlived boot would pin the
  session to the blind lane for its whole life.
* `resolveGuestMcpTransport()` (:345) decides per attach: `RELAY_OK` → the relay
  command (`transport: 'interactive-relay'`); `RELAY_DOWN`/`RELAY_BAD` → the
  session-0 command with `SESSION0_FALLBACK_REASON` (:162) on the record —
  `session-0 fallback (interactive relay not running; desktop automation will be
  blind)`. The lane is a property of the **command that will run**, not of the
  probe, so `DSH_CUA_WIN_MCP_COMMAND` naming the relay still counts as the relay,
  and an override that bypassed it says so.
* `relayDoctorFacts()` (:385) returns the same facts for a caller that has no
  client, and the client's own `doctorFacts()` (:638) is synchronous and
  side-effect free: `transport`, `relayPort`, `relayOk`, `relayStatus`,
  `transportCommand`, `transportReason` — `transport: null` when nothing was ever
  attached in this process, never a guess.

**Doctor** (`plugins/dsh-cua-vm/index.js`): `windowsMcpDoctor()` spreads those facts
into the payload (`...(transportFacts ?? {})`, so a client-less doctor simply omits
them) and adds ONE line, `transportText` (:1301), built by `windowsTransportLine()`
(:1232) from the same object: `windows mcp transport: interactive-relay (port
47999, relay up)` or `windows mcp transport: session-0 fallback: … desktop
automation will be blind`, and `not attached yet (no lane decided in this process)`
before an attach. The doctor **never dials** to fill them in — it has its own probe
budget and must not open a second SSH session.

### R4 — the package, and how it is verified

The runtime sources above are not mine to touch in this pass; what changed with
them is the part that **notices when one of them stops being true**.

| file | change |
|---|---|
| `tests/modules-unit.mjs` | OEM payload list now the four required + the clipboard agent **+ the MCP relay** (:826), and a new `J22-14` block: the probe pair read out of the python file and both lengths (`RELAY_PING` 10, `RELAY_OK` **8**), the same pair spelled once on the JS side, the port default agreeing on both sides of the wire (47999), `DSH_CUA_MCP_RELAY_PORT` override + garbage → default, `RELAY_COMMAND` verbatim, `relayProbeCommand()`'s 8-byte read, the fallback sentence, and `doctorFacts()` answering `transport: null` before any attach |
| `tools/check-cua-vm.mjs` | NEW `relay` section (both modes, loopback bind, the probe pair and its 8-byte answer, the probe outside the session lock, `bufsize: 0` + `CREATE_NO_WINDOW`, child restart/`child-exit`, `DSH_CUA_MCP_RELAY_PORT`/`_LOG`) plus needles on the backend (`OEM_MCP_RELAY_FILE`, staged to `oemDir`, the `$OEM$` copy and byte-compare), firstboot (`mcp-relay-task`, `cua-mcp-host`, `Test-RelayPing` + `byte[] 8` + `-ceq 'RELAY_OK'`, `task-started-but-relay-not-listening`), `win-mcp.js` (`RELAY_COMMAND` `py -3`, the fallback reason, `relayDoctorFacts`, `interactive-relay`/`session-0-direct`), `index.js` (`transportText`, both transport sentences), the Dockerfile (both COPYs + the proof loop) and `cua-mcp-relay.py` added to J1-6b's flat-tree set |
| `README.md` | new "The MCP server runs in the interactive session — the loopback relay" section: the Session 0 evidence table, the lane-preference table, the doctor fields, and the two env rows |
| `plugins/dsh-cua-vm/README.md` | "The interactive session — the MCP server lives there now (the relay)" replaces "…and what does not exist yet" (the note that said no long-lived user-session server could be reached), and the dsh-cua tools section now names the relay command instead of `ssh … --stdio` |
| `BRANCH-NOTES.md` | this section |

**Verify.** All of these, all exit 0, from the repo root:

```bash
node tools/check-cua-vm.mjs --root .      # 1020 assertions / 23 files; the relay's 24
node tools/check-cua-rea.mjs --root .     # 67 needles / 5 files (unchanged surface)
node tests/modules-unit.mjs               # includes J22-14 + the 6-file OEM payload list
node tests/windows-boot.mjs
node tests/windows-mcp-gate.mjs           # the real gate, fake guest: 19 tools, guard, doctor
node tests/supervisor-smoke.mjs
node tests/qmp-shutdown.mjs
```

**Residual risk, named honestly.** The relay is only as good as the logon task
being *interactive*: a guest with no logged-on user (`/it` has nothing to run in)
answers `RELAY_DOWN`, and the attach falls back to the blind lane — visibly, with
the sentence in the doctor, but blind. A relay that dies mid-session costs one
reconnect (the child is restarted); a relay caught by a firewall that
*filters* the loopback port instead of refusing it costs the 800 ms probe timeout
and lands on the same recorded fallback.

## 23. Branch `cua-vm-improve` — 2026-11-18: the shutdown that answers, the poll that could not die, a deadline for every tool

One incident, three defects, and one rule that came out of it: **the thing the
user is waiting for must not be behind the thing that takes minutes.**

### The incident

`cua_vm_shutdown` on a Windows computer hung for minutes. The tool call never
settled, the panel's Shutdown button looked dead, and aborting the chat did not
unwind it either — the user force-restarted the harness. What the supervisor was
actually doing was one synchronous call:

```js
execFileSync(qemuImgPath(), ['convert', '-O', 'qcow2', disk, `${target}.tmp`], …)
```

`qemu-img convert` of a **10 GB system disk**, on the critical path of the
ANSWER, on a computer the registry had already recorded as `powered-off`. Three
independent failures made that unrecoverable rather than merely slow:

1. the op did not answer until the convert finished, so the harness tool call had
   nothing to return (its socket default is 30 minutes, and there was no
   per-tool deadline);
2. the chat's abort could not unwind a body blocked in `await request(...)` on a
   socket that was still waiting — cooperative cancellation needs a body that
   reaches an `await` of an abortable thing;
3. the only observer of a guest power-off could die: a tick of the QMP state poll
   that threw in `finaliseGuestShutdown` (a quota-refused checkpoint threw
   *before* the row was written) left the row `ready` for the rest of the session
   and stopped the loop.

### A. The poll is unkillable, and the guest-shutdown path is state-first

`finaliseGuestShutdown` now writes, **first and unconditionally**, the four facts
a reader needs — `state: 'powered-off'`, `stateFrom: 'qmp-poll'`, `lastShutdown`
with `method: 'guest-shutdown'`, and `restoreFrom: { kind: 'image', image:
'windows' }` — and only then takes the checkpoint, in its **own** try/catch. A
refused capture can therefore only ever ADD a `checkpointSkipped: { reason,
detail }` (the live one was `quota`: a 9.9 GB disk + an 11.5 GB Linux checkpoint
+ a 3.6 GB ISO on a 20 GB store) and `lastShutdown.checkpointStatus:
'skipped:quota'` to a row that already says powered-off. Nothing a checkpoint does
decides whether the state is recorded.

The poll loop itself (`startQmpStatePoll`) follows the same rule: a throw is
logged through `noteTickFailure` **at most once a minute**
(`STATE_POLL_ERROR_LOG_MS = 60000`, so a wedged monitor cannot make the log the
tick rate), the loop is re-armed from `finally`, and `stop()` is only ever called
on a verdict — never from a catch.

### B. The shutdown answers first: a bounded QMP phase, then a detached convert

The fix is an **order**, not a bigger timeout (`WINDOWS_STOP_BUDGET_MS = 8000`,
`WINDOWS_STOP_QMP_MS = 5000`):

| step | what runs | why it is where it is |
|---|---|---|
| 1 | `windowsStopPhase(meta)` — one probe; `cont` for a paused guest; `system_powerdown`; poll pid/`query-status` | an already-off computer answers **instantly** (`already-off`); a guest that exits in a few seconds is recorded as powered-off; a guest still flushing is handed to the backend's full `shutdownTimeoutSec` window **in the background** — it is never force-quit for being slower than the budget |
| 2 | `recordWindowsPoweredOff()` writes `powered-off` + `lastShutdown` + `restoreFrom: { kind: 'image' }` + `checkpointPending: { token, at }` | this is what the panel badge, Start, the doctor and the state stream read, and it is written before anything slow |
| 3 | the op returns `checkpoint: 'deferred'` + `checkpointDeferred: true` | the answer carries a WORD, not a path: a path here could only be a lie (it does not exist yet) |
| 4 | `scheduleDeferredWindowsCheckpoint()` → `checkpointDiskFileAsync()` (spawn + await, 600 s) | the convert runs off the answer path, holds the computer's lifecycle lock (a Start cannot boot a disk that is mid-`convert`), and is **token-guarded**: if the row was started again while it ran, the result is dropped instead of resurrecting `restoreFrom` over a live row |

When the convert lands, the row is **upgraded**: `restoreFrom: { kind:
'checkpoint', file: '$STORE/checkpoints/<name>.qcow2' }` and
`lastShutdown.checkpointStatus: 'saved'`; on a quota/policy refusal,
`checkpointSkipped` is recorded, `restoreFrom` stays the disk, and the computer
**still boots its installed disk** next Start. `continueWindowsStopInBackground`
handles the other half of step 1 (a guest that outlives the budget, or a monitor
that refused ACPI), and still marks the restore point stale when the guest
survives `quit`.

### C. A deadline for every `cua_vm_*` tool

Whatever the supervisor does, the **tool layer** must settle and say what
happened. `plugins/dsh-cua-vm/index.js` now carries one `TOOL_TIMEOUTS` map, and
`registerCuaTool` REFUSES a registration whose `timeoutMs` is missing from the
map or disagrees with it — a new tool cannot be added without an envelope. Two
layers, because neither is enough:

* the declared `timeoutMs` is what the harness timeout guard
  (`@deepseek-ai/dsh-tool-call-timeout-policy`) arms — and that guard is
  cooperative: it aborts `exec.signal` and then *awaits* the body, so a body
  blocked on a dead supervisor never observes it;
* each body is therefore ALSO raced against its own deadline
  (`boundedExecute`, firing `TIMEOUT_LEAD_MS = 250` early so the specific
  sentence wins) and returns a structured failure:
  `… timed out after Ns; the supervisor op may still be running — check the
  panel/registry before retrying` with `code: tool-timeout`. The losing body is
  not orphaned: it keeps running to quiescence, which is what lets the supervisor
  finish its `qemu-img` work.

`PER_CALL_TIMEOUTS` exists for the two tools whose legitimate duration is an
argument: `cua_vm_exec` (`timeout` s + 60 s, the same clamp the schema declares)
and `cua_vm_create` (60 s for Windows — the create returns while Setup keeps
installing — 30 min for Linux, which is synchronous).

### The files

| file | change |
|---|---|
| `docker/cua-vm-supervisor.mjs` | A: state-first `finaliseGuestShutdown` + `noteTickFailure`/`STATE_POLL_ERROR_LOG_MS`; B: `WINDOWS_STOP_BUDGET_MS`/`WINDOWS_STOP_QMP_MS`, `windowsStopPhase`, `recordWindowsPoweredOff`, `scheduleDeferredWindowsCheckpoint`, `checkpointDiskFileAsync`, `continueWindowsStopInBackground` |
| `plugins/dsh-cua-vm/index.js` | C: `TOOL_TIMEOUTS`, `registerCuaTool` validation, `boundedExecute`, `toolTimeoutError` (`code: tool-timeout`), `PER_CALL_TIMEOUTS`; and the deferred sentence the model reads (`Checkpoint: deferred — runs in the background; the panel badge shows powered-off immediately.`) |
| `tests/modules-unit.mjs` | **J23**: the tool-timeout envelope as a unit contract — every registration draws from `TOOL_TIMEOUTS`, the map has no unused/keyless entry, `registerCuaTool` refuses a missing or disagreeing number, every body is raced (`boundedExecute` + `TIMEOUT_LEAD_MS`), the failure carries `code: tool-timeout`, and the deferred sentence says the badge is already powered-off |
| `tests/supervisor-smoke.mjs` | F1 rewritten for the deferred answer (answer → poll the registry ≤5 s / 200 ms → `restoreFrom.kind === 'checkpoint'` + file exists + `checkpointStatus: 'saved'`), the Windows-disk-not-the-vmm-disk proof adapted to the upgrade, and a new P4/D1 block: a fake QMP monitor + a 1 GB policy against a 2 GB disk, proving a quota-refused **guest-initiated** power-off still records `powered-off` + `checkpointSkipped: quota` |
| `tools/check-cua-vm.mjs` | 18 new supervisor needles (the budget/QMP constants, every new function, the pending token + its guard, `checkpointDiskFileAsync`, `checkpoint: status`/`checkpointDeferred`, `noteTickFailure`, `stateFrom: 'qmp-poll'`) plus the **P5 order assertion** — `windowsStopPhase` before `recordWindowsPoweredOff`, `powered-off` before the deferred schedule, and `powered-off` before `windowsCheckpointPlan` in the guest path |
| `README.md` / `plugins/dsh-cua-vm/README.md` | the shutdown contract: the button answers in seconds, the convert is deferred and upgrades the restore point, a quota refusal records `checkpointSkipped` and the computer still boots its installed disk, and a guest-initiated shutdown is recorded even when its checkpoint fails |
| `BRANCH-NOTES.md` | this section |

### Verify

All of these, all exit 0, from the repo root:

```bash
node tools/check-cua-vm.mjs --root .      # 1039 assertions / 23 files
node tools/check-cua-rea.mjs --root .     # 67 needles / 5 files
node tests/modules-unit.mjs               # 346 assertions (J23 is the envelope)
node tests/windows-boot.mjs               # 63 assertions
node tests/windows-mcp-gate.mjs           # 45 assertions
node tests/supervisor-smoke.mjs           # 254 assertions — F1/P4-D1 are the ones this section added
node tests/qmp-shutdown.mjs               # 7 assertions
```

**Residual risk, named honestly.** The tool envelope settles the CALL; it cannot
cancel the supervisor's `qemu-img` child, so a convert of a genuinely huge disk
still runs to completion in the background (that is the design: the answer no
longer waits for it, and `checkpointPending` says it is still in flight). A
supervisor that is wedged for a reason other than the convert — a dead QMP socket,
a hung `sb` — is still only cured by a restart; what changed is that the tool now
SAYS which call it was and leaves the harness responsive.
