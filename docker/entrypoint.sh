#!/usr/bin/env bash
# =====================================================================
# seek-harness entrypoint
#
#   docker run image                     -> DSH web + reverse proxy
#   docker run image web [extra args]    -> extra args forwarded to `dsh web`
#   docker run image --profile headless "task"
#                                        -> flags passed straight to `dsh`
#   docker run image bash                -> arbitrary command exec
#
# Docker engine access (this container's docker CLI):
#   * TCP proxy :  -e DOCKER_HOST=tcp://docker-proxy:2375
#   * socket    :  -v /var/run/docker.sock:/var/run/docker.sock
#                  + compose.docker.yaml override (group_add DOCKER_GID)
# =====================================================================
set -euo pipefail

DSH_PORT="${DSH_PORT:-3079}"
PROXY_PORT="${PROXY_PORT:-3080}"
PROXY_HOST="${PROXY_HOST:-0.0.0.0}"
DSH_NODE_FLAGS="${DSH_NODE_FLAGS---expose-internals}"
DSH_BIN="${DSH_BIN:-/usr/local/bin/dsh}"
PROXY_SCRIPT="${PROXY_SCRIPT:-/opt/seek-harness/proxy.mjs}"

log() { echo "[seek-harness] $*"; }
# ---------------------------------------------------------------------
# Boot diagnostics for the recovery surface (docker/recovery.mjs).
# The state file is the only witness of a boot that never reached the harness,
# so the reverse proxy can show WHY instead of a bare 502.
# ---------------------------------------------------------------------
BOOT_STATE_FILE="${DSH_BOOT_STATE_FILE:-/tmp/dsh-boot.json}"
write_boot_state() {   # write_boot_state <state> <reason> [detail]
  node -e '
    const fs = require("fs");
    const [file, state, reason, detail, profile] = process.argv.slice(1);
    let logTail = "";
    try {
      const full = fs.readFileSync("/tmp/dsh-web.log", "utf8");
      // The whole log is what a user needs to hand to an agent (DSH NEXT shows a
      // full, copyable report). Keep a generous tail rather than a teaser.
      const lines = full.split("\n");
      logTail = lines.slice(-400).join("\n").trim();
    } catch {}
    fs.writeFileSync(file, JSON.stringify({ state, reason: reason || null, detail: detail || null, profile: profile || null, at: new Date().toISOString(), logTail: logTail || null }, null, 2) + "\n");
  ' "$BOOT_STATE_FILE" "$1" "$2" "${3:-}" "${PROFILE:-}"
}
fatal() {
  echo "[seek-harness] FATAL: $*" >&2
  write_boot_state failed "$*" "the harness process exited during startup"
  # KEEP THE PROXY ALIVE. This is the whole point of the recovery surface: if the
  # harness cannot boot, the proxy must stay up to serve the failure page and the
  # switch-profile / Safe-Mode actions. Tearing everything down (the stock
  # behaviour) turns a broken profile into an unrecoverable crash loop.
  if [[ -n "${PROXY_PID:-}" ]] && kill -0 "$PROXY_PID" 2>/dev/null; then
    log "harness failed to start — leaving the reverse proxy up on ${PROXY_HOST}:${PROXY_PORT} so the recovery page can fix the profile"
    write_boot_state failed "$*" "harness down; recovery surface serving on port ${PROXY_PORT}"
    set +e
    wait "$PROXY_PID"
    exit 0
  fi
  exit 1
}


if [[ "$DSH_PORT" == "$PROXY_PORT" ]]; then
  fatal "DSH_PORT (${DSH_PORT}) must differ from PROXY_PORT (${PROXY_PORT})."
fi

# ---------------------------------------------------------------------
# Docker access diagnostics (non-fatal — purely informational)
# ---------------------------------------------------------------------
if [[ -n "${DOCKER_HOST:-}" ]]; then
  log "docker: engine via TCP proxy — DOCKER_HOST=${DOCKER_HOST}"
elif [[ -S /var/run/docker.sock ]]; then
  if [[ -w /var/run/docker.sock ]]; then
    log "docker: /var/run/docker.sock is mounted and writable"
  else
    log "WARN: /var/run/docker.sock mounted but NOT writable by uid=$(id -u)."
    log "      Fix: compose.docker.yaml override with group_add: [\"${DOCKER_GID:-999}\"]"
    log "      (run 'stat -c %g /var/run/docker.sock' on the HOST to get the gid)."
  fi
else
  log "docker: no DOCKER_HOST and no /var/run/docker.sock — CLI available, no engine access (ok if unintended)"
fi

# ---------------------------------------------------------------------
# Arg dispatch
# ---------------------------------------------------------------------
cmd="${1:-web}"

