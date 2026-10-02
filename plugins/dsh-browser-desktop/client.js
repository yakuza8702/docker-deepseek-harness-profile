window.__ModuleLoader__.load({
  id: 'dsh-browser-desktop',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')

    const zh = window.navigator.language.toLowerCase().startsWith('zh')
    const messages = {
      browser: zh ? '浏览器桌面' : 'Browser desktop',
      browserDialog: zh ? '浏览器桌面 · 人工接管' : 'Browser desktop · Human takeover',
      browserFrame: zh ? '容器 Chromium 桌面' : 'Container Chromium desktop',
      close: zh ? '关闭' : 'Close',
      maximize: zh ? '最大化' : 'Maximize',
      openNew: zh ? '新窗口打开' : 'Open in new window',
      openTitle: zh ? '打开浏览器桌面并人工接管' : 'Open browser desktop for human takeover',
      resize: zh ? '调整浏览器窗口大小' : 'Resize browser window',
      resizeHint: zh ? '拖动标题栏 · 右下角缩放' : 'Drag title bar · resize from corner',
      resizeTitle: zh ? '拖动调整窗口大小' : 'Drag to resize',
      restore: zh ? '还原' : 'Restore'
    }

    let browserState = {
      opened: false,
      // null = same origin as the Harness page (single-port deployments where
      // the desktop is path-routed through the Harness proxy). A number is an
      // explicit port (the upstream shape, used when noVNC listens separately).
      desktopPort: null,
      desktopPath: '/vnc.html?autoconnect=1&resize=scale&view_only=0&reconnect=1',
      pollIntervalMs: 750
    }
    let lastBrowserRevision = null
    const listeners = new Set()

    function updateBrowserState(patch) {
      const next = { ...browserState, ...patch }
      if (Object.keys(next).every((key) => next[key] === browserState[key])) return
      browserState = next
      for (const listener of listeners) listener()
    }

    function setOpened(value) {
      updateBrowserState({ opened: value })
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function useBrowserState() {
      return React.useSyncExternalStore(subscribe, () => browserState, () => browserState)
    }

    function useBrowserToolEvents() {
      React.useEffect(() => {
        let disposed = false
        let timer

        async function poll() {
          try {
            const response = await fetch('/browser-desktop/state', { cache: 'no-store' })
            if (!response.ok) throw new Error(`browser state returned HTTP ${response.status}`)
            const state = await response.json()
            if (disposed) return

            // The host reports the desktop port as a positive integer, or as
            // null/0 for "same origin as this page". Same-origin is the correct
            // answer behind a reverse proxy: only the BROWSER knows the public
            // authority (https://host with no port vs http://lan-ip:3080), so
            // forcing a port here would break one of the two. See desktopUrl().
            const desktopPort = state.desktop === undefined
              ? browserState.desktopPort
              : Number.isInteger(state.desktop.port) && state.desktop.port > 0
                ? state.desktop.port
                : null
            const desktopPath = typeof state.desktop?.path === 'string' && state.desktop.path.startsWith('/')
              ? state.desktop.path
              : browserState.desktopPath
            const pollIntervalMs = Number.isInteger(state.pollIntervalMs)
              ? Math.min(10000, Math.max(250, state.pollIntervalMs))
              : browserState.pollIntervalMs
            updateBrowserState({ desktopPort, desktopPath, pollIntervalMs })

            if (lastBrowserRevision === null) {
              lastBrowserRevision = state.revision
              if (state.revision > 0 && Date.now() - state.openedAt < 15000) setOpened(true)
            } else if (state.revision !== lastBrowserRevision) {
              lastBrowserRevision = state.revision
              setOpened(true)
            }
          } catch {
            // The host half can be briefly unavailable during Harness HMR or
            // a container restart. The next poll reconnects automatically.
          } finally {
            if (!disposed) timer = window.setTimeout(poll, browserState.pollIntervalMs)
          }
        }

        poll()
        return () => {
          disposed = true
          if (timer !== undefined) window.clearTimeout(timer)
        }
      }, [])
    }

    function desktopUrl(port, path) {
      const url = new URL(window.location.href)
      const target = new URL(path, url)
      // Only override the port when the host asked for a specific one. Leaving
      // it alone keeps whatever the browser used to reach the Harness UI, which
      // is what makes one URL work both on the LAN (http://host:3080) and behind
      // an https reverse proxy (https://host, implicit 443).
      if (Number.isInteger(port) && port > 0) target.port = String(port)
      return target.toString()
    }

    /**
     * The sidebar entry: an ICON ONLY control at the trailing edge of the Settings
     * row, through the `sidebar.footer.trailing` slot this image adds — see
     * tools/patch-sidebar-footer.mjs, which also supplies its styling.
     *
     * Icon-only on purpose. It is the same 36x36 box, the same radius token and the
     * same theme variables as the profile control beside it, and its glyph is drawn
     * on the same 16x16 grid at the same 1.5 stroke, so the row reads as one set of
     * controls. The name lives in `title`/`aria-label`; a text label in that row
     * would push the Settings label aside for a button that only opens a panel.
     *
     * `data-dsh-sidebar-glyph` is the styling contract: the patched stylesheet
     * carries the size, the radius, the hover/active/focus states, and in the
     * collapsed rail it selects this icon's place in the column.
     */
    function BrowserGlyph() {
      return React.createElement(
        'button',
        {
          type: 'button',
          title: messages.browser,
          'aria-label': messages.browser,
          'data-dsh-sidebar-glyph': 'browser',
          onClick: () => setOpened(true)
        },
        React.createElement(
          'svg',
          {
            'aria-hidden': 'true',
            focusable: 'false',
            width: '18',
            height: '18',
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: '1.5',
            strokeLinecap: 'round',
            strokeLinejoin: 'round'
          },
          React.createElement('circle', { cx: '8', cy: '8', r: '5.8' }),
          React.createElement('path', { d: 'M2.2 8h11.6' }),
          React.createElement('path', { d: 'M8 2.2c1.75 2.05 1.75 9.55 0 11.6' }),
          React.createElement('path', { d: 'M8 2.2c-1.75 2.05-1.75 9.55 0 11.6' })
        )
      )
    }

    const panelMargin = 12

    function panelBounds(panel) {
      const parent = panel?.offsetParent
      if (parent instanceof HTMLElement) {
        return { width: parent.clientWidth, height: parent.clientHeight }
      }
      return {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight
      }
    }

    function initialPanelRect(bounds) {
      const maxWidth = Math.max(280, bounds.width - panelMargin * 2)
      const maxHeight = Math.max(240, bounds.height - panelMargin * 2)
      const minWidth = Math.min(420, maxWidth)
      const minHeight = Math.min(280, maxHeight)
      const width = Math.min(maxWidth, Math.max(minWidth, Math.round(bounds.width * 0.68)))
      const height = Math.min(maxHeight, Math.max(minHeight, Math.round(bounds.height * 0.68)))
      return {
        x: Math.max(panelMargin, Math.round((bounds.width - width) / 2)),
        y: Math.max(panelMargin, Math.round((bounds.height - height) / 2)),
        width,
        height
      }
    }

    function clampPanelRect(rect, bounds) {
      const maxWidth = Math.max(280, bounds.width - panelMargin * 2)
      const maxHeight = Math.max(240, bounds.height - panelMargin * 2)
      const minWidth = Math.min(420, maxWidth)
      const minHeight = Math.min(280, maxHeight)
      const width = Math.min(maxWidth, Math.max(minWidth, rect.width))
      const height = Math.min(maxHeight, Math.max(minHeight, rect.height))
      return {
        x: Math.min(Math.max(panelMargin, rect.x), Math.max(panelMargin, bounds.width - width - panelMargin)),
        y: Math.min(Math.max(panelMargin, rect.y), Math.max(panelMargin, bounds.height - height - panelMargin)),
        width,
        height
      }
    }

    function maximizedPanelRect(bounds) {
      return {
        x: panelMargin,
        y: panelMargin,
        width: Math.max(280, bounds.width - panelMargin * 2),
        height: Math.max(240, bounds.height - panelMargin * 2)
      }
    }

    function BrowserOverlay() {
      useBrowserToolEvents()
      const { opened: visible, desktopPort, desktopPath } = useBrowserState()
      const src = React.useMemo(
        () => desktopUrl(desktopPort, desktopPath),
        [desktopPort, desktopPath]
      )
      const panelRef = React.useRef(null)
      const interactionRef = React.useRef(null)
      const restoreRectRef = React.useRef(null)
      const positionedRef = React.useRef(false)
      const [maximized, setMaximized] = React.useState(false)
      const [rect, setRect] = React.useState(() => initialPanelRect({
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight
      }))

      React.useLayoutEffect(() => {
        if (!visible || positionedRef.current || panelRef.current === null) return
        setRect(initialPanelRect(panelBounds(panelRef.current)))
        positionedRef.current = true
      }, [visible])

      React.useEffect(() => {
        function move(event) {
          const interaction = interactionRef.current
          if (interaction === null || panelRef.current === null) return
          const bounds = panelBounds(panelRef.current)
          const deltaX = event.clientX - interaction.pointerX
          const deltaY = event.clientY - interaction.pointerY

          if (interaction.kind === 'move') {
            setRect(clampPanelRect({
              ...interaction.rect,
              x: interaction.rect.x + deltaX,
              y: interaction.rect.y + deltaY
            }, bounds))
            return
          }

          setRect(clampPanelRect({
            ...interaction.rect,
            width: interaction.rect.width + deltaX,
            height: interaction.rect.height + deltaY
          }, bounds))
        }

        function end() {
          interactionRef.current = null
          document.body.style.removeProperty('user-select')
          document.body.style.removeProperty('cursor')
        }

        function resizeWindow() {
          if (panelRef.current === null) return
          const bounds = panelBounds(panelRef.current)
          setRect((current) => maximized ? maximizedPanelRect(bounds) : clampPanelRect(current, bounds))
        }

        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', end)
        window.addEventListener('pointercancel', end)
        window.addEventListener('resize', resizeWindow)
        return () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', end)
          window.removeEventListener('pointercancel', end)
          window.removeEventListener('resize', resizeWindow)
          document.body.style.removeProperty('user-select')
          document.body.style.removeProperty('cursor')
        }
      }, [maximized])

      function beginInteraction(kind, event) {
        if (maximized || event.button !== 0) return
        if (kind === 'move' && event.target.closest('button')) return
        event.preventDefault()
        interactionRef.current = {
          kind,
          pointerX: event.clientX,
          pointerY: event.clientY,
          rect
        }
        document.body.style.setProperty('user-select', 'none')
        document.body.style.setProperty('cursor', kind === 'move' ? 'move' : 'nwse-resize')
      }

      function toggleMaximized() {
        if (panelRef.current === null) return
        const bounds = panelBounds(panelRef.current)
        if (maximized) {
          setRect(clampPanelRect(restoreRectRef.current || initialPanelRect(bounds), bounds))
          setMaximized(false)
          return
        }
        restoreRectRef.current = rect
        setRect(maximizedPanelRect(bounds))
        setMaximized(true)
      }

      if (!visible) return null

      return React.createElement(
        'section',
        {
          ref: panelRef,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': messages.browserDialog,
          style: {
            position: 'absolute',
            left: `${rect.x}px`,
            top: `${rect.y}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            boxSizing: 'border-box',
            zIndex: 100,
            pointerEvents: 'auto',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: '14px',
            background: 'var(--dsw-alias-bg-base)',
            boxShadow: '0 18px 60px rgba(0,0,0,.35)'
          }
        },
        React.createElement(
          'header',
          {
            onPointerDown: (event) => beginInteraction('move', event),
            onDoubleClick: toggleMaximized,
            style: {
              height: '44px',
              flex: '0 0 44px',
              padding: '0 10px 0 14px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              borderBottom: '1px solid var(--dsw-alias-border-l2)',
              color: 'var(--dsw-alias-label-primary)',
              cursor: maximized ? 'default' : 'move',
              userSelect: 'none',
              touchAction: 'none'
            }
          },
          React.createElement(
            'strong',
            {
              style: {
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                fontSize: '14px'
              }
            },
            messages.browserDialog,
            React.createElement('span', {
              style: { marginLeft: '8px', fontSize: '12px', fontWeight: 400, opacity: 0.55 }
            }, messages.resizeHint)
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: toggleMaximized,
              style: headerButtonStyle()
            },
            maximized ? messages.restore : messages.maximize
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: () => window.open(src, '_blank', 'noopener,noreferrer'),
              style: headerButtonStyle()
            },
            messages.openNew
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              'aria-label': messages.close,
              onClick: () => setOpened(false),
              style: headerButtonStyle()
            },
            messages.close
          )
        ),
        React.createElement('iframe', {
          title: messages.browserFrame,
          src,
          allow: 'clipboard-read; clipboard-write',
          style: { width: '100%', minHeight: 0, flex: 1, border: 0, background: '#111' }
        }),
        React.createElement('div', {
          role: 'separator',
          'aria-label': messages.resize,
          title: messages.resizeTitle,
          onPointerDown: (event) => beginInteraction('resize', event),
          style: {
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: '22px',
            height: '22px',
            zIndex: 2,
            cursor: maximized ? 'default' : 'nwse-resize',
            touchAction: 'none',
            background: maximized
              ? 'transparent'
              : 'linear-gradient(135deg, transparent 52%, var(--dsw-alias-border-l2) 53%, var(--dsw-alias-border-l2) 62%, transparent 63%, transparent 72%, var(--dsw-alias-border-l2) 73%, var(--dsw-alias-border-l2) 82%, transparent 83%)'
          }
        })
      )
    }

    function headerButtonStyle() {
      return {
        height: '30px',
        padding: '0 10px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-button-elevated-fill)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer'
      }
    }

    const inject = ['slots']

    function apply(ctx) {
      // At the END of the Settings row (`order` 20: after the file browser's folder
      // glyph), not in `sidebar.footer.action` — that area belongs to whatever
      // panel registers there, and a footer action would sit above Settings in a
      // row of its own instead of beside it.
      ctx.slots.inject('sidebar.footer.trailing', () => ctx.slots.register({
        name: 'sidebar.footer.trailing',
        id: 'browser-desktop',
        order: 20,
        label: messages.browser
      }, BrowserGlyph))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'browser-desktop-overlay',
        order: 50,
        label: messages.browserDialog
      }, BrowserOverlay))
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  }
})
