#!/usr/bin/env node
/**
 * Guarantee the Landlock launcher exists in the image — and that it really
 * enforces — so confined permission modes work on a FRESH deployment with no
 * extra mounts, downloads or host-side preparation.
 *
 * WHY THIS EXISTS
 * ---------------
 * DSH confines tool processes through `@deepseek-ai/dsh-sandbox-local`, whose
 * Linux runner chain is `["bwrap", "landlock"]` (probed in order, by platform
 * first). `bwrap` needs unprivileged user namespaces, which a hardened
 * container refuses by design (`cap_drop: ALL` + `no-new-privileges` + the
 * daemon's seccomp profile), so the chain falls through to the Landlock
 * launcher. The launcher is a prebuilt binary that ships in the per-platform
 * npm package
 *
 *   @deepseek-ai/node-addon-system-<platform>-<arch>/bin/landlock-run
 *
 * resolved by `launcherPath()` (see @deepseek-ai/node-addon-system). Any install
 * path that skipped it — a package tree that does not declare the API package at
 * all, or a source-channel monorepo build that only linked the workspace copy and
 * never built the native binary — ends up WITHOUT it; `probe()` then reports
 * `unusable` and every confined mode fails closed, which is exactly the
 * "sandbox unavailable, use danger-full-access" advice users hit on a fresh
 * start.
 *
 * Historically this repo asked the USER to download that binary and bind-mount
 * it into the container. That is a deployment footgun: the mount path is a
 * source-channel path (`/opt/dsh-src/native/...`) that does not exist in an
 * npm-channel image, the package name has changed upstream, and a stale mount
 * silently shadows nothing. The image now owns it instead, and this script is
 * how the build proves it.
 *
 * WHAT IT DOES
 * ------------
 * For every given root that carries a DSH installation:
 *   1. find the launcher API package in EVERY layout the two channels produce —
 *      npm (`<root>/node_modules/...`), pnpm store
 *      (`<root>/node_modules/.pnpm/@deepseek-ai+node-addon-system@*`) and the
 *      source workspace (`<root>/native/system/...`, whose own package is the
 *      `-workspace` wrapper and whose platform packages sit in `packages/`);
 *   2. resolve the launcher the way the runtime would — through the installed
 *      package's own `launcherPath()` when the API is loadable, otherwise
 *      directly from the known platform-package locations, including the
 *      workspace's in-tree `native/system/packages/<platform>/bin/`;
 *   3. probe it for real (`--probe` builds and enforces a maximal ruleset in a
 *      child: a kernel with the syscalls but no enforcement reports unusable);
 *   4. if it is missing, `npm pack` the matching platform package (same version
 *      as the installed API/workspace package, `latest` as a fallback) and place
 *      it in every slot the runtime could resolve it from — the root's
 *      node_modules, the package-internal fallback `launcherPath()` points at,
 *      and the workspace's in-tree platform directory;
 *   5. re-probe and FAIL THE BUILD (`exit 1`) unless the verdict is
 *      `full`/`partial`.
 *
 * Usage: node tools/ensure-landlock-launcher.mjs <node_modules-root> [...]
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The platform package the launcher binary is published in (npm os/cpu gated). */
const PLATFORM_PACKAGE = `@deepseek-ai/node-addon-system-${process.platform}-${process.arch}`;
/** …and its unscoped directory name, for joining inside an existing scope dir. */
const PLATFORM_BASENAME = PLATFORM_PACKAGE.slice(PLATFORM_PACKAGE.indexOf("/") + 1);
/** The package that owns the launcher API and the binary's contract. */
const LAUNCHER_PACKAGE = "@deepseek-ai/node-addon-system";
/** Platform directory name used inside the source workspace. */
const PLATFORM_DIR = `${process.platform}-${process.arch}`;
/** The binary inside the platform package. */
const LAUNCHER_BIN = "landlock-run";
/** Verdicts that mean "the kernel really enforces". */
const WORKING_VERDICTS = ["full", "partial"];

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: node tools/ensure-landlock-launcher.mjs <node_modules-root> [...]");
  process.exit(2);
}

