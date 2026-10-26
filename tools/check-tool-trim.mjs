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
 * Exit 1 when a dropped tool survives, a description exceeds the cap, a
 * `stripKeys` key (`$schema`, `additionalProperties`) survives, the fixture stops
 * carrying those keys (which would make the assertion vacuous), or the proxy
 * breaks the JSON-RPC stream.
 */

import { spawn } from 'node:child_process'
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
      const names = ['click','hover','fill','type_text','drag','press_key','navigate_page','new_page','list_pages','select_page','close_page','resize_page','take_screenshot','take_snapshot','evaluate_script','wait_for','handle_dialog','get_tab_id','list_console_messages','get_console_message','list_network_requests','get_network_request','emulate','lighthouse_audit','performance_start_trace','performance_stop_trace','performance_analyze_insight']
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
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools } }) + '\\n')
    }
  }
})
`

function catalogue(name, { proxy = true } = {}) {
  return new Promise((resolve, reject) => {
    const policy = JSON.parse(readFileSync(POLICIES[name], 'utf8'))
    const child = proxy
      ? spawn(process.execPath, [SLIM, '--policy', POLICIES[name], '--', process.execPath, '-e', FAKE_SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(process.execPath, ['-e', FAKE_SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })
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
  const sample = tools[0]
  if (sample !== undefined && sample.inputSchema) {
    console.log(`  schema keys on ${sample.name}: ${Object.keys(sample.inputSchema).join(', ')}`)
  }
  if (sample !== undefined) console.log(`  e.g. ${sample.name}: "${sample.description}"`)
}
process.exit(failures === 0 ? 0 : 1)
