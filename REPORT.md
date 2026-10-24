# Report — CUA personal computers for the DeepSeek Harness

Branch: `feat/cua-web` (from `dsh-desktop-git`, previously
`feat/cua-trim-obscura`)
Base: `@deepseek-ai/dsh` 0.2.1-rc.2
Image: `dsh-harness:trim-cua-20261024` — **6.29 GB** (was ~11 GB)
Date: 2026-10-24

---

## 1. Executive summary

The harness image was **43 % smaller** and the model gained something the shell
could never have: its own Linux computer on KVM. The computer is a QEMU VM owned
by a supervisor that lives *outside* the agent sandbox, so the agent can keep
running under `workspace-write` — it reaches the VM through tools, not through
`/dev/kvm` — and VM disks never enter the workspace.

On top of that the image now ships a **Personal VM (CUA)** page in the left
sidebar (next to Plugins and Automation tasks) with a Computers list, create
with a name/spec/image, Start↔Shutdown, an inline terminal, guest metrics, and a
**shared desktop** a human can take over while the model watches.

The trade made: the Android emulator (5.16 GB) and the APK toolchain (1.27 GB)
were removed. Both are better served by a VM disk than by every image.

---

## 2. What was delivered

| Area | Deliverable |
|---|---|
| Image | Emulator and APK layers cut, `cua` CLI installed, supervisor + plugin wired |
| Runtime | `docker/cua-vm-supervisor.mjs` — UDS JSON supervisor: create/exec/put/get/port/suspend/resume/start/stop/delete/list/metrics/view/screenshot/input/config |
| Model tools | 8 `cua_vm_*` tools + a prompt section that tells the model to ask (`ask_user_question`) before creating a computer |
| UI | Personal VM (CUA) left-nav page: list, New computer (name, vCPU, RAM, image), Start/Shutdown, Terminal, Metrics, Delete, Policy |
| Shared desktop | `Show VM` — `cua sb view` minted into `/cua-vm/views.json`, proxied at `/vm/view/<name>/`, framed same-origin, ticket in the fragment |
| HTTP fallback | `Frames (http)` — PNG stills every 1.2 s, clickable, with typing through `xdotool` in the guest |
| Previews | `/vm/port/<name>/` HTTP + WebSocket, same origin as the harness |
| Policy | `/cua-vm/config.json`: autoSuspend, idleSuspendMinutes, diskQuotaGb, maxRunning — editable from the page, read every minute |
| Housekeeping | Built-in MCP rows (`browser-mcp`, `brave-devtools-mcp`) filtered out of the MCP manager list |

---

## 3. Environment and constraints

* Host chain: Proxmox → OMV → Docker (Sysbox dind) → harness container.
* The harness is reached over LAN HTTP (`http://192.168.0.101:13080`) for these
  tests; production is expected behind HTTPS.
* The agent runs under `workspace-write`: Landlock read-write only for
  `/dev/null`, `/tmp` and the workspace root. That is the reason the VM cannot
  be reached through `/dev/kvm` from the shell.
* No external Docker was touched; the test engine was the local Sysbox dind.

---

## 4. Image changes

### Removed

| Layer | Uncompressed |
|---|---|
| Android emulator + system images | ~5.16 GB |
| APK static toolchain (JDK, jadx, apktool, build-tools) | ~1.27 GB |
| Obscura browser payload (added, then removed — see §8) | ~165 MB |

### Added

* `cua` CLI 0.7.0 (~45 MB);
* `docker/cua-vm-supervisor.mjs`;
* `plugins/dsh-cua-vm` in both `node_modules` roots plus the installation
  manifest;
* `tools/patch-mcp-manager.mjs`.

QEMU (~200 MB) and the base VM image (~1.3 GB) are pulled into the `/cua-vm`
volume on first use, not baked in.

---

## 5. Architecture

```
agent shell (workspace-write)
        │  no /dev/kvm
        ▼
  cua_vm_* tools ──(unix socket /tmp/cua-vm/supervisor.sock)──► supervisor
                                                                   │ owns /dev/kvm
                                                                   ▼
                                                             QEMU Linux VM
                                                             (cua-spacesd :3211)
        browser ──/vm/port/<name>/──┐                                  ▲
                ──/vm/view/<name>/──┴── proxy.mjs ────────────────────┘
```

The supervisor holds the device, the QEMU process, the cua store and the
policy. The harness restarts are the supervisor's problem, not the model's:
`vmStart` rebuilds a VM whose QEMU process is gone.

---

## 6. Verification matrix

All of the following were exercised against the built image on the dind test
engine (`/dev/kvm` present, `crw-rw-rw- nobody nobody`).

