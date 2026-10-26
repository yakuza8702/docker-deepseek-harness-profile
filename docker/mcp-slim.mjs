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
 *      entirely when the parameter is a boolean whose name already says it;
 *   5. deletes the JSON keys named in `stripKeys` (`$schema`,
 *      `additionalProperties`) at every depth of the final tool object. They are
 *      validator boilerplate: no tool-calling model reads them, and they are
 *      paid on every turn like everything else in the catalogue.
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
 *   node mcp-slim.mjs --selftest   # the `__proto__` rebuild guard (exit 0/1)
 *   MCP_SLIM=0                bypass (the wrapper execs the server directly)
 *   MCP_SLIM_VERBOSE=1        log a one-line before/after summary to stderr
 *
 * NOTE the names do not start with DSH_: the MCP client builds a child
 * environment by dropping every DSH_* name (packages/mcp/mcp-client/src/
 * transport.ts, scrubbedParentEnv), so a DSH_MCP_SLIM set in compose would
 * never reach this process.
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const selftest = argv.includes('--selftest')
const policyAt = argv.indexOf('--policy')
const sepAt = argv.indexOf('--')
if (!selftest && (policyAt === -1 || sepAt === -1 || sepAt <= policyAt + 1)) {
  process.stderr.write('mcp-slim: usage: mcp-slim.mjs --policy <file> -- <command> [args...]\n')
  process.exit(64)
}
const policyPath = argv[policyAt + 1]
const command = argv[sepAt + 1]
const commandArgs = argv.slice(sepAt + 2)

let policy = {
  drop: new Set(),
  overrides: {},
  stripKeys: new Set(),
  maxDescription: 160,
  maxParamDescription: 80
}

// Run before any policy is read: the guard is about the JSON rebuild, not the
// catalogue, and the build gate calls this so it is exercised, not assumed.
if (selftest) {
  const ok = selfTest()
  if (!ok) process.stderr.write('mcp-slim: self-test failed: a literal __proto__ key did not survive the rebuild as data\n')
  process.exit(ok ? 0 : 1)
}

try {
  const parsed = JSON.parse(readFileSync(policyPath, 'utf8'))
  policy = {
    server: typeof parsed.server === 'string' ? parsed.server : undefined,
    drop: new Set(Array.isArray(parsed.drop) ? parsed.drop : []),
    overrides: parsed.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : {},
    stripKeys: new Set(Array.isArray(parsed.stripKeys) ? parsed.stripKeys.filter((key) => typeof key === 'string') : []),
    maxDescription: Number.isFinite(parsed.maxDescription) ? parsed.maxDescription : 160,
    maxParamDescription: Number.isFinite(parsed.maxParamDescription) ? parsed.maxParamDescription : 80
  }
  if (!(policy.drop instanceof Set)) policy.drop = new Set()
  if (!(policy.stripKeys instanceof Set)) policy.stripKeys = new Set()
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

/**
 * Define an OWN enumerable data property.
 *
 * `out[key] = value` is not equivalent for the one key that is both legal JSON
 * and special to JS: a literal `"__proto__"` hits `Object.prototype`'s setter,
 * so the key vanishes from the JSON and its value is installed as the object's
 * prototype (or dropped outright when it is not an object). Both rebuilds below
 * iterate keys that come from a remote catalogue, so they write through here.
 * `defineProperty` never consults the prototype chain.
 */
function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
  return target
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
    for (const [key, value] of Object.entries(copy.properties)) setOwn(properties, key, compressProperty(key, value))
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

/**
 * Delete `policy.stripKeys` from every object in the tool, at any depth.
 *
 * `$schema` and `additionalProperties` are JSON-Schema validator boilerplate
 * that no tool-calling model acts on, but every server that publishes a strict
 * schema repeats them once per tool (and `additionalProperties` once per
 * parameter object). Arrays are walked element-wise, null and primitives are
 * returned untouched, and nothing is invented: a missing key stays missing.
 */
function prune(value) {
  if (Array.isArray(value)) return value.map((entry) => prune(entry))
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    if (policy.stripKeys.has(key)) continue
    setOwn(out, key, prune(child))
  }
  return out
}

/**
 * Guard for the `__proto__` hazard above, run by `--selftest` (and by the build
 * gate, which calls that). A remote catalogue may carry a literal `__proto__`
 * key at any depth; both rebuilds must keep it as an own property, leave the
 * object's prototype alone, and survive a JSON round-trip.
 */
function selfTest() {
  const raw = '{"__proto__":{"type":"string","description":"Kept as a key, not a prototype."},"type":"object"}'
  const rebuilt = [
    prune(JSON.parse(raw)),
    compressProperty('', { properties: JSON.parse(raw) }).properties
  ]
  return rebuilt.every((value) => value !== null
    && typeof value === 'object'
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.prototype.hasOwnProperty.call(value, '__proto__')
    && JSON.stringify(value).includes('"__proto__":')
    && Object.prototype.hasOwnProperty.call(JSON.parse(JSON.stringify(value)), '__proto__'))
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
  const trimmed = kept.map((tool) => prune(trimTool(tool)))
  after = JSON.stringify(trimmed).length
  if (!reported && process.env.MCP_SLIM_VERBOSE === '1') {
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
