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

      const send = async (payload) => {
        try {
          await api('input', { name, ...payload })
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
      // X11 renders the cursor as an overlay the capture does not include, so
      // the real pointer moves invisibly. Poll it and draw our own.
      useEffect(() => {
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
        const timer = setInterval(() => { void tick() }, 500)
        return () => { alive = false; clearInterval(timer) }
      }, [name])
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
          pos !== null && h('div', { style: { ...S.muted, fontVariantNumeric: 'tabular-nums' } }, `pointer ${pos.x},${pos.y}`),
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
              title: `${name} desktop`,
              src: `/vm/view/${name}/${hash}`,
              style: { width: '100%', height: '100%', border: 'none', borderRadius: T.radiusLg, background: '#000' },
              allow: 'clipboard-read; clipboard-write; fullscreen'
            })
      )
    }

    function PersonalVmPage() {
      const [tab, setTab] = useState('computers')
      const [state, setState] = useState(null)
      const [note, setNote] = useState(null)
      const [showNew, setShowNew] = useState(false)
      const [draft, setDraft] = useState({ name: '', cpu: 2, memory: 4, image: 'linux', gpu: false })
      const [pending, setPending] = useState(null)
      const [exec, setExec] = useState(null)
      const [form, setForm] = useState(null)
      const [view, setView] = useState(null)
      const [metricFor, setMetricFor] = useState(null)

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

      const act = async (name, label, action, body) => {
        setPending({ name, action })
        setNote(label)
        try {
          await api(action, body)
          await load()
          setNote(null)
        } catch (error) {
          setNote(clean(error?.message ?? error))
        } finally {
          setPending(null)
        }
      }

      const create = async () => {
        setPending({ name: draft.name, action: 'create' })
        setNote(`Creating ${draft.name}… it boots on first use.`)
        try {
          await api('create', { name: draft.name, cpu: draft.cpu, memory: draft.memory, image: draft.image, gpu: draft.gpu })
          setShowNew(false)
          setDraft({ name: '', cpu: 2, memory: 4, image: 'linux', gpu: false })
          await load()
          setNote(`${draft.name} is up.`)
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
            h('div', { style: { ...S.muted, marginLeft: 'auto' } }, `store ${(state.usedBytes / 1024 ** 3).toFixed(1)} GB`),
            h('div', { style: S.muted }, `${state.config.maxRunning} max running · ${state.config.autoSuspend ? `${state.config.idleSuspendMinutes} min idle` : 'no idle suspend'}`)
          ),
          showNew && h('div', { style: S.card },
            h('div', { style: { fontWeight: 600, fontSize: 13 } }, 'New computer'),
            h('input', {
              placeholder: 'name (a-z, 0-9, dashes)', value: draft.name, style: S.input,
              onChange: (event) => setDraft({ ...draft, name: event.target.value })
            }),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 2fr auto', gap: 8, alignItems: 'end' } },
              h('label', { style: { display: 'grid', gap: 4 } }, h('span', { style: S.muted }, 'vCPU'),
                h('input', { type: 'number', min: 1, max: 8, value: draft.cpu, style: S.input, onChange: (event) => setDraft({ ...draft, cpu: Number(event.target.value) }) })),
              h('label', { style: { display: 'grid', gap: 4 } }, h('span', { style: S.muted }, 'RAM (GB)'),
                h('input', { type: 'number', min: 1, max: 32, value: draft.memory, style: S.input, onChange: (event) => setDraft({ ...draft, memory: Number(event.target.value) }) })),
              h('label', { style: { display: 'grid', gap: 4 } }, h('span', { style: S.muted }, 'Image'),
                h('select', { value: draft.image, style: S.input, onChange: (event) => setDraft({ ...draft, image: event.target.value }) },
                  h('option', { value: 'linux' }, 'Ubuntu 24.04 slim (Cua disk)'),
                  h('option', { value: 'ghcr.io/trycua/linux:24.04' }, 'Ubuntu 24.04 full')
                )),
              h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, paddingBottom: 6 } },
                h('input', {
                  type: 'checkbox', checked: draft.gpu === true,
                  onChange: (event) => setDraft({ ...draft, gpu: event.target.checked })
                }),
                'Enable GPU'
              )
            ),
            h('div', { style: S.muted }, 'Debian and Arch are not Cua disks yet: build one with `cua images build` and paste its reference into the image field.'),
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
              const busy = pending?.name === name
              const busyLabel = pending?.action === 'start' ? 'Starting…' : pending?.action === 'stop' ? 'Shutting down…' : null
              return h('div', { key: name, style: S.card },
                h('div', { style: S.row },
                  h('span', { style: { fontWeight: 600, fontSize: 13 } }, name),
                  h('span', { style: S.badge(ready) }, vm.state ?? 'unknown'),
                  vm.gpu === true && h('span', { style: { ...S.badge(false), color: T.info } }, 'GPU'),
                  h('span', { style: { ...S.muted, marginLeft: 'auto' } }, `${vm.cpu ?? '?'} vCPU · ${vm.memory ?? '?'} GB · ${vm.image ?? 'linux'}`)
                ),
                h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  h('button', {
                    type: 'button', style: S.button, disabled: busy,
                    onClick: () => {
                      if (ready === false) return void act(name, `Starting ${name}…`, 'start', { name })
                      if (!window.confirm(`Do you want to shutdown ${name}?`)) return
                      void act(name, `Shutting down ${name}…`, 'stop', { name })
                    }
                  }, busy && busyLabel !== null ? busyLabel : ready ? 'Shutdown' : 'Start'),
                  h('button', { type: 'button', style: S.button, onClick: () => void showVm(name) }, 'Show VM'),
                  h('button', {
                    type: 'button',
                    style: { ...S.button, background: exec !== null && exec.name === name ? T.hover : 'transparent' },
                    onClick: () => setExec((current) => (current !== null && current.name === name ? null : { name, cmd: '', out: '', busy: false }))
                  }, 'Terminal'),
                  h('button', {
                  type: 'button',
                  style: { ...S.button, background: metricFor === name ? T.hover : 'transparent' },
                  onClick: () => {
                    if (metricFor === name) { setMetricFor(null); setNote(null); return }
                    void metrics(name)
                  }
                }, 'Metrics'),
                  h('button', {
                    type: 'button', style: { ...S.button, color: T.error },
                    onClick: () => { if (window.confirm(`Delete ${name}? Its disk goes with it.`)) void act(name, `Deleted ${name}.`, 'delete', { name }) }
                  }, 'Delete')
                ),
                exec !== null && exec.name === name && h('div', { style: { display: 'grid', gap: 6 } },
                  h('div', { style: { display: 'flex', gap: 6 } },
                    h('input', {
                      value: exec.cmd, placeholder: 'command inside the VM (sh -c)', style: { ...S.input, flex: 1 },
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
          field('diskQuotaGb', 'Disk Size (GB)', 'Base image + QEMU + every disk in /cua-vm.'),
          field('maxRunning', 'Max running computers', 'Shutdown frees a slot, disks are untouched.'),
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
    return module.exports
  }
})
