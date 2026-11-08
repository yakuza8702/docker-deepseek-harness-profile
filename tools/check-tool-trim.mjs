#!/usr/bin/env node
/**
 * check-tool-trim — measure what mcp-slim does to a tool catalogue.
 *
 * It runs a synthetic MCP server (no browser, no network) through the proxy and
 * prints the catalogue size before and after, so a change to a policy is a
 * number rather than an opinion. The synthetic catalogue mirrors the shape of
 * the real servers: ~24 tools, multi-sentence descriptions, documented params.
 *
 *   node tools/check-tool-trim.mjs                 # both policies, synthetic
 *   node tools/check-tool-trim.mjs --live brave    # the real server, if present
 *
 * Exit 1 when a dropped tool survives, a drop entry names a tool the pinned
 * server does not define (checked against the FROZEN catalogue below, never
 * against the policy auditing itself), a description exceeds the cap, a
 * `stripKeys` key (`$schema`, `additionalProperties`) survives, the fixture stops
 * carrying those keys (which would make the assertion vacuous), a literal
 * `__proto__` key is lost by the rebuild, or the proxy breaks the JSON-RPC
 * stream.
 */

import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
// The image copies the proxy and its policies flat into /opt/seek-harness, so
// the build gate points at them there instead of at the repo layout.
const SLIM = process.env.DSH_SLIM_BIN || path.join(ROOT, 'docker', 'mcp-slim.mjs')
const POLICY_DIR = process.env.DSH_SLIM_POLICIES || path.join(ROOT, 'docker')
const POLICIES = {
  browser: path.join(POLICY_DIR, 'mcp-slim.browser.json'),
  brave: path.join(POLICY_DIR, 'mcp-slim.brave.json')
}

/**
 * FROZEN GROUND TRUTH — the tool names each pinned server actually publishes.
 *
 * The drop list is the one place a typo is invisible: a name no tool carries
 * removes nothing and looks like a successful trim. An audit that builds its
 * fixture FROM `policy.drop` agrees with that typo by construction, so the
 * oracle has to live here instead, outside the policy it is auditing.
 *
 * Copied verbatim from the packages the image pins, by running the real
 * initialize + tools/list handshake against them:
 *
 *   browser — @playwright/mcp 0.0.80, 24 tools
 *             (node <pkg>/cli.js)
 *   brave   — brave-mcp 1.9.0, 30 tools, in the configuration this image's row
 *             starts it with (`--browserUrl=… --no-performance-crux`).
 *
 * Refresh it by re-running the handshake against a new pin and pasting the
 * list. Hand-editing an entry to make a policy pass is how this gate dies.
 */
const FROZEN = Object.freeze({
  browser: Object.freeze([
    'browser_click',
    'browser_close',
    'browser_console_messages',
    'browser_drag',
    'browser_drop',
    'browser_evaluate',
    'browser_file_upload',
    'browser_fill_form',
    'browser_find',
    'browser_handle_dialog',
    'browser_hover',
    'browser_navigate',
    'browser_navigate_back',
    'browser_network_request',
    'browser_network_requests',
    'browser_press_key',
    'browser_resize',
    'browser_run_code_unsafe',
    'browser_select_option',
    'browser_snapshot',
    'browser_tabs',
    'browser_take_screenshot',
    'browser_type',
    'browser_wait_for'
  ]),
  brave: Object.freeze([
    'click',
    'close_page',
    'drag',
    'emulate',
    'evaluate_script',
    'fill',
    'fill_form',
    'get_console_message',
    'get_css_styles',
    'get_network_request',
    'handle_dialog',
    'hover',
    'lighthouse_audit',
    'list_console_messages',
    'list_network_requests',
    'list_pages',
    'navigate_page',
    'new_page',
    'performance_analyze_insight',
    'performance_start_trace',
    'performance_stop_trace',
    'press_key',
    'resize_page',
    'select_page',
    'take_heapsnapshot',
    'take_screenshot',
    'take_snapshot',
    'type_text',
    'upload_file',
    'wait_for'
  ])
})

/** How to name each frozen catalogue in an error, so a failure is actionable. */
const FROZEN_SOURCE = {
  browser: 'playwright-mcp 0.0.80',
  brave: 'brave-devtools 1.9.0'
}

