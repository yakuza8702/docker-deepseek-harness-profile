/**
 * dsh-profile-switcher — browser half.
 *
 * One pill in `sidebar.footer.action` ("Optional actions beside Settings at the
 * sidebar foot"), showing the active profile. Opening it lists the profiles and
 * offers: switch, New Profile…, Delete (never for `web` — the launcher's
 * fallback), and Safe Mode. No menu bar.
 *
 * Layout follows `dsh-mobile`: the same `(max-width: 720px)` breakpoint, the same
 * 44px touch targets. Below it the popover becomes a bottom sheet, so the control
 * is usable on a phone; above it stays an anchored popover. The control is mounted
 * by the launcher for EVERY profile, so the mobile look is inherited everywhere.
 *
 * A switch is always a restart (a profile is a boot-time launcher input), so the
 * pill confirms, calls the host half, then waits for the harness to go down and
 * come back before reloading the page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-profile-switcher',
  factory: (require) => {
    const React = require('react')
    const ROUTE = '/api/dsh-profile-switcher'
    const MOBILE_QUERY = '(max-width: 720px)'
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

    /** dsh-mobile's breakpoint — one media query keeps both looking related. */
    function useMobile() {
      const query = React.useMemo(() => window.matchMedia(MOBILE_QUERY), [])
      const [mobile, setMobile] = React.useState(query.matches)
      React.useEffect(() => {
        const listener = (event) => setMobile(event.matches)
        query.addEventListener('change', listener)
        setMobile(query.matches)
        return () => query.removeEventListener('change', listener)
      }, [query])
      return mobile
    }

    const styles = (mobile) => ({
      wrap: { position: 'relative' },
      button: {
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        minHeight: mobile ? 48 : 32, padding: mobile ? '10px 12px' : '6px 10px',
        background: 'transparent', border: 0, borderRadius: 10, color: 'inherit',
        cursor: 'pointer', font: 'inherit', fontSize: mobile ? 15 : 13, textAlign: 'left',
      },
      panel: mobile
        ? {
            position: 'fixed', left: 8, right: 8, bottom: 'calc(8px + env(safe-area-inset-bottom, 0px))',
            maxHeight: '82dvh', overflowY: 'auto', padding: 16, borderRadius: 18, fontSize: 15,
            border: '1px solid rgba(127,127,127,.35)', zIndex: 2147483000,
            background: 'var(--dsw-alias-bg-layer-1, rgba(24,24,32,.99))',
            color: 'var(--dsw-alias-label-primary, inherit)',
            boxShadow: '0 18px 48px rgba(0,0,0,.55)',
            WebkitOverflowScrolling: 'touch',
          }
        : {
            position: 'fixed', width: 340, maxHeight: '70vh', overflowY: 'auto', padding: 12, borderRadius: 12,
            border: '1px solid rgba(127,127,127,.35)', zIndex: 2147483000, fontSize: 13,
            background: 'var(--dsw-alias-bg-layer-1, rgba(28,28,36,.99))',
            color: 'var(--dsw-alias-label-primary, inherit)',
            boxShadow: '0 18px 40px rgba(0,0,0,.5)',
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
      sheetGrabber: { width: 42, height: 4, borderRadius: 999, background: 'rgba(127,127,127,.45)', margin: '0 auto 10px' },
    })

    const describe = (profile) => {
      if (profile.bundles === null) return 'no package.json — not switchable'
      if (!profile.webCapable) return `${profile.bundleCount} bundles — not web-capable`
      const thirdParty = profile.bundleCount - 2
      if (profile.safeMode) return 'Safe Mode — stock bundles'
      return thirdParty > 0 ? `${profile.bundleCount} bundles (${thirdParty} added)` : 'stock (dsh-base + web-app)'
    }

    function ProfilePill() {
      const mobile = useMobile()
      const S = React.useMemo(() => styles(mobile), [mobile])
      const [open, setOpen] = React.useState(false)
      const [profiles, setProfiles] = React.useState([])
      const [active, setActive] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [elapsed, setElapsed] = React.useState(null)
      const buttonRef = React.useRef(null)
      const [anchor, setAnchor] = React.useState(null)

      /** Anchor the popover to the pill (desktop only; mobile uses the sheet). */
      const place = React.useCallback(() => {
        const rect = buttonRef.current?.getBoundingClientRect()
        if (rect === undefined || rect === null) return
        setAnchor({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 348)), bottom: Math.max(8, window.innerHeight - rect.top + 8) })
      }, [])

      React.useEffect(() => {
        if (!open || mobile) return undefined
        place()
        window.addEventListener('resize', place)
        return () => window.removeEventListener('resize', place)
      }, [open, mobile, place])

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

      /** Confirm, apply, restart, then wait for the harness to come back. */
      const applyAndWait = async (action, body, label) => {
        if (!window.confirm(`Switch to “${label}” and restart the harness?\n\nThe interface disconnects for about 20 seconds. Sessions, settings and credentials are kept — only the plugin set changes.`)) return
        setBusy(true)
        setNote(`switching to “${label}”…`)
        setElapsed(0)
        const started = Date.now()
        const ticker = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000)
        try {
          await call(action, body)          // selects (or creates + selects) the profile
          await call('restart', {})         // asks the harness to exit; the container policy reboots it
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
                style: { ...S.action, opacity: !profile.webCapable || busy ? .5 : 1 },
                disabled: !profile.webCapable || busy,
                onClick: () => void applyAndWait('select', { name: profile.name }, profile.name),
              }, 'Switch'),
          profile.locked
            ? React.createElement('span', { style: S.lock, title: 'default profile — the launcher falls back to it, so it cannot be deleted' }, '🔒 default')
            : (profile.deletable && !profile.active
                ? React.createElement('button', {
                    type: 'button',
                    style: { ...S.action, ...S.danger, opacity: busy ? .5 : 1 },
                    disabled: busy,
                    title: `delete profiles/${profile.name}`,
                    onClick: () => void deleteProfile(profile),
                  }, 'Delete')
                : null))))

      return React.createElement('div', { style: S.wrap },
        React.createElement('button', {
          type: 'button', ref: buttonRef, style: S.button,
          title: 'Profile — switch the plugin set this harness boots',
          onClick: () => { setOpen((value) => !value); if (!open) void refresh() },
        },
          React.createElement('span', { style: { opacity: .7 } }, '◍'),
          React.createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            `Profile: ${active ?? 'unknown'}`),
          React.createElement('span', { style: { opacity: .5, fontSize: 11 } }, open ? '▾' : '▸')),
        open && React.createElement('div', {
          style: mobile || anchor === null ? S.panel : { ...S.panel, left: anchor.left, bottom: anchor.bottom },
        },
          mobile && React.createElement('div', { style: S.sheetGrabber }),
          React.createElement('div', { style: S.title }, 'Available Profiles'),
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
              type: 'button', style: { ...S.action, opacity: draft.trim() === '' || busy ? .5 : 1 },
              disabled: draft.trim() === '' || busy, onClick: () => void createProfile(),
            }, '+ New Profile')),
          React.createElement('button', {
            type: 'button',
            style: { ...S.action, width: '100%', marginTop: 10, borderRadius: 10, minHeight: mobile ? 48 : 0, opacity: busy ? .5 : 1 },
            disabled: busy,
            onClick: () => void applyAndWait('safe', {}, 'Safe Mode'),
          }, 'Safe Mode — boot stock bundles only'),
          note !== null && React.createElement('div', {
            style: { ...S.note, color: 'var(--dsw-alias-label-secondary, inherit)' },
          }, elapsed === null ? note : `${note} (${elapsed}s)`)))
    }

    function apply(ctx) {
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
