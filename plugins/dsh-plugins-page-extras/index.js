/**
 * dsh-plugins-page-extras — host half.
 *
 * Owns the two operations the Plugins-page sections need, behind three small
 * routes so the client half never has to guess at the client-side service graph:
 *
 *   GET  /dsh-plugins-page-extras/state          -> which of OUR bundles are on
 *   POST /dsh-plugins-page-extras/bundle         { name, enabled }
 *   POST /dsh-plugins-page-extras/market         { id }        (install if needed)
 *   POST /dsh-plugins-page-extras/market-off     {}
 *
 * It drives the plugin manager's own host service (`ctx.pluginManager`), i.e. the
 * same calls the Plugins page makes for its switches — `listBundles()`,
 * `selectBundle(name, enabled)` and `installBundle(spec, options)`. Nothing here
 * invents a private API, and nothing here needs the browser to be logged in.
 */

export const name = 'plugins-page-extras'
export const inject = ['pluginManager', 'webServer']

const ROUTE = '/dsh-plugins-page-extras'

/** The integrated browser tooling this image ships (plugins/dsh-browser-mcp). */
const BROWSER_BUNDLE = 'dsh-browser-mcp'

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

const MANAGED = [BROWSER_BUNDLE, ...MARKETS.map((market) => market.name)]

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

  const describe = (bundle) => ({
    name: bundle.name,
    enabled: bundle.enabled === true,
    installed: bundle.installed === true
  })

  /** Switch one of OUR bundles on or off — the same write the page's own switch makes. */
  const setBundle = async (name, enabled) => {
    await ctx.pluginManager.selectBundle(name, enabled)
  }

  /** Every market off (the master switch, and the "only one at a time" rule). */
  const marketsOff = async () => {
    for (const market of MARKETS) {
      try {
        await setBundle(market.name, false)
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
            const bundles = await ctx.pluginManager.listBundles()
            return send(res, 200, {
              ok: true,
              bundles: bundles.filter((bundle) => MANAGED.includes(bundle.name)).map(describe)
            })
          }
          case 'bundle': {
            const body = await readBody(req)
            const name = String(body.name ?? '')
            if (!MANAGED.includes(name)) return send(res, 400, { ok: false, error: `not managed here: ${name}` })
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
