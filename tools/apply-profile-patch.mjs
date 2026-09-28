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
write_boot_state starting "booting profile \${PROFILE}"

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
  console.error(`anchor matched ${occurrences} times in ${source} — refusing to write (upstream changed?)`)
  process.exit(1)
}
let patched = original.replace(ANCHOR, BLOCK)

/**
 * 3. BOOT DIAGNOSTICS — record the boot outcome where the RECOVERY SURFACE can
 *    read it. The failure case is the whole point: when the profile cannot boot,
 *    no plugin inside the harness runs, so the entrypoint is the only witness.
 *    `docker/proxy.mjs` serves it to the browser (see docker/recovery.mjs).
 */
const DIAG_HELPER = `# ---------------------------------------------------------------------
# Boot diagnostics for the recovery surface (docker/recovery.mjs).
# The state file is the only witness of a boot that never reached the harness,
# so the reverse proxy can show WHY instead of a bare 502.
# ---------------------------------------------------------------------
BOOT_STATE_FILE="\${DSH_BOOT_STATE_FILE:-/tmp/dsh-boot.json}"
write_boot_state() {   # write_boot_state <state> <reason> [detail]
  node -e '
    const fs = require("fs");
    const [file, state, reason, detail, profile] = process.argv.slice(1);
    let logTail = "";
    try {
      const full = fs.readFileSync("/tmp/dsh-web.log", "utf8");
      // The whole log is what a user needs to hand to an agent (DSH NEXT shows a
      // full, copyable report). Keep a generous tail rather than a teaser.
      const lines = full.split("\\n");
      logTail = lines.slice(-400).join("\\n").trim();
    } catch {}
    fs.writeFileSync(file, JSON.stringify({ state, reason: reason || null, detail: detail || null, profile: profile || null, at: new Date().toISOString(), logTail: logTail || null }, null, 2) + "\\n");
  ' "$BOOT_STATE_FILE" "$1" "$2" "\${3:-}" "\${PROFILE:-}"
}
fatal() {
  echo "[seek-harness] FATAL: $*" >&2
  write_boot_state failed "$*" "the harness process exited during startup"
  # KEEP THE PROXY ALIVE. This is the whole point of the recovery surface: if the
  # harness cannot boot, the proxy must stay up to serve the failure page and the
  # switch-profile / Safe-Mode actions. Tearing everything down (the stock
  # behaviour) turns a broken profile into an unrecoverable crash loop.
  if [[ -n "\${PROXY_PID:-}" ]] && kill -0 "$PROXY_PID" 2>/dev/null; then
    log "harness failed to start — leaving the reverse proxy up on \${PROXY_HOST}:\${PROXY_PORT} so the recovery page can fix the profile"
    write_boot_state failed "$*" "harness down; recovery surface serving on port \${PROXY_PORT}"
    set +e
    wait "$PROXY_PID"
    exit 0
  fi
  exit 1
}

`
const FATAL_ANCHOR = `fatal() {
  echo "[seek-harness] FATAL: $*" >&2
  # never leave a half-started stack behind
  if [[ -n "\${DSH_PID:-}" ]]; then
    kill -TERM "$DSH_PID" \${PROXY_PID:+"$PROXY_PID"} 2>/dev/null || true
  fi
  exit 1
}
`
// terminate() must mark a deliberate stop so the watchdog stands down.
const TERMINATE_OLD = `terminate() {
  log "signal received — stopping DSH (\${DSH_PID}) and proxy (\${PROXY_PID})"
  kill -TERM "$DSH_PID" "$PROXY_PID" \${TAIL_PID:+"$TAIL_PID"} 2>/dev/null || true
}`
const TERMINATE_NEW = `terminate() {
  log "signal received — stopping DSH (\${DSH_PID}) and proxy (\${PROXY_PID})"
  : > /tmp/dsh-stopping
  kill -TERM "$DSH_PID" "$PROXY_PID" \${TAIL_PID:+"$TAIL_PID"} \${WATCHDOG_PID:+"$WATCHDOG_PID"} 2>/dev/null || true
}`
if (patched.split(TERMINATE_OLD).length - 1 !== 1) {
  console.error('anchor (terminate) matched an unexpected number of times — refusing to write')
  process.exit(1)
}
patched = patched.replace(TERMINATE_OLD, TERMINATE_NEW)

if (patched.split(FATAL_ANCHOR).length - 1 !== 1) {
  console.error('anchor (fatal) matched an unexpected number of times — refusing to write')
  process.exit(1)
}
patched = patched.replace(FATAL_ANCHOR, DIAG_HELPER)

