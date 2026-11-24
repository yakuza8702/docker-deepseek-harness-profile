# Two desktop paths, one rule

There are **two** ways an agent can see and drive a Windows screen from DSH, and
they are not two implementations of one thing: they drive **different machines**.
This page is the rule that keeps them from being wired to the same session at the
same time, and the table that tells an operator which one a task needs.

## 1. The two machines

| | **guest VM** — this plugin (`dsh-cua-vm`) | **host desktop** — `dsh-windows-mcp` |
|---|---|---|
| what it drives | the QEMU guest started by `cua-vm-supervisor.mjs`: a Windows install whose medium comes from that code's ISO **chain** (`kind: "windows"` — live `mido` page for `11`/`10`, a pinned `midoDirect`/ESD/mirror entry for the rest; see `windows-iso-sources.md`) or the Linux Cua guest | the physical PC that DSH itself runs on, through `CursorTouch/Windows-MCP` over stdio (`uvx windows-mcp serve`) |
| transport | guest OpenSSH (exec/put/get), QMP for input and `query-status`, noVNC relay for the live view | the in-box MCP client (`@deepseek-ai/dsh-mcp-client`), `mcp__windows__*` tools |
| tool names | `cua_vm_*` tools, `cua_vm_gui`, and the lazily revealed `tool_*` element tools over the guest relay | `mcp__windows__Screenshot`, `Snapshot`, `Click`, `Type`, `Clipboard`, `Process`, `Registry`, … |
| screenshots | `cua_vm_gui {action:'screenshot'}` (print screen path + the measured space line) and the live view at `/vm/port/<name>/` | `mcp__windows__Screenshot` — the image lands as a real attachment |
| accessibility tree | `cua_vm_gui {action:'a11y'}`; element actions only when the guest advertises them (`elementLaneOk`) | `mcp__windows__Snapshot` — a text tree with no image tokens |
| click / type | `cua_vm_gui` `click` / `type` over QMP, mapped from the screenshot pixels | `mcp__windows__Click` / `Type` / `Shortcut` |
| clipboard | the panel's Clipboard section (the guest runs no clipboard agent; there is no `clipboard` action on Windows) | `mcp__windows__Clipboard` |
| processes / registry | `cua_vm_exec` (`tasklist`, `reg query`) — shell only | `mcp__windows__Process` / `Registry` |
| waits | poll `cua_vm_status` / `cua_vm_exec` | `mcp__windows__Wait` / `WaitFor` (an actual UI condition) |
| self-diagnosis | `cua_vm_doctor` (host facts) + `windows_mcp_doctor` (the guest bridge's lane) | `windows_mcp_doctor` (the plugin's own tool) |
| startup cost | one ISO, one install (`windowsInstallTimeoutMinutes`, default 60) | `uvx` + a Python toolchain; off until an install rewrites the bridge row |

## 2. The rule

**One desktop target per session. Never both.**

Both builds register a desktop toolset into the same agent loop, so "both" is not
a synonym for "more capable" — it is three concrete failures:

* **Two cursors, one desktop.** The guest bridge clicks through QMP on the VM's
  screen; the host bridge injects Win32 input into the PC's session. A model that
  alternates between them clicks in one machine while reading coordinates from
  the other, and neither tool can tell that it happened.
* **Doubled schemas on every step.** Eighteen `mcp__windows__*` schemas plus the
  revealed `tool_*` names is context spent on every request, including the ones
  that never touch a screen.
* **`serverName` is part of the tool name.** Renaming it (`windows` → anything)
  renames every tool and invalidates the prompt cache prefix for the session —
  see `plugins/dsh-cua-vm/win-mcp.js` (`DEFAULT_SERVER_NAME`).

The rule is enforced by configuration, not by hope: the guest bridge is gated per
agent (`windowsGuardDecision`), and the host plugin's "Grant new sessions by
default" stays **off** so a session only sees the desktop it was explicitly given.

## 3. When the host path is right

`dsh-windows-mcp` is **opt-in**, and it earns its place when the task is about
the PC DSH runs on:

* UIA verbs the guest bridge has no equivalent for: `Snapshot` (a text tree
  without image tokens), `WaitFor` (wait until a UI condition, instead of
  sleeping), `Scrape`, `MultiSelect`/`MultiEdit`, `ControlStatus`,
  `DisplayInventory`, `Registry`.
* Context hygiene the guest bridge does not have: the off-by-default Computer Use
  pill and the lazy `windows_desktop` reveal.
* A per-version toolchain (`UV_TOOL_DIR` per `windows-mcp` version) with a
  fastest-mirror installer and a rollback that only rewrites the bridge row.

It is **not** for duplicating guest clicks. If the task is "click through Setup in
the VM", the guest bridge is the tool: it owns that screen, its live view and the
install watcher.

When it is adopted, keep the curated defaults: `App/PowerShell/FileSystem`
excluded (DSH already ships shell and file tools), lazy tools **ON**, *Grant new
sessions* **OFF**, and gate the exposure on `windows_mcp_doctor` — a bridge row
that shipped disabled is the normal state, not an error.

## 4. The Windows Session-0 doctrine, restated

This is not new work — it is already implemented here, and this section is the
cross-reference so nobody re-derives it:

* **Windows OpenSSH runs in Session 0, which has no desktop.** A process started
  by `sshd` can open files and run commands, but its "screen" is not the
  interactive one. That is why `cua_vm_exec` works the moment the SSH banner
  answers, while `cua_vm_gui` needs the QEMU display instead of anything inside
  the guest's SSH session.
* **Input comes from the interactive session, over the relay.**
  `docker/cua-mcp-relay.py --serve` listens on `127.0.0.1:<port>` inside the
  logged-in desktop session; `--connect` is a plain byte bridge from SSH stdio to
  that socket, so the harness's guest tool call reaches a process that really owns
  the desktop. `docker/windows-oem/cua-relay-guard.ps1` is the single owner of
  "is that listener up, and does it answer `RELAY_PING`?", and
  `docker/windows-oem/cua-firstboot.ps1` stages it plus the two scheduled tasks.
* **A blank desktop is a fact, not a hang.** The bridge reports `blind: true` with
  a `blindReason` when it is attached on the session-0 fallback lane, and
  `windows_mcp_doctor` reports `viewer.code: attaching` while the interactive
  session is still being dialled. Never read either as "there is no computer".

`dsh-windows-mcp` inherits the same doctrine for the same reason (its stdio child
is started from DSH, which may itself be in Session 0 on a service install). The
difference is only *which* machine's desktop sits behind the pipe.