if [[ "$cmd" != "web" ]]; then
  if [[ "$cmd" == -* ]]; then
    log "forwarding flags to dsh: dsh $*"
    # DSH main process gets the same node flags as the web stack
    declare -a _nf=()
    [[ -n "$DSH_NODE_FLAGS" ]] && read -r -a _nf <<< "$DSH_NODE_FLAGS"
    exec node "${_nf[@]}" "$DSH_BIN" "$@"
  else
    log "exec: $*"
    exec "$@"
  fi
fi
shift || true

# ---------------------------------------------------------------------
# Start the stack: DSH on loopback + proxy on 0.0.0.0 (the 0.0.0.0 fix)
# ---------------------------------------------------------------------
declare -a trusted_args=()
if [[ -n "${DSH_TRUSTED_HOSTS:-}" ]]; then
  IFS=',' read -r -a _hosts <<< "$DSH_TRUSTED_HOSTS"
  for h in "${_hosts[@]}"; do
    h="${h#"${h%%[![:space:]]*}"}"; h="${h%"${h##*[![:space:]]}"}"
    [[ -n "$h" ]] && trusted_args+=(--trusted-host "$h")
  done
fi

declare -a node_flags=()
[[ -n "$DSH_NODE_FLAGS" ]] && read -r -a node_flags <<< "$DSH_NODE_FLAGS"

# DSH output goes to a log file (streamed to container logs by a tail helper)
# so the boot token can be extracted for the proxy's zero-auth auto-login.
DSH_LOG=/tmp/dsh-web.log
: > "$DSH_LOG"
: > /tmp/dsh-token
log "starting DSH web on 127.0.0.1:${DSH_PORT} (DSH_HOME=${DSH_HOME:-unset}, HOME=${HOME})"
# ---------------------------------------------------------------------
# Profile-aware boot (this repo's change against upstream).
# A DSH profile is a LAUNCHER input, so the selection has to be resolved here,
# at boot: $DSH_HOME/active-profile.json { version, active }. Anything missing,
# malformed, or not web-capable falls back to "web": a bad selection must never
# leave the container without a Web UI.
# ---------------------------------------------------------------------
PROFILE="$(node -e 'const fs=require("fs"),path=require("path");try{const home=process.env.DSH_HOME||"/home/node/.dsh";const j=JSON.parse(fs.readFileSync(path.join(home,"active-profile.json"),"utf8"));const n=String(j.active||"");if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(n))process.exit(0);const m=JSON.parse(fs.readFileSync(path.join(home,"profiles",n,"package.json"),"utf8"));const b=(m&&m.dsh&&m.dsh.profile&&m.dsh.profile.bundles)||[];if(b.includes("@deepseek-ai/dsh-base")&&b.includes("@deepseek-ai/dsh-web-app"))process.stdout.write(n)}catch{}' 2>/dev/null || true)"
PROFILE="${PROFILE:-web}"
log "active profile: ${PROFILE}"
write_boot_state starting "booting profile ${PROFILE}"

# ---------------------------------------------------------------------
# In-app profile control (dsh-profile-switcher) as a launcher overlay.
# Applied AFTER the profile layer, so no profile directory is ever edited: the
# pill in the Web UI comes from this file. DSH_PROFILE_OVERLAY=<path> overrides
# it; DSH_PROFILE_OVERLAY= disables it.
# ---------------------------------------------------------------------
declare -a overlay_args=()
OVERLAY="${DSH_PROFILE_OVERLAY-/opt/seek-harness/profile-switcher.overlay.yml}"
if [[ -n "$OVERLAY" && -f "$OVERLAY" ]]; then
  overlay_args+=(--patch "$OVERLAY")
  log "overlay: $OVERLAY"
fi

node "${node_flags[@]}" "$DSH_BIN" --profile "${PROFILE}" \
  ${overlay_args[@]+"${overlay_args[@]}"} \
  --no-open --host 127.0.0.1 --port "$DSH_PORT" \
  ${trusted_args[@]+"${trusted_args[@]}"} "$@" >"$DSH_LOG" 2>&1 &
DSH_PID=$!
tail -F "$DSH_LOG" 2>/dev/null &
TAIL_PID=$!

log "starting reverse proxy on ${PROXY_HOST}:${PROXY_PORT}"
node "$PROXY_SCRIPT" &
PROXY_PID=$!

terminate() {
  log "signal received — stopping DSH (${DSH_PID}) and proxy (${PROXY_PID})"
  : > /tmp/dsh-stopping
  kill -TERM "$DSH_PID" "$PROXY_PID" ${TAIL_PID:+"$TAIL_PID"} ${WATCHDOG_PID:+"$WATCHDOG_PID"} 2>/dev/null || true
}
trap terminate TERM INT

# Wait for DSH to accept HTTP on its loopback port (profile boot can take a while)
for i in $(seq 1 120); do
  if curl -s -o /dev/null "http://127.0.0.1:${DSH_PORT}/"; then
    break
  fi
  if ! kill -0 "$DSH_PID" 2>/dev/null; then
    fatal "dsh exited during startup (exit=$?) — check logs above"
  fi
  sleep 1
done

# Zero-auth LAN mode: `dsh web` generates a session token at boot and prints
# its URL. Capture it and hand it to the reverse proxy so it can transparently
# mint browser sessions — the user just opens the bare LAN URL. The token is
# in-memory per boot; that is fine because the proxy re-mints on next visit.
DSH_TOKEN=""
[[ -s "$DSH_LOG" ]] && DSH_TOKEN="$(grep -m1 -oE '\?token=[A-Za-z0-9_-]+' "$DSH_LOG" | cut -d= -f2 || true)"
if [[ -n "$DSH_TOKEN" ]]; then
  export DSH_TOKEN
  printf '%s\n' "$DSH_TOKEN" > /tmp/dsh-token
  log "dsh web token captured — proxy auto-authenticates browsers (zero-auth LAN)"
fi
# The token line can land AFTER the HTTP listener answers (race seen in the
# wild: banner said "n/a" while dsh printed its token moments later). Retry in
# the background — the proxy re-reads /tmp/dsh-token per request, so auto-login
# activates the moment the token appears, no restart needed.
(
  for _ in $(seq 1 300); do
    tok="$(grep -m1 -oE '\?token=[A-Za-z0-9_-]+' "$DSH_LOG" 2>/dev/null | cut -d= -f2 || true)"
    if [[ -n "$tok" ]]; then
      printf '%s\n' "$tok" > /tmp/dsh-token
      log "dsh web token captured (background retry) — auto-login active"
      exit 0
    fi
    kill -0 "$DSH_PID" 2>/dev/null || exit 0
    sleep 1
  done
  log "WARNING: boot token never appeared — zero-auth auto-login inactive"
) &
DSH_TOKEN_URL="$(grep -m1 -oE '/\?token=[A-Za-z0-9_-]+' "$DSH_LOG" 2>/dev/null || true)"

AUTH_STATE="OFF"
[[ -n "${PROXY_USERNAME:-}" && -n "${PROXY_PASSWORD:-}" ]] && AUTH_STATE="ON"

# Bail out early (rather than printing a misleading ready banner) if either
# process died while we were waiting for DSH to boot.
if ! kill -0 "$DSH_PID" 2>/dev/null; then fatal "dsh exited during startup — check logs above"; fi
if ! kill -0 "$PROXY_PID" 2>/dev/null; then fatal "proxy exited during startup — check logs above"; fi

# A degraded boot still SERVES the UI, so it is not a failure — but the user
# should not have to open the container log to learn that an entry did not
# activate, or which profile is missing a plugin. Record it as degraded with
# the reasons; the in-app panel and the recovery page both read this.
if grep -qE "warning: [0-9]+ entr(y|ies) did not activate|failed to import" "$DSH_LOG" 2>/dev/null; then
  DEGRADED="$(grep -E "did not activate|failed to import|skipping profile bundle|Error:" "$DSH_LOG" 2>/dev/null | head -12 | paste -sd ' | ' - || true)"
  write_boot_state degraded "the harness started with errors" "${DEGRADED:-see the log tail}"
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
log " DeepSeek Harness is ready (no browser stack included)"
log "   local : http://127.0.0.1:${PROXY_PORT}/"
log "   LAN   : http://<host-ip>:${PROXY_PORT}/   (basic auth: ${AUTH_STATE})"
log "   token : ${DSH_TOKEN_URL:-pending (background capture)}   (append to your LAN URL; auto-login usually makes it unnecessary)"
log "   WS channels are forwarded automatically by the proxy"
log "   DSH pid=${DSH_PID}  proxy pid=${PROXY_PID}"
log "=============================================================="

# Supervise. A DSH exit keeps the REVERSE PROXY serving the recovery page, so a
# profile that cannot boot is fixable from the browser instead of becoming a
# crash loop. The proxy's own exit (a deliberate restart from that page) still
# shuts the stack down so the container policy can boot the new selection — and so
# does a profile switch requested in the UI (/tmp/dsh-restart-requested).
set +e
while true; do
  wait -n "$DSH_PID" "$PROXY_PID"
  status=$?
  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    log "proxy exited (status=${status}) — shutting down"
    terminate
    exit "$status"
  fi
  if [[ -f /tmp/dsh-restart-requested ]]; then
    log "profile switch requested — shutting the stack down so the container boots the new selection"
    terminate
    exit 0
  fi
  write_boot_state failed "the harness process exited" "recovery surface serving on port ${PROXY_PORT}"
  log "harness exited (status=${status}) — recovery surface still serving on ${PROXY_HOST}:${PROXY_PORT}"
  log "open the harness URL to switch profile or boot Safe Mode"
  wait "$PROXY_PID"
  exit 0
done
