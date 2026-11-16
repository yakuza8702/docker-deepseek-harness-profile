import net, { createConnection } from 'node:net'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createDshCuaClient, windowsMcpEnabled } from './win-mcp.js'

export const name = 'cua-vm'
export const inject = ['tools', 'systemPrompt', 'webServer']

/**
 * The VM store lives outside the workspace; the socket lives in /tmp, which is
 * the only other path `workspace-write` grants. Nothing here opens /dev/kvm —
 * the supervisor does that, before any session exists.
 */
export const Config = z.object({
  socketPath: z.string().min(1).default('/tmp/cua-vm/supervisor.sock').description(
    'Unix socket of the cua-vm-supervisor started by the container entrypoint.'
  ),
  workspaceRoot: z.string().min(1).default('/workspace').description(
    'The only host tree the VM tools may read or write. Paths outside it are refused by the supervisor.'
  ),
  defaultTier: z.string().min(1).default('slim').description('Image tier used by vm_ensure when the model does not name one.'),
  defaultCpu: z.number().step(1).min(1).max(16).default(2),
  defaultMemory: z.number().step(1).min(1).max(64).default(4),
  maxOutputChars: z.number().step(1).min(512).max(200000).default(8000)
})

const TOOL_TIMEOUT_MS = 1_800_000

/** One request per connection: write a JSON line, read a JSON line. */
function request(socketPath, payload, timeoutMs = TOOL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    let buffer = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, new Error(`cua-vm supervisor did not answer within ${timeoutMs} ms`)), timeoutMs)
    timer.unref?.()

    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      if (buffer.includes('\n')) {
        try {
          const answer = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
          if (answer.ok) finish(resolve, answer)
          else finish(reject, new Error(answer.error || 'cua-vm supervisor refused the request'))
        } catch (error) {
          finish(reject, error)
        }
      }
    })
    socket.on('error', (error) => finish(reject, error))
    socket.on('close', () => {
      if (!settled) finish(reject, new Error('cua-vm supervisor closed the connection without an answer'))
    })
  })
}

function clamp(text, limit) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n… [truncated ${value.length - limit} chars]`
}

const textOutput = (description) => ({
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      text: { type: 'string', description }
    },
    required: ['text']
  },
  render: (_args, value) => [{ type: 'text', text: value.text }]
})

/**
 * The prompt the model always reads. Kept as lines so the REA paragraph can be
 * appended as one more sentence-pair, not rewrapped by hand.
 */
const CUA_PROMPT_LINES = [
  'This workspace has a personal Linux computer (a QEMU VM) driven by `cua_vm_*`; the user manages theirs in Plugins → Personal VM.',
  'Treat it as your own machine: install what the task needs there (apt, npm, pip, SDKs), build and test there, copy the artifact back with `cua_vm_get`, never install project toolchains into the harness image.',
  'Its `/workspace` is this same directory over 9p (files appear on both sides); if the share is missing, `cua_vm_put`/`cua_vm_get` still copy.',
  'Build inside the VM, not over the share, for thousand-file builds: copy the source to /tmp/build (or /home/cua/build), build, copy the artifact back — 9p carries source and results, not object files.',
  'Drive the desktop with `cua_vm_gui`: screenshot, click, type, hotkeys, drag, scroll, `zoom` to crop.',
  'COORDINATES: x/y is a pixel in the screenshot you just took, origin top-left; `cua_vm_gui` maps it to the display, so click the pixel you see — never rescale, never offset — the desktop is 1200x750.',
  'Choose deliberately: the shell for anything a command can do (gradle, adb, blender -b, apt, tests), the desktop for visual work or when the user says show me, click or test the UI.',
  'Before clicking, take the position from `a11y` (element bounds) or `windows`, then screenshot to confirm; without vision, trust the a11y bounds over guessed pixels.',
  'Before creating a computer, ask with `ask_user_question` for name, vCPU/RAM and image unless the user said so — never invent a spec silently — and say Debian and Arch need a built Cua disk, not a substitute image.',
  'For Android, Blender, WebGL or 3D work create it with `gpu: true` unless told otherwise (say so if the image or host cannot); an Android app is `cua_vm_create` with gpu, cpu 4, memory 8, diskGb 40, then `cua_vm_android` once (SDK + AVD), `cua-emulator` (`-no-window` for adb tests), `adb devices` before the APK, `cua_vm_exec` → `ls -l /dev/kvm` for nested KVM.',
  'On a GPU computer Xorg runs on virgl and reports OpenGL 4.3 (Mesa under-reports 4.2; the session lifts it); if an app refuses, check `cua_vm_gui geometry` or `glxinfo -B`, and use `LIBGL_ALWAYS_SOFTWARE=1` (llvmpipe, slower) only as a genuine, stated fallback.',
  'SPACE: the screenshot and the click share ONE space, and the tool measures it — every desktop result prints `screenshot WxH · display WxH · scale N`. When scale is 1 (a 1200x750 desktop) image pixels are display pixels; when it is not, the result says `image px = 0.9375 × display px; cua maps it — do not rescale`, and that is literal: click the pixel you see, never multiply it.',
  'SHUTDOWN vs SUSPEND: `cua_vm_shutdown` is a real ACPI powerdown, then a checkpoint, then the sandbox is removed (`state: powered-off`); `cua_vm_start` cold-boots from that checkpoint — do NOT expect `sb resume` to work on a powered-off computer, that is the trap the split exists for. `cua_vm_suspend` keeps the sandbox and resumes instantly. Neither happens on its own: the computer runs until the user asks.',
  'WINDOWS (`kind: "windows"`, direct QEMU + OVMF/TPM2): exec/put/get work over the guest OpenSSH server like the Linux computer (Session 0, cmd.exe, `C:\\` paths); the desktop is `cua_vm_gui` over QMP and the LIVE VIEW at /vm/port/<name>/ (noVNC), where a human can drive the same screen. Its GPU is a virtio-gpu with NO Windows 3D driver: Direct3D falls back to WARP (CPU), so do not promise hardware acceleration; there is no mouse-cursor overlay on this path (the real pointer is in the frame). QMP typing is ASCII-only and there is no clipboard, no accessibility tree and no window list — for element-level work use the dsh-cua tools when the guest advertises them. It cannot take `rea: true` or `android: true`; the generated password is per computer (Reveal), and SSH keys are per computer too.',
  'If a tool reports no VM, call `cua_vm_ensure` once, then `cua_vm_exec`.',
  'For reverse-engineering work — a feature to reimplement, a suspicious binary, an APK, an Electron app, a model file — create the computer with `rea: true` (and let the disk be at least 40 GB); REA is not installed on a computer created without it, and installing it by hand inside a 20 GB disk is the wrong fix.'
]

const CUA_PROMPT_BASE = CUA_PROMPT_LINES.join(' ')

/**
 * REA awareness, appended only when `reaCache` knows a computer has the kit.
 * Six sentences: where it is, how to call it, the analysis verbs, the coverage
 * the JSON actually proves, how to report evidence, and where the engine lives.
 */
function reaParagraph(names) {
  const where = names.length === 1 ? `the computer ${names[0]}` : `the computers ${names.join(', ')}`
  return [
    `REA (\`rea\`, Reverse Engineer Anything) is installed in ${where} and is the right tool for "how does this app work, show me the evidence".`,
    'Run it through `cua_vm_exec`, never from the harness shell: `rea --help`, then `rea doctor --json` and `rea doctor --provider ghidra --json` before trusting an analysis.',
    'Analysis verbs: `rea analyze ghidra` for a native binary, `rea search --kind procedures` to find a symbol, `rea analyze-javascript-application` for a JS or Electron tree, `rea inspect-managed-artifact` and `rea inspect-managed-members` for .NET, `rea inspect-android-package`, `rea search-android-classes`, `rea inspect-android-method` and `rea trace-android-references` for an APK, `rea inspect-analysis-view` to page through whatever was already analyzed.',
    'Coverage comes from the JSON, not from a hunch: `analyze ghidra`, `search --kind procedures`, `analyze-javascript-application`, `inspect-managed-artifact`, `inspect-managed-members`, `inspect-android-package`, `search-android-classes`, `inspect-android-method`, `trace-android-references`, `inspect-analysis-view` — each one answers what it ran on and what it could not see.',
    'Read the JSON, not the banner: state only what the evidence supports, name the unknowns explicitly, and when an output is large write it to a file and page it with `rea inspect-analysis-view` instead of pasting it.',
    'Static JavaScript and .NET need no native engine, so only native work needs Ghidra — the provider here — and a provider error is usually a missing or relative `GHIDRA_INSTALL_DIR` path; build and test the reimplementation in the same computer, then copy the artifact back with `cua_vm_get`.'
  ].join(' ')
}

