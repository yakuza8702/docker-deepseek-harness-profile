# dsh-brave-devtools-mcp — the troubleshooting tools as a switchable plugin

The container's **diagnostic** browser surface, packaged the way DSH expects a
plugin to be: a **bundle** with a `dsh.bundle.patch`, so it appears on the
**Plugins page** between "Browser tools" and "Browser Use" and can be switched on
and off there.

| | |
|---|---|
| Bundle / package | `dsh-brave-devtools-mcp` (title "Browser tools brave") |
| Plugin row it mounts | `brave-devtools-mcp` → `@deepseek-ai/dsh-mcp-client` |
| Server name | `brave-devtools` (this is the tool namespace) |
| Tools | `mcp__brave-devtools__*` — **30** DevTools tools |
| Server behind them | [`brave-mcp`](https://github.com/triuzzi/brave-devtools-mcp) (npm `brave-mcp`), pinned in the image |
| Attaches to | the visible Brave desktop, over loopback CDP (`127.0.0.1:$DSH_CDP_PORT`) |
| Switch | **Plugins page → Browser tools brave → off/on** |

## What it adds over the Playwright row

`browser-mcp` **drives** a page; this one **diagnoses** it. The two are
complementary, and each is its own switch:

| | `mcp__playwright-mcp__*` (Browser tools) | `mcp__brave-devtools__*` (this plugin) |
|---|---|---|
| Driver | Playwright | Puppeteer (upstream DevTools MCP) |
| Tools | 24 — navigate, read, click, type, screenshot | 30 — the same actions **plus** console, network, CSS, performance, Lighthouse, heap, emulation |
| Console | ✗ | `list_console_messages`, `get_console_message` (source-mapped stacks) |
| Network | ✗ | `list_network_requests`, `get_network_request` (status, headers, bodies) |
| Performance | ✗ | `performance_start_trace` / `_stop_trace` / `_analyze_insight`, `lighthouse_audit` |
| Memory | ✗ | `take_heapsnapshot` |
| Styles | ✗ | `get_css_styles` (matched rules, cascade, inheritance) |

"What is wrong with this site" stops being a question answered from a screenshot
and a page dump: the model can read the console, see which request 404'd, and
record a trace — on the **same browser** you are looking at in the panel.

## How it reaches the browser (and why that is safe)

The row starts the server with `--browserUrl=http://127.0.0.1:$DSH_CDP_PORT`,
i.e. **attach mode against the browser this container already runs**:

* the desktop stack launches Brave with
  `--remote-debugging-address=127.0.0.1 --remote-debugging-port=$DSH_CDP_PORT`
  (see `start_desktop` in `docker/entrypoint.sh`), so **CDP is on by default and
  bound to loopback** — nothing on the LAN can reach it, and the MCP can only
  attach to a browser inside this container;
* no second browser is launched, no Playwright/Puppeteer browser download is
  needed, and the human panel and the model see the same tabs, cookies, logins
  and console;
* the server is a **pinned copy inside the image** behind the stable wrapper
  `/usr/local/bin/dsh-brave-devtools-mcp` — no `npx --yes …@latest` at boot, so a
  restart cannot silently change the tool surface or fail without the registry.

Sharing one browser with the Playwright row is fine (Chrome accepts several CDP
clients), and the rows stay independent. If two sessions visibly fight over the
active tab, turn one of the two rows off — that is what the separate switches are
for.

## Why it is a bundle

The Plugins page does not list loader rows — it lists **bundles**, and gives a
switch to every entry with a `dsh.bundle.patch`
(`listBundles()` / `setBundleEnabled()` over
`dsh.profile.bundles` ∪ the profile's dependencies ∪ the installation's
dependencies). Anything mounted some other way is invisible there or, worse,
unswitchable: a row mounted by a launcher **overlay** is applied *after* the
profile layer, so it re-declares itself enabled every boot and no `disabled:`
override can win — measured, and the reason the first two rows moved into
bundles.

The row then costs nothing when it is off: the MCP server is not spawned, its 30
tool definitions are not in any Session's context, and the profile patch carries
the `disabled:` override that documents the choice.

## How it is selected

`docker/entrypoint.sh` (`seed_brave_devtools_bundle`) selects the bundle for the
active profile **once per home**, marker-guarded
(`.brave-devtools-mcp-bundle-seeded`), so switching it off is a decision the image
never overrides. A fresh home gets it on the first boot.

It **selects, never depends**: a profile `dependencies` entry would put an
image-shipped native feature into the community Market's *Installed* tab (which
lists the profile manifest's `dependencies`) and into the Plugins page's own list,
which is exactly what an integrated feature must not do — in DSH Desktop the
native add-ons never appear there. The Plugins page's duplicate card is prevented
separately, by name, in `tools/patch-plugin-manager-page.mjs`
(`INTEGRATED_BUNDLES`).

## Switches

| Variable | Default | Meaning |
|---|---|---|
| `DSH_BRAVE_DEVTOOLS_MCP` | `1` | `0` = do not select the bundle at boot. The row stays VISIBLE on the Plugins page (off) rather than vanishing, but the bundle patch also carries this variable in its own `disabled:` expression, so the switch cannot turn it on either — this is a deployment-level opt-out, not a per-user one |
| `DSH_DESKTOP_ENABLED` | `1` | `0` = no desktop stack, so the row is disabled with it (there would be no browser to attach to) |
| `DSH_CDP_PORT` | `9222` | the browser's DevTools port inside the container |
| `DSH_BRAVE_MCP_TIMEOUT` | `120000` | per-tool-call timeout in ms — longer than the Playwright row's, because Lighthouse and performance traces legitimately run long |

## Privacy defaults

* `--no-performance-crux` — a performance trace is **not** offered to Google's
  CrUX API for real-user field data. The lab trace, which is the part that finds
  your bug, is unaffected. Remove the flag from
  `plugins/dsh-brave-devtools-mcp/cordis.patch.yml` to opt back in.
* `BRAVE_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1` — no usage statistics (upstream
  already defaults to off in this fork; this makes it explicit).
* `BRAVE_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1` — no npm update check from inside the
  container; the version is pinned by the image.

## Provenance

Upstream: <https://github.com/triuzzi/brave-devtools-mcp> (Apache-2.0), npm
package `brave-mcp`. The image installs it into `/opt/brave-mcp` and never
patches it — the owner is upstream (DSH plugin rule 3). The pinned version lives
in the `BRAVE_MCP_VERSION` build arg, and the build **fails** if the wrapper, the
package, or a real MCP handshake does not answer (see
`tools/check-brave-mcp.mjs`).
