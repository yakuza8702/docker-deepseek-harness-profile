# dsh-browser-mcp — the browser tools as a switchable plugin

The container's browser automation, packaged the way DSH expects a plugin to be:
a **bundle** with a `dsh.bundle.patch`, so it appears on the **Plugins page** next
to the shipped plugins and can be switched on and off there.

| | |
|---|---|
| Bundle / package | `dsh-browser-mcp` |
| Plugin row it mounts | `browser-mcp` → `@deepseek-ai/dsh-mcp-client` |
| Server name | `playwright-mcp` (this is the tool namespace) |
| Tools | `mcp__playwright-mcp__browser_*` — 24 tools, identical names to the old provider |
| Attaches to | the visible Brave desktop this image runs, over CDP (`127.0.0.1:$DSH_CDP_PORT`) |
| Switch | **Plugins page → Browser tools → off/on** (writes `dsh.profile.bundles`) |

## Why it is a bundle

The Plugins page does not list loader rows — it lists **bundles**. The plugin
manager builds that list from

```
dsh.profile.bundles  ∪  the profile's dependencies  ∪  the DSH installation's dependencies
```

and every entry with a `dsh.bundle.patch` gets a switch
(`listBundles()` / `selectBundle()`: selecting writes the name into
`dsh.profile.bundles`, deselecting removes it). Anything that is *not* a bundle is
invisible there, however it was mounted:

* a **launcher overlay** row can never be switched off at all — the overlay is
  applied after the profile layer, so it re-declares itself enabled (measured with
  `dsh --profile web --patch … --dump-config`);
* a row **spliced into the profile patch** works as a switch target but does not
  appear on the Plugins page — that was this feature's first attempt, and the
  reason it "did not show up in the sidebar".

Shipping the row *inside a bundle* fixes both: the row exists exactly while the
bundle is selected, and the bundle is what the page lists and toggles.

## Why it exists at all

The tool definitions cost roughly 10k tokens of static context in **every**
Session, and the provider path they came from ran one MCP process per activated
Session (~110–130 MB each) and needed an upstream patch for its single-owner
attach mode. Going through `dsh-mcp-client` instead gives:

* one switchable plugin entry, off when you do not want it — server, tools and
  their context all gone;
* **one** MCP process for the whole harness instead of one per Session;
* no exclusive attach mode, so the upstream exclusivity patch is not needed on
  this path (the provider stays available, see below).

## How it is selected

`docker/entrypoint.sh` (`seed_browser_mcp_bundle`) selects the bundle for the
active profile **once per home**, marker-guarded (`.browser-mcp-bundle-seeded`),
so switching it off is a decision the image never overrides. A fresh home gets it
on the first boot — the entrypoint initialises the shipped `web` profile with
DSH's own `initProfile()` before the harness starts.

It also **migrates** the previous attempt away: a profile patch that still carries
the row spliced in by an earlier image has that block removed (exact text match,
idempotent), because the bundle now provides the same row id.

## Switches

| Variable | Default | Meaning |
|---|---|---|
| `DSH_BROWSER_MCP` | `1` | `0` = do not select the bundle (it stays visible in the Plugins page as available) |
| `DSH_DESKTOP_ENABLED` | `1` | `0` = no desktop stack, and the row is disabled with it |
| `DSH_CDP_PORT` | `9222` | the browser's DevTools port inside the container |
| `DSH_BROWSER_MCP_TIMEOUT` | `60000` | per-tool-call timeout in ms |

## Alternative: the official provider

The overlay still carries the provider rows, switched **off** by default. Set
`DSH_BROWSER_USE_PROVIDER=1` to use them instead (per-Session tools, one process
per Session, single-owner attach unless `DSH_BROWSER_USE_EXCLUSIVE=0`). Do not
enable both: they would offer the same tool names from two servers.
