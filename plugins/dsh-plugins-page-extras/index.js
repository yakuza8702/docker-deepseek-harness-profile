/**
 * dsh-plugins-page-extras — host half.
 *
 * Owns the operations the Plugins-page sections need, behind a few small routes so
 * the client half never has to guess at the client-side service graph:
 *
 *   GET  /dsh-plugins-page-extras/state          -> which of OUR rows/bundles are on
 *   POST /dsh-plugins-page-extras/row            { id, enabled }   (a loader row)
 *   POST /dsh-plugins-page-extras/bundle         { name, enabled } (a bundle layer)
 *   POST /dsh-plugins-page-extras/market         { id }        (install if needed)
 *   POST /dsh-plugins-page-extras/market-off     {}
 *
 * It drives the plugin manager's own public host service (`ctx.pluginManager`) —
 * `listPlugins()`, `setPluginEnabled(id, enabled)`, `listBundles()`,
 * `setBundleEnabled(name, enabled)` and `installBundle(spec, options)`. Nothing
 * here invents a private API, and nothing here needs the browser to be logged in.
 *
 * ROWS vs BUNDLES. The two browser features are switched as ROWS, not as bundles:
 * `setPluginEnabled` writes an id-targeted `disabled:` override into the profile
 * patch and reloads, which is the live, reversible half — and it leaves the bundle
 * selected, so "installed" and "running" stay separate ideas. The bundle itself is
 * what carries the row (plugins/dsh-browser-mcp, plugins/dsh-browser-desktop); that
 * is why one switch can release the MCP tool definitions and the other the
 * `browser_open` tool and its prompt section, independently.
 */

export const name = 'plugins-page-extras'
export const inject = ['pluginManager', 'webServer']

const ROUTE = '/dsh-plugins-page-extras'

/**
 * The integrated features that get a row of their own in the page's top section.
 *
 * `id` is the ROW id the profile patch's override targets; `bundle` is the package
 * that declares that row. Both are needed: the row is what costs context, and the
 * bundle is what carries it — a bundle that is not selected contributes no row at
 * all, so switching a feature on has to make sure of both.
 *
 * Each stays out of the page's own list by name — see
 * tools/patch-plugin-manager-page.mjs — so it appears ONCE, as this row.
 */
const ROWS = [
  /**
   * The Playwright MCP server: the 24 `mcp__playwright-mcp__*` browser tools, from
   * plugins/dsh-browser-mcp.
   */
  { id: 'browser-mcp', bundle: 'dsh-browser-mcp' },
  /**
   * The Brave DevTools MCP server: the 30 `mcp__brave-devtools__*` tools that
   * DIAGNOSE a page (console, network, CSS cascade, performance, Lighthouse, heap),
   * from plugins/dsh-brave-devtools-mcp. A row of its own because it is a separate
   * tool surface: releasing the driving tools must not have to release these, and
   * the other way round.
   */
  { id: 'brave-devtools-mcp', bundle: 'dsh-brave-devtools-mcp' },
  /**
   * The visible Chromium desktop and the `browser_open` hand-off bridge, from
   * plugins/dsh-browser-desktop.
   */
  { id: 'browser-desktop', bundle: 'dsh-browser-desktop' },
  /**
   * The harness's own Office skills and the pinned Python payload they run on,
   * from plugins/dsh-office. `skill-office` is the row that costs context (three
   * skill descriptions in every catalog); the bundle's second row, the
   * `load_workspace_dependencies` tool, is left mounted because it answers one
   * question and does nothing on its own.
   */
  { id: 'skill-office', bundle: 'dsh-office' }
]

/**
 * The markets, mirroring DSH Desktop's MARKET_OPTIONS. `installable` records what
 * is true for THIS image: `dshmarket` is a real npm package; `dsh-community-market`
 * on npm is a 719-byte reserved-name stub and the real one is a Desktop-only
 * TypeScript workspace that is not published — so its card is informative rather
 * than actionable, instead of failing at the pnpm step.
 */
const MARKETS = [
  {
    id: 'community-market',
    name: 'dsh-community-market',
    spec: 'dsh-community-market',
    installable: false
  },
  {
    id: 'dsh-market',
    name: 'dshmarket',
    spec: 'dshmarket',
    installable: true
  }
]

const MANAGED_MARKETS = MARKETS.map((market) => market.name)

async function readBody(req) {
  if (req.method !== 'POST') return {}
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw === '' ? {} : JSON.parse(raw)
}

