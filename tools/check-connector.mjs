#!/usr/bin/env node
/**
 * check-connector.mjs — prove the Connector is wired into THIS image, in the one
 * place it is supposed to live: the top section of the Plugins page, under
 * "Personal VM (CUA)".
 *
 * WHY THIS EXISTS
 * ---------------
 * The row is only real if SEVEN pieces agree, and they live in six different
 * files that no compiler connects:
 *
 *   1. the installed bundle — `dsh-connector` in BOTH DSH installations'
 *      node_modules, declaring `dsh.bundle.patch` and shipping that patch;
 *   2. the bundle patch — a row with `id: connector` whose `name:` is the real
 *      package (`dsh-connector`, not the source checkout's `@local/connector`);
 *   3. the Plugins-page HOST table — the `{ id, bundle }` pair the switch toggles;
 *   4. the Plugins-page CLIENT table — the row the user reads, in the position
 *      that matters: after "Personal VM (CUA)", before "Office documents";
 *   5. the duplicate-card suppression — the bundle must be in
 *      INTEGRATED_BUNDLES, or the same feature shows up a second time under
 *      "Installed plugins";
 *   6. the entrypoint seeder — the selection that mounts the row on a fresh home,
 *      plus the migration that drops the pre-rename `@local/connector` link;
 *   7. the Dockerfile — the COPY, the cp into both roots, the chmod, the rm, and
 *      the dependency declaration that makes the bare name resolvable.
 *
 * A green image with any ONE of those missing boots fine and looks exactly like
 * success until somebody opens the page — or worse, it "works" as a duplicate
 * card under "Installed". So this gate asserts every hop by reading the installed
 * and repository files, and fails the BUILD.
 *
 * USAGE
 * -----
 *   node tools/check-connector.mjs                     # repository layout
 *   node tools/check-connector.mjs /opt/dsh/node_modules /opt/dsh-src/node_modules
 *   node tools/check-connector.mjs --repo /tmp/connector-repo <root> [...]
 *
 * With no root argument the repository's own `plugins/` directory is used as the
 * install tree, so the gate is runnable by hand from a checkout. `--repo` names
 * the directory holding Dockerfile + entrypoint.sh + the extras/page sources; it
 * defaults to this script's repository and accepts the flat layout the image
 * stages (`dsh-connector.cordis.patch.yml`, `entrypoint.sh`, …) as well as the
 * real `plugins/…`/`docker/…` paths.
 */
import fs from "node:fs";
import path from "node:path";

const BUNDLE = "dsh-connector";
const ROW_ID = "connector";
const LEGACY_SPEC = "@local/connector";

/** Arguments: `--repo DIR` anywhere, every other argument is an install root. */
const argv = process.argv.slice(2);
let repoArg;
const roots = [];
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--repo") {
    repoArg = argv[index + 1];
    index += 1;
  } else {
    roots.push(argv[index]);
  }
}

const repo = path.resolve(repoArg ?? path.join(import.meta.dirname, ".."));
const installs = roots.length > 0 ? roots.map((root) => path.resolve(root)) : [path.join(repo, "plugins")];

let checks = 0;
let failed = 0;

const ok = (label, detail = "") => {
  checks += 1;
  console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
};
const bad = (label, detail = "") => {
  checks += 1;
  failed += 1;
  console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};
const expect = (condition, label, detail = "") => (condition ? ok(label, detail) : bad(label, detail));
const read = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * The repository files this gate needs, in both layouts the gate runs in:
 *
 *   checkout                the image (staged flat into /tmp/connector-repo)
 *   Dockerfile              Dockerfile
 *   docker/entrypoint.sh    entrypoint.sh
 *   tools/patch-plugin-manager-page.mjs
 *                           patch-plugin-manager-page.mjs
 *   plugins/dsh-plugins-page-extras/index.js
 *                           plugins-page-extras.index.js
 *   plugins/dsh-plugins-page-extras/client.js
 *                           plugins-page-extras.client.js
 *   plugins/dsh-connector/cordis.patch.yml
 *                           dsh-connector.cordis.patch.yml
 *
 * `undefined` means "absent here", which is a failure for the pieces that are
 * unconditionally required and a note for the ones a hand-run can live without.
 */
