window.__ModuleLoader__.load({
  id: 'dsh-cua-vm',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    const PANEL_ID = 'personal-vm-cua'
    const T = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      secondary: 'var(--dsw-alias-label-secondary, #9aa3ad)',
      caption: 'var(--dsw-alias-label-caption, #8b949e)',
      error: 'var(--dsw-alias-state-error-primary, #f28b82)',
      line: 'var(--dsw-alias-border-l3, rgba(255,255,255,.14))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))',
      accent: 'var(--dsw-alias-interactive-bg-hover-accent, rgba(43,127,255,.12))',
      info: 'var(--dsw-alias-button-info-fill, #4d6bfe)',
      success: 'var(--dsw-alias-state-success-primary, #7ee787)',
      brand: 'var(--dsw-alias-brand-primary, #111)',
      onBrand: 'var(--dsw-alias-label-primary-inverted, #fff)',
      radiusSm: 'var(--dsw-radius-sm, 6px)',
      radiusLg: 'var(--dsw-radius-lg, 10px)',
      radiusXl: 'var(--dsw-radius-xl, 14px)'
    }
    const S = {
      page: { padding: '28px 24px 48px', display: 'grid', gap: 14, color: T.text, maxWidth: 1000, width: '100%', margin: '0 auto' },
      head: { display: 'grid', gap: 4 },
      title: { fontSize: 18, fontWeight: 600 },
      sub: { fontSize: 13, color: T.secondary },
      tabs: { display: 'flex', gap: 4 },
      tab: (on) => ({
        padding: '6px 10px', borderRadius: T.radiusSm, border: 'none', cursor: 'pointer',
        font: 'inherit', fontSize: 13, background: on ? T.hover : 'transparent',
        color: T.text, fontWeight: on ? 600 : 400
      }),
      card: { padding: '12px 14px', borderRadius: T.radiusLg, border: `1px solid ${T.line}`, display: 'grid', gap: 8 },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      button: {
        height: 28, padding: '0 10px', borderRadius: T.radiusSm, cursor: 'pointer', font: 'inherit',
        border: `0.5px solid ${T.line}`, background: 'transparent', color: T.text, fontSize: 12, fontWeight: 500
      },
      primary: { height: 28, padding: '0 12px', borderRadius: T.radiusSm, cursor: 'pointer', font: 'inherit', border: 'none', background: T.brand, color: T.onBrand, fontSize: 12, fontWeight: 600 },
      input: { padding: '6px 8px', borderRadius: T.radiusSm, border: `1px solid ${T.line}`, background: 'transparent', color: T.text, font: 'inherit', fontSize: 13 },
      muted: { fontSize: 12, color: T.secondary },
      badge: (ready) => ({
        fontSize: 11, padding: '1px 6px', borderRadius: 999,
        background: ready ? T.accent : T.hover, color: ready ? T.info : T.secondary
      }),
      pre: { margin: 0, padding: 8, borderRadius: T.radiusSm, background: T.hover, fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }
    }

    /** The UI never shows a semicolon: cua's messages use them and they read badly here. */
    function clean(text) {
      return String(text).replaceAll(';', ',')
    }

    /**
     * U1: THE SECRET STATE IS CLEARABLE.
     *
     * `setSecret` only ever ADDED a key (`{ ...current, [name]: password }`), so
     * a revealed password could not leave the component: "Hide password" flipped
     * the label and the value lived on. Returning a NEW object without the key
     * (never mutating the old one) is what makes the next render actually hide
     * it — React only re-renders on a new reference, which is why the delete has
     * to be part of the copy.
     *
     * Pure and exported (`module.exports.__test`) so a unit test can assert the
     * transition without a renderer.
     */
    function hideSecretEntry(current, name) {
      const next = { ...(current ?? {}) }
      delete next[name]
      return next
    }

    /**
     * U1: ...AND THE NOTE IS NOT A PASSWORD DISPLAY.
     *
     * The reveal note used to interpolate the password, so "hiding" left it in
     * the persistent banner. The reveal note no longer carries the value; this
     * helper is the belt for a note that DOES (one written by an older build, or
     * by a future regression): hide clears it instead of leaving it on screen.
     */
    function noteAfterHide(note, name, value) {
      if (typeof note !== 'string') return note
      if (typeof value !== 'string' || value === '' || !note.includes(value)) return note
      return `${name}: password hidden and removed from this page.`
    }

    async function api(path, body) {
      const response = await fetch(`/cua/${path}`, body === undefined
        ? { headers: { accept: 'application/json' } }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const payload = await response.json().catch(() => null)
      if (payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload
    }

    function Viewer({ name, hash, onClose }) {
      const [frames, setFrames] = useState(false)
      const [png, setPng] = useState(null)
      const [text, setText] = useState('')
      const [frameAt, setFrameAt] = useState(0)
      const [pos, setPos] = useState(null)
      const frameRef = React.useRef(null)

      const send = async (payload) => {
        try {
          // Pointer actions ride the same cua path the model uses, so a click
          // here cannot drift if the capture size ever differs from the
          // display. Typing and keys are position independent and stay on the
          // cheaper xdotool route.
          if (payload.kind === 'click') {
            await api('gui', { name, action: 'click', x: payload.x, y: payload.y, smooth: false })
          } else {
            await api('input', { name, ...payload })
          }
          setFrameAt(Date.now())
        } catch (error) {
          setPng(null)
        }
      }
      useEffect(() => {
        if (!frames) return undefined
        let alive = true
        const tick = async () => {
          try {
            const payload = await api('screenshot', { name })
            if (alive) setPng(payload.png)
          } catch { /* the next tick retries */ }
        }
        void tick()
        const timer = setInterval(() => { void tick() }, 1200)
        return () => { alive = false; clearInterval(timer) }
      }, [frames, name, frameAt])
      // FRAMES ONLY. A static PNG carries no cursor, so this view draws one at
      // the guest pointer. The video view deliberately draws nothing: the
      // viewer paints the real pointer itself, and a second marker there was
      // the "double mouse" report — one of them lagging on a 400 ms poll.
      // This is also how the upstream build behaves.
      useEffect(() => {
        if (!frames) { setPos(null); return undefined }
        let alive = true
        const tick = async () => {
          try {
            const p = await api('pointer', { name })
            // Keep the last good position: a busy or briefly unavailable guest
            // answers with width 0, which used to make the drawn cursor vanish.
            if (alive && p !== null && p.width > 0 && p.height > 0) setPos(p)
          } catch { /* the VM may be busy; the next tick retries */ }
        }
        void tick()
        const timer = setInterval(() => { void tick() }, 400)
        return () => { alive = false; clearInterval(timer) }
      }, [name, frames])

      return h('div', {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': `VM desktop ${name}`,
        style: {
          position: 'fixed', inset: 0, zIndex: 70,
          background: 'rgba(0,0,0,.72)', backdropFilter: 'blur(2px)',
          display: 'grid', gridTemplateRows: 'auto 1fr', gap: 10, padding: 16
        }
      },
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 8, color: T.text,
            padding: '8px 12px', borderRadius: T.radiusLg,
            background: 'var(--dsw-alias-bg-layer-1, #17181a)', border: `1px solid ${T.line}`
          }
        },
          h('div', { style: { fontWeight: 600 } }, `${name} — shared desktop`),
          h('div', { style: { ...S.muted, marginLeft: 'auto' } }, 'You and the model share this screen. Input from either side lands in the same session.'),
          // The numeric pointer is only meaningful next to a static frame: in
          // the video view the viewer renders the guest cursor itself.
          frames && pos !== null && h('div', { style: { ...S.muted, fontVariantNumeric: 'tabular-nums' } }, `pointer ${pos.x},${pos.y}`),
          h('button', {
            type: 'button',
            style: { ...S.button, background: frames ? T.hover : 'transparent', color: T.text },
            onClick: () => setFrames((on) => !on)
          }, frames ? 'Video view' : 'Frames (http)'),
          h('button', { type: 'button', style: { ...S.button, color: T.text }, onClick: onClose }, 'Close'),
          h('a', {
            href: `/vm/view/${name}/${hash}`,
            target: '_blank', rel: 'noopener',
            style: { ...S.button, display: 'inline-flex', alignItems: 'center', textDecoration: 'none', color: T.text }
          }, 'Open in new tab')
        ),
        frames
          ? h('div', { style: { display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 8, minHeight: 0 } },
              h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                h('input', {
                  value: text,
                  placeholder: 'type into the computer (a password, a login…)',
                  style: { ...S.input, flex: 1 },
                  onChange: (event) => setText(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') { void send({ kind: 'type', text }); setText('') }
                  }
                }),
                h('button', { type: 'button', style: S.button, onClick: () => { void send({ kind: 'type', text }); setText('') } }, 'Type'),
                h('button', { type: 'button', style: S.button, onClick: () => void send({ kind: 'key', key: 'Return' }) }, 'Enter'),
                h('button', { type: 'button', style: S.button, onClick: () => void send({ kind: 'key', key: 'Tab' }) }, 'Tab'),
                h('button', { type: 'button', style: S.button, onClick: () => void send({ kind: 'key', key: 'Escape' }) }, 'Esc')
              ),
              h('div', { style: { display: 'grid', placeItems: 'center', background: '#000', borderRadius: T.radiusLg, overflow: 'hidden', minHeight: 0 } },
                png === null
                  ? h('div', { style: { color: '#ddd', fontSize: 13 } }, 'Capturing the first frame…')
                  : h('div', { style: { position: 'relative', display: 'inline-block', maxWidth: '100%', maxHeight: '100%' } },
                      h('img', {
                        src: `data:image/png;base64,${png}`,
                        alt: `${name} screen`,
                        title: 'Click to click in the computer',
                        style: { display: 'block', maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', cursor: 'crosshair' },
                        onClick: (event) => {
                          const img = event.currentTarget
                          const rect = img.getBoundingClientRect()
                          const scale = img.naturalWidth / rect.width
                          void send({
                            kind: 'click',
                            x: Math.round((event.clientX - rect.left) * scale),
                            y: Math.round((event.clientY - rect.top) * scale)
                          })
                        }
                      }),
                      pos !== null && pos.width > 0 && h('div', {
                        'aria-hidden': true,
                        style: {
                          position: 'absolute', pointerEvents: 'none', left: `${(pos.x / pos.width) * 100}%`,
                          top: `${(pos.y / pos.height) * 100}%`, transform: 'translate(-2px,-2px)', width: 16, height: 16
                        }
                      }, h('svg', { width: 16, height: 16, viewBox: '0 0 16 16' },
                        h('path', { d: 'M2 1 L2 13 L5.5 9.8 L8 15 L10.2 14 L7.8 8.9 L12.5 8.4 Z', fill: '#fff', stroke: '#111', strokeWidth: 1 })))
                    )
              ),
              h('div', { style: S.muted }, 'Frames refresh every 1.2 s. Click the screen to click in the computer, type above to type.')
            )
          : h('iframe', {
              ref: frameRef,
              title: `${name} desktop`,
              src: `/vm/view/${name}/${hash}`,
              style: { width: '100%', height: '100%', border: 'none', borderRadius: T.radiusLg, background: '#000' },
              allow: 'clipboard-read; clipboard-write; fullscreen'
            }),
      )
    }

    function PersonalVmPage() {
      const [tab, setTab] = useState('computers')
      const [state, setState] = useState(null)
      const [note, setNote] = useState(null)
      const [showNew, setShowNew] = useState(false)
      // `gpu: null` is "not chosen yet": the supervisor then applies the host
      // default (virgl when DSH_CUA_VM_GPU enables it). Ticking the box says
      // yes, unticking it after that says no — an omitted value never means
      // "off", which is what made a GPU host create llvmpipe computers.
      const [draft, setDraft] = useState({
        name: '', kind: 'linux', cpu: 2, memory: 4, image: 'linux', gpu: null, diskGb: 20,
        android: false, rea: false, windowsVersion: '11', windowsIso: '', windowsKey: ''
      })
      const [pending, setPending] = useState(null)
      // F4: the wait needs a CLOCK. A shutdown can take the whole
      // shutdownTimeoutSec (120 s for a slow init), and a label that never
      // changes is indistinguishable from a hung panel — so while an action is
      // pending this ticks once a second and the label counts.
      const [, setWaitTick] = useState(0)
      const [exec, setExec] = useState(null)
      const [form, setForm] = useState(null)
      const [view, setView] = useState(null)
      const [metricFor, setMetricFor] = useState(null)
      const [secret, setSecret] = useState({})
      // B3/force-delete: the per-computer install status (serial tail + the
      // signals being watched) and the last PARTIAL delete, so the row can offer
      // "Force delete" instead of leaving the user with a stuck name.
      const [installInfo, setInstallInfo] = useState({})
      const [partial, setPartial] = useState(null)
      // U2: the per-computer clipboard form (the text to paste, the readout of
      // what the guest holds, and which direction is in flight).
      const [clip, setClip] = useState({})
      // U4: the measured C: free space per computer, refreshed at most once a
      // minute — the number Windows Update fails on, not the virtual disk size.
      const [freeSpace, setFreeSpace] = useState({})

      const load = useCallback(async () => {
        try {
          const payload = await api('state')
          setState(payload)
          setForm((current) => current ?? payload.config)
        } catch (error) {
          setNote(clean(error?.message ?? error))
        }
      }, [])

      // Refresh the VM gate cookie before the first viewer opens. The page may
      // have been loaded before a restart, in which case its cookie was minted
      // with the previous per-boot secret and every /vm/view call would 403.
      useEffect(() => { void fetch('/vm/gate', { credentials: 'same-origin' }).catch(() => {}) }, [])
      useEffect(() => { void load() }, [load])

      // While a machine is starting, poll so its row and its button catch up
      // without the user pressing Refresh.
      useEffect(() => {
        if (pending === null) return undefined
        const timer = setInterval(() => { void load() }, 4000)
        return () => clearInterval(timer)
      }, [pending, load])

      // F4: ...and tick once a second so the LABEL moves while that poll is in
      // flight. Polling alone updates the row every 4 s, which still reads as a
      // frozen button for the first seconds of a 120 s shutdown.
      useEffect(() => {
        if (pending === null) return undefined
        const timer = setInterval(() => setWaitTick((value) => value + 1), 1000)
        return () => clearInterval(timer)
      }, [pending])

      /**
       * B3: HOW THE USER KNOWS IT FINISHED.
       *
       * While a Windows computer installs, poll `windowsStatus` (not `state`) —
       * it answers the install sentence, the last serial lines, the elapsed
       * time and the two readiness signals, so the row shows Windows Setup
       * progressing instead of a bare phase. It is ONE small request with a
       * 5-line tail, and it stops the moment nothing is installing.
       */
      const installingNames = Object.entries(state?.vms ?? {})
        .filter(([, vm]) => vm?.kind === 'windows' && vm?.state === 'installing')
        .map(([name]) => name)
      const installingKey = installingNames.join(',')
      useEffect(() => {
        if (installingKey === '') return undefined
        let cancelled = false
        const refresh = async () => {
          for (const name of installingKey.split(',')) {
            try {
              const payload = await api('windowsStatus', { name, tail: 5 })
              if (cancelled) return
              setInstallInfo((current) => ({ ...current, [name]: payload }))
            } catch {
              // A status poll that fails (the supervisor restarted) must not
              // wipe the row: the last good answer stays on screen.
            }
          }
        }
        void refresh()
        const timer = setInterval(() => { void refresh() }, 5000)
        return () => { cancelled = true; clearInterval(timer) }
      }, [installingKey])

      /**
       * U4: THE FREE SPACE THAT IS ACTUALLY LEFT.
       *
       * `diskGb` is the virtual size the user asked for; it cannot say that the
       * reported computer had 6.8 GB left on a 64 GB disk. This asks the
       * supervisor (which reads `Get-PSDrive C` over the guest's SSH) ONCE A
       * MINUTE for each ready Windows computer: a 60 s beat is enough for a
       * number that moves in gigabytes, and it keeps an SSH round trip off the
       * 4 s action poll. A failure leaves the previous number in place rather
       * than blanking a row that is still ready.
       */
      const readyWindows = Object.entries(state?.vms ?? {})
        .filter(([, vm]) => vm?.kind === 'windows' && (vm?.state === 'ready' || vm?.state === 'running'))
        .map(([name]) => name)
      const freeKey = readyWindows.join(',')
      useEffect(() => {
        if (freeKey === '') return undefined
        let cancelled = false
        const refresh = async () => {
          for (const name of freeKey.split(',')) {
            try {
              const payload = await api('windowsFreeSpace', { name })
              if (cancelled) return
              setFreeSpace((current) => ({ ...current, [name]: payload }))
            } catch {
              // A probe that cannot answer must not wipe the last good number.
            }
          }
        }
        void refresh()
        const timer = setInterval(() => { void refresh() }, 60000)
        return () => { cancelled = true; clearInterval(timer) }
      }, [freeKey])

      /**
       * U2: PASTE TO THE GUEST.
       *
       * The text goes to the supervisor, which writes it to
       * C:\ProgramData\cua\clip.txt, runs the `cua-clip-set` task IN THE
       * INTERACTIVE SESSION (that is the only clipboard the user can see) and
       * reports the task's own Last Result. A refusal is printed as it came:
       * "the clipboard was NOT set" with the schtasks or scp reason, never a
       * cheerful "done" over a queue that never ran.
       */
      const pasteToGuest = async (name) => {
        const entry = clip[name] ?? {}
        setClip((current) => ({ ...current, [name]: { ...entry, busy: 'set', out: '' } }))
        try {
          const payload = await api('windowsClipboardSet', { name, text: entry.text ?? '' })
          setClip((current) => ({
            ...current,
            [name]: { ...(current[name] ?? {}), busy: null, out: payload.available === false
              ? `paste unavailable: ${payload.reason}`
              : clean(payload.detail ?? 'pasted') }
          }))
        } catch (error) {
          setClip((current) => ({ ...current, [name]: { ...(current[name] ?? {}), busy: null, out: clean(error?.message ?? error) } }))
        }
      }

      /** U2: READ THE GUEST'S CLIPBOARD into the readout (session 2). */
      const readGuestClipboard = async (name) => {
        const entry = clip[name] ?? {}
        setClip((current) => ({ ...current, [name]: { ...entry, busy: 'get', out: '' } }))
        try {
          const payload = await api('windowsClipboardGet', { name })
          setClip((current) => ({
            ...current,
            [name]: { ...(current[name] ?? {}), busy: null, out: payload.available === false
              ? `read unavailable: ${payload.reason}`
              : clean(`guest clipboard (${payload.chars} char(s)):\n${payload.text ?? ''}`) }
          }))
        } catch (error) {
          setClip((current) => ({ ...current, [name]: { ...(current[name] ?? {}), busy: null, out: clean(error?.message ?? error) } }))
        }
      }

      /**
       * FORCE DELETE: the escape hatch for a row the normal manifest could not
       * remove (a wedged `sb rm`, a QEMU that still holds its disk, a deleted
       * container whose row stayed behind). It kills the process tree FIRST and
       * then re-runs the same manifest with that truth, so the disk is only
       * unlinked once nothing holds it.
       */
      const forceDelete = async (name) => {
        const okToForce = window.confirm(`Force delete ${name}?\n\nThis kills the VM process and removes its disks even if the delete reported failures — the row, container/QEMU, swtpm, websockify, disks, ports and registry row are all removed.`)
        if (!okToForce) return
        setPending({ name, action: 'delete' })
        setNote(`Force deleting ${name}: killing the process first, then removing every item…`)
        try {
          const payload = await api('delete', { name, force: true })
          await load()
          setPartial(payload.complete === false ? { name, ...payload } : null)
          setInstallInfo((current) => {
            const next = { ...current }
            delete next[name]
            return next
          })
          setNote(payload.complete === false
            ? clean(`Force delete of ${name} still left: ${[
                (payload.kept ?? []).map((item) => `${item.target} (kept: ${item.reason})`).join(', '),
                (payload.failed ?? []).map((item) => `${item.target} (failed: ${item.detail})`).join(', ')
              ].filter(Boolean).join('; ') || (payload.detail ?? 'see the supervisor log')}`)
            : `Force deleted ${name}: process, disks, ports and registry row are gone.`)
        } catch (error) {
          setNote(clean(error?.message ?? error))
        } finally {
          setPending(null)
        }
      }

      const act = async (name, label, action, body) => {
        // F4: `at` is what the label counts from. A shutdown that ends in the
        // forced `quit` path answers with a `detail`, and a failure answers with
        // the supervisor's own sentence — BOTH are surfaced in the note, so the
        // row never goes quiet after a shutdown that did not do what it said.
        setPending({ name, action, at: Date.now() })
        setNote(label)
        try {
          const payload = await api(action, body)
          await load()
          setNote(payload?.mayBeTorn === true
            ? clean(`${name}: ${payload?.detail ?? `${action} finished`} Its restore point is marked mayBeTorn, so the next Start boots the disk instead of trusting it.`)
            : typeof payload?.detail === 'string' && payload.detail !== '' ? clean(`${name}: ${payload.detail}`) : null)
        } catch (error) {
          setNote(clean(error?.message ?? error))
        } finally {
          setPending(null)
        }
      }

      const create = async () => {
        const windows = draft.kind === 'windows'
        setPending({ name: draft.name, action: 'create' })
        setNote(windows
          ? `Creating ${draft.name} (Windows ${draft.windowsVersion})… QEMU starts the install at once with the ${draft.diskGb} GB disk and ${draft.memory} GB RAM you asked for, so this is tens of minutes. The computer lists as installing until SSH answers; the panel follows the serial log.`
          : `Creating ${draft.name}${draft.gpu === true ? ' with GPU' : ''}${draft.android ? ' + Android SDK' : ''}${draft.rea ? ' + REA' : ''}… the first start also provisions the guest (a minute or two).${draft.rea ? ' The REA kit adds several minutes for Node 22, rea-agents, a JDK, Ghidra and JADX.' : ''}`)
        try {
          await api('create', windows
            ? {
                name: draft.name,
                kind: 'windows',
                // B1: THE NUMBERS THE USER TYPED TRAVEL UNCHANGED. The panel used
                // to send `Math.max(6, draft.memory)` / `Math.max(64, draft.diskGb)`
                // — a silent clamp in the UI — so a computer created as 20 GB /
                // 4 GB was created as 64 GB / 6 GB and the row (correctly) showed
                // the 64 GB it had been given. The floor is a RECOMMENDATION the
                // supervisor warns about; only the supervisor fills a default for
                // a field the user did not touch.
                cpu: draft.cpu,
                memory: draft.memory,
                diskGb: draft.diskGb,
                // REA and Android are Linux-only and the tool refuses them; the
                // form cannot even offer them for a Windows computer.
                gpu: draft.gpu === null ? undefined : draft.gpu,
                windowsVersion: draft.windowsVersion,
                windowsIso: draft.windowsIso.trim() === '' ? undefined : draft.windowsIso.trim(),
                // S3: optional, for a licensed operator ISO. The pinned media
                // are EVALUATION images and ignore it.
                windowsKey: draft.windowsKey.trim() === '' ? undefined : draft.windowsKey.trim()
              }
            : {
                name: draft.name,
                kind: 'linux',
                cpu: draft.cpu,
                memory: draft.memory,
                image: draft.image,
                gpu: draft.gpu === null ? undefined : draft.gpu,
                diskGb: draft.diskGb,
                android: draft.android,
                rea: draft.rea
              })
          setShowNew(false)
          setDraft({
            name: '', kind: 'linux', cpu: 2, memory: 4, image: 'linux', gpu: null, diskGb: 20,
            android: false, rea: false, windowsVersion: '11', windowsIso: '', windowsKey: ''
          })
          await load()
          setNote(`${draft.name} is up.`)
        } catch (error) {
          setNote(clean(error?.message ?? error))
        } finally {
          setPending(null)
        }
      }

      /**
       * The generated Windows password, on demand. It never lands in a log.
       *
       * U1: THE NOTE IS NOT A PASSWORD DISPLAY. It used to interpolate the
       * password into the persistent note banner AND into the reveal row, and
       * "Hide password" only flipped the row's label: the secret stayed in
       * state and the password STAYED IN THE BANNER for as long as the note was
       * up. Now the note says only that the password was revealed (where it
       * lives, what it costs), and `hidePassword` is a real clear.
       */
      const revealPassword = async (name) => {
        try {
          const payload = await api('windowsPassword', { name })
          setNote(clean(`${name}: password revealed below (user "${payload.username}"). It is stored 0600 in the VM store, never in the registry — Hide password removes it from this page.`))
          setSecret((current) => ({ ...current, [name]: payload.password }))
        } catch (error) {
          setNote(clean(error?.message ?? error))
        }
      }

      /**
       * U1: HIDE IS A CLEAR, NOT A LABEL.
       *
       * `setSecret` had only one direction (reveal), so the secret stayed in the
       * component state for the rest of the session: the label said "Reveal
       * password" while the value lived on in memory, and any re-render that
       * consulted `secret[name]` printed it again. The two pure helpers below
       * are exported for the unit test (`module.exports.__test`), because the
       * defect was exactly that "hide" did not clear anything — a React test
       * would test the renderer, while a unit test of the STATE TRANSITION is
       * what names the bug.
       */
      const hidePassword = (name) => {
        const value = secret[name]
        setSecret((current) => hideSecretEntry(current, name))
        setNote((current) => noteAfterHide(current, name, value))
      }

      /** The measured space, so the shown line is the tool's own line. */
      const showSpace = async (name) => {
        try {
          const payload = await api('space', { name })
          setNote(clean(payload.warning ? `${payload.line} — ${payload.warning}` : payload.line))
        } catch (error) {
          setNote(clean(error?.message ?? error))
        }
      }

      /** Store cleanup: orphan checkpoints, restore temps, old shots, stale rows. */
      const cleanup = async () => {
        setPending({ name: '', action: 'gc' })
        try {
          const payload = await api('gc', {})
          await load()
          const reclaimed = (payload.orphans ?? []).filter((row) => row.action.startsWith('reclaim'))
          setNote(clean(payload.bytesFreed > 0 || reclaimed.length > 0
            ? `Cleaned ${(payload.bytesFreed / 1024 ** 2).toFixed(1)} MB: ${payload.checkpoints.length} checkpoint(s), ${payload.shots.length} screenshot(s), ${payload.views.length} viewer row(s), ${payload.ports.length} port row(s)${reclaimed.length > 0 ? `, ${reclaimed.length} orphaned computer(s) reclaimed` : ''}.`
            : 'Nothing to clean.'))
        } catch (error) {
          setNote(clean(error?.message ?? error))
        } finally {
          setPending(null)
        }
      }

      const run = async () => {
        if (exec === null || exec.cmd.trim() === '') return
        setExec({ ...exec, busy: true, out: '' })
        try {
          const payload = await api('exec', { name: exec.name, cmd: exec.cmd, timeout: 120 })
          setExec({ ...exec, busy: false, out: clean(`exit ${payload.exit}\n${payload.stdout}${payload.stderr ? `\n[stderr]\n${payload.stderr}` : ''}`) })
          await load()
        } catch (error) {
          setExec({ ...exec, busy: false, out: clean(error?.message ?? error) })
        }
      }

      const showVm = async (name) => {
        try {
          const payload = await api('view', { name })
          // A Windows computer has a console page, not a cua viewer: open it in a
          // tab (the relay serves a full page), and keep the frame viewer for the
          // Linux guests, where the input path is the cua one.
          if (payload.console === true) {
            // The relay serves noVNC at /vm/port/<name>/; its page is vnc.html
            // and it connects to the websocket the same prefix carries.
            window.open(`${payload.url}vnc.html?autoconnect=1&resize=scale&reconnect=1&path=websockify`, '_blank', 'noopener')
            return
          }
          setView({ name, hash: payload.hash ?? '' })
        } catch (error) {
          setNote(clean(`${error.message}. The guest desktop answers only while the computer is running.`))
        }
      }

      const metrics = async (name) => {
        try {
          const m = await api('metrics', { name })
          setMetricFor(name)
          setNote(`${name}: load ${m.load} · mem ${m.memUsedMb}/${m.memTotalMb} MB · disk ${m.diskUsed}/${m.diskSize} (${m.diskUsePct}) · ${m.cpus} vCPU`)
        } catch (error) {
          setNote(clean(error?.message ?? error))
        }
      }

      const savePolicy = async () => {
        try {
          const payload = await api('config', form)
          setForm(payload.config)
          setNote('Policy saved.')
          await load()
        } catch (error) {
          setNote(clean(error?.message ?? error))
        }
      }

      const field = (key, label, hint) => h('label', { style: { display: 'grid', gap: 4, fontSize: 13 } },
        h('span', { style: { fontWeight: 500 } }, label),
        h('input', {
          type: 'number', min: 0, value: form[key],
          onChange: (event) => setForm({ ...form, [key]: Number(event.target.value) }),
          style: S.input
        }),
        hint !== undefined && h('span', { style: S.muted }, hint)
      )

      if (state === null || form === null) {
        return h('div', { style: S.page }, h('div', { style: S.title }, 'Personal VM (CUA)'), h('div', { style: S.muted }, note ?? 'Loading…'))
      }

      const vms = Object.entries(state.vms ?? {})
      // The REA kit does not fit in a stock 20 GB disk (Ghidra alone unpacks to
      // ~1.4 GB and the JDK, JADX and Node pile on top), so the field floors at
      // 40 the moment the box is ticked — before the supervisor's own clamp has
      // to save the create.
      // The floor is a property of the workload: the REA kit needs 40 GB, a
      // Windows install RECOMMENDS 64 GB, a plain desktop is fine on 20.
      //
      // Windows is different on purpose: 64 GB is a recommendation, not a gate.
      // The input accepts less and the create carries a warning ("Windows Update
      // will run out of space"), because refusing a size the user typed is worse
      // than doing what they asked and saying what will happen.
      const diskFloorGb = draft.rea === true && draft.kind !== 'windows' ? 40 : 20

      return h('div', { style: S.page },
        h('div', { style: S.head },
          h('div', { style: S.title }, 'Personal VM (CUA)'),
          h('div', { style: S.sub }, 'Linux computers on KVM. The model builds inside them, and the disks live in /cua-vm, never in the workspace.')
        ),
        h('div', { style: S.tabs },
          h('button', { type: 'button', style: S.tab(tab === 'computers'), onClick: () => setTab('computers') }, 'Computers'),
          h('button', { type: 'button', style: S.tab(tab === 'policy'), onClick: () => setTab('policy') }, 'Policy')
        ),

        tab === 'computers' && h('div', { style: { display: 'grid', gap: 10 } },
          h('div', { style: { ...S.row, gap: 8 } },
            h('button', { type: 'button', style: S.button, onClick: () => setShowNew((open) => !open) }, showNew ? 'Cancel' : 'New computer'),
            h('button', { type: 'button', style: S.button, onClick: () => void load() }, 'Refresh'),
            // Store hygiene: orphan checkpoints (a full flattened disk each),
            // crashed restore temps, screenshots past retention, stale rows. It
            // is a button because the alternative is a store that fills up and a
            // user who has to read the supervisor log to find out why.
            h('button', { type: 'button', style: S.button, disabled: pending !== null, onClick: () => void cleanup() }, 'Clean up'),
            h('button', {
              type: 'button', style: S.button,
              onClick: async () => {
                try {
                  const payload = await api('doctor')
                  const caps = payload.hostCaps ?? {}
                  setNote(clean(`kvm ${caps.kvm} · render ${caps.renderNode} · virgl ${caps.virtioGpuGl ? 'yes' : 'no'} · docker ${caps.docker} · windows ${payload.windows?.enabled ? 'on' : 'off'} · store ${(payload.store?.usedBytes / 1024 ** 3).toFixed(1)} GB`))
                } catch (error) {
                  setNote(clean(error?.message ?? error))
                }
              }
            }, 'Doctor'),
            h('div', { style: { ...S.muted, marginLeft: 'auto' } }, `store ${(state.usedBytes / 1024 ** 3).toFixed(1)} GB`),
            h('div', { style: S.muted }, `${state.config.maxRunning} max running · ${state.config.autoSuspend ? `${state.config.idleSuspendMinutes} min idle` : 'no idle suspend'}`)
          ),
          showNew && h('div', { style: S.card },
            h('div', { style: { fontWeight: 600, fontSize: 13 } }, 'New computer'),
            h('input', {
              placeholder: 'name (a-z, 0-9, dashes)', value: draft.name, style: S.input,
              onChange: (event) => setDraft({ ...draft, name: event.target.value })
            }),
            // KIND FIRST: it decides which of the fields below exist at all. A
            // Windows computer has no image alias, no Android SDK and no REA kit
            // (the tool refuses them), so the form must not offer them.
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
              h('label', { style: { display: 'grid', gap: 4 } }, h('span', { style: S.muted }, 'Kind'),
                h('select', {
                  value: draft.kind, style: S.input,
                  onChange: (event) => setDraft({ ...draft, kind: event.target.value })
                },
                  h('option', { value: 'linux' }, 'Linux (Cua guest)'),
                  h('option', {
                    value: 'windows',
                    disabled: state.windows?.ok !== true
                  }, state.windows?.ok === true ? 'Windows (direct QEMU)' : 'Windows (unavailable — see Doctor)')
                )),
              draft.kind === 'linux'
                ? h('label', { style: { display: 'grid', gap: 4 } }, h('span', { style: S.muted }, 'Image'),
                    h('select', { value: draft.image, style: S.input, onChange: (event) => setDraft({ ...draft, image: event.target.value }) },
                      h('option', { value: 'linux' }, 'Ubuntu 24.04 slim (Cua disk)'),
                      h('option', { value: 'ghcr.io/trycua/linux:24.04' }, 'Ubuntu 24.04 full')
                    ))
                : h('label', { style: { display: 'grid', gap: 4 } }, h('span', { style: S.muted }, 'Windows version'),
                    h('select', {
                      value: draft.windowsVersion, style: S.input,
                      onChange: (event) => setDraft({ ...draft, windowsVersion: event.target.value })
                    },
                      h('option', { value: '11' }, 'Windows 11'),
                      // Pinned, probed public ISO (Microsoft's own Evaluation Center
                      // link resolves to it) — the only 11-family image that installs
                      // without an operator-supplied ISO.
                      h('option', { value: '11ltsc' }, 'Windows 11 IoT Enterprise LTSC 2024 (pinned ISO)'),
                      h('option', { value: '10' }, 'Windows 10'),
                      h('option', { value: 'ltsc10' }, 'Windows 10 LTSC'),
                      h('option', { value: '2022' }, 'Server 2022'),
                      h('option', { value: '2025' }, 'Server 2025 (pinned ISO)')
                    ))
            ),
            // The recommendation, stated where the number is typed — the create
            // itself no longer refuses a smaller disk.
            draft.kind === 'windows' && h('div', { style: { ...S.muted, fontSize: 12 } },
              `Recommended: 64 GB disk / 6 GB RAM / 2 vCPU. Below that the computer is still created, with a warning that Windows Update will run out of space.`),
            draft.kind === 'windows' && h('input', {
              placeholder: 'ISO: http(s) URL, or a path under the VM store (e.g. windows/11.iso) — optional',
              value: draft.windowsIso, style: S.input,
              onChange: (event) => setDraft({ ...draft, windowsIso: event.target.value })
            }),
            // S3: the pinned ISOs are EVALUATION media and need no key. This is
            // for a licensed operator ISO; empty means "no <ProductKey> block".
            draft.kind === 'windows' && h('input', {
              placeholder: 'Product key (optional; EVALUATION ISOs need none)',
              value: draft.windowsKey, style: S.input,
              onChange: (event) => setDraft({ ...draft, windowsKey: event.target.value })
            }),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 8, alignItems: 'end' } },
              h('label', { style: { display: 'grid', gap: 4 } }, h('span', { style: S.muted }, 'vCPU'),
                h('input', { type: 'number', min: 1, max: 8, value: draft.cpu, style: S.input, onChange: (event) => setDraft({ ...draft, cpu: Number(event.target.value) }) })),
              h('label', { style: { display: 'grid', gap: 4 } }, h('span', { style: S.muted }, 'RAM (GB)'),
                h('input', { type: 'number', min: 1, max: 32, value: draft.memory, style: S.input, onChange: (event) => setDraft({ ...draft, memory: Number(event.target.value) }) })),
              h('label', { style: { display: 'grid', gap: 4 } }, h('span', { style: S.muted }, 'Disk (GB)'),
                h('input', {
                  type: 'number', min: diskFloorGb, max: 200, step: 10, value: draft.diskGb, style: S.input,
                  onChange: (event) => setDraft({ ...draft, diskGb: Math.max(diskFloorGb, Number(event.target.value)) })
                })),
              h('div', { style: { display: 'grid', gap: 4, paddingBottom: 2 } },
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 } },
                  h('input', {
                    type: 'checkbox', checked: draft.gpu === true,
                    onChange: (event) => setDraft({ ...draft, gpu: event.target.checked })
                  }),
                  'Enable GPU'
                ),
                draft.kind === 'linux' && h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 } },
                  h('input', {
                    type: 'checkbox', checked: draft.android === true,
                    onChange: (event) => setDraft({ ...draft, android: event.target.checked })
                  }),
                  'Install Android'
                ),
                draft.kind === 'linux' && h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 } },
                  h('input', {
                    type: 'checkbox', checked: draft.rea === true,
                    // Ticking REA raises the disk with it: the kit is ~3.5 GB
                    // installed and Ghidra refuses to unpack on a full volume.
                    onChange: (event) => setDraft({ ...draft, rea: event.target.checked, diskGb: event.target.checked ? Math.max(40, draft.diskGb) : draft.diskGb })
                  }),
                  'Enable REA'
                )
              )
            ),
            draft.kind === 'linux'
              ? h('div', { style: S.muted }, 'Provisioning is automatic on the first start: Xorg on virgl + OpenGL 4.3 + render/KVM access + a 1200x750 desktop + the workspace share (Enable GPU), and the official Android SDK with an AVD inside the VM (Install Android, ~7 GB, needs a 40 GB disk and a GPU computer). Enable REA adds Node 22, rea-agents, a JDK 21, Ghidra 12.1.4 and JADX to the computer, roughly 3.5 GB installed, and lifts the disk to at least a 40 GB one. Debian and Arch are not Cua disks yet: build one with `cua images build` and paste its reference into the image field. Leaving Enable GPU unticked uses the host default (virgl when this host can do it).')
              : h('div', { style: S.muted }, 'Windows is a DIRECT QEMU computer (OVMF firmware, a swtpm TPM2, a qcow2 disk under the VM store) — there is no container runtime. It needs /dev/kvm and compose.windows.yaml for the devices (DSH_CUA_VM_WINDOWS=1). The recommended floor is 64 GB disk and 6 GB RAM: create below it anyway, and the computer carries a warning that Windows Update will run out of space. The install takes tens of minutes and lists as installing until SSH answers AND QMP says running. Once ready: exec/put/get work over SSH, the desktop is cua_vm_gui over QMP, and the live view at /vm/port/<name>/ is a noVNC stream a human can drive. It cannot take REA or Android, and the disk does not grow. Its password is generated and shown with Reveal — stored 0600 in the VM store, never in the registry.'),
            // A SPARSE DISK OVER THE POLICY IS CREATED, NOT REFUSED: this is advice,
            // not a block (the supervisor sends warnings[code: disk-over-policy]).
            draft.rea === true && form.diskQuotaGb < Math.max(40, draft.diskGb) && h('div', { style: { ...S.muted, color: T.error } },
              `The VM store quota is ${form.diskQuotaGb} GB. The ${Math.max(40, draft.diskGb)} GB REA disk is created anyway (it is sparse), but the guest will hit the real disk ceiling — raise Disk Size in the Policy tab first.`),
            h('div', { style: S.row },
              h('button', { type: 'button', style: S.primary, disabled: pending !== null || draft.name.trim() === '', onClick: () => void create() }, pending?.action === 'create' ? 'Creating…' : 'Create computer')
            )
          ),

          vms.length === 0
            ? h('div', { style: S.card }, h('div', { style: { fontWeight: 600, fontSize: 13 } }, 'No computer yet'),
                h('div', { style: S.muted }, 'Create one above, or ask the model — it asks you for a name, a spec and an image first.'))
            : vms.map(([name, vm]) => {
              // cua reports a freshly booted QEMU VM as `running`; a resumed one
              // as `ready`. Both mean "the Shutdown button belongs here".
              const ready = vm.state === 'ready' || vm.state === 'running'
              const installing = vm.state === 'installing'
              const failed = vm.state === 'error'
              const windows = vm.kind === 'windows'
              const busy = pending?.name === name
              // B3: the live install picture. The ROW is the source of truth for
              // the spec, the polled payload for the progress sentence + tail.
              const info = installInfo[name] ?? null
              const installDetail = (info?.installDetail ?? vm.installDetail) ?? null
              const serialTail = Array.isArray(info?.serialTail) ? info.serialTail : (Array.isArray(vm.serialTail) ? vm.serialTail : [])
              const readiness = info?.readiness ?? vm.readiness ?? null
              const elapsed = Number.isFinite(Number(info?.elapsedMinutes)) ? Number(info.elapsedMinutes) : null
              // B1: THE REQUESTED SPEC. The row stores what the user asked for,
              // so a Windows computer shows its own 20 GB / 4 GB instead of the
              // recommendation. `?` means the row predates the field.
              // U4: THE MEASURED FREE SPACE IS PART OF THE SPEC LINE. `diskGb`
              // is the VIRTUAL size; the reported computer had 6.8 GB free on a
              // 64 GB disk, which is the state Windows Update fails in. The
              // number comes from the guest (Get-PSDrive, throttled 60 s) and
              // the below-floor warning is shown next to it, not tooltip'd away.
              const space = windows ? freeSpace[name] ?? null : null
              const specLine = windows
                ? `${vm.cpu ?? '?'} vCPU · ${vm.memory ?? '?'} GB · Windows ${vm.windowsVersion || 'ISO'}${space?.available === true && typeof space.line === 'string' ? ` · ${space.line}` : ''}`
                : `${vm.cpu ?? '?'} vCPU · ${vm.memory ?? '?'} GB · ${vm.image ?? 'linux'}`
              // A stuck install (installing with no live QEMU) cannot be deleted
              // by the normal path — the panel says so and offers the force.
              // `info.stuck` is the supervisor's own verdict (row says
              // installing, no QEMU process), so the copy cannot drift from it.
              const stuck = windows && installing && (info?.stuck === true
                || (info !== null && (info.state === 'stopped' || info.state === 'powered-off' || info.detail === 'no QEMU process')))
              const partialFor = partial !== null && partial.name === name ? partial : null
              // F4: THE WAIT IS VISIBLE. The elapsed seconds come from `at`
              // (set by `act`) and `waitTick` re-renders the label every second
              // while the 4 s `load()` poll refreshes the row underneath it.
              const waitedSec = pending?.at
                ? Math.max(0, Math.round((Date.now() - pending.at) / 1000))
                : 0
              const withWait = (text) => (waitedSec > 0 ? `${text} ${waitedSec}s` : text)
              const busyLabel = pending?.action === 'start' ? withWait('Starting…')
                : pending?.action === 'shutdown' ? withWait('Shutting down…')
                  : pending?.action === 'suspend' ? withWait('Suspending…')
                    : pending?.action === 'delete' ? withWait('Deleting…') : null
              const stateBadge = failed
                ? { ...S.badge(false), color: T.error, border: `1px solid ${T.line}`, background: 'rgba(242, 139, 130, .12)' }
                : installing
                  ? { ...S.badge(false), color: T.info, border: `1px solid ${T.line}`, background: 'rgba(77, 107, 254, .12)' }
                  : S.badge(ready)
              return h('div', { key: name, style: S.card },
                h('div', { style: S.row },
                  h('span', { style: { fontWeight: 600, fontSize: 13 } }, name),
                  h('span', { style: stateBadge }, vm.state ?? 'unknown'),
                  h('span', { style: { ...S.badge(false), color: T.caption } }, windows ? 'Windows' : 'Linux'),
                  vm.gpu === true && h('span', { style: { ...S.badge(false), color: T.info } }, 'GPU'),
                  vm.android === true && h('span', { style: { ...S.badge(false), color: T.success, border: `1px solid ${T.line}`, background: 'rgba(126, 231, 135, .14)' } }, 'Android'),
                  vm.rea === true && h('span', { style: { ...S.badge(false), color: T.info, border: `1px solid ${T.line}`, background: 'rgba(138, 180, 255, .14)' } }, 'REA'),
                  vm.diskGb > 0 && h('span', { style: { ...S.badge(false), color: T.caption } }, `${vm.diskGb} GB`),
                  h('span', { style: { ...S.muted, marginLeft: 'auto' } }, specLine)
                ),
                h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  ready === false && h('button', {
                    type: 'button', style: S.button, disabled: busy || installing,
                    onClick: () => void act(name, `Starting ${name}…`, 'start', { name })
                  }, busy && busyLabel !== null ? busyLabel : installing ? 'Installing…' : 'Start'),
                  // SHUTDOWN and SUSPEND are different promises. Shutdown is the
                  // real ACPI power-off (checkpoint, sandbox removed, Start cold
                  // boots); suspend keeps the sandbox and resumes instantly. A
                  // A Windows computer only has the live view.
                  //
                  // F4: AN INSTALLING WINDOWS ROW GETS BOTH BUTTONS, WITH A
                  // CONFIRM THAT SAYS WHAT IT COSTS. Hiding them left the user
                  // with no way out of a 40-minute install except Force delete,
                  // and a silent "Shutting down…" hid that the supervisor was
                  // waiting on this exact window. The confirm is the honest part:
                  // there is no ACPI handler in Setup, so Shutdown aborts the
                  // install (the backend sends a short powerdown window then
                  // `quit` and marks the disk mayBeTorn); Suspend pauses the
                  // machine and Start continues it.
                  (ready || (windows && installing)) && h('button', {
                    type: 'button', style: S.button, disabled: busy,
                    onClick: () => {
                      const question = windows && installing
                        ? `Shut ${name} down?\n\nTHIS ABORTS THE WINDOWS INSTALL. Setup has no ACPI handler, so it will be stopped (a short window, then a forced quit) and its half-written disk marked mayBeTorn — Start will NOT resume Setup, and you will have to create the computer again.`
                        : `Do you want to shutdown ${name}? Its disk is checkpointed and Start boots it again.`
                      if (!window.confirm(question)) return
                      void act(name, `Shutting down ${name}… this can take up to ${state?.config?.shutdownTimeoutSec ?? 120} s (ACPI, then a forced quit).`, 'shutdown', { name })
                    }
                  }, busy && busyLabel !== null ? busyLabel : 'Shutdown'),
                  // Both kinds can be suspended: `cua sb suspend` on Linux,
                  // QMP stop on Windows (the tool says which).
                  (ready || (windows && installing)) && h('button', {
                    type: 'button', style: S.button, disabled: busy,
                    onClick: () => {
                      if (windows && installing
                        && !window.confirm(`Suspend ${name}? Mid-install this PAUSES Windows Setup: the machine keeps its RAM and Start continues where it stopped, but the install does not finish while it is paused (the install deadline keeps running).`)) return
                      void act(name, `Suspending ${name}…`, 'suspend', { name })
                    }
                  }, busy && busyLabel !== null ? busyLabel : 'Suspend'),
                  h('button', { type: 'button', style: S.button, onClick: () => void showVm(name) }, 'Show VM'),
                  // U1: ONE BUTTON, TWO DIRECTIONS. The label follows the
                  // state, so the click has to follow it too: it used to say
                  // "Hide password" and still call revealPassword.
                  windows && h('button', {
                    type: 'button', style: S.button,
                    onClick: () => (secret[name] ? hidePassword(name) : void revealPassword(name))
                  }, secret[name] ? 'Hide password' : 'Reveal password'),
                  // U3: NOT A TERMINAL — SAY SO. This button opens a ONE-SHOT
                  // command form: a command line, Run, and the captured output.
                  // There is no pty, no job control, no `cd` that survives the
                  // call, and no interactive prompt (the Windows side runs it
                  // through sshd in Session 0, the Linux side through `sb exec`).
                  // Labelling it "Terminal" promised a shell the panel does not
                  // have; adding a real pty is not trivial (it needs a
                  // bidirectional stream and a resize path on both backends), so
                  // the honest fix is the label.
                  h('button', {
                    type: 'button',
                    title: 'Runs ONE command and shows its output. Not an interactive terminal: there is no pty, no prompt and no persistent working directory.',
                    style: { ...S.button, background: exec !== null && exec.name === name ? T.hover : 'transparent' },
                    onClick: () => setExec((current) => (current !== null && current.name === name ? null : { name, cmd: '', out: '', busy: false }))
                  }, 'Run command'),
                  windows === false && h('button', {
                    type: 'button',
                    style: { ...S.button, background: metricFor === name ? T.hover : 'transparent' },
                    onClick: () => {
                      if (metricFor === name) { setMetricFor(null); setNote(null); return }
                      void metrics(name)
                    }
                  }, 'Metrics'),
                  // The measured coordinate space, printed by the same code the
                  // tool uses. It is the one number a click depends on.
                  h('button', { type: 'button', style: S.button, onClick: () => void showSpace(name) }, 'Space'),
                  h('button', {
                    type: 'button', style: { ...S.button, color: T.error },
                    onClick: () => {
                      if (!window.confirm(`Delete ${name}? Its disk, checkpoints, screenshots and port rows go with it.${windows ? ' A Windows computer also has a QEMU process and a TPM: if either still holds the disk, use Force delete.' : ''}`)) return
                      void (async () => {
                        try {
                          const payload = await api('delete', { name })
                          await load()
                          // A partial manifest is not a deletion: say which
                          // items survived (usually a disk kept because QEMU
                          // still holds it) instead of reporting success, and
                          // keep it so the row can offer Force delete.
                          setPartial(payload.complete === false ? { name, ...payload } : null)
                          const kept = (payload.kept ?? []).map((item) => item.target)
                          const failedItems = (payload.failed ?? []).map((item) => item.target)
                          setNote(payload.complete === false
                            ? clean(`Partially deleted ${name} — ${[
                                kept.length > 0 ? `disk kept: ${kept.join(', ')} (run Clean up to reclaim once the process is gone)` : '',
                                failedItems.length > 0 ? `failed: ${failedItems.join(', ')}` : '',
                                kept.length === 0 && failedItems.length === 0 ? (payload.detail ?? 'see the supervisor log') : ''
                              ].filter(Boolean).join('; ')}. Use Force delete to kill the process and remove what is left.`)
                            : `Deleted ${name}.`)
                        } catch (error) {
                          setNote(clean(error?.message ?? error))
                        }
                      })()
                    }
                  }, busy && busyLabel !== null ? busyLabel : 'Delete'),
                  // FORCE DELETE: shown after a partial delete, on a stuck
                  // Windows install, or always for Windows (its QEMU/TPM can
                  // hold the disk in ways a Linux guest cannot).
                  (partialFor !== null || stuck || windows) && h('button', {
                    type: 'button',
                    style: { ...S.button, color: T.error, border: `1px solid ${T.error}` },
                    disabled: busy,
                    onClick: () => void forceDelete(name)
                  }, 'Force delete')
                ),
                secret[name] && h('div', { style: { ...S.muted, fontFamily: 'ui-monospace, monospace' } },
                  `user "cua" password "${secret[name]}" (also in $STORE/windows/${name}/credentials.json, mode 0600)`),
                // U4: THE DISK IS NOT THE FREE SPACE. A below-floor number is
                // printed in the error colour with the remedy, because "the
                // install failed" with 6.8 GB left is a different problem from
                // "the install failed" with 40 GB left.
                space?.available === true && space.belowFloor === true && h('div', { style: { ...S.muted, color: T.error } },
                  clean(space.warning ?? `only ${space.line}`)),
                space?.available === false && h('div', { style: S.muted },
                  clean(`free space unavailable: ${space.reason ?? 'the guest did not answer'}`)),
                // U2: THE CLIPBOARD, WHERE IT ACTUALLY WORKS.
                //
                // A Windows guest has no clipboard agent, so the noVNC paste box
                // (which rides RFB ClientCutText) delivers nothing, and
                // Set-Clipboard over SSH writes Session 0's clipboard, which the
                // user never sees. These two buttons drive on-demand tasks that
                // run IN THE INTERACTIVE SESSION instead. When the computer is
                // not ready the section is disabled WITH the reason: a button
                // that explains itself beats a button that fails.
                windows && (() => {
                  const entry = clip[name] ?? {}
                  // TWO reasons to be disabled, both stated: the row is not
                  // running (no interactive session exists), or the row says
                  // SSH is off — the bridge has no other transport, and a button
                  // that fails with an SSH error is worse than a disabled one
                  // that says why.
                  const usable = ready === true && vm.ssh !== false
                  const reason = vm.ssh === false
                    ? 'SSH is disabled for this computer, and the clipboard bridge has no other transport (it writes the text over SSH and runs the task with schtasks)'
                    : usable ? null : `the clipboard runs in the computer's interactive session, which exists once it is ready (state: ${vm.state ?? 'unknown'})`
                  return h('div', { style: { display: 'grid', gap: 6, padding: '8px 0 0', borderTop: `1px solid ${T.line}` } },
                    h('div', { style: { ...S.muted, fontWeight: 600 } }, 'Clipboard'),
                    h('div', { style: S.muted },
                      'Pastes through a task in the Windows session (the only clipboard a user can see). The noVNC paste box does not work on this kind of computer: there is no clipboard agent in the guest.'),
                    h('textarea', {
                      value: entry.text ?? '', rows: 3, disabled: !usable,
                      placeholder: usable ? 'text to paste into the guest' : (reason ?? ''),
                      style: { ...S.input, width: '100%', boxSizing: 'border-box', resize: 'vertical', opacity: usable ? 1 : 0.6 },
                      onChange: (event) => setClip((current) => ({ ...current, [name]: { ...(current[name] ?? {}), text: event.target.value } }))
                    }),
                    h('div', { style: S.row },
                      h('button', {
                        type: 'button', style: S.button, disabled: !usable || entry.busy === 'set',
                        onClick: () => void pasteToGuest(name)
                      }, entry.busy === 'set' ? 'Pasting…' : 'Paste to guest'),
                      h('button', {
                        type: 'button', style: S.button, disabled: !usable || entry.busy === 'get',
                        onClick: () => void readGuestClipboard(name)
                      }, entry.busy === 'get' ? 'Reading…' : 'Read guest clipboard')
                    ),
                    reason !== null && h('div', { style: S.muted }, clean(reason)),
                    typeof entry.out === 'string' && entry.out !== '' && h('pre', { style: S.pre }, entry.out)
                  )
                })(),
                // F4: THE WAITING ROW SAYS WHAT IT IS WAITING FOR. The poll above
                // already refreshes `vm.state`; printing it here is what turns a
                // silent 120 s label into "ACPI was asked, the guest has not
                // answered yet".
                busy && (pending?.action === 'shutdown' || pending?.action === 'suspend') && h('div', { style: S.muted },
                  pending.action === 'shutdown'
                    ? `Waiting for ${name} to power off — state is "${vm.state ?? 'unknown'}" after ${waitedSec} s. A paused guest is continued first, then asked for ACPI; a mid-install guest gets a short window and then a forced quit. The timeout is ${state?.config?.shutdownTimeoutSec ?? 120} s.`
                    : `Waiting for ${name} to pause — state is "${vm.state ?? 'unknown'}" after ${waitedSec} s.`),
                (installing || failed) && installDetail && h('div', { style: S.muted }, clean(installDetail)),
                installing && elapsed !== null && h('div', { style: S.muted },
                  `elapsed ${elapsed} min of ${vm.installTimeoutMinutes ?? info?.installTimeoutMinutes ?? 60} · the badge flips to Ready when readiness answers, and /vm/port/${name}/ becomes the noVNC stream you can drive.`),
                installing && readiness !== null && h('div', { style: S.muted },
                  clean(`watching: ${(readiness.signals ?? []).join(' + ')} (serial-log tail is shown live)${readiness.onReady ? ` — ${readiness.onReady}` : ''}`)),
                installing && serialTail.length > 0 && h('pre', { style: S.pre }, clean(serialTail.join('\n'))),
                installing && serialTail.length === 0 && h('div', { style: S.muted }, 'Serial log: no lines yet — Windows Setup has not printed to the console (the tail appears here as soon as it does).'),
                // A STUCK INSTALL (installing with no live QEMU) cannot be
                // deleted by the normal path, so the panel names the remedy.
                stuck && h('div', { style: { ...S.muted, color: T.caption } },
                  'This install is marked installing but QEMU is not running, so the normal delete keeps the disk. Use Force delete: it kills the process, then removes the disk, the TPM, the ports and the registry row.'),
                partialFor !== null && h('div', { style: { ...S.muted, color: T.caption } },
                  clean(`The last delete left ${[(partialFor.kept ?? []).length > 0 ? `${(partialFor.kept ?? []).length} kept item(s)` : '', (partialFor.failed ?? []).length > 0 ? `${(partialFor.failed ?? []).length} failed item(s)` : ''].filter(Boolean).join(' and ')} — Force delete kills the process and removes them.`)),
                failed && vm.error && h('div', { style: { ...S.muted, color: T.error } }, clean(vm.error)),
                failed && vm.errorLog && h('pre', { style: S.pre }, clean(String(vm.errorLog).slice(-1200))),
                exec !== null && exec.name === name && h('div', { style: { display: 'grid', gap: 6 } },
                  h('div', { style: { display: 'flex', gap: 6 } },
                    h('input', {
                      value: exec.cmd, placeholder: 'ONE command (sh -c on Linux, cmd.exe on Windows) — no prompt, output is captured once', style: { ...S.input, flex: 1 },
                      onChange: (event) => setExec({ ...exec, cmd: event.target.value }),
                      onKeyDown: (event) => { if (event.key === 'Enter') void run() }
                    }),
                    h('button', { type: 'button', style: S.button, disabled: exec.busy, onClick: () => void run() }, exec.busy ? 'Running…' : 'Run')
                  ),
                  exec.out !== '' && h('pre', { style: S.pre }, exec.out)
                )
              )
            }),
          note !== null && h('div', { style: S.muted }, note)
        ),

        tab === 'policy' && h('div', { style: S.card },
          h('div', { style: S.muted }, 'Stored in /cua-vm/config.json and read by the supervisor every minute. Nothing here is baked into the image.'),
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 } },
            h('input', { type: 'checkbox', checked: form.autoSuspend === true, onChange: (event) => setForm({ ...form, autoSuspend: event.target.checked }) }),
            'Suspend idle computers automatically'
          ),
          field('idleSuspendMinutes', 'Idle timeout (minutes)', '0 disables. Checked every minute; a running command postpones it.'),
          field('diskQuotaGb', 'Disk Size (GB)', 'Base image + QEMU + every disk, checkpoint, screenshot and the shared ISO cache in the store. A create that would exceed it is refused before it starts.'),
          field('maxRunning', 'Max running computers', 'Shutdown frees a slot, disks are untouched.'),
          field('shutdownTimeoutSec', 'Shutdown timeout (seconds)', 'How long an ACPI powerdown may take before the QMP quit forces it. 120 is right for a slow init.'),
          h('label', { style: { display: 'grid', gap: 4, fontSize: 13 } },
            h('span', { style: { fontWeight: 500 } }, 'Checkpoint policy'),
            h('select', {
              value: form.checkpointPolicy ?? 'shutdown',
              onChange: (event) => setForm({ ...form, checkpointPolicy: event.target.value }),
              style: S.input
            },
              h('option', { value: 'shutdown' }, 'After a clean shutdown (default)'),
              h('option', { value: 'always' }, 'Also before a suspend'),
              h('option', { value: 'never' }, 'Never (no checkpoint; Start boots the base image)')
            ),
            h('span', { style: S.muted }, 'A checkpoint is a flattened copy of the disk: Start cold-boots from it after a shutdown.'),
          ),
          field('shotsKeepDays', 'Keep screenshots (days)', 'Screenshots are read-once. 0 keeps them for ever; Clean up enforces this number.'),
          field('windowsInstallTimeoutMinutes', 'Windows install timeout (minutes)', 'A first Windows boot re-partitions 64 GB and runs the OOBE. Past this, the computer is marked error with the last 40 log lines.'),
          h('div', { style: S.row }, h('button', { type: 'button', style: S.primary, onClick: () => void savePolicy() }, 'Save policy'))
        ),

        view !== null && h(Viewer, { name: view.name, hash: view.hash, onClose: () => setView(null) })
      )
    }

    function Icon() {
      return h('svg', {
        width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true
      },
        h('rect', { x: 2.5, y: 4, width: 19, height: 13, rx: 2 }),
        h('path', { d: 'M8 20.5h8M12 17v3.5' }),
        h('path', { d: 'M6.5 8.5l2 1.6-2 1.6M11 12h4' })
      )
    }

    /** Only `slots`: all data comes from the host half's /cua routes. */
    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_ID
      }, PersonalVmPage))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: 'Personal VM (CUA)'
      }, Icon))
    }

    module.exports.apply = apply
    module.exports.inject = inject
    // U1: the two state transitions the hide button depends on, and the secret
    // helpers around them, are pure functions so a test can prove "hide clears
    // the value" without mounting the page.
    module.exports.__test = { hideSecretEntry, noteAfterHide, clean }
    return module.exports
  }
})
