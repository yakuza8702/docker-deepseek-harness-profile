/**
 * dsh-plugins-page-extras — client half.
 *
 * Two sections at the TOP of the Plugins page, above the "Official" group,
 * arranged the way DSH Desktop arranges its own features there:
 *
 *   1. INTEGRATED — the container's browser tooling (`dsh-browser-mcp`) with a
 *      switch and an "Open panel" button (the noVNC desktop), the same shape as
 *      Desktop's "Remote Control" row.
 *   2. PLUGIN MARKET — a master switch plus one card per market, only one of
 *      which can be on at a time, the same shape as Desktop's "Plugin market".
 *
 * The section is rendered through the `plugins.page.top` slot. That slot does not
 * exist upstream: tools/patch-plugin-manager-page.mjs adds it to the upstream
 * page at image-build time (content-anchored, fails the build if the anchor
 * moves), because the stock page offers no extension point above the groups.
 *
 * Everything here talks to the harness through the plugin-manager's own client
 * service (`remote.pluginManager`), i.e. exactly the calls the page itself makes
 * for its own switches — no private API, no host half of our own.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugins-page-extras',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useCallback, useEffect, useState } = React

    /** The integrated browser tooling this image ships (plugins/dsh-browser-mcp). */
    const BROWSER_BUNDLE = 'dsh-browser-mcp'
    const DESKTOP_PATH = '/desktop/vnc.html?autoconnect=1&resize=scale&view_only=0&reconnect=1'

    /**
     * The markets, mirroring Desktop's MARKET_OPTIONS (community market /
     * dsh-market) with the same repositories.
     * `installable` records what is true for THIS image: `dshmarket` is a real npm
     * package; `dsh-community-market` on npm is a 719-byte reserved-name stub, and
     * the real package is a Desktop-only TypeScript workspace that is not
     * published anywhere — so that card is informative rather than actionable
     * instead of failing at the pnpm step.
     */
    const MARKETS = [
      {
        id: 'community-market',
        name: 'dsh-community-market',
        spec: 'dsh-community-market',
        title: 'dsh-community-market',
        badge: 'Beta',
        body: 'The open plugin market built into DSH Desktop, with support for custom plugin data sources.',
        repo: 'https://github.com/anywhere-labs/deepseek-harness-desktop/tree/master/dsh-community-market',
        installable: false,
        note: 'Not installable in this image: the published npm name is a reserved-name stub, and the real package ships as part of DSH Desktop (TypeScript, not published). Build it from the repository and install it as a local path to use it here.'
      },
      {
        id: 'dsh-market',
        name: 'dshmarket',
        spec: 'dshmarket',
        title: 'dsh-market',
        badge: null,
        body: 'A popular community plugin market powered by data from awesome-dsh-plugin.',
        repo: 'https://github.com/dsh-market/dsh-market',
        installable: true,
        note: null
      }
    ]

    const S = {
      section: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 },
      head: { display: 'flex', alignItems: 'baseline', gap: 8 },
      title: { margin: 0, fontSize: 14, fontWeight: 500, lineHeight: '22px' },
      hint: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' },
      card: {
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.12))',
        borderRadius: 12, background: 'var(--dsw-alias-bg-elevated, rgba(255,255,255,.03))'
      },
      cardMain: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
      cardTitle: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 500 },
      cardBody: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' },
      badge: {
        fontSize: 10, lineHeight: '16px', padding: '0 6px', borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.2))',
        color: 'var(--dsw-alias-label-tertiary)'
      },
      button: {
        height: 28, padding: '0 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.16))',
        background: 'var(--dsw-alias-button-elevated-fill, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)'
      },
      switch: (on) => ({
        width: 40, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer', padding: 0,
        background: on ? 'var(--dsw-alias-state-success-primary, #2ea043)' : 'var(--dsw-alias-bg-sunken, rgba(255,255,255,.18))',
        position: 'relative', flex: '0 0 auto'
      }),
      knob: (on) => ({
        position: 'absolute', top: 2, left: on ? 20 : 2, width: 18, height: 18, borderRadius: '50%',
        background: '#fff', transition: 'left 120ms ease'
      }),
      notice: { margin: 0, fontSize: 12.5, color: 'var(--dsw-alias-label-tertiary)' },
      error: { margin: 0, fontSize: 12.5, color: 'var(--dsw-alias-state-error-primary, #f28b82)' }
    }

    const Toggle = ({ on, onToggle, label, disabled }) => React.createElement('button', {
      type: 'button', style: { ...S.switch(on), opacity: disabled ? .5 : 1 }, role: 'switch',
      'aria-checked': on ? 'true' : 'false', 'aria-label': label, disabled,
      onClick: () => onToggle(!on)
    }, React.createElement('span', { style: S.knob(on) }))

    const Link = ({ href, children }) => React.createElement('a', {
      href, target: '_blank', rel: 'noopener noreferrer',
      style: { color: 'inherit', textDecoration: 'underline' }
    }, children)

    function Extras() {
      const [bundles, setBundles] = useState(null)
      const [busy, setBusy] = useState(null)
      const [message, setMessage] = useState(null)
      const [selected, setSelected] = useState('dsh-market')

      const state = (name) => bundles?.find((entry) => entry.name === name) ?? null

      const call = useCallback(async (action, body) => {
        const response = await fetch(`${ROUTE}/${action}`, body === undefined
          ? { headers: { accept: 'application/json' } }
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        const payload = await response.json().catch(() => null)
        if (payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      }, [])

      const refresh = useCallback(async () => {
        try {
          const payload = await call('state')
          setBundles(payload.bundles ?? [])
          return true
        } catch (error) {
          setMessage(String(error?.message ?? error))
          return false
        }
      }, [call])

      useEffect(() => { void refresh() }, [refresh])

      const setBundle = useCallback(async (name, enabled) => {
        setBusy(name); setMessage(null)
        try {
          await call('bundle', { name, enabled })
          setMessage(`${name} ${enabled ? 'enabled' : 'disabled'}.`)
        } catch (error) {
          setMessage(String(error?.message ?? error))
        } finally {
          setBusy(null)
          void refresh()
        }
      }, [call, refresh])

      const enableMarket = useCallback(async (market) => {
        setSelected(market.id)
        if (market.installable !== true) {
          setMessage(market.note)
          return
        }
        setBusy(market.name); setMessage(market.installed === false ? `Installing ${market.spec}…` : null)
        try {
          const payload = await call('market', { id: market.id })
          setMessage(payload.installed === true
            ? `${market.title} installed and enabled — it loads on the next restart.`
            : `${market.title} is on.`)
        } catch (error) {
          setMessage(String(error?.message ?? error))
        } finally {
          setBusy(null)
          void refresh()
        }
      }, [call, refresh])

      const activeMarket = MARKETS.find((market) => state(market.name)?.enabled === true) ?? null
      const browser = state(BROWSER_BUNDLE)
      const marketOn = activeMarket !== null

      return React.createElement('div', { 'data-plugin-section': 'plugins-page-extras' },
        // ---- Integrated --------------------------------------------------
        React.createElement('section', { style: S.section },
          React.createElement('div', { style: S.head },
            React.createElement('h3', { style: S.title }, 'Integrated'),
            React.createElement('span', { style: S.hint }, 'Shipped with this container')
          ),
          React.createElement('div', { style: S.card },
            React.createElement('div', { style: S.cardMain },
              React.createElement('div', { style: S.cardTitle }, 'Browser tools'),
              React.createElement('div', { style: S.cardBody },
                'Let the model drive the container\u2019s visible browser: navigate, read pages, click, type and screenshot through the Playwright MCP server attached over CDP. Switch it off to save the tool definitions\u2019 context.')
            ),
            React.createElement('button', {
              type: 'button', style: S.button, title: 'Open the browser desktop for human takeover',
              onClick: () => { window.open(DESKTOP_PATH, '_blank', 'noopener') }
            }, 'Open panel'),
            React.createElement(Toggle, {
              on: browser?.enabled === true, label: 'Enable Browser tools',
              disabled: bundles === null || busy === BROWSER_BUNDLE,
              onToggle: (next) => void setBundle(BROWSER_BUNDLE, next)
            })
          )
        ),

        // ---- Plugin market ----------------------------------------------
        React.createElement('section', { style: S.section },
          React.createElement('div', { style: { ...S.head, justifyContent: 'space-between' } },
            React.createElement('div', { style: S.head },
              React.createElement('h3', { style: S.title }, 'Plugin market'),
              React.createElement('span', { style: S.hint }, 'Only one can be enabled at a time')
            ),
            React.createElement(Toggle, {
              on: marketOn, label: 'Enable a plugin market',
              disabled: bundles === null || busy !== null,
              onToggle: (next) => {
                if (next) void enableMarket(MARKETS.find((market) => market.id === selected) ?? MARKETS[1])
                else void call('market-off').then(() => refresh()).catch((error) => setMessage(String(error?.message ?? error)))
              }
            })
          ),
          React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 } },
            ...MARKETS.map((market) => {
              const entry = state(market.name)
              const isActive = entry?.enabled === true
              return React.createElement('div', {
                key: market.id,
                style: {
                  ...S.card, alignItems: 'flex-start', cursor: market.installable === true ? 'pointer' : 'default',
                  outline: isActive ? '2px solid var(--dsw-alias-state-success-primary, #2ea043)' : 'none'
                },
                onClick: () => void enableMarket(market)
              },
                React.createElement('div', { style: S.cardMain },
                  React.createElement('div', { style: S.cardTitle },
                    React.createElement(Link, { href: market.repo }, market.title),
                    market.badge !== null && React.createElement('span', { style: S.badge }, market.badge),
                    entry !== null && entry.installed !== true && React.createElement('span', { style: S.badge }, 'not installed')
                  ),
                  React.createElement('div', { style: S.cardBody },
                    market.id === 'dsh-market'
                      ? React.createElement(React.Fragment, null, market.body, ' ', React.createElement(Link, { href: 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin' }, 'awesome-dsh-plugin'))
                      : market.body
                  )
                )
              )
            })
          )
        ),

        message !== null && React.createElement('p', { style: S.error }, message)
      )
    }

    /** Route prefix of the host half. */
    const ROUTE = '/dsh-plugins-page-extras'

    /** Only `slots`: all data comes from our own host routes, over plain fetch. */
    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('plugins.page.top', () => ctx.slots.register({
        name: 'plugins.page.top',
        id: 'plugins-page-extras',
        order: 10,
        label: 'Integrated'
      }, Extras))
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  }
})
