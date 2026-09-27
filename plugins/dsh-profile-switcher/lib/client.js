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
    const ROUTE = '/api/dsh-profile-switcher'
    const MOBILE_QUERY = '(max-width: 720px)'
    const REDUCED_QUERY = '(prefers-reduced-motion: reduce)'
    const inject = ['slots']

    /** Small JSON client for the host half. */
    const call = async (action, body) => {
      const response = await fetch(`${ROUTE}/${action}`, body === undefined
        ? { headers: { accept: 'application/json' } }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const payload = await response.json().catch(() => ({}))
      if (response.ok !== true || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return payload
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
.dsh-ps__trigger{transition:background-color 120ms ease}
.dsh-ps__trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}
.dsh-ps__trigger:active,.dsh-ps__trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-active,#e8ebf0)}
.dsh-ps__trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:2px}
.dsh-ps__action{transition:background-color 120ms ease}
.dsh-ps__action:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.22))}
.dsh-ps__danger:not(:disabled):hover{background:rgba(220,90,90,.22)}
.dsh-ps__close{transition:background-color 120ms ease}
.dsh-ps__close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.22))}
.dsh-ps__close:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:2px}
`

    /** Install the stylesheet once, beside the tag dsh-mobile manages. */
    function installStyles(ctx) {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-profile-switcher'
      style.textContent = CSS
      document.head.append(style)
      return () => { if (style.isConnected) style.remove() }
    }

    const styles = (mobile) => ({
      wrap: { position: 'relative', display: 'flex', flex: '0 0 auto', minWidth: 0 },
      // Expanded sidebar AND rail: the icon alone, sized like dsh-mobile's own
      // footer control (the labelled version squeezed the footer row and got
      // truncated next to "Mobile access").
      trigger: {
        boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 36, height: 36, flex: '0 0 auto', margin: 0, padding: 0, border: 0,
        borderRadius: '50%', background: 'transparent', color: 'inherit', cursor: 'pointer',
      },
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
            position: 'fixed', width: 340, maxHeight: '70vh', overflowY: 'auto', padding: 12, borderRadius: 12,
            border: '1px solid rgba(127,127,127,.35)', zIndex: 2147483000, fontSize: 13,
            background: 'var(--dsw-alias-bg-layer-1, rgba(28,28,36,.99))',
            color: 'var(--dsw-alias-label-primary, inherit)',
            boxShadow: '0 18px 40px rgba(0,0,0,.5)',
          },
      backdrop: {
        position: 'fixed', inset: 0, zIndex: 2147482999, background: 'rgba(0,0,0,.45)',
        transition: 'opacity 200ms cubic-bezier(.2,.8,.2,1)',
      },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 2 },
      close: {
        flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: mobile ? 44 : 28, height: mobile ? 44 : 28, marginTop: mobile ? -6 : -4, marginRight: mobile ? -6 : -4,
        padding: 0, border: 0, borderRadius: 999, background: 'transparent', color: 'inherit',
        fontSize: mobile ? 20 : 15, lineHeight: 1, cursor: 'pointer', opacity: .75,
      },
      title: { fontWeight: 650, fontSize: mobile ? 17 : 13.5, marginBottom: 2 },
      subtitle: { opacity: .65, fontSize: mobile ? 13 : 12, marginBottom: 12, lineHeight: 1.4 },
      row: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        minHeight: mobile ? 56 : 0, padding: mobile ? '10px 12px' : '8px 10px',
        borderRadius: 10, background: 'rgba(127,127,127,.10)', marginBottom: 8,
      },
      name: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
      nameText: { fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: mobile ? 15 : 13 },
      meta: { opacity: .6, fontSize: mobile ? 12 : 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      actions: { display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' },
      action: {
        flex: '0 0 auto', padding: mobile ? '10px 14px' : '4px 10px', borderRadius: 999, cursor: 'pointer',
        font: 'inherit', fontSize: mobile ? 13 : 12, minHeight: mobile ? 44 : 0,
        border: '1px solid rgba(127,127,127,.4)', background: 'rgba(127,127,127,.12)', color: 'inherit',
      },
      danger: { borderColor: 'rgba(220,90,90,.5)', background: 'rgba(220,90,90,.12)' },
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
      if (profile.safeMode) return 'Safe Mode — stock bundles'
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
      const [elapsed, setElapsed] = React.useState(null)
      const [anchor, setAnchor] = React.useState(null)
      const buttonRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const closeTimer = React.useRef(null)

      const open = mounted

      const place = React.useCallback(() => {
        const rect = buttonRef.current?.getBoundingClientRect()
        if (rect === undefined || rect === null) return
        setAnchor({
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 348)),
          bottom: Math.max(8, window.innerHeight - rect.top + 8),
        })
      }, [])

      const refresh = React.useCallback(async () => {
        try {
          const data = await call('list')
          setProfiles(Array.isArray(data.profiles) ? data.profiles : [])
          setActive(typeof data.active === 'string' ? data.active : null)
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

      /** Confirm, apply, restart, then wait for the harness to come back. */
      const applyAndWait = async (action, body, label) => {
        if (!window.confirm(`Switch to “${label}” and restart the harness?\n\nThe interface disconnects for about 20 seconds. Sessions, settings and credentials are kept — only the plugin set changes.`)) return
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

      const rows = profiles.map((profile) => React.createElement('div', { key: profile.name, style: S.row },
        React.createElement('div', { style: S.name },
          React.createElement('span', { style: S.nameText }, profile.active ? `${profile.name} · current` : profile.name),
          React.createElement('span', { style: S.meta }, describe(profile))),
        React.createElement('div', { style: S.actions },
          profile.active
            ? React.createElement('span', { style: S.meta, title: 'the profile this harness booted' }, 'Current Profile')
            : React.createElement('button', {
                type: 'button',
                className: 'dsh-ps__action',
                style: { ...S.action, opacity: !profile.webCapable || busy ? .5 : 1 },
                disabled: !profile.webCapable || busy,
                onClick: () => void applyAndWait('select', { name: profile.name }, profile.name),
              }, 'Switch'),
          profile.locked
            ? React.createElement('span', { style: S.lock, title: 'default profile — the launcher falls back to it, so it cannot be deleted' }, '🔒 default')
            : (profile.deletable && !profile.active
                ? React.createElement('button', {
                    type: 'button',
                    className: 'dsh-ps__action dsh-ps__danger',
                    style: { ...S.action, ...S.danger, opacity: busy ? .5 : 1 },
                    disabled: busy,
                    title: `delete profiles/${profile.name}`,
                    onClick: () => void deleteProfile(profile),
                  }, 'Delete')
                : null))))

      const panelPosition = mobile || anchor === null ? {} : { left: anchor.left, bottom: anchor.bottom }
      const panelTransition = `opacity ${duration}ms cubic-bezier(.2,.8,.2,1), transform ${duration}ms cubic-bezier(.2,.8,.2,1)`
      const panelEnter = mobile
        ? { opacity: entered ? 1 : 0, transform: entered ? 'translateY(0)' : 'translateY(101%)' }
        : { opacity: entered ? 1 : 0, transform: entered ? 'none' : 'translateY(6px) scale(.97)' }

      return React.createElement('div', { style: S.wrap },
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
          React.createElement('span', { style: { fontSize: 18, lineHeight: 1, opacity: .85 } }, '◍')),
        mounted && mobile && React.createElement('div', {
          style: { ...S.backdrop, opacity: entered ? 1 : 0 },
          onClick: hide,
          'aria-hidden': true,
        }),
        mounted && React.createElement('div', {
          ref: panelRef,
          role: 'dialog',
          'aria-label': 'Available Profiles',
          style: { ...S.panel, ...panelPosition, ...panelEnter, transition: panelTransition },
        },
          mobile && React.createElement('div', { style: S.sheetGrabber }),
          React.createElement('div', { style: S.header },
            React.createElement('div', { style: S.title }, 'Available Profiles'),
            React.createElement('button', {
              type: 'button', className: 'dsh-ps__close', style: S.close, title: 'Close', 'aria-label': 'Close',
              onClick: hide,
            }, '✕')),
          React.createElement('div', { style: S.subtitle }, 'Switch to another Web-compatible Profile, create or delete one. Switching restarts the harness.'),
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
          React.createElement('button', {
            type: 'button',
            className: 'dsh-ps__action',
            style: { ...S.action, width: '100%', marginTop: 10, borderRadius: 10, minHeight: mobile ? 48 : 0, opacity: busy ? .5 : 1 },
            disabled: busy,
            onClick: () => void applyAndWait('safe', {}, 'Safe Mode'),
          }, 'Safe Mode — boot stock bundles only'),
          note !== null && React.createElement('div', {
            style: { ...S.note, color: 'var(--dsw-alias-label-secondary, inherit)' },
          }, elapsed === null ? note : `${note} (${elapsed}s)`)))
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
