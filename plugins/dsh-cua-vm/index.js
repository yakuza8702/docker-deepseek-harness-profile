import net, { createConnection } from 'node:net'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

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
  'The VM persists across turns and stops only when the user asks; if a tool reports no VM, call `cua_vm_ensure` once, then `cua_vm_exec`.',
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
            return send(200, { ok: true, config: config.config, usedBytes: config.usedBytes, vms: list.registry })
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
      const lines = entries.map(([name, vm]) => [
        `${name} (${vm.state || 'unknown'})`,
        `workspace=${vm.workspace}`,
        `tier=${vm.tier}`,
        `cpu=${vm.cpu}`,
        `memory=${vm.memory}GB`,
        vm.lastUsed ? `lastUsed=${vm.lastUsed}` : null,
        vm.rea === true ? 'rea=yes' : null,
        vm.lastCommand ? `lastCommand=${vm.lastCommand}` : null
      ].filter(Boolean).join(' · '))
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
        waitForDesktop: { type: 'boolean', description: 'Wait for the desktop, not just the daemon.' }
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
        waitDesktop: args.waitForDesktop === true
      })
      return { text: `${result.created ? 'Created' : 'Resumed'} ${result.name} (tier=${result.tier}, state=${result.state}). Use this name with cua_vm_exec.` }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_create',
    description: 'New computer: name, vCPU, RAM, image, gpu, diskGb, android, rea. Ask the user for the spec first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Computer name: lowercase letters, digits and dashes.' },
        cpu: { type: 'number', description: 'vCPUs (default 2).' },
        memory: { type: 'number', description: 'RAM in GB (default 4).' },
        image: { type: 'string', description: 'Image reference. Default "linux" (Ubuntu 24.04 slim Cua disk).' },
        gpu: { type: 'boolean', description: 'virgl GPU for 3D/Android/Blender.' },
        diskGb: { type: 'number', description: 'Disk size in GB (Android and REA: 40).' },
        android: { type: 'boolean', description: 'Install the Android SDK + AVD after creating.' },
        rea: { type: 'boolean', description: 'Install the REA reverse-engineering kit (Node 22, rea-agents, JDK 21, Ghidra 12.1.4, JADX). Needs a 40 GB disk; it is raised to 40 when this is true.' }
      }
    },
    output: textOutput('The computer, its renderer, disk, Android and REA status.'),
    async execute(input) {
      const answer = await call({ op: 'vmCreate', ...input })
      const parts = [`${answer.name} is ${answer.state}${input.gpu === true ? ' with a GPU (virgl)' : ''}.`]
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
    description: 'Run a shell command in the VM; returns exit code, stdout, stderr.',
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
    output: textOutput('Local address that reaches the guest port.'),
    async execute(args = {}) {
      const result = await call({ op: 'port', name: args.name, guestPort: args.guestPort, localPort: args.localPort })
      return { text: `Guest port ${args.guestPort} is reachable at ${result.target}` }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_suspend',
    description: 'Stop the VM, keep its disk. Start/ensure resumes it.',
    parameters: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' } }, required: ['name'] },
    output: textOutput('Suspend result.'),
    async execute(args = {}) {
      const result = await call({ op: 'suspend', name: args.name })
      return { text: `${result.name} suspended; its disk stays in the VM store.` }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_destroy',
    description: 'Delete the VM and its disk. Only when the user asks.',
    parameters: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' } }, required: ['name'] },
    output: textOutput('Destroy result.'),
    async execute(args = {}) {
      const result = await call({ op: 'destroy', name: args.name })
      return { text: `${result.name} destroyed. Its disk is gone; the next ensure starts from the base image.` }
    }
  })
}
