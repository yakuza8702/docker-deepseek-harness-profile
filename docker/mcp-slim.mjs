#!/usr/bin/env node
/**
 * mcp-slim — a stdio MCP proxy that trims the tool catalogue on the way out.
 *
 * WHY
 * ---
 * Every tool schema rides in the *static* context of every request, so a
 * verbose sentence in a description is paid on every turn of every session.
 * The two browser MCP servers in this image are the biggest contributors
 * (~24 Playwright tools + ~32 DevTools tools), and an MCP server has no
 * "short description" mode: its wording is baked into the package.
 *
 * A proxy is the one place that can change it without patch-patching minified
 * bundles: it spawns the real server, passes everything through untouched, and
 * rewrites only the `tools/list` reply — the same idea as caveman's text
 * compression, applied to a tool catalogue instead of prose.
 *
 * WHAT IT DOES TO `tools/list`
 *   1. drops tools named in the policy (`drop`), for verbs another server in
 *      the same harness already offers better;
 *   2. replaces a tool's description with `overrides[name]` when the policy has
 *      one (hand-written, terse, still precise);
 *   3. otherwise keeps the first sentence, strips the "This tool is used to…"
 *      throat-clearing, and caps it at `maxDescription` characters;
 *   4. caps each parameter description at `maxParamDescription`, and removes it
 *      entirely when the parameter is a boolean whose name already says it.
 *
 * WHAT IT NEVER DOES
 *   * never touches a request, a notification, or any other response;
 *   * never reorders handles, ids, or notifications (bytes pass through unless
 *     the message is a `tools/list` reply);
 *   * never fails the handshake — a parse or rewrite error forwards the
 *     original line verbatim.
 *
 * USAGE
 *   node mcp-slim.mjs --policy <file.json> -- <command> [args...]
 *   DSH_MCP_SLIM=0            bypass (the wrapper execs the server directly)
 *   DSH_MCP_SLIM_VERBOSE=1    log a one-line before/after summary to stderr
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const policyAt = argv.indexOf('--policy')
const sepAt = argv.indexOf('--')
if (policyAt === -1 || sepAt === -1 || sepAt <= policyAt + 1) {
  process.stderr.write('mcp-slim: usage: mcp-slim.mjs --policy <file> -- <command> [args...]\n')
  process.exit(64)
}
const policyPath = argv[policyAt + 1]
const command = argv[sepAt + 1]
const commandArgs = argv.slice(sepAt + 2)

let policy = { drop: [], overrides: {}, maxDescription: 160, maxParamDescription: 80 }
try {
  const parsed = JSON.parse(readFileSync(policyPath, 'utf8'))
  policy = {
    server: typeof parsed.server === 'string' ? parsed.server : undefined,
    drop: new Set(Array.isArray(parsed.drop) ? parsed.drop : []),
    overrides: parsed.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : {},
    maxDescription: Number.isFinite(parsed.maxDescription) ? parsed.maxDescription : 160,
    maxParamDescription: Number.isFinite(parsed.maxParamDescription) ? parsed.maxParamDescription : 80
  }
  if (!(policy.drop instanceof Set)) policy.drop = new Set()
} catch (error) {
  process.stderr.write(`mcp-slim: cannot read policy ${policyPath}: ${error.message}; passing everything through\n`)
}

/** First sentence, filler removed, capped at `max` characters on a word boundary. */
function compress(text, max) {
  if (typeof text !== 'string' || text === '') return text
  let out = text.replace(/\s+/gu, ' ').trim()
  // Throat-clearing openers that cost tokens and carry no information.
  out = out.replace(/^(this tool (?:is used to|will|lets you|allows you to|can)\s+)/iu, '')
  out = out.replace(/^(use this tool to\s+)/iu, '')
  out = out.replace(/^(this (?:function|command) (?:is used to|will|lets you)\s+)/iu, '')
  out = out.replace(/^(whether to\s+(?:include\s+)?)/iu, '')
  out = out.replace(/^the\s+/iu, '')
  out = out.replace(/^optional[:\s]+/iu, '')
  // Prefer a sentence boundary; a full stop inside an abbreviation is rare
  // enough in tool prose that this is the better trade.
  const sentence = /^([\s\S]{0,400}?[.!?])(?:\s|$)/u.exec(out)
  if (sentence !== null && sentence[1].length <= max) out = sentence[1]
  if (out.length > max) {
    const cut = out.slice(0, max)
    const space = cut.lastIndexOf(' ')
    out = `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[.,;:\s]+$/u, '')}…`
  }
  return out
}

