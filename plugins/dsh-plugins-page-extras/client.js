/**
 * dsh-plugins-page-extras — client half.
 *
 * The top of the Plugins page, arranged 1:1 like DSH Desktop's own page:
 *
 *   1. PLUGIN MARKET — heading + description with the master switch on the right,
 *      then one equal-width card per market, the active one outlined. Desktop's
 *      layout, copy and repository links.
 *   2. This container's integrated browser tooling — a single ROW with an icon
 *      tile, a title, a description and its controls at the end: exactly the shape
 *      of Desktop's "Remote Control" / "Computer Use" rows, and exactly the shape
 *      of this page's own official package rows. No group heading, because
 *      Desktop has none above them.
 *
 * Both come before the page's own "Official" group, through the `plugins.page.top`
 * slot that tools/patch-plugin-manager-page.mjs adds to the upstream page at
 * image-build time (the build fails if that anchor moves).
 *
 * Styling uses the page's own design tokens and its own metrics (14px/20px
 * medium titles, 13px/18px tertiary descriptions, 48px icon tiles with a 0.5px
 * `border-l3` frame, `--dsw-radius-lg`/`-xl`), so the block is indistinguishable
 * from the groups underneath it. Only `react` is required: third-party client
 * bundles cannot resolve the UI primitives.
 *
 * All state comes from this plugin's own host routes; the writes are the same
 * plugin-manager calls the page's own cards make, so the two never disagree.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugins-page-extras',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useCallback, useEffect, useState } = React

    /** Route prefix of this plugin's own host half. */
    const ROUTE = '/dsh-plugins-page-extras'

    /** The visible browser desktop the "Open panel" action points at. */
    const DESKTOP_PATH = '/desktop/vnc.html?autoconnect=1&resize=scale&view_only=0&reconnect=1'

    /**
     * The two integrated browser features, one row each — and one switch each.
     *
     * They are deliberately separate because they cost DIFFERENT things: the MCP row
     * is 24 tool definitions, the desktop row is one tool (`browser_open`) plus a
     * system-prompt section. One switch for both meant releasing the cheaper one to
     * drop the expensive one, and there was no way to keep the visible desktop while
     * dropping its prompt cost.
     *
     * `row` is the loader entry id the host route toggles.
     */
    const FEATURES = [
      {
        row: 'browser-mcp',
        glyph: 'tools',
        title: 'Browser tools',
        body: 'Let the model drive this container\u2019s visible browser \u2014 navigate, read pages, click, type and screenshot \u2014 through the Playwright MCP server attached over CDP. This is the whole tool surface: turn it off to stop paying for it in every request.'
      },
      {
        row: 'browser-desktop',
        glyph: 'desktop',
        title: 'Browser Use',
        body: 'The visible Chromium desktop itself, plus the browser_open hand-off tool and its system-prompt section that let the model reveal a page to you for human takeover. Its own cost is small but constant \u2014 turn it off to release it while Browser tools stays on.',
        panel: true
      }
    ]

    /**
     * The markets — Desktop's MARKET_OPTIONS (its copy and repositories), minus its
     * "disabled" entry, which the master switch expresses.
     * `installable` records what is true for THIS image: `dshmarket` is a real npm
     * package; `dsh-community-market` on npm is a 719-byte reserved-name stub and
     * the real one is a Desktop-only TypeScript workspace that is not published.
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

    /* The page's own tokens, with the values it falls back to. */
    const T = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      secondary: 'var(--dsw-alias-label-secondary, #9aa3ad)',
      tertiary: 'var(--dsw-alias-label-tertiary, #8b949e)',
      caption: 'var(--dsw-alias-label-caption, #8b949e)',
      error: 'var(--dsw-alias-state-error-primary, #f28b82)',
      line: 'var(--dsw-alias-border-l3, rgba(255,255,255,.14))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))',
      radiusSm: 'var(--dsw-radius-sm, 6px)',
      radiusMd: 'var(--dsw-radius-md, 8px)',
      radiusLg: 'var(--dsw-radius-lg, 10px)',
      radiusXl: 'var(--dsw-radius-xl, 14px)',
      /* The page's own switch tokens — theme-aware, so light mode works too. */
      switchOff: 'var(--dsw-alias-border-l3, rgba(0,0,0,.2))',
      switchOn: 'var(--dsw-alias-brand-primary, #2b7fff)',
      knob: 'var(--dsw-alias-label-primary-foreground, #fff)'
    }

    const S = {
      /*
       * The page's own column, repeated here: `.page > *` sets `width:100%` and
       * `max-width:960px`, but the slot renderer wraps every registered entry in a
       * `display:contents` element, which generates no box — so those two
       * declarations are dropped and a block that does not repeat them stretches
       * to the full page width instead of lining up with the Official group.
       * `.page` centres its items, so the 960px column lands on the same gutter.
       */
      root: { display: 'flex', flexDirection: 'column', gap: 24, width: '100%', maxWidth: 960, boxSizing: 'border-box' },
      /* One group of the page: the same 8px rhythm as `.group`. */
      group: { display: 'flex', flexDirection: 'column', gap: 8, width: '100%' },
      /* Heading + explanation on the left, the master control on the right. */
      head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 },
      title: { margin: 0, fontSize: 14, lineHeight: '22px', fontWeight: 500, color: T.text },
      desc: { margin: '2px 0 0', fontSize: 13, lineHeight: '20px', color: T.secondary },

      /* Two market cards of exactly equal width, like Desktop's. */
      cards: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12, margin: '6px 0 0' },
      card: (active, actionable) => ({
        display: 'flex', flexDirection: 'column', gap: 6, boxSizing: 'border-box',
        padding: '12px 14px', border: `1px solid ${active ? T.text : T.line}`,
        borderRadius: T.radiusLg, background: 'transparent',
        cursor: actionable ? 'pointer' : 'default'
      }),
      cardTitle: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 14, lineHeight: '20px', fontWeight: 500, color: T.text },
      cardBody: { fontSize: 13, lineHeight: '18px', color: T.tertiary },
      badge: {
        fontSize: 10, lineHeight: '16px', padding: '0 6px', borderRadius: 999, fontWeight: 500,
        border: `0.5px solid ${T.line}`, color: T.caption
      },
      link: { color: 'inherit', textDecoration: 'none' },

      /* A package-shaped row: `.cardHead` of the official cards, verbatim metrics. */
      row: { display: 'flex', alignItems: 'center', gap: 14, padding: 8, margin: '0 -8px', borderRadius: T.radiusXl },
      tile: {
        display: 'inline-flex', flex: 'none', alignItems: 'center', justifyContent: 'center',
        width: 48, height: 48, boxSizing: 'border-box', border: `0.5px solid ${T.line}`,
        borderRadius: T.radiusLg, color: T.secondary
      },
      rowMain: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 },
      rowTitle: { fontSize: 14, lineHeight: '20px', fontWeight: 500, color: T.text },
      rowBody: { fontSize: 13, lineHeight: '18px', color: T.tertiary },
      end: { display: 'inline-flex', flex: 'none', alignItems: 'center', gap: 10 },

      button: {
        height: 28, padding: '0 10px', borderRadius: T.radiusSm, cursor: 'pointer', boxSizing: 'border-box',
        border: `0.5px solid ${T.line}`, background: 'transparent', color: T.text,
        fontSize: 12, lineHeight: '18px', fontWeight: 500, fontFamily: 'inherit'
      },
      hint: { fontSize: 12, lineHeight: '18px', color: T.caption }
    }

    /*
     * The page's own Switch, mirrored: 36x20 capsule, 2px padding, thumb
     * translated 16px when on. Same tokens as @deepseek-ai/dsh-client-ui-primitives,
     * which a third-party client bundle cannot import.
     */
    const Toggle = ({ on, onToggle, label, disabled }) => React.createElement('button', {
      type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label,
      disabled, title: label,
      style: {
        boxSizing: 'border-box', position: 'relative', flex: '0 0 auto', width: 36, height: 20,
        padding: 2, border: 0, borderRadius: 999, opacity: disabled ? 0.5 : 1,
        background: on ? T.switchOn : T.switchOff,
        cursor: disabled ? 'default' : 'pointer'
      },
      onClick: () => onToggle(!on)
    }, React.createElement('span', {
      style: {
        display: 'block', width: 16, height: 16, borderRadius: '50%', background: T.knob,
        transform: on ? 'translateX(16px)' : 'none', transition: 'transform 120ms ease'
      }
    }))

    const A = ({ href, children }) => React.createElement('a', {
      href, target: '_blank', rel: 'noopener noreferrer', style: S.link,
      onClick: (event) => event.stopPropagation()
    }, children)

    /** The first feature's glyph: a browser window over a page. */
    const ToolsIcon = () => React.createElement('svg', {
      width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true
    },
      React.createElement('rect', { x: 2.5, y: 4, width: 19, height: 16, rx: 2.5 }),
      React.createElement('path', { d: 'M2.5 8.5h19' }),
      React.createElement('circle', { cx: 5.6, cy: 6.2, r: 0.65, fill: 'currentColor', stroke: 'none' }),
      React.createElement('circle', { cx: 7.9, cy: 6.2, r: 0.65, fill: 'currentColor', stroke: 'none' }),
      React.createElement('circle', { cx: 12, cy: 14.3, r: 3 }),
      React.createElement('path', { d: 'M9 14.3h6M12 11.3c1.55 1.65 1.55 4.35 0 6M12 11.3c-1.55 1.65-1.55 4.35 0 6' })
    )

    /** The second feature's glyph: the display the human sits in front of. */
    const DesktopIcon = () => React.createElement('svg', {
      width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true
    },
      React.createElement('rect', { x: 2.5, y: 4, width: 19, height: 12.5, rx: 2.2 }),
      React.createElement('path', { d: 'M9.5 20.5h5M12 16.5v4' }),
      React.createElement('path', { d: 'M8.6 12.4l2.1-2.6 1.9 1.6 2.3-3' })
    )

    function Extras() {
      const [rows, setRows] = useState(null)
      const [bundles, setBundles] = useState(null)
      const [busy, setBusy] = useState(null)
      /* `{ text, tone }`: informational lines must not wear the error colour. */
      const [message, setMessage] = useState(null)
      const say = useCallback((text, tone = 'info') => setMessage({ text, tone }), [])
      const [selected, setSelected] = useState('dsh-market')

      const bundle = (name) => bundles?.find((entry) => entry.name === name) ?? null
      const row = (id) => rows?.find((entry) => entry.id === id) ?? null
      const loaded = rows !== null && bundles !== null

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
          setRows(payload.rows ?? [])
          setBundles(payload.bundles ?? [])
        } catch (error) {
          say(String(error?.message ?? error), 'error')
        }
      }, [call])

      useEffect(() => { void refresh() }, [refresh])

      /** Switch one integrated feature's loader row — live, and independent of the other. */
      const setRow = useCallback(async (feature, enabled) => {
        setBusy(feature.row); setMessage(null)
        try {
          await call('row', { id: feature.row, enabled })
          say(`${feature.title} ${enabled ? 'on' : 'off'}.`)
        } catch (error) {
          say(String(error?.message ?? error), 'error')
        } finally {
          setBusy(null)
          void refresh()
        }
      }, [call, refresh])

      const enableMarket = useCallback(async (market) => {
        setSelected(market.id)
        if (market.installable !== true) {
          say(market.note)
          return
        }
        setBusy(market.name)
        if (bundle(market.name)?.installed !== true) say(`Installing ${market.spec}\u2026`)
        try {
          const payload = await call('market', { id: market.id })
          say(payload.installed === true
            ? `${market.title} installed and enabled \u2014 it loads on the next restart.`
            : `${market.title} is on.`)
        } catch (error) {
          say(String(error?.message ?? error), 'error')
        } finally {
          setBusy(null)
          void refresh()
        }
      }, [call, refresh, bundles])

      const activeMarket = MARKETS.find((market) => bundle(market.name)?.enabled === true) ?? null
      const busyAny = busy !== null

      const marketCard = (market) => {
        const entry = bundle(market.name)
        const isActive = activeMarket?.id === market.id
        return React.createElement('div', {
          key: market.id, 'data-market': market.id, 'data-active': isActive ? 'true' : 'false',
          style: S.card(isActive, market.installable === true),
          onClick: () => void enableMarket(market)
        },
          React.createElement('div', { style: S.cardTitle },
            React.createElement(A, { href: market.repo }, market.title),
            market.badge !== null && React.createElement('span', { style: S.badge }, market.badge),
            entry !== null && entry.installed !== true && React.createElement('span', { style: S.badge }, 'not installed')
          ),
          React.createElement('div', { style: S.cardBody },
            market.id === 'dsh-market'
              ? React.createElement(React.Fragment, null, market.body, ' ', React.createElement(A, { href: 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin' }, 'awesome-dsh-plugin'))
              : market.body
          )
        )
      }

      const featureRow = (feature) => {
        const entry = row(feature.row)
        return React.createElement('div', {
          key: feature.row, 'data-feature': feature.row, style: S.row
        },
          React.createElement('span', { style: S.tile, 'aria-hidden': true },
            feature.glyph === 'desktop' ? React.createElement(DesktopIcon) : React.createElement(ToolsIcon)),
          React.createElement('div', { style: S.rowMain },
            React.createElement('div', { style: S.rowTitle }, feature.title),
            React.createElement('div', { style: S.rowBody }, feature.body)
          ),
          React.createElement('div', { style: S.end },
            feature.panel === true && React.createElement('button', {
              type: 'button', style: S.button,
              title: 'Open the visible browser desktop in a new tab for human takeover',
              onClick: () => window.open(DESKTOP_PATH, '_blank', 'noopener')
            }, 'Open panel'),
            React.createElement(Toggle, {
              on: entry?.enabled === true, label: `Enable ${feature.title}`,
              // `present === false` means this image did not compose the row at all
              // (DSH_BROWSER_MCP=0, DSH_DESKTOP_ENABLED=0, or an unseeded profile):
              // a switch that could only fail is greyed out instead.
              disabled: !loaded || busyAny || entry?.present === false,
              onToggle: (next) => void setRow(feature, next)
            })
          )
        )
      }

      return React.createElement('div', {
        'data-plugin-section': 'plugins-page-extras',
        style: S.root
      },
        /* ---- Plugin market: first, exactly like Desktop -------------------- */
        React.createElement('section', { style: S.group, 'data-extra-section': 'market' },
          React.createElement('div', { style: S.head },
            React.createElement('div', null,
              React.createElement('h3', { style: S.title }, 'Plugin market'),
              React.createElement('p', { style: S.desc }, 'Choose a plugin market. Only one can be enabled at a time.')
            ),
            React.createElement(Toggle, {
              on: activeMarket !== null, label: 'Enable a plugin market',
              disabled: !loaded || busyAny,
              onToggle: (next) => {
                if (next) {
                  void enableMarket(MARKETS.find((market) => market.id === selected) ?? MARKETS[1])
                  return
                }
                setBusy('market-off'); setMessage(null)
                void call('market-off')
                  .then(() => say('Plugin market off.'))
                  .catch((error) => say(String(error?.message ?? error), 'error'))
                  .finally(() => { setBusy(null); void refresh() })
              }
            })
          ),
          React.createElement('div', { style: S.cards }, ...MARKETS.map(marketCard))
        ),

        /* ---- The integrated features: rows, no heading (Desktop's shape) ---- */
        React.createElement('section', { style: S.group, 'data-extra-section': 'browser' },
          ...FEATURES.map(featureRow)
        ),

        message !== null && React.createElement('p', {
          role: message.tone === 'error' ? 'alert' : 'status',
          style: {
            margin: 0, fontSize: 12, lineHeight: '18px',
            color: message.tone === 'error' ? T.error : T.caption
          }
        }, message.text)
      )
    }

    /** Only `slots`: all data comes from our own host routes, over plain fetch. */
    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('plugins.page.top', () => ctx.slots.register({
        name: 'plugins.page.top',
        id: 'plugins-page-extras',
        order: 10,
        label: 'Plugin market'
      }, Extras))
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  }
})
