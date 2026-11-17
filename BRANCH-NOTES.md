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
