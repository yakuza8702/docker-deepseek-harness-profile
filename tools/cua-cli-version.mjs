#!/usr/bin/env node
/**
 * cua-cli-version.mjs — the Dockerfile's cua-CLI resolution, executed offline.
 *
 * WHY THIS EXISTS
 * ---------------
 * `docker build` cannot run in CI's gate job (no daemon, and the step downloads
 * ~45 MB from GitHub), yet the resolution is the one part of the cua layer that
 * can fail for a reason nobody sees until a release is cut: the API answers a
 * shape we no longer parse, a tag scheme changes, or the "latest" default
 * quietly degrades into a frozen version.
 *
 * So this tool does not RE-DESCRIBE the logic in JavaScript — a copy would
 * drift on the first edit and keep passing. It reads the `ARG CUA_CLI_VERSION`
 * line and the RUN block that follows it FROM THE DOCKERFILE, extracts the
 * resolution fragment (`cua_version=...` through the closing `fi;`), and runs
 * that exact shell text under `sh` with a stub `curl` that answers a fixture.
 * What is proved is the text Docker would execute.
 *
 * THREE ANSWERS IT PINS
 * ---------------------
 *   1. `latest` + a releases payload → the FIRST `cua-sdk-v*` tag's version with
 *      the prefix stripped (the API returns releases newest-first).
 *   2. `latest` + an API failure, or a payload with no `cua-sdk-v*` tag → a
 *      NON-ZERO exit with a message. No silent fallback to a frozen version.
 *   3. any other value → used VERBATIM, and `curl` is never called (an offline
 *      or reproducible build must not depend on the network).
 *
 * USAGE
 * -----
 *   node tools/cua-cli-version.mjs --check     # the assertions; exit 1 on FAIL
 *   node tools/cua-cli-version.mjs --json      # machine-readable result
 *
 * Imported by `tests/modules-unit.mjs`, which drives the same functions with the
 * release payload embedded there as a fixture (so a network payload change is
 * a test edit, not a green gate that proves nothing).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The endpoint the Dockerfile queries; exported so a test can assert it. */
export const RELEASES_API_URL = "https://api.github.com/repos/trycua/cua/releases?per_page=100";

/** The tag scheme: `cua-sdk-v<version>` on the release, `<version>` in assets. */
export const TAG_PREFIX = "cua-sdk-v";

/** Read the `ARG CUA_CLI_VERSION=` line and the RUN block that follows it. */
export function readRunBlock(dockerfileText) {
  const lines = dockerfileText.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^ARG\s+CUA_CLI_VERSION=/u.test(line));
  if (start === -1) {
    throw new Error("ARG CUA_CLI_VERSION is not in the Dockerfile");
  }
  let index = start + 1;
  while (index < lines.length && !/^\s*RUN\s/u.test(lines[index])) index += 1;
  if (index >= lines.length) throw new Error("no RUN step follows ARG CUA_CLI_VERSION");
  const block = [];
  for (; index < lines.length; index += 1) {
    block.push(lines[index]);
    if (!lines[index].trimEnd().endsWith("\\")) break;
  }
  return block.join("\n");
}

/**
 * The resolution fragment: from `cua_version="${CUA_CLI_VERSION}"` to the
 * closing `fi;`. Deliberately the OUTER `fi` — the inner failure checks are
 * `[ ... ] || { ...; exit 1; }` one-liners, so the first `fi;` is the end of the
 * `latest` branch and a single-line shift cannot silently truncate the logic.
 */
export function extractResolveFragment(runBlock) {
  const lines = runBlock.split(/\r?\n/u);
  const begin = lines.findIndex((line) => line.includes('cua_version="${CUA_CLI_VERSION}"'));
  if (begin === -1) {
    throw new Error('the RUN block has no cua_version="${CUA_CLI_VERSION}" line');
  }
  const end = lines.findIndex((line, index) => index > begin && line.trim() === "fi; \\");
  if (end === -1) throw new Error("the resolution branch has no closing `fi;`");
  return lines
    .slice(begin, end + 1)
    .map((line) => line.replace(/\\\s*$/u, ""))
    .join("\n");
}

/**
 * Run the Dockerfile's own fragment under `sh`.
 *
 * `apiFails: true` makes the stub curl exit 22 with an error on stderr, which is
 * the "the GitHub API did not answer" branch a real build hits offline.
 *
 * Returns { status, version, curlCalled, stdout, stderr }. `version` is null
 * whenever the fragment exited non-zero — a partial parse is never a version.
 */
