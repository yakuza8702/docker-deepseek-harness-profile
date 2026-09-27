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
```

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
| `POST /api/dsh-profile-switcher/create` | `{ name, from? }` | copies an existing profile (default: the active one) |
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
