#!/usr/bin/env node
/**
 * check-cua-rea.mjs — the REA kit is wired through five files, and four of them
 * are only connected by strings.
 *
 * WHY A TEXT GATE
 * ---------------
 * The guest provisioner is a shell script, the supervisor talks to it by
 * filename, the Dockerfile copies it, and the plugin panel decides whether to
 * ask for it. Nothing in that chain type-checks: a renamed script, a dropped
 * `rea: true` in the registry literal, a Dockerfile COPY that forgets the file
 * or a create payload that never sends the flag all leave a build that boots,
 * a panel that looks right, and a model that quietly gets a plain desktop
 * instead of a decompiler. So each hop is asserted here as a needle, the build
 * runs it, and a broken hop fails the BUILD instead of a user's first RE task.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a linter and not a behavioural test: it cannot tell whether Ghidra runs,
 * only that the install, the env persistence, the registration and the doctor
 * call are still in the script, and that the supervisor still asks for them.
 * The behavioural proof lives in the guest (`rea doctor --provider ghidra`).
 *
 * USAGE
 * -----
 *   node tools/check-cua-rea.mjs                 # repository layout
 *   node tools/check-cua-rea.mjs --root DIR      # flat image layout
 *
 * The image copies the five files flat into one directory (no docker/, no
 * plugins/), so --root only changes where a name is looked up, never what is
 * asserted. Exit 1 prints the complete list of missing needles.
 *
 * NEEDLE CONTRACT (stage-2 files)
 * -------------------------------
 * client.js and index.js are owned by the UI writer; their needles are the
 * exact shape this gate expects:
 *
 *   client.js  `rea: false` (draft default), `rea: draft.rea` (create payload)
 *   index.js   `rea: { type: 'boolean'` (tool schema), `input.rea === true`
 *
 * If a reformat makes one of those spellings impossible, change the needle and
 * the code in the same commit — never delete the needle to make the gate pass.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    root: { type: 'string', default: path.resolve(import.meta.dirname, '..') },
    quiet: { type: 'boolean', default: false }
  }
})
const ROOT = path.resolve(values.root)

/**
 * A file, wherever this layout keeps it: flat (an image check directory),
 * docker/ (the supervisor and the guest scripts), plugins/ (the plugin bundle).
 * `--root` never changes which copies are wanted, only where they live.
 */
