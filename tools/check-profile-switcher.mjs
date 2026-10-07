#!/usr/bin/env node
/**
 * Build gate for the profile-create **chooser** in `dsh-profile-switcher`.
 *
 * WHY THIS EXISTS
 * ---------------
 * "+ New Profile" in the pill used to copy the whole source profile on one click,
 * so a profile made to try something in isolation arrived carrying every plugin of
 * the profile it was created from — invisible until it booted. The click now asks:
 * **Start New** (the stock skeleton) or **Inherit plugins** (the copy).
 *
 * That is a contract across five places a refactor can silently desync:
 *
 *   1. the HOST half — `mode: "new"` must really produce a stock profile (two Web
 *      bundles, no dependencies, no `node_modules`, no copied patch layer), or the
 *      panel's first answer quietly becomes a second copy of the second answer;
 *   2. the HOST half's default — a caller that sends no `mode` (the recovery page,
 *      an older client bundle) must keep getting the copy it always got;
 *   3. the freshness WRITER — the stock skeleton is written by DSH's own
 *      `initProfile` when the image carries one, and by a local copy of the same
 *      three files when it does not. Those two must stay byte-identical, or a
 *      fresh profile differs between channels;
 *   4. the CLIENT half — two answers, both wired to a mode, and a dialog that is
 *      CENTRED rather than attached to the trigger;
 *   5. the CLIENT half's plumbing — the chooser is portaled OUTSIDE the panel, so
 *      the panel's own outside-click guard and its Escape handler must both know
 *      about it (otherwise clicking an answer closes the panel, and the create
 *      with it, before the request is sent).
 *
 * The host half is therefore EXECUTED here — its real HTTP route, driven with a
 * fake carrier over a throwaway `$DSH_HOME` — and the browser half is MOUNTED on a
 * stub React runtime and clicked through, because a browser half that throws on its
 * first render takes the profile control out of the UI for every profile. Both
 * channels are covered: the plugin directory is resolved from whichever root
 * carries it.
 *
 * Usage: node tools/check-profile-switcher.mjs <install-root> [<install-root> …]
 * Set PS_GATE_TRACE=1 to print the rendered panel text after every interaction.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const roots = process.argv.slice(2)
if (roots.length === 0) {
  console.error('usage: node tools/check-profile-switcher.mjs <install-root> [<install-root> ...]')
  process.exit(2)
}

const failures = []
const notes = []
const pass = (name) => notes.push(`ok   ${name}`)
const check = (name, condition, detail) => {
  if (condition) pass(name)
  else failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** The plugin directory, from whichever installation root carries it. */
const pluginDir = roots
  .map((root) => join(root, 'node_modules', 'dsh-profile-switcher'))
  .find((candidate) => existsSync(join(candidate, 'lib', 'index.js')))
check('the plugin is installed in one of the given roots', pluginDir !== undefined, roots.join(', '))
if (pluginDir === undefined) {
  console.error(failures.join('\n'))
  process.exit(1)
}

const hostFile = pathToFileURL(join(pluginDir, 'lib', 'index.js')).href
const clientSource = readFileSync(join(pluginDir, 'lib', 'client.js'), 'utf8')

/** One loaded copy of the host half; the query string gives each phase its own
 * module instance, so the memoised initialiser lookup can be exercised twice. */
async function loadHost(tag) {
  const module = await import(`${hostFile}?${tag}`)
  let handler = null
  const ctx = {
    // The plugin registers its route through ctx.effect(() => ctx.webServer.register(…)).
    effect: (fn) => { fn(); return () => {} },
    webServer: { register: (route) => { handler = route.handler; return () => {} } },
  }
  module.apply(ctx)
  if (typeof handler !== 'function') throw new Error('the host half registered no web route')
  return handler
}

/** Drive the real route with the smallest request/response the plugin uses. */
async function request(handler, action, body) {
  const req = { method: body === undefined ? 'GET' : 'POST', url: `/api/dsh-profile-switcher/${action}` }
  if (body !== undefined) {
    req[Symbol.asyncIterator] = async function* iterator() { yield Buffer.from(JSON.stringify(body), 'utf8') }
  }
  let text = ''
  const res = { statusCode: 200, setHeader() {}, end(chunk) { if (chunk !== undefined && chunk !== null) text += String(chunk) } }
  await handler(req, res)
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    payload = { unparsable: text.slice(0, 200) }
  }
  return { status: res.statusCode, body: payload }
}