/** 3b. Mark the boot as started, then as ready, and watch for a late death. */
const READY_ANCHOR = `log "=============================================================="
log " DeepSeek Harness is ready (no browser stack included)"`
const READY_BLOCK = `# A degraded boot still SERVES the UI, so it is not a failure — but the user
# should not have to open the container log to learn that an entry did not
# activate, or which profile is missing a plugin. Record it as degraded with
# the reasons; the in-app panel and the recovery page both read this.
if grep -qE "warning: [0-9]+ entr(y|ies) did not activate|failed to import" "$DSH_LOG" 2>/dev/null; then
  DEGRADED="$(grep -E "did not activate|failed to import|skipping profile bundle|Error:" "$DSH_LOG" 2>/dev/null | head -12 | paste -sd ' | ' - || true)"
  write_boot_state degraded "the harness started with errors" "\${DEGRADED:-see the log tail}"
  log "WARNING: degraded boot — see the recovery panel for details"
else
  write_boot_state ready "" ""
fi
# Late-death watchdog: if the harness dies AFTER the ready banner (a plugin that
# crashes on its first request, an OOM), flip the state to failed so the recovery
# page shows the real reason instead of an empty 502. A deliberate stop writes the
# flag first, so a normal container stop is never reported as a boot failure.
# A REQUESTED profile switch (/tmp/dsh-restart-requested, written by the in-app
# switcher) is deliberate too: it must not be recorded as a crash.
(
  while kill -0 "$DSH_PID" 2>/dev/null; do
    [[ -f /tmp/dsh-stopping || -f /tmp/dsh-restart-requested ]] && exit 0
    sleep 5
  done
  [[ -f /tmp/dsh-stopping || -f /tmp/dsh-restart-requested ]] && exit 0
  write_boot_state failed "the harness process exited after startup" "exit observed by the entrypoint watchdog"
) &
WATCHDOG_PID=$!

log "=============================================================="
log " DeepSeek Harness is ready (no browser stack included)"`
if (patched.split(READY_ANCHOR).length - 1 !== 1) {
  console.error('anchor (ready banner) matched an unexpected number of times — refusing to write')
  process.exit(1)
}
patched = patched.replace(READY_ANCHOR, READY_BLOCK)

/**
 * 4. RESILIENT SUPERVISION — a DSH exit must NOT take the recovery surface down.
 *    Stock behaviour stops the proxy and exits, which turns a broken profile into
 *    a crash loop with nothing to click. Here the proxy stays up and serves the
 *    recovery page; the proxy's own exit (a deliberate restart from that page)
 *    still shuts the stack down.
 *
 *    The ONE exception is a profile switch requested from the in-app control: it
 *    exits DSH after writing /tmp/dsh-restart-requested, and that exit has to
 *    take the whole stack down — otherwise nothing ever reboots the container and
 *    the switch silently does not happen. Same teardown as the recovery page.
 */
const SUPERVISE_OLD = `# Supervise: if either process exits, stop the other and propagate status.
set +e
wait -n "$DSH_PID" "$PROXY_PID"
status=$?
log "a managed process exited (status=\${status}) \u2014 shutting down"
terminate
wait "$DSH_PID" "$PROXY_PID" 2>/dev/null
exit "$status"`
const SUPERVISE_NEW = `# Supervise. A DSH exit keeps the REVERSE PROXY serving the recovery page, so a
# profile that cannot boot is fixable from the browser instead of becoming a
# crash loop. The proxy's own exit (a deliberate restart from that page) still
# shuts the stack down so the container policy can boot the new selection — and so
# does a profile switch requested in the UI (/tmp/dsh-restart-requested).
set +e
while true; do
  wait -n "$DSH_PID" "$PROXY_PID"
  status=$?
  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    log "proxy exited (status=\${status}) \u2014 shutting down"
    terminate
    exit "$status"
  fi
  if [[ -f /tmp/dsh-restart-requested ]]; then
    log "profile switch requested — shutting the stack down so the container boots the new selection"
    terminate
    exit 0
  fi
  write_boot_state failed "the harness process exited" "recovery surface serving on port \${PROXY_PORT}"
  log "harness exited (status=\${status}) \u2014 recovery surface still serving on \${PROXY_HOST}:\${PROXY_PORT}"
  log "open the harness URL to switch profile or boot Safe Mode"
  wait "$PROXY_PID"
  exit 0
done`
if (patched.split(SUPERVISE_OLD).length - 1 !== 1) {
  console.error('anchor (supervise) matched an unexpected number of times — refusing to write')
  process.exit(1)
}
patched = patched.replace(SUPERVISE_OLD, SUPERVISE_NEW)

fs.writeFileSync(target, patched, { mode: 0o755 })
const added = BLOCK.split('\n').length - ANCHOR.split('\n').length
console.log(`wrote ${path.relative(process.cwd(), target)} (+${added} lines from the profile block, + boot diagnostics) from ${source}`)