export function simulateResolution({
  dockerfileText,
  requested = "latest",
  apiJson = "[]",
  apiFails = false,
}) {
  const fragment = extractResolveFragment(readRunBlock(dockerfileText));
  const dir = mkdtempSync(path.join(tmpdir(), "cua-cli-version-"));
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
        ': > "$CUA_STUB_CALLS"',
        apiFails ? 'echo "curl: (22) the requested URL returned error: 503" >&2' : 'cat "$CUA_STUB_FIXTURE"',
        apiFails ? "exit 22" : "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);
    // `-u` mirrors the Dockerfile's `set -eux`: an unset variable is a failure,
    // not an empty string. `-e` makes an unchecked failing command fail the run.
    const script = `set -eu\n${fragment}\nprintf 'RESOLVED=%s' "$cua_version"\n`;
    const result = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        CUA_CLI_VERSION: requested,
        CUA_STUB_FIXTURE: fixture,
        CUA_STUB_CALLS: calls,
      },
    });
    const stdout = result.stdout ?? "";
    const found = /RESOLVED=(.*)$/u.exec(stdout);
    return {
      status: result.status,
      version: result.status === 0 && found !== null ? found[1] : null,
      curlCalled: spawnSync("sh", ["-c", `test -f ${JSON.stringify(calls)}`]).status === 0,
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
export function cuaCliAssetUrl(version, cuaAsset) {
  return `https://github.com/trycua/cua/releases/download/${TAG_PREFIX}${version}/cua-cli-${version}-linux-${cuaAsset}.tar.gz`;
}

/**
 * `sh -n` over the whole RUN body: a broken continuation or an unbalanced quote
 * would fail a docker build, and no assertion about the fragment's *output* can
 * see the lines around it. Paths are not executed — only parsed, so the
 * `dpkg`, `curl`, `tar` and `mv` in it stay inert.
 */
export function checkRunBlockSyntax(runBlock) {
  const body = runBlock
    .split(/\r?\n/u)
    .map((line, index) => (index === 0 ? line.replace(/^\s*RUN\s+/u, "") : line))
    .map((line) => line.replace(/\\\s*$/u, ""))
    .join("\n");
  const dir = mkdtempSync(path.join(tmpdir(), "cua-cli-syntax-"));
  try {
    const file = path.join(dir, "run.sh");
    writeFileSync(file, `${body}\n`);
    const result = spawnSync("sh", ["-n", file], { encoding: "utf8", timeout: 30_000 });
    return { ok: result.status === 0, status: result.status, stderr: result.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The version out of one `"tag_name": "cua-sdk-vX.Y.Z"` line (the shell's rule). */
export function versionFromTagName(tagName) {
  if (typeof tagName !== "string" || !tagName.startsWith(TAG_PREFIX)) return null;
  const version = tagName.slice(TAG_PREFIX.length).trim();
  return version === "" ? null : version;
}

const ROOT = path.resolve(import.meta.dirname, "..");

/** The fixture the --check mode uses: newest first, as the API returns them. */
const SAMPLE_RELEASES = JSON.stringify(
  [
    { tag_name: "cua-sdk-v0.9.4", name: "cua-sdk 0.9.4", draft: false, prerelease: false },
    { tag_name: "cua-sdk-v0.9.3", name: "cua-sdk 0.9.3", draft: false, prerelease: false },
    { tag_name: "cua-computer-v1.2.0", name: "unrelated package", draft: false, prerelease: false },
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
      /^ARG CUA_CLI_VERSION=latest$/mu.test(dockerfileText),
      (dockerfileText.match(/^ARG CUA_CLI_VERSION=.*$/mu) ?? ["missing"])[0],
    );
    check(
      "the RUN queries the releases API",
      block.includes(RELEASES_API_URL),
      RELEASES_API_URL,
    );
    check(
      "the URL template spends the RESOLVED variable (not the ARG)",
      block.includes("releases/download/cua-sdk-v${cua_version}/cua-cli-${cua_version}-linux-${cua_asset}.tar.gz") &&
        !block.includes("releases/download/cua-sdk-v${CUA_CLI_VERSION}"),
      "sdk-v${cua_version} → cua-cli-${cua_version}-linux-${cua_asset}",
    );

    const latest = simulateResolution({ dockerfileText, requested: "latest", apiJson: SAMPLE_RELEASES });
    check(
      "latest resolves the FIRST cua-sdk-v* tag with the prefix stripped",
      latest.status === 0 && latest.version === "0.9.4" && latest.curlCalled,
      `status ${latest.status}, version ${JSON.stringify(latest.version)}`,
    );

    const pinned = simulateResolution({ dockerfileText, requested: "0.7.0", apiJson: SAMPLE_RELEASES });
    check(
      "an explicit version is used verbatim and never calls the API",
      pinned.status === 0 && pinned.version === "0.7.0" && pinned.curlCalled === false,
      `status ${pinned.status}, version ${JSON.stringify(pinned.version)}, curl ${pinned.curlCalled}`,
    );

    const noTag = simulateResolution({
      dockerfileText,
      requested: "latest",
      apiJson: JSON.stringify([{ tag_name: "cua-computer-v1.2.0" }]),
    });
    check(
      "a payload with no cua-sdk-v* tag FAILS the build",
      noTag.status !== 0 && noTag.version === null && /no cua-sdk-v\*/u.test(noTag.output),
      `status ${noTag.status}: ${noTag.output.trim().split("\n").at(-1) ?? ""}`,
    );

    const apiDown = simulateResolution({ dockerfileText, requested: "latest", apiFails: true });
    check(
      "an unreachable API FAILS the build instead of falling back",
      apiDown.status !== 0 && apiDown.version === null && /GitHub releases API/us.test(apiDown.output),
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
      cuaCliAssetUrl("0.9.4", "x64") ===
        "https://github.com/trycua/cua/releases/download/cua-sdk-v0.9.4/cua-cli-0.9.4-linux-x64.tar.gz",
      cuaCliAssetUrl("0.9.4", "x64"),
    );
    check(
      "versionFromTagName strips only the cua-sdk-v prefix",
      versionFromTagName("cua-sdk-v0.9.4") === "0.9.4" &&
        versionFromTagName("cua-computer-v1.2.0") === null &&
        versionFromTagName("cua-sdk-v") === null,
      "three cases",
    );
  } catch (error) {
    check("the Dockerfile parses", false, String(error?.message ?? error));
  }

  failed = rows.filter((row) => !row.ok).length;
  if (asJson) {
    console.log(JSON.stringify({ failed, passed: rows.length - failed, results: rows }, null, 2));
  } else {
    console.log(`\ncua-cli-version: ${rows.length - failed} passed, ${failed} failed`);
  }
  process.exit(failed === 0 ? 0 : 1);
}
