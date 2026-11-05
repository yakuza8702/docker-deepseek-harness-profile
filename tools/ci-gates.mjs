#!/usr/bin/env node
/**
 * ci-gates.mjs — run every build gate this repository has, from a bare CHECKOUT.
 *
 * WHY THIS EXISTS
 * ---------------
 * The image runs its gates mid-Dockerfile, against `/opt/dsh/node_modules` and
 * `/opt/dsh-src/node_modules` — the trees the build has just populated. That is
 * the right place for the last word, and the wrong place to learn about a broken
 * wiring: a gate that fails there has already cost a full image build, and on a
 * tag push it fails after the tag exists.
 *
 * This runner answers the same questions in seconds, on a runner with nothing but
 * Node: it STAGES the repository's own `plugins/*` into a throwaway
 * `node_modules` root (exactly the shape the two installation roots have in the
 * image), then executes each gate with the arguments that layout needs. No image,
 * no browser, no Python payload.
 *
 * THREE OUTCOMES, AND WHY SKIPS ARE LOUD
 * --------------------------------------
 *   PASS  the gate ran and every assertion held.
 *   FAIL  the gate ran and something is wired wrong — the build stops here.
 *   SKIP  the gate needs an IMAGE ARTIFACT the checkout does not have (the pinned
 *         Python payload, the compiled Brave MCP wrapper, the OCR tools tree).
 *         Printed with the exact missing path, NEVER counted as a pass: a gate
 *         that silently turns green is worse than no gate, because it reads like
 *         coverage. Those gates still run, unconditionally, inside `docker build`.
 *
 * USAGE
 * -----
 *   node tools/ci-gates.mjs                 # the CI job: PASS/FAIL/SKIP, exit 1 on FAIL
 *   node tools/ci-gates.mjs --require-all   # SKIP is a failure too (nightly audit)
 *   node tools/ci-gates.mjs --installed     # also read real image roots, if present
 *   node tools/ci-gates.mjs --json          # machine-readable summary
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const REQUIRE_ALL = argv.includes("--require-all");
const JSON_OUT = argv.includes("--json");
const WITH_INSTALLED = argv.includes("--installed");

const RESULTS = [];
const started = Date.now();

/** Record one gate outcome and print its line immediately (CI logs stream). */
function record(name, status, detail, output) {
  RESULTS.push({ name, status, detail });
  if (JSON_OUT) return;
  const tag =
    status === "PASS" ? "  ok  " : status === "FAIL" ? " FAIL " : status === "INFO" ? " info " : " skip ";
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (status === "FAIL" && output) {
    const lines = output.split("\n").filter((line) => /\bFAIL\b|error|Error|usage:/.test(line));
    for (const line of lines.slice(0, 12)) console.log(`         ${line.trim()}`);
  }
}

/** Run one gate; returns { code, output }. */
function run(file, args, env = {}) {
  const result = spawnSync(process.execPath, [join(ROOT, "tools", file), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
    env: { ...process.env, ...env },
  });
  return { code: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * The staged installation root.
 *
 * The image's roots hold `node_modules/<bundle>`; a checkout holds
 * `plugins/<bundle>`. Copying is not a trick to make the gates pass — it is the
 * only way to exercise `resolvePageFile`, `findPackageDir` and the rest without
 * building an image, and a gate that only ever saw the repository layout would
 * never catch a package the Dockerfile forgets to install.
 */
function stageInstallRoot() {
  const root = mkdtempSync(join(tmpdir(), "ci-gates-"));
  const modules = join(root, "node_modules");
  mkdirSync(modules, { recursive: true });
  const plugins = join(ROOT, "plugins");
  for (const entry of readdirSync(plugins)) {
    const dir = join(plugins, entry);
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, "package.json"))) continue;
    cpSync(dir, join(modules, entry), { recursive: true });
  }
  return { root, modules };
}

/**
 * Which gates need an IMAGE ARTIFACT, and ALL of it.
 *
 * Each entry lists every path the gate dereferences. A gate runs only when the
 * whole set is present; one missing file SKIPS it, with that path named. This is
 * deliberately stricter than "the first file exists": a half-populated host (an
 * image directory left over from an old build, a bind mount of just the payload)
 * is where a partial run reports FAILED for a reason that is not a wiring defect,
 * and the next person spends an hour on a red X that means "this machine is not
 * the image".
 */