| # | Test | Result |
|---|---|---|
| 1 | Image builds with the cuts and the additions | pass, 6.29 GB |
| 2 | Supervisor boots before the harness, socket at `/tmp/cua-vm/` | pass |
| 3 | VM create (Ubuntu slim), boot with `-accel kvm` | pass |
| 4 | Command inside the VM | pass, 141 ms round trip |
| 5 | Store path outside the workspace | pass, 690 MB after first boot |
| 6 | Port preview `/vm/port/<name>/` | pass, HTTP 200 from a guest `python3 -m http.server` |
| 7 | Policy edit persists across a container recreate | pass (5 / 25 / 2 read back) |
| 8 | Idle suspend | pass, 5-minute policy suspended an idle VM |
| 9 | Start after a container restart (QEMU dead) | pass, VM recreated from its spec |
| 10 | 8 tools visible to a free OmniRoute model, `cua_vm_status` called end to end | pass |
| 11 | Left-nav page renders, 1000 px centered column | pass |
| 12 | New computer (name, 1 vCPU, 1 GB) through the form | pass, `lab` running |
| 13 | Start → Starting… → Shutdown | pass, state `running`, button flipped, note cleared |
| 14 | Terminal tab (`uname -sr`, `nproc`, `id -un`) | pass: `Linux 6.8.0-147-generic`, `1`, `cua` |
| 15 | Metrics tab | pass: load 0.10/0.12/0.05, mem 359/961 MB, disk 1.4G/20G (8 %) |
| 16 | Show VM (views.json → `/vm/view/lab/`) | pass, HTTP 200, viewer boots |
| 17 | Viewer video/input over plain HTTP | **blocked by the browser** (no secure context): frame fallback used instead |
| 18 | Frames fallback | pass, 1280×800 PNG of the guest XFCE desktop |
| 19 | Dark and light themes | pass, tokens resolve (`rgb(35,35,36)` / `rgb(15,17,21)`), outlined buttons |

Not verified end to end: the frame view's click/type plumbing (implemented via
`xdotool`, shipped, untested) — it is only needed on plain HTTP, and the plan
is HTTPS.

---

## 7. Problems found and fixed

* **`cua sb create --headless`** does not exist in 0.7.0 — dropped; readiness
  waits on `tcp:3211`.
* **QEMU `could not load PC BIOS 'bios-256k.bin'`** — seabios files were not
  linked into the QEMU data dir; the supervisor repairs the symlinks.
* **Build gate failed** on a missing `assets/scripts/check_office.py` (removed
  upstream 0.2.1-rc.2) — the gate now validates the skills.
* **Prompt section rejected** `order` → `tool:cua_vm`, order 120.
* **CUA switch empty** — the row was missing from the page's row table.
* **Client crash** `Cannot access 'call' before initialization` — callbacks moved
  after their dependencies.
* **Resume after container recreate** fails (`qemu does not support starting…`)
  — `ensure`/`vmStart` now recreate from the recorded spec.
* **Preview 502** — proxy read `/tmp/cua-vm/ports.json`, supervisor wrote
  `/cua-vm/ports.json`; the paths were unified.
* **`/dev/kvm` `Permission denied` behind Sysbox** even privileged (userns
  `0→165536`, device shows `nobody:nogroup`) — host udev `MODE="0666"`.
* **Panel was white in dark mode** — it used `--dsw-alias-bg-elevated`, which
  does not exist; switched to `bg-layer-1` / `label-*` / `border-l3`.
* **Viewer refused framing** (`frame-ancestors 'none'`) → rewritten to
  `'self'`, which is the harness origin.
* **Viewer gRPC 502** — spacesd serves services at root paths that the viewer
  resolves against `/vm/view/`; dotted segments now route to the newest viewer.
* **Start looked static** — cua reports `running` (not `ready`) after a fresh
  boot, and the list did not poll; both fixed.

---

## 8. Decisions

* **Obscura was removed.** It is a browser engine, not a CDP client: it cannot
  drive the shared Brave, so it could never replace Playwright while keeping the
  visible browser. Keeping it would have cost ~165 MB for nothing.
* **MCP rows hidden, not disabled.** `browser-mcp` and `brave-devtools-mcp` stay
  bundle-owned and switchable on the Plugins page; the manager list is filtered
  so the same switch is not offered twice.
* **The agent never gets `/dev/kvm`.** The supervisor owns the device; the agent
  talks to it over a socket in `/tmp`. This is what keeps `workspace-write`
  meaningful.
* **VM disks outside the workspace.** They live in the `cua-vm` volume, so the
  workspace stays clean and a finished product is copied back deliberately.
* **Policy in a file, not in the image.** The user's idle timeout, quota and
  running limit are editable at runtime.

---

## 9. Known limitations

* A container restart kills QEMU, and cua 0.7.0 cannot start such a VM again;
  the fallback recreates it, losing that machine's disk delta.
* The interactive viewer needs HTTPS (or localhost). Plain HTTP gets PNG frames
  plus click/type through `xdotool`.
* Debian and Arch are not Cua disks: the image dropdown offers Ubuntu slim and
  full, and the page says a custom disk must be built with `cua images build`.
* The Android emulator capability is gone from this branch by design.
* The MCP-manager patch is content-anchored against a third-party bundle; a
  plugin update that moves the anchor logs a warning and leaves the list
  unfiltered until refreshed.

---

## 10. Reproduce

```bash
git clone https://github.com/yakuza8702/docker-deepseek-harness-profile
cd docker-deepseek-harness-profile
git checkout feat/cua-web

docker build --build-arg DSH_VERSION=0.2.1-rc.2 -t dsh-harness:trim-cua .
docker compose -f compose.yaml -f compose.emulator.yaml up -d

docker exec <c> cua --version
docker exec <c> tail -f /cua-vm/supervisor.log
```

Then open the harness, **Personal VM (CUA)** in the left sidebar, and press
**New computer**.

---

## 11. Next

1. Serve the harness over HTTPS so Show VM uses the real video/input viewer
   (the frames fallback then becomes unnecessary).
2. VM over MCP: `cua mcp` behind a stdio→HTTP bridge at `/vm/mcp`, same auth
   fence and token as the tools, so agents other than this harness can use the
   same per-workspace computer.
3. Optionally, "VM as workspace": route the shell and file tools into the guest
   so the model's `bash` runs where the VM is, matching BoxCompute's model.