export function apply(ctx, config = {}) {
  const socketPath = config.socketPath ?? '/tmp/cua-vm/supervisor.sock'
  const workspaceRoot = config.workspaceRoot ?? '/workspace'
  const defaultTier = config.defaultTier ?? 'slim'
  const defaultCpu = config.defaultCpu ?? 2
  const defaultMemory = config.defaultMemory ?? 4
  const maxOutputChars = config.maxOutputChars ?? 8000

  const call = (payload) => request(socketPath, payload)

  /**
   * REA AWARENESS IS GATED, NOT FREE.
   *
   * A paragraph telling the model to reach for Ghidra is worth its tokens on a
   * reverse-engineering turn and is noise on every other one — worse, it would
   * point at a `rea` binary the computer does not have. So the paragraph is
   * appended only while a computer in this registry carries `rea: true`, and
   * the answer comes from a cache filled out of band: the prompt path reads
   * `reaCache.vms` synchronously and never touches the socket. A refresh that
   * runs anyway (30 s TTL, on /cua/state, after create/start/delete) is a
   * single `vmList`, so a non-REA workspace pays zero prompt-path cost.
   */
  const REA_CACHE_TTL_MS = 30_000
  const reaCache = { at: 0, vms: [] }

  /** The registry is `{ name: meta }`; a computer opts in with `rea: true`. */
  function rememberRea(registry) {
    reaCache.vms = Object.entries(registry ?? {})
      .filter(([, vm]) => vm?.rea === true)
      .map(([name]) => name)
      .sort()
    reaCache.at = Date.now()
  }

  async function refreshReaCache() {
    try {
      rememberRea((await call({ op: 'vmList' })).registry)
    } catch {
      // A supervisor that is not up yet must not make every assembly retry:
      // back the same 30 s window off, and keep the names already known.
      reaCache.at = Date.now()
    }
  }

  /**
   * THE dsh-cua TOOLS OF A WINDOWS COMPUTER, ATTACHED ONLY WHILE IT IS THE ONE.
   *
   * A Windows guest is reachable over SSH, and inside it `dsh-cua` drives the
   * desktop from the INTERACTIVE session (pywinauto cannot see windows from
   * Session 0). Its MCP tool list is what makes element-level work cheap:
   * `find_elements` + `type_text` return a receipt ("action_sent",
   * "effect_verified") in a few hundred bytes, where the screenshot loop costs a
   * PNG per attempt.
   *
   * The registration is DYNAMIC and EPHEMERAL:
   *   * nothing is written to the profile, ever;
   *   * tools exist only while a `kind: "windows"` computer is `ready`;
   *   * switching or deleting the computer disposes them;
   *   * DSH_CUA_VM_WIN_MCP=0 disables the whole path.
   *
   * COST: the guest's schema is ~3-8k tokens while it is attached, which is why
   * it is not attached to a Linux-only workspace at all.
   */
  // `inflight` is the guard, not `at`: a connect can take up to 45 s while the
  // beat is 5 s, so without it two ticks race into two SSH sessions and register
  // every tool twice (the second registration throws, the first leaks).
  const WIN_MCP = { name: '', client: null, disposers: [], inflight: null, reason: 'not attempted' }

  function detachWindowsMcp(reason) {
    for (const dispose of WIN_MCP.disposers.splice(0)) {
      try { dispose() } catch { /* the tool registry may already be gone */ }
    }
    WIN_MCP.client?.close()
    WIN_MCP.client = null
    if (WIN_MCP.name !== '') console.log(`[cua-vm] windows MCP detached (${reason})`)
    WIN_MCP.name = ''
    WIN_MCP.reason = reason
  }

  async function attachWindowsMcp() {
    if (WIN_MCP.inflight !== null) return WIN_MCP.inflight
    WIN_MCP.inflight = (async () => {
      if (!windowsMcpEnabled()) {
        detachWindowsMcp('disabled (DSH_CUA_VM_WIN_MCP=0)')
        return
      }
    let target = null
    try {
      const answer = await call({ op: 'vmWindowsMcp', name: '' })
      target = answer?.available === true ? answer : null
    } catch (error) {
      detachWindowsMcp(`no ready Windows computer (${error?.message ?? error})`)
      return
    }
    if (target === null) {
      detachWindowsMcp('no ready Windows computer')
      return
    }
    if (WIN_MCP.name === target.name && WIN_MCP.client?.state.connected === true) return
    detachWindowsMcp('switching computers')
    const client = createDshCuaClient({
      name: target.name,
      sshPort: target.sshPort,
      keyPath: target.keyPath,
      user: target.user ?? 'cua',
      timeoutMs: 45000
    })
    try {
      const session = await client.connect()
      WIN_MCP.client = client
      WIN_MCP.name = target.name
      for (const tool of session.tools) {
        const publicName = `cua_win__${String(tool.name).replace(/[^A-Za-z0-9_]/gu, '_')}`
        const dispose = ctx.effect(() => ctx.tools.register({
          name: publicName,
          description: `${tool.description ?? tool.name} (dsh-cua, Windows computer ${target.name})`,
          parameters: tool.inputSchema ?? { type: 'object', additionalProperties: true, properties: {} },
          output: textOutput('The guest tool result as JSON.'),
          async execute(args = {}) {
            const result = await client.callTool(tool.name, args)
            return { text: JSON.stringify(result) }
          }
        }), `cua-vm: windows mcp ${publicName}`)
        if (typeof dispose === 'function') WIN_MCP.disposers.push(dispose)
      }
      WIN_MCP.reason = `attached (${session.tools.length} tool(s))`
      console.log(`[cua-vm] windows MCP attached to ${target.name} (${session.tools.length} tool(s))`)
    } catch (error) {
      client.close()
      WIN_MCP.reason = `attach failed: ${error?.message ?? error}`
      console.log(`[cua-vm] windows MCP NOT attached: ${error?.message ?? error}`)
    }
    })().finally(() => { WIN_MCP.inflight = null })
    return WIN_MCP.inflight
  }

  /**
   * The Personal VM page's own API. It speaks the same socket as the tools, so
   * the page and the model can never disagree about a computer's state.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/cua',
    handler: async (req, res) => {
      const action = new URL(req.url ?? '/cua', 'http://localhost').pathname.replace(/^\/cua\/?/u, '')
      const send = (status, payload) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(payload))
      }
      const body = async () => {
        if (req.method !== 'POST') return {}
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const raw = Buffer.concat(chunks).toString('utf8')
        return raw === '' ? {} : JSON.parse(raw)
      }
      try {
        switch (action) {
          case 'state': {
            const [config, list] = await Promise.all([call({ op: 'configGet' }), call({ op: 'vmList' })])
            // The page polls this every few seconds while a machine starts, so
            // it is also the cheapest place to keep the REA cache warm.
            rememberRea(list.registry)
            return send(200, {
              ok: true,
              config: config.config,
              usedBytes: config.usedBytes,
              vms: list.registry,
              // The panel hides the Windows kind when the backend is off, so the
              // option never becomes a button that answers "disabled".
              windows: list.windows ?? { ok: false, reason: 'the supervisor is older than this plugin' }
            })
          }
          case 'config': return send(200, { ok: true, ...(await call({ op: 'configSet', config: await body() })) })
          case 'create': {
            const answer = await call({ op: 'vmCreate', ...(await body()) })
            // A computer created with `rea: true` is provisioned by the time
            // this answers, so the awareness paragraph can appear at once
            // instead of up to 30 s later.
            void refreshReaCache()
            return send(200, { ok: true, ...answer })
          }
          case 'start': {
            const answer = await call({ op: 'vmStart', ...(await body()) })
            void refreshReaCache()
            return send(200, { ok: true, ...answer })
          }
          case 'shutdown': {
            const answer = await call({ op: 'vmShutdown', ...(await body()) })
            return send(200, { ok: true, ...answer })
          }
          case 'gc': return send(200, { ok: true, ...(await call({ op: 'vmGc', ...(await body()) })) })
          case 'doctor': return send(200, { ok: true, ...(await call({ op: 'vmDoctor' })) })
          case 'space': return send(200, { ok: true, ...(await call({ op: 'vmSpace', ...(await body()) })) })
          case 'windowsStatus': return send(200, { ok: true, ...(await call({ op: 'vmWindowsStatus', ...(await body()) })) })
          // The generated Windows password, on demand only: the row carries a
          // `credentials: true` flag, the secret stays in the 0600 file.
          case 'windowsPassword': return send(200, { ok: true, ...(await call({ op: 'vmWindowsPassword', ...(await body()) })) })
          case 'stop': return send(200, { ok: true, ...(await call({ op: 'stop', ...(await body()) })) })
          case 'delete': {
            const answer = await call({ op: 'vmDelete', ...(await body()) })
            // Deleting the last REA computer has to take the paragraph with it.
            void refreshReaCache()
            return send(200, { ok: true, ...answer })
          }
          case 'exec': return send(200, { ok: true, ...(await call({ op: 'exec', ...(await body()) })) })
          case 'metrics': return send(200, { ok: true, ...(await call({ op: 'vmMetrics', ...(await body()) })) })
          case 'view': return send(200, { ok: true, ...(await call({ op: 'view', ...(await body()) })) })
          case 'screenshot': return send(200, { ok: true, ...(await call({ op: 'screenshot', ...(await body()) })) })
          case 'input': return send(200, { ok: true, ...(await call({ op: 'input', ...(await body()) })) })
          case 'gui': return send(200, { ok: true, ...(await call({ op: 'gui', ...(await body()) })) })
          case 'pointer': return send(200, { ok: true, ...(await call({ op: 'pointer', ...(await body()) })) })
          default: return send(404, { ok: false, error: `unknown action: ${action}` })
        }
      } catch (error) {
        return send(503, { ok: false, error: String(error?.message ?? error) })
      }
    }
  }), 'cua-vm: page api')

  ctx.systemPrompt.section({
    name: 'tool:cua_vm',
    order: 120,
    // Synchronous by construction: the cache may be up to 30 s old, and a
    // prompt must never wait on a socket. A stale read schedules the refresh
    // and answers from what it already knows.
    text: () => {
      if (Date.now() - reaCache.at > REA_CACHE_TTL_MS) void refreshReaCache()
      return reaCache.vms.length === 0 ? CUA_PROMPT_BASE : CUA_PROMPT_BASE + ' ' + reaParagraph(reaCache.vms)
    }
  })

  // Keep the cache warm even for a session that never opens the page: one
  // vmList every 30 s, unref'd so it can never hold the process open, and
  // cleared with the plugin. The initial fill is the same call.
  ctx.effect(() => {
    void refreshReaCache()
    const timer = setInterval(() => { void refreshReaCache() }, REA_CACHE_TTL_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'cua-vm: rea awareness cache')

  // The Windows MCP tools are attached by the same 30 s beat: one socket call
  // when there is nothing to attach, one SSH handshake when a Windows computer
  // becomes ready, and a disposal the moment it stops being ready.
  ctx.effect(() => {
    void attachWindowsMcp()
    // FIVE SECONDS, not the 30 s cache beat: a shutdown or a delete must take the
    // guest's tools away promptly — a model that calls `cua_win__*` against a
    // stopped computer gets a confusing SSH failure, and 30 s of that is long
    // enough to blame the wrong thing.
    const timer = setInterval(() => { void attachWindowsMcp() }, 5000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => {
      clearInterval(timer)
      detachWindowsMcp('plugin disposed')
    }
  }, 'cua-vm: windows mcp (lazy)')

  ctx.tools.register({
    name: 'cua_vm_status',
    description: 'VM for this workspace: state, spec, last command.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: textOutput('Human-readable VM status.'),
    async execute() {
      const status = await call({ op: 'status' })
      const vms = status.registry || {}
      const entries = Object.entries(vms)
      if (entries.length === 0) return { text: 'No VM has been created yet. Use cua_vm_ensure to create one.' }
      // A WINDOWS COMPUTER'S INSTALL IS POLLABLE FROM HERE TOO (B3): the row
      // alone says "installing"; `vmWindowsStatus` answers the same sentence the
      // panel shows (elapsed, the serial tail, the readiness signals) in ONE
      // small call, so an agent can watch an install without reading the log.
      const live = {}
      for (const [name, vm] of entries) {
        if (vm?.kind !== 'windows' || vm?.state !== 'installing') continue
        try {
          live[name] = await call({ op: 'vmWindowsStatus', name, tail: 5 })
        } catch {
          // A status poll may fail while the supervisor restarts; the row is
          // still worth printing.
        }
      }
      const lines = entries.map(([name, vm]) => {
        const info = live[name] ?? null
        return [
          `${name} (${vm.state || 'unknown'})`,
          `workspace=${vm.workspace}`,
          vm.kind === 'windows' ? null : `tier=${vm.tier}`,
          `cpu=${vm.cpu}`,
          `memory=${vm.memory}GB`,
          vm.diskGb > 0 ? `disk=${vm.diskGb}GB` : null,
          vm.kind === 'windows' ? `windows=${vm.windowsVersion || 'ISO'}` : null,
          vm.lastUsed ? `lastUsed=${vm.lastUsed}` : null,
          vm.rea === true ? 'rea=yes' : null,
          vm.lastCommand ? `lastCommand=${vm.lastCommand}` : null,
          vm.kind === 'windows' && info?.installDetail ? `install: ${info.installDetail}` : null,
          vm.kind === 'windows' && Array.isArray(info?.serialTail) && info.serialTail.length > 0
            ? `serial (last ${info.serialTail.length}): ${info.serialTail.join(' | ')}`
            : null,
          vm.kind === 'windows' && info?.operationalNote ? info.operationalNote : null
        ].filter(Boolean).join(' · ')
      })
      return { text: lines.join('\n') }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_ensure',
    description: 'Create or resume the workspace VM. Idempotent; the first call downloads the image.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        workspace: { type: 'string', description: 'Workspace path (default: root).' },
        tier: { type: 'string', enum: ['slim', 'full'], description: 'slim (default) or full.' },
        cpu: { type: 'integer', minimum: 1, maximum: 16 },
        memory: { type: 'integer', minimum: 1, maximum: 64, description: 'Guest memory in GB.' },
        waitForDesktop: { type: 'boolean', description: 'Wait for the desktop, not just the daemon.' },
        // The whole spec travels, not just tier/cpu/memory: a computer born
        // from "the first cua_vm_exec" used to record no image and no gpu, and
        // a rebuild then brought it back without them.
        image: { type: 'string', description: 'Image reference for a NEW computer (default "linux").' },
        gpu: { type: 'boolean', description: 'virgl GPU. Omit to take the host default (virgl when DSH_CUA_VM_GPU enables it); false forces llvmpipe.' },
        diskGb: { type: 'number', description: 'Disk size in GB for a new computer (Android and REA: 40).' },
        android: { type: 'boolean', description: 'Install the Android SDK + AVD on a new computer.' },
        rea: { type: 'boolean', description: 'Install the REA kit on a new computer (needs a 40 GB disk).' }
      }
    },
    output: textOutput('Creation result and the VM name to use in later calls.'),
    async execute(args = {}) {
      const result = await call({
        op: 'ensure',
        workspace: args.workspace ?? workspaceRoot,
        tier: args.tier ?? defaultTier,
        cpu: args.cpu ?? defaultCpu,
        memory: args.memory ?? defaultMemory,
        waitDesktop: args.waitForDesktop === true,
        image: args.image,
        gpu: args.gpu,
        diskGb: args.diskGb,
        android: args.android === true,
        rea: args.rea === true
      })
      const gpuNote = result.gpu === true ? ' with a GPU (virgl)' : ''
      return { text: `${result.created ? 'Created' : 'Resumed'} ${result.name} (tier=${result.tier}, state=${result.state}${gpuNote}). Use this name with cua_vm_exec.` }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_create',
    description: 'New computer: name, kind, vCPU, RAM, image, gpu, diskGb, android, rea (Windows: windowsVersion/windowsIso). Ask the user for the spec first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Computer name: lowercase letters, digits and dashes.' },
        kind: { type: 'string', enum: ['linux', 'windows'], description: 'linux (default, the Cua guest) or windows (direct QEMU with OVMF/TPM2; exec/put/get work over SSH, the desktop is QMP plus a noVNC live view).' },
        cpu: { type: 'number', description: 'vCPUs (default 2; Windows floors at 2).' },
        memory: { type: 'number', description: 'RAM in GB (default 4; Windows floors at 6).' },
        image: { type: 'string', description: 'Image reference. Default "linux" (Ubuntu 24.04 slim Cua disk). Linux only.' },
        gpu: { type: 'boolean', description: 'virgl GPU for 3D/Android/Blender (Windows: GPU=Y + the render node).' },
        diskGb: { type: 'number', description: 'Disk size in GB. Omitted: 20 for Linux, 64 for Windows. Below a Windows floor (64 GB disk / 6 GB RAM / 2 vCPU) the computer is still created and the result carries a warning.' },
        android: { type: 'boolean', description: 'Install the Android SDK + AVD after creating (Linux only).' },
        rea: { type: 'boolean', description: 'Install the REA reverse-engineering kit (Node 22, rea-agents, JDK 21, Ghidra 12.1.4, JADX). Needs a 40 GB disk; it is raised to 40 when this is true. Linux only.' },
        windowsVersion: { type: 'string', enum: ['11', '11ltsc', '10', 'ltsc10', '2022', '2025'], description: 'Windows version. "2025" and "11ltsc" (Windows 11 IoT Enterprise LTSC 2024, alias "ltsc11") have pinned, probed public ISOs; 11/10/ltsc10/2022 require windowsIso (their evaluation media is behind a session-token page). Windows only.' },
        windowsIso: { type: 'string', description: 'Windows ISO instead of a version: an http(s) URL (downloaded once into $STORE/iso/) or a file path inside the VM store or the workspace (attached directly as a QEMU drive). Windows only; mutually exclusive with windowsVersion.' },
        windowsImageIndex: { type: 'integer', description: 'Windows only, optional: the /IMAGE/INDEX the answer file installs (1-based, as listed in the ISO sources/install.wim). Omit to use the version default: the pinned 11ltsc media names its edition explicitly (/IMAGE/NAME), Server 2025 installs image 2 (Standard Evaluation, Desktop Experience), any windowsIso installs image 1. Needed only for an unusual ISO where those are wrong.' },
        windowsImageName: { type: 'string', description: 'Windows only, optional: the exact /IMAGE/NAME to install, e.g. "Windows 11 IoT Enterprise LTSC 2024 Evaluation". Wins over windowsImageIndex. Use it when the ISO carries several editions and the name is known exactly — a name that does not match the media fails the install.' }
      }
    },
    output: textOutput('The computer, its renderer, disk, Android and REA status.'),
    async execute(input) {
      if (input.kind === 'windows') {
        // Refused HERE as well as in the supervisor: a tool that sends a
        // combination the backend will reject costs a round trip and reads like
        // a backend bug instead of a spec mistake.
        if (input.rea === true) throw new Error('REA is not available for Windows computers: the kit is a Linux guest layer. Create the Windows computer without it, or use a Linux computer.')
        if (input.android === true) throw new Error('Android is not available for Windows computers: the SDK and the AVD run in a Linux guest.')
        const answer = await call({ op: 'vmWindowsCreate', ...input })
        const parts = [`${answer.name} is ${answer.state} (Windows).`]
        if (answer.console) parts.push(`Live view: ${answer.console} (noVNC over QEMU VNC, never published raw).`)
        parts.push(answer.passwordHint)
        // The floors are DEFAULTS now: a below-floor request is created and the
        // warnings come from the supervisor, so the sentence describes what
        // actually happened instead of a silent raise.
        for (const warning of answer.warnings ?? []) parts.push(`WARNING: ${warning.message}`)
        parts.push('Once it is ready, `cua_vm_exec` runs commands over SSH in cmd.exe, `cua_vm_put`/`cua_vm_get` copy files over scp, and `cua_vm_gui` drives the screen over QMP — `cua_vm_disk`, Android and REA are the Linux-only ones.')
        if (answer.detail) parts.push(answer.detail)
        return { text: parts.join(' ') }
      }
      const answer = await call({ op: 'vmCreate', ...input })
      const parts = [`${answer.name} is ${answer.state}${input.gpu === true ? ' with a GPU (virgl)' : ''}.`]
      // A SPARSE DISK BIGGER THAN THE QUOTA IS CREATED, NOT REFUSED: the
      // supervisor sends `disk-over-policy` here (Linux and Windows alike), so
      // the sentence says what will actually go wrong instead of a refusal.
      for (const warning of answer.warnings ?? []) parts.push(`WARNING: ${warning.message}`)
      if (answer.renderer) parts.push(`Renderer: ${answer.renderer}.`)
      if (answer.disk && answer.disk.ok === false) parts.push(`Disk: ${answer.disk.error}`)
      else if (answer.disk && answer.disk.changed) parts.push(`Disk grown to ${answer.disk.sizeGb} GB (guest: ${answer.disk.guest || 'unknown'}).`)
      if (input.android === true) parts.push(answer.android ? 'Android SDK provisioned; boot it with `cua-emulator`.' : 'Android provisioning did not finish — see the output below.')
      // `rea` is true only when the guest's own marker was written after a
      // passing `rea doctor`; undefined/false means the kit is not there, and
      // Start re-runs the idempotent script.
      if (input.rea === true) parts.push(answer.rea ? 'REA is ready. Verify with `cua_vm_exec` → `rea doctor --provider ghidra --json`.' : 'REA provisioning did not finish — see the output below, then `cua_vm_start` once to retry (it is idempotent).')
      // The supervisor's own floor; the panel raises the field too, but the
      // tool is reachable without the panel.
      if (answer.diskGbRaised !== undefined) parts.push(`Disk was raised to ${answer.diskGbRaised} GB: the REA kit does not fit below 40 GB.`)
      // The paragraph must follow the create, not the next 30 s tick.
      if (input.rea === true) void refreshReaCache()
      if (answer.output) parts.push(`\n${answer.output}`)
      return { text: parts.join(' ') }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_gui',
    description: 'Drive the VM desktop. x/y are pixels in the last screenshot and the tool maps them: click what you see. Start with `screenshot` or `geometry`; `zoom` a window for small controls.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'name'],
      properties: {
        action: {
          type: 'string',
          enum: ['screenshot', 'geometry', 'click', 'dclick', 'move', 'drag', 'type', 'key', 'hotkey', 'scroll', 'windows', 'a11y', 'clipboard', 'launch', 'open', 'zoom', 'unzoom'],
          description: 'What to do on the VM desktop.'
        },
        name: { type: 'string', description: 'Computer name from cua_vm_status / cua_vm_ensure.' },
        x: { type: 'number', description: 'X pixel for click/dclick/move/drag start.' },
        y: { type: 'number', description: 'Y pixel for click/dclick/move/drag start.' },
        x2: { type: 'number', description: 'X pixel for the drag end.' },
        y2: { type: 'number', description: 'Y pixel for the drag end.' },
        text: { type: 'string', description: 'Text to type.' },
        key: { type: 'string', description: 'Key name (enter, escape, tab, f5) or hotkey combination (ctrl+c, ctrl+shift+s).' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction.' },
        amount: { type: 'number', description: 'Scroll steps (default 3).' },
        app: { type: 'string', description: 'Application name for launch.' },
        window: { type: 'string', description: 'Window title for zoom (substring, from geometry/windows).' },
        path: { type: 'string', description: 'File or URL for open.' },
        save: { type: 'string', description: 'Guest path for the PNG (default /home/cua/shots/…).' },
        region: {
          type: 'object',
          description: 'Read-only crop; prefer `zoom` before clicking.',
          properties: {
            x: { type: 'number' }, y: { type: 'number' },
            width: { type: 'number' }, height: { type: 'number' },
            scale: { type: 'number', description: 'Magnification, 1-4 (default 1).' }
          }
        },
        relative: { type: 'boolean', description: 'Fractions 0-1 instead of pixels.' },
        smooth: { type: 'boolean', description: 'Animate the pointer (default true).' },
        steps: { type: 'number', description: 'Animation steps 1-8 (default 6).' },
        durationMs: { type: 'number', description: 'Unused.' }
      }
    },
    output: textOutput('What happened, or the screenshot path.'),
    async execute(input) {
      const target = input.name
      const answer = await call({ op: 'gui', ...input, name: target })
      return { text: answer.output || `${input.action} done` }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_disk',
    description: 'Grow the disk online (QMP block_resize + growpart). No reboot; cannot shrink.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'sizeGb'],
      properties: {
        name: { type: 'string', description: 'Computer name from cua_vm_status.' },
        sizeGb: { type: 'number', description: 'New total disk size in GB (must be larger than the current one).' }
      }
    },
    output: textOutput('The new size and the guest filesystem after the grow.'),
    async execute({ name, sizeGb }) {
      const answer = await call({ op: 'vmDisk', name, sizeGb })
      if (answer.available === false) return { text: answer.message }
      if (answer.changed === false) return { text: `${name} is already ${answer.sizeGb} GB; nothing to do.` }
      return { text: `${name} disk is now ${answer.sizeGb} GB. Guest: ${answer.guest || 'unknown'}` }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_android',
    description: 'Install Google Android SDK + AVD inside the VM (~7 GB, needs 12 GB free). Boot with `cua-emulator`.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Computer name (must have a GPU-aware image and enough disk).' },
        api: { type: 'integer', description: 'Android API level (default 35).' },
        variant: { type: 'string', description: 'System image variant: google_apis (default, includes Google APIs), google_apis_playstore, or default.' },
        arch: { type: 'string', description: 'System image ABI (default x86_64; x86_64 needs KVM).' },
        avd: { type: 'string', description: 'AVD name (default cua).' }
      }
    },
    output: textOutput('Installed, plus the provisioning log tail.'),
    async execute(input) {
      const answer = await call({ op: 'vmAndroid', ...input })
      return { text: `Android SDK ready on ${input.name}. Start it with: cua-emulator\n${answer.output || ''}` }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_exec',
    description: 'Run a shell command in the computer: bash in the Linux guest, cmd.exe over SSH on a Windows one.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'VM name from cua_vm_ensure / cua_vm_status.' },
        cmd: { type: 'string', description: 'Shell command to run inside the guest.' },
        cwd: { type: 'string', description: 'Guest working directory (absolute path inside the VM).' },
        timeout: { type: 'integer', minimum: 1, maximum: 3600, description: 'Seconds before the command is stopped. Default 300.' }
      },
      required: ['name', 'cmd']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exit: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          ms: { type: 'integer' }
        },
        required: ['exit', 'stdout', 'stderr', 'ms']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `exit=${value.exit} (${value.ms} ms)\n${value.stdout}${value.stderr ? `\n[stderr]\n${value.stderr}` : ''}`
      }]
    },
    async execute(args = {}) {
      const result = await call({ op: 'exec', name: args.name, cmd: args.cmd, cwd: args.cwd, timeout: args.timeout ?? 300 })
      if (result.available === false) {
        // A Windows computer has no guest agent. The schema still has to answer,
        // so the refusal travels in stderr with exit 126 — the shape a shell
        // command that cannot run uses.
        return { exit: result.exit ?? 126, stdout: '', stderr: result.stderr ?? 'not available for Windows computers', ms: 0 }
      }
      return {
        exit: result.exit,
        stdout: clamp(result.stdout, maxOutputChars),
        stderr: clamp(result.stderr, maxOutputChars / 2),
        ms: result.ms ?? 0
      }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_put',
    description: 'Copy a workspace path into the VM.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        local: { type: 'string', description: 'Path inside the workspace (absolute or relative to the workspace root).' },
        guest: { type: 'string', description: 'Absolute destination path inside the VM.' }
      },
      required: ['name', 'local', 'guest']
    },
    output: textOutput('Copy result.'),
    async execute(args = {}) {
      const result = await call({ op: 'put', name: args.name, local: args.local, guest: args.guest })
      if (result.available === false) return { text: result.message }
      return { text: `Copied ${result.local} → ${args.name}:${result.guest}` }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_get',
    description: 'Copy an artifact out of the VM into the workspace.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        guest: { type: 'string', description: 'Absolute source path inside the VM.' },
        local: { type: 'string', description: 'Destination inside the workspace (absolute or relative to the workspace root).' }
      },
      required: ['name', 'guest', 'local']
    },
    output: textOutput('Copy result with byte count.'),
    async execute(args = {}) {
      const result = await call({ op: 'get', name: args.name, guest: args.guest, local: args.local })
      if (result.available === false) return { text: result.message }
      return { text: `Copied ${args.name}:${result.guest} → ${result.local} (${result.bytes} bytes)` }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_port',
    description: 'Expose a guest port as /vm/port/<name>/.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        guestPort: { type: 'integer', minimum: 1, maximum: 65535 },
        localPort: { type: 'integer', minimum: 1, maximum: 65535 }
      },
      required: ['name', 'guestPort']
    },
    output: textOutput('The proxy path and the loopback port that reaches the guest port.'),
    async execute(args = {}) {
      const result = await call({ op: 'port', name: args.name, guestPort: args.guestPort, localPort: args.localPort })
      // The supervisor answers {url, localPort, guestPort, backend} — and used
      // to be read as `result.target`, which is undefined: every call printed
      // "reachable at undefined". Print BOTH: the url is what the user can open,
      // the loopback port is what a curl from the harness shell can reach.
      const via = result.backend === 'relay' ? ' (relayed from the container)' : ''
      return { text: `Guest port ${result.guestPort ?? args.guestPort} on ${result.name ?? args.name} is reachable at ${result.url}${via} — from the harness shell: http://127.0.0.1:${result.localPort}/` }
    }
  })

  /**
   * START is its own tool because a powered-off computer does NOT resume.
   *
   * `cua sb resume` only works while cua still knows the sandbox; a shutdown
   * removes it on purpose (that is what makes the powerdown real), so the
   * natural-looking call fails for ever. `cua_vm_start` cold-boots from the
   * checkpoint — the model does not need to know why, only that this is the
   * button.
   */
  ctx.tools.register({
    name: 'cua_vm_start',
    description: 'Start a computer: resumes a suspended one, cold-boots a powered-off one from its checkpoint. Not for a Windows install in progress.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Computer name from cua_vm_status.' }
      }
    },
    output: textOutput('Start result, the boot source, and the provisioning outcome.'),
    async execute(args = {}) {
      const answer = await call({ op: 'vmStart', name: args.name })
      const parts = [`${answer.name} is ${answer.state}.`]
      if (answer.coldBoot === true) parts.push(answer.detail || 'cold-booted from its checkpoint.')
      if (answer.bootedFrom === 'image') parts.push('No checkpoint was available, so it booted the base image: the previous disk is gone.')
      if (answer.provisioned === false) parts.push(`Guest provisioning did not finish:\n${(answer.output || '').slice(-1200)}`)
      if (answer.rea === false) parts.push('REA did not finish provisioning; call cua_vm_start again (it is idempotent).')
      if (answer.detail && answer.coldBoot !== true) parts.push(answer.detail)
      if (answer.console) parts.push(`Console: ${answer.console}`)
      return { text: parts.join(' ') }
    }
  })

  /**
   * SHUTDOWN is a real power-off: ACPI `system_powerdown`, wait for the process
   * to exit (or `query-status` to say shutdown), flatten the disk into a
   * checkpoint, remove the sandbox, and record `powered-off` + `restoreFrom`.
   * The alternative (`cua_vm_suspend`) keeps the sandbox and resumes instantly;
   * the difference matters because a suspended computer still holds its RAM and
   * its QEMU process.
   */
  ctx.tools.register({
    name: 'cua_vm_shutdown',
    description: 'Power the computer off: ACPI powerdown, checkpoint, sandbox removed, state powered-off. Start cold-boots it. Only when the user asks.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Computer name from cua_vm_status.' }
      },
      required: ['name']
    },
    output: textOutput('The method used, the checkpoint, and any warning.'),
    async execute(args = {}) {
      const answer = await call({ op: 'vmShutdown', name: args.name })
      const parts = [`${answer.name} is ${answer.state} (${answer.method}).`]
      if (answer.fallback === 'acpi-unsupported') parts.push(answer.detail)
      else {
        if (answer.checkpoint) parts.push(`Checkpoint: ${answer.checkpoint}.`)
        if (answer.restoreFrom?.kind === 'image') parts.push('No checkpoint was written, so Start boots the base image.')
        if (answer.mayBeTorn) parts.push('The guest did not power down in time, so the image is marked mayBeTorn: the disk was captured after a forced quit.')
        if (Array.isArray(answer.notes) && answer.notes.length > 0) parts.push(`Notes: ${answer.notes.join('; ')}`)
      }
      parts.push('`cua_vm_start` boots it again; `cua_vm_resume` will NOT (a powered-off computer has no sandbox to resume).')
      return { text: parts.join(' ') }
    }
  })

  /** Garbage collection, so a store does not fill with dead 6 GB files. */
  ctx.tools.register({
    name: 'cua_vm_gc',
    description: 'Clean the VM store: orphan checkpoints (newest kept), restore temps, screenshots older than the retention, stale viewer rows, dead port rows.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dryRun: { type: 'boolean', description: 'Report what would go, delete nothing.' }
      }
    },
    output: textOutput('What was (or would be) removed, and the bytes freed.'),
    async execute(args = {}) {
      const answer = await call({ op: 'vmGc', dryRun: args.dryRun === true })
      const lines = []
      const list = (label, rows) => {
        if (!Array.isArray(rows) || rows.length === 0) return
        lines.push(`${label} (${rows.length}):`)
        for (const row of rows.slice(0, 12)) lines.push(`- ${row.file ?? row.name} — ${row.reason}`)
      }
      list('checkpoints', answer.checkpoints)
      list('screenshots', answer.shots)
      list('viewer rows', answer.views)
      list('port rows', answer.ports)
      if (Array.isArray(answer.orphans) && answer.orphans.length > 0) {
        lines.push(`orphaned rows (${answer.orphans.length}):`)
        for (const row of answer.orphans) lines.push(`- ${row.name}: ${row.sandbox}, ${row.action}`)
      }
      if (Array.isArray(answer.sandboxes) && answer.sandboxes.length > 0) {
        lines.push(`sandboxes cua lists with no row (${answer.sandboxes.length}) — not touched, they may belong to another install:`)
        for (const row of answer.sandboxes.slice(0, 8)) lines.push(`- ${row.name} (${row.status})`)
      }
      if (lines.length === 0) lines.push('Nothing to clean: no orphan checkpoint, no expired screenshot, no stale row.')
      lines.push(`${answer.dryRun === true ? 'Would free' : 'Freed'} ${(answer.bytesFreed / 1024 ** 2).toFixed(1)} MB; store now ${(answer.usedBytes / 1024 ** 3).toFixed(1)} GB.`)
      if (Array.isArray(answer.errors) && answer.errors.length > 0) lines.push(`Errors: ${answer.errors.slice(0, 5).join('; ')}`)
      return { text: lines.join('\n') }
    }
  })

  /** Host capabilities, from the one process that can actually see them. */
  ctx.tools.register({
    name: 'cua_vm_doctor',
    description: 'Diagnose the host: /dev/kvm, render node, QEMU virgl support, Docker engine reachability, store accounting, policy.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: textOutput('Host capabilities and the store policy, one line per fact.'),
    async execute() {
      const answer = await call({ op: 'vmDoctor' })
      const caps = answer.hostCaps ?? {}
      const windows = answer.windows ?? {}
      const store = answer.store ?? {}
      return {
        text: [
          // The device and its ACCESS are two facts: "present but DENIED" is
          // the group/gid bug (uid 1000 is not in the device's group), and it
          // used to read as "NOT usable" with no way to tell it from a missing
          // node. Never collapse them.
          `kvm: ${caps.kvm}${caps.kvmUsable ? '' : (caps.kvmState === 'denied' ? ` (mounted but NOT openable by this uid — ${caps.kvmMode ?? '?'} owner ${caps.kvmOwner ?? '?'}, groups ${Array.isArray(caps.kvmGroups) && caps.kvmGroups.length > 0 ? caps.kvmGroups.join(',') : 'none'}: add KVM_GID to group_add, see the README)` : ' (NOT usable — the computer cannot start)')}`,
          `render node: ${caps.renderNode}`,
          `system qemu: ${caps.systemQemu}`,
          `virtio-gpu-gl-pci: ${caps.virtioGpuGl ? 'yes' : 'no'} (DSH_CUA_VM_GPU=${caps.gpuMode}; default gpu=${caps.gpuDefault})`,
          `desktop: ${caps.desktop}${caps.resolutionAllowed ? '' : ' (refused: above cua\'s capture budget — set DSH_CUA_VM_RESOLUTION_ALLOW_SCALE=1 to accept a scaled capture)'}`,
          `workspace share: ${caps.share}`,
          `docker engine: ${caps.docker}`,
          `windows: ${windows.enabled
            ? `enabled (direct qemu: ${windows.hostCaps?.qemu ? 'present' : 'MISSING'}, OVMF ${windows.hostCaps?.ovmfCode ? 'present' : 'MISSING'}, swtpm ${windows.hostCaps?.swtpm ? 'present' : 'MISSING'}, KVM ${windows.hostCaps?.kvm ? (windows.hostCaps?.kvmUsable ? 'present' : 'present but NOT openable by this uid (gid/group_add)') : 'MISSING'})`
            : `disabled (${windows.reason})`}`,
          `store: ${(store.usedBytes / 1024 ** 3).toFixed(1)} GB of ${(store.quotaBytes / 1024 ** 3).toFixed(0)} GB`,
          `policy: shutdownTimeoutSec=${answer.shutdownTimeoutSec} checkpointPolicy=${answer.checkpointPolicy} computers=${answer.vms}`
        ].join('\n')
      }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_suspend',
    description: 'Pause the computer and keep its disk (resume is instant). Linux: cua sb suspend. Windows: QMP stop. For a real power-off use cua_vm_shutdown.',
    parameters: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' } }, required: ['name'] },
    output: textOutput('Suspend result.'),
    async execute(args = {}) {
      const result = await call({ op: 'suspend', name: args.name })
      if (result.kind === 'windows') return { text: `${result.name} is suspended (the VM is paused with QMP stop; Start continues it).` }
      return { text: `${result.name} suspended; its disk stays in the VM store.` }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_destroy',
    description: 'Delete the VM and everything it left in the store. Only when the user asks. `force: true` kills the QEMU/swtpm/websockify processes FIRST and then removes what is left — use it when a normal delete reported failures.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        force: { type: 'boolean', description: 'Force delete: kill the VM process (QEMU/swtpm/websockify) and remove its disks even if the normal delete reported failures — the row, disks, ports and registry row all go. Ask for confirmation first: it is destructive.' }
      },
      required: ['name']
    },
    output: textOutput('Destroy result, the items that survived, and the kill log when force was used.'),
    async execute(args = {}) {
      const result = await call({ op: 'destroy', name: args.name, force: args.force === true })
      const killed = (result.force?.killed ?? []).map((item) => `- ${item.status === 'removed' ? 'KILLED' : 'STILL RUNNING'} ${item.target}: ${item.detail}`).join('\n')
      if (result.complete === false) {
        // A PARTIAL manifest is not a deletion, and a KEPT item is the usual
        // case: a disk whose QEMU is still running is deliberately left alone,
        // so the row stays (orphaned) and cua_vm_gc reclaims it once the process
        // is gone. Print both lists: what failed and what was kept on purpose.
        const failed = (result.failed ?? []).map((item) => `- FAILED ${item.target}: ${item.detail}`).join('\n')
        const kept = (result.kept ?? []).map((item) => `- KEPT ${item.target}: ${item.reason}`).join('\n')
        const offer = result.canForce === true && args.force !== true
          ? '\nCall cua_vm_destroy again with force: true to kill the process and remove what is left.'
          : ''
        return { text: `${result.name} was NOT fully deleted. ${result.detail ?? ''}\n${[kept, failed, killed].filter(Boolean).join('\n')}${offer}` }
      }
      return { text: `${result.name} destroyed (${result.items?.length ?? 0} store item(s) removed)${killed ? `.\n${killed}` : ''}. The next ensure starts from the base image.` }
    }
  })
}