export function apply(ctx) {
  const send = (res, status, payload) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  /**
   * The inventory entry for one of OUR patch ids.
   *
   * `PluginInfo` carries TWO identities and they are not the same string: `patchId`
   * is the row id the profile patch declares (`browser-mcp`), `entryId` is the
   * Loader entry identity, which cordis namespaces. The profile override is written
   * against `patchId`, while `setPluginEnabled` looks the row up by `entryId` — so
   * matching on `entryId` alone finds nothing and every switch reads as off. Match
   * either, and hand `entryId` to the manager.
   */
  const findRow = async (id) => (await ctx.pluginManager.listPlugins())
    .find((entry) => entry.patchId === id || entry.entryId === id)

  /** Switch one of OUR features on or off. */
  const setRow = async (feature, enabled) => {
    // ON goes through the BUNDLE first: the row is the bundle's patch, so a bundle
    // that is not selected contributes no row, and `setPluginEnabled` would find
    // nothing to re-enable. `setBundleEnabled` also reloads the bundle's rows, so
    // the lookup below sees the freshly composed entry.
    if (enabled) {
      const bundle = (await ctx.pluginManager.listBundles()).find((entry) => entry.name === feature.bundle)
      if (bundle?.enabled !== true) await ctx.pluginManager.setBundleEnabled(feature.bundle, true)
    }
    // OFF only flips the row, and deliberately LEAVES THE BUNDLE SELECTED: that is
    // what keeps the switch reversible without a restart, and it is also the half
    // that actually releases the context — a deselected bundle would take the row
    // with it, and there would be nothing left to switch back on.
    const entry = await findRow(feature.id)
    if (entry === undefined) {
      throw new Error(`the loader has no row "${feature.id}" — "${feature.bundle}" is installed but not composed in this profile`)
    }
    await ctx.pluginManager.setPluginEnabled(entry.entryId, enabled)
  }

  /** Switch one of OUR bundles — the write behind the page's bundle cards. */
  const setBundle = async (name, enabled) => {
    await ctx.pluginManager.setBundleEnabled(name, enabled)
  }

  /** Every market off (the master switch, and the "only one at a time" rule). */
  const marketsOff = async () => {
    for (const market of MANAGED_MARKETS) {
      try {
        await setBundle(market, false)
      } catch {
        /* a market that was never installed cannot be deselected — not an error */
      }
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      const action = new URL(req.url ?? ROUTE, 'http://localhost').pathname.slice(ROUTE.length).replace(/^\//u, '')
      try {
        switch (action) {
          case 'state': {
            // `enabled` comes from the LIVE row, not from bundle selection: the
            // bundle stays selected while its row is switched off, so the bundle's
            // own flag would report the feature as on when it costs nothing and
            // does nothing.
            //
            // `present` is read from the DECLARED rows of every bundle rather than
            // from the live entries: a switched-off row may legitimately be absent
            // from `listPlugins()`, and deriving it from live state would grey out
            // the very switch needed to turn it back on.
            const bundles = await ctx.pluginManager.listBundles()
            const declared = new Set(bundles.flatMap((bundle) => (bundle.rows ?? []).map((entry) => entry.rowId)))
            const entries = await Promise.all(ROWS.map(async (row) => {
              const entry = await findRow(row.id)
              return { id: row.id, enabled: entry?.enabled === true, present: declared.has(row.id) || entry !== undefined }
            }))
            return send(res, 200, {
              ok: true,
              rows: entries,
              bundles: bundles
                .filter((bundle) => MANAGED_MARKETS.includes(bundle.name))
                .map((bundle) => ({ name: bundle.name, enabled: bundle.enabled === true, installed: bundle.installed === true }))
            })
          }
          case 'row': {
            const body = await readBody(req)
            const feature = ROWS.find((row) => row.id === String(body.id ?? ''))
            if (feature === undefined) return send(res, 400, { ok: false, error: `not managed here: ${String(body.id ?? '')}` })
            await setRow(feature, body.enabled === true)
            return send(res, 200, { ok: true, id: feature.id, enabled: body.enabled === true })
          }
          case 'bundle': {
            const body = await readBody(req)
            const name = String(body.name ?? '')
            if (!MANAGED_MARKETS.includes(name)) return send(res, 400, { ok: false, error: `not managed here: ${name}` })
            await setBundle(name, body.enabled === true)
            return send(res, 200, { ok: true, name, enabled: body.enabled === true })
          }
          case 'market': {
            const body = await readBody(req)
            const market = MARKETS.find((entry) => entry.id === String(body.id ?? ''))
            if (market === undefined) return send(res, 400, { ok: false, error: `unknown market: ${String(body.id ?? '')}` })
            if (market.installable !== true) {
              return send(res, 400, { ok: false, error: `${market.name} is not installable in this image: the published npm name is a reserved stub and the real package ships with DSH Desktop` })
            }
            await marketsOff()
            const before = (await ctx.pluginManager.listBundles()).find((bundle) => bundle.name === market.name)
            const needsInstall = before === undefined || before.installed !== true
            if (needsInstall) await ctx.pluginManager.installBundle(market.spec, { enabled: false })
            await setBundle(market.name, true)
            return send(res, 200, { ok: true, id: market.id, installed: needsInstall })
          }
          case 'market-off': {
            await marketsOff()
            return send(res, 200, { ok: true })
          }
          default:
            return send(res, 404, { ok: false, error: `unknown action "${action}"` })
        }
      } catch (error) {
        return send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }), 'plugins-page-extras: HTTP routes')
}
