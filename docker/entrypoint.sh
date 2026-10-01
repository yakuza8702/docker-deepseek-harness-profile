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
      // full, copyable report). Keep a generous tail rather than a teaser, and
      // REDACT boot tokens the way DSH NEXT does (?token=****) — the tail is
      // shown in a browser and exported in the diagnostic archive.
      const lines = full.split("\n").map((l) => l.replace(/(\?token=)[A-Za-z0-9_-]+/g, "$1****"));
      logTail = lines.slice(-400).join("\n").trim();
    } catch {}
    fs.writeFileSync(file, JSON.stringify({ state, reason: reason || null, detail: detail || null, profile: profile || null, at: new Date().toISOString(), logTail: logTail || null }, null, 2) + "\n");
  ' "$BOOT_STATE_FILE" "$1" "$2" "${3:-}" "${PROFILE:-}"
}
# The ready state is written the moment the HTTP listener answers — long before
# the harness banner (and most of the boot log) lands. Re-record the ready state
# once the banner appears so the Diagnostics tab and the exported archive carry
# the REAL boot log, not a single token line. Deliberate exits skip it.
record_ready_log() {
  (
    for _ in $(seq 1 30); do
      CURRENT="$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j.state||"")}catch{}' "$BOOT_STATE_FILE" 2>/dev/null || true)"
      [[ "$CURRENT" == "failed" || "$CURRENT" == "client-failed" ]] && exit 0
      # dsh itself prints little on stdout; the harness output is what it is.
      # Give the boot a settle window, then refresh the tail (degraded boots
      # accumulate their error lines during it).
      sleep 10
      break
    done
    if grep -qE "warning: [0-9]+ entr(y|ies) did not activate|failed to import" /tmp/dsh-web.log 2>/dev/null; then
      DEGRADED="$(grep -E "did not activate|failed to import|skipping profile bundle|Error:" /tmp/dsh-web.log 2>/dev/null | head -12 | paste -sd ' | ' - || true)"
      write_boot_state degraded "the harness started with errors" "${DEGRADED:-see the log tail}"
    else
      write_boot_state ready "" ""
    fi
  ) &
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
# Safe Mode — a TRUE temporary environment (dsh-next parity).
# The recovery surface (or the in-app panel) writes $DSH_HOME/.safe-mode-request
# and restarts. This boot consumes the flag and starts the harness with a
# THROWAWAY tmpfs DSH_HOME: existing profiles, settings, sessions and
# credentials are never read or changed. ONLY the official DeepSeek API key
# credential (.credentials.yaml) is carried over so the harness still works.
# /tmp is tmpfs, so leaving Safe Mode is simply the next restart.
# DSH_REAL_HOME keeps pointing at the real home for tools that need it (the
# in-app panel's Safe Mode button writes the flag there even while running on
# the temporary home).
# ---------------------------------------------------------------------
DSH_REAL_HOME="${DSH_HOME:-/home/node/.dsh}"
export DSH_REAL_HOME
SAFE_MODE_FLAG="$DSH_REAL_HOME/.safe-mode-request"
SAFE_MODE=0
HARNESS_HOME="$DSH_REAL_HOME"
if [[ -f "$SAFE_MODE_FLAG" ]]; then
  rm -f "$SAFE_MODE_FLAG"
  SAFE_MODE=1
  SAFE_HOME="/tmp/dsh-safe-home"
  rm -rf "$SAFE_HOME"
  mkdir -p "$SAFE_HOME"
  [[ -f "$DSH_REAL_HOME/.credentials.yaml" ]] && cp -a "$DSH_REAL_HOME/.credentials.yaml" "$SAFE_HOME/.credentials.yaml"
  HARNESS_HOME="$SAFE_HOME"
  # Safe Mode is a STOCK environment (dsh-next semantics): the real home's
  # selection must not leak into the temporary one — only the shipped `web`
  # profile has a template, so only it can be materialized in a fresh home.
  PROFILE="web"
  log "SAFE MODE: booting a temporary environment (DSH_HOME=$SAFE_HOME) — the real home is untouched; only .credentials.yaml was carried over"
  write_boot_state starting "booting Safe Mode (temporary environment)"
fi

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
# Browser Use + desktop bundle rows. Applied unconditionally when the file is
# present: the rows carry their own `disabled` conditions (DSH_DESKTOP_ENABLED /
# DSH_BROWSER_USE_ENABLED), so switching the feature off never needs a rebuild.
BROWSER_OVERLAY="${DSH_BROWSER_USE_OVERLAY-/opt/seek-harness/browser-use.overlay.yml}"
if [[ -n "$BROWSER_OVERLAY" && -f "$BROWSER_OVERLAY" ]]; then
  overlay_args+=(--patch "$BROWSER_OVERLAY")
  log "overlay: $BROWSER_OVERLAY"
fi
# Workspace file manager. Same convention: the row carries its own `disabled`
# condition (DSH_WORKSPACE_BROWSER_ENABLED), so the feature is switched off in
# config rather than by removing the file.
WORKSPACE_OVERLAY="${DSH_WORKSPACE_BROWSER_OVERLAY-/opt/seek-harness/workspace-browser.overlay.yml}"
if [[ -n "$WORKSPACE_OVERLAY" && -f "$WORKSPACE_OVERLAY" ]]; then
  overlay_args+=(--patch "$WORKSPACE_OVERLAY")
  log "overlay: $WORKSPACE_OVERLAY"
fi

# ---------------------------------------------------------------------
# Browser Use + the visible desktop (this fork).
#
# The desktop is a second local service, NOT a second published port: Xvfb ->
# openbox -> x11vnc -> websockify/noVNC all bind 127.0.0.1, Brave exposes CDP on
# 127.0.0.1:$DSH_CDP_PORT, and the reverse proxy path-routes
# /${DSH_DESKTOP_PREFIX}/ to the noVNC port. One public port stays the whole
# story, which is what makes an https reverse proxy (Pangolin/nginx) able to
# embed the panel instead of being blocked by mixed content.
#
# DSH_DESKTOP_ENABLED=0 skips the whole stack; the overlay rows are disabled too.
# ---------------------------------------------------------------------
DESKTOP_ENABLED="${DSH_DESKTOP_ENABLED:-1}"
DSH_NOVNC_PORT="${DSH_NOVNC_PORT:-6080}"
DSH_CDP_PORT="${DSH_CDP_PORT:-9222}"
DSH_DESKTOP_WIDTH="${DSH_DESKTOP_WIDTH:-1440}"
DSH_DESKTOP_HEIGHT="${DSH_DESKTOP_HEIGHT:-900}"
DSH_DESKTOP_PREFIX="${DSH_DESKTOP_PREFIX:-desktop}"
DISPLAY="${DISPLAY:-:99}"
export DISPLAY
# Persistent browser profile: cookies, logins and installed extensions live in
# $DSH_HOME (the dsh-home volume), so they survive a restart/recreate — that is
# the point of human takeover. Everything else (caches, XDG state) goes to /tmp
# so the read-only rootfs stays read-only.
DESKTOP_PROFILE="${DSH_DESKTOP_USER_DATA_DIR:-$DSH_REAL_HOME/brave-profile}"
DESKTOP_TMP="${DSH_DESKTOP_TMP:-/tmp/dsh-desktop}"
declare -a desktop_pids=()

# Run a desktop process with a writable XDG/HOME environment. Deliberately NOT
# exported globally: HOME is /workspace and XDG_CONFIG_HOME must keep pointing at
# the real home for the harness and its tools.
desktop_env() {
  env HOME="$DESKTOP_TMP/home" \
      XDG_CONFIG_HOME="$DESKTOP_TMP/config" \
      XDG_CACHE_HOME="$DESKTOP_TMP/cache" \
      XDG_DATA_HOME="$DESKTOP_TMP/data" \
      XDG_RUNTIME_DIR="$DESKTOP_TMP/runtime" \
      "$@"
}

write_desktop_state() {  # write_desktop_state <state> <detail>
  node -e '
    const fs = require("fs");
    fs.writeFileSync(process.argv[1], JSON.stringify({ state: process.argv[2], detail: process.argv[3] || null, at: new Date().toISOString() }, null, 2) + "\n");
  ' /tmp/dsh-desktop-state.json "$1" "${2:-}" 2>/dev/null || true
}

start_desktop() {
  mkdir -p "$DESKTOP_TMP"/{home,config,cache,data,runtime,logs} "$DESKTOP_PROFILE"
  chmod 0700 "$DESKTOP_TMP/runtime" 2>/dev/null || true
  # A container killed mid-write leaves Chromium singleton locks in the
  # persistent profile, and the browser then refuses to start.
  rm -f "$DESKTOP_PROFILE"/Singleton{Cookie,Lock,Socket}

  desktop_env Xvfb "$DISPLAY" -screen 0 "${DSH_DESKTOP_WIDTH}x${DSH_DESKTOP_HEIGHT}x24" \
    -ac -nolisten tcp >"$DESKTOP_TMP/logs/xvfb.log" 2>&1 &
  local xvfb_pid=$!
  desktop_pids+=("$xvfb_pid")

  local attempt=0
  until xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; do
    if ! kill -0 "$xvfb_pid" 2>/dev/null; then
      log "WARNING: Xvfb exited before ${DISPLAY} was ready:"
      sed 's/^/    /' "$DESKTOP_TMP/logs/xvfb.log" >&2 || true
      return 1
    fi
    attempt=$((attempt + 1))
    if [[ "$attempt" -ge 50 ]]; then
      log "WARNING: timed out waiting for the virtual display ${DISPLAY}"
      return 1
    fi
    sleep 0.1
  done

  desktop_env openbox >"$DESKTOP_TMP/logs/openbox.log" 2>&1 &
  desktop_pids+=("$!")

  # x11vnc stays on loopback and without a password: it is reachable only
  # through websockify, which is reachable only through the auth-protected
  # proxy. -repeat keeps the framebuffer flowing so a long-lived VNC socket
  # never looks idle to an intermediate proxy.
  desktop_env x11vnc -display "$DISPLAY" -forever -shared -repeat -noxdamage \
    -rfbport 5900 -localhost -nopw >"$DESKTOP_TMP/logs/x11vnc.log" 2>&1 &
  desktop_pids+=("$!")

  desktop_env websockify --web=/usr/share/novnc \
    "127.0.0.1:${DSH_NOVNC_PORT}" 127.0.0.1:5900 >"$DESKTOP_TMP/logs/novnc.log" 2>&1 &
  desktop_pids+=("$!")

  # /dev/shm defaults to 64 MB. Chromium uses it for renderer shared memory and
  # crashes under load without it; when the host did not size it generously
  # (compose does: shm_size), fall back to /tmp storage automatically instead of
  # making it the user's problem.
  declare -a browser_extra=()
  local shm_kb
  shm_kb="$(df -k /dev/shm 2>/dev/null | awk 'NR==2 {print $2}')"
  if [[ -n "$shm_kb" && "$shm_kb" -lt 262144 ]]; then
    browser_extra+=(--disable-dev-shm-usage)
    log "desktop: /dev/shm is only $((shm_kb / 1024)) MB — starting the browser with --disable-dev-shm-usage (set shm_size on the service to remove this)"
  fi

  # Supervise the browser: a crash must not take the desktop (and with it the
  # panel and the model's browser tools) down for the rest of the container's
  # life.
  (
    while :; do
      desktop_env brave-desktop \
        --user-data-dir="$DESKTOP_PROFILE" \
        --password-store=basic \
        --remote-debugging-address=127.0.0.1 \
        --remote-debugging-port="$DSH_CDP_PORT" \
        --window-position=0,0 \
        --window-size="${DSH_DESKTOP_WIDTH},${DSH_DESKTOP_HEIGHT}" \
        --no-first-run --no-default-browser-check --hide-crash-restore-bubble \
        ${browser_extra[@]+"${browser_extra[@]}"} \
        "${DSH_DESKTOP_START_URL:-about:blank}" >>"$DESKTOP_TMP/logs/brave.log" 2>&1
      log "desktop: browser exited (status=$?) — restarting"
      sleep 1
    done
  ) &
  desktop_pids+=("$!")
  write_desktop_state up "display ${DISPLAY} ${DSH_DESKTOP_WIDTH}x${DSH_DESKTOP_HEIGHT}, noVNC on 127.0.0.1:${DSH_NOVNC_PORT}, CDP on 127.0.0.1:${DSH_CDP_PORT}, profile ${DESKTOP_PROFILE}"
  return 0
}

# Reached only for the `web` command: every other form exec'd above.
DESKTOP_ACTIVE=0
if [[ "$DESKTOP_ENABLED" != "0" ]]; then
  if start_desktop; then
    DESKTOP_ACTIVE=1
    log "browser desktop ready — served by the proxy at /${DSH_DESKTOP_PREFIX}/ (no extra port published)"
  else
    write_desktop_state failed "the desktop stack did not start"
    log "WARNING: the browser desktop failed to start — the harness boots without it, and /${DSH_DESKTOP_PREFIX}/ returns 502 until it is fixed"
  fi
else
  write_desktop_state disabled "DSH_DESKTOP_ENABLED=0"
  log "browser desktop disabled (DSH_DESKTOP_ENABLED=0)"
fi

# The harness child gets the (possibly temporary) DSH_HOME; every other process
# — the proxy, the recovery surface, the entrypoint — keeps the real home.
DSH_HOME="$HARNESS_HOME" node "${node_flags[@]}" "$DSH_BIN" --profile "${PROFILE}" \
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
  log "signal received — stopping DSH (${DSH_PID}), proxy (${PROXY_PID}) and the desktop"
  : > /tmp/dsh-stopping
  kill -TERM "$DSH_PID" "$PROXY_PID" ${TAIL_PID:+"$TAIL_PID"} ${WATCHDOG_PID:+"$WATCHDOG_PID"} 2>/dev/null || true
  # The browser lives under a restart supervisor: stop the supervisor first,
  # otherwise it simply brings the browser back while we are tearing down.
  for pid in ${desktop_pids[@]+"${desktop_pids[@]}"}; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  pkill -TERM -f '/usr/bin/brave-browser' 2>/dev/null || true
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
  # Healthy boot: capture a startup checkpoint for the recovery screen's
  # Rollback tab (3 rotating slots in $DSH_HOME/.recovery-checkpoints).
  # A degraded boot is NOT checkpointed — it is the configuration itself
  # that may need rolling back. Failures here must never block the boot.
  # A Safe Mode boot captures nothing either: it is the temporary
  # environment, not the configuration anyone would want to roll back to.
  if [[ "$SAFE_MODE" == "1" ]]; then
    log "SAFE MODE: checkpoint capture skipped (temporary environment)"
  else
    node -e 'import("/opt/seek-harness/recovery.mjs").then((m) => { const r = m.captureCheckpoint(process.env); if (r) console.log("[seek-harness] startup checkpoint", r.skipped ? "skipped after restore (slots preserved)" : "captured into " + r.slot); }).catch(() => {})' || true
  fi
fi
# Re-record the ready/degraded state with the FULL boot log once the banner
# lands (see record_ready_log above) — without this the Diagnostics tab shows
# a single token line for healthy boots.
record_ready_log
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
log " DeepSeek Harness is ready"
log "   local : http://127.0.0.1:${PROXY_PORT}/"
log "   LAN   : http://<host-ip>:${PROXY_PORT}/   (basic auth: ${AUTH_STATE})"
log "   token : ${DSH_TOKEN_URL:-pending (background capture)}   (append to your LAN URL; auto-login usually makes it unnecessary)"
log "   WS channels are forwarded automatically by the proxy"
if [[ "$DESKTOP_ACTIVE" == "1" ]]; then
  log "   browser desktop (Browser Use + human takeover):"
  log "     same port, no extra publish:  http://<host-ip>:${PROXY_PORT}/${DSH_DESKTOP_PREFIX}/vnc.html"
else
  log "   browser desktop: not running (see the warning above)"
fi
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
