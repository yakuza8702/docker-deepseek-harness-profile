# seek-harness

A self-built, hardened **DeepSeek Harness (DSH)** container image.

It packages the **official npm release** of [`@deepseek-ai/dsh`](https://github.com/deepseek-ai/deepseek-harness) and combines the best of the two unofficial reference builds — **without** runzhliu's browser stack:

| Input | What is taken |
|---|---|
| **official** [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | `@deepseek-ai/dsh` npm package, pinned + verified at build time |
| **smanx** [`devtools-latest`](https://hub.docker.com/r/smanx/deepseek-harness) | complete devtools package set **+ the "0.0.0.0 fix"**: built-in Node reverse proxy (`0.0.0.0:3080 → 127.0.0.1:DSH_PORT`) with HTTP+WS forwarding, optional Basic Auth, `crypto.randomUUID` polyfill for non-secure LAN pages |
| **runzhliu** [deepseek-harness-docker](https://github.com/runzhliu/deepseek-harness-docker) | security hardening: non-root UID 1000, `tini` init, fixed pnpm, build-time version verification, `HOME=/workspace` dir-selector fix, `--expose-internals` only on the DSH main process, cap_drop ALL / no-new-privileges / read-only rootfs in compose. **NOT taken:** Chromium / Xvfb / noVNC / `@runzhliu/dsh-browser-desktop` (no browser) |
| **this repo** | Docker engine access: mounted `docker.sock` **or** Docker proxy over TCP via `DOCKER_HOST`; docker CLI + compose plugin inside the image; GitHub workflow that auto-follows the official repo and keeps `:latest` current |

## Why a reverse proxy? (the 0.0.0.0 fix)

`dsh web` serves `http://127.0.0.1:3080` and the CLI **intentionally refuses `--host 0.0.0.0`** (anti unauthenticated-RCE measure). A container port forward needs a non-loopback listener, so this image keeps DSH on `127.0.0.1:$DSH_PORT` inside the container and exposes a zero-dependency Node reverse proxy on `$PROXY_HOST:$PROXY_PORT` (smanx approach) that provides:

- HTTP **and** WebSocket forwarding (`/api/events.mux`, `/api/events.host`, ...)
- optional **HTTP Basic Auth** (enabled when `PROXY_USERNAME` *and* `PROXY_PASSWORD` are set; applies to HTTP and WS; `/manifest.webmanifest`, `/favicon.svg`, `/favicon.ico` are bypassed)
- **zero-auth LAN auto-login** (default): `dsh web` generates a session token at boot and requires it (`401` + `?token=` URL). The entrypoint captures that token from DSH's stdout and hands it to the proxy, which transparently re-requests with it and relays the `303` + session cookie for browser navigations (`sec-fetch-mode: navigate` / `Accept: text/html`). You just open the bare URL — no token, no prompt, survives every restart. Non-navigation clients (API scripts) still get the plain `401`
- a **`crypto.randomUUID` polyfill** injected into served HTML — pages opened over a LAN IP are a browser *non-secure context* where `randomUUID` is unavailable, which otherwise leaves the realtime WS channel pending forever
- `Host` rewritten to the loopback authority so DSH's `/api` browser-trust fence treats proxied traffic as local (add real authorities via `DSH_TRUSTED_HOSTS` when fronting with your own authenticated proxy)

## Quick start (compose)

```bash
cp .env.example .env            # edit: workspace path, bind, auth, docker access
docker compose pull
DSH_WORKSPACE=/abs/path/to/project docker compose up -d
# open http://127.0.0.1:3080/
```

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
```

* host routes: `GET /api/dsh-profile-switcher/list`, `POST …/select`,
  `POST …/create`, `POST …/safe`, `POST …/restart`;
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

## Quick start (plain docker run)

```bash
docker pull ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest

docker run -d --name seek-harness \
  -p 3080:3080 \
  -v seek-harness-home:/home/node/.dsh \
  -v "$PWD":/workspace \
  --restart unless-stopped \
  ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest
```

Other entrypoint forms:

```bash
# flags go straight to dsh (headless one-shot)
docker run --rm -v "$PWD":/workspace ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest \
  --profile headless "summarize this repository"

# arbitrary command (shell into the devtools image)
docker run --rm -it --entrypoint bash ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest
```

## Docker engine access (agent can run docker)

**Option A — Docker proxy over TCP (preferred):** point `DOCKER_HOST` at a filtered socket proxy, e.g. [tecnativa/docker-socket-proxy](https://hub.docker.com/r/tecnativa/docker-socket-proxy):

```yaml
# .env
DOCKER_HOST=tcp://docker-socket-proxy:2375
```

**Option B — host docker.sock:**

```bash
# on the HOST: get the docker group gid
stat -c %g /var/run/docker.sock     # e.g. 999

# .env
DOCKER_GID=999

# then run with the override
docker compose -f compose.yaml -f compose.docker.yaml up -d
```

> ⚠️ Mounting `docker.sock` is root-equivalent access to the host daemon. The TCP-proxy route with a filtered proxy is the safer pattern. Both keep the rest of the hardening intact (the docker CLI needs no capabilities).

Inside the container: `docker ps`, `docker compose version`, `docker build ...` all work via socket **or** `DOCKER_HOST`.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PROXY_PORT` | `3080` | Public proxy port (the only listening surface) |
| `DSH_PORT` | `3079` | DSH loopback port inside the container (must differ) |
| `PROXY_HOST` | `0.0.0.0` | Proxy bind address inside the container |
| `PROXY_USERNAME` / `PROXY_PASSWORD` | unset | Basic Auth (HTTP+WS); enabled only when **both** set |
| `PROXY_INJECT_POLYFILL` | `1` | Inject the `crypto.randomUUID` polyfill into HTML |
| `PROXY_UNLOCK_REMOTE_SETTINGS` | `1` | Rewrite served JS so LAN pages get host settings persistence (DSH otherwise restricts settings editing to loopback pages) |
| `DSH_TRUSTED_HOSTS` | empty | **REQUIRED for LAN access.** Comma-list of `host[:port]` authorities DSH's `/api` trust fence accepts — set to your LAN authority, e.g. `192.168.0.6:3080`. Without it, `/api` calls (models, plugins, settings) return 403 |
| `DOCKER_HOST` | unset | Docker proxy over TCP (e.g. `tcp://socket-proxy:2375`) |
| `DOCKER_GID` | `999` | Host docker group gid for the `compose.docker.yaml` override |
| `DSH_WORKSPACE` | `./workspace` | Compose-only: workspace bind source |
| `DSH_BIND` | `127.0.0.1` | Compose-only: host publish address (`0.0.0.0` = LAN) |
| `DEEPSEEK_API_KEY` | unset | Runtime credential (or configure in the Web UI settings) |
| `DSH_TELEMETRY_DISABLED` | `1` | Hard-disabled locally by default (empty = upstream default) |
| `DSH_PERMISSION_MODE` | unset | `read-only` / `workspace-write` / `danger-full-access` — confined modes use the bundled Landlock launcher (kernel ≥ 5.13); on kernels without it use `danger-full-access` |
| `DSH_TOOLS_MODE` | unset | `native` / `ptc` / `both` |
| `DSH_NODE_FLAGS` | `--expose-internals` | Node flags for the DSH main process only (agent children don't inherit) |

## What's inside (smanx devtools-latest set)

`git` `curl` `wget` `nano` `jq` `less` `ripgrep` `rsync` `procps` `ca-certificates` `unzip` `vim` `zip` `htop` `tmux` `tree` `openssl` `python3` `bash-completion` `build-essential` (via base image) · npm globals: **pnpm** (pinned) · **uv** (`uvx` for MCP servers) · **docker CLI + compose plugin** · `tini` · `bubblewrap` (DSH Linux sandbox backend)

No browser: no Chromium, no Xvfb, no noVNC, no `dsh-browser-desktop` plugin. DSH is launched with `--no-open` so it never tries to open a host browser.

## Auto-update workflow

`.github/workflows/docker-build.yml` keeps `:latest` in sync with the official project:

- **every 6h** (cron) it resolves the newest release on the selected **channel** and compares it against what's already on GHCR
- build key = `dsh <version>` + this repo's commit SHA → rebuilds only when **either** upstream releases a new version **or** this repo's Dockerfile changes
- pushes `linux/amd64` (default; arm64 opt-in via workflow input or `vars.DSH_PLATFORMS`) to `ghcr.io/<owner>/<repo>` with tags `latest`, `dsh-<version>`, `build-<version>-<sha8>`
- manual **Run workflow** button always available (`force_build` to bypass the skip check)
- uses only the built-in `GITHUB_TOKEN` — no secrets needed

Point your docker manager (watchtower/Portainer/etc.) at `ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest` and it will pick up every upstream update.

### Release channels

| Channel | Resolves | Build | Use when |
|---|---|---|---|
| `npm` (default) | `@deepseek-ai/dsh` `dist-tags.latest` on the npm registry | installs the official npm package (fast, slim, what runzhliu & smanx do) | normal operation. Caveat: GitHub-only pre-releases that were never published to npm can't be installed this way |
| `github-tag` | newest `dsh-v*` tag on the official GitHub repo — **includes pre-releases/alphas** | clones + builds the upstream monorepo from source (slow, much larger image) | you want bleeding-edge tags like `dsh-v0.1.2-alpha.1` that npm doesn't have |

Channel selection precedence: workflow input (manual run) > repository **variable** `DSH_CHANNEL` (Settings → Secrets and variables → Actions → Variables; also applies to the cron) > default `npm`.

Example reality check (Aug 2026): npm `latest` = `0.1.1-rc.2`; GitHub has `dsh-v0.1.2-alpha.1` as a source-only pre-release (no npm package, no release assets). With the default channel a push builds `0.1.1-rc.2`; run the workflow once with `channel=github-tag` to build the alpha from source. The moment `0.1.2` (rc or final) is published to npm `latest`, the default channel picks it up automatically.

## Security model

- **Non-root** (uid/gid 1000), rootfs read-only, `cap_drop: ALL`, `no-new-privileges`, `/tmp` tmpfs — in the provided `compose.yaml`
- DSH state (profiles/credentials/sessions/plugins) persists in the `dsh-home` volume at `/home/node/.dsh`; only `/workspace` (the agent's world) is a bind mount
- The Web UI runs `dsh web`, which has **its own per-boot token auth** (printed to the container log as `dsh web: http://…/?token=…`); the proxy auto-mints sessions for browsers (zero-auth LAN). **Consequence: any device on the LAN can open the UI** — it executes code, so add Basic Auth (`PROXY_USERNAME` + `PROXY_PASSWORD`) if that is not acceptable, and never expose to the public internet
- Docker socket access is opt-in and widens the trust boundary — prefer the filtered TCP proxy

## Debugging with the read-only rootfs

`read_only: true` locks the image layers (`/usr`, `/etc`, `/opt`, ...). The harness itself stays fully functional — all of its state is on mounts: the `dsh-home` volume (`/home/node/.dsh` — settings, sessions, credentials, plugins), the `/workspace` bind, and the `/tmp` tmpfs. If you need to poke at system paths (e.g. test an apt install or edit image files), create a local `compose.override.yaml` (compose merges it automatically; it is git-ignored):

```yaml
# compose.override.yaml — local debugging only, do not commit
services:
  seek-harness:
    read_only: false
```

`docker compose up -d` then recreates the container with a writable rootfs; delete the file to return to the hardened posture. Need another persistent path (logs, exports)? Add a volume/bind for it in the same way rather than disabling `read_only` globally.

## Smoke test

```bash
docker run --rm --entrypoint dsh ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest --version   # prints pinned DSH version
docker run --rm --entrypoint bash ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest -c \
  'docker --version && docker compose version && pnpm --version && uv --version && bwrap --version'
docker compose up -d && curl -fsS http://127.0.0.1:3080/ && docker compose ps   # healthy
```

## Image coordinates

- Git: `git@github.com:yakuza8702/docker-deepseek-harness.git`
- Image: `ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest` — the workflow derives the image name from `github.repository`, so no per-run edits are needed. After the first push, trigger it once from **Actions → docker-build → Run workflow** (or wait for the 6h cron), then point your docker manager at `:latest`.

## Credits

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — the official project (MIT)
- [runzhliu/deepseek-harness-docker](https://github.com/runzhliu/deepseek-harness-docker) — hardening patterns
- [smanx/deepseek-harness](https://hub.docker.com/r/smanx/deepseek-harness) — devtools package set + reverse-proxy "0.0.0.0 fix"

## Overrides directory (`overrides/`)

The `overrides/` folder holds bind-mounted patches that fix or extend the
upstream image without rebuilding it. These survive image updates.

| File | Mount target | Fix |
|---|---|---|
| `overrides/proxy.mjs` | `/opt/seek-harness/proxy.mjs:ro` | Full-chain regex for the "unlock remote settings" JS rewrite (narrow regex left dangling `ctx.remote.` prefix → SyntaxError) |
| `overrides/settings-index.js` | `/opt/dsh-src/packages/settings/settings/lib/index.js:ro` | Re-exports `settingsNamespace` (made internal in 0.1.2-alpha.3) so third-party plugins that still import it keep loading |

To remove: delete the file, remove the `- ./overrides/...` line from compose.yaml,
and (for settings-index.js) re-enable the `disabled: true` rows in
`dsh-home/profiles/web/cordis.patch.yml` if the upstream plugins have been
updated.
