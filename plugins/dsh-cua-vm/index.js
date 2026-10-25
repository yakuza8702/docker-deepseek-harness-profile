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

export function apply(ctx, config = {}) {
  const socketPath = config.socketPath ?? '/tmp/cua-vm/supervisor.sock'
  const workspaceRoot = config.workspaceRoot ?? '/workspace'
  const defaultTier = config.defaultTier ?? 'slim'
  const defaultCpu = config.defaultCpu ?? 2
  const defaultMemory = config.defaultMemory ?? 4
  const maxOutputChars = config.maxOutputChars ?? 8000

  const call = (payload) => request(socketPath, payload)

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
            return send(200, { ok: true, config: config.config, usedBytes: config.usedBytes, vms: list.registry })
          }
          case 'config': return send(200, { ok: true, ...(await call({ op: 'configSet', config: await body() })) })
          case 'create': return send(200, { ok: true, ...(await call({ op: 'vmCreate', ...(await body()) })) })
          case 'start': return send(200, { ok: true, ...(await call({ op: 'vmStart', ...(await body()) })) })
          case 'stop': return send(200, { ok: true, ...(await call({ op: 'stop', ...(await body()) })) })
          case 'delete': return send(200, { ok: true, ...(await call({ op: 'vmDelete', ...(await body()) })) })
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
    text: [
      'You have a personal Linux computer for this workspace (a QEMU VM), managed by the `cua_vm_*` tools; the user also manages computers from Plugins → Personal VM (Computers).',
      'Treat it as your own machine, not as a sandbox to poke: install what the task needs there (apt, npm, pip, SDKs, the Android SDK, Blender), build and test there, and copy only the finished artifact back with `cua_vm_get`. Never install project toolchains into the harness image itself.',
      'Its `/workspace` is the SAME directory as this workspace (a 9p share set up by the supervisor). Files you write with the file tools are visible there and files it writes appear here — a build inside the VM lands in the project. If the share is missing, `cua_vm_put`/`cua_vm_get` still copy explicitly.',
      'Build in the VM, not over the share, when the build writes thousands of small files: copy the source to /tmp/build (or /home/cua/build) inside the VM, build there, then copy the artifact back to /workspace. 9p is for source and results, not for object files.',
      'You can drive its desktop with `cua_vm_gui`: screenshot, click, type, hotkeys, drag, scroll, and `zoom` to crop the desktop to one window.',
      'COORDINATES: every x/y is a pixel in the screenshot you just took, origin top-left. `cua_vm_gui` maps that to the display for you, so click the pixel you see — never rescale, never add an offset. The desktop is 1200x750 by default, which is exactly what the capture returns.',
      'Choose the surface deliberately: the shell for anything a command can do (gradle, adb, blender -b, apt, tests), the desktop when the work is visual or only exists as a window — a login screen, an app with no CLI, a UI you must look at to judge, or when the user says show me, click, or test the UI.',
      'Before clicking, get the position from `a11y` (element bounds) or `windows`, then screenshot to confirm the result. If you cannot see images, use the a11y bounds rather than guessing pixels.',
      'Before you create a computer for the user, ask with `ask_user_question` for its name, vCPU/RAM and image unless they already said so; never invent a spec silently. Debian and Arch need a built Cua disk, so say that instead of substituting an image.',
      'For Android, Blender, WebGL or any 3D work, create the computer with `cua_vm_create` and gpu enabled (gpu: true) unless the user says otherwise, and tell them when the image or the host cannot provide it.',
      'For an Android app: `cua_vm_create` with gpu, cpu 4, memory 8 and diskGb 40, then `cua_vm_android` once (SDK + AVD, a few GB). Boot it with `cua-emulator` (or `cua-emulator -no-window` for adb-driven tests) and check `adb devices` before installing the APK. KVM is nested inside the VM, so the emulator is hardware-accelerated; confirm it with `cua_vm_exec` → `ls -l /dev/kvm`.',
      'On a GPU computer the desktop runs Xorg on virgl and reports OpenGL 4.3 (Mesa under-reports virgl as 4.2; the session lifts the reported version so Blender 4.x starts on the GPU). If an app still refuses, check `cua_vm_gui geometry` or `glxinfo -B`; only fall back to `LIBGL_ALWAYS_SOFTWARE=1` (llvmpipe, GL 4.5, much slower) when the GPU path genuinely fails, and say so.',
      'The VM persists across turns and is stopped only when the user asks. If a tool reports that no VM exists, call `cua_vm_ensure` once, then `cua_vm_exec`.'
    ].join(' ')
  })

  ctx.tools.register({
    name: 'cua_vm_status',
    description: 'Report the personal VM for this workspace: whether it exists, its state, tier, size and the last command run in it. Call this before vm_ensure if you are unsure whether a VM is already running.',
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
        vm.lastCommand ? `lastCommand=${vm.lastCommand}` : null
      ].filter(Boolean).join(' · '))
      return { text: lines.join('\n') }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_ensure',
    description: 'Create or resume the personal Linux VM for this workspace. Idempotent: calling it on an existing VM just resumes it and returns the same name. The first call downloads the base image and can take several minutes.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        workspace: { type: 'string', description: 'Workspace path or a path relative to the configured workspace root. Defaults to the root.' },
        tier: { type: 'string', enum: ['slim', 'full'], description: 'Image tier. slim is the default and smaller; full adds the larger desktop payload.' },
        cpu: { type: 'integer', minimum: 1, maximum: 16 },
        memory: { type: 'integer', minimum: 1, maximum: 64, description: 'Guest memory in GB.' },
        waitForDesktop: { type: 'boolean', description: 'Wait until the desktop session accepts input, not just until the guest daemon answers.' }
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
    description: 'Create a named computer with an explicit spec: name, vCPU, RAM, image and whether it gets a GPU. Ask the user for the name and spec first unless they already gave them. Set gpu true for Android, Blender, WebGL or any 3D work; it needs an image built with virgl support and a GPU render node on the host.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Computer name: lowercase letters, digits and dashes.' },
        cpu: { type: 'number', description: 'vCPUs (default 2).' },
        memory: { type: 'number', description: 'RAM in GB (default 4).' },
        image: { type: 'string', description: 'Image reference. Default "linux" (Ubuntu 24.04 slim Cua disk).' },
        gpu: { type: 'boolean', description: 'Give the computer a virgl GPU (3D/Android/Blender). Default false.' },
        diskGb: { type: 'number', description: 'Grow the disk to this many GB. Android needs ~40; the filesystem grows online, no reboot.' },
        android: { type: 'boolean', description: 'Provision the Android SDK and an AVD inside it right after creating (several GB, several minutes). Implies gpu and at least 8 GB RAM / 40 GB disk are sensible.' }
      }
    },
    output: textOutput('The created computer, its renderer and whether disk/Android provisioning ran.'),
    async execute(input) {
      const answer = await call({ op: 'vmCreate', ...input })
      const parts = [`${answer.name} is ${answer.state}${input.gpu === true ? ' with a GPU (virgl)' : ''}.`]
      if (answer.renderer) parts.push(`Renderer: ${answer.renderer}.`)
      if (answer.disk && answer.disk.ok === false) parts.push(`Disk: ${answer.disk.error}`)
      else if (answer.disk && answer.disk.changed) parts.push(`Disk grown to ${answer.disk.sizeGb} GB (guest: ${answer.disk.guest || 'unknown'}).`)
      if (input.android === true) parts.push(answer.android ? 'Android SDK provisioned; boot it with `cua-emulator`.' : 'Android provisioning did not finish — see the output below.')
      if (answer.output) parts.push(`\n${answer.output}`)
      return { text: parts.join(' ') }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_gui',
    description: 'Drive the desktop of the personal VM the way a person would: screenshot, click, double-click, move, drag, type text, press keys or hotkeys, scroll, list windows, read the accessibility tree, read the clipboard, launch an app, open a file, and zoom the desktop to a single window. COORDINATES are pixels in the screenshot you took, origin top-left; the tool maps them to the display, so click what you see and never scale. The default desktop is 1200x750, which is exactly what a screenshot returns. Start with `screenshot` (see the screen), `geometry` (display size, pointer, window titles) or `a11y` (element bounds, when the app exposes it), then act, then screenshot to confirm. `zoom <window>` crops to a window and keeps coordinates relative to that crop — the reliable way to click small controls; `unzoom` returns to the full screen. Screenshots are also saved in the guest, so cua_vm_get can fetch them.',
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
        window: { type: 'string', description: 'Window title for `zoom` — any substring of a title listed by `geometry` or `windows` (e.g. "Blender", "Calculator").' },
        path: { type: 'string', description: 'File or URL for open.' },
        save: { type: 'string', description: 'Guest path for the screenshot, e.g. /home/cua/shots/gui.png. Defaults to /home/cua/shots/<name>-<timestamp>.png; the panel also keeps a copy under /cua-vm/shots.' },
        region: {
          type: 'object',
          description: 'Read-only crop for a magnified look at part of the screenshot. The result prints the inverse mapping; prefer `zoom` when you intend to click.',
          properties: {
            x: { type: 'number' }, y: { type: 'number' },
            width: { type: 'number' }, height: { type: 'number' },
            scale: { type: 'number', description: 'Magnification, 1-4 (default 1).' }
          }
        },
        relative: { type: 'boolean', description: 'Treat x and y as fractions (0-1) instead of pixels. Only for callers that saw a resized preview; x=0.5 is the centre.' },
        smooth: { type: 'boolean', description: 'Animate the pointer for a human watching the shared desktop. Default true; set false for speed.' },
        steps: { type: 'number', description: 'Pointer animation steps (1-8, default 3).' },
        durationMs: { type: 'number', description: 'Unused; kept for compatibility.' }
      }
    },
    output: textOutput('What the action did, or the screenshot path.'),
    async execute(input) {
      const target = input.name
      const answer = await call({ op: 'gui', ...input, name: target })
      return { text: answer.output || `${input.action} done` }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_disk',
    description: 'Grow the disk of a running computer. The qcow2 grows under the live QEMU (QMP block_resize) and the guest grows its partition and ext4 filesystem online, so nothing reboots and no data is lost. Use it before installing something large (the Android SDK needs ~12 GB free). Shrinking is not supported.',
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
    description: 'Install the official Google Android SDK, platform-tools and an AVD inside the computer (several GB, several minutes; needs /dev/kvm and ~12 GB free — grow the disk with cua_vm_disk first). Afterwards run the emulator inside the guest with `cua-emulator` (or `cua-emulator -no-window` for adb-driven tests); it is hardware-accelerated because KVM is nested in the VM.',
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
    output: textOutput('Whether the SDK and AVD are installed, plus the tail of the provisioning log.'),
    async execute(input) {
      const answer = await call({ op: 'vmAndroid', ...input })
      return { text: `Android SDK ready on ${input.name}. Start it with: cua-emulator\n${answer.output || ''}` }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_exec',
    description: 'Run a shell command inside the personal VM and return its exit code, stdout and stderr. Use it for builds, tests and troubleshooting. The command runs as one `sh -c` line; pass a cwd to start elsewhere.',
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
    description: 'Copy a file or directory from the workspace INTO the VM. The local path must stay inside the workspace; the guest path must be absolute.',
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
    description: 'Copy a finished artifact OUT of the VM into the workspace. This is the only way VM output reaches the workspace, so use it deliberately and only for the product, not for scratch files.',
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
    description: 'Expose a port from the VM so it can be reached from this machine, e.g. to check a web app the build produced. Returns the local address to open.',
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
    description: 'Stop the VM while keeping its disk, so the next cua_vm_ensure resumes the same computer. Use it when the work is finished but the user may come back.',
    parameters: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' } }, required: ['name'] },
    output: textOutput('Suspend result.'),
    async execute(args = {}) {
      const result = await call({ op: 'suspend', name: args.name })
      return { text: `${result.name} suspended; its disk stays in the VM store.` }
    }
  })

  ctx.tools.register({
    name: 'cua_vm_destroy',
    description: 'Permanently delete the VM and its disk. Only call this when the user has explicitly asked to destroy the VM; never as cleanup after a task.',
    parameters: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' } }, required: ['name'] },
    output: textOutput('Destroy result.'),
    async execute(args = {}) {
      const result = await call({ op: 'destroy', name: args.name })
      return { text: `${result.name} destroyed. Its disk is gone; the next ensure starts from the base image.` }
    }
  })
}