function pick(name) {
  const candidates = [
    path.join(ROOT, name),
    path.join(ROOT, 'docker', name),
    path.join(ROOT, 'plugins', name),
    path.join(ROOT, 'plugins', 'dsh-cua-vm', name)
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/**
 * Whitespace is the one thing that legitimately drifts when someone rewraps a
 * line or lets a formatter run, so every run of spaces in a needle matches any
 * run of whitespace. Everything else is literal: a needle that matches a
 * different identifier is not a gate.
 */
function needlePattern(needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return escaped.split(/ +/u).join('\\s+')
}

const FILES = {
  guest: { label: 'docker/cua-guest-rea.sh', name: 'cua-guest-rea.sh' },
  supervisor: { label: 'docker/cua-vm-supervisor.mjs', name: 'cua-vm-supervisor.mjs' },
  dockerfile: { label: 'Dockerfile', name: 'Dockerfile' },
  client: { label: 'plugins/dsh-cua-vm/client.js', name: 'client.js' },
  index: { label: 'plugins/dsh-cua-vm/index.js', name: 'index.js' }
}

/**
 * The chain, in the order it breaks. `min` > 1 is used where the SAME call has
 * to appear on more than one path (start and provision): one surviving call
 * site is exactly the regression that looks fine until the second button.
 */
const NEEDLES = {
  guest: [
    ['MARKER=/var/lib/cua-rea', 1],
    ['VERSION="${REA_MARKER_VERSION:-1}"', 1],
    ['LOG=/var/log/cua-rea.log', 1],
    ['exec > >(tee -a "$LOG") 2>&1', 1],
    ['say() { echo "[rea] $*"; }', 1],
    ['die() { echo "[rea] FAILED: $*"; exit 1; }', 1],
    ['exit 3', 1],
    ['openjdk-21-jdk-headless procps unzip curl ca-certificates xz-utils', 1],
    ['JAVA_HOME="$(dirname', 1],
    ['NODE_VERSION="${REA_NODE_VERSION:-v22.23.4}"', 1],
    ['NODE_DIR=/opt/node22', 1],
    ['sort -V', 1],
    ['ln -sfn "$NODE_DIR/bin/$bin" "/usr/local/bin/$bin"', 1],
    ['npm" install --global --no-fund --no-audit rea-agents@latest', 1],
    ['REA_MJS="${NPM_GLOBAL_ROOT}/rea-agents/scripts/rea.mjs"', 1],
    ['Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip', 1],
    ['GHIDRA_DIR=/opt/ghidra', 1],
    ['support/analyzeHeadless', 1],
    ['Ghidra/Features/Decompiler/os/*/decompile', 1],
    ['jadx-${JADX_VERSION}.zip', 1],
    ['jadx-headless-mcp-0.7.1-all.jar', 1],
    ['6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75', 1],
    ['sha256sum "$JAR_PATH"', 1],
    ['/etc/profile.d/rea.sh', 1],
    ['^${key}=', 1],
    ['/etc/systemd/system/cua-spacesd.service.d/20-rea.conf', 1],
    ['systemctl daemon-reload', 1],
    ['sudo -u cua -H env', 1],
    ['setup --client dsh --yes --json', 1],
    ["id: rea-mcp", 1],
    ["name: '@deepseek-ai/dsh-mcp-client'", 1],
    ['serverName: rea', 1],
    ['cordis.patch.yml', 1],
    ['setup --skill --yes --json', 1],
    ['doctor --provider ghidra --json', 1],
    ['registered=$REGISTERED', 1],
    ["setsid sh -c 'sleep 5; systemctl daemon-reload; systemctl restart cua-spacesd'", 1]
  ],
  supervisor: [
    ["const REA_SCRIPT = String(process.env.DSH_CUA_REA_SCRIPT || '/usr/local/bin/cua-guest-rea.sh')", 1],
    ['const REA_MIN_DISK_GB = 40', 1],
    ['async function provisionReaGuest(name)', 1],
    ['timeoutSec: 3600, timeoutMs: 3900000', 1],
    ['\\[rea\\] OK', 1],
    ['already provisioned', 1],
    ['node=(v[0-9][^\\s]*)', 1],
    ['...(known || {}),', 1],
    ['const reaBack = known?.rea === true ? await provisionReaGuest(name) : null', 1],
    ['rea: false,', 1],
    ['android = false, rea = false', 1],
    ['const wantedDiskGb = Number(diskGb) > 0 ? Number(diskGb) : 20', 1],
    ['const effectiveDiskGb = rea === true ? Math.max(wantedDiskGb, REA_MIN_DISK_GB) : wantedDiskGb', 1],
    ['Plugins → Personal VM (CUA) → Policy', 1],
    ['rea: rea === true,', 1],
    ['diskGb: effectiveDiskGb,', 1],
    ['if (effectiveDiskGb > 20) disk = await growGuestDisk(name, effectiveDiskGb)', 1],
    ['const reaResult = rea === true ? await provisionReaGuest(name) : null', 1],
    ['diskGbRaised: effectiveDiskGb > wantedDiskGb ? effectiveDiskGb : undefined', 1],
    ['const rea = meta.rea === true ? await provisionReaGuest(name) : null', 2],
    ['const both = result.ok && (rea === null || rea.ok)', 1]
  ],
  dockerfile: [
    ['docker/cua-guest-rea.sh /usr/local/bin/', 1],
    ['tools/check-cua-rea.mjs /opt/seek-harness/check-cua-rea.mjs', 1],
    ['RUN node /opt/seek-harness/check-cua-rea.mjs --root /opt/seek-harness/cua-check', 1]
  ],
  client: [
    ['rea: false', 1],
    ['rea: draft.rea', 1],
    ['REA', 1]
  ],
  index: [
    ["rea: { type: 'boolean'", 1],
    ['input.rea === true', 1],
    ['REA', 1]
  ]
}

let failures = 0
const missing = []

console.log(`cua-rea gate — ${ROOT}`)

for (const [key, spec] of Object.entries(FILES)) {
  const file = pick(spec.name)
  if (file === null) {
    failures += 1
    missing.push(`${spec.label}: file not found (looked in ${ROOT}, ${path.join(ROOT, 'docker')}, ${path.join(ROOT, 'plugins')})`)
    console.log(`  FAIL ${spec.label}: file not found`)
    continue
  }
  const text = readFileSync(file, 'utf8')
  let checked = 0
  let bad = 0
  for (const [needle, min] of NEEDLES[key]) {
    checked += 1
    const pattern = new RegExp(needlePattern(needle), 'gu')
    const hits = (text.match(pattern) || []).length
    if (hits < min) {
      bad += 1
      failures += 1
      missing.push(`${spec.label}: ${hits}/${min} × ${needle}`)
    }
  }
  if (bad === 0) {
    if (!values.quiet) console.log(`  ok   ${spec.label} — ${checked} needle(s)`)
  } else {
    console.log(`  FAIL ${spec.label} — ${bad}/${checked} needle(s) missing`)
  }
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed:`)
  for (const line of missing) console.error(`  - ${line}`)
  console.error('\nThe REA kit is one chain: guest script → supervisor → image → plugin.')
  console.error('A missing needle is a hop that no longer exists, not a formatting nit.')
  process.exit(1)
}

console.log('\nREA kit wired end to end: provisioner, supervisor, image gate, plugin surface.')
process.exit(0)
