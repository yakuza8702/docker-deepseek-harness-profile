#!/usr/bin/env node
/**
 * Bake the profile-aware launcher into `docker/entrypoint.sh` (in place).
 *
 * WHY: a DSH profile is a BOOT-TIME launcher input (`dsh --profile <name>`).
 * Upstream's entrypoint hardcodes `dsh web`, so a container can never boot
 * anything else. This patch resolves the selection from
 *
 *     $DSH_HOME/active-profile.json   ->   { "version": 1, "active": "<name>" }
 *
 * validates it (1-64 chars, not a reserved name, `package.json` parses, and the
 * bundle list carries BOTH `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`)
 * and boots `dsh --profile <name>`. Anything missing, malformed or not
 * web-capable falls back to `web`: a bad selection must never leave the
 * container without a Web UI.
 *
 * Idempotent and content-anchored: re-run it after syncing upstream, and it
 * refuses to touch a file whose anchor is absent or ambiguous.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const entrypoint = process.argv[2] ?? path.join(here, '..', 'docker', 'entrypoint.sh')
const MARKER = 'Profile-aware boot'

const ANCHOR = [
  'node "${node_flags[@]}" "$DSH_BIN" web \\',
  '  --no-open --host 127.0.0.1 --port "$DSH_PORT" \\',
  '  ${trusted_args[@]+"${trusted_args[@]}"} "$@" >"$DSH_LOG" 2>&1 &'
].join('\n')

const REPLACEMENT = `# ---------------------------------------------------------------------
# Profile-aware boot (this repo's one change against upstream).
# A DSH profile is a LAUNCHER input, so the selection has to be resolved here,
# at boot: $DSH_HOME/active-profile.json { version, active }. Anything missing,
# malformed, or not web-capable falls back to "web": a bad selection must never
# leave the container without a Web UI.
# ---------------------------------------------------------------------
PROFILE="$(node -e 'const fs=require("fs"),path=require("path");try{const home=process.env.DSH_HOME||"/home/node/.dsh";const j=JSON.parse(fs.readFileSync(path.join(home,"active-profile.json"),"utf8"));const n=String(j.active||"");if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(n))process.exit(0);const m=JSON.parse(fs.readFileSync(path.join(home,"profiles",n,"package.json"),"utf8"));const b=(m&&m.dsh&&m.dsh.profile&&m.dsh.profile.bundles)||[];if(b.includes("@deepseek-ai/dsh-base")&&b.includes("@deepseek-ai/dsh-web-app"))process.stdout.write(n)}catch{}' 2>/dev/null || true)"
PROFILE="\${PROFILE:-web}"
log "active profile: \${PROFILE}"
node "\${node_flags[@]}" "$DSH_BIN" --profile "\${PROFILE}" \\
  --no-open --host 127.0.0.1 --port "$DSH_PORT" \\
  \${trusted_args[@]+"\${trusted_args[@]}"} "$@" >"$DSH_LOG" 2>&1 &`

const text = fs.readFileSync(entrypoint, 'utf8')
if (text.includes(MARKER)) {
  console.log(`already patched: ${entrypoint}`)
  process.exit(0)
}
const occurrences = text.split(ANCHOR).length - 1
if (occurrences !== 1) {
  console.error(`anchor matched ${occurrences} time(s) in ${entrypoint} — refusing to patch`)
  process.exit(1)
}
fs.writeFileSync(entrypoint, text.replace(ANCHOR, REPLACEMENT))
console.log(`patched ${entrypoint} (+${REPLACEMENT.split('\n').length - ANCHOR.split('\n').length} lines)`)
