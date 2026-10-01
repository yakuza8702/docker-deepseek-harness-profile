/**
 * dsh-profile-switcher — browser half.
 *
 * One pill in `sidebar.footer.action` ("Optional actions beside Settings at the
 * sidebar foot"), showing the active profile. Opening it lists the profiles and
 * offers: switch, New Profile…, Delete (never for `web` — the launcher's
 * fallback), and Safe Mode. No menu bar.
 *
 * Layout follows `dsh-mobile`:
 *   * the slot's own `wide` prop decides the trigger shape — the labelled pill in
 *     the expanded sidebar, a 36×36 round icon button when the sidebar is the
 *     rail (the same treatment `dsh-mobile` gives its own footer control);
 *   * the same `(max-width: 720px)` breakpoint switches the panel to a bottom
 *     sheet with 44px touch targets and safe-area padding;
 *   * open/close animate (the sheet slides, the popover fades), and everything
 *     collapses to no motion under `prefers-reduced-motion`.
 *
 * Closing: ✕ in the panel header, a click anywhere outside, Escape, or tapping
 * the backdrop of the sheet.
 *
 * The control is mounted by the launcher for EVERY profile, so the same trigger
 * and the same mobile behaviour appear everywhere.
 */
window.__ModuleLoader__.load({
  id: 'dsh-profile-switcher',
  factory: (require) => {
    const React = require('react')
    /**
     * The panel is rendered through a portal into <body>, and that is load-bearing,
     * not decoration: the sidebar carries a `transform`, which makes it the
     * containing block for every `position:fixed` descendant. The panel was
     * therefore positioned inside the SIDEBAR — on a phone that put the bottom
     * sheet at the off-canvas drawer's coordinates (x ≈ -300, 226px wide) instead
     * of across the screen. <body> has no transform, so fixed means the viewport
     * again. `react-dom` is part of the client module table; if a build ever lacks
     * it the panel still renders, just inline, exactly as before.
     */
    let createPortal = null
    try { createPortal = require('react-dom').createPortal } catch { createPortal = null }
    const ROUTE = '/api/dsh-profile-switcher'
    const MOBILE_QUERY = '(max-width: 720px)'
    const REDUCED_QUERY = '(prefers-reduced-motion: reduce)'
    const inject = ['slots']
    // The clone that sits beside Settings while the sidebar is expanded, and the
    // body class that takes the real (slot-rendered) control out of the flow.
    const INLINE_ID = 'dsh-ps-trigger-inline'
    const INLINE_CLASS = 'dsh-ps--beside-settings'

    /** Inline lucide icons (dsh-desktop's Recovery Mode / Safe Mode glyphs). */
    const ICONS = {
      recovery: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><path d="m4.9 4.9 4.2 4.2"/><path d="m19.1 4.9-4.2 4.2"/><path d="m4.9 19.1 4.2-4.2"/><path d="m19.1 19.1-4.2-4.2"/>',
      safeMode: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    }
    const iconSvg = (paths) => React.createElement('span', {
      style: { display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' },
      dangerouslySetInnerHTML: {
        __html: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`,
      },
    })

    /** Small JSON client for the host half. */
    const call = async (action, body) => {
      const response = await fetch(`${ROUTE}/${action}`, body === undefined
        ? { headers: { accept: 'application/json' } }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const payload = await response.json().catch(() => ({}))
      if (response.ok !== true || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return payload
    }

    /**
     * The recovery surface lives in the REVERSE PROXY, not in DSH, so it is the
     * one thing that still answers while the harness is down (and it needs no
     * token — the proxy serves it to any browser). `null` means "no answer", which
     * is not the same as "not broken".
     */
    const recoveryState = async () => {
      try {
        const response = await fetch('/__recovery/state', { headers: { accept: 'application/json' }, cache: 'no-store' })
        if (response.ok !== true) return null
        return await response.json()
      } catch {
        return null
      }
    }

    function useMedia(query) {
      const list = React.useMemo(() => window.matchMedia(query), [query])
      const [matches, setMatches] = React.useState(list.matches)
      React.useEffect(() => {
        const listener = (event) => setMatches(event.matches)
        list.addEventListener('change', listener)
        setMatches(list.matches)
        return () => list.removeEventListener('change', listener)
      }, [list])
      return matches
    }

    /**
     * Interactive states need CSS (`:hover`/`:active`/`:focus-visible` are not
     * expressible inline); layout stays inline. Colours come from the theme
     * variables dsh-mobile uses for its own footer control, so the pill sits in
     * the footer exactly like Settings and Mobile access do — in both the
     * expanded sidebar and the rail.
     */
    const CSS = `
/* Geometry and colours are copied from the shipped Settings trigger
   (.VOzbGW_trigger in this build): same radius variable, same label colour, and
   the SAME two theme variables for hover/active — deliberately with NO fallback
   literal, because a hard-coded light tint is what made the control glow in the
   dark theme. If a variable is missing the declaration resolves to nothing,
   which is still consistent with the surrounding UI. */
.dsh-ps__trigger{box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:0;
  width:36px;height:36px;flex:0 0 auto;margin:0;padding:0;border:none;border-radius:var(--dsw-radius-md,12px);
  background:none;color:var(--dsw-alias-label-primary,inherit);cursor:pointer;transition:background-color 120ms ease}
.dsh-ps__trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ps__trigger:active,.dsh-ps__trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-active)}
.dsh-ps__trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:2px}
/* Beside Settings (expanded sidebar only): the visible control is the plain DOM
   clone in the Settings trigger row — see the placement effect — while the real,
   slot-rendered control is taken out of the flow so the slot does not leave an
   empty row above Settings. Out of the FLOW, not merely hidden: an absolutely
   positioned child is no longer a flex item, so it adds no row and no gap. The
   !important is load-bearing — React owns the inline position:relative on that
   wrapper and would otherwise win over this rule. The clone keeps the same 36x36
   box, the same 12px radius and the same theme colours, so the two controls sit
   in one row exactly like the shipped footer controls do. */
body.dsh-ps--beside-settings .dsh-ps__wrap{position:absolute!important;left:-9999px;top:0;width:0;height:0;overflow:hidden}
body.dsh-ps--beside-settings .dsh-ps__trigger:not(.dsh-ps__inline){display:none}
.dsh-ps__inline{flex:0 0 auto;margin:0}
.dsh-ps__action{background:var(--dsw-alias-interactive-bg-hover);transition:background-color 120ms ease}
.dsh-ps__action:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-active)}
.dsh-ps__danger{border-color:var(--dsw-alias-state-error-primary,rgba(220,90,90,.5))}
.dsh-ps__close{transition:background-color 120ms ease}
.dsh-ps__close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ps__close:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:2px}
/* Square icon buttons in a row: trash, pencil and the reorder arrows. */
.dsh-ps__icon{display:flex;align-items:center;justify-content:center;gap:4px;flex:0 0 auto;
  min-width:30px;height:30px;padding:0 6px;border:1px solid transparent;border-radius:8px;
  background:none;color:inherit;font:inherit;font-size:12px;cursor:pointer;transition:background-color 120ms ease}
.dsh-ps__icon:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ps__icon:not(:disabled):active{background:var(--dsw-alias-interactive-bg-active)}
.dsh-ps__icon:disabled{cursor:not-allowed;opacity:.35}
.dsh-ps__icon:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:2px}
/* The delete word appears BESIDE the trash icon only while the button is hovered
   (or focused), which is what keeps the row quiet the rest of the time. */
