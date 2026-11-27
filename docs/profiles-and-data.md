# Profiles and data — switching, `$DSH_HOME`, and the in-app pill

What a profile is, where the data lives, and the control that switches between profiles without editing a file. See the [README](../README.md) for the quick start.

## Profile switching — this fork's one change against upstream

Upstream's entrypoint hardcodes `dsh web`, so a container can only ever boot the
`web` profile. Here the boot resolves a **stored selection** instead:

```
$DSH_HOME/active-profile.json   ->   { "version": 1, "active": "research" }
```

Rules applied at every boot (see `docker/entrypoint.sh`):

* the name must match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` (no paths, no
  `node_modules`);
* the profile's `package.json` must parse and its `dsh.profile.bundles` must
  contain **both** `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`;
* anything missing, malformed or not web-capable falls back to **`web`** — a bad
  selection can never leave the container without a Web UI;
* the boot log states the outcome: `[seek-harness] active profile: <name>`;
* **fresh start: the fallback is written down.** The first boot of an empty
  `$DSH_HOME` stores `{ "active": "web" }`, so the in-app panel and the recovery
  page show `web` as the *current* profile (its row is inert — no "Switch"
  button) instead of reporting the active profile as `unknown`. The file is
  visible on the host inside the mounted data directory, so the selection is a
  fact you can read and edit, not an inference. A *stale* stored name that
  cannot boot this build never rewrites your file: the boot falls back to `web`,
  logs a warning, and the recovery page is where you repair it;
* profiles share one `$DSH_HOME` (settings, sessions, credentials, skills,
  workspace); only the **composed plugin tree** differs.

Add a second profile and switch to it:

```bash
# 1. a new profile, seeded from the shipped `web` profile
docker exec seek-harness cp -a /home/node/.dsh/profiles/web /home/node/.dsh/profiles/research
#    (plugins installed later land in profiles/research/node_modules only:
#     docker exec seek-harness dsh plugin --profile research add <package>)

# 2. store the selection (this is exactly what a wrapper/app writes)
docker exec seek-harness node -e \
  'require("fs").writeFileSync("/home/node/.dsh/active-profile.json", JSON.stringify({version:1,active:"research"})+"\n")'

# 3. reboot into it
docker restart seek-harness && docker logs --tail=5 seek-harness
#    -> [seek-harness] active profile: research
```

`tools/apply-profile-patch.mjs` re-applies the entrypoint change after syncing
from upstream (idempotent, content-anchored: it refuses an absent or ambiguous
anchor). A companion Electron shell that manages profiles and restarts the
container lives outside this repo.

## Where your data lives — `~/.dsh`, `$DSH_HOME` and `/workspace`

DSH resolves its user data as `--dsh-home` > `$DSH_HOME` > `~/.dsh`
(`@deepseek-ai/dsh-home-paths`). This image keeps **two** spellings of "home":

| Spelling | Container path | What it is |
|---|---|---|
| `$DSH_HOME` | `/home/node/.dsh` | the harness home — profiles, settings, sessions, credentials, skills, the browser profile |
| `$HOME` | `/workspace` | the **agent workspace** (the mounted project), because the Web UI's directory picker treats `HOME` as the starting point |

Every guide, README and community recipe in the ecosystem says
`~/.dsh/profiles/<name>/pnpm-workspace.yaml`, so the two spellings must be the
same directory — and the entrypoint makes them so: it symlinks
`$HOME/.dsh -> /home/node/.dsh` at every boot. `~/.dsh`, `/home/node/.dsh` and
the host-side `dsh-home/profiles/...` you edit through the mount are therefore
**one directory**, whichever way you reach it.

A shell that starts without the image environment (`su -`, an ssh login, a
console that scrubs the env) also gets `DSH_HOME` from
`/etc/profile.d/10-dsh-home.sh` and `/etc/bash.bashrc`.

> ⚠️ **Upgrading from an image built before 2026-10-02:** that alias did not
> exist yet, so a `dsh plugin … add` run from such a shell installed into a
> *phantom* home at `/workspace/.dsh` that the launcher never reads (symptom:
> the plugin installs "successfully", the plugin market never appears, and a
> `pnpm-workspace.yaml` you edit there changes nothing). On the first boot with
> the alias in place, an existing real `/workspace/.dsh` directory is **parked**
> as `/workspace/.dsh.orphan-<UTC>` (never deleted) and logged — inspect it, move
> anything you still want into `profiles/<name>/`, and re-run the install.

## In-app profile control — the pill beside Settings

The image also carries **`dsh-profile-switcher`**: one pill in the Web UI's
sidebar foot (slot `sidebar.footer.action`, right beside *Settings*), and in it
exactly three things — switch profile, *New Profile…*, *Safe Mode*. No menu bar,
no other entries.

```
sidebar footer:   ◍ Profile: research ▸      Settings
                  ┌────────────────────────────────────────────┐
                  │ Available Profiles                         │
                  │ research · current    3 bundles (1 added)  │
                  │ web                   stock bundles  [Switch]
                  │ ─────────────────────────────────────────  │
                  │ [ new profile name ]        [ + New Profile ]
                  │ [ Safe Mode — boot stock bundles only ]     │
                  └────────────────────────────────────────────┘
                  ↓  "+ New Profile" asks before it creates
                  ┌──────────────────────────────────────┐     ← centred dialog
                  │ Create profile “test”                │
                  │ How should it start?                 │
                  │ ┌──────────────────────────────────┐ │
                  │ │ Start New                        │ │
                  │ │ stock bundles only, nothing copied│ │
                  │ ├──────────────────────────────────┤ │
                  │ │ Inherit plugins                  │ │
                  │ │ a copy of “web” — the branch case│ │
                  │ └──────────────────────────────────┘ │
                  │                           [ Cancel ] │
                  └──────────────────────────────────────┘
