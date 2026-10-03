# dsh-plugins-page-extras — the top of the Plugins page

Two groups at the **top of the Plugins page, above the "Official" group**,
arranged the way DSH Desktop arranges its own features there:

```
Plugin market         Only one can be enabled at a time            (on)
  ┌ dsh-community-market  Beta ┐   ┌ dsh-market ┐
  └───────────────────────────┘   └────────────┘
  Browser tools                                                      (on)
  Browser tools brave                                                (on)
  Browser Use                                  [Open panel]          (on)
Official 8
  …
```

| | |
|---|---|
| **Browser tools** | the `dsh-browser-mcp` bundle: the Playwright MCP row (24 tools) with its switch. The same shape as Desktop's "Remote Control" row |
| **Browser tools brave** | the `dsh-brave-devtools-mcp` bundle: the Brave DevTools MCP row (30 tools — console, network, CSS, performance, Lighthouse, heap) with its *own* switch, so releasing one tool surface never releases the other |
| **Browser Use** | the `dsh-browser-desktop` bundle: the visible desktop itself plus `browser_open` and its prompt section, with **Open panel** and its own switch |
| **Plugin market** | a master switch + one card per market; only one market can be on at a time. Mirrors Desktop's `MARKET_OPTIONS` (`community-market` / `dsh-market`) and links the same repositories |
| Server side | `index.js` — four routes under `/dsh-plugins-page-extras/`, driving `ctx.pluginManager` (`listBundles`, `selectBundle`, `installBundle`), i.e. the same calls the page's own switches make |
| Client side | `client.js` — registers into the `plugins.page.top` slot; the rows come from its `FEATURES` table, in page order |

## The `plugins.page.top` slot does not exist upstream

The stock Plugins page can be contributed INTO (`plugins.item` puts a card inside
"Official"), but it offers **no extension point above its groups**. DSH Desktop
solves this by patching the same package; this image does the same, at build time:

`tools/patch-plugin-manager-page.mjs` — content-anchored, idempotent, and it
**fails the build** if upstream moves either anchor:

1. the page **declares** the child slot `plugins.page.top` in its slot contract
   (declaring is what authorises rendering the key), and
2. the page **renders** it immediately before the `renderGroup("official", …)` call.

## What is actually installable

| Market | State in this image |
|---|---|
| `dsh-market` (npm `dshmarket`, 1.66.8) | **fully wired**: the card installs it into the profile (pnpm) and enables it |
| `dsh-community-market` | npm carries only a **719-byte reserved-name stub**; the real package is a DSH-Desktop TypeScript workspace that is not published. The card therefore explains that instead of failing at the pnpm step |

The switch writes are the same ones the page makes for its own bundles
(`selectBundle` → `dsh.profile.bundles`), so the two UIs never disagree: turning
the browser tools off here is the same state the "Installed" card shows.

The bundles behind these rows are also added to the page's own
`BUILTIN_PROFILE_BUNDLES` set by `tools/patch-plugin-manager-page.mjs` — upstream's
mechanism for keeping a profile-declared bundle out of the ordinary list. Without
it an integrated feature appears twice: once as this row and again as a card under
"Installed". In DSH Desktop the native add-ons never appear there either.
