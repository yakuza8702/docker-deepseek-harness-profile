# seek-harness

A self-built, hardened **DeepSeek Harness (DSH)** container image.

It packages the **official npm release** of [`@deepseek-ai/dsh`](https://github.com/deepseek-ai/deepseek-harness) and combines the best of the two unofficial reference builds — **without** runzhliu's browser stack:

| Input | What is taken |
|---|---|
| **official** [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | `@deepseek-ai/dsh` npm package, pinned + verified at build time |
| **smanx** [`devtools-latest`](https://hub.docker.com/r/smanx/deepseek-harness) | complete devtools package set **+ the "0.0.0.0 fix"**: built-in Node reverse proxy (`0.0.0.0:3080 → 127.0.0.1:DSH_PORT`) with HTTP+WS forwarding, optional Basic Auth, `crypto.randomUUID` polyfill for non-secure LAN pages |
| **runzhliu** [deepseek-harness-docker](https://github.com/runzhliu/deepseek-harness-docker) | security hardening: non-root UID 1000, `tini` init, fixed pnpm, build-time version verification, `HOME=/workspace` dir-selector fix, `--expose-internals` only on the DSH main process, cap_drop ALL / no-new-privileges / read-only rootfs in compose. **Also taken:** its visible-desktop stack (Xvfb → openbox → x11vnc → websockify/noVNC) and its `dsh-browser-desktop` plugin — vendored, since it is not on npm — but running **Brave** instead of Chromium, with the panel on the **same port** as the UI |
| **this repo** | Docker engine access: mounted `docker.sock` **or** Docker proxy over TCP via `DOCKER_HOST`; docker CLI + compose plugin inside the image; GitHub workflow that auto-follows the official repo and keeps `:latest` current |

## Browser tools + a visible browser desktop — on ONE port

The image carries a real browser: **the browser tools** for the model and a
**noVNC desktop** you can take over by hand. Both are the same browser instance —
same tabs, same cookies, same logins — because both tool servers run in
**attach mode** against it over CDP.

There are **two** model-facing tool surfaces, each with its own switch:
`browser-mcp` (**Browser tools**) *drives* the page, and `brave-devtools-mcp`
(**Browser tools brave**) *diagnoses* it — console, network, CSS, performance,
Lighthouse, heap. Turn either off when you do not want to pay for its tools — see
[Browser tools as a switchable plugin row](docs/integrated-plugins.md#browser-tools-as-a-switchable-plugin)
and [Browser troubleshooting](docs/integrated-plugins.md#browser-troubleshooting-as-a-switchable-plugin).

```
        your browser
             │  https://seek-harness.dfm.homes   ← one host, one port, one login
             ▼
   Pangolin / nginx / bare LAN :3080
             │
   ┌─────────┴──────────────────────────────────────────────┐
   │ container: proxy.mjs on 0.0.0.0:3080                   │
   │   /                 → 127.0.0.1:3079  dsh web          │
   │   /desktop/...      → 127.0.0.1:6080  noVNC  ─────┐    │
   │   /websockify       → 127.0.0.1:6080  (its WS)     │   │
   └────────────────────────────────────────────────────┼───┘
                                                        ▼
   Xvfb :99 → openbox → x11vnc :5900 → websockify :6080
                    ▲
                    └── Brave ── CDP 127.0.0.1:9222 ◄──┬─ `browser-mcp`         (drives)
                                                     └─ `brave-devtools-mcp`  (diagnoses)
```

**No second port is published.** That is not just tidiness: a plain `http://host:6080`
panel would be blocked as mixed content inside an https UI, and it would sit outside
your reverse proxy's auth. Path-routing it through the same port means the panel is
same-origin, shares the cert and the login, and needs nothing new forwarded in
Pangolin/nginx/Cloudflare.

What you get:

* `browser_open` — the model can reveal a page in the visible desktop for you to take over;
* the **DevTools troubleshooting tools** on that same browser — console, network,
  CSS cascade, performance traces, Lighthouse, heap — from the `brave-devtools-mcp`
  row, so "why is this page broken" is answered from evidence, not a screenshot;
* the desktop button in the sidebar footer, and the noVNC panel at `/desktop/vnc.html`;
* a **persistent browser profile** at `$DSH_HOME/brave-profile`, inside the `dsh-home`
  volume: cookies, logins, saved sessions and Chrome-Web-Store extensions
  (Bitwarden-style password managers, uBlock-style blockers) survive
  `restart` / `up` / `recreate`. Only `docker compose down -v` wipes them. Brave's
  Shields block ads natively, so no ad-block extension is required at all;
* Brave is launched with `--no-sandbox` through the `brave-desktop` wrapper — the
  container itself is the sandbox boundary (`cap_drop: ALL` + `no-new-privileges`), so
  the in-process setuid sandbox cannot be used. Never call `brave-browser` directly.

Switches:

| Variable | Default | Meaning |
|---|---|---|
| `DSH_DESKTOP_ENABLED` | `1` | `0` = no desktop stack, no browser rows at boot (packages stay in the image) |
| `DSH_BROWSER_MCP` | `1` | `0` = do not offer the browser tools at all (the switchable row is never seeded) |
| `DSH_BRAVE_DEVTOOLS_MCP` | `1` | `0` = a deployment-level opt-out: the bundle is never selected and the row is disabled by its own patch (the Plugins page still *shows* it, off) |
| `DSH_BROWSER_USE_PROVIDER` | `0` | `1` = use the official Browser Use **provider** rows instead of the MCP row (do not enable both — same tool names twice) |
| `DSH_BROWSER_USE_ENABLED` | `1` | `0` = no model-facing browser tools, panel still available |
| `DSH_BROWSER_USE_EXCLUSIVE` | `0` | provider only: `0` = **every** Session drives the same visible browser (this image's default, see [One browser, every Session](docs/integrated-plugins.md#one-browser-every-session-provider-path--this-fork-patches-upstream)); `1` = upstream's single-owner attachment |
| `DSH_BROWSER_MCP_TIMEOUT` | `60000` | per-tool-call timeout for the browser MCP row, in ms |
| `DSH_BRAVE_MCP_TIMEOUT` | `120000` | per-tool-call timeout for the DevTools row, in ms — longer on purpose, Lighthouse and performance traces legitimately run long |
| `DSH_DESKTOP_PREFIX` | `desktop` | path the proxy serves the desktop on (`/desktop/…`) |
| `DSH_NOVNC_PORT` | `6080` | internal noVNC/websockify port (loopback only) |
| `DSH_CDP_PORT` | `9222` | internal DevTools port the browser tool server attaches to |
| `DSH_DESKTOP_WIDTH` / `DSH_DESKTOP_HEIGHT` | `1440` / `900` | virtual display size |
| `DSH_DESKTOP_START_URL` | `about:blank` | first page the browser opens |

## Contents

This file is the overview and the quick start. The long operational chapters are one
document per theme, so a change lands in one place:

| Document | What is in it |
|---|---|
| **[README.md](README.md)** (this file) | overview, quick start (compose and `docker run`), environment variables, image coordinates, credits |
| [docs/integrated-plugins.md](docs/integrated-plugins.md) | the Plugins page rows: Browser tools, Browser troubleshooting, Office, OpenCode, OCR, the Files entry |
| [docs/profiles-and-data.md](docs/profiles-and-data.md) | profile switching, `~/.dsh` / `$DSH_HOME` / `/workspace`, the in-app profile pill |
| [docs/docker-engine.md](docs/docker-engine.md) | Docker engine access: mounted socket, socket proxy over TCP, dind and sysbox |
| [docs/personal-vm.md](docs/personal-vm.md) | the Personal VM (`cua`): one computer two kinds, the Windows install and its tools, the loopback MCP relay, the clipboard, `/dev/kvm`, GPU, coordinates, the store, provenance |
| [docs/troubleshooting.md](docs/troubleshooting.md) | host-side edits that "do not reflect", the Plugin Market lockfile refusal, GitHub plugin installs |
| [docs/operations.md](docs/operations.md) | auto-update workflow and release channels, security model, read-only-rootfs debugging, smoke test, factory reset |
| [docs/overrides.md](docs/overrides.md) | the `overrides/` directory and its build-time rule |
| [docs/windows-iso-sources.md](docs/windows-iso-sources.md) | ISO provenance and the source chain per Windows code |
| [docs/cua-capability-roadmap.md](docs/cua-capability-roadmap.md) | what the Personal VM can and cannot do yet |
| [docs/compose-hardening.md](docs/compose-hardening.md) | the compose hardening notes |
| [plugins/dsh-cua-vm/README.md](plugins/dsh-cua-vm/README.md) | the Personal VM plugin's own architecture, tools and limits |
| [patches/README.md](patches/README.md) | the source patches applied to the upstream monorepo — the auth fix: what it fixes, its base commit `4b399c39`, how the build applies and verifies it |

Sections that stayed in this file:

- [Browser tools + a visible browser desktop — on ONE port](#browser-tools--a-visible-browser-desktop--on-one-port)
- [Why a reverse proxy? (the 0.0.0.0 fix)](#why-a-reverse-proxy-the-0000-fix)
- [Quick start (compose)](#quick-start-compose)
- [Quick start (plain docker run)](#quick-start-plain-docker-run)
- [Environment variables](#environment-variables)
- [What's inside (smanx devtools-latest set)](#whats-inside-smanx-devtools-latest-set)
- [Image coordinates](#image-coordinates)
- [Credits](#credits)

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

## Quick start (plain docker run)

```bash
docker pull ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest

docker run -d --name seek-harness \
  -p 3080:3080 \
  -v seek-harness-home:/home/node/.dsh \
  -v "$PWD":/workspace \
  --shm-size=1g \
  --restart unless-stopped \
  ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest
```

`--shm-size=1g` is for the browser (renderer shared memory); the entrypoint copes
without it by falling back to `--disable-dev-shm-usage`, just more slowly.

Other entrypoint forms:

```bash
# flags go straight to dsh (headless one-shot)
docker run --rm -v "$PWD":/workspace ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest \
  --profile headless "summarize this repository"

# arbitrary command (shell into the devtools image)
docker run --rm -it --entrypoint bash ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest
```

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
| `DIND_DATA` | `./dind-data` | `compose.dind.yaml`: the isolated engine's whole state. **Real filesystem only** (ext4/xfs/btrfs — overlay2 refuses FUSE/mergerfs). Deleted = the engine is purged |
| `DIND_EXPORT` | `./image-export` | `compose.dind.yaml`: host-visible dir mounted at `/export`; finished images leave the isolated engine here (`docker save … > /export/x.tgz`) and **survive a purge** |
| `DIND_REGISTRY_DATA` | `./dind-registry` | `compose.dind.yaml`: storage of the bundled `registry:2` durable image store; **survives a purge** |
| `DIND_IMAGE_TAG` | `29-dind` | `compose.dind.yaml`: engine image tag for the sidecar (match the host engine's major) |
| `DIND_NETWORK` | `harness-docker` | `compose.dind.yaml`: private network shared by the harness and its engine; the engine API is never published |
| `DSH_WORKSPACE` | `./workspace` | Compose-only: workspace bind source |
| `DSH_BIND` | `127.0.0.1` | Compose-only: host publish address (`0.0.0.0` = LAN) |
| `DEEPSEEK_API_KEY` | unset | Runtime credential (or configure in the Web UI settings) |
| `DSH_TELEMETRY_DISABLED` | `1` | Hard-disabled locally by default (empty = upstream default) |
| `DSH_PERMISSION_MODE` | unset | `read-only` / `workspace-write` / `danger-full-access` — confined modes use the Landlock launcher that ships **inside the image** (kernel ≥ 5.13) and is probe-verified at build time; nothing to mount. `bwrap` is installed too but cannot create user namespaces under this hardening, so Landlock is the backend that runs |
| `DSH_TOOLS_MODE` | unset | `native` / `ptc` / `both` |
| `DSH_NODE_FLAGS` | `--expose-internals` | Node flags for the DSH main process only (agent children don't inherit) |

## Sign-in durability fix (source channel)

`patches/auth-fix.patch` fixes three defects in the DeepSeek account path that
upstream `0.2.3-alpha.2` (commit `4b399c39`) still has:

* an account that reads as **signed out after a restart** while the Platform is
  unreachable — the identity is now persisted beside the grant and seeded back at
  boot, and only a *ready* Platform read replaces it;
* **one HTTP 401 deleting the stored grant** (a proxy, a clock skew, a platform
  edge is enough — the "logged out again" / 403 storms): a rejection now only
  records a strike, and the grant is removed when a **second** rejection of the
  same token arrives at least one `requestTimeoutMs` later and outside the boot
  grace;
* a settings card that stays **blank while the account cannot be reached**: the
  account section now mounts in the unknown state with "Can't reach DeepSeek right
  now / Try again", and the retry shares the grant handle so a revoked grant
  starts no read.

It also **bounds the account read rate** against a destination that rejects every
request: the field failure a WAF/edge challenge produced (HTTP 202 with an empty
body, `stage=parse-json`) used to be re-read on every client refresh, at ~1
request/second. One unreachable answer is still retried at once; a *run* of them
opens a doubling window (5 s → 60 s) in which profile and wallet reads replay
their last outcome without another round trip, so a broken destination is probed
rather than hammered.

It is a patch against the upstream **TypeScript sources**, so it can only reach a
**source build**: the image applies it between the clone and `pnpm run build`
(`DSH_SIGNIN_FIX=1`, the default), then proves the compiled Host lib carries it and
fails the build if the patch stops applying.

```bash
docker build --build-arg DSH_SOURCE_REF=dsh-v0.2.3-alpha.2 -t seek-harness:auth-fix .
# or: Actions → docker-build → Run workflow → channel = github-tag
```

The **npm channel** installs compiled JavaScript and cannot carry a source patch,
so an image built that way keeps upstream's behaviour — the build log says so.
`docker logs` states which one you are running (`auth fix: active — two-strike 401
expiry …` on a patched source build). Base commit, scope and the update recipe:
[patches/README.md](patches/README.md).

## What's inside (smanx devtools-latest set)

`git` `curl` `wget` `nano` `jq` `less` `ripgrep` `rsync` `procps` `ca-certificates` `unzip` `vim` `zip` `htop` `tmux` `tree` `openssl` `python3` `bash-completion` `build-essential` (via base image) · npm globals: **pnpm** (pinned) · **uv** (`uvx` for MCP servers) · **docker CLI + compose plugin** · `tini` · `bubblewrap` (DSH Linux sandbox backend)

No browser is *forced* on you: the desktop is started only for a `web` boot
(`DSH_DESKTOP_ENABLED=0` turns it off entirely) and DSH still runs with `--no-open`
so it never tries to open a host browser. The image does ship the browser stack now —
**Brave**, Xvfb, openbox, x11vnc, websockify and noVNC — because that is what Browser
Use and human takeover run on.

## Image coordinates

- Git: `git@github.com:yakuza8702/docker-deepseek-harness.git`
- Image: `ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest` — the workflow derives the image name from `github.repository`, so no per-run edits are needed. After the first push, trigger it once from **Actions → docker-build → Run workflow** (or wait for the 6h cron), then point your docker manager at `:latest`.

## Credits

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — the official project (MIT)
- [runzhliu/deepseek-harness-docker](https://github.com/runzhliu/deepseek-harness-docker) — hardening patterns
- [smanx/deepseek-harness](https://hub.docker.com/r/smanx/deepseek-harness) — devtools package set + reverse-proxy "0.0.0.0 fix"