.dsh-ps__delLabel{max-width:0;overflow:hidden;white-space:nowrap;opacity:0;transition:max-width 140ms ease,opacity 140ms ease}
.dsh-ps__icon:hover .dsh-ps__delLabel,.dsh-ps__icon:focus-visible .dsh-ps__delLabel{max-width:60px;opacity:1}
.dsh-ps__dangerIcon:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary,inherit)}
.dsh-ps__renameInput{box-sizing:border-box;width:100%;margin-top:6px;padding:6px 8px;border-radius:8px;font:inherit;font-size:13px;
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.45));background:var(--dsw-alias-bg-layer-2,transparent);color:inherit}
`

    /** Install the stylesheet once, beside the tag dsh-mobile manages. */
    function installStyles(ctx) {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-profile-switcher'
      style.textContent = CSS
      document.head.append(style)
      return () => { if (style.isConnected) style.remove() }
    }

/**
 * Icon set: plain stroke SVGs in `currentColor`, so they inherit the theme
 * (the same approach the shipped footer icons use).
 */
const Icon = (paths, size = 15) => React.createElement('svg', {
  'aria-hidden': true, focusable: false, width: size, height: size, viewBox: '0 0 16 16',
  fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
}, ...paths.map((d, index) => React.createElement('path', { key: index, d })))

const Icons = {
  // trash can: lid, body, two ribs
  trash: () => Icon(['M2.6 4.3h10.8', 'M6.3 4.3V3a1 1 0 0 1 1-1h1.4a1 1 0 0 1 1 1v1.3', 'M4.2 4.3l.6 8.2a1.2 1.2 0 0 0 1.2 1.1h4a1.2 1.2 0 0 0 1.2-1.1l.6-8.2', 'M6.7 6.9v4.4', 'M9.3 6.9v4.4']),
  // pencil: rename
  pencil: () => Icon(['M11.1 2.6a1.3 1.3 0 0 1 1.9 0l.4.4a1.3 1.3 0 0 1 0 1.9L5.9 12.4l-2.5.6.6-2.5 7.1-7.9Z', 'M10.2 3.6l2.2 2.2']),
  up: () => Icon(['M8 12.5V3.8', 'M4.4 7.4 8 3.8l3.6 3.6'], 14),
  down: () => Icon(['M8 3.5v8.7', 'M4.4 8.6 8 12.2l3.6-3.6'], 14),
}

/**
 * Trash button whose word appears beside the icon only on hover/focus.
 *
 * It takes the SAME action style as its neighbours (the row's other icon
 * buttons), which is what keeps it 44px on a phone: without it the trash was the
 * only 30px control in a row of 44px ones — visibly undersized and harder to hit.
 */
function DeleteButton({ disabled, onDelete, name, style }) {
  return React.createElement('button', {
    type: 'button',
    className: 'dsh-ps__icon dsh-ps__dangerIcon',
    style,
    disabled,
    title: `delete profiles/${name}`,
    'aria-label': `Delete ${name}`,
    onClick: onDelete,
  }, Icons.trash(), React.createElement('span', { className: 'dsh-ps__delLabel' }, 'Delete'))
}

    const styles = (mobile) => ({
      wrap: { position: 'relative', display: 'flex', flex: '0 0 auto', alignItems: 'center', justifyContent: 'center', minWidth: 0 },
      // Icon only, in the expanded sidebar AND the rail — the same shape and
      // hover highlight the shipped footer controls (Settings, and the Mobile
      // access trigger when installed) use. Its colours live in CSS below.
      trigger: {},  // geometry + colours: the injected stylesheet, copied from Settings
      triggerLabel: { minWidth: 0, flex: '1 1 auto', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' },
      panel: mobile
        ? {
            position: 'fixed', left: 8, right: 8, bottom: 'calc(8px + env(safe-area-inset-bottom, 0px))',
            maxHeight: '82dvh', overflowY: 'auto', padding: 16, borderRadius: 18, fontSize: 15,
            border: '1px solid rgba(127,127,127,.35)', zIndex: 2147483000,
            background: 'var(--dsw-alias-bg-layer-1, rgba(24,24,32,.99))',
            color: 'var(--dsw-alias-label-primary, inherit)',
            boxShadow: '0 18px 48px rgba(0,0,0,.55)', WebkitOverflowScrolling: 'touch',
          }
        : {
            // Wide enough that a name and its five buttons fit on one line: at the
            // old 340 the name column was ~110px, so every longer profile read
            // "web-plug…" on the desktop too. Keep PANEL_WIDTH in sync with the
            // clamp in place().
            position: 'fixed', width: 400, maxHeight: '70vh', overflowY: 'auto', padding: 12, borderRadius: 12,
            border: '1px solid rgba(127,127,127,.35)', zIndex: 2147483000, fontSize: 13,
            background: 'var(--dsw-alias-bg-layer-1, rgba(28,28,36,.99))',
            color: 'var(--dsw-alias-label-primary, inherit)',
            boxShadow: '0 18px 40px rgba(0,0,0,.5)',
          },
      backdrop: {
        position: 'fixed', inset: 0, zIndex: 2147482999, background: 'rgba(0,0,0,.45)',
        transition: 'opacity 200ms cubic-bezier(.2,.8,.2,1)',
      },
      /**
       * The header is sticky on the phone. The sheet scrolls, so without it the
       * title — and with it the ✕ — leaves the screen as soon as the list is longer
       * than the sheet (the reported "no way to see the top"). The negative top
       * margin/offsets are what make it stick flush to the sheet's edge while the
       * padding stays part of the panel.
       */
      header: mobile
        ? {
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 2,
            position: 'sticky', top: -16, zIndex: 3, margin: '-16px -16px 8px', padding: '16px 16px 8px',
            background: 'var(--dsw-alias-bg-layer-1, rgba(24,24,32,.99))',
          }
        : { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 2 },
      close: {
        flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: mobile ? 44 : 28, height: mobile ? 44 : 28, marginTop: mobile ? -6 : -4, marginRight: mobile ? -6 : -4,
        padding: 0, border: 0, borderRadius: 999, color: 'inherit',
        fontSize: mobile ? 20 : 15, lineHeight: 1, cursor: 'pointer', opacity: .75,
      },
      title: { fontWeight: 650, fontSize: mobile ? 17 : 13.5, marginBottom: 2 },
      subtitle: { opacity: .65, fontSize: mobile ? 13 : 12, marginBottom: 12, lineHeight: 1.4 },
      /**
       * On a phone the row is TWO lines: the name (and its meta line) get the full
       * width, the buttons sit under it. Sharing one line truncated every name to
       * "we…" and "BR…" — the name is the one thing the row has to communicate, so
       * it must not be the thing that loses the space.
       */
      row: {
        display: 'flex', flexDirection: mobile ? 'column' : 'row',
        alignItems: mobile ? 'stretch' : 'center', justifyContent: 'space-between', gap: 10,
        minHeight: mobile ? 0 : 0, padding: mobile ? '12px 14px' : '8px 10px',
        borderRadius: mobile ? 12 : 10, background: 'rgba(127,127,127,.10)', marginBottom: 8,
      },
      name: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, width: mobile ? '100%' : undefined },
      nameText: { fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: mobile ? 15 : 13 },
      meta: { opacity: .6, fontSize: mobile ? 12 : 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      actions: {
        display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto',
        flexWrap: mobile ? 'wrap' : 'nowrap', alignSelf: mobile ? 'flex-start' : undefined,
      },
      action: {
        flex: '0 0 auto', padding: mobile ? '10px 14px' : '4px 10px', borderRadius: 999, cursor: 'pointer',
        font: 'inherit', fontSize: mobile ? 13 : 12, minHeight: mobile ? 44 : 0,
        border: '1px solid rgba(127,127,127,.4)', color: 'inherit',
      },
      danger: { borderColor: 'rgba(220,90,90,.5)' },
      lock: { opacity: .55, fontSize: mobile ? 12 : 11, flex: '0 0 auto' },
      divider: { height: 1, background: 'rgba(127,127,127,.25)', margin: '12px 0' },
      input: {
        flex: 1, minWidth: 0, padding: mobile ? '10px 12px' : '5px 8px', borderRadius: 10, font: 'inherit',
        fontSize: mobile ? 15 : 12, minHeight: mobile ? 44 : 0,
        border: '1px solid rgba(127,127,127,.4)', background: 'rgba(127,127,127,.10)', color: 'inherit',
      },
      note: { marginTop: 10, fontSize: mobile ? 13 : 12, lineHeight: 1.45 },
      sheetGrabber: { width: 42, height: 4, borderRadius: 999, background: 'rgba(127,127,127,.45)', margin: '0 auto 12px' },
    })

    const describe = (profile) => {
      if (profile.bundles === null) return 'no package.json — not switchable'
      if (!profile.webCapable) return `${profile.bundleCount} bundles — not web-capable`
      const thirdParty = profile.bundleCount - 2
      return thirdParty > 0 ? `${profile.bundleCount} bundles (${thirdParty} added)` : 'stock (dsh-base + web-app)'
    }

    /** The slot hands `wide` down: false when the sidebar is the icon rail. */
    function ProfilePill({ wide = true }) {
      const mobile = useMedia(MOBILE_QUERY)
      const reduced = useMedia(REDUCED_QUERY)
      const S = React.useMemo(() => styles(mobile), [mobile])
      const duration = reduced ? 0 : (mobile ? 240 : 180)

      const [mounted, setMounted] = React.useState(false)
      const [entered, setEntered] = React.useState(false)
      const [profiles, setProfiles] = React.useState([])
      const [active, setActive] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [boot, setBoot] = React.useState(null)
      const [renaming, setRenaming] = React.useState(null)
      const [renameDraft, setRenameDraft] = React.useState('')
      const [elapsed, setElapsed] = React.useState(null)
      const [anchor, setAnchor] = React.useState(null)
      const buttonRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const wrapRef = React.useRef(null)
      const closeTimer = React.useRef(null)

      const open = mounted

      const place = React.useCallback(() => {
        // Measure whatever the user actually sees: beside Settings the real button
        // is out of the flow, so the panel hangs off the clone instead.
        const inline = document.getElementById(INLINE_ID)
        const target = inline !== null && inline.isConnected ? inline : buttonRef.current
        const rect = target?.getBoundingClientRect()
        if (rect === undefined || rect === null) return
        setAnchor({
          // 400 + 8px of breathing room: the panel's own width is PANEL-1 in styles().
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 408)),
          bottom: Math.max(8, window.innerHeight - rect.top + 8),
        })
      }, [])

      const refresh = React.useCallback(async () => {
        try {
          const data = await call('list')
          setProfiles(Array.isArray(data.profiles) ? data.profiles : [])
          setActive(typeof data.active === 'string' ? data.active : null)
          setBoot(data.boot ?? null)
          setNote(null)
        } catch (error) {
          setNote(`cannot read profiles: ${error.message}`)
        }
      }, [])

      React.useEffect(() => { void refresh() }, [refresh])

      const show = React.useCallback(() => {
        if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null }
        setMounted(true)
        void refresh()
        // Enter in two steps so the transition has a from-state to run out of.
        // rAF is the smooth path, but it is PAUSED in some renderers (an occluded
        // or non-composited window), so a timer guarantees the panel still opens
        // instead of sitting at opacity 0.
        const kick = () => setEntered(true)
        requestAnimationFrame(() => requestAnimationFrame(kick))
        setTimeout(kick, 60)
      }, [refresh])

      const hide = React.useCallback(() => {
        setEntered(false)
        closeTimer.current = setTimeout(() => { setMounted(false); closeTimer.current = null }, duration)
      }, [duration])

      React.useEffect(() => () => { if (closeTimer.current !== null) clearTimeout(closeTimer.current) }, [])

      // Outside click + Escape close, and the popover follows the trigger.
      React.useEffect(() => {
        if (!mounted) return undefined
        const onPointerDown = (event) => {
          const target = event.target
          if (panelRef.current?.contains(target) === true) return
          if (buttonRef.current?.contains(target) === true) return
          // The beside-Settings clone is a plain copy of the trigger, so it counts
          // as the trigger: without this every click on it would be an "outside"
          // click first and the panel would just close.
          if (document.getElementById(INLINE_ID)?.contains(target) === true) return
          hide()
        }
        const onKeyDown = (event) => { if (event.key === 'Escape') hide() }
        const onResize = () => { if (!mobile) place() }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        window.addEventListener('resize', onResize)
        if (!mobile) place()
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
          window.removeEventListener('resize', onResize)
        }
      }, [mounted, mobile, place, hide])

      /**
       * Sit BESIDE Settings while the sidebar is expanded — WITHOUT touching a
       * React-owned node.
       *
       * An earlier version MOVED this control's wrapper into the Settings row. It
       * looked right, and it was fatal: the node belongs to React, so the next
       * commit in `sidebar.footer.action` raised
       * "insertBefore … is not a child of this node" and the whole slot entry
       * disappeared (commit 7350968 removed it again).
       *
       * The safe way — the one the reference deployment's own Mobile Access
       * control uses — is a CLONE. This component keeps rendering exactly where
       * the slot put it, so React stays the only owner of that subtree; an inert,
       * imperatively-created copy of the trigger is what gets inserted into the
       * Settings trigger row. A plain DOM node cannot break a React commit, and
       * the real button stays the single source of truth: the copy only forwards
       * clicks to it and mirrors `aria-expanded` / `title` / `aria-label` back.
       *
       * Only while the sidebar is EXPANDED: in the rail the slot's own stacked
       * placement is already the correct layout, so nothing is cloned and nothing
       * is hidden there.
       */
      React.useEffect(() => {
        const TRIGGER = `.dsh-ps__trigger:not(#${INLINE_ID})`
        const ATTRS = ['aria-expanded', 'title', 'aria-label']
        let observed = null
        let attrs = null
        let scheduled = false

        /** Mirror the real trigger's live state onto the copy. */
        const sync = (from, to) => {
          for (const name of ATTRS) {
            const value = from.getAttribute(name)
            if (value !== null && to.getAttribute(name) !== value) to.setAttribute(name, value)
          }
        }

        const clearClone = () => {
          const clone = document.getElementById(INLINE_ID)
          if (clone !== null) clone.remove()
          if (attrs !== null) { attrs.disconnect(); attrs = null }
          observed = null
          document.body.classList.remove(INLINE_CLASS)
        }

        const place = () => {
          const orig = document.querySelector(TRIGGER)
          if (orig === null) { clearClone(); return }
          const foot = orig.closest('[class*="footArea"]')
          const row = foot === null ? null : foot.querySelector('[class*="settingsArea"] [class*="_triggerRow"]')
          // The footer is wide when the sidebar is expanded and ~a rail when it is
          // collapsed; the reference deployment's row only exists in the expanded
          // sidebar anyway, so both conditions agree.
          const expanded = foot !== null && foot.getBoundingClientRect().width > 120
          if (!expanded || row === null) { clearClone(); return }

          document.body.classList.add(INLINE_CLASS)
          let clone = document.getElementById(INLINE_ID)
          if (clone === null || clone.parentElement !== row) {
            if (clone !== null) clone.remove()
            clone = orig.cloneNode(true)
            clone.id = INLINE_ID
            clone.classList.add('dsh-ps__inline')
            clone.addEventListener('click', (event) => {
              event.preventDefault()
              event.stopPropagation()
              const live = document.querySelector(TRIGGER)
              if (live !== null) live.click()
            })
            row.insertBefore(clone, row.firstChild)
          }
          sync(orig, clone)
          // Re-bind when React replaces the real node (the slot may re-render it).
          if (observed !== orig) {
            if (attrs !== null) attrs.disconnect()
            attrs = new MutationObserver(() => {
              const live = document.querySelector(TRIGGER)
              const copy = document.getElementById(INLINE_ID)
              if (live !== null && copy !== null) sync(live, copy)
            })
            attrs.observe(orig, { attributes: true, attributeFilter: ATTRS })
            observed = orig
          }
        }

        // Both paths on purpose: the observer is the fast one, the interval is the
        // one that still works where animation frames are paused (an occluded
        // window) and after a collapse/expand animation that changes no children.
        const schedule = () => {
          if (scheduled) return
          scheduled = true
          const run = () => { if (!scheduled) return; scheduled = false; place() }
          requestAnimationFrame(run)
          window.setTimeout(run, 90)
        }
        place()
        const watcher = new MutationObserver(schedule)
        watcher.observe(document.body, { childList: true, subtree: true })
        window.addEventListener('resize', schedule)
        const ticker = window.setInterval(place, 700)
        return () => {
          watcher.disconnect()
          window.removeEventListener('resize', schedule)
          window.clearInterval(ticker)
          clearClone()
        }
      }, [])
      /** Confirm, apply, restart, then wait for the harness to come back. */
      const applyAndWait = async (action, body, label, confirmMessage) => {
        if (!window.confirm(confirmMessage ?? `Switch to “${label}” and restart the harness?\n\nThe interface disconnects for about 20 seconds. Sessions, settings and credentials are kept — only the plugin set changes.`)) return
        setBusy(true)
        setNote(`switching to “${label}”…`)
        setElapsed(0)
        const started = Date.now()
        const ticker = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000)
        try {
          await call(action, body)
          await call('restart', {})
          let down = false
          for (let attempt = 0; attempt < 180; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000))
            try {
              await call('list')
              if (down) {
                clearInterval(ticker)
                window.location.reload()
                return
              }
            } catch {
              if (!down) {
                down = true
                setNote(`harness restarting into “${label}”…`)
              }
            }
            if (!down && attempt >= 30) {
              setNote('the harness did not restart — the container needs `restart: unless-stopped` (or any supervisor) for a profile switch to take effect')
              break
            }
            /**
             * A profile that CANNOT boot never brings this page back: the user is
             * left staring at a dead UI with no idea that a reload would hand them
             * the diagnostics — while a switch to a WORKING profile reloads by
             * itself. Both directions have to behave the same way.
             *
             * The reverse proxy is the one thing still answering (it serves the
             * recovery surface), so ask IT whether the boot this switch started
             * has already failed, and navigate there when it has. This check is
             * deliberately independent of `down` above: the hand-off must not
             * depend on how the client happened to learn the harness went away.
             *
             * The floor is what keeps a NORMAL switch — which reports `starting`
             * for its whole restart — from being mistaken for a broken one.
             */
            const waited = Date.now() - started
            if (waited > 10000) {
              const state = await recoveryState()
              const broken = state !== null && state.ready !== true
                && (state.boot?.state === 'failed' || state.boot?.state === 'client-failed')
              if (broken) {
                clearInterval(ticker)
                setNote(`“${label}” did not boot — opening the recovery page…`)
                window.location.replace('/__recovery/page?from=switch')
                return
              }
              /**
               * Last resort, for a stack whose boot state never resolves (an older
               * image, or a container policy that does not reboot at all): nothing
               * has answered for 45s, so reload. A navigation taken WHILE the
               * harness is down is what serves the recovery page, and that page
               * reloads itself into the app as soon as the harness answers — so
               * the user is never left on a frozen tab.
               */
              if (down && waited > 45000) {
                clearInterval(ticker)
                setNote('the harness has not come back — reloading to the recovery page…')
                window.location.reload()
                return
              }
            }
          }
          clearInterval(ticker)
        } catch (error) {
          clearInterval(ticker)
          setNote(error.message)
        } finally {
          setBusy(false)
          setElapsed(null)
        }
      }

      const createProfile = async () => {
        const name = draft.trim()
        if (name === '') return
        setBusy(true)
        try {
          await call('create', { name, from: active ?? 'web' })
          setDraft('')
          await refresh()
          setNote(`created “${name}” from “${active ?? 'web'}” — switch to it when you are ready`)
        } catch (error) {
          setNote(error.message)
        } finally {
          setBusy(false)
        }
      }

      /** Cosmetic rename: only the label changes, never the profile directory. */
      const commitRename = async (profile) => {
        setBusy(true)
        try {
          const result = await call('rename', { name: profile.name, label: renameDraft })
          await refresh()
          setRenaming(null)
          setRenameDraft('')
          setNote(result.label === null
            ? `“${profile.name}” now shows its folder name again (the folder itself never changed)`
            : `“${profile.name}” is shown as “${result.label}” — the folder stays profiles/${profile.name}`)
        } catch (error) {
          setNote(error.message)
        } finally {
          setBusy(false)
        }
      }

      /** Reorder by one step: the sidecar order changes, the folders do not move. */
      const moveProfile = async (profile, direction) => {
        setBusy(true)
        try {
          await call('move', { name: profile.name, direction })
          await refresh()
        } catch (error) {
          setNote(error.message)
        } finally {
          setBusy(false)
        }
      }

      const deleteProfile = async (profile) => {
        if (!window.confirm(`Delete profile “${profile.name}”?\n\nIts plugin set (profiles/${profile.name}) is removed. Other profiles, sessions and settings are untouched.`)) return
        setBusy(true)
        try {
          await call('delete', { name: profile.name })
          await refresh()
          setNote(`deleted “${profile.name}”`)
        } catch (error) {
          setNote(error.message)
        } finally {
          setBusy(false)
        }
      }

      const rows = profiles.map((profile, index) => React.createElement('div', { key: profile.name, style: S.row },
        React.createElement('div', { style: S.name },
          React.createElement('span', { style: S.nameText },
            (profile.label ?? profile.name) + (profile.active ? ' · current' : '')),
          React.createElement('span', { style: S.meta },
            profile.label === null || profile.label === undefined
              ? describe(profile)
              : `${profile.name} — ${describe(profile)}`),
          renaming === profile.name && React.createElement('input', {
            className: 'dsh-ps__renameInput',
            autoFocus: true,
            value: renameDraft,
            placeholder: profile.name,
            disabled: busy,
            onChange: (event) => setRenameDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void commitRename(profile)
              if (event.key === 'Escape') { setRenaming(null); setRenameDraft('') }
            },
            onBlur: () => { /* committed by the Save button / Enter, so a stray click cannot rename */ },
          }),
          renaming === profile.name && React.createElement('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
            React.createElement('button', {
              type: 'button', className: 'dsh-ps__action',
              style: { ...S.action, opacity: busy ? .5 : 1 }, disabled: busy,
              onClick: () => void commitRename(profile),
            }, 'Save'),
            React.createElement('button', {
              type: 'button', className: 'dsh-ps__action',
              style: { ...S.action, opacity: busy ? .5 : 1 }, disabled: busy,
              onClick: () => { setRenaming(null); setRenameDraft('') },
            }, 'Cancel'))),
        React.createElement('div', { style: S.actions },
          profile.active
            ? React.createElement('span', { style: S.meta, title: 'the profile this harness booted' }, 'Current Profile')
            : React.createElement('button', {
                type: 'button',
                className: 'dsh-ps__action',
                style: { ...S.action, opacity: !profile.webCapable || busy ? .5 : 1 },
                disabled: !profile.webCapable || busy,
                onClick: () => void applyAndWait('select', { name: profile.name }, profile.label ?? profile.name),
              }, 'Switch'),
          React.createElement('button', {
            type: 'button', className: 'dsh-ps__icon', style: S.action,
            disabled: busy, title: `rename the label for ${profile.name} (the folder keeps its name)`,
            'aria-label': `Rename ${profile.name}`, onClick: () => { setRenaming(profile.name); setRenameDraft(profile.label ?? '') },
          }, Icons.pencil()),
          React.createElement('button', {
            type: 'button', className: 'dsh-ps__icon', style: S.action,
            disabled: busy || index === 0, title: 'move up', 'aria-label': `Move ${profile.name} up`,
            onClick: () => void moveProfile(profile, 'up'),
          }, Icons.up()),
          React.createElement('button', {
            type: 'button', className: 'dsh-ps__icon', style: S.action,
            disabled: busy || index === profiles.length - 1, title: 'move down', 'aria-label': `Move ${profile.name} down`,
            onClick: () => void moveProfile(profile, 'down'),
          }, Icons.down()),
          profile.locked
            ? React.createElement('span', { style: S.lock, title: 'default profile — the launcher falls back to it, so it cannot be deleted' }, '🔒')
            : (profile.deletable && !profile.active
                ? React.createElement(DeleteButton, {
                    disabled: busy, name: profile.name, style: S.action,
                    onDelete: () => void deleteProfile(profile),
                  })
                : null))))

      const panelPosition = mobile || anchor === null ? {} : { left: anchor.left, bottom: anchor.bottom }
      const panelTransition = `opacity ${duration}ms cubic-bezier(.2,.8,.2,1), transform ${duration}ms cubic-bezier(.2,.8,.2,1)`
      const panelEnter = mobile
        ? { opacity: entered ? 1 : 0, transform: entered ? 'translateY(0)' : 'translateY(101%)' }
        : { opacity: entered ? 1 : 0, transform: entered ? 'none' : 'translateY(6px) scale(.97)' }

      const trigger = React.createElement('div', { ref: wrapRef, className: 'dsh-ps__wrap', style: S.wrap },
        React.createElement('button', {
          type: 'button',
          ref: buttonRef,
          className: 'dsh-ps__trigger',
          style: S.trigger,
          title: `Profile: ${active ?? 'unknown'} — switch the plugin set this harness boots`,
          'aria-label': `Profile: ${active ?? 'unknown'}`,
          'aria-expanded': open,
          onClick: () => { if (open) hide(); else show() },
        },
          React.createElement('svg', {
            'aria-hidden': true, focusable: false, width: 18, height: 18, viewBox: '0 0 16 16',
            fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
          },
            React.createElement('circle', { cx: 8, cy: 5.4, r: 2.6 }),
            React.createElement('path', { d: 'M3.3 13.3c.75-2.4 2.6-3.7 4.7-3.7s3.95 1.3 4.7 3.7' }))))

      /**
       * The panel and the backdrop are SIBLINGS of the wrapper (not children: the
       * wrapper is taken out of the flow while the control sits beside Settings and
       * anything inside it would go with it), and they are portaled into <body> so
       * that `position:fixed` really means the viewport — the sidebar's transform
       * otherwise makes IT the containing block (see the note at createPortal).
       * Both are gated on `mounted`, so the exit animation still runs and the
       * portal disappears with it.
       */
      const overlay = React.createElement(React.Fragment, null,
        mobile && React.createElement('div', {
          style: { ...S.backdrop, opacity: entered ? 1 : 0 },
          onClick: hide,
          'aria-hidden': true,
        }),
        React.createElement('div', {
          ref: panelRef,
          role: 'dialog',
          'aria-label': 'Available Profiles',
          style: { ...S.panel, ...panelPosition, ...panelEnter, transition: panelTransition },
        },
          mobile && React.createElement('div', { style: S.sheetGrabber }),
          React.createElement('div', { style: S.header },
            React.createElement('div', { style: S.title }, 'Available Profiles'),
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 2, flex: '0 0 auto' } },
              React.createElement('button', {
                type: 'button', className: 'dsh-ps__close', style: { ...S.close, marginRight: 0 },
                title: 'Restart in Recovery Mode', 'aria-label': 'Restart in Recovery Mode', disabled: busy,
                onClick: () => {
                  if (!window.confirm('Restart in Recovery Mode?\n\nThis opens the recovery screen — the diagnostic assistant with plugin management, checkpoints, profiles, reset and a full diagnostic archive. It is served even while the harness is down, so nothing is lost by opening it.')) return
                  window.location.assign('/__recovery/page')
                },
              }, iconSvg(ICONS.recovery)),
              React.createElement('button', {
                type: 'button', className: 'dsh-ps__close', style: { ...S.close, marginRight: 0 },
                title: 'Enter Safe Mode', 'aria-label': 'Enter Safe Mode', disabled: busy,
                onClick: () => void applyAndWait('safe', {}, 'Safe Mode',
                  'Enter Safe Mode and restart the harness?\n\nThe harness will use a separate temporary data directory: existing Profiles, plugins, settings and conversations are not read or changed, and the temporary data is removed on the next restart. Only the official DeepSeek API key, if you saved one, is carried over.'),
              }, iconSvg(ICONS.safeMode)),
              React.createElement('button', {
                type: 'button', className: 'dsh-ps__close', style: S.close, title: 'Close', 'aria-label': 'Close',
                onClick: hide,
              }, '✕'))),
          React.createElement('div', { style: S.subtitle }, 'Switch to another Web-compatible Profile, create or delete one. Switching restarts the harness.'),
          boot !== null && boot.state === 'degraded' && React.createElement('div', {
            style: {
              marginBottom: 10, padding: '10px 12px', borderRadius: 10, fontSize: mobile ? 13 : 12, lineHeight: 1.45,
              border: '1px solid var(--dsw-alias-state-warn-primary, rgba(220,160,60,.5))',
              background: 'var(--dsw-alias-state-warn-tertiary, rgba(220,160,60,.12))',
            },
          },
            React.createElement('div', { style: { fontWeight: 650, marginBottom: 4 } }, 'This boot reported errors'),
            React.createElement('div', { style: { opacity: .85, overflowWrap: 'anywhere' } },
              boot.detail ?? boot.reason ?? 'see the container log'),
            React.createElement('div', { style: { opacity: .7, marginTop: 6 } },
              'Switching to another profile, or Safe Mode, restarts the harness without them.')),
          boot !== null && boot.state === 'failed' && React.createElement('div', {
            style: {
              marginBottom: 10, padding: '10px 12px', borderRadius: 10, fontSize: mobile ? 13 : 12, lineHeight: 1.45,
              border: '1px solid var(--dsw-alias-state-error-primary, rgba(220,90,90,.5))',
              background: 'rgba(220,90,90,.12)',
            },
          },
            React.createElement('div', { style: { fontWeight: 650, marginBottom: 4 } }, 'The last boot failed'),
            React.createElement('div', { style: { opacity: .85, overflowWrap: 'anywhere' } }, boot.reason ?? 'unknown reason'),
            boot.detail !== null && boot.detail !== undefined && React.createElement('div', { style: { opacity: .7, marginTop: 4, overflowWrap: 'anywhere' } }, boot.detail)),
          ...rows,
          React.createElement('div', { style: S.divider }),
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            React.createElement('input', {
              style: S.input, placeholder: 'new profile name', value: draft, disabled: busy,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') void createProfile() },
            }),
            React.createElement('button', {
              type: 'button', className: 'dsh-ps__action', style: { ...S.action, opacity: draft.trim() === '' || busy ? .5 : 1 },
              disabled: draft.trim() === '' || busy, onClick: () => void createProfile(),
            }, '+ New Profile')),
          note !== null && React.createElement('div', {
            style: { ...S.note, color: 'var(--dsw-alias-label-secondary, inherit)' },
          }, elapsed === null ? note : `${note} (${elapsed}s)`)))

      return React.createElement(React.Fragment, null,
        trigger,
        mounted && (createPortal === null ? overlay : createPortal(overlay, document.body)))
    }

    function apply(ctx) {
      ctx.effect(() => installStyles(ctx), 'dsh-profile-switcher: footer control stylesheet')
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'dsh-profile-switcher', order: 40, label: 'Profile' },
        ProfilePill,
      ))
    }

    // client-modules contract: `factory(require) -> exports`, memoized per bundle.
    // There is no `exports`/`module` in this scope — return the plugin object.
    return { inject, apply }
  },
})
