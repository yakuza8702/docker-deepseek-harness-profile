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
     * THE LAST LINE OF A CAPTURED LOG TAIL, bounded. A failed install's tail is
     * 1.5 KB of npm/curl noise; the row needs the sentence that says why, not
     * the dump (`reaError` keeps the rest for the tool answer).
     */
    const lastLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? ''

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

    /**
     * THE VERSION LIST IS DATA, NOT MARKUP.
     *
     * `vmList`'s `windows` payload carries the backend catalog (`versions`: the
     * 16 codes; `catalog`: one row per code with label/sizeGb/bios/refused), and
     * the panel renders exactly that, in the backend's own order. When the field
     * is absent (a supervisor older than this page) the select falls back to the
     * same 16 rows instead of going empty — the codes below ARE the catalog, so
     * a fallback row can never invent a version the backend refuses to answer.
     * The markers are read off the row too: `xp` is LISTED and refused (its
     * refusal is data — no Autounattend path), `7u` boots SeaBIOS and is
     * experimental, and the tiny/core codes keep their own Tiny labels.
     */
    const WINDOWS_CATALOG_FALLBACK = [
      { code: '11', label: 'Windows 11 Pro', sizeGb: 7.9, bios: 'ovmf' },
      { code: '11l', label: 'Windows 11 LTSC', sizeGb: 4.7, bios: 'ovmf' },
      { code: '11e', label: 'Windows 11 Enterprise', sizeGb: 6.6, bios: 'ovmf' },
      { code: '10', label: 'Windows 10 Pro', sizeGb: 5.7, bios: 'ovmf' },
      { code: '10l', label: 'Windows 10 LTSC', sizeGb: 4.6, bios: 'ovmf' },
      { code: '10e', label: 'Windows 10 Enterprise', sizeGb: 5.2, bios: 'ovmf' },
      { code: '7u', label: 'Windows 7 Ultimate', sizeGb: 3.1, bios: 'seabios' },
      { code: 'xp', label: 'Windows XP Professional', sizeGb: 0.6, bios: 'seabios', refused: true },
      { code: '2025', label: 'Windows Server 2025', sizeGb: 7.6, bios: 'ovmf' },
      { code: '2022', label: 'Windows Server 2022', sizeGb: 6.0, bios: 'ovmf' },
      { code: '2019', label: 'Windows Server 2019', sizeGb: 5.3, bios: 'ovmf' },
      { code: '2016', label: 'Windows Server 2016', sizeGb: 6.5, bios: 'ovmf' },
      { code: '2012', label: 'Windows Server 2012', sizeGb: 4.3, bios: 'ovmf' },
      { code: 'core11', label: 'Tiny11 Core', sizeGb: 3.0, bios: 'ovmf' },
      { code: 'tiny11', label: 'Tiny11', sizeGb: 5.3, bios: 'ovmf' },
      { code: 'tiny10', label: 'Tiny10', sizeGb: 3.6, bios: 'ovmf' }
    ]

    // The spellings the backend canonicalises. Mirrored here so a stored draft
    // that says `11ltsc` renders as "Windows 11 LTSC (4.7 GB) — alias" instead
    // of a blank select; the payload's own `aliases` wins when it carries one.
    const WINDOWS_VERSION_ALIASES_FALLBACK = {
      '11p': '11', pro11: '11', win11: '11', windows11: '11', '11ltsc': '11l', ltsc11: '11l', win11l: '11l', 'win11-ltsc': '11l', '11iot': '11l', iot11: '11l', '11i': '11l',
      '10p': '10', pro10: '10', win10: '10', windows10: '10', '10ltsc': '10l', ltsc10: '10l', win10l: '10l', 'win10-ltsc': '10l', '10iot': '10l', iot10: '10l',
      '7': '7u', win7: '7u', win7u: '7u', windows7: '7u', '7e': '7u',
      xp32: 'xp', winxp: 'xp', winxp86: 'xp', windowsxp: 'xp',
      '25': '2025', win25: '2025', win2025: '2025', windows2025: '2025',
      '22': '2022', win22: '2022', win2022: '2022', windows2022: '2022',
      '19': '2019', win19: '2019', win2019: '2019', windows2019: '2019',
      '16': '2016', win16: '2016', win2016: '2016', windows2016: '2016',
      '2012r2': '2012', win2012: '2012', win2012r2: '2012', windows2012: '2012',
      'core 11': 'core11', tiny11core: 'core11', tiny11_core: 'core11',
      'tiny 11': 'tiny11', tiny_11: 'tiny11', 'tiny 10': 'tiny10', tiny_10: 'tiny10'
    }

    /** `null` for "no size", not 0 — `Number(null)` is 0 and would print "(0.0 GB)". */
    function toSizeGb(value) {
      if (value === null || value === undefined || value === '') return null
      const size = Number(value)
      return Number.isFinite(size) ? size : null
    }

    /**
     * `64 GB` / `1.5 GB`, or `null` when the number is absent or not positive.
     * A store readout that says "12.3 GB" cannot answer the only question the
     * number raises — "out of how much?" — so every usage line carries the
     * quota right next to it (dropped, not faked, when the payload lacks it).
     */
    function formatGb(value) {
      const gb = Number(value)
      return Number.isFinite(gb) && gb > 0 ? `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB` : null
    }

    function windowsAliasMap(windows) {
      const aliases = windows?.aliases
      if (aliases !== null && typeof aliases === 'object' && !Array.isArray(aliases)) return aliases
      return WINDOWS_VERSION_ALIASES_FALLBACK
    }

    /**
     * One row per code, whatever shape the payload uses: an array of rows that
     * carry `code`, a `code → row` map, or a bare `versions` array (zipped by
     * index, with the fallback row filling the facts). `versions` order wins, so
     * the dropdown cannot reorder itself between two polls.
     */
    function windowsCatalogRows(windows) {
      const versions = Array.isArray(windows?.versions) ? windows.versions.map((code) => String(code)) : []
      const catalog = windows?.catalog
      const rows = new Map()
      const add = (code, row) => {
        const value = String(code ?? row?.code ?? row?.id ?? '')
        if (value === '' || rows.has(value)) return
        rows.set(value, {
          code: value,
          label: typeof row?.label === 'string' && row.label !== '' ? row.label : value,
          sizeGb: toSizeGb(row?.sizeGb),
          bios: typeof row?.bios === 'string' ? row.bios : null,
          refused: row?.refused === true || (typeof row?.refused === 'string' && row.refused !== '')
        })
      }
      if (Array.isArray(catalog)) {
        catalog.forEach((row, index) => add(row?.code ?? versions[index], row))
      } else if (catalog !== null && typeof catalog === 'object') {
        for (const [code, row] of Object.entries(catalog)) add(code, row)
      }
      if (rows.size === 0 && versions.length > 0) {
        for (const code of versions) {
          add(code, WINDOWS_CATALOG_FALLBACK.find((row) => row.code === code) ?? { label: code })
        }
      }
      if (rows.size === 0) return WINDOWS_CATALOG_FALLBACK
      const order = versions.length > 0
        ? versions.concat([...rows.keys()].filter((code) => !versions.includes(code)))
        : [...rows.keys()]
      return order.filter((code) => rows.has(code)).map((code) => rows.get(code))
    }

    /** `Windows 7 Ultimate (3.1 GB — SeaBIOS, experimental)`; markers are data. */
    function windowsVersionLabel(row) {
      const size = toSizeGb(row?.sizeGb)?.toFixed(1) ?? null
      const marker = row?.refused === true ? 'refused: no Autounattend path'
        : row?.bios === 'seabios' ? 'SeaBIOS, experimental' : ''
      if (size === null) return marker === '' ? String(row?.label ?? '') : `${row?.label ?? ''} (${marker})`
      return marker === '' ? `${row.label} (${size} GB)` : `${row.label} (${size} GB — ${marker})`
    }

    /**
     * THE STORED DRAFT WINS OVER THE CATALOG, NOT THE OTHER WAY ROUND.
     * A draft holding `11ltsc` (a spelling the old six-option list used) must
     * stay selectable: a `value` that no `<option>` carries makes the browser
     * silently show the first entry, so the user would create `11` believing it
     * was their LTSC choice. The extra option is labelled with the canonical
     * form. The disabled state belongs to the kind select above and is untouched.
     */
    function windowsVersionOptions(windows, current) {
      const options = windowsCatalogRows(windows).map((row) => ({ value: row.code, label: windowsVersionLabel(row) }))
      const value = String(current ?? '')
      if (value === '' || options.some((option) => option.value === value)) return options
      const canonical = windowsAliasMap(windows)[value.toLowerCase()] ?? null
      const row = canonical === null ? null : windowsCatalogRows(windows).find((entry) => entry.code === canonical) ?? null
      options.push({
        value,
        label: row === null
          ? `${value} (not in this catalog — kept from your draft)`
          : `${windowsVersionLabel(row)} — alias "${value}"`
      })
      return options
    }

    /**
     * C19 — THE CLIENT OUTLIVES THE ROUTE.
     *
     * The `/cua` routes carry their own budget (`ROUTE_TIMEOUTS`, WP-B) and
     * answer a 504 with a sentence when the supervisor misses it. This table is
     * that table **plus five seconds** (route budget + 5_000), so the panel is
     * still listening when the route's own refusal arrives: the user reads the
     * supervisor-shaped story ("did not answer start within 65 s … the computer
     * did not stop working") instead of a blind client abort that would hide
     * whether the supervisor ever saw the request.
     *
     *   state 15 s → 20 s      lifecycle (start/shutdown/suspend/stop/delete)
     *   65 s → 70 s            create 2_885 s → 2_890 s; provision 30 s → 35 s
     *   exec                   route `(timeout | 300) + 60 s` → that + 5 s, PER CALL (D1)
     *
     * Duplicated on purpose: the client half is a separate module bundle and
     * cannot import the plugin's `index.js` at runtime. The ARITHMETIC is the
     * contract; a table that drifts below route + 5 s re-opens defect R4 (the
     * 30-minute wait) on the one surface the user actually watches.
     */
    const CLIENT_TIMEOUTS = Object.freeze({
      state: 20_000, config: 20_000, doctor: 35_000, gc: 35_000, space: 35_000,
      windowsStatus: 35_000, windowsFreeSpace: 35_000, windowsPassword: 20_000,
      windowsClipboardSet: 35_000, windowsClipboardGet: 35_000,
      start: 70_000, shutdown: 70_000, suspend: 70_000, stop: 70_000, delete: 70_000,
      create: 2_890_000, ensure: 2_890_000, android: 3_370_000, provision: 35_000,
      metrics: 35_000, view: 35_000, screenshot: 35_000, input: 35_000, gui: 125_000, pointer: 35_000,
      // D1: `exec` is 0 — "ask the resolver", exactly as the route's own table
      // says (`ROUTE_TIMEOUTS.exec === 0`). It was a frozen 180_000 (= 120 s +
      // grace), which both CUT a legal long exec the route allows up to 3 660 s
      // and, for the panel's own `timeout: 120` body, fired the AbortSignal at
      // the same 180 s the route's 504 needs — the C18 sentence never rendered.
      // The budget is now computed per call by `clientBudget('exec', body)`.
      exec: 0
    })
    const CLIENT_TIMEOUT_FALLBACK_MS = 35_000
    /** The route's `exec` grace (EXEC_ENVELOPE_GRACE_MS): `timeout + 60 s`. */
    const CLIENT_EXEC_GRACE_MS = 60_000
    /** C19's lead: the client outlives the route by five seconds. */
    const CLIENT_LEAD_MS = 5_000
    /**
     * D1 — THE EXEC BUDGET IS PER CALL, because the route's is.
     *
     * Mirrors `PER_CALL_TIMEOUTS.cua_vm_exec` (`(timeout | 300)`, clamped to
     * 1–3600 s, `+ 60 s`), then applies C19's `+ 5 s`. Duplicated arithmetic on
     * purpose (the client bundle cannot import `index.js`); `tests/exec-budget.mjs`
     * asserts the two agree, so the copy cannot drift.
     */
    const execRouteTimeoutMs = (body) => (Math.min(3600, Math.max(1, Number(body?.timeout) || 300)) * 1000) + CLIENT_EXEC_GRACE_MS
    /** The budget for an action (C19: route + 5 s), or the route fallback + 5 s. */
    const clientBudget = (action, body) => (action === 'exec'
      ? execRouteTimeoutMs(body) + CLIENT_LEAD_MS
      : (CLIENT_TIMEOUTS[action] ?? CLIENT_TIMEOUT_FALLBACK_MS))

    /**
     * C19 — the backstop, not the primary answer.
     *
     * `{ budgetMs }` puts `AbortSignal.timeout(budgetMs)` on the fetch, so a
     * supervisor that never answers can no longer leave a button counting for
     * ever. The abort is TRANSLATED: a silent `TimeoutError`/`AbortError`
     * becomes the sentence below, while a real route refusal (a `504` carrying
     * `code:'route-timeout'`) has already put its own, more truthful sentence in
     * `payload.error` and is thrown untouched.
     */
    async function api(path, body, { budgetMs } = {}) {
      const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : null
      try {
        const response = await fetch(`/cua/${path}`, {
          ...(body === undefined
            ? { headers: { accept: 'application/json' } }
            : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
          ...(budget === null ? {} : { signal: AbortSignal.timeout(budget) })
        })
        const payload = await response.json().catch(() => null)
        if (payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } catch (error) {
        // The computer did not stop working just because this page stopped
        // waiting: say that, and point at the one action that re-reads the truth.
        if (budget !== null && (error?.name === 'TimeoutError' || error?.name === 'AbortError')) {
          throw new Error(`the panel stopped waiting after ${Math.round(budget / 1000)} s — the supervisor may still be finishing; hit Refresh`)
        }
        throw error
      }
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
            await api('gui', { name, action: 'click', x: payload.x, y: payload.y, smooth: false }, { budgetMs: clientBudget('gui') })
          } else {
            await api('input', { name, ...payload }, { budgetMs: clientBudget('input') })
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
            const payload = await api('screenshot', { name }, { budgetMs: clientBudget('screenshot') })
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
            const p = await api('pointer', { name }, { budgetMs: clientBudget('pointer') })
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
          const payload = await api('state', undefined, { budgetMs: CLIENT_TIMEOUTS.state })
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
              const payload = await api('windowsStatus', { name, tail: 5 }, { budgetMs: clientBudget('windowsStatus') })
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
              const payload = await api('windowsFreeSpace', { name }, { budgetMs: clientBudget('windowsFreeSpace') })
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
          const payload = await api('windowsClipboardSet', { name, text: entry.text ?? '' }, { budgetMs: clientBudget('windowsClipboardSet') })
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
          const payload = await api('windowsClipboardGet', { name }, { budgetMs: clientBudget('windowsClipboardGet') })
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
          const payload = await api(action, body, { budgetMs: clientBudget(action) })
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
          : `Creating ${draft.name}${draft.gpu === true ? ' with GPU' : ''}${draft.android ? ' + Android SDK' : ''}${draft.rea ? ' + REA' : ''}… the first start also provisions the guest (a minute or two).${draft.rea || draft.android ? ' The slow layers install in the background once the VM is up; this note is not the progress bar, the row is.' : ''}`)
        try {
          const answer = await api('create', windows
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
              }, { budgetMs: CLIENT_TIMEOUTS.create })
          setShowNew(false)
          setDraft({
            name: '', kind: 'linux', cpu: 2, memory: 4, image: 'linux', gpu: null, diskGb: 20,
            android: false, rea: false, windowsVersion: '11', windowsIso: '', windowsKey: ''
          })
          await load()
          // THE SUPERVISOR'S OWN SENTENCES WIN. A create returns when the VM is
          // up, so "is up" alone would read as "everything is installed" — the
          // notes say which layers are still installing in the background (and
          // what a failure means), so they belong in the same line.
          const notes = Array.isArray(answer?.notes)
            ? answer.notes.filter((line) => typeof line === 'string' && line !== '')
            : []
          setNote(clean([`${draft.name} is up.`, ...notes].join(' ')))
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
          const payload = await api('windowsPassword', { name }, { budgetMs: clientBudget('windowsPassword') })
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
          const payload = await api('space', { name }, { budgetMs: clientBudget('space') })
          setNote(clean(payload.warning ? `${payload.line} — ${payload.warning}` : payload.line))
        } catch (error) {
          setNote(clean(error?.message ?? error))
        }
      }

      /** Store cleanup: orphan checkpoints, restore temps, old shots, stale rows. */
      const cleanup = async () => {
        setPending({ name: '', action: 'gc' })
        try {
          const payload = await api('gc', {}, { budgetMs: CLIENT_TIMEOUTS.gc })
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
          // D1: the body IS the budget. `timeout: 120` therefore gets route
          // 180 s + C19's 5 s = 185 s, so the route's 504 (and C18's sentence)
          // always lands before this AbortSignal.
          const body = { name: exec.name, cmd: exec.cmd, timeout: 120 }
          const payload = await api('exec', body, { budgetMs: clientBudget('exec', body) })
          setExec({ ...exec, busy: false, out: clean(`exit ${payload.exit}\n${payload.stdout}${payload.stderr ? `\n[stderr]\n${payload.stderr}` : ''}`) })
          await load()
        } catch (error) {
          setExec({ ...exec, busy: false, out: clean(error?.message ?? error) })
        }
      }

      const showVm = async (name) => {
        try {
          const payload = await api('view', { name }, { budgetMs: clientBudget('view') })
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
          const m = await api('metrics', { name }, { budgetMs: clientBudget('metrics') })
          setMetricFor(name)
          setNote(`${name}: load ${m.load} · mem ${m.memUsedMb}/${m.memTotalMb} MB · disk ${m.diskUsed}/${m.diskSize} (${m.diskUsePct}) · ${m.cpus} vCPU`)
        } catch (error) {
          setNote(clean(error?.message ?? error))
        }
      }

      const savePolicy = async () => {
        try {
          const payload = await api('config', form, { budgetMs: CLIENT_TIMEOUTS.config })
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
            // C20/C-4: NOT GATED ON `pending`. Clean up and Refresh are how a
            // user escapes a wedged operation WITHOUT reloading the page; a
            // wedged op is exactly when `pending` stays set, so disabling this
            // button hid the remedy behind the defect. (It still sets `pending`
            // itself while it runs — the row buttons read that — but a second
            // click is a second gc the supervisor serialises, not a dead UI.)
            h('button', { type: 'button', style: S.button, onClick: () => void cleanup() }, 'Clean up'),
            h('button', {
              type: 'button', style: S.button,
              onClick: async () => {
                try {
                  const payload = await api('doctor', undefined, { budgetMs: CLIENT_TIMEOUTS.doctor })
                  const caps = payload.hostCaps ?? {}
                  // U5: the quota is half the fact. `doctor` sends it as
                  // `store.quotaBytes`; an older supervisor only has
                  // `policy.diskQuotaGb`, so both are read and neither is invented.
                  const usedGb = (payload.store?.usedBytes / 1024 ** 3).toFixed(1)
                  const quotaGb = Number(payload.store?.quotaBytes) > 0
                    ? Number(payload.store.quotaBytes) / 1024 ** 3
                    : payload.policy?.diskQuotaGb
                  const quota = formatGb(quotaGb)
                  setNote(clean(`kvm ${caps.kvm} · render ${caps.renderNode} · virgl ${caps.virtioGpuGl ? 'yes' : 'no'} · docker ${caps.docker} · windows ${payload.windows?.enabled ? 'on' : 'off'} · store ${usedGb} GB${quota === null ? '' : ` / ${quota}`}`))
                } catch (error) {
                  setNote(clean(error?.message ?? error))
                }
              }
            }, 'Doctor'),
            // U5: THE QUOTA IS IN THE SAME LINE AS THE USAGE. The store number
            // used to be a bare "used GB", which cannot be judged: 12 GB is fine
            // on a 64 GB quota and nearly full on a 16 GB one. `state.config`
            // carries `diskQuotaGb` (the Policy tab's own field, relabelled
            // "Store quota"), and the line falls back to the bare number when an
            // older payload does not carry it.
            h('div', { style: { ...S.muted, marginLeft: 'auto' } },
              `store ${(state.usedBytes / 1024 ** 3).toFixed(1)} GB${formatGb(state.config?.diskQuotaGb) === null ? '' : ` / ${formatGb(state.config.diskQuotaGb)}`}`),
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
                      // every code has an ordered ISO source chain with sha256+size verification; aliases (11ltsc, ltsc10, ltsc11, win11, …) still work
                      windowsVersionOptions(state?.windows, draft.windowsVersion).map((option) =>
                        h('option', { key: option.value, value: option.value }, option.label))
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
                  'Install rea'
                )
              )
            ),
            draft.kind === 'linux'
              ? h('div', { style: S.muted }, 'Provisioning is automatic on the first start: Xorg on virgl + OpenGL 4.3 + render/KVM access + a 1200x750 desktop + the workspace share (Enable GPU), and the official Android SDK with an AVD inside the VM (Install Android, ~7 GB, needs a 40 GB disk and a GPU computer). Install rea adds Node 22, rea-agents, a JDK 21, Ghidra 12.1.4 and JADX to the computer, roughly 3.5 GB installed, and lifts the disk to at least a 40 GB one. It installs per computer, in the background: Create returns as soon as the VM is up, the row shows REA… while it runs, and a failure shows REA failed with a Retry install button. rea-agents comes from npm\'s latest tag (REA_AGENTS_VERSION pins it), and an installed computer has an Update rea button that moves it to the latest without deleting the disk. Debian and Arch are not Cua disks yet: build one with `cua images build` and paste its reference into the image field. Leaving Enable GPU unticked uses the host default (virgl when this host can do it).')
              : h('div', { style: S.muted }, 'Windows is a DIRECT QEMU computer (OVMF firmware for the UEFI editions, SeaBIOS for 7u, a swtpm TPM2, a qcow2 disk under the VM store) — there is no container runtime. It needs /dev/kvm and compose.windows.yaml for the devices (DSH_CUA_VM_WINDOWS=1). The recommended floor is 64 GB disk and 6 GB RAM: create below it anyway, and the computer carries a warning that Windows Update will run out of space. The install takes tens of minutes and lists as installing until SSH answers AND QMP says running. Once ready: exec/put/get work over SSH, the desktop is cua_vm_gui over QMP, and the live view at /vm/port/<name>/ is a noVNC stream a human can drive. It cannot take REA or Android, and the disk does not grow. Its password is generated and shown with Reveal — stored 0600 in the VM store, never in the registry.'),
            // A SPARSE DISK OVER THE POLICY IS CREATED, NOT REFUSED: this is advice,
            // not a block (the supervisor sends warnings[code: disk-over-policy]).
            draft.rea === true && form.diskQuotaGb < Math.max(40, draft.diskGb) && h('div', { style: { ...S.muted, color: T.error } },
              `The VM store quota is ${form.diskQuotaGb} GB. The ${Math.max(40, draft.diskGb)} GB REA disk is created anyway (it is sparse), but the guest will hit the real disk ceiling — raise Store quota in the Policy tab first.`),
            h('div', { style: S.row },
              // C20/C-4: only the EMPTY NAME disables Create. A wedged operation
              // elsewhere in the panel used to disable this button too, which
              // made "the panel is stuck" and "you cannot create anything" the
              // same sentence. The label still follows the create itself.
              h('button', { type: 'button', style: S.primary, disabled: draft.name.trim() === '', onClick: () => void create() }, pending?.action === 'create' ? 'Creating…' : 'Create computer')
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
              // C20 — RENDER, THEN DISABLE WITH A REASON.
              //
              // BOTH power buttons are rendered on EVERY row. HEAD hid them on
              // every row that was not `ready` (or an installing Windows one),
              // so a powered-off, erroring or wedged computer showed no power
              // control at all — the reported "where did the buttons go" — and
              // the fix belongs in the row, not in a wider show-condition. The
              // HEAD expression is kept as a VALUE so the semantic stays
              // greppable: what changed is that failing it DISABLES the button
              // (with the reason as its title) instead of removing it.
              const canPower = (ready || (windows && installing))
              // C20 — THE REASON LADDER, IN THIS ORDER (first match wins): a
              // pending action outranks a held lock, which outranks the row's
              // state. The user is told the NEAREST cause, not the stale one
              // underneath it. `lock` is the supervisor's lock snapshot for this
              // computer (WP-A/B), so a wedged operation is NAMED here instead of
              // presenting a button that silently refuses.
              const lockHeldMs = Number(vm.lock?.heldMs) > 0 ? Number(vm.lock.heldMs) : 0
              const powerReason = busy && pending !== null
                ? `Waiting for ${pending.action}… ${waitedSec}s`
                : lockHeldMs > 0
                  ? `Another operation on ${name} has been running for ${Math.max(1, Math.round(lockHeldMs / 60000))} min (${vm.lock?.heldBy ?? 'unknown'}). If it does not settle, restart the supervisor.`
                  : vm.state === 'powered-off'
                    ? 'Powered off — Start boots it'
                    : vm.state === 'suspended'
                      ? 'Suspended — Start resumes it'
                      : (vm.state === 'booting' || vm.state === 'installing') && !windows
                        ? 'Booting — the power buttons work once it is ready'
                        : failed ? 'Error — Start or delete first' : null
              // C13/C20 — THE ROW CAN TELL THE TRUTH ABOUT A GUEST IT CANNOT
              // REACH. `stateStale` is computed ON READ by the supervisor (C15:
              // no watcher write is needed for a row to look stale), so a row
              // whose corroboration timed out says so in the badge and in one
              // line under the row, instead of showing a confident `ready` for
              // a guest that is already gone. The age falls back to `stateSince`
              // (C13's own formula) for a supervisor older than this page.
              //
              // D5: `stateSince` is an ISO STRING (the supervisor's own
              // `stateStaleness` does `Date.parse(String(row.stateSince))`), so
              // `Number(iso)` was NaN — and `Math.max(0, NaN)` is NaN, which
              // rendered as "unconfirmed NaNm". Parse it the same way, and keep
              // 0 as the honest "age unknown"; a `stateStale:true` row always
              // carries `stateAgeMs`, so this is the older-supervisor path only.
              const stateSinceMs = Date.parse(String(vm.stateSince ?? ''))
              const stateAgeMs = Number.isFinite(Number(vm.stateAgeMs))
                ? Number(vm.stateAgeMs)
                : (Number.isFinite(stateSinceMs) ? Math.max(0, Date.now() - stateSinceMs) : 0)
              const staleMin = vm.stateStale === true
                ? Math.max(1, Math.round(stateAgeMs / 60000))
                : null
              const stateBadge = failed
                ? { ...S.badge(false), color: T.error, border: `1px solid ${T.line}`, background: 'rgba(242, 139, 130, .12)' }
                : installing
                  ? { ...S.badge(false), color: T.info, border: `1px solid ${T.line}`, background: 'rgba(77, 107, 254, .12)' }
                  : S.badge(ready)
              return h('div', { key: name, style: S.card },
                h('div', { style: S.row },
                  h('span', { style: { fontWeight: 600, fontSize: 13 } }, name),
                  h('span', { style: stateBadge }, staleMin === null ? (vm.state ?? 'unknown') : `${vm.state ?? 'unknown'} (unconfirmed ${staleMin}m)`),
                  h('span', { style: { ...S.badge(false), color: T.caption } }, windows ? 'Windows' : 'Linux'),
                  vm.gpu === true && h('span', { style: { ...S.badge(false), color: T.info } }, 'GPU'),
                  vm.android === true && h('span', { style: { ...S.badge(false), color: T.success, border: `1px solid ${T.line}`, background: 'rgba(126, 231, 135, .14)' } }, 'Android'),
                  vm.rea === true && h('span', { style: { ...S.badge(false), color: T.info, border: `1px solid ${T.line}`, background: 'rgba(138, 180, 255, .14)' } }, 'REA'),
                  vm.rea === true && typeof vm.reaVersion === 'string' && vm.reaVersion !== '' &&
                    h('span', { style: { ...S.badge(false), color: T.secondary } }, `rea ${vm.reaVersion}`),
                  // A QUEUED INSTALL AND A FAILED ONE ARE DIFFERENT FACTS.
                  // `provisioning` is the stage the background job is on; the
                  // Ok=false badges are what a finished run that did not pass
                  // `rea doctor` / the SDK check leaves behind.
                  // THREE STAGES, THREE LABELS. The old ternary had two arms, so
                  // the `desktop` stage — the one a Retry install can queue — was
                  // badged "Android…", which is a lie about what is installing.
                  vm.provisioning !== undefined && h('span', { style: { ...S.badge(false), color: T.info, border: `1px solid ${T.line}`, background: 'rgba(138, 180, 255, .10)' } },
                    vm.provisioning === 'rea' ? 'REA…' : vm.provisioning === 'android' ? 'Android…' : 'Provisioning…'),
                  vm.reaOk === false && h('span', { style: { ...S.badge(false), color: T.error, border: `1px solid ${T.line}`, background: 'rgba(242, 139, 130, .12)' } }, 'REA failed'),
                  vm.androidOk === false && h('span', { style: { ...S.badge(false), color: T.error, border: `1px solid ${T.line}`, background: 'rgba(242, 139, 130, .12)' } }, 'Android failed'),
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
                  // C20: BOTH ARE RENDERED HERE UNCONDITIONALLY — an installing
                  // Windows row is the case that PROVES it, because hiding them
                  // left the user with no way out of a 40-minute install except
                  // Force delete. `canPower` is the old show-condition, now the
                  // disable-condition, and `title` carries the reason ladder.
                  //
                  // The confirm still says what the action COSTS: there is no
                  // ACPI handler in Setup, so Shutdown aborts the install (the
                  // backend sends a short powerdown window then `quit` and marks
                  // the disk mayBeTorn); Suspend pauses the machine and Start
                  // continues it. It fires only when the button is enabled.
                  h('button', {
                    type: 'button', style: S.button, disabled: !canPower || busy, title: powerReason,
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
                  h('button', {
                    type: 'button', style: S.button, disabled: !canPower || busy, title: powerReason,
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
                          const payload = await api('delete', { name }, { budgetMs: clientBudget('delete') })
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
                // C20: ONE warning line under the row — not a colour, not a
                // second badge. A `ready` row whose guest stopped answering is
                // the stale-ready wedge this package exists for, so the remedy
                // is spelled out where the buttons are.
                staleMin !== null && h('div', { style: { ...S.muted, color: T.error } },
                  `This row has not been confirmed by the computer for ${staleMin} min — the guest is probably gone. Try Start, then restart the supervisor if it does not settle.`),
                // P6: THE SLOW LAYERS ARE A BACKGROUND JOB, SO THE ROW IS THE
                // PROGRESS BAR. Create answered when the VM came up; this line
                // is the only thing that says the kit is still installing, and
                // the poll below refreshes it on its own.
                !windows && vm.provisioning !== undefined && h('div', { style: S.muted },
                  `Installing ${vm.provisioning === 'rea' ? 'REA' : vm.provisioning === 'android' ? 'Android' : vm.provisioning} in the background — the Create/tool call already returned. The last line of this row updates itself.`),
                // A FAILURE IS NOT A SPINNER. The tail says what the script
                // said, the hint says which button (or tool) retries it.
                !windows && typeof vm.reaError === 'string' && vm.reaError !== '' && h('div', { style: { ...S.muted, color: T.error } },
                  clean(`REA did not finish: ${lastLine(vm.reaError)} ${vm.reaErrorHint ?? ''}`.trim())),
                !windows && typeof vm.androidError === 'string' && vm.androidError !== '' && h('div', { style: { ...S.muted, color: T.error } },
                  clean(`Android did not finish: ${lastLine(vm.androidError)} ${vm.androidErrorHint ?? ''}`.trim())),
                // THE DESKTOP LAYER HAS NO RETRY BUTTON (a re-run is the Start
                // path), but a silent `desktopOk:false` is the one failure the
                // row would otherwise never mention.
                !windows && typeof vm.desktopError === 'string' && vm.desktopError !== '' && h('div', { style: { ...S.muted, color: T.error } },
                  clean(`Desktop did not finish: ${lastLine(vm.desktopError)} — see the supervisor log.`)),
                // THE RETRY IS A QUEUE, NOT A WAIT: `async: true` makes the
                // supervisor answer at once, so the button re-enables on the
                // next poll instead of hanging for the length of the install.
                // A RETRY NEEDS A FAILURE, NOT A REQUEST. `requested && !installed`
                // is also true during the create window (the job has not written
                // its result yet), where a Retry button offers to re-run work that
                // is already running. `*Ok === false` is only ever written by a
                // finished run that did not pass.
                !windows && vm.provisioning === undefined && (vm.reaOk === false || vm.androidOk === false) && (() => {
                  const steps = [
                    ...(vm.reaRequested === true && vm.rea !== true ? ['rea'] : []),
                    ...(vm.androidRequested === true && vm.android !== true ? ['android'] : [])
                  ]
                  if (steps.length === 0) return null
                  return h('div', { style: S.row },
                    h('button', {
                      type: 'button', style: S.button, disabled: busy,
                      onClick: () => void act(name, `Queuing ${steps.join('+')} install for ${name}…`, 'provision', { name, steps, async: true })
                    }, busy && busyLabel !== null ? busyLabel : 'Retry install')
                  )
                })(),
                // R2: UPDATE AFTER CREATED. A provisioned disk carries version=1
                // in /var/lib/cua-rea, so "re-run the installer" is a no-op there;
                // the op's `update` flag is what moves rea-agents on a disk the
                // user keeps. Gated on the VERIFIED kit: a failed row already
                // offers Retry install, and two buttons for one run would be a
                // choice the panel cannot explain.
                !windows && vm.provisioning === undefined && vm.rea === true && h('div', { style: S.row },
                  h('button', {
                    type: 'button', style: S.button, disabled: busy,
                    title: 'Update rea to the latest; safe to re-run. Re-runs the REA installer past its marker (REA_FORCE_UPDATE=1), so rea-agents moves without deleting the disk.',
                    onClick: () => void act(name, `Updating rea on ${name} to the latest…`, 'provision', { name, steps: ['rea'], async: true, update: true })
                  }, 'Update rea')
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
          field('diskQuotaGb', 'Store quota (GB)', 'Disk quota for the VM store: base image + QEMU + every disk, checkpoint, screenshot and the shared ISO cache. A create that would exceed it is refused before it starts.'),
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
    // V6: the version picker is pure data → label, exported for the same reason:
    // a unit test can prove the 16-code fallback, the xp refusal marker and the
    // stored-alias option without mounting the page.
    module.exports.__test = {
      hideSecretEntry, noteAfterHide, clean,
      windowsCatalogRows, windowsVersionLabel, windowsVersionOptions, WINDOWS_CATALOG_FALLBACK, formatGb,
      // D1: the per-call client budget is ARITHMETIC, so `tests/exec-budget.mjs`
      // can prove it against the route's own resolver without mounting a page.
      clientBudget, CLIENT_TIMEOUTS, CLIENT_EXEC_GRACE_MS, CLIENT_LEAD_MS
    }
    return module.exports
  }
})
