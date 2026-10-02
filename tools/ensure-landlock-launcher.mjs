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
 * resolved by `launcherPath()` (see @deepseek-ai/node-addon-system). That
 * package is an OPTIONAL dependency of the install, so any install path that
 * skipped optional deps — or a source-channel build that only linked the
 * monorepo workspace copy — ends up WITHOUT it; `probe()` then reports
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
 * For every given node_modules root that carries a DSH installation:
 *   1. resolve the host's launcher path through the installed package's own
 *      `launcherPath()` — never a hardcoded path, so an upstream layout change
 *      cannot make this step silently skip;
 *   2. probe it for real (`--probe` builds and enforces a maximal ruleset in a
 *      child: a kernel with the syscalls but no enforcement reports unusable);
 *   3. if it is missing, `npm pack` the matching platform package (same version
 *      as the installed `@deepseek-ai/node-addon-system`, `latest` as a
 *      fallback) and install it into the root's node_modules — both the
 *      canonical location and the package-internal fallback `launcherPath()`
 *      points at when resolution fails;
 *   4. re-probe and FAIL THE BUILD (`exit 1`) unless the verdict is
 *      `full`/`partial`.
 *
 * Usage: node tools/ensure-landlock-launcher.mjs <node_modules-root> [...]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The platform package the launcher binary is published in (npm os/cpu gated). */
const PLATFORM_PACKAGE = `@deepseek-ai/node-addon-system-${process.platform}-${process.arch}`;
/** The package that owns the launcher API and the binary's contract. */
const LAUNCHER_PACKAGE = "@deepseek-ai/node-addon-system";

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: node tools/ensure-landlock-launcher.mjs <node_modules-root> [...]");
  process.exit(2);
}

const log = (...parts) => console.log("[landlock]", ...parts);

/** Read a package's version, or undefined when the package is not installed. */
function versionOf(root, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

/**
 * Import the installed launcher API for one root.
 *
 * The module is loaded by ABSOLUTE PATH on purpose: this script itself runs
 * from a temp directory, so a bare specifier would resolve against the wrong
 * tree — and `launcherPath()` derives the binary location from the module's own
 * resolution root, which is precisely the fact being verified.
 */
async function loadLauncherApi(root) {
  const entry = path.join(root, "node_modules", LAUNCHER_PACKAGE, "lib", "index.js");
  if (!fs.existsSync(entry)) return undefined;
  return import(pathToFileURL(entry).href);
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

/** Install the platform package for `root` when the probe says the launcher is unusable. */
function installPlatformPackage(root, api, launcher) {
  const declared = versionOf(root, LAUNCHER_PACKAGE);
  const attempts = [...new Set([declared, "latest"].filter((value) => typeof value === "string" && value !== ""))];
  log(`launcher missing/unusable at ${launcher} — installing ${PLATFORM_PACKAGE} (${attempts.join(", ")})`);
  for (const version of attempts) {
    // Canonical location: resolvable from any module inside this install.
    const canonical = path.join(root, "node_modules", PLATFORM_PACKAGE);
    try {
      unpackPlatformPackage(PLATFORM_PACKAGE, version, canonical);
      // The documented fallback location `launcherPath()` returns when the
      // platform package cannot be resolved at all: keep it in step, so a
      // resolution quirk cannot leave the binary unreachable.
      const fallback = path.join(root, "node_modules", LAUNCHER_PACKAGE, "node_modules", PLATFORM_PACKAGE);
      unpackPlatformPackage(PLATFORM_PACKAGE, version, fallback);
      log(`installed ${PLATFORM_PACKAGE}@${version} into ${canonical}`);
      return true;
    } catch (error) {
      log(`attempt with ${version} failed: ${error.message}`);
      fs.rmSync(canonical, { recursive: true, force: true });
    }
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
  const api = await loadLauncherApi(root);
  if (api === undefined) {
    log(`skipped ${root} (no ${LAUNCHER_PACKAGE} — not a DSH installation root)`);
    continue;
  }
  checked += 1;

  let launcher = api.launcherPath();
  let verdict = fs.existsSync(launcher) ? api.probe(launcher) : "unusable";
  if (verdict === "unusable") {
    if (!installPlatformPackage(root, api, launcher)) {
      console.error(`[landlock] ERROR: could not obtain ${PLATFORM_PACKAGE} for ${root}`);
      failures += 1;
      continue;
    }
    launcher = api.launcherPath();
    verdict = api.probe(launcher);
  }

  if (verdict === "unusable") {
    // A build host without Landlock support (kernel < 5.13) lands here. That is
    // deliberately fatal: an image whose sandbox silently fails closed is worse
    // than a build that refuses to ship, because the failure only shows up as
    // "permission mode refused" long after deployment.
    console.error(`[landlock] ERROR: ${launcher} probes unusable in ${root} (kernel ${os.release()})`);
    failures += 1;
    continue;
  }

  log(`${launcher} — probe: ${verdict} (${root})`);
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
