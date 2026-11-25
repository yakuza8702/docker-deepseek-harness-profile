#!/usr/bin/env node
/**
 * check-opencode-cli.mjs — the Dockerfile's opencode-CLI resolution, executed
 * offline.
 *
 * WHY THIS EXISTS
 * ---------------
 * The image ships a working OpenCode CLI so that `dsh-opencode-connect` — which
 * the USER installs from the Plugins page after boot — finds
 * `/usr/local/bin/opencode` and can spawn `opencode serve --port 40961`. The
 * plugin is not in the image; the CLI is the image's entire obligation to it.
 *
 * That obligation is one shell block, and it fails silently in exactly four
 * ways nobody sees until a release is cut:
 *
 *   1. it resolves a `v2.*` tag — the plugin speaks the v1 root API paths
 *      (`/session`, `/config/providers`, `/event`), and a 2.x CLI answers none
 *      of them;
 *   2. the API answers `301 Moved Permanently` (github.com/sst/opencode now
 *      redirects) and the tag grep finds nothing, which reads as "no release"
 *      instead of "we stopped following redirects";
 *   3. an API outage degrades into a frozen fallback version;
 *   4. a version below the plugin's 1.18.0 free-tier floor gets baked in.
 *
 * So this tool does not RE-DESCRIBE the logic in JavaScript — a copy would
 * drift on the first edit and keep passing. It reads the `ARG OPENCODE_VERSION`
 * line and the RUN block that follows it FROM THE DOCKERFILE, extracts the
 * resolution fragment (from `oc_version=...` to the line that starts the
 * download), and runs that exact shell text under `sh` with a stub `curl` that
 * answers a fixture. What is proved is the text Docker would execute.
 *
 * ANSWERS IT PINS
 * ---------------
 *   * `latest` → the FIRST `v1.*` tag (the API returns releases newest-first),
 *     skipping every v2 tag — pre-releases included — and SAYING which it
 *     skipped.
 *   * `latest` + an API failure, or a payload with no v1 tag → a NON-ZERO exit
 *     with a message. No silent fallback.
 *   * another value → used as given (a leading `v` tolerated), `curl` never
 *     called — an offline or reproducible build must not need the network.
 *   * a 2.x pin → refused with a message that names the v1 constraint.
 *   * anything below 1.18.0 → refused (the plugin's free-tier floor).
 *   * `0` → NOT a version: the RUN's own guard (above the resolution) echoes the
 *     skip line and exits 0 before the resolver or any network call. Simulated
 *     from the guard's real text, so deleting the guard fails this gate.
 *
 * USAGE
 * -----
 *   node tools/check-opencode-cli.mjs --check     # the assertions; exit 1 on FAIL
 *   node tools/check-opencode-cli.mjs --json      # machine-readable result
 *
 * Imported by `tests/modules-unit.mjs`, which drives the same functions with its
 * own fixture (so a payload change is a test edit, not a green gate that proves
 * nothing). Wired into `tools/ci-gates.mjs` as a repository gate.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The endpoint the Dockerfile queries; exported so a test can assert it.
 *
 * `sst/opencode` is the historical name and still resolves — via a
 * `301 Moved Permanently` to `anomalyco/opencode` — which is why the RUN passes
 * `--location`. Keeping this exact URL is deliberate: it is the one the plugin's
 * own docs point at, and following the redirect is the RUN's job, not a reader's.
 */
export const RELEASES_API_URL = "https://api.github.com/repos/sst/opencode/releases?per_page=100";

/** The tag scheme this resolver accepts: `v1.<minor>.<patch>[-pre]` only. */
export const V1_TAG_PREFIX = "v1.";

/** The plugin's free-tier floor (`opencode --version` must be >= this). */
export const PLUGIN_VERSION_FLOOR = "1.18.0";

/** The asset the RUN downloads, for one architecture/baseline/musl target. */
export const ASSET_GLOB = "opencode-linux-<target>.tar.gz";

