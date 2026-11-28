#!/usr/bin/env node
/**
 * check-egress-router.mjs — the selective-egress gate.
 *
 * WHAT IT GUARDS
 * --------------
 * The 2026-11-28 regression was not a typo: exporting one proxy address to the
 * whole container made EVERY outbound socket depend on it, so a proxy the
 * container could not even resolve (`host.docker.internal` on a plain Linux/dind
 * network) took the entire internet away — every cloud model failed to load.
 * The fix is a shape, not a line, and a shape needs a gate:
 *
 *   1. FUNCTIONAL — `tests/egress-router.mjs` runs the router against local
 *      stubs and proves routed-vs-direct, the DIRECT fail-safe, STRICT mode, the
 *      WebSocket upgrade relay and the probe exit codes. No network is touched,
 *      so this answers on a push runner.
 *   2. WIRING — the entrypoint must export the ROUTER, never the upstream; it
 *      must probe before exporting; the browser must be given an explicit egress
 *      decision (it honours the proxy env — measured) instead of inheriting it.
 *   3. PACKAGING — the router must be copied into the image and readable by the
 *      runtime user, and compose must document/pass the knobs (including the
 *      `host.docker.internal` mapping, whose absence is the field failure).
 *
 * Usage: node tools/check-egress-router.mjs
 * Exit: 0 all good, 1 a wiring/functional failure, 2 the files are missing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
let checks = 0;

/** Assert one property, printing the outcome immediately. */
function check(name, fn) {
  checks += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name} — ${error.message}`);
  }
}

/** Read a repo file or fail the check that needed it. */
function text(relative) {
  const path = join(ROOT, relative);
  if (!existsSync(path)) throw new Error(`${relative} is missing`);
  return readFileSync(path, "utf8");
}

const REQUIRED = ["docker/egress-router.mjs", "tests/egress-router.mjs", "docker/entrypoint.sh", "compose.yaml", "Dockerfile"];
for (const relative of REQUIRED) {
  if (!existsSync(join(ROOT, relative))) {
    console.log(`  FAIL ${relative} is missing — this gate cannot run`);
    process.exit(2);
  }
}

/* 1. syntax + functional */

for (const relative of ["docker/egress-router.mjs", "tests/egress-router.mjs"]) {
  check(`${relative} parses`, () => {
    const result = spawnSync(process.execPath, ["--check", join(ROOT, relative)], { encoding: "utf8" });
    if (result.status !== 0) throw new Error((result.stderr || "").split("\n")[0] || `exit ${result.status}`);
  });
}

check("the router's own suite passes (routed/direct, fail-safe, strict, upgrade, probe)", () => {
  const result = spawnSync(process.execPath, [join(ROOT, "tests/egress-router.mjs")], { encoding: "utf8", timeout: 180_000 });
  if (result.status !== 0) {
    const lines = `${result.stdout ?? ""}${result.stderr ?? ""}`.split("\n").filter((line) => /FAIL|Error|error/.test(line));
    throw new Error(lines.slice(0, 6).join(" | ") || `exit ${result.status}`);
  }
});

/* 2. entrypoint wiring */

const entrypoint = text("docker/entrypoint.sh");
const proxyFn = entrypoint.slice(entrypoint.indexOf("apply_egress_proxy()"), entrypoint.indexOf("`~/.dsh` must BE the harness home"));

check("the entrypoint starts the router by path (and would notice it missing)", () => {
  if (!/EGRESS_ROUTER="\$\{EGRESS_ROUTER:-[^}]*egress-router\.mjs\}/.test(entrypoint)) throw new Error("EGRESS_ROUTER does not default to egress-router.mjs");
  if (!/\[\[ ! -f "\$EGRESS_ROUTER" \]\]/.test(proxyFn)) throw new Error("no missing-router guard");
});

check("the upstream is PROBED before any proxy env is exported", () => {
  if (!/node "\$EGRESS_ROUTER" --probe/.test(proxyFn)) throw new Error("no --probe call");
  const probeAt = proxyFn.indexOf("--probe");
  const exportAt = proxyFn.indexOf("export HTTPS_PROXY=");
  if (probeAt < 0 || exportAt < 0 || probeAt > exportAt) throw new Error("the export happens before the probe");
});

check("an unusable upstream leaves the proxy env UNSET (no total egress loss)", () => {
  const failBranch = proxyFn.slice(proxyFn.indexOf("*)"), proxyFn.indexOf("esac"));
  if (!/NOT exporting the proxy env/.test(failBranch)) throw new Error("the failure branch does not say the env is left unset");
  if (/export HTTPS_PROXY/.test(failBranch)) throw new Error("the failure branch still exports a proxy");
  if (!/return 0/.test(failBranch)) throw new Error("the failure branch does not return to direct egress");
});

check("a failing probe/router cannot abort the boot (the script runs under set -e)", () => {
  if (!/^set -euo pipefail$/m.test(entrypoint)) throw new Error("the entrypoint no longer runs under set -e — re-check this hazard");
  // A bare `probe="$(…)"` whose command substitution fails would kill the whole
  // entrypoint: the one case the probe exists to survive would abort the boot.
  if (!/probe="\$\([\s\S]*?\)" \|\| rc=\$\?/.test(proxyFn)) throw new Error("the probe assignment is not errexit-safe");
  if (!/router_status=0 \|\| router_status=\$\?/.test(proxyFn)) throw new Error("the supervisor loop is not errexit-safe");
});

check("the exported proxy points at the LOOPBACK ROUTER, never at the upstream", () => {
  if (!/EGRESS_ROUTER_URL="http:\/\/127\.0\.0\.1:\$\{EGRESS_ROUTER_PORT\}"/.test(entrypoint)) throw new Error("EGRESS_ROUTER_URL is not loopback");
  if (!/export HTTPS_PROXY="\$EGRESS_ROUTER_URL"/.test(proxyFn)) throw new Error("HTTPS_PROXY is not the router");
  if (/export (HTTPS_PROXY|ALL_PROXY)="\$upstream"/.test(proxyFn)) throw new Error("the raw upstream is exported");
});

check("NODE_USE_ENV_PROXY is set (Node's fetch ignores the env without it)", () => {
  if (!/export NODE_USE_ENV_PROXY="\$\{NODE_USE_ENV_PROXY:-1\}"/.test(proxyFn)) throw new Error("NODE_USE_ENV_PROXY is not exported");
});

check("the router is supervised (a dead router must come back)", () => {
  if (!/while :; do[\s\S]{0,400}node "\$EGRESS_ROUTER"/.test(proxyFn)) throw new Error("no respawn loop");
  if (!/wait_for_port "\$EGRESS_ROUTER_PORT"/.test(proxyFn)) throw new Error("the entrypoint never waits for the router to listen");
});

/* 3. browser wiring */

check("the desktop browser gets an explicit egress decision, defaulting to the router", () => {
  if (!/DSH_DESKTOP_PROXY:-router/.test(entrypoint)) throw new Error("DSH_DESKTOP_PROXY does not default to the router");
  if (!/--no-proxy-server/.test(entrypoint)) throw new Error("no DIRECT mode for the browser");
  if (!/--proxy-server="\$\{EGRESS_ROUTER_URL\}"/.test(entrypoint)) throw new Error("the browser is not pointed at the router");
  if (!/desktop_env env -u HTTPS_PROXY/.test(entrypoint)) throw new Error("the proxy env is not stripped for the browser");
});

/* 4. packaging */

check("the image copies the router and makes it readable for uid 1000", () => {
  const dockerfile = text("Dockerfile");
  if (!/COPY[^]*docker\/egress-router\.mjs \/opt\/seek-harness\//.test(dockerfile)) throw new Error("no COPY into /opt/seek-harness");
  if (!/chmod 0755[^]*\/opt\/seek-harness\/egress-router\.mjs/.test(dockerfile)) throw new Error("the router is not chmod 0755");
});

check("compose passes the knobs and maps host.docker.internal", () => {
  const compose = text("compose.yaml");
  for (const key of ["DSH_EGRESS_PROXY", "DSH_EGRESS_ROUTE_HOSTS", "DSH_EGRESS_STRICT", "DSH_DESKTOP_PROXY"]) {
    if (!new RegExp(`${key}:`).test(compose)) throw new Error(`${key} is not passed through`);
  }
  if (!/host\.docker\.internal:host-gateway/.test(compose)) throw new Error("no extra_hosts host-gateway mapping (the field failure)");
});

check("the router's default route list is exactly the Platform hosts", () => {
  const router = text("docker/egress-router.mjs");
  if (!/const DEFAULT_ROUTES = \["chat\.deepseek\.com", "platform\.deepseek\.com"\];/.test(router)) {
    throw new Error("DEFAULT_ROUTES changed — re-check what now travels through the operator's proxy");
  }
});

console.log(`\ncheck-egress-router: ${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