const IMAGE_ARTIFACTS = {
  "check-office.mjs": [
    "/opt/dsh-office/primary-runtime/runtime.json",
    "/opt/dsh-office/office-skills/pdf-documents/SKILL.md",
  ],
  "check-ocr-toolchain.mjs": [
    "/opt/dsh-office/primary-runtime/dependencies/python/bin/python3",
    "/opt/ocr-tools/ocr-pdf.py",
    "/opt/ocr-tools/README.md",
    "/usr/local/bin/ocr-tools",
  ],
  "check-brave-mcp.mjs": ["/usr/local/bin/dsh-brave-devtools-mcp"],
};

/** The first artifact this gate needs that is not here, or null when all are. */
function missingArtifact(file) {
  const paths = IMAGE_ARTIFACTS[file];
  if (paths === undefined) return null;
  return paths.find((path) => !existsSync(path)) ?? null;
}

/**
 * The OTHER thing check-brave-mcp cannot run without: the BUILT plugin-manager
 * client bundle, which upstream ships inside the DSH installation (npm layout
 * `@deepseek-ai/<name>/lib/client.js`, pnpm's store, or the source workspace).
 * A checkout has none of those, so the gate would fail on a missing page rather
 * than on a broken wiring — exactly the false red this runner must not print.
 *
 * Mirrors check-brave-mcp's own resolvePageFile: the staged install only ever
 * carries this repository's `plugins/*`, so on a bare checkout this is null and
 * the Brave gate is SKIPPED (it still runs, unconditionally, inside docker build).
 */
