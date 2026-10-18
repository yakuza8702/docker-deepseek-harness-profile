# dsh-profile-switcher

The smallest useful Profile control for the DeepSeek Harness **Web UI**: one pill
beside Settings, and in it exactly three things — **switch profile**, **New
Profile…**, **Safe Mode**. No menu bar.

```
sidebar.footer.action  (root scope, list cardinality — additive)
   └─ ◍ Profile: research            ← the pill
        ┌───────────────────────────────────────────┐
        │ Available Profiles                        │
        │ web · current            Current Profile  │
        │ research  3 bundles      [ Switch ]       │
        │ shell-safe · Safe Mode   [ Switch ]       │
        │ ─────────────────────────────────────────  │
        │ [ new profile name ]        [ + New Profile]
        │ [ Safe Mode — boot stock bundles only ]   │
        └───────────────────────────────────────────┘
                    ↓  "+ New Profile" asks first
        ┌───────────────────────────────────────┐     ← centred, over the panel
        │ Create profile “test”                 │
        │ How should it start?                  │
        │ ┌───────────────────────────────────┐ │
        │ │ Start New                         │ │
        │ │ stock bundles only, nothing copied│ │
        │ ├───────────────────────────────────┤ │
        │ │ Inherit plugins                   │ │
        │ │ a copy of “web” — the branch case │ │
        │ └───────────────────────────────────┘ │
        │                            [ Cancel ] │
        └───────────────────────────────────────┘
```

Every row is the same strip of controls, left to right:

```
[ Switch ]  ✎ rename  ▲ up  ▼ down  ⟲ Reset to Default  🗑 Delete
 │          │         │     │       │                   └ 🔒 on `web` — the
 │          │         │     │       │                      default profile cannot
 │          │         │     │       └ the words appear    be deleted, so reset is
 │          │         │     │         on hover/focus only  its only way back
 │          │         └─────┴─ reorder the list (sidecar, folders never move)
 │          └─ cosmetic label; the folder keeps its name
 └─ absent on the profile this harness is running from ("Current Profile" instead)
```

## Two ways a profile can start

A new profile used to be one thing: a **copy** of the source profile, so a profile
created to try something in isolation arrived carrying every plugin of the profile
it came from — invisible until it booted. The click now asks, and the answer is
what creates the profile.

| Answer | What it writes | When it is the right one |
|---|---|---|
| **Start New** | `profiles/<name>/` with the shipped bundles only — `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`, an empty `dependencies`, an empty patch layer and the hoisted pnpm settings. No `node_modules`, no plugins. | a clean slate: add plugins from the Plugins page and keep this profile's set separate from every other one |
| **Inherit plugins** | a recursive copy of the source profile (the active one, or `from`): plugin set, pins, patch layer and installed `node_modules` included. | branching: keep a working set and diverge from it |

**Start New** is written by DSH's own `initProfile`
(`@deepseek-ai/dsh-app-boot`), the same call the image's entrypoint uses for the
shipped `web` profile, so no template knowledge is duplicated; when an image has no
loadable initialiser the host half writes the identical three files itself.
`tools/check-profile-switcher.mjs` fails the image build if those two ever disagree,
and exercises both modes through the real route.

Both answers produce a **web-capable** profile (`dsh-base` + `dsh-web-app`), which
is the condition the switcher selects on — a new profile can therefore always be
switched to and deleted again.

## Reset to Default — the way back, on every row

`⟲ Reset to Default` deletes **everything inside `profiles/<name>`** — plugins,
pins, `node_modules`, market state and the profile's own patch layer — and writes
the shipped skeleton back in its place. The directory keeps its name, so the
profile ends up exactly what *Start New* would have created.

It is on **every** row, including the two that otherwise have no destructive action
at all:

* **`web`** — the launcher's fallback profile, which can never be deleted, so
  resetting it is the only way to get rid of a plugin set that broke it;
* **the profile this harness is running from** — resetting the running profile is
  the point: it is how a session that boots into a broken plugin set gets fixed
  without leaving the UI.

What it does **not** touch is as important as what it does: profile **labels**, the
list **order**, and everything at the home level — sessions, settings, credentials —
live outside the profile directory, and a reset undoes a plugin set, not a rename.
The control itself is a row icon whose word appears on hover/focus (the same
treatment the trash gets), because a row that always reads "Reset to Default"
beside "Delete" is a row that invites the wrong click.

**A reset of the ACTIVE profile restarts the harness.** The running process still
serves the plugin set it loaded at boot, so the clean tree only exists after a
reboot; the host half answers `restartRequired: true`, and the panel restarts and
waits exactly like a profile switch (including the recovery hand-off if the boot
fails). Resetting any other profile is an in-place operation — switch to it when
you are ready.

## Why a restart is part of the feature

A DSH profile is a **boot-time launcher input** (`dsh --profile <name>` →
`$DSH_HOME/profiles/<name>`): no code running inside the process can change it.
This plugin therefore

1. writes `$DSH_HOME/active-profile.json` (`{ "version": 1, "active": "<name>" }`) —
   the file the `docker-deepseek-harness-profile` entrypoint reads at boot, and
2. asks the harness to exit; `restart: unless-stopped` brings the container back
   **on the selected profile**.

The UI confirms first, then polls until the harness answers and reloads the page.

## Host routes

| Route | Body | Effect |
|---|---|---|
| `GET /api/dsh-profile-switcher/list` | — | active profile + every profile with its bundle count and web-capability |
| `POST /api/dsh-profile-switcher/select` | `{ name }` | validates, writes the selection (atomic) |
| `POST /api/dsh-profile-switcher/create` | `{ name, mode?, from? }` | `mode: "inherit"` (default, and the behaviour of every older caller) copies `from`; `mode: "new"` writes the stock skeleton and copies nothing. Answers `{ name, mode, from, skeleton }` |
| `POST /api/dsh-profile-switcher/reset` | `{ name }` | deletes everything inside `profiles/<name>` and writes the stock skeleton back; the folder, its label and its list position stay. Answers `{ name, reset, skeleton, restartRequired }` |
| `POST /api/dsh-profile-switcher/safe` | — | ensures `shell-safe` (stock bundles only), selects it, restarts |
| `POST /api/dsh-profile-switcher/restart` | — | exits the process; the container policy reboots it |

Every mutation answers **before** the process exits, and every refusal is a `400`
with a reason the pill prints — a profile that cannot boot the Web app
(`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`) is never selectable, so a
bad choice cannot lock the UI out.

## Requirements

* an image whose launcher honours `active-profile.json`
  (`docker-deepseek-harness-profile`) — on stock images the pill still lists
  profiles but a switch cannot take effect;
* the container must be able to come back on its own: `restart: unless-stopped`
  (or any supervisor that restarts it).