```

* host routes: `GET /api/dsh-profile-switcher/list`, `POST …/select`,
  `POST …/create`, `POST …/reset`, `POST …/safe`, `POST …/restart`;
* **creating a profile asks HOW it should start** — one click used to copy the
  source profile, so a profile made to isolate something arrived carrying every
  plugin of the profile it came from. *Start New* writes the **stock skeleton**
  (the two shipped bundles, an empty dependency list and patch layer, no
  `node_modules`) using DSH's own `initProfile`; *Inherit plugins* copies the
  current profile — the branch case. `create` takes `mode: "new" | "inherit"`,
  and a caller that sends no mode keeps getting the copy;
* **every row can be reset to the shipped default** (`⟲`, whose words appear on
  hover/focus like the trash's). It deletes everything INSIDE `profiles/<name>` —
  plugins, pins, `node_modules`, patch layer — and writes the skeleton back, keeping
  the folder name, its label and its list position. It is the only destructive
  action the locked `web` profile has (it can never be deleted), and resetting the
  profile the harness is RUNNING from restarts it, so a session stuck on a broken
  plugin set is fixable from the panel;
* a switch writes `active-profile.json` and asks the harness to exit — the
  container's `restart: unless-stopped` brings it back **on the selected
  profile** (the UI confirms first, then waits for the harness and reloads);
* **Safe Mode** creates/boots `shell-safe` (the shipped bundles only) with an
  empty patch layer, so a broken third-party plugin can be removed from the UI;
* installation/removal is one file: the launcher applies
  `/opt/seek-harness/profile-switcher.overlay.yml` as a `--patch` overlay
  (`DSH_PROFILE_OVERLAY=` disables it, any other path replaces it). No profile
  directory in `$DSH_HOME` is edited — the pill is mounted by the launcher, so it
  appears in *every* profile, including Safe Mode.

Two implementation details that were not obvious and are load-bearing:

1. **The package must be declared in the installation manifest.**
   `node_modules/…` alone is not enough: the launcher builds its module-resolution
   table by walking the installation package's dependency closure, and
   `client-modules` maps a loader row back to a *package name* to compose its
   browser half. A package that merely sits in `node_modules` fails with
   `failed to import`. The Dockerfile therefore adds
   `"dsh-profile-switcher": "0.1.0"` to the dependencies of
   `/opt/dsh/node_modules/@deepseek-ai/dsh/package.json` (and of
   `/opt/dsh-src/apps/cli/package.json` on source-channel images).
2. **The browser half follows the `client-modules` contract**:
   `window.__ModuleLoader__.load({ id, factory })` where `factory(require)`
   **returns** the exports object — there is no `exports`/`module` in that scope.