/**
 * Verbs the same pinned packages define behind an opt-in flag, so they are real
 * names but not part of the default `tools/list`: brave-mcp 1.9.0 publishes
 * `click_at` only with `--experimentalVision` and `get_tab_id` only with
 * `--experimentalInteropTools`, and this image's row passes neither. A drop
 * entry naming one is therefore inert today — but it is a real verb, not a
 * rename or a typo, which is what the gate is hunting. They are listed
 * separately so the audit can say so instead of pretending the server serves
 * them; anything NOT in these two lists is still a hard failure.
 */
const OPT_IN = Object.freeze({
  browser: Object.freeze([]),
  brave: Object.freeze(['click_at', 'get_tab_id'])
})

/**
 * Verbs an earlier verdict decided to KEEP, even though another server offers
 * something similar. Asserted by name so a later policy edit cannot quietly
 * undo the decision without a red gate.
 */
const REQUIRED_KEPT = {
  browser: ['browser_navigate_back'],
  brave: []
}

/** A stdio MCP server that answers initialize + tools/list and nothing else. */
const FAKE_SERVER = `
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (!line.trim()) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1.0.0' }
      } }) + '\\n')
      continue
    }
    if (message.method === 'tools/list') {
      const names = process.env.FAKE_NAMES
        ? JSON.parse(process.env.FAKE_NAMES)
        : ['click','hover','fill','type_text','drag','press_key','navigate_page','new_page','list_pages','select_page','close_page','resize_page','take_screenshot','take_snapshot','evaluate_script','wait_for','handle_dialog','get_tab_id','list_console_messages','get_console_message','list_network_requests','get_network_request','emulate','lighthouse_audit','performance_start_trace','performance_stop_trace','performance_analyze_insight']
      const tools = names.map((name, index) => ({
        name,
        description: 'This tool is used to ' + name.replace(/_/gu, ' ') + ' in the target page. It is the recommended entry point when you need to inspect or manipulate that part of the page, and the response includes enough detail to continue without another round trip. Prefer taking a snapshot before acting if you are unsure about element ids.',
        inputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: { type: 'number', description: 'Targets a specific page by ID. Required when more than one page is open, which is usually the case after a redirect or a popup.' },
            verbose: { type: 'boolean', description: 'Whether to include all possible information available in the full accessibility tree. Default is false.' },
            selector: { type: 'string', description: 'Optional CSS selector. When omitted the tool uses the element uid you pass, and that uid must come from the most recent snapshot.' },
            index: { type: 'number', description: 'Which of the listed entries to act on, counted from one, in the order the previous call printed them.' },
            options: {
              type: 'object',
              additionalProperties: false,
              properties: {
                timeout: { type: 'number', description: 'How long to wait before giving up, in milliseconds. Defaults to the server value.' }
              }
            }
          },
          required: ['pageId']
        }
      }))
      // Opt-in only: the headline catalogue must keep its exact byte count, so
      // the probe key that a plain assignment would swallow is added on demand.
      if (process.env.FAKE_PROTO_KEY === '1') {
        const probe = JSON.parse('{"__proto__":{"type":"string","description":"A literal __proto__ key."}}')
        for (const tool of tools) tool.inputSchema.properties = { ...tool.inputSchema.properties, ...probe }
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools } }) + '\\n')
    }
  }
})
`

function catalogue(name, { proxy = true, names, env: extraEnv } = {}) {
  return new Promise((resolve, reject) => {
    const policy = JSON.parse(readFileSync(POLICIES[name], 'utf8'))
    const env = {
      ...process.env,
      ...(names === undefined ? {} : { FAKE_NAMES: JSON.stringify(names) }),
      ...extraEnv
    }
    const child = proxy
      ? spawn(process.execPath, [SLIM, '--policy', POLICIES[name], '--', process.execPath, '-e', FAKE_SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env })
      : spawn(process.execPath, ['-e', FAKE_SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env })
    let out = ''
    let err = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { err += chunk })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      out += chunk
      if (!out.includes('"tools":[')) return
      const lines = out.split('\n').filter(Boolean)
      const reply = lines.map((line) => { try { return JSON.parse(line) } catch { return null } }).find((m) => m?.result?.tools)
      if (reply === undefined) return
      child.kill()
      resolve({ tools: reply.result.tools, policy, err })
    })
    child.on('error', reject)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } } })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
    setTimeout(() => { child.kill(); reject(new Error(`no tools/list reply for ${name}`)) }, 10000)
  })
}

