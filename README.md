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
[Browser tools as a switchable plugin row](#browser-tools-as-a-switchable-plugin-row)
and [Browser troubleshooting](#browser-troubleshooting-as-a-switchable-plugin).

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
| `DSH_BROWSER_USE_EXCLUSIVE` | `0` | provider only: `0` = **every** Session drives the same visible browser (this image's default, see below); `1` = upstream's single-owner attachment |
| `DSH_BROWSER_MCP_TIMEOUT` | `60000` | per-tool-call timeout for the browser MCP row, in ms |
| `DSH_BRAVE_MCP_TIMEOUT` | `120000` | per-tool-call timeout for the DevTools row, in ms — longer on purpose, Lighthouse and performance traces legitimately run long |
| `DSH_DESKTOP_PREFIX` | `desktop` | path the proxy serves the desktop on (`/desktop/…`) |
| `DSH_NOVNC_PORT` | `6080` | internal noVNC/websockify port (loopback only) |
| `DSH_CDP_PORT` | `9222` | internal DevTools port the browser tool server attaches to |
| `DSH_DESKTOP_WIDTH` / `DSH_DESKTOP_HEIGHT` | `1440` / `900` | virtual display size |
| `DSH_DESKTOP_START_URL` | `about:blank` | first page the browser opens |

## The top of the Plugins page — the integrated features + the market selector

Two groups render **above the "Official" group**, arranged the way DSH Desktop
arranges its own features there (`dsh-plugins-page-extras`):

```
Plugin market         Only one can be enabled at a time            (on)
  ┌ dsh-community-market  Beta ┐   ┌ dsh-market ┐
  └───────────────────────────┘   └────────────┘
  Browser tools                                                      (on)
  Browser tools brave                                                (on)
  Browser Use                                  [Open panel]          (on)
Official 8
```

* **Plugin market** — a master switch plus one card per market, only one of which
  can be on at a time; mirrors Desktop's `MARKET_OPTIONS` and links the same
  repositories. `dsh-market` (npm `dshmarket`) is fully wired — the card installs
  it into the profile (pnpm) and enables it. `dsh-community-market` is listed with
  its Desktop provenance, but its card explains rather than pretends: npm carries
  only a 719-byte reserved-name stub, the real package being a Desktop-only
  TypeScript workspace that is not published.
* **Browser tools / Browser tools brave / Browser Use** — one row per feature, no
  group heading (Desktop has none above its own rows), each with the 48px icon
  tile, title, description and switch of the page's own official cards. They are
  three rows and not one because they cost three different things: the Playwright
  tools (24 definitions), the Brave DevTools tools (30) and the `browser_open`
  hand-off (one tool + a prompt section). The **Open panel** button belongs to the
  desktop row. Every switch writes the same state the page's own cards would,
  because both go through the plugin manager.

The upstream page offers **no extension point above its groups** (you can only
contribute a card INTO "Official"), so `tools/patch-plugin-manager-page.mjs` adds
the `plugins.page.top` slot to `@deepseek-ai/dsh-client-ui-plugin-manager` at image
build time — content-anchored, idempotent, and it **fails the build** if upstream
moves either anchor. Desktop patches the same package for the same reason.

## Browser tools as a switchable plugin

The model-facing browser tools are **one plugin you switch on and off** — on the
**Plugins page**, next to the shipped plugins:

```
Plugins page → Browser tools → off      # server gone, tools gone, tokens gone
Plugins page → Browser tools → on       # 24 browser_* tools, attached to the visible Brave
```

| | |
|---|---|
| Bundle / package | `dsh-browser-mcp` (title "Browser tools") |
| Plugin row it mounts | `browser-mcp` → `@deepseek-ai/dsh-mcp-client` |
| Server name | `playwright-mcp` → tools `mcp__playwright-mcp__browser_*` |
| Attaches to | the visible Brave desktop, over CDP (`127.0.0.1:$DSH_CDP_PORT`) |
| Applies | at the next boot (bundle selection is read when the tree is composed) |

**Why this matters:** the tool definitions cost roughly 10k tokens of static
context in every Session, and they used to be unavoidable — a row mounted by a
launcher **overlay** is applied *after* the profile layer, so it re-declares itself
enabled and no switch can turn it off (measured: a profile-level `disabled: false`
override on an overlay row is ignored, `--dump-config` shows why). The row now
ships **inside a bundle**, which is the unit the Plugins page lists and toggles
(`listBundles()` builds that list from `dsh.profile.bundles` ∪ the profile's
dependencies ∪ the **installation's** dependencies, and gives every entry with a
`dsh.bundle.patch` a switch). Two further wins: **one** MCP process for the whole
harness instead of one per activated Session (~110-130 MB each), and no need for
the exclusivity patch below — a plain MCP client has no single-owner attach mode.

The bundle is selected for the active profile **once per home** by the entrypoint
(marker `.browser-mcp-bundle-seeded`), so switching it off is a decision the image
never overrides. `DSH_BROWSER_MCP=0` skips the selection entirely — the plugin
then shows up as *available* (off) rather than selected. A profile patch that
still carries the row an earlier image spliced in is migrated away automatically
(exact text match, validated with the launcher's own YAML parser before writing).

The official provider is still in the image and still one flag away
(`DSH_BROWSER_USE_PROVIDER=1`), for anyone who wants per-Session tools.

## Browser troubleshooting as a switchable plugin

Driving a page and **diagnosing** one are different jobs, so they are different
rows with different switches. The second one is `dsh-brave-devtools-mcp`, titled
**Browser tools brave** on the Plugins page, sitting between the other two:

```
Plugins page → Browser tools brave → off   # 30 DevTools tools gone, server gone
Plugins page → Browser tools brave → on    # console, network, CSS, perf, Lighthouse, heap
```

| | |
|---|---|
| Bundle / package | `dsh-brave-devtools-mcp` (title "Browser tools brave") |
| Plugin row it mounts | `brave-devtools-mcp` → `@deepseek-ai/dsh-mcp-client` |
| Server name | `brave-devtools` → tools `mcp__brave-devtools__*` |
| Server behind them | [`brave-mcp`](https://github.com/triuzzi/brave-devtools-mcp) — Brave-native, full Chrome DevTools MCP parity, pinned in the image |
| Attaches to | the same visible Brave desktop, over **loopback** CDP (`127.0.0.1:$DSH_CDP_PORT`) |
| Switch | **Plugins page → Browser tools brave → off/on** (live, no restart) |

**Why it is worth 30 more tool definitions.** The Playwright row can navigate and
click; it cannot tell you *why* the result was wrong. This one reads the console
(with source-mapped stacks), lists every request with its status and body, matches
CSS rules and reports which one won the cascade, records a performance trace with
insight sets, runs Lighthouse, and snapshots the heap. On a self-hosted stack
behind a reverse proxy that is the difference between "the page looks broken" and
"`/dsh-market/api/v1/updates` returned 502 because the upstream socket was reset".

**Why "attach", and why loopback.** The row starts the server with
`--browserUrl=http://127.0.0.1:$DSH_CDP_PORT`, i.e. against the browser this
container already runs. `start_desktop` launches Brave with
`--remote-debugging-address=127.0.0.1 --remote-debugging-port=$DSH_CDP_PORT`, so
**CDP is on by default and bound to loopback**: the MCP can only reach a browser
inside this container, nothing on the LAN can attach to it, no second browser is
launched or downloaded, and the model shares your tabs, cookies and logins — you
will see what it is doing in the noVNC panel. Both MCP rows attach to that same
browser; Chrome accepts several CDP clients, and the two switches stay
independent. If two sessions ever visibly fight over the active tab, turn one of
the two rows off.

**It is a pinned copy, not `npx`.** `/usr/local/bin/dsh-brave-devtools-mcp` execs
the `brave-mcp` installed at build time (`BRAVE_MCP_VERSION`), so a boot cannot
depend on the npm registry and `@latest` cannot move the tool surface under you.
The privacy defaults are explicit: no usage statistics, no npm update check, and
`--no-performance-crux` keeps a trace URL from being offered to Google's CrUX API
(the lab trace, which is the part that finds your bug, is unaffected).

**Selection, again, is once per home** (marker `.brave-devtools-bundle-seeded`),
so switching it off is a decision the image never overrides;
`DSH_BRAVE_DEVTOOLS_MCP=0` skips the selection entirely.

### One browser, every Session (provider path — this fork patches upstream)

*Applies to the official provider, which is opt-in (`DSH_BROWSER_USE_PROVIDER=1`).
The default MCP row has no exclusive attach mode at all, so this limitation simply
does not exist on that path.*

Upstream's attach mode reserves the attached browser for **one** live Session:
`exclusive: config.mode === "attach"`. Its own runtime README calls this out under
*Known Limitations* — *“a busy attachment skips startup permanently for that live
activation”* and *“releasing the attachment does not retry skipped activations”*.
In a container that boots with sessions already open, the winner of that race is
whichever activation happens first, which is frequently **not** the session you are
looking at; every other session then shows no browser tools at all, silently and
permanently, and closing the “owner” does not bring them back.

This image patches that expression off (see `tools/patch-browser-use-exclusivity.mjs`
and the Dockerfile step that applies it), so **every** Session gets its own MCP client
attached to the same browser. The patch is content-anchored and idempotent, and it
**fails the build** if upstream changes that line — an upstream refactor must never
silently restore the behaviour this fork removed.

The trade-off is explicit: there is one browser, so **cookies, logins, tabs and
installed extensions are shared between Sessions**, and two Sessions driving it at the
same time compete for the active tab. That is inherent to “one visible browser with
your logins” — it was already true before the patch, when it simply travelled with
ownership. Set `DSH_BROWSER_USE_EXCLUSIVE=1` to get upstream's single-owner semantics
back (useful if you want a strict one-session-at-a-time browser).

Compose already sets `shm_size: "1g"` for renderer shared memory. If you run the image
with plain `docker run`, add `--shm-size=1g` — the entrypoint detects a small `/dev/shm`
and falls back to `--disable-dev-shm-usage` automatically, but the properly sized path
is faster.

## Office documents — Word, PowerPoint, Excel and PDF, as one switchable card

DeepSeek Harness **already ships** the Office feature; a plain container mounts none of
it. This image mounts it, supplies the interpreter it expects, and puts a switch on it:

```
Plugins page → Office documents → on    # office-docx / office-pptx / office-xlsx / pdf-documents
Plugins page → Office documents → off   # the four skills released from every request
```

| | |
|---|---|
| Bundle / package | `dsh-office` (`plugins/dsh-office`) |
| Rows it mounts | `skill-office` → `@deepseek-ai/dsh-skill-office` · `workspace-dependencies` → `@deepseek-ai/dsh-tool-workspace-dependencies` |
| Skills | `office-docx`, `office-pptx`, `office-xlsx` (bundled upstream) + `pdf-documents` (this image) |
| Interpreter | `/opt/dsh-office/primary-runtime` — Python 3.12.14, 15 distributions, ~282 MiB |
| Engine | `@deepseek-ai/libreoffice-kit` — LibreOffice, prebuilt, WebAssembly backend on Linux |
| Switches | `DSH_OFFICE=0` · `DSH_OFFICE_RUNTIME=<dir>` |
| Selection | once per home (marker `.office-bundle-seeded`) |

**Nothing here is a third-party plugin and nothing installs at runtime.** The skills and
the engine are ordinary dependencies of the DSH release already in the image; what the
image adds is the payload those skills are instructed to use — `python-docx`,
`python-pptx`, `openpyxl`, `XlsxWriter`, `Pillow`, `lxml`, `numpy`, `pandas`, and two
wheels this repo adds on purpose: `pypdf` and `PyMuPDF`.

`docker/office-runtime.lock.json` is the upstream
`scripts/primary-runtime/lock.json` for the shipped release, pinned by SHA-256
everywhere. `tools/build-office-payload.mjs` downloads, verifies and unpacks it at build
time (no repository checkout needed, no compiler on the build host); `tools/check-office.mjs`
then **executes** the result — imports all ten libraries, writes a `.docx` with the
payload's own interpreter, runs the real `check_office.py` over it, converts it to a real
PDF and renders a page to a real PNG with the real engine, and reads the four declarations
that put the card on the Plugins page.

What the model can do, and what proves it works:

| Capability | How |
|---|---|
| Create, read and edit `.docx` / `.pptx` / `.xlsx` | the three bundled skills on the payload's libraries |
| Look at a page, slide or worksheet range | the engine renders it to PNG; the core `read_image` tool hands it to the model |
| Extract embedded pictures | `word/media/`, `ppt/media/`, `xl/media/` from the package, or PyMuPDF inside a PDF |
| Convert to PDF | `convert` — real PDF 1.7 (measured: a one-page document in ~3.2 s) |
| Recalculate a workbook | `recalculate`, formulas preserved |
| Read a PDF's text, images and pages | `pypdf` + `PyMuPDF` + the engine's PDFium render path |
| Check before delivering | `check_office.py` — OOXML packages, relationships, structure |

**What it is not:** the engine is LibreOffice, so pagination can differ from Word —
previews are layout QA, not proof of print. A render is bounded to 100 pages and 16.7M
pixels, and the engine is not resident (each operation starts it for ~2-3 s). PDF has no
reflow: read, split, merge, rotate, stamp, render, or regenerate from the Office source.
Missing fonts are reported (`missingFonts`), never silently substituted. Full detail and
provenance: `plugins/dsh-office/README.md`.

## Workspace file manager — the "Files" entry in the sidebar footer

The image also carries **`dsh-workspace-browser`**, a file manager for `/workspace`
that the Harness Web UI does not otherwise have. DSH's built-in file sidebar is
read-oriented (tree, previews, open-in-local-app, diff review of Agent changes); this
adds the write half:

| In the panel | Detail |
|---|---|
| Navigate | Directory listing with breadcrumbs, size and modification time |
| Preview | Bounded text preview, 512 KiB by default |
| Edit | In-UI text editing with `Ctrl`/`Cmd`+`S`, and an mtime precondition so a save refuses to silently overwrite an outside change |
| Create / rename / delete | Files and directories; deleting a non-empty directory asks first and is explicit about being recursive |

**It writes, so read this before enabling it.** Every path is resolved under the
configured root with `realpath` checks; `..` traversal and symlinks escaping the root
are rejected, symlinks cannot be mutated, mutations must be same-origin JSON, and
single writes are capped. But above that, the only boundary is who can reach the UI:
anyone who can open the Harness can create, edit, rename and recursively delete inside
`/workspace`. Keep it behind Pangolin/Badger, Basic Auth, or a trusted network, and
mount only the directory you are willing to expose. `DSH_WORKSPACE_BROWSER_ENABLED=0`
removes it entirely.

| Variable | Default | Meaning |
|---|---|---|
| `DSH_WORKSPACE_BROWSER_ENABLED` | `1` | `0` = no file manager row at boot |
| `DSH_WORKSPACE_ROOT` | `/workspace` | The only directory it can touch |
| `DSH_WORKSPACE_MAX_ENTRIES` | `2000` | Directory listing cap |
| `DSH_WORKSPACE_MAX_PREVIEW_BYTES` | `524288` | Text preview cap |
| `DSH_WORKSPACE_MAX_WRITE_BYTES` | `1048576` | Single write cap |

Vendored from runzhliu's **unmerged** `feat/workspace-browser-crud` branch (the package
is not on npm) and ported from the 0.1.0-rc.6 client runtime to `dsh-client-modules` for
DSH 0.2.0 — see [`plugins/dsh-workspace-browser/README.md`](plugins/dsh-workspace-browser/README.md).
Its own suite covers the host logic and runs in the image:
`docker exec <container> node --test /opt/dsh/node_modules/dsh-workspace-browser/workspace.test.js`.

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
| `DSH_PERMISSION_MODE` | unset | `read-only` / `workspace-write` / `danger-full-access` — confined modes use the Landlock launcher that ships **inside the image** (kernel ≥ 5.13) and is probe-verified at build time; nothing to mount. `bwrap` is installed too but cannot create user namespaces under this hardening, so Landlock is the backend that runs |
| `DSH_TOOLS_MODE` | unset | `native` / `ptc` / `both` |
| `DSH_NODE_FLAGS` | `--expose-internals` | Node flags for the DSH main process only (agent children don't inherit) |

## What's inside (smanx devtools-latest set)

`git` `curl` `wget` `nano` `jq` `less` `ripgrep` `rsync` `procps` `ca-certificates` `unzip` `vim` `zip` `htop` `tmux` `tree` `openssl` `python3` `bash-completion` `build-essential` (via base image) · npm globals: **pnpm** (pinned) · **uv** (`uvx` for MCP servers) · **docker CLI + compose plugin** · `tini` · `bubblewrap` (DSH Linux sandbox backend) · **APK/Android reverse-engineering toolchain** (JDK, jadx, apktool, Hermes, frida, androguard, Android SDK — see the section below)

No browser is *forced* on you: the desktop is started only for a `web` boot
(`DSH_DESKTOP_ENABLED=0` turns it off entirely) and DSH still runs with `--no-open`
so it never tries to open a host browser. The image does ship the browser stack now —
**Brave**, Xvfb, openbox, x11vnc, websockify and noVNC — because that is what Browser
Use and human takeover run on.

## APK / Android reverse-engineering toolchain

The image answers "what does this .apk actually do?" offline — no toolchain to
download at runtime, no phone, no account. This is what the agent reaches for when
it is handed an APK (or an `.apks`/`.xapk` split bundle), and it is the difference
between reading a DEX string table and reading the app's actual logic.

```bash
docker run --rm --entrypoint apk-tools ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest   # inventory + versions
docker exec seek-harness apk-tools --check        # re-run the build-time probe of every tool
docker exec seek-harness apk-unpack /workspace/app.apk          # -> /workspace/app-unpacked/
docker exec seek-harness apk-unpack /workspace/app.apks ./out   # split bundle: analyses base.apk
```

| Tool | Version | What it answers |
|---|---|---|
| JDK | 21 (Debian) | jadx, apktool, apksigner, sdkmanager and apkanalyzer are all JVM programs |
| `jadx` | 1.5.6 | DEX → Java source (`jadx/sources/`) — the readable half of an APK |
| `apktool` | 3.0.3 | binary `AndroidManifest.xml` + `resources.arsc` → real XML, smali decode, **and rebuild** (a decompiler cannot produce an APK) |
| `hbctool`, `hermes-dec` | 0.1.5 / 0.1.7 | React-Native `assets/index.android.bundle` is Hermes **bytecode**, invisible to jadx and to `strings` |
| `androguard`, `apkid` | 4.1.4 / 3.1.0 | scriptable APK/DEX/AXML analysis without a JVM, and packer/obfuscator detection |
| `frida`, `frida-dexdump`, `objection` | 17.20.0 / 2.0.1 / 1.12.5 | dynamic instrumentation (needs a device — the container has no USB) |
| Android SDK | cmdline-tools `16111833`, build-tools `36.1.0`, `android-36` | `apksigner`, `zipalign`, `aapt2`, `apkanalyzer`, `sdkmanager` — sign and inspect a rebuilt APK |
| `adb` | Debian package | talks to a device/emulator over TCP. Debian's on purpose: Google's platform-tools zip has no aarch64 build |

`apk-unpack` produces a layout meant to be read, not re-derived:
`raw/` (the archive as-is), `base/` (the inner `base.apk` of a split bundle, unpacked),
`apktool/` (decoded resources + smali), `jadx/` (Java sources), `AndroidManifest.xml`
(apkanalyzer's print), `apk-summary.txt`, `SUMMARY.txt` (dex count, native libs,
Hermes/Flutter/Unity hints) and `logs/` — every step's failure is kept in a log instead
of being thrown away, because `jadx` reports errors on almost every obfuscated app and
that must not stop you from reading the manifest.

Three things worth knowing before trusting a result:

- **Hermes revisions differ.** `hbctool` refuses bytecode revisions it does not know
  (v98, which current React Native/Expo apps ship, is one of them); `hermes-dec`
  (`hbc-disassembler`, `hbc-decompiler`) handles those with a warning. Try both, and
  report which one worked instead of guessing at the bytecode.
- **The rootfs is read-only** (`read_only: true` in the compose file), so
  `sdkmanager --install "platforms;android-35"` cannot write into `$ANDROID_HOME`.
  Android *projects* usually only need their own `./gradlew` (it downloads its Gradle
  into `$HOME`); for extra SDK packages, use a `compose.override.yaml` with
  `read_only: false` or point `ANDROID_HOME` at a writable path.
- **Static by default.** Nothing here calls out, and no device is touched unless you
  connect one (`adb connect host:port` + `frida-server` on the target).

Cost, stated plainly: this section adds roughly **0.7 GB** to the image (mostly the JDK
and the Android SDK). Versions are pinned in [`docker/apk-toolchain.sh`](docker/apk-toolchain.sh)
and every download is checksum-verified against the vendor's own digest, so an analysis
can be reproduced later; [`tools/check-apk-toolchain.mjs`](tools/check-apk-toolchain.mjs)
**executes** all 27 checks at build time and fails the build if any tool cannot run —
a container that boots is a container whose toolchain works. The in-image guide
(`/opt/apk-tools/README.md`, also in the repo as [`docker/apk-tools.md`](docker/apk-tools.md))
carries the full workflow: Hermes bundles, repack/sign, native libs, and the limits.

## Auto-update workflow

`.github/workflows/docker-build.yml` keeps `:latest` in sync with the official project:

- **every 6h** (cron) it resolves the newest release on the selected **channel** and compares it against what's already on GHCR
- **the version pin is empty by default**: push and cron runs follow npm's `latest`
  dist-tag, so an upstream release lands in `:latest` with no commit here. Set the
  `DSH_VERSION_PIN` workflow env to a version string to freeze the image instead
  (that is how this repo ran while it was deliberately held on `0.1.7-rc.2`).
  The browser-use packages follow whatever version is resolved — if upstream ever
  publishes a core release before the matching browser-use release, the build
  falls back to that package's `next` tag and says so in the log
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
- **The browser desktop is the same trust boundary as the UI.** It is served on the UI's port, behind the same auth, and it drives a real browser holding your logins — whoever reaches the URL reaches the browser. Keep it behind Pangolin/Badger or Basic Auth, and treat the `dsh-home` volume as credential material (the browser profile lives in it)
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
docker run --rm --entrypoint bash ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest -c \
  'apk-tools --check'                       # APK toolchain: 27/27 checks passed
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
| `overrides/settings-index.js` | `/opt/dsh-src/packages/settings/settings/lib/index.js:ro` | Re-exports `settingsNamespace` (made internal in 0.1.2-alpha.3) so third-party plugins that still import it keep loading |

> **Removed 2026-10-01:** `overrides/proxy.mjs` (and its compose bind-mount). It
> carried the 2026-09-01 dotted-chain regex fix as a runtime patch over the image
> copy — but `docker/proxy.mjs` in the image has owned that fix since, plus the
> recovery surface, the client-boot watchdog and the `/desktop` route, so the stale
> 415-line copy was silently shadowing every later proxy change. The image copy is
> authoritative again; drop any `./overrides/proxy.mjs` line from an existing
> deployment or the browser desktop path will 404.

> **Removed 2026-10-02:** `overrides/landlock-run/` (the hand-built static
> `landlock-run` binary) and its compose bind-mount. The launcher now comes from
> the published platform package
> `@deepseek-ai/node-addon-system-<platform>-<arch>` — the exact package and path
> the runtime resolves through `launcherPath()` — and
> `tools/ensure-landlock-launcher.mjs` guarantees it during the build and **fails
> the build** unless `landlock-run --probe` reports `full`/`partial`. The old
> mount pointed at a source-channel path (`/opt/dsh-src/native/landlock-run/…`)
> that does not exist in an npm-channel image, so it shadowed nothing while
> making a fresh start look like it needed a manual download. Delete the
> `./overrides/landlock-run/…` line from an existing compose file: confined
> permission modes (`read-only`, `workspace-write`) work with no mount at all.

To remove: delete the file, remove the `- ./overrides/...` line from compose.yaml,
and (for settings-index.js) re-enable the `disabled: true` rows in
`dsh-home/profiles/web/cordis.patch.yml` if the upstream plugins have been
updated.

## Factory reset — what it actually does

The recovery page (`/__recovery/page`, reachable whenever the harness is down or
its browser half fails to load) has a **Reset data and restart** action. Because
the data directory is a **mount**, it cannot be moved aside — `rename()` of a
mount point fails with `EBUSY`, and `/tmp` is a different filesystem (`EXDEV`).
The reset therefore clears the data directory **in place**, one top-level entry
at a time, and then restarts the stack (a wiped home is only adopted by a new
process):

| Removed | Kept |
|---|---|
| conversations (`sessions/`), other profiles, `settings.yaml`, plugin installs (`node_modules`, `dependencies`), the browser profile, logs, caches, plugin stores | `.credentials.yaml` (so the harness still reaches a model — Safe Mode carries the same file over), `.recovery-checkpoints/` including a checkpoint taken just before the reset, and the shipped `web` profile |

Inside the shipped profile, the **authored** files survive
(`cordis.patch.yml`, `cordis.yml`, `pnpm-workspace.yaml` — your patch layer and
pnpm settings) while `package.json` is rebuilt to the shipped default and
generated artefacts (`pnpm-lock.yaml`) are dropped: plugin installs live in
`dependencies` + `dsh.profile.bundles`, and their `node_modules` is gone, so a
manifest kept as-is would advertise bundles that no longer exist. Everything is
recoverable *as configuration* through the Rollback tab; the data itself is not
recoverable, which is what the confirmation dialog says. Project files outside
the data directory (the workspace mount) are never touched.

## Troubleshooting

### A host-side edit "does not reflect" in the container, or a plugin installs but never appears

Both symptoms are usually the **same** mistake: editing (or installing into) the
wrong home. `~/.dsh` and `$DSH_HOME` are one directory in this image (see
[Where your data lives](#where-your-data-lives--dsh-dsh_home-and-workspace)), so
check *which* path you touched:

```bash
# what the launcher actually boots, and where its data lives
docker exec <container> sh -c 'echo DSH_HOME=$DSH_HOME; readlink -f ~/.dsh; ls -la ~/.dsh/profiles/*/'
# the same directory, seen from the host (the mounted data dir)
cat <data-dir>/dsh-home/active-profile.json
```

* A file is only real if it exists under **`$DSH_HOME`** (`/home/node/.dsh`,
  i.e. `<data-dir>/dsh-home/` on the host). A `pnpm-workspace.yaml` under
  `/workspace/.dsh/...` is a phantom home from an image built before the alias —
  it is parked as `/workspace/.dsh.orphan-<UTC>` on the first boot with the
  alias, and the fix is to re-run the install so it lands in the real home.
* Profile/plugin state changes only take effect on the **next boot** (`dsh
  --profile` is a launcher input): `docker restart <container>`, then read the
  boot log.

### `dsh plugin --profile web add dshmarket` warns about a missing peer

```
WARN  Issues with peer dependencies found
└─┬ dshmarket 1.66.8
  └── ✕ missing peer @deepseek-ai/cordis@^4.0.1
```

That warning is **cosmetic** in this image and does not stop the plugin from
loading: pnpm resolves the profile's own workspace (`nodeLinker: hoisted`,
`autoInstallPeers: false` — DSH's shipped template) and therefore cannot see
`@deepseek-ai/cordis`, `@deepseek-ai/dsh-settings` and `@deepseek-ai/schemastery`,
which the *core installation* provides at runtime. To silence the warning without
installing a second copy of the core:

```yaml
# $DSH_HOME/profiles/web/pnpm-workspace.yaml  (host: <data-dir>/dsh-home/profiles/web/)
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

peerDependencyRules:
  ignoreMissing:
    - "@deepseek-ai/*"
```

The install is not what makes the market appear — the **restart** is: `dsh
plugin add` writes the dependency *and* appends the package to
`dsh.profile.bundles`, and the loader composes that list at boot. So: install →
`docker restart` → the Market section shows up. `autoInstallPeers: false` stays:
it is upstream's own setting and prevents a duplicate copy of the core's
framework packages from being installed into the profile (which is what makes
`dshmarket`, or any other bundle, fail to load with two competing runtimes).

### The Plugin Market's Install button fails for every plugin (pnpm refuses the lockfile)

```
Install  <any plugin>
…node_modules/pnpm/dist/pnpm.cjs:168629:34)
 at Array.map (<anonymous>)
 at resolveDependenciesOfImporters (…/pnpm/dist/pnpm.cjs:168195:58)
 at async _installInContext (…/pnpm/dist/pnpm.cjs:175355:232)
```

The stack names no package, and the plugin you were installing is usually not the
problem. pnpm verifies a profile's **whole** lockfile before any `add`/`remove`,
and refuses a tarball resolution that carries no `integrity` unless it can
recognise the URL as git-hosted itself (`codeload.github.com/…tar.gz`,
`bitbucket.org`, `gitlab.com`):

```
ERR_PNPM_MISSING_TARBALL_INTEGRITY: Cannot install package
"<name>@https://github.com/<owner>/<repo>/releases/…/<file>.tgz":
its lockfile entry has no "integrity" field
```

A GitHub **release asset** is not one of those shapes — and pnpm *writes* that
shape when such a URL is added, then refuses it on the next operation that has to
materialise the package. The Market installs curated catalog entries that ship a
prebuilt release archive from exactly that URL (about 70 of them), so one such
install is enough to stop every later install and uninstall in that profile —
including perfectly compatible plugins. The market's own log names the culprit:

```bash
docker exec <container> tail -5 /home/node/.dsh/profiles/web/.dsh-market/log.ndjson
# {"event":"install","detail":"<plugin> exit=1 err=ERR_PNPM_MISSING_TARBALL_INTEGRITY: … <culprit> …"}
```

This image repairs it at boot (`docker/lockfile-integrity.mjs`, called by the
entrypoint before `dsh` starts): it finds tarball resolutions pnpm would reject,
downloads each tarball once, and pins `integrity: sha512-…` on that line — the
hash pnpm itself computes for the URL, which is already in the profile's own
manifest. The lockfile is backed up to `$DSH_HOME/.lockfile-repair-<UTC>/` first,
the repair is idempotent, and a failed download changes nothing.

```bash
# what the guard did on this boot
docker logs <container> 2>&1 | grep lockfile-integrity
# run it by hand (dry-run = report only, no download, no write)
docker exec <container> node /opt/seek-harness/lockfile-integrity.mjs --home "$DSH_HOME" --dry-run
```

* `DSH_LOCKFILE_REPAIR=0` switches the guard off; `=dry` reports without writing.
* pnpm may re-resolve once and drop the pinned integrity on the **first** install
  after a failed run — the next boot re-applies it. Two `pnpm install` passes are
  enough by hand; `--lockfile-only` must **not** be used to check a repair, it
  rewrites the entry without an integrity.
* The guard only pins; it never deletes a dependency or installs anything.

### Installing a GitHub plugin — use a git spec, not a release asset

```bash
# safe: pnpm resolves it through codeload with `gitHosted: true` + an integrity
docker exec <container> dsh plugin --profile web add github:owner/repo
docker exec <container> dsh plugin --profile web add github:owner/repo#v1.2.3
```

A **release asset** URL (`https://github.com/<owner>/<repo>/releases/download/<tag>/<file>.tgz`,
`.tar.gz` is the same) is the shape pnpm refuses when it carries no integrity —
and pnpm writes it that way itself. Measured on pnpm 10.34.6 against a fresh
profile with this image's workspace file: the add fails with
`ERR_PNPM_MISSING_TARBALL_INTEGRITY`, the manifest change is rolled back (nothing
is half-installed), and an orphan entry is left in the lockfile — which the next
pnpm command prunes, so an install that follows it still succeeds. The boot guard
is what covers the other order, where such a plugin *does* land and every later
install would otherwise be blocked.