/** A home with one real profile: `web`, carrying a third-party plugin and its own
 * patch layer — the things that must NOT follow a profile created with "Start New". */
function seedHome(home) {
  const web = join(home, 'profiles', 'web')
  mkdirSync(join(web, 'node_modules', 'community-plugin'), { recursive: true })
  writeFileSync(join(web, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'community-plugin': '^1.2.3' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'community-plugin'] } },
  }, null, 2)}\n`)
  writeFileSync(join(web, 'cordis.patch.yml'), '# the source profile owns this patch layer\n- id: community-plugin\n')
  writeFileSync(join(web, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  writeFileSync(join(web, 'node_modules', 'community-plugin', 'index.js'), 'export default {}\n')
}

const manifestOf = (home, name) => JSON.parse(readFileSync(join(home, 'profiles', name, 'package.json'), 'utf8'))
const STOCK_FILES = ['cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']

/**
 * Mount the browser half on a stub React runtime.
 *
 * WHY A STUB IS WORTH IT: the pill is mounted for EVERY profile, so a browser half
 * that throws on its first render (a hook used out of order, a value read before
 * its `const` — a class neither a type check nor a static regex can see) takes the
 * whole profile control out of the UI everywhere. This runs the real component,
 * with real hooks and real effects, over a document that captures the listeners the
 * component installs, and clicks the actual path: open the panel, type a name,
 * "+ New Profile", answer the chooser. `fetch` is stubbed so the request the UI
 * really sends can be asserted, and refs are real objects so the chooser/panel
 * containment checks behave the way they do in a browser.
 * @param {string} clientPath - absolute path of the browser half.
 * @returns the harness the checks drive.
 */
function mountPill(clientPath) {
  const source = readFileSync(clientPath, 'utf8')
  const posts = []
  const listeners = new Map()
  const timers = new Set()
  let loaded = null
  let component = null
  let tree = null
  const profiles = [{
    name: 'web', label: null, bundleCount: 2, webCapable: true, active: true, locked: true, deletable: false,
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  }]

  const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })
  const fetchStub = async (url, options = {}) => {
    const target = String(url)
    if (target.endsWith('/list')) {
      return reply({ ok: true, home: '/tmp/home', active: 'web', profiles, safeModeActive: false, boot: null })
    }
    if (target.endsWith('/create')) {
      const body = JSON.parse(options.body)
      posts.push({ url: target, body })
      profiles.push({ name: body.name, label: null, bundleCount: 0, webCapable: true, active: false, locked: false, deletable: true, bundles: null })
      return reply({ ok: true, name: body.name, mode: body.mode, from: body.mode === 'new' ? null : 'web', skeleton: 'app-boot', profiles })
    }
    return reply({ ok: false, error: `unexpected request ${target}` })
  }

  const documentStub = {
    head: { append() {} },
    body: { classList: { add() {}, remove() {} } },
    createElement: () => ({ dataset: {}, isConnected: true, textContent: '', remove() {}, append() {} }),
    getElementById: () => null,
    querySelector: () => null,
    addEventListener: (type, handler) => { const list = listeners.get(type) ?? []; list.push(handler); listeners.set(type, list) },
    removeEventListener: (type, handler) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== handler))
    },
  }
  const windowStub = {
    __ModuleLoader__: { load: (spec) => { loaded = spec } },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
    innerWidth: 1200, innerHeight: 800,
    setInterval: () => ({}), clearInterval() {},
    location: { reload() {}, replace() {}, assign() {} },
    confirm: () => true,
  }

  // ---- the smallest React that can run this component --------------------
  // Effects are QUEUED and flushed after the component body, the way React runs
  // them: an effect that sets state from inside the render would otherwise
  // restart the component mid-body and shift every later hook index.
  const hooks = []
  let cursor = 0
  let pendingEffects = []
  let rendering = false
  let dirty = false
  const render = () => {
    if (rendering) { dirty = true; return }
    rendering = true
    try {
      let guard = 0
      do {
        dirty = false
        cursor = 0
        const queued = []
        pendingEffects = queued
        tree = component({ wide: true })
        pendingEffects = []
        for (const effect of queued) effect()
        guard += 1
      } while (dirty && guard < 100)
    } finally {
      rendering = false
    }
  }
  const refValue = () => {
    const value = {
      isConnected: true,
      focus() {}, click() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
      contains: (candidate) => candidate !== null && typeof candidate === 'object' && candidate.__inside === value,
    }
    return value
  }
  const createElement = (type, props, ...children) => {
    const node = { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
    if (props?.ref !== undefined && props.ref !== null) props.ref.current = refValue()
    return node
  }
  const React = {
    Fragment: Symbol.for('react.fragment'),
    createElement,
    useState: (initial) => {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      const set = (next) => {
        hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next
        render()
      }
      return [hooks[index].value, set]
    },
    useRef: (initial) => {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { current: initial }
      return hooks[index]
    },
    useMemo: (factory) => {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { value: factory() }
      return hooks[index].value
    },
    useCallback: (factory) => {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { value: factory }
      return hooks[index].value
    },
    useEffect: (effect, deps) => {
      const index = cursor++
      const previous = hooks[index]
      const changed = previous === undefined || deps === undefined
        || deps.length !== previous.deps.length || deps.some((dep, position) => dep !== previous.deps[position])
      if (!changed) return
      // The deps are recorded now; the body runs after the component body, and the
      // state it sets must find them already recorded.
      if (typeof previous?.cleanup === 'function') previous.cleanup()
      hooks[index] = { deps }
      pendingEffects.push(() => { hooks[index].cleanup = effect() })
    },
  }
  const requireShim = (name) => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: (node) => node }
    return {}
  }

  const realSetTimeout = globalThis.setTimeout
  // Transitions must not hold the gate open: every timer fires almost at once.
  const setTimeoutStub = (fn, ms) => {
    const id = realSetTimeout(() => { timers.delete(id); fn() }, Math.min(Number(ms) || 0, 10))
    timers.add(id)
    return id
  }
  const clearTimeoutStub = (id) => { timers.delete(id); clearTimeout(id) }
  const rafStub = (fn) => { fn(); return 0 }
  class MutationObserverStub { observe() {} disconnect() {} takeRecords() { return [] } }

  const run = new Function(
    'window', 'document', 'fetch', 'MutationObserver', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'requestAnimationFrame', 'require', `${source}\n`,
  )
  run(windowStub, documentStub, fetchStub, MutationObserverStub, setTimeoutStub, clearTimeoutStub,
    windowStub.setInterval, windowStub.clearInterval, rafStub, requireShim)
  if (loaded === null) throw new Error('the browser half never called window.__ModuleLoader__.load')
  loaded.factory(requireShim).apply({
    effect: (fn) => { fn(); return () => {} },
    slots: {
      inject: (name, callback) => callback(),
      register: (spec, entry) => { component = entry; return () => {} },
    },
  })
  if (component === null) throw new Error('the browser half registered nothing into sidebar.footer.action')
  render()

  const walk = (node, visit) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
    if (node.props === undefined) return
    visit(node)
    walk(node.props.children, visit)
  }
  const flatten = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(flatten).join(' ')
    if (typeof node !== 'object' || node.props === undefined) return ''
    return flatten(node.props.children)
  }
  const findAll = (predicate) => { const found = []; walk(tree, (node) => { if (predicate(node)) found.push(node) }); return found }
  const chooserNode = () => findAll((node) => node.props['aria-modal'] === true)[0]
  const click = (label) => {
    const target = label.startsWith('dsh-ps__')
      ? findAll((node) => node.type === 'button' && node.props.className === label)[0]
      : findAll((node) => node.type === 'button' && flatten(node).includes(label))[0]
    if (target === undefined) throw new Error(`no button matches ${JSON.stringify(label)}`)
    target.props.onClick()
  }
  /** Same lookup, but a missing control is an answer ("not there"), not a crash. */
  const tryClick = (label) => { try { click(label); return true } catch { return false } }
  const settle = () => new Promise((resolve) => realSetTimeout(resolve, 30))
  /** Optional trace (`PS_GATE_TRACE=1`) — a failing wiring check is easier to read
   * with the rendered text than with a stack. */
  const trace = (label) => { if (process.env.PS_GATE_TRACE === '1') console.log(`[trace] ${label}: ${flatten(tree).replace(/\s+/gu, ' ').slice(0, 400)}`) }

  return {
    posts,
    mounted: () => tree !== null,
    text: () => flatten(tree),
    hasChooser: () => chooserNode() !== undefined,
    trace,
    click: (label) => { click(label); trace(`after click ${label}`) },
    tryClick,
    /** Answer the chooser when the answer is there; report it when it is not, so a
     * missing control fails a check WITH the rendered text instead of throwing. */
    answer: async (label) => {
      const clicked = tryClick(label)
      await settle()
      trace(`after answer ${label} (clicked: ${clicked})`)
      return clicked
    },
    /** Type into the name field; `false` when the field is not on screen. */
    type: (value) => {
      const input = findAll((node) => node.type === 'input' && node.props.placeholder === 'new profile name')[0]
      if (input === undefined) return false
      input.props.onChange({ target: { value } })
      trace(`after typing ${value}`)
      return true
    },
    /** The order a browser sends for a click on a chooser answer: pointerdown first. */
    pointerDownInsideChooser: () => {
      const chooser = chooserNode()
      if (chooser === undefined) throw new Error('the chooser is not rendered')
      for (const handler of listeners.get('pointerdown') ?? []) {
        handler({ target: { __inside: chooser.props.ref.current } })
      }
    },
    keydown: (key) => { for (const handler of listeners.get('keydown') ?? []) handler({ key }) },
    settle,
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-profile-gate-'))
const home = join(scratch, 'home')
const emptyRoots = join(scratch, 'no-installation')
mkdirSync(emptyRoots, { recursive: true })

// The host half resolves its home per call; DSH_REAL_HOME (Safe Mode) must be
// absent or the panel would manage a different directory than the one under test.
delete process.env.DSH_REAL_HOME
delete process.env.DSH_INSTALL_ROOTS
process.env.DSH_HOME = home
seedHome(home)

try {
  // ---- the host half, with the image's own initialiser -------------------
  const handler = await loadHost('default')
  const listed = await request(handler, 'list')
  check('list reports the seeded `web` profile as active and web-capable',
    listed.status === 200
      && listed.body?.active === 'web'
      && listed.body?.profiles?.some((profile) => profile.name === 'web' && profile.webCapable === true),
    `${listed.status} ${JSON.stringify(listed.body?.active)}`)

  // An older caller sends no mode: it must still get the copy.
  const legacy = await request(handler, 'create', { name: 'legacy', from: 'web' })
  check('create without a mode still COPIES the source (older callers keep working)',
    legacy.status === 200 && legacy.body?.mode === 'inherit' && legacy.body?.from === 'web',
    `${legacy.status} ${JSON.stringify(legacy.body?.error ?? legacy.body?.mode)}`)
  check('the copy carries the source plugin and its patch layer',
    existsSync(join(home, 'profiles', 'legacy', 'node_modules', 'community-plugin', 'index.js'))
      && readFileSync(join(home, 'profiles', 'legacy', 'cordis.patch.yml'), 'utf8').includes('community-plugin'),
    'the copied profile is missing the source plugin or its patch layer')

  const inherited = await request(handler, 'create', { name: 'branch', from: 'web', mode: 'inherit' })
  check('create mode=inherit answers mode/from and copies the plugin set',
    inherited.status === 200 && inherited.body?.mode === 'inherit' && inherited.body?.from === 'web'
      && manifestOf(home, 'branch').dsh.profile.bundles.includes('community-plugin'),
    `${inherited.status} ${JSON.stringify(inherited.body?.error ?? inherited.body)}`)

  const fresh = await request(handler, 'create', { name: 'fresh', mode: 'new' })
  const freshDir = join(home, 'profiles', 'fresh')
  check('create mode=new answers mode/from and names the writer it used',
    fresh.status === 200 && fresh.body?.mode === 'new' && fresh.body?.from === null
      && ['app-boot', 'template'].includes(fresh.body?.skeleton),
    `${fresh.status} ${JSON.stringify(fresh.body?.error ?? fresh.body)}`)
  check('a "Start New" profile holds ONLY the stock skeleton',
    JSON.stringify(readdirSync(freshDir).sort()) === JSON.stringify(STOCK_FILES),
    JSON.stringify(readdirSync(freshDir)))
  const freshManifest = manifestOf(home, 'fresh')
  check('its manifest carries the two Web bundles and no dependencies',
    JSON.stringify(freshManifest.dsh.profile.bundles) === JSON.stringify(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
      && JSON.stringify(freshManifest.dependencies) === '{}',
    JSON.stringify({ bundles: freshManifest.dsh.profile.bundles, dependencies: freshManifest.dependencies }))
  check('nothing of the source followed it (no plugin, no patch layer, no node_modules)',
    !existsSync(join(freshDir, 'node_modules'))
      && !readFileSync(join(freshDir, 'cordis.patch.yml'), 'utf8').includes('community-plugin')
      && !readFileSync(join(freshDir, 'package.json'), 'utf8').includes('community-plugin'))
  check('it is web-capable, so the pill can switch to it',
    (await request(handler, 'list')).body?.profiles
      ?.some((profile) => profile.name === 'fresh' && profile.webCapable === true && profile.active === false) === true)
  check('its pnpm settings are the hoisted linker out-of-tree plugins need',
    readFileSync(join(freshDir, 'pnpm-workspace.yaml'), 'utf8').includes('nodeLinker: hoisted'))

  // ---- refusals: a bad ask must not leave a directory behind -------------
  const unknownMode = await request(handler, 'create', { name: 'bad-mode', mode: 'copy' })
  check('an unknown mode is refused with 400 and writes nothing',
    unknownMode.status === 400 && !existsSync(join(home, 'profiles', 'bad-mode')),
    `${unknownMode.status} ${JSON.stringify(unknownMode.body?.error)}`)
  const badName = await request(handler, 'create', { name: '../escape', mode: 'new' })
  check('an invalid name is refused with 400', badName.status === 400, `${badName.status}`)
  const duplicate = await request(handler, 'create', { name: 'fresh', mode: 'new' })
  check('an existing name is refused with 400', duplicate.status === 400, `${duplicate.status}`)

  // ---- the same ask with NO installation to borrow the initialiser from ---
  const fallbackHandler = await loadHost('fallback')
  check('the installation roots are overridable (the fallback path is reachable at all)',
    process.env.DSH_INSTALL_ROOTS === undefined)
  process.env.DSH_INSTALL_ROOTS = emptyRoots
  const fallback = await request(fallbackHandler, 'create', { name: 'fresh-fallback', mode: 'new' })
  check('with no initialiser the host half writes the local skeleton itself',
    fallback.status === 200 && fallback.body?.skeleton === 'template',
    `${fallback.status} ${JSON.stringify(fallback.body?.error ?? fallback.body?.skeleton)}`)
  const fallbackDir = join(home, 'profiles', 'fresh-fallback')
  check('that skeleton is the same three files',
    JSON.stringify(readdirSync(fallbackDir).sort()) === JSON.stringify(STOCK_FILES),
    JSON.stringify(readdirSync(fallbackDir)))
  if (fresh.body?.skeleton === 'app-boot') {
    // The real drift check: the local copy must be identical to what DSH's own
    // initialiser writes, or a fresh profile would differ between the channels.
    // The manifest is compared without its `name` (each profile's is its own).
    const withoutName = (dir) => {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      delete manifest.name
      return JSON.stringify(manifest)
    }
    const differing = STOCK_FILES.filter((name) => name === 'package.json'
      ? withoutName(freshDir) !== withoutName(fallbackDir)
      : readFileSync(join(freshDir, name), 'utf8') !== readFileSync(join(fallbackDir, name), 'utf8'))
    check('the local skeleton is byte-identical to the initialiser\'s output', differing.length === 0,
      `differing: ${differing.join(', ')}`)
    check('both writers name the manifest after the profile directory',
      manifestOf(home, 'fresh').name === 'dsh-profile-fresh'
        && manifestOf(home, 'fresh-fallback').name === 'dsh-profile-fresh-fallback',
      `${manifestOf(home, 'fresh').name} / ${manifestOf(home, 'fresh-fallback').name}`)
  } else {
    notes.push('SKIP the initialiser-drift comparison — this image carries no loadable dsh-app-boot (the runtime would use the local skeleton, so there is nothing to compare against)')
  }
  // Back to the defaults before the browser-half phase, so nothing that follows
  // depends on the root override this phase used.
  delete process.env.DSH_INSTALL_ROOTS

  // ---- the client half: the chooser must exist and be wired --------------
  const clientChecks = [
    ['the chooser offers both answers', /'Start New'/.test(clientSource) && /'Inherit plugins'/.test(clientSource)],
    ['each answer creates with its own mode', /createProfile\('new'\)/.test(clientSource) && /createProfile\('inherit'\)/.test(clientSource)],
    ['the create request carries the mode', /call\('create',\s*\{\s*name,\s*from:\s*source,\s*mode\s*\}\)/.test(clientSource)],
    ['"+ New Profile" and Enter open the chooser instead of creating',
      /onClick: openChooser/.test(clientSource) && /event\.key === 'Enter'\) openChooser\(\)/.test(clientSource)
      && !/void createProfile\(\)/.test(clientSource)],
    ['the dialog is CENTRED over the page', /transform: 'translate\(-50%, -50%\)'/.test(clientSource)],
    ['it is announced as a modal dialog', /'aria-modal': true/.test(clientSource) && /role: 'dialog'/.test(clientSource)],
    ['the panel ignores clicks that land in the chooser', /chooserRef\.current\?\.contains\(target\)/.test(clientSource)],
    ['Escape answers the chooser before it closes the panel', /if \(choice !== null\) \{ setChoice\(null\); return \}/.test(clientSource)],
    ['closing the panel also drops the chooser',
      /const hide = React\.useCallback\(\(\) => \{[\s\S]{0,400}?setChoice\(null\)[\s\S]{0,120}?setEntered\(false\)/.test(clientSource)],
  ]
  for (const [name, ok] of clientChecks) check(name, ok)

  const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
  check('the plugin still declares its browser half',
    manifest.dsh?.client !== undefined, JSON.stringify(manifest.dsh ?? {}))

  // ---- the client half, RENDERED -----------------------------------------
  // The pill is mounted for EVERY profile, so a client half that throws on its
  // first render would take the profile control out everywhere — and the static
  // checks above cannot see that. This mounts it on a stub React runtime (hooks,
  // effects, refs, a document with listener capture) and clicks the real path:
  // open the panel, type a name, "+ New Profile", answer the chooser.
  const pill = mountPill(join(pluginDir, 'lib', 'client.js'))
  check('the pill renders and registers into the sidebar slot', pill.mounted() === true)
  pill.tryClick('dsh-ps__trigger')
  check('opening the pill lists the profiles', pill.text().includes('Available Profiles'))
  check('the panel offers a name field', pill.type('test') === true)
  pill.tryClick('+ New Profile')
  check('"+ New Profile" opens the chooser with both answers',
    pill.hasChooser() && pill.text().includes('Start New') && pill.text().includes('Inherit plugins'),
    pill.text().slice(0, 200))
  check('the chooser names the profile being created', pill.text().includes('Create profile “test”'))
  // The chooser is portaled OUTSIDE the panel, so this exact click order is what
  // a browser sends: pointerdown on document (capture) first, then the click. If
  // the panel's outside-click guard did not know about the chooser, the panel
  // would close here and the click would never reach the answer.
  pill.pointerDownInsideChooser()
  check('a pointerdown inside the chooser leaves panel and chooser mounted',
    pill.hasChooser() && pill.text().includes('Available Profiles'))
  const startedNew = await pill.answer('Start New')
  check('"Start New" creates the profile with mode=new',
    startedNew && pill.posts.length === 1 && pill.posts[0].body.mode === 'new'
      && pill.posts[0].body.name === 'test' && pill.posts[0].body.from === 'web',
    JSON.stringify(pill.posts))
  check('the chooser closes and the panel reports what was created',
    !pill.hasChooser() && pill.text().includes('as a new profile'))

  pill.type('branch')
  pill.tryClick('+ New Profile')
  const inheritedAgain = await pill.answer('Inherit plugins')
  check('"Inherit plugins" creates the profile with mode=inherit',
    inheritedAgain && pill.posts.length === 2 && pill.posts[1].body.mode === 'inherit' && pill.posts[1].body.name === 'branch',
    JSON.stringify(pill.posts.map((post) => post.body)))

  pill.type('web')
  pill.tryClick('+ New Profile')
  check('a name that already exists is refused before the chooser opens',
    !pill.hasChooser() && pill.text().includes('already exists'))
  pill.type('Bad Name')
  pill.tryClick('+ New Profile')
  check('an unusable name is refused before the chooser opens',
    !pill.hasChooser() && pill.text().includes('cannot be a profile name'))

  pill.type('escape-test')
  pill.tryClick('+ New Profile')
  pill.keydown('Escape')
  check('Escape cancels the chooser without closing the panel behind it',
    !pill.hasChooser() && pill.text().includes('Available Profiles'))
  pill.keydown('Escape')
  await pill.settle()
  check('a second Escape closes the panel itself', pill.text().includes('Available Profiles') === false,
    pill.text().slice(0, 120))
} finally {
  delete process.env.DSH_INSTALL_ROOTS
  rmSync(scratch, { recursive: true, force: true })
}

for (const note of notes) console.log(`[profile-switcher] ${note}`)
if (failures.length > 0) {
  console.error(`[profile-switcher] FAILED — ${failures.length} check(s):`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
const ran = notes.filter((note) => note.startsWith('ok ')).length
console.log(`[profile-switcher] ok — ${ran} checks passed in ${pluginDir}`)
