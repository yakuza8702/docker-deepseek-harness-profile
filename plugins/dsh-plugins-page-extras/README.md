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
  Personal VM (CUA)                                                  (on)
  Connector                                                          (on)
  Office documents                                                   (on)
Official 8
  …
```

| | |
|---|---|
| **Browser tools** | the `dsh-browser-mcp` bundle: the Playwright MCP row (24 tools) with its switch. The same shape as Desktop's "Remote Control" row |
| **Browser tools brave** | the `dsh-brave-devtools-mcp` bundle: the Brave DevTools MCP row (30 tools — console, network, CSS, performance, Lighthouse, heap) with its *own* switch, so releasing one tool surface never releases the other |
| **Browser Use** | the `dsh-browser-desktop` bundle: the visible desktop itself plus `browser_open` and its prompt section, with **Open panel** and its own switch |
| **Personal VM (CUA)** | the `dsh-cua-vm` bundle: the `cua_vm_*` tools and their prompt section, with its own switch |
| **Office documents** | the `dsh-office` bundle: the three Office skills on the pinned Python payload, with its own switch |
| **Connector** | the `dsh-connector` bundle: the six `connector_*` tools (`status`, `repos_list`, `repo_actions`, `file`, `cloudflare`, `push`), the `/api/connector` routes, the `tool:connector` prompt section and the **Connector** sidebar page (GitHub / Cloudflare / Gitea). Sits directly under **Personal VM (CUA)** — the same order as the sidebar, where the Connector entry is order 21 and the VM is 20 — and has its own switch |
| **Plugin market** | a master switch + one card per market; only one market can be on at a time. Mirrors Desktop's `MARKET_OPTIONS` (`community-market` / `dsh-market`) and links the same repositories |
| Server side | `index.js` — four routes under `/dsh-plugins-page-extras/`, driving `ctx.pluginManager` (`listBundles`, `selectBundle`, `installBundle`), i.e. the same calls the page's own switches make |
| Client side | `client.js` — registers into the `plugins.page.top` slot; the rows come from its `FEATURES` table, in page order |

## The `plugins.page.top` slot does not exist upstream

The stock Plugins page can be contributed INTO (`plugins.item` puts a card inside
a group), but it offers **no extension point above its groups**. DSH Desktop
solves this by patching the same package; this image does the same, at build time:

`tools/patch-plugin-manager-page.mjs` — content-anchored, idempotent, and it
**fails the build** if upstream moves either anchor:

1. the page **declares** the child slot `plugins.page.top` in its slot contract
   (declaring is what authorises rendering the key), and
2. the page **renders** it immediately before the first group of its main list —
   `renderGroup("basic", …)` since 0.2.1-alpha.2, `renderGroup("official", …)`
   before that. Both shapes are anchored (newest first, the one that appears
   exactly once wins); a third shape fails the build with every variant's count
   printed, so re-anchoring is a one-line change instead of a bisect.

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

## The Connector row

`{ id: 'connector', bundle: 'dsh-connector' }` — the sixth row, added when the
connector moved from a profile-pinned plugin (`@local/connector`) to a built-in
bundle (`plugins/dsh-connector`, see its README). It sits **between
`{ id: 'cua-vm', bundle: 'dsh-cua-vm' }` and `{ id: 'skill-office', bundle:
'dsh-office' }`**, which is also where it renders: under **Personal VM (CUA)** and
above **Office documents**, matching the sidebar, where the Connector page is
order 21 and the VM panel is 20.

The row switches the whole bundle, not one tool: off means the six
`connector_*` tools, the `/api/connector` routes and the `tool:connector` prompt
section are all released from the next request, and no stored credential is read,
moved or deleted. `dsh-connector` is listed in `INTEGRATED_BUNDLES`
(`tools/patch-plugin-manager-page.mjs`), so it never reappears as a second card
under "Installed", and in the Market's "Installed" tab it never appears at all —
selection lives in `dsh.profile.bundles`, never as a profile dependency.

The wiring is asserted by `tools/check-connector.mjs`, which the image runs after
the Office gate: the installed package in BOTH node_modules roots, the bundle
patch's `id: connector` + `name: dsh-connector` row, this host/client pair and its
order, the suppression list entry, the entrypoint's `seed_connector_bundle` +
`@local/connector` link migration, and the Dockerfile's COPY/staging lines.
