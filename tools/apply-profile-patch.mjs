#!/usr/bin/env node
/**
 * Bake the profile-aware launcher into `docker/entrypoint.sh`.
 *
 * Generates the committed file from a PRISTINE entrypoint (the upstream
 * `docker/entrypoint.sh` of yakuza8702/docker-deepseek-harness), so it can be
 * re-run after every upstream sync:
 *
 *   node tools/apply-profile-patch.mjs [pristine-entrypoint.sh]
 *
 * Two changes, both in the web-stack branch:
 *
 *  1. PROFILE-AWARE BOOT — the profile is a BOOT-TIME launcher input
 *     (`dsh --profile <name>`), so the selection is resolved here from
 *     `$DSH_HOME/active-profile.json` (`{ version, active }`), validated
 *     (name shape, manifest parses, bundles carry BOTH `@deepseek-ai/dsh-base`
 *     and `@deepseek-ai/dsh-web-app`) and falls back to `web`: a bad selection
 *     can never leave the container without a Web UI.
 *  2. PROFILE-SWITCHER OVERLAY — when
 *     `/opt/seek-harness/profile-switcher.overlay.yml` exists, it is applied as
 *     a launcher `--patch` overlay, which mounts this repo's in-app profile
 *     control into every profile WITHOUT editing any profile directory.
 *     Disable with `DSH_PROFILE_OVERLAY=` (empty) or point it elsewhere.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(here, '..')
const source = process.argv[2] ?? path.join(projectRoot, '..', 'docker-deepseek-harness', 'docker', 'entrypoint.sh')
const target = path.join(projectRoot, 'docker', 'entrypoint.sh')
const MARKER = 'Profile-aware boot'

const ANCHOR = [
  'node "${node_flags[@]}" "$DSH_BIN" web \\',
  '  --no-open --host 127.0.0.1 --port "$DSH_PORT" \\',
  '  ${trusted_args[@]+"${trusted_args[@]}"} "$@" >"$DSH_LOG" 2>&1 &'
].join('\n')

const BLOCK = `# ---------------------------------------------------------------------
# Profile-aware boot (this repo's change against upstream).
# A DSH profile is a LAUNCHER input, so the selection has to be resolved here,
# at boot: $DSH_HOME/active-profile.json { version, active }. Anything missing,
# malformed, or not web-capable falls back to "web": a bad selection must never
# leave the container without a Web UI.
# ---------------------------------------------------------------------
PROFILE="$(node -e 'const fs=require("fs"),path=require("path");try{const home=process.env.DSH_HOME||"/home/node/.dsh";const j=JSON.parse(fs.readFileSync(path.join(home,"active-profile.json"),"utf8"));const n=String(j.active||"");if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(n))process.exit(0);const m=JSON.parse(fs.readFileSync(path.join(home,"profiles",n,"package.json"),"utf8"));const b=(m&&m.dsh&&m.dsh.profile&&m.dsh.profile.bundles)||[];if(b.includes("@deepseek-ai/dsh-base")&&b.includes("@deepseek-ai/dsh-web-app"))process.stdout.write(n)}catch{}' 2>/dev/null || true)"
PROFILE="\${PROFILE:-web}"
log "active profile: \${PROFILE}"

# ---------------------------------------------------------------------
# In-app profile control (dsh-profile-switcher) as a launcher overlay.
# Applied AFTER the profile layer, so no profile directory is ever edited: the
# pill in the Web UI comes from this file. DSH_PROFILE_OVERLAY=<path> overrides
# it; DSH_PROFILE_OVERLAY= disables it.
# ---------------------------------------------------------------------
declare -a overlay_args=()
OVERLAY="\${DSH_PROFILE_OVERLAY-/opt/seek-harness/profile-switcher.overlay.yml}"
if [[ -n "$OVERLAY" && -f "$OVERLAY" ]]; then
  overlay_args+=(--patch "$OVERLAY")
  log "overlay: $OVERLAY"
fi

node "\${node_flags[@]}" "$DSH_BIN" --profile "\${PROFILE}" \\
  \${overlay_args[@]+"\${overlay_args[@]}"} \\
  --no-open --host 127.0.0.1 --port "$DSH_PORT" \\
  \${trusted_args[@]+"\${trusted_args[@]}"} "$@" >"$DSH_LOG" 2>&1 &`

if (!fs.existsSync(source)) {
  console.error(`pristine entrypoint not found: ${source}\nPass it as the first argument (upstream docker/entrypoint.sh).`)
  process.exit(1)
}
const original = fs.readFileSync(source, 'utf8')
if (original.includes(MARKER)) {
  console.error(`${source} is already patched — pass a PRISTINE upstream entrypoint`)
  process.exit(1)
}
const occurrences = original.split(ANCHOR).length - 1
if (occurrences !== 1) {
  console.error(`anchor matched ${occurrences} time(s) in ${source} — refusing to write (upstream changed?)`)
  process.exit(1)
}
fs.writeFileSync(target, original.replace(ANCHOR, BLOCK), { mode: 0o755 })
const added = BLOCK.split('\n').length - ANCHOR.split('\n').length
console.log(`wrote ${path.relative(process.cwd(), target)} (+${added} lines) from ${source}`)