/**
 * The OFF sentinel: `--build-arg OPENCODE_VERSION=0` means "build without the
 * CLI" (the workflows' `opencode` toggle sends it), never a version to resolve.
 */
export const SKIP_SENTINEL = "0";

/**
 * The one line the RUN prints when the sentinel is in play. Exported because the
 * gate asserts it against the RUN text itself: the echo is what an operator
 * reads in a build log to know the CLI was skipped on purpose.
 */
export const SKIP_ECHO =
  "opencode: OPENCODE_VERSION=0 — skipping the OpenCode CLI (disabled for this build)";

/** Read the `ARG OPENCODE_VERSION=` line and the RUN block that follows it. */
export function readRunBlock(dockerfileText) {
  const lines = dockerfileText.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^ARG\s+OPENCODE_VERSION=/u.test(line));
  if (start === -1) {
    throw new Error("ARG OPENCODE_VERSION is not in the Dockerfile");
  }
  let index = start + 1;
  while (index < lines.length && !/^\s*RUN\s/u.test(lines[index])) index += 1;
  if (index >= lines.length) throw new Error("no RUN step follows ARG OPENCODE_VERSION");
  const block = [];
  for (; index < lines.length; index += 1) {
    block.push(lines[index]);
    if (!lines[index].trimEnd().endsWith("\\")) break;
  }
  return block.join("\n");
}

/**
 * The OFF-SENTINEL guard: the `if [ "${OPENCODE_VERSION}" = "0" ]` block at the
 * top of the RUN, through its closing `fi;`.
 *
 * It is extracted (not re-written) for the same reason the resolver is: the gate
 * has to run the text Docker would run. The guard sits ABOVE `oc_version=`, so
 * it is deliberately outside `extractResolveFragment` — a sentinel run must not
 * execute a single line of the resolver, which is exactly what this proves.
 */
export function extractSkipGuard(runBlock) {
  const lines = runBlock.split(/\r?\n/u);
  const begin = lines.findIndex((line) =>
    /^\s*if\s+\[\s*"\$\{OPENCODE_VERSION\}"\s*=\s*"0"\s*\]/u.test(line),
  );
  if (begin === -1) {
    throw new Error('the RUN block has no `if [ "${OPENCODE_VERSION}" = "0" ]` guard');
  }
  const end = lines.findIndex((line, index) => index > begin && /^\s*fi;\s*\\?\s*$/u.test(line));
  if (end === -1) throw new Error("the OPENCODE_VERSION=0 guard has no closing `fi;`");
  return lines
    .slice(begin, end + 1)
    .map((line) => line.replace(/\\\s*$/u, ""))
    .join("\n");
}

/**
 * The resolution fragment: from `oc_version="${OPENCODE_VERSION}"` to (and
 * excluding) the `oc_target=` line, which is where the download begins.
 *
 * The boundary is that assignment on purpose: everything above it decides WHICH
 * version is installed and can fail the build, everything below it fetches and
 * verifies. Keeping the fetch out means this tool can execute the real fragment
 * without a network or an 80 MB download.
 */
export function extractResolveFragment(runBlock) {
  const lines = runBlock.split(/\r?\n/u);
  const begin = lines.findIndex((line) => line.includes('oc_version="${OPENCODE_VERSION}"'));
  if (begin === -1) {
    throw new Error('the RUN block has no oc_version="${OPENCODE_VERSION}" line');
  }
  const end = lines.findIndex((line, index) => index > begin && /^\s*oc_target=/u.test(line));
  if (end === -1) throw new Error("the RUN block has no `oc_target=` line to end the resolution at");
  return lines
    .slice(begin, end)
    .map((line) => line.replace(/\\\s*$/u, ""))
    .join("\n");
}

