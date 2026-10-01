# `dsh-browser-desktop` (vendored)

A visible browser desktop and human-takeover layer for DeepSeek Harness Browser Use. It embeds a real, persistent browser in a movable and resizable noVNC panel and registers the small `browser_open` bridge so an Agent can reveal the same browser to the user.

## Vendored from runzhliu, with one patch (`seek-harness`)

This directory is copied verbatim from
[`runzhliu/deepseek-harness-docker`](https://github.com/runzhliu/deepseek-harness-docker)
(`plugins/dsh-browser-desktop`, version 0.1.4, MIT) — the package is **not published to
npm**, so vendoring is the only way to use it — with exactly one behavioural change
plus one rename:

| Change | Why |
|---|---|
| Renamed `@runzhliu/dsh-browser-desktop` → **`dsh-browser-desktop`** (package name, `__ModuleLoader__.load` id and the bundle patch all match) | Same convention as `dsh-profile-switcher`, so the loaded bundle is unambiguous in boot logs and can never be confused with a future upstream release |
| **`desktopPort: 0` now means "same origin as the Harness page"** | Upstream's `desktopUrl()` forced an explicit port on the panel iframe, so a single-port deployment behind a reverse proxy had no correct value: `6080` breaks `https://host/` (nothing is listening there) and `443` breaks `http://lan-ip:3080`. With `0`, the port override is skipped entirely and the browser keeps whatever authority it reached the UI through — LAN `http://h:3080` and public `https://host` both work from one config |

Everything else — the `browser_open` tool, the state endpoint, the panel, the persistent
profile, the takeover behaviour — is upstream's and unmodified.

This plugin complements the official browser features instead of replacing them:

| Layer | Responsibility |
| --- | --- |
| DSH Sidebar Browser | Lightweight iframe tabs for embeddable HTTP(S) pages; it does not expose model tools. |
| DSH Browser Use | Model-facing inspection and interaction through Playwright MCP, Chrome DevTools MCP, or Stagehand. |
| Browser Desktop | Browser lifecycle, persistent profile, visible desktop, and human takeover for pages that need a real browser. |

Use official Browser Use tools for navigation, inspection, clicking, and extraction. Use `browser_open` when a user explicitly asks to open, see, or take over a URL. This division avoids maintaining a second browser-automation API.

The plugin is only the Harness integration layer. It expects two companion services:

- a browser DevTools endpoint, defaulting to `http://127.0.0.1:9222` from the Harness host process;
- a browser-accessible noVNC page, by default path-routed at `/desktop/vnc.html` through the Harness proxy (same origin, single port).

The parent image provides the browser, Xvfb, Openbox, x11vnc, websockify and the required lifecycle supervision. Installing this package alone does not install or start that desktop stack or an official Browser Use provider.

## Official Browser Use attachment

The reference image mounts the official Playwright MCP provider in attachment mode:

```yaml
- id: browser-use
  name: '@deepseek-ai/dsh-browser-use'
- id: browser-use-playwright-mcp
  name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
  config:
    mode: attach
    endpoint: 'http://127.0.0.1:9222'
```

The model and the noVNC panel therefore operate the same Chromium tabs, cookies, and persisted login state. DSH currently gives one live Session exclusive ownership of an attached browser within one provider instance. Other Sessions continue without Browser Use until the owner releases it; `browser_open` and manual desktop access remain available. If Chromium restarts, create or resume a Session after the CDP endpoint is healthy because the experimental provider does not reconnect a disconnected Session automatically.

## Install

There is nothing to install: the image copies this package into the DSH
installation's `node_modules`, declares it in the installation manifest, and mounts
it for every profile through `/opt/seek-harness/browser-use.overlay.yml` (applied by
the entrypoint as a `--patch` overlay, exactly like `dsh-profile-switcher`). Setting
`DSH_BROWSER_USE_ENABLED=0` — or `DSH_DESKTOP_ENABLED=0` for the desktop alone —
removes the rows at boot without rebuilding.

Upstream's own install instructions (`dsh plugin --profile web add …`) do not apply
here, because the package is not published to npm. Version `0.1.4` is compatible with
both the DSH `0.2.0` and the older `0.1.2` client-module runtimes.

## Configuration

The bundle's defaults are tuned for this image; the overlay sets the same values:

```yaml
- id: browser-desktop
  name: 'dsh-browser-desktop'
  config:
    cdpBaseUrl: 'http://127.0.0.1:9222'
    desktopPort: 0
    desktopPath: '/desktop/vnc.html?autoconnect=1&resize=scale&view_only=0&reconnect=1'
    pollIntervalMs: 750
```

`desktopPort: 0` means **same origin as the Harness page** — the panel is loaded from
whatever authority the UI itself was opened on. Use a positive number only when
noVNC really listens on its own port (upstream's shape, which requires publishing that
port and reaching it directly). `desktopPath` must be a same-origin absolute path; it
is where the Harness reverse proxy routes the desktop.

## Security

This plugin controls a real browser, and the noVNC desktop is only as protected as the
Harness URL it is reached through. In this image the desktop is served on the **same
port as the Harness UI** (path-routed by `docker/proxy.mjs`), so it inherits exactly
the same protections: the proxy's Basic Auth when `PROXY_USERNAME`/`PROXY_PASSWORD`
are set, and whatever auth sits in front of the container (Pangolin/Badger, a
reverse-proxy login). Never publish a plain `:6080` instead — a second port would
bypass that layer and, on an https page, could not be embedded at all as mixed content.

## Discovery and publishing

Official DeepSeek Harness discovers community plugins through npm/GitHub and the `dsh-plugin` topic. The parent container repository also documents an explicitly optional third-party `dshmarket` image variant, but that market is neither an official DeepSeek service nor a substitute for publishing a normal DSH bundle. Before publishing, follow the official [bundle publishing guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md), run `npm pack --dry-run`, publish the scoped package with public access, and add the GitHub topic `dsh-plugin` to the repository.

## License

MIT
