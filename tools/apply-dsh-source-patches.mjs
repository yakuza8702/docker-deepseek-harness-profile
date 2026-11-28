#!/usr/bin/env node
/**
 * Apply this profile's DSH source patches to the upstream monorepo the image
 * builds, and prove the compiled artifact carries them.
 *
 * WHY THIS EXISTS
 * ---------------
 * The image's default channel installs the compiled npm release of
 * `@deepseek-ai/dsh`, which a source patch cannot touch. The **source channel**
 * (`DSH_SOURCE_REF=<github tag>`) clones `deepseek-ai/deepseek-harness` into
 * `/src` and runs `pnpm run build`, so a defect in the TypeScript sources can be
 * fixed there — by applying `patches/*.patch` to the clone BEFORE the build. See
 * `patches/README.md` for what each patch fixes and its base commit.
 *
 * THREE GUARANTEES
 * ----------------
 *   IDEMPOTENT  `git apply --check` decides: pending → apply, already applied
 *               (`--reverse --check`) → skip loudly, otherwise → fail. A rebuild
 *               of the same context therefore re-applies nothing.
 *   FAIL LOUD   An unapplicable patch, a directory that is not a git work tree,
 *               or a built lib without the expected markers (see BUILT_CHECKS)
 *               stops the build. An upstream refactor must never silently ship
 *               the behaviour this fork removed.
 *   HONEST BASE The patch was verified against one upstream commit. When the
 *               source ref is a different (newer) tag the run WARNS instead of
 *               pretending the verification still holds — and still refuses to
 *               continue if a hunk does not apply.
 *
 * USAGE
 * -----
 *   node tools/apply-dsh-source-patches.mjs <repo-dir> [--patch <file>] [--expect-base <sha>] [--dry-run]
 *   node tools/apply-dsh-source-patches.mjs <repo-dir> --verify-built [--patch <file>]
 *
 *   --patch        patch to apply/verify (default: patches/auth-fix.patch)
 *   --expect-base  upstream commit the patch was verified against (short or full sha)
 *   --dry-run      report what would happen; change nothing
 *   --verify-built check the compiled lib of the built repo for the patch's markers
 *
 * The functions are exported for `tests/modules-unit/22-dsh-source-patch.mjs`,
 * which exercises them against a throwaway git repo — no network, no image.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROFILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Default patch of this profile. */
export const DEFAULT_PATCH = path.join(PROFILE_ROOT, "patches", "auth-fix.patch");

/** Provenance record the applier leaves in the built source tree (also shipped in the image). */
export const PROVENANCE_FILE = ".dsh-profile-patches.json";

/**
 * What each patch MUST leave in the COMPILED lib — the build-time proof that the
 * patch is actually in the artifact the harness runs, not merely in the sources.
 * The markers are names the diff introduces: a compiled JS class keeps its method
 * and field names (`private` is erased, `#private` is not used here), so their
 * absence means the file that was built did not carry the patch.
 */
export const BUILT_CHECKS = {
  "auth-fix.patch": [
    {
      dir: "packages/account/deepseek-account/lib",
      reason: "the Host account service did not compile the two-strike expiry / durable identity cache",
      markers: ["expiryConfirmed", "ownProfileWrite", "persistedProfile"],
    },
    {
      dir: "packages/client/ui-settings-account/lib",
      reason: "the settings client did not compile the unknown-state card / shared retry handle",
      markers: ["accessEnded", "accountUnreachableTitle"],
    },
  ],
};