/**
 * Run the Dockerfile's own fragment under `sh`.
 *
 * `apiFails: true` makes the stub curl exit 22 with an error on stderr — the
 * "the GitHub API did not answer" branch a real build hits offline.
 *
 * Returns { status, version, curlCalled, stdout, stderr, output }. `version` is
 * null whenever the fragment exited non-zero — a partial parse is never a
 * version. `skipped` is true only when the requested value was the OFF sentinel
 * AND the guard's own skip line was printed: the sentinel is a "no CLI in this
 * image" build, which is exit 0 with no version and no curl.
 */
export function simulateResolution({
  dockerfileText,
  requested = "latest",
  apiJson = "[]",
  apiFails = false,
}) {
  const runBlock = readRunBlock(dockerfileText);
  // `0` never reaches the resolver — the RUN's guard exits first. So the text
  // executed for the sentinel is the GUARD, not the resolver: running the
  // resolver here would prove a branch Docker never takes.
  const skipping = requested === SKIP_SENTINEL;
  const fragment = skipping ? extractSkipGuard(runBlock) : extractResolveFragment(runBlock);
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-cli-version-"));
  try {
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    const fixture = path.join(dir, "releases.json");
    writeFileSync(fixture, apiJson);
    const calls = path.join(dir, "curl.calls");
    const stub = path.join(bin, "curl");
    writeFileSync(
      stub,
      [
        "#!/bin/sh",
        ': > "$OC_STUB_CALLS"',
        'printf "%s\\n" "$@" >> "$OC_STUB_CALLS"',
        apiFails ? 'echo "curl: (22) the requested URL returned error: 503" >&2' : 'cat "$OC_STUB_FIXTURE"',
        apiFails ? "exit 22" : "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);
    // `-u` mirrors the Dockerfile's `set -eux`: an unset variable is a failure,
    // not an empty string. `-e` makes an unchecked failing command fail the run.
    // For the sentinel the trailing printf is unreachable by design (the guard's
    // `exit 0`) — an empty RESOLVED is the proof that nothing resolved.
    const script = skipping
      ? `set -eu\n${fragment}\nprintf 'RESOLVED=%s' "${SKIP_SENTINEL}"\n`
      : `set -eu\n${fragment}\nprintf 'RESOLVED=%s' "$oc_version"\n`;
    const result = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        OPENCODE_VERSION: requested,
        OC_STUB_FIXTURE: fixture,
        OC_STUB_CALLS: calls,
      },
    });
    const stdout = result.stdout ?? "";
    const found = /RESOLVED=(.*)$/u.exec(stdout);
    const callLog = (() => {
      try {
        return readFileSync(calls, "utf8");
      } catch {
        return "";
      }
    })();
    return {
      status: result.status,
      version: result.status === 0 && found !== null ? found[1] : null,
      // The OFF sentinel: exit 0, the guard's own line in the log, no version.
      skipped: skipping && stdout.includes(SKIP_ECHO),
      curlCalled: callLog.length > 0,
      // The argv the Dockerfile's curl actually received: the endpoint and the
      // redirect flag are part of the contract, not incidental.
      curlArgs: callLog.split("\n").filter(Boolean),
      stdout,
      stderr: result.stderr ?? "",
      // Docker prints both streams in one build log; a failure check must read
      // the same text an operator would.
      output: `${stdout}${result.stderr ?? ""}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The asset URL the RUN block builds, so a test can compare it verbatim. */
export function opencodeAssetUrl(version, target = "x64") {
  return `https://github.com/sst/opencode/releases/download/v${version}/opencode-linux-${target}.tar.gz`;
}

/**
 * `sh -n` over the whole RUN body: a broken continuation or an unbalanced quote
 * would fail a docker build, and no assertion about the fragment's *output* can
 * see the lines around it. Paths are not executed — only parsed, so the `dpkg`,
 * `curl`, `tar` and `ldd` in it stay inert.
 */
export function checkRunBlockSyntax(runBlock) {
  const body = runBlock
    .split(/\r?\n/u)
    .map((line, index) => (index === 0 ? line.replace(/^\s*RUN\s+/u, "") : line))
    .map((line) => line.replace(/\\\s*$/u, ""))
    .join("\n");
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-cli-syntax-"));
  try {
    const file = path.join(dir, "run.sh");
    writeFileSync(file, `${body}\n`);
    const result = spawnSync("sh", ["-n", file], { encoding: "utf8", timeout: 30_000 });
    return { ok: result.status === 0, status: result.status, stderr: result.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The version out of one `"tag_name": "v1.19.6"` tag (the shell's rule). */
export function versionFromTagName(tagName) {
  if (typeof tagName !== "string") return null;
  const match = /^v(1\.\d[0-9A-Za-z.-]*)$/u.exec(tagName.trim());
  return match === null ? null : match[1];
}

const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * The fixture the --check mode uses: NEWEST FIRST, as the API returns them.
 *
 * Deliberate about the four shapes that break a naive resolver: a v2 release at
 * the top, a v2 PRE-RELEASE under it, another package's tag (`process-daemon-v*`)
 * in between, and an older v1 below. `assets` is the real asset list of the
 * v1.19.6 x64 release (checked against the live API when this block was
 * written), so the check that the URL names an asset the release actually
 * carries is about a real payload.
 */
const SAMPLE_RELEASES = JSON.stringify(
  [
    {
      tag_name: "v2.4.1",
      name: "v2.4.1",
      draft: false,
      prerelease: false,
      assets: [{ name: "opencode-linux-x64.tar.gz" }],
    },
    {
      tag_name: "v2.0.0-rc.1",
      name: "v2.0.0-rc.1",
      draft: false,
      prerelease: true,
      assets: [],
    },
    {
      tag_name: "process-daemon-v0.6.0",
      name: "process-daemon 0.6.0",
      draft: false,
      prerelease: false,
      assets: [{ name: "process-daemon-linux-x64.tar.gz" }],
    },
    {
      tag_name: "v1.19.6",
      name: "v1.19.6",
      draft: false,
      prerelease: false,
      assets: [
        { name: "opencode-linux-arm64-musl.tar.gz" },
        { name: "opencode-linux-arm64.tar.gz" },
        { name: "opencode-linux-x64-baseline-musl.tar.gz" },
        { name: "opencode-linux-x64-baseline.tar.gz" },
        { name: "opencode-linux-x64-musl.tar.gz" },
        { name: "opencode-linux-x64.tar.gz" },
      ],
    },
    {
      tag_name: "v1.19.5",
      name: "v1.19.5",
      draft: false,
      prerelease: false,
      assets: [{ name: "opencode-linux-x64.tar.gz" }],
    },
  ],
  null,
  2,
);

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const asJson = process.argv.includes("--json");
  const dockerfileText = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  const rows = [];
  const check = (label, ok, detail) => {
    rows.push({ label, ok: Boolean(ok), detail });
    if (!asJson) console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  };
  let failed = 0;

  try {
    const block = readRunBlock(dockerfileText);
    check(
      "the ARG defaults to latest",
      /^ARG OPENCODE_VERSION=latest$/mu.test(dockerfileText),
      (dockerfileText.match(/^ARG OPENCODE_VERSION=.*$/mu) ?? ["missing"])[0],
    );
    check(
      "the RUN queries the releases API",
      block.includes(RELEASES_API_URL),
      RELEASES_API_URL,
    );
    check(
      "the API call follows the permanent redirect (curl --location)",
      /curl\s+-fsSL\s+--retry\s+3\s+--location/u.test(block) ||
        /--location[^\n]*releases\?per_page=100/u.test(block),
      "sst/opencode answers 301 → anomalyco/opencode",
    );
    check(
      "the URL template spends the RESOLVED variable (not the ARG)",
      block.includes("releases/download/v${oc_version}/opencode-linux-${oc_target}.tar.gz") &&
        !block.includes("releases/download/v${OPENCODE_VERSION}"),
      "v${oc_version} → opencode-linux-${oc_target}.tar.gz",
    );
    check(
      "the 1.18.0 floor is asserted twice (resolved, then what the binary reports)",
      (block.split("'1.18.0'").length - 1) >= 2,
      `${block.split("'1.18.0'").length - 1} assertion(s)`,
    );

    const latest = simulateResolution({ dockerfileText, requested: "latest", apiJson: SAMPLE_RELEASES });
    check(
      "latest resolves the FIRST v1.* tag and skips v2 (prerelease included) + other packages",
      latest.status === 0 && latest.version === "1.19.6" && latest.curlCalled,
      `status ${latest.status}, version ${JSON.stringify(latest.version)}`,
    );
    check(
      "the build log NAMES the resolved version and the skipped v2 tags",
      /resolved to 1\.19\.6/u.test(latest.stdout) &&
        /skipped v2 tags: .*2\.4\.1/u.test(latest.stdout) &&
        /skipped v2 tags: .*2\.0\.0-rc\.1/u.test(latest.stdout),
      (latest.stdout.match(/opencode: .*resolved.*$/mu) ?? ["missing"])[0],
    );
    check(
      "the curl call carries the documented endpoint and follows the redirect",
      latest.curlArgs.includes(RELEASES_API_URL) && latest.curlArgs.includes("--location"),
      latest.curlArgs.join(" "),
    );

    const pinned = simulateResolution({ dockerfileText, requested: "1.19.6", apiJson: SAMPLE_RELEASES });
    check(
      "an explicit version is used as given and never calls the API",
      pinned.status === 0 && pinned.version === "1.19.6" && pinned.curlCalled === false,
      `status ${pinned.status}, version ${JSON.stringify(pinned.version)}, curl ${pinned.curlCalled}`,
    );
    const pinnedV = simulateResolution({ dockerfileText, requested: "v1.19.6", apiJson: SAMPLE_RELEASES });
    check(
      "a leading `v` on a pinned version is tolerated (the tag and the asset differ by it)",
      pinnedV.status === 0 && pinnedV.version === "1.19.6" && pinnedV.curlCalled === false,
      `status ${pinnedV.status}, version ${JSON.stringify(pinnedV.version)}`,
    );

    // THE OFF SENTINEL. `0` is not a version: the RUN's guard must short-circuit
    // the whole block — exit 0, the skip line in the log, no curl, no version —
    // and that line must be IN the RUN text, not only in this simulator. A
    // build with the toggle off therefore contains no CLI and says so.
    const off = simulateResolution({ dockerfileText, requested: SKIP_SENTINEL, apiJson: SAMPLE_RELEASES });
    check(
      "OPENCODE_VERSION=0 short-circuits: exit 0, the skip echo in the log, never a curl call",
      block.includes(SKIP_ECHO) &&
        off.status === 0 &&
        off.version === null &&
        off.curlCalled === false &&
        off.skipped === true &&
        /skipping the OpenCode CLI/u.test(off.output),
      `status ${off.status}, version ${JSON.stringify(off.version)}, curl ${off.curlCalled}, skip echo ${off.skipped ? "present" : "MISSING"}`,
    );

    const pinnedV2 = simulateResolution({ dockerfileText, requested: "2.4.1", apiJson: SAMPLE_RELEASES });
    check(
      "a pinned 2.x version is REJECTED with a message naming the v1 constraint",
      pinnedV2.status !== 0 && pinnedV2.version === null && /speaks the v1 API/u.test(pinnedV2.output),
      `status ${pinnedV2.status}: ${pinnedV2.output.trim().split("\n").at(-1) ?? ""}`,
    );
    const pinnedV2Pre = simulateResolution({ dockerfileText, requested: "v2.0.0-rc.1", apiJson: SAMPLE_RELEASES });
    check(
      "...a 2.x PRE-RELEASE pin is rejected the same way",
      pinnedV2Pre.status !== 0 && pinnedV2Pre.version === null && /OpenCode 2/u.test(pinnedV2Pre.output),
      `status ${pinnedV2Pre.status}: ${pinnedV2Pre.output.trim().split("\n").at(-1) ?? ""}`,
    );

    const tooOld = simulateResolution({ dockerfileText, requested: "1.17.9", apiJson: SAMPLE_RELEASES });
    check(
      "a version below the plugin's 1.18.0 floor FAILS the build",
      tooOld.status !== 0 && tooOld.version === null && /1\.18\.0 floor/u.test(tooOld.output),
      `status ${tooOld.status}: ${tooOld.output.trim().split("\n").at(-1) ?? ""}`,
    );
    const atFloor = simulateResolution({ dockerfileText, requested: "1.18.0", apiJson: SAMPLE_RELEASES });
    check(
      "...and 1.18.0 itself passes (the floor is inclusive)",
      atFloor.status === 0 && atFloor.version === "1.18.0",
      `status ${atFloor.status}, version ${JSON.stringify(atFloor.version)}`,
    );

    const noV1 = simulateResolution({
      dockerfileText,
      requested: "latest",
      apiJson: JSON.stringify([{ tag_name: "v2.4.1" }, { tag_name: "process-daemon-v0.6.0" }]),
    });
    check(
      "a payload with no v1.* tag FAILS the build",
      noV1.status !== 0 && noV1.version === null && /no v1\.\* release/u.test(noV1.output),
      `status ${noV1.status}: ${noV1.output.trim().split("\n").at(-1) ?? ""}`,
    );

    const apiDown = simulateResolution({ dockerfileText, requested: "latest", apiFails: true });
    check(
      "an unreachable API FAILS the build instead of falling back",
      apiDown.status !== 0 && apiDown.version === null && /GitHub releases API did not answer/u.test(apiDown.output),
      `status ${apiDown.status}: ${apiDown.output.trim().split("\n").at(-1) ?? ""}`,
    );

    const syntax = checkRunBlockSyntax(block);
    check(
      "the whole RUN body parses as shell (sh -n)",
      syntax.ok,
      syntax.ok ? "no syntax error" : syntax.stderr.trim().split("\n")[0],
    );

    check(
      "the asset URL helper matches the Dockerfile's template",
      opencodeAssetUrl("1.19.6", "x64") ===
        "https://github.com/sst/opencode/releases/download/v1.19.6/opencode-linux-x64.tar.gz" &&
        opencodeAssetUrl("1.19.6", "arm64-baseline").endsWith("/opencode-linux-arm64-baseline.tar.gz"),
      opencodeAssetUrl("1.19.6", "x64"),
    );

    const v1Release = JSON.parse(SAMPLE_RELEASES).find((release) => release.tag_name === "v1.19.6");
    const assetNames = (v1Release?.assets ?? []).map((asset) => asset.name);
    check(
      "the release the resolver picks actually carries the asset the URL names",
      ["x64", "arm64", "x64-baseline", "x64-musl", "arm64-musl"].every((target) =>
        assetNames.includes(`opencode-linux-${target}.tar.gz`),
      ),
      assetNames.length === 0 ? "no assets in the fixture" : `${assetNames.length} asset(s)`,
    );

    check(
      "versionFromTagName accepts v1 tags only",
      versionFromTagName("v1.19.6") === "1.19.6" &&
        versionFromTagName("v2.4.1") === null &&
        versionFromTagName("process-daemon-v0.6.0") === null &&
        versionFromTagName("v1.") === null,
      "four cases",
    );
  } catch (error) {
    check("the Dockerfile parses", false, String(error?.message ?? error));
  }

  failed = rows.filter((row) => !row.ok).length;
  if (asJson) {
    console.log(JSON.stringify({ failed, passed: rows.length - failed, results: rows }, null, 2));
  } else {
    console.log(`\nopencode-cli: ${rows.length - failed} passed, ${failed} failed`);
  }
  process.exit(failed === 0 ? 0 : 1);
}