function pick(...candidates) {
  for (const candidate of candidates) {
    const file = path.join(repo, candidate);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

const FILES = {
  dockerfile: pick("Dockerfile"),
  entrypoint: pick("docker/entrypoint.sh", "entrypoint.sh"),
  pagePatcher: pick("tools/patch-plugin-manager-page.mjs", "patch-plugin-manager-page.mjs"),
  extrasHost: pick("plugins/dsh-plugins-page-extras/index.js", "plugins-page-extras.index.js"),
  extrasClient: pick("plugins/dsh-plugins-page-extras/client.js", "plugins-page-extras.client.js"),
  patch: pick(`plugins/${BUNDLE}/cordis.patch.yml`, `${BUNDLE}.cordis.patch.yml`),
};

console.log(`[check-connector] repo ${repo}`);
console.log(`[check-connector] install roots ${installs.join(", ")}`);

/* ------------------------------------------------- 1. the installed bundle */
console.log(`[check-connector] 1/7 ${BUNDLE} is installed in every installation root`);

/**
 * The roots that ARE installations.
 *
 * The image is built on one of two channels and only one carries its own
 * node_modules: the npm channel has `/opt/dsh/node_modules`, the source channel
 * `/opt/dsh-src/node_modules`. The staging RUN skips a root that is absent, and so
 * does this gate — but every root that exists must hold the package, and at least
 * one must exist. That is exactly the failure this gate is for: the package
 * installed into ONE root, so it resolves on the channel the author happened to
 * build and "failed to import" on the other.
 */
const isDir = (candidate) => {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
};

/** Where `<root>/<bundle>` is, if it is a directory. */
function bundleDirOf(root) {
  const dir = path.join(root, BUNDLE);
  return isDir(dir) ? dir : undefined;
}

let firstBundleDir;
let installedRoots = 0;
for (const root of installs) {
  const dir = bundleDirOf(root);
  if (dir === undefined && !isDir(root)) {
    console.log(`  --   ${root} is not an installation root in this channel (absent, skipped)`);
    continue;
  }
  installedRoots += 1;
  expect(dir !== undefined, `${BUNDLE} is installed in ${root}`, dir ?? "not found");
  if (dir === undefined) continue;
  firstBundleDir ??= dir;

  const manifestText = read(path.join(dir, "package.json"));
  let manifest;
  try {
    manifest = JSON.parse(manifestText ?? "");
  } catch {
    bad(`${BUNDLE} in ${root} has a readable package.json`, "unreadable or missing");
    continue;
  }
  expect(manifest.name === BUNDLE, `its package name is "${BUNDLE}"`, String(manifest.name));
  expect(manifest.private === true, "it stays private:true (never published, never installable from the market)");
  expect(manifest.main === "./index.js", "its entry point is ./index.js", String(manifest.main));

  const declared = manifest.dsh?.bundle?.patch;
  expect(declared === "./cordis.patch.yml", "it declares dsh.bundle.patch", String(declared));
  const patchPath = typeof declared === "string" ? path.join(dir, declared) : undefined;
  expect(
    patchPath !== undefined && fs.existsSync(patchPath),
    "the declared patch file exists where the manifest says",
    patchPath ?? "no patch declared",
  );

  // The client half is what puts the sidebar row and the page there. A package
  // that declares dsh.client but no client.js fails at bundle time, not here, so
  // the gate looks for both halves.
  expect(fs.existsSync(path.join(dir, "client.js")), "the client half (client.js) is installed");
  expect(manifest.dsh?.client?.platform === "web", "it declares a web client", String(manifest.dsh?.client?.platform));
  expect(
    Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-layout"),
    "its client inject list is unchanged (the sidebar/layout peers)",
    String(JSON.stringify(manifest.dsh?.client?.inject)),
  );
}

// One live installation at least. Without this, a run against nothing but absent
// roots would print a screen of `--` lines and exit 0.
expect(installedRoots > 0, "at least one DSH installation root is present under the paths given");

/* ---------------------------------------------------- 2. the bundle patch */
console.log(`[check-connector] 2/7 the patch mounts the ${ROW_ID} row under the real name`);

const installedPatch = firstBundleDir === undefined ? undefined : path.join(firstBundleDir, "cordis.patch.yml");
/**
 * Both copies are asserted, when both exist: the INSTALLED one is what the loader
 * reads in the image, and the REPOSITORY one is what the next build will install.
 * A gate that reads only the installed copy passes with a stale repo declaration —
 * exactly how a rename survives one image and breaks the next.
 */
const patchFiles = [...new Set([installedPatch, FILES.patch].filter((file) => file !== undefined && fs.existsSync(file)))];
expect(patchFiles.length > 0, "at least one cordis.patch.yml was found to read", String(patchFiles.join(", ") || FILES.patch));

for (const patchFile of patchFiles) {
  console.log(`  ..   ${patchFile}`);
  const patch = read(patchFile) ?? "";
  expect(new RegExp(`^\\s*-?\\s*id:\\s*${ROW_ID}\\s*$`, "mu").test(patch), `the patch mounts id "${ROW_ID}"`);
  expect(
    new RegExp(`^\\s*name:\\s*'?${BUNDLE}'?\\s*$`, "mu").test(patch),
    `the row resolves the package by its bare name "${BUNDLE}"`,
  );
  expect(!patch.includes(LEGACY_SPEC), `the patch no longer names ${LEGACY_SPEC}`, "the loader cannot resolve a source-checkout name");
  expect(
    /disabled:\s*!!js\s+"process\.env\.DSH_CONNECTOR === '0'"/u.test(patch),
    "the row honours DSH_CONNECTOR=0 (the image switch)",
  );
  expect(patch.includes("credentialRef"), "the config still carries credential REFERENCE names, not values");
  // The row is the ONLY row this bundle adds: two `- insert:` entries would mount
  // two panels under one switch.
  expect((patch.match(/^\s*- insert:\s*$/gmu) ?? []).length === 1, "the patch inserts exactly one row list");
  expect((patch.match(/id:\s*connector\b/gu) ?? []).length === 1, "the row id appears once (no duplicate entry)");
}

/* --------------------------------------------- 3. the Plugins-page host pair */
console.log("[check-connector] 3/7 the Plugins-page host table can toggle it");

if (FILES.extrasHost === undefined) {
  bad("the Plugins-page extras host half (index.js) is present", String(repo));
} else {
  const host = read(FILES.extrasHost) ?? "";
  expect(
    new RegExp(`id:\\s*'${ROW_ID}'\\s*,\\s*bundle:\\s*'${BUNDLE}'`, "u").test(host),
    `the host half carries { id: '${ROW_ID}', bundle: '${BUNDLE}' }`,
  );
  expect(
    new RegExp(`id:\\s*'cua-vm'\\s*,\\s*bundle:\\s*'dsh-cua-vm'`, "u").test(host),
    "the VM row it sits beside is still there",
  );
}

/* ---------------------------------------- 4. the Plugins-page client row order */
console.log("[check-connector] 4/7 the client row renders under Personal VM (CUA)");

if (FILES.extrasClient === undefined) {
  bad("the Plugins-page extras client half (client.js) is present", String(repo));
} else {
  const client = read(FILES.extrasClient) ?? "";
  expect(client.includes(`row: '${ROW_ID}'`), "the client half renders a row for it");
  expect(client.includes("title: 'Connector'"), 'the row is titled "Connector"');
  expect(
    client.includes("GitHub / Cloudflare / Gitea connector settings"),
    "the row carries the connector's body copy",
  );
  const order = ["row: 'cua-vm'", `row: '${ROW_ID}'`, "row: 'skill-office'"].map((needle) => client.indexOf(needle));
  expect(
    order.every((position) => position >= 0) && order[0] < order[1] && order[1] < order[2],
    'it sits BETWEEN "Personal VM (CUA)" and "Office documents"',
    order.join(" < "),
  );
  // The glyph key must resolve in the GLYPHS map, or the row renders with the
  // generic tools icon (looks like a bug, ships silently).
  const glyph = new RegExp(`row:\\s*'${ROW_ID}'[\\s\\S]{0,400}?glyph:\\s*'(\\w+)'`, "u").exec(client);
  const key = glyph?.[1];
  expect(key !== undefined, "the row names a glyph", String(key));
  if (key !== undefined) {
    expect(
      new RegExp(`GLYPHS = \\{[^}]*\\b${key}:\\s*\\w+`, "u").test(client),
      `the glyph key "${key}" is in the GLYPHS map`,
    );
  }
}

/* ------------------------------------------------ 5. no duplicate card, ever */
console.log("[check-connector] 5/7 the bundle stays out of the page's own list");

if (FILES.pagePatcher === undefined) {
  bad("tools/patch-plugin-manager-page.mjs is present", String(repo));
} else {
  const patcher = read(FILES.pagePatcher) ?? "";
  const list = /INTEGRATED_BUNDLES\s*=\s*\[([\s\S]*?)\]/u.exec(patcher)?.[1];
  expect(list !== undefined, "the patcher still declares INTEGRATED_BUNDLES");
  if (list !== undefined) {
    const names = [...list.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
    expect(names.includes(BUNDLE), `INTEGRATED_BUNDLES contains "${BUNDLE}"`, names.join(", "));
    expect(names.includes("dsh-cua-vm"), "the sibling bundles are still listed (the set was appended to, not replaced)");
    expect(new Set(names).size === names.length, "no bundle is listed twice");
  }
}

/* ------------------------------------------------------- 6. the entrypoint */
console.log("[check-connector] 6/7 the entrypoint seeds it and repairs the old pin");

if (FILES.entrypoint === undefined) {
  bad("docker/entrypoint.sh is present", String(repo));
} else {
  const entry = read(FILES.entrypoint) ?? "";
  expect(/^CONNECTOR_BUNDLE="dsh-connector"$/mu.test(entry), 'the entrypoint defines CONNECTOR_BUNDLE="dsh-connector"');
  expect(/^seed_connector_bundle\(\)\s*\{/mu.test(entry), "it defines seed_connector_bundle()");
  expect(/^\s*seed_connector_bundle\s*$/mu.test(entry), "it CALLS seed_connector_bundle at boot");
  expect(entry.includes("DSH_CONNECTOR"), "the DSH_CONNECTOR opt-out exists");
  expect(/^drop_connector_profile_link\(\)\s*\{/mu.test(entry), "it defines the @local/connector link migration");
  expect(entry.includes(LEGACY_SPEC), "the migration still looks for the pre-rename package name");
  // The migration must run even when the feature is switched off: it is the
  // stale dependency, not the selection, that breaks a pre-rename home.
  const seeder = /seed_connector_bundle\(\)\s*\{([\s\S]*?)\n\}/u.exec(entry)?.[1] ?? "";
  const migrationAt = seeder.indexOf("drop_connector_profile_link");
  const optOutAt = seeder.indexOf("DSH_CONNECTOR:-1");
  expect(
    migrationAt >= 0 && optOutAt >= 0 && migrationAt < optOutAt,
    "the migration runs BEFORE the DSH_CONNECTOR=0 early return",
    `migration@${migrationAt} opt-out@${optOutAt}`,
  );
  // The suffix match is the safe half of the migration: it drops OUR checkout's
  // pin and leaves a `link:` into node_modules (or anywhere else) alone. The
  // suffix travels as an argument to the node -e script, so both halves are
  // asserted: the comparison is `.endsWith(<arg>)`, and the arg is the literal
  // `/plugin/connector` — never a prefix, never a bare `link:` test.
  expect(
    /spec\.startsWith\("link:"\)[\s\S]{0,80}?\.endsWith\(suffix\)/u.test(entry) &&
      /"@local\/connector" "\/plugin\/connector"/u.test(entry),
    "only a link: whose path suffix is /plugin/connector is dropped (a user's own pin survives)",
  );
}

/* -------------------------------------------------------- 7. the Dockerfile */
console.log("[check-connector] 7/7 the image installs it into BOTH installations");

if (FILES.dockerfile === undefined) {
  bad("the Dockerfile is present", String(repo));
} else {
  const docker = read(FILES.dockerfile) ?? "";
  expect(/^COPY plugins\/dsh-connector \/opt\/dsh-connector$/mu.test(docker), "it COPYs plugins/dsh-connector into the build stage");
  expect(
    /cp -a \/opt\/dsh-connector "\$target\/dsh-connector"/u.test(docker),
    "it cp -a's the package into every installation's node_modules",
  );
  expect(docker.includes("/opt/dsh/node_modules/dsh-connector"), "the npm root is chmod'ed/declared by name");
  expect(docker.includes("/opt/dsh-src/node_modules/dsh-connector"), "the source root is chmod'ed/declared by name");
  expect(/rm -rf[^\n]*\/opt\/dsh-connector\b/u.test(docker), "the staging directory is removed");
  const depsLine = docker
    .split("\n")
    .find((line) => line.includes('for (const n of [') && line.includes('"dsh-office"'));
  expect(depsLine !== undefined, "the dependency-merge line is still where the gate expects it");
  if (depsLine !== undefined) {
    expect(depsLine.includes(`"${BUNDLE}"`), `the deps array declares "${BUNDLE}"`);
    expect(docker.includes("/opt/dsh-src/apps/cli/package.json"), "the source channel's manifest is updated too");
  }
  expect(
    /COPY --chmod=0644 tools\/check-connector\.mjs \/tmp\/check-connector\.mjs/u.test(docker),
    "this gate is staged and run by the image (it is not a file somebody meant to run)",
  );
}

console.log(`[check-connector] ${failed === 0 ? "ok" : "FAILED"} — ${checks - failed}/${checks} checks passed`);
process.exit(failed === 0 ? 0 : 1);