/** Compress one parameter's description; booleans lose it entirely. */
function compressProperty(name, node) {
  if (node === null || typeof node !== 'object') return node
  const copy = { ...node }
  if (typeof copy.description === 'string') {
    // A boolean's name and type already say everything: "verbose: Whether to
    // include all possible information…" adds tokens, not information.
    if (copy.type === 'boolean') delete copy.description
    else copy.description = compress(copy.description, policy.maxParamDescription)
  }
  if (copy.properties && typeof copy.properties === 'object') {
    const properties = {}
    for (const [key, value] of Object.entries(copy.properties)) properties[key] = compressProperty(key, value)
    copy.properties = properties
  }
  if (copy.items) copy.items = compressProperty(name, copy.items)
  return copy
}

function trimTool(tool) {
  const out = { ...tool }
  if (typeof policy.overrides[tool.name] === 'string') out.description = policy.overrides[tool.name]
  else if (typeof tool.description === 'string') out.description = compress(tool.description, policy.maxDescription)
  if (tool.inputSchema && typeof tool.inputSchema === 'object' && tool.inputSchema.properties) {
    out.inputSchema = { ...tool.inputSchema, properties: compressProperty('', { properties: tool.inputSchema.properties }).properties }
  }
  return out
}

let before = 0
let after = 0
let reported = false

/** Rewrite one `tools/list` result; returns the message to forward. */
function rewrite(message) {
  const tools = message?.result?.tools
  if (!Array.isArray(tools)) return message
  const kept = []
  for (const tool of tools) {
    if (tool && policy.drop.has(tool.name)) continue
    kept.push(tool)
  }
  before = JSON.stringify(tools).length
  const trimmed = kept.map(trimTool)
  after = JSON.stringify(trimmed).length
  if (!reported && process.env.DSH_MCP_SLIM_VERBOSE === '1') {
    reported = true
    process.stderr.write(`mcp-slim[${policy.server ?? 'mcp'}]: ${tools.length} -> ${kept.length} tools, `
      + `${before} -> ${after} chars (~${Math.round(before / 4)} -> ~${Math.round(after / 4)} tokens)\n`)
  }
  return { ...message, result: { ...message.result, tools: trimmed } }
}

const child = spawn(command, commandArgs, { stdio: ['pipe', 'pipe', 'inherit'] })

child.on('error', (error) => {
  process.stderr.write(`mcp-slim: cannot start ${command}: ${error.message}\n`)
  process.exit(127)
})
child.on('exit', (code, signal) => {
  process.exit(signal !== null ? 1 : (code ?? 0))
})

process.stdin.pipe(child.stdin)
process.stdin.on('error', () => {})
child.stdin.on('error', () => {})

if (commandArgs === undefined) process.exit(64)

let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf('\n')
    if (line.trim() === '') {
      process.stdout.write(`${line}\n`)
      continue
    }
    if (!line.includes('"tools"')) {
      process.stdout.write(`${line}\n`)
      continue
    }
    let forwarded = line
    try {
      const message = JSON.parse(line)
      forwarded = JSON.stringify(rewrite(message))
    } catch {
      // Not JSON, or an unexpected shape: forward the original bytes.
    }
    process.stdout.write(`${forwarded}\n`)
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal)
  })
}