function findPageBundle(roots) {
  const name = "@deepseek-ai/dsh-client-ui-plugin-manager";
  for (const root of roots) {
    const flat = join(root, name, "lib", "client.js");
    if (existsSync(flat)) return flat;
    const store = join(root, ".pnpm");
    let entries = [];
    try {
      entries = readdirSync(store);
    } catch {
      entries = [];
    }
    const hit = entries.find((entry) => entry.startsWith("@deepseek-ai+dsh-client-ui-plugin-manager@"));
    if (hit !== undefined) {
      const candidate = join(store, hit, "node_modules", name, "lib", "client.js");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/* ---------------------------------------------------------------- run them */

if (!JSON_OUT) console.log(`ci-gates: ${ROOT}`);

const staged = stageInstallRoot();

/**
 * Which roots the installed-layout gates read.
 *
 * DEFAULT: the staged copy of THIS checkout, and nothing else. That is the
 * deterministic answer — a CI runner, a laptop, and a machine that happens to
 * carry an old `/opt/dsh-src` all assert the same thing against the same tree,
 * and a stale image root can never turn a green checkout red for a reason that
 * belongs to the machine.
 *
 * `--installed` adds the real installation roots when they exist. A root is used
 * only when it carries the bundles the Dockerfile installs into BOTH roots, which
 * is what distinguishes an image root from an upstream DSH workspace.
 */
const IMAGE_ROOT_MARKERS = ["dsh-cua-vm", "dsh-plugins-page-extras", "dsh-office"];
const extraRoots = WITH_INSTALLED ? ["/opt/dsh/node_modules", "/opt/dsh-src/node_modules"] : [];
const ROOTS = [
  staged.modules,
  ...extraRoots.filter(
    (root) => existsSync(root) && IMAGE_ROOT_MARKERS.every((name) => existsSync(join(root, name))),
  ),
].filter((root, index, all) => all.indexOf(root) === index);

if (!JSON_OUT) {
  console.log(`ci-gates: staged install root ${staged.modules}`);
  if (ROOTS.length > 1) console.log(`ci-gates: also reading ${ROOTS.slice(1).join(", ")}`);
  console.log("");
}

/* 1. The connector gate — BOTH layouts, because they answer different questions:
 *    the installed copy is what the loader reads in the image, the repository copy
 *    is what the NEXT build installs (a stale repo declaration is exactly how a
 *    rename survives one image and breaks the next). */
{
  const image = run("check-connector.mjs", ROOTS);
  record(
    "check-connector.mjs (installed layout)",
    image.code === 0 ? "PASS" : "FAIL",
    image.code === 0 ? `dsh-connector wired into ${ROOTS.length} installation root(s)` : `exit ${image.code}`,
    image.output,
  );
  const repo = run("check-connector.mjs", []);
  record(
    "check-connector.mjs (repository layout)",
    repo.code === 0 ? "PASS" : "FAIL",
    repo.code === 0 ? "repo declarations agree" : `exit ${repo.code}`,
    repo.output,
  );
}

/* 2. Gates that consume only repository files (plus the staged install, which IS
 *    repository files). These are the ones a push can always answer. */
const REPO_GATES = [
  { file: "check-cua-rea.mjs", args: [], label: "REA kit chain" },
  { file: "check-recovery-page.mjs", args: [], label: "recovery page scripts parse" },
  { file: "check-tool-trim.mjs", args: [], label: "MCP catalogue trim policy" },
  { file: "check-profile-switcher.mjs", args: [staged.root, staged.modules], label: "profile chooser + reset" },
];

for (const gate of REPO_GATES) {
  if (!existsSync(join(ROOT, "tools", gate.file))) {
    record(gate.file, "SKIP", "not in this tree");
    continue;
  }
  const result = run(gate.file, gate.args);
  record(
    gate.file,
    result.code === 0 ? "PASS" : "FAIL",
    result.code === 0 ? gate.label : `exit ${result.code}`,
    result.output,
  );
}

/* 3. Gates that need an image artifact. They are the SAME assertions the image
 *    makes; running them here only happens on a host that has the artifacts. */
for (const [file, label] of [
  ["check-office.mjs", "Office payload + declarations"],
  ["check-ocr-toolchain.mjs", "OCR layer"],
  ["check-brave-mcp.mjs", "Brave DevTools MCP surface"],
]) {
  const missing = missingArtifact(file);
  if (missing !== null) {
    record(file, "SKIP", `needs image artifact ${missing}`);
    continue;
  }
  // check-brave-mcp dereferences a SECOND image artifact: the BUILT plugin-manager
  // client bundle. A host that happens to carry the wrapper (an old image layer, a
  // bind mount of /usr/local/bin) but not the page used to make this gate go red
  // for a reason that is not a wiring defect. Skip with the exact file named.
  if (file === "check-brave-mcp.mjs" && findPageBundle(ROOTS) === null) {
    record(
      file,
      "SKIP",
      "needs the built plugin-manager client bundle (@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js in an installation root) — image artifact only",
    );
    continue;
  }
  // Same arguments the Dockerfile gives each gate. check-ocr-toolchain takes FLAGS
  // only (parseArgs with no positionals), so it must not be handed a root; the
  // Brave gate runs with MCP_SLIM=0 because the catalogue trim is a POLICY
  // (check-tool-trim.mjs) and measuring the trimmed surface here would report the
  // policy as a missing-tool failure.
  const args =
    file === "check-office.mjs"
      ? ["--payload", "/opt/dsh-office", "--install", ...ROOTS]
      : file === "check-brave-mcp.mjs"
        ? ["/usr/local/bin/dsh-brave-devtools-mcp", "1.9.0", ...ROOTS]
        : [];
  const result = run(file, args, file === "check-brave-mcp.mjs" ? { MCP_SLIM: "0" } : {});
  record(file, result.code === 0 ? "PASS" : "FAIL", result.code === 0 ? label : `exit ${result.code}`, result.output);
}

/* 4. probe-anchors is a NETWORK probe, not a gate: it downloads the upstream
 *    bundle the image will patch. Its own workflow (`anchor-probe.yml`) owns that
 *    question, so here it is advisory and never fails the job — a push must not go
 *    red because GitHub was slow. */
if (existsSync(join(ROOT, "tools", "probe-anchors.mjs"))) {
  const probe = run("probe-anchors.mjs", []);
  record(
    "probe-anchors.mjs (advisory)",
    "INFO",
    probe.code === 0 ? "anchors resolve" : "anchors moved — advisory only, see anchor-probe.yml",
  );
}

rmSync(staged.root, { recursive: true, force: true });

/* ----------------------------------------------------------------- report */

const passed = RESULTS.filter((r) => r.status === "PASS").length;
const failed = RESULTS.filter((r) => r.status === "FAIL").length;
const skipped = RESULTS.filter((r) => r.status === "SKIP").length;
const informed = RESULTS.filter((r) => r.status === "INFO").length;
const seconds = ((Date.now() - started) / 1000).toFixed(1);

if (JSON_OUT) {
  console.log(JSON.stringify({ passed, failed, skipped, informed, seconds, results: RESULTS }, null, 2));
} else {
  console.log(`\nci-gates: ${passed} passed, ${failed} failed, ${skipped} skipped in ${seconds}s`);
  if (skipped > 0) {
    console.log("  skipped gates need an IMAGE artifact (paths above) — they run unconditionally inside docker build");
  }
  if (informed > 0) console.log("  info lines are advisory and never fail the job");
}

if (failed > 0) process.exit(1);
if (REQUIRE_ALL && skipped > 0) {
  console.error("ci-gates: --require-all was given, so the skipped gates are failures");
  process.exit(1);
}
process.exit(0);
