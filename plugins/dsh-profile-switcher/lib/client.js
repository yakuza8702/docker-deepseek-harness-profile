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

/** Trash button whose word appears beside the icon only on hover/focus. */
function DeleteButton({ disabled, onDelete, name }) {
  return React.createElement('button', {
    type: 'button',
    className: 'dsh-ps__icon dsh-ps__dangerIcon',
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
        padding: 0, border: 0, borderRadius: 999, color: 'inherit',
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
       * Placement: KEEP THE CONTROL WHERE THE SLOT PUTS IT.
       *
       * An earlier version moved this React-owned node into the Settings row to sit
       * beside Settings. That crashed the whole slot entry
       * ("insertBefore … is not a child of this node") as soon as React re-rendered
       * the footer, taking the control off screen entirely — the node was moved
       * while React still owned its position, and the MutationObserver that was
       * meant to re-place it fired on its own mutations.
       *
       * The footer slot already renders directly above Settings, which is the
       * grouping the user asked for, so the honest fix is to leave the node alone.
       */
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
                    disabled: busy, name: profile.name, onDelete: () => void deleteProfile(profile),
                  })
                : null))))

      const panelPosition = mobile || anchor === null ? {} : { left: anchor.left, bottom: anchor.bottom }
      const panelTransition = `opacity ${duration}ms cubic-bezier(.2,.8,.2,1), transform ${duration}ms cubic-bezier(.2,.8,.2,1)`
      const panelEnter = mobile
        ? { opacity: entered ? 1 : 0, transform: entered ? 'translateY(0)' : 'translateY(101%)' }
        : { opacity: entered ? 1 : 0, transform: entered ? 'none' : 'translateY(6px) scale(.97)' }

      return React.createElement('div', { ref: wrapRef, style: S.wrap },
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
            React.createElement('path', { d: 'M3.3 13.3c.75-2.4 2.6-3.7 4.7-3.7s3.95 1.3 4.7 3.7' }))),
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