const log = (...parts) => console.log("[landlock]", ...parts);

/** Read a package's version, or undefined when the package is not installed. */
function versionOf(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

/** Read a package's name, or undefined. */
function nameOf(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name;
  } catch {
    return undefined;
  }
}

function isDir(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isExecutableFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Every directory in `root` that could be the launcher API package.
 *
 * Three layouts matter, and a build only ever produces one of them:
 *   npm     → <root>/node_modules/@deepseek-ai/node-addon-system
 *   pnpm    → <root>/node_modules/.pnpm/@deepseek-ai+node-addon-system@<v>/node_modules/...
 *   source  → <root>/native/system (the -workspace wrapper) and its own
 *             node_modules, plus every consumer's linked copy
 */
function apiDirs(root) {
  const found = [];

  const push = (dir) => {
    if (!dir) return;
    const pkg = path.join(dir, "package.json");
    const lib = path.join(dir, "lib", "index.js");
    if (!isDir(dir) || !fs.existsSync(pkg)) return;
    // Accept both the published API package and the source workspace wrapper: the
    // wrapper is where `pnpm install` links the platform packages, so it is a
    // legitimate discovery root even though its own name ends in -workspace.
    if (fs.existsSync(lib) || /node-addon-system($|-)/.test(nameOf(dir) ?? "")) {
      if (!found.includes(dir)) found.push(dir);
    }
  };

  push(path.join(root, "node_modules", LAUNCHER_PACKAGE));
  push(path.join(root, "native", "system"));
  push(path.join(root, "native", "system", "node_modules", LAUNCHER_PACKAGE));

  // pnpm store: the real directory behind every symlink.
  const pnpm = path.join(root, "node_modules", ".pnpm");
  if (isDir(pnpm)) {
    for (const entry of fs.readdirSync(pnpm)) {
      const m = /^@deepseek-ai\+node-addon-system@(.+)$/.exec(entry);
      if (m) push(path.join(pnpm, entry, "node_modules", LAUNCHER_PACKAGE));
    }
  }

  // pnpm links workspace packages into each CONSUMER, not into the root.
  for (const group of ["packages", "apps", "vendor"]) {
    const groupDir = path.join(root, group);
    if (!isDir(groupDir)) continue;
    for (const tier of fs.readdirSync(groupDir)) {
      const tierDir = path.join(groupDir, tier);
      if (!isDir(tierDir)) continue;
      push(path.join(tierDir, "node_modules", LAUNCHER_PACKAGE));
      if (group === "packages") {
        for (const pkg of fs.readdirSync(tierDir)) {
          push(path.join(tierDir, pkg, "node_modules", LAUNCHER_PACKAGE));
        }
      }
    }
  }

  return found;
}

/**
 * Import a launcher API by ABSOLUTE PATH on purpose: this script runs from a
 * temp directory, so a bare specifier would resolve against the wrong tree —
 * and `launcherPath()` derives the binary location from the module's own
 * resolution root, which is precisely the fact being verified.
 */
async function loadLauncherApi(dir) {
  const entry = path.join(dir, "lib", "index.js");
  if (!fs.existsSync(entry)) return undefined;
  try {
    return await import(pathToFileURL(entry).href);
  } catch (error) {
    log(`could not load the API at ${entry}: ${error.message}`);
    return undefined;
  }
}

/**
 * Every path the launcher binary could legitimately live at for this root —
 * ordered from "the runtime resolves this" to "the legacy slot older images
 * used". A path is returned whether or not it exists; the caller filters.
 */
function launcherCandidates(root, apiDir, apiLauncher) {
  const candidates = [];
  if (typeof apiLauncher === "string" && apiLauncher.length > 0) candidates.push(apiLauncher);

  // PLATFORM_PACKAGE already carries its scope, so it is joined on its own.
  const platformDirs = [
    path.join(root, "node_modules", PLATFORM_PACKAGE),
    path.join(root, "native", "system", "node_modules", PLATFORM_PACKAGE),
    path.join(root, "native", "system", "packages", PLATFORM_DIR),
    path.join(root, "native", "landlock-run", "packages", PLATFORM_DIR),
  ];
  if (apiDir) {
    // `launcherPath()`'s documented fallback when resolution fails:
    // <apiDir>/node_modules/<platform>/bin/landlock-run.
    platformDirs.push(path.join(apiDir, "node_modules", PLATFORM_PACKAGE));
    // Sibling inside the same scope directory — where pnpm links a package's
    // own dependencies and where npm hoists them.
    platformDirs.push(path.join(apiDir, "..", PLATFORM_BASENAME));
  }
  for (const dir of platformDirs) candidates.push(path.join(dir, "bin", LAUNCHER_BIN));

  return [...new Set(candidates)];
}

/** Download a platform package tarball and unpack it into `destination`. */
function unpackPlatformPackage(name, version, destination) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "landlock-pack-"));
  try {
    let tarball;
    try {
      tarball = execFileSync("npm", ["pack", "--silent", `${name}@${version}`], {
        cwd: scratch,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        // A registry that answers slowly (or not at all) must FAIL the build, not
        // hang it: without this the whole image build waits on npm's own retries.
        timeout: 120000,
      }).trim().split("\n").pop();
    } catch (error) {
      throw new Error(`npm pack ${name}@${version} failed: ${error.message}`);
    }
    fs.mkdirSync(destination, { recursive: true });
    execFileSync("tar", ["-xzf", path.join(scratch, tarball), "-C", destination, "--strip-components=1"], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Probe a launcher binary directly — a byte-for-byte copy of the contract in
 * `@deepseek-ai/node-addon-system`'s own `probe()`, so this guard reaches the
 * same verdict the runtime will:
 *   exit status != 0            → unusable
 *   stdout has "partially enforced" → partial
 *   anything else (e.g. "fully enforced") → full
 */
function probeBinary(binary) {
  const result = spawnSync(binary, ["--probe"], {
    timeout: 2000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return "unusable";
  return /partially enforced/.test(result.stdout ?? "") ? "partial" : "full";
}

/** The version to ask npm for: the installed API's, else the workspace's. */
function packVersion(root, apiDir) {
  return (
    (apiDir ? versionOf(apiDir) : undefined) ??
    versionOf(path.join(root, "native", "system", "packages", PLATFORM_DIR)) ??
    versionOf(path.join(root, "native", "system")) ??
    "latest"
  );
}

/**
 * Place the platform package everywhere the runtime could resolve it from:
 * the root's node_modules (npm layout), the API package's own fallback slot
 * (pnpm layout) and the workspace's in-tree platform directory (source layout,
 * which is what the consumers' pnpm links point at).
 */
function installPlatformPackage(root, apiDir) {
  const version = packVersion(root, apiDir);
  // npm may not have that exact version (the platform package carries its own
  // version line), so the caller's list ends with `latest`.
  const attempts = [...new Set([version, "latest"].filter((v) => typeof v === "string" && v !== ""))];
  const targets = [
    path.join(root, "node_modules", PLATFORM_PACKAGE),
    path.join(root, "native", "system", "packages", PLATFORM_DIR),
  ];
  if (apiDir) {
    targets.push(path.join(apiDir, "node_modules", PLATFORM_PACKAGE));
    targets.push(path.join(apiDir, "..", PLATFORM_BASENAME));
  }

  log(`launcher missing/unusable — installing ${PLATFORM_PACKAGE} (${attempts.join(", ")})`);
  for (const candidate of attempts) {
    let installed = false;
    for (const target of targets) {
      try {
        // A workspace platform directory already carries its own package.json;
        // only the published payload (bin/, prebuilds.json) must be merged in.
        const before = new Set(isDir(target) ? fs.readdirSync(target) : []);
        unpackPlatformPackage(PLATFORM_PACKAGE, candidate, target);
        const after = isDir(target) ? fs.readdirSync(target) : [];
        if (!before.has("bin") && after.includes("bin")) installed = true;
        if (isExecutableFile(path.join(target, "bin", LAUNCHER_BIN))) installed = true;
        log(`installed ${PLATFORM_PACKAGE}@${candidate} into ${target}`);
      } catch (error) {
        log(`attempt with ${candidate} into ${target} failed: ${error.message}`);
      }
    }
    if (installed) return true;
  }
  return false;
}

let failures = 0;
let checked = 0;

for (const root of roots) {
  if (!fs.existsSync(root)) {
    log(`skipped ${root} (absent)`);
    continue;
  }

  const dirs = apiDirs(root);
  const isDshRoot =
    fs.existsSync(path.join(root, "node_modules", "@deepseek-ai", "dsh", "package.json")) ||
    fs.existsSync(path.join(root, "apps", "cli", "lib", "bin.js")) ||
    dirs.length > 0;
  if (!isDshRoot) {
    log(`skipped ${root} (not a DSH installation root)`);
    continue;
  }

  checked += 1;
  const apiDir = dirs[0];
  const api = apiDir ? await loadLauncherApi(apiDir) : undefined;
  let apiLauncher;
  try {
    apiLauncher = api?.launcherPath?.();
  } catch (error) {
    log(`launcherPath() threw: ${error.message}`);
  }

  /**
   * The verdict for one binary. `probe()` in the installed API package is the
   * runtime's own view, so it wins when it reports a working verdict — but it is
   * a thin wrapper (spawn + status + regex), and a *stale* wrapper must not be
   * able to veto a binary that works. So an `unusable` from the wrapper is
   * always re-checked against the binary's own `--probe`, and a disagreement is
   * logged rather than hidden.
   */
  const verdictFor = (binary) => {
    let apiVerdict;
    if (api && typeof api.probe === "function") {
      try {
        apiVerdict = api.probe(binary);
      } catch (error) {
        log(`probe() threw for ${binary}: ${error.message} — probing the binary directly`);
      }
    }
    const directVerdict = probeBinary(binary);
    if (WORKING_VERDICTS.includes(apiVerdict)) return apiVerdict;
    if (WORKING_VERDICTS.includes(directVerdict)) {
      if (apiVerdict) {
        log(`note: probe() reported "${apiVerdict}" for ${binary}, but the binary's own --probe reports "${directVerdict}" — accepting it`);
      }
      return directVerdict;
    }
    return apiVerdict ?? directVerdict;
  };

  const works = () => {
    for (const candidate of launcherCandidates(root, apiDir, apiLauncher)) {
      if (!isExecutableFile(candidate)) continue;
      const verdict = verdictFor(candidate);
      if (WORKING_VERDICTS.includes(verdict)) return { candidate, verdict };
    }
    return undefined;
  };

  let ok = works();
  if (ok) {
    log(`${ok.candidate} — probe: ${ok.verdict} (${root})`);
    continue;
  }

  if (!installPlatformPackage(root, apiDir)) {
    console.error(`[landlock] ERROR: could not obtain ${PLATFORM_PACKAGE} for ${root}`);
    failures += 1;
    continue;
  }

  // Re-resolve: an installation may have made a previously unresolvable
  // platform package resolvable, so ask the API again before scanning paths.
  try {
    apiLauncher = api?.launcherPath?.() ?? apiLauncher;
  } catch {
    /* keep the previous value */
  }
  ok = works();
  if (ok) {
    log(`${ok.candidate} — probe: ${ok.verdict} (${root})`);
    continue;
  }

  // A build host without Landlock support (kernel < 5.13) lands here, as does a
  // launcher nothing can resolve. Both are deliberately fatal: an image whose
  // sandbox silently fails closed is worse than a build that refuses to ship,
  // because the failure only shows up as "permission mode refused" long after
  // deployment.
  console.error(
    `[landlock] ERROR: no working launcher for ${root} (kernel ${os.release()}); tried:\n  ` +
      launcherCandidates(root, apiDir, apiLauncher).join("\n  "),
  );
  failures += 1;
}

if (checked === 0) {
  console.error("[landlock] ERROR: no DSH installation root among: " + roots.join(", "));
  process.exit(1);
}
if (failures > 0) {
  console.error(`[landlock] ERROR: ${failures} root(s) without a working launcher — refusing to ship a broken sandbox`);
  process.exit(1);
}
log(`ok — ${checked} installation root(s) carry a working Landlock launcher`);
