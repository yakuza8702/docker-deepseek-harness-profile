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