const live = process.argv.includes('--live')
if (live) {
  const target = process.argv[process.argv.indexOf('--live') + 1]
  const bin = target === 'brave'
    ? '/usr/local/bin/dsh-brave-devtools-mcp'
    : '/usr/local/bin/dsh-playwright-mcp'
  if (!existsSync(bin)) {
    console.error(`check-tool-trim: ${bin} is not in this image (live check needs the built image)`)
    process.exit(2)
  }
  console.error(`check-tool-trim: live mode needs a browser and a CDP endpoint; run the wrapper by hand: ${bin}`)
  process.exit(2)
}

let failures = 0
// mcp-slim's own guard, exercised rather than asserted in a comment: both
// catalogue rebuilds must keep a literal "__proto__" key as data.
const selftest = spawnSync(process.execPath, [SLIM, '--selftest'], { encoding: 'utf8' })
if (selftest.status === 0) {
  console.log('mcp-slim self-test: literal "__proto__" key kept as data')
} else {
  failures += 1
  const reason = (selftest.stderr || selftest.stdout || selftest.error?.message || '').trim() || 'no output'
  console.error(`  FAIL mcp-slim --selftest exited ${selftest.status}: ${reason}`)
}
const STRIPPED = ['$schema', 'additionalProperties']
for (const name of ['browser', 'brave']) {
  const baseline = await catalogue(name, { proxy: false })
  const { tools, policy } = await catalogue(name)
  const dropped = [...(policy.drop ?? [])].filter((tool) => tools.some((entry) => entry.name === tool))
  const tooLong = tools.filter((tool) => tool.description.replace(/…$/u, '').length > policy.maxDescription)
  const beforeChars = JSON.stringify(baseline.tools).length
  const chars = JSON.stringify(tools).length
  const saved = Math.round((1 - chars / beforeChars) * 100)
  console.log(`${name}: ${baseline.tools.length} tools -> ${tools.length} (${baseline.tools.length - tools.length} removed), `
    + `${beforeChars} -> ${chars} chars, ~${Math.round(beforeChars / 4)} -> ~${Math.round(chars / 4)} tokens (-${saved}%)`)
  if (dropped.length > 0) {
    console.error(`  FAIL dropped tools survived: ${dropped.join(', ')}`)
    failures += 1
  }
  if (tooLong.length > 0) {
    console.error(`  FAIL descriptions over ${policy.maxDescription}: ${tooLong.map((t) => `${t.name}(${t.description.length})`).join(', ')}`)
    failures += 1
  }
  // Validator boilerplate is pure overhead in a tool catalogue: the proxy must
  // delete it, and the fixture must prove the strip actually had work to do.
  const baselineJson = JSON.stringify(baseline.tools)
  const trimmedJson = JSON.stringify(tools)
  const leaks = STRIPPED.filter((key) => trimmedJson.includes(JSON.stringify(key) + ':'))
  if (leaks.length > 0) {
    console.error(`  FAIL stripped keys survived the proxy: ${leaks.join(', ')}`)
    failures += 1
  }
  const unexercised = STRIPPED.filter((key) => !baselineJson.includes(JSON.stringify(key) + ':'))
  if (unexercised.length > 0) {
    console.error(`  FAIL fixture never carried ${unexercised.join(', ')}; the strip assertion would be vacuous`)
    failures += 1
  }
  const beforeStripped = STRIPPED.reduce((total, key) => total + baselineJson.split(JSON.stringify(key) + ':').length - 1, 0)
  const afterStripped = STRIPPED.reduce((total, key) => total + trimmedJson.split(JSON.stringify(key) + ':').length - 1, 0)
  console.log(`  stripKeys: ${beforeStripped} -> ${afterStripped} occurrences of ${STRIPPED.join('/')}`)
  // A parameter literally named "__proto__" is legal JSON. A rebuild that
  // assigns into a plain object loses it (and installs it as the prototype), so
  // push one through the proxy end to end. Opt-in, to keep the headline
  // catalogue's byte count stable.
  const protoBaseline = await catalogue(name, { proxy: false, names: ['proto_probe'], env: { FAKE_PROTO_KEY: '1' } })
  const protoTools = await catalogue(name, { names: ['proto_probe'], env: { FAKE_PROTO_KEY: '1' } })
  const protoKey = '"__proto__":'
  if (!JSON.stringify(protoBaseline.tools).includes(protoKey)) {
    failures += 1
    console.error('  FAIL fixture never carried a __proto__ parameter; the rebuild assertion would be vacuous')
  } else if (!JSON.stringify(protoTools.tools).includes(protoKey)) {
    failures += 1
    console.error('  FAIL a literal __proto__ parameter was lost by the proxy (prototype takeover)')
  } else {
    console.log('  __proto__ parameter: kept as an own key')
  }
  // The measured catalogue uses canonical DevTools names, so a playwright drop
  // entry (`browser_resize`) never appears in it. Audit the drop list against
  // the frozen catalogue, then prove the mechanism on a fixture drawn from it:
  // the policy is an input here, never the oracle.
  const freeze = failures
  const frozen = FROZEN[name]
  const known = [...frozen, ...(OPT_IN[name] ?? [])]
  const dropList = [...(policy.drop ?? [])]
  const phantom = dropList.filter((tool) => !known.includes(tool))
  const inert = dropList.filter((tool) => !frozen.includes(tool) && known.includes(tool))
  const sentinel = 'drop_audit_sentinel'
  const auditNames = [...known, sentinel]
  const audit = await catalogue(name, { names: auditNames })
  const auditBaseline = await catalogue(name, { proxy: false, names: auditNames })
  const auditBefore = JSON.stringify(auditBaseline.tools).length
  const auditAfter = JSON.stringify(audit.tools).length
  const fixtureNames = auditBaseline.tools.map((tool) => tool.name)
  const expected = [...known.filter((tool) => !dropList.includes(tool)), sentinel]
  const survived = audit.tools.map((tool) => tool.name)
  const fixtureMissing = auditNames.filter((tool) => !fixtureNames.includes(tool))
  const missing = expected.filter((tool) => !survived.includes(tool))
  const leaked = survived.filter((tool) => !expected.includes(tool))
  if (phantom.length > 0) {
    failures += 1
    console.error(`  FAIL policy.drop names ${phantom.length} tool(s) ${FROZEN_SOURCE[name]} does not define: ${phantom.join(', ')}`)
    console.error(`       frozen catalogue (${known.length}): ${known.join(', ')}`)
  }
  if (fixtureMissing.length > 0) {
    failures += 1
    console.error(`  FAIL audit fixture never carried ${fixtureMissing.join(', ')}; the drop assertion would be vacuous`)
  }
  if (missing.length > 0) {
    failures += 1
    console.error(`  FAIL kept tools missing from the trimmed catalogue: ${missing.join(', ')}`)
  }
  if (leaked.length > 0) {
    failures += 1
    console.error(`  FAIL drop list leaked: ${leaked.join(', ')}`)
  }
  for (const tool of REQUIRED_KEPT[name] ?? []) {
    if (!survived.includes(tool)) {
      failures += 1
      console.error(`  FAIL ${tool} must stay in the ${name} catalogue: an earlier verdict kept it`)
    }
  }
  if (failures === freeze) {
    console.log(`  drop audit: ${dropList.length} dropped / ${expected.length - 1} kept of ${known.length} frozen ${FROZEN_SOURCE[name]} verbs`
      + (inert.length > 0 ? ` (${inert.length} opt-in, inert: ${inert.join(', ')})` : '')
      + `, ${auditBefore} -> ${auditAfter} chars (${auditBefore - auditAfter} saved), sentinel kept`)
    if ((REQUIRED_KEPT[name] ?? []).length > 0) {
      console.log(`  kept by decision: ${REQUIRED_KEPT[name].join(', ')}`)
    }
  }
  const sample = tools[0]
  if (sample !== undefined && sample.inputSchema) {
    console.log(`  schema keys on ${sample.name}: ${Object.keys(sample.inputSchema).join(', ')}`)
  }
  if (sample !== undefined) console.log(`  e.g. ${sample.name}: "${sample.description}"`)
}
process.exit(failures === 0 ? 0 : 1)