/** Run git with a repo-scoped safe.directory, so a bind-mounted tree still works. */
function runGit(repo, args) {
  const result = spawnSync("git", ["-c", `safe.directory=${repo}`, "-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`git is not usable: ${result.error.message}`);
  return {
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

/** sha256 of a file, hex. */
export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** HEAD of a git work tree, or a throw with the reason. */
export function repositoryHead(repo) {
  const head = runGit(repo, ["rev-parse", "HEAD"]);
  if (head.status !== 0 || head.stdout === "") {
    throw new Error(`not a git work tree: ${repo}${head.stderr ? `\n${head.stderr}` : ""}`);
  }
  return head.stdout;
}

/**
 * Is the patch pending, already applied, or unapplicable in this tree?
 * @returns {{ state: "pending" | "applied" | "conflict", detail: string }}
 */
export function patchState(repo, patchFile) {
  if (!existsSync(patchFile)) throw new Error(`patch not found: ${patchFile}`);
  const forward = runGit(repo, ["apply", "--check", patchFile]);
  if (forward.status === 0) return { state: "pending", detail: "" };
  const reverse = runGit(repo, ["apply", "--check", "--reverse", patchFile]);
  if (reverse.status === 0) return { state: "applied", detail: "" };
  return { state: "conflict", detail: forward.stderr || forward.stdout || "git apply --check failed" };
}

/**
 * Compare the tree's HEAD with the commit the patch was verified against.
 * A mismatch is a warning (the patch may still apply cleanly), never a silent pass.
 * @returns {{ exact: boolean, detail: string }}
 */
export function baseVerdict(head, expected) {
  if (!expected) return { exact: false, detail: "no base commit given — the patch's provenance is unverified" };
  const short = head.toLowerCase().slice(0, 12);
  const wanted = expected.toLowerCase();
  const exact = head.toLowerCase().startsWith(wanted) || wanted.startsWith(head.toLowerCase());
  return {
    exact,
    detail: exact
      ? `HEAD ${short} is the patch base`
      : `HEAD ${short} is NOT the patch base ${wanted} — this patch was verified on ${wanted} only, so it must still apply cleanly`,
  };
}

/**
 * Apply one patch, idempotently.
 * @param {string} repo upstream monorepo checkout.
 * @param {{ patch?: string, expectBase?: string, dryRun?: boolean, log?: (line: string) => void }} [options]
 * @returns {{ status: "applied" | "already-applied" | "pending", head: string, sha256: string, baseExact: boolean }}
 */
export function applyPatch(repo, options = {}) {
  const patchFile = options.patch ?? DEFAULT_PATCH;
  const log = options.log ?? (() => {});
  const dryRun = options.dryRun === true;
  const head = repositoryHead(repo);
  const verdict = baseVerdict(head, options.expectBase);
  if (options.expectBase && !verdict.exact) log(`warn: ${verdict.detail}`);
  else if (verdict.exact) log(verdict.detail);

  const state = patchState(repo, patchFile);
  const name = path.basename(patchFile);
  const digest = sha256File(patchFile);
  if (state.state === "applied") {
    log(`${name}: already applied — skipped (idempotent)`);
    return { status: "already-applied", head, sha256: digest, baseExact: verdict.exact };
  }
  if (state.state === "conflict") {
    throw new Error(
      `${name} does not apply to ${repo} (HEAD ${head.slice(0, 12)}).\n` +
        `The upstream tree moved past the patch's base commit; re-verify patches/README.md and the diff.\n` +
        state.detail,
    );
  }
  if (dryRun) {
    log(`${name}: pending — would apply (dry run)`);
    return { status: "pending", head, sha256: digest, baseExact: verdict.exact };
  }
  const applied = runGit(repo, ["apply", patchFile]);
  if (applied.status !== 0) {
    throw new Error(`${name} failed to apply to ${repo}:\n${applied.stderr || applied.stdout}`);
  }
  log(`${name}: applied (HEAD ${head.slice(0, 12)})`);
  return { status: "applied", head, sha256: digest, baseExact: verdict.exact };
}

/** Record what was applied, so the image carries its own provenance. */
export function writeProvenance(repo, entries) {
  const file = path.join(repo, PROVENANCE_FILE);
  const document = {
    schema: 1,
    source: "docker-deepseek-harness-profile",
    patches: entries,
  };
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  return file;
}

/** Every .js file under a directory (recursive). */
function walkJs(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkJs(full));
    else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))) files.push(full);
  }
  return files;
}

/**
 * Prove the COMPILED lib carries the patch.
 * @param {string} repo built monorepo checkout.
 * @param {string} [patchFile] patch whose BUILT_CHECKS contract to enforce.
 * @param {(line: string) => void} [log]
 * @returns {{ checks: number, files: number }}
 */
