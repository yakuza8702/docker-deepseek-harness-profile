#!/usr/bin/env node
/**
 * Hide the image's INTEGRATED MCP rows from @xxxyz/dsh-mcp-manager's list.
 *
 * WHY
 * ---
 * `browser-mcp` and `brave-devtools-mcp` are not user-managed MCP servers. They
 * are rows owned by the image's bundles, and the Plugins page is their switch.
 * The MCP manager lists every loader-owned row read-only, which makes the same
 * capability appear in two places with two different (one inert) controls.
 *
 * The manager has no configuration for this — its `Config` carries a token and
 * nothing else — so the list is filtered at the source: rows whose
 * `readOnlyReason` is `loader` and whose id is in DSH_MCP_MANAGER_HIDDEN
 * (default: browser-mcp,brave-devtools-mcp) are omitted. Profile-owned servers
 * stay visible and editable, and setting the env var to an empty string shows
 * everything again.
 *
 * The patch is content-anchored, idempotent and NEVER fails the boot: a plugin
 * update that moves the anchor logs a warning and leaves the manager working
 * (it simply lists the built-in rows again).
 *
 * Usage: node tools/patch-mcp-manager.mjs <dsh-home>
 */
import fs from 'node:fs'
import path from 'node:path'

const home = process.argv[2] || process.env.DSH_HOME || '/home/node/.dsh'
const MARKER = 'dsh-mcp-manager-hidden-rows'
const ANCHOR = `        return {
            ok: true,
            rows: rows.map((row) => ({`

const REPLACEMENT = `        // Integrated rows (browser-mcp, brave-devtools-mcp) are owned by the
        // image's bundles and switched on the Plugins page; listing them here
        // read-only gives the user a second, inert control for the same thing.
        // ${MARKER}
        const hiddenIds = new Set(
            (process.env.DSH_MCP_MANAGER_HIDDEN ?? 'browser-mcp,brave-devtools-mcp')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
        );
        const visibleRows = rows.filter((row) => !(hiddenIds.has(row.id) && row.readOnlyReason === 'loader'));
        return {
            ok: true,
            rows: visibleRows.map((row) => ({`

const profilesRoot = path.join(home, 'profiles')
if (!fs.existsSync(profilesRoot)) process.exit(0)

let patched = 0
let skipped = 0
for (const profile of fs.readdirSync(profilesRoot)) {
  const target = path.join(profilesRoot, profile, 'node_modules', '@xxxyz', 'dsh-mcp-manager', 'lib', 'index.js')
  if (!fs.existsSync(target)) continue
  const source = fs.readFileSync(target, 'utf8')
  if (source.includes(MARKER)) { skipped += 1; continue }
  if (!source.includes(ANCHOR)) {
    console.warn(`patch-mcp-manager: anchor not found in ${target} — left untouched (the manager still works, built-in rows stay listed)`)
    continue
  }
  fs.writeFileSync(target, source.replace(ANCHOR, REPLACEMENT))
  patched += 1
  console.log(`patch-mcp-manager: hid built-in MCP rows in ${target}`)
}
if (patched === 0 && skipped === 0) console.log('patch-mcp-manager: no installed mcp-manager to patch')