export function verifyBuilt(repo, patchFile = DEFAULT_PATCH, log = () => {}) {
  const name = path.basename(patchFile);
  const checks = BUILT_CHECKS[name];
  if (!checks) throw new Error(`no compiled-artifact contract for ${name} — add one to BUILT_CHECKS`);
  const problems = [];
  let fileCount = 0;
  for (const check of checks) {
    const dir = path.join(repo, check.dir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      problems.push(`${check.dir} does not exist — the package was not built (is this the source channel?)`);
      continue;
    }
    const files = walkJs(dir);
    fileCount += files.length;
    const missing = check.markers.filter(
      (marker) => !files.some((file) => readFileSync(file, "utf8").includes(marker)),
    );
    if (missing.length > 0) {
      problems.push(`${check.dir} is missing ${missing.map((marker) => `'${marker}'`).join(", ")} — ${check.reason}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`the compiled artifact does not carry ${name}:\n  ${problems.join("\n  ")}`);
  }
  log(`${name}: compiled artifact carries every marker (${checks.length} check(s), ${fileCount} file(s))`);
  return { checks: checks.length, files: fileCount };
}

/**
 * Whether this build enables the auth fix. The Dockerfile passes DSH_AUTH_FIX as a build arg
 * (default 1, the fix); `0` (or false/off/no) ships the stock upstream tree, which is the escape
 * hatch when the patch must not be in the image.
 * @param {NodeJS.ProcessEnv} [env] environment to read.
 * @returns {boolean} true unless the switch explicitly disables it.
 */
export function authFixEnabled(env = process.env) {
  const raw = String(env.DSH_AUTH_FIX ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

/**
 * Prove the COMPILED lib does NOT carry the patch — the stock artifact check a DSH_AUTH_FIX=0
 * build runs after `pnpm run build`, so "stock" is verified rather than assumed.
 * @param {string} repo built monorepo checkout.
 * @param {string} [patchFile] patch whose BUILT_CHECKS markers must be absent.
 * @param {(line: string) => void} [log]
 * @returns {{ checks: number, files: number }}
 */
export function verifyAbsent(repo, patchFile = DEFAULT_PATCH, log = () => {}) {
  const name = path.basename(patchFile);
  const checks = BUILT_CHECKS[name];
  if (!checks) throw new Error(`no compiled-artifact contract for ${name} — add one to BUILT_CHECKS`);
  const problems = [];
  let fileCount = 0;
  for (const check of checks) {
    const dir = path.join(repo, check.dir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      problems.push(`${check.dir} does not exist — the package was not built (is this the source channel?)`);
      continue;
    }
    const files = walkJs(dir);
    fileCount += files.length;
    const present = check.markers.filter(
      (marker) => files.some((file) => readFileSync(file, "utf8").includes(marker)),
    );
    if (present.length > 0) {
      problems.push(`${check.dir} still carries ${present.map((marker) => `'${marker}'`).join(", ")} — ${check.reason}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`DSH_AUTH_FIX=0 but the compiled artifact still carries ${name}:\n  ${problems.join("\n  ")}`);
  }
  log(`${name}: DSH_AUTH_FIX=0 — compiled artifact carries none of its markers (${checks.length} check(s), ${fileCount} file(s))`);
  return { checks: checks.length, files: fileCount };
}

/** Parse argv; keeps the CLI honest about unknown options and missing values. */
export function parseArgs(argv) {
  const args = {
    repo: undefined,
    patch: DEFAULT_PATCH,
    expectBase: undefined,
    dryRun: false,
    verifyBuilt: false,
    authFix: undefined,
    help: false,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--patch" || arg === "--expect-base") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      if (arg === "--patch") args.patch = path.resolve(value);
      else args.expectBase = value;
      index += 1;
    } else if (arg === "--auth-fix") {
      const value = argv[index + 1];
      if (value !== "0" && value !== "1") throw new Error("--auth-fix needs 0 or 1");
      args.authFix = value === "1";
      index += 1;
    } else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--verify-built") args.verifyBuilt = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new Error("expected exactly one repository directory");
  args.repo = positional[0];
  return args;
}

const USAGE = `usage:
  node tools/apply-dsh-source-patches.mjs <repo-dir> [--patch <file>] [--expect-base <sha>] [--dry-run] [--auth-fix 0|1]
  node tools/apply-dsh-source-patches.mjs <repo-dir> --verify-built [--patch <file>] [--auth-fix 0|1]

--auth-fix defaults to DSH_AUTH_FIX (the Dockerfile build arg; 1 unless set to 0).
With 1, --verify-built proves the markers are present; with 0 it proves they are absent (stock).`;

/** CLI entry; returns the process exit code. */
export function main(argv = process.argv.slice(2), log = (line) => console.log(line)) {
  const args = parseArgs(argv);
  if (args.help) {
    log(USAGE);
    return 0;
  }
  if (!args.repo) {
    log(USAGE);
    return 2;
  }
  const repo = path.resolve(args.repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    throw new Error(`not a directory: ${repo}`);
  }
  const authFix = args.authFix ?? authFixEnabled();
  if (args.verifyBuilt) {
    if (authFix) verifyBuilt(repo, args.patch, log);
    else verifyAbsent(repo, args.patch, log);
    return 0;
  }
  if (!authFix) {
    log(`auth fix: off (DSH_AUTH_FIX=0) — ${path.basename(args.patch)} is NOT applied`);
    if (!args.dryRun) {
      const file = writeProvenance(repo, [{
        file: path.basename(args.patch),
        sha256: sha256File(args.patch),
        status: "off",
        reason: "DSH_AUTH_FIX=0",
        appliedAt: new Date().toISOString(),
      }]);
      log(`provenance: ${path.relative(repo, file) || file}`);
    }
    return 0;
  }
  const result = applyPatch(repo, {
    patch: args.patch,
    expectBase: args.expectBase,
    dryRun: args.dryRun,
    log,
  });
  if (!args.dryRun) {
    const file = writeProvenance(repo, [
      {
        file: path.basename(args.patch),
        sha256: result.sha256,
        base: args.expectBase ?? null,
        baseExact: result.baseExact,
        head: result.head,
        status: result.status,
        appliedAt: new Date().toISOString(),
      },
    ]);
    log(`provenance: ${path.relative(repo, file) || file}`);
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`apply-dsh-source-patches: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
