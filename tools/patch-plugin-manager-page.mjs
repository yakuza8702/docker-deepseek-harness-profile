#!/usr/bin/env node
/**
 * Give the Plugins page a slot ABOVE its groups.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Plugins page (`@deepseek-ai/dsh-client-ui-plugin-manager`) supports
 * contributing INTO its groups — a `plugins.item` card lands inside "Official",
 * after the shipped cards — but there is no extension point *above* them. DSH
 * Desktop gets its top sections ("Plugin market", "Remote Control", "Computer
 * Use") by patching this very package (patches/dsh-client-ui-plugin-manager@…),
 * which adds slots of its own. This image needs the same shape for its integrated
 * feature, so it does the same thing here, at build time and content-anchored:
 *
 *   1. the page DECLARES a child slot `plugins.page.top` in its own slot contract
 *      (declaring is what authorises rendering the key), and
 *   2. the page RENDERS it immediately before the first group of its main list —
 *      `basic` since 0.2.1-alpha.2, `official` before that (both shapes are
 *      anchored; see ANCHOR_RENDER_VARIANTS).
 *
 * `dsh-plugins-page-extras` then registers the component that fills it.
 *
 * It also adds this installation's INTEGRATED bundles to the page's own
 * `BUILTIN_PROFILE_BUNDLES` set, so a feature that has moved into the top section
 * stops having a card of its own underneath: a bundle is listed only when it is a
 * profile dependency or a shipped optional bundle, and the page already excludes
 * the names in that set. Without this the same feature appears twice — as the
 * top row and again under "Installed" — which is not the layout of the Desktop
 * page this mirrors.
 *
 * Every anchor is asserted present and unique; the patch is idempotent and FAILS
 * THE BUILD if upstream moves one — an upstream refactor must never silently drop
 * the section or resurrect the duplicate card (same philosophy as
 * tools/patch-browser-use-exclusivity.mjs).
 *
 * Usage: node tools/patch-plugin-manager-page.mjs <node_modules-root> [...]
 */
import fs from "node:fs";
import path from "node:path";

const PACKAGE = "@deepseek-ai/dsh-client-ui-plugin-manager";
const TARGET_SUBPATH = path.join("lib", "client.js");
/** Kept for the log messages: the path as it looks in a flat (npm) install. */
const TARGET = path.join(PACKAGE, TARGET_SUBPATH);

const MARKER = "plugins.page.top";

// 1. The slot contract: the page declares the child slots it renders. The file is
//    NOT minified — the declaration is a multi-line block — so this anchor is
//    whitespace-tolerant and the replacement CLONES the matched block (keeping the
//    file's own indentation) instead of hardcoding a layout.
const ANCHOR_DECL = /([ \t]*)"plugins\.item": \{\s*\n\s*kind: "list",\s*\n\s*scope: "root"\s*\n\s*\},/u;

// 2. The render site: immediately before the FIRST group of the page's main list —
//    the group the shipped bundles live in. Upstream renamed it in 0.2.1-alpha.2:
//    `renderGroup("official", t("officialTitle"), officialCards)` became
//    `renderGroup("basic", t("basicTitle"), basicCards)`, and the page now renders
//    three groups (basic / extensions / bundles) instead of one official list.
//    Both shapes are listed, newest first: the image may be built against either
//    channel, the first variant that appears EXACTLY ONCE wins, and a third shape
//    fails the build with every variant's count printed — so the next re-anchor is
//    a one-line change instead of a bisect through a 200 KB bundle.
const ANCHOR_RENDER_VARIANTS = [
  { since: "0.2.1-alpha.2+", anchor: 'renderGroup("basic", t("basicTitle"), basicCards)' },
  { since: "<= 0.2.1-alpha.1", anchor: 'renderGroup("official", t("officialTitle"), officialCards)' },
];

// 3. The page's own exclusion list: names that stay out of it even when the
//    profile declares them as dependencies.
const ANCHOR_BUILTIN = /const BUILTIN_PROFILE_BUNDLES = new Set\(\[([\s\S]*?)\]\)/u;

/**
 * The bundles this installation surfaces in the top section instead of as cards:
 * the browser tooling (plugins/dsh-browser-mcp), the browser troubleshooting tools
 * (plugins/dsh-brave-devtools-mcp), the visible browser desktop with its
 * browser_open bridge (plugins/dsh-browser-desktop), the Office skills and their
 * Python payload (plugins/dsh-office) and the market the market selector installs.
 * All of them keep their own switch up there, so nothing becomes uncontrollable —
 * they simply stop being listed twice.
 */
const INTEGRATED_BUNDLES = ["dsh-browser-mcp", "dsh-brave-devtools-mcp", "dsh-browser-desktop", "dsh-office", "dshmarket"];

/** Occurrences of a literal, counted without regex escaping. */
const count = (text, needle) => text.split(needle).length - 1;
/** Occurrences of a pattern. */
const countRe = (text, pattern) => [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"))].length;

/**
 * Locate PACKAGE's directory under one installation root.
 *
 * A build produces exactly ONE of three layouts, so a root-only lookup is a
 * silent no-op on the other two — which is how this patch went missing from every
 * source-channel image:
 *   npm    <root>/@deepseek-ai/<name>
 *   pnpm   <root>/.pnpm/@deepseek-ai+<name>@<version>/node_modules/@deepseek-ai/<name>
 *   source <tree>/packages/<tier>/<name>, <tree>/apps/<name>, <tree>/native/<name>
 *          — pnpm links workspace packages by SYMLINK, so the workspace copy IS
 *            the file the runtime serves and the one that must be patched.
 */
function resolvePackageDir(root) {
  const flat = path.join(root, PACKAGE);
  if (isDir(flat)) return flat;

  const store = path.join(root, ".pnpm");
  if (isDir(store)) {
    const mangled = PACKAGE.replace("/", "+");
    const hit = fs.readdirSync(store).find((entry) => entry === mangled || entry.startsWith(`${mangled}@`));
    if (hit !== undefined) {
      const dir = path.join(store, hit, "node_modules", PACKAGE);
      if (isDir(dir)) return dir;
    }
  }

  const tree = path.dirname(root);
  for (const group of ["packages", "apps", "vendor", "native"]) {
    const groupDir = path.join(tree, group);
    if (!isDir(groupDir)) continue;
    for (const entry of fs.readdirSync(groupDir)) {
      const entryDir = path.join(groupDir, entry);
      if (!isDir(entryDir)) continue;
      // packages/<tier>/<pkg>; the other groups are one level deep.
      const candidates =
        group === "packages" ? fs.readdirSync(entryDir).map((child) => path.join(entryDir, child)) : [entryDir];
      for (const dir of candidates) {
        if (packageName(dir) === PACKAGE) return dir;
      }
    }
  }
  return undefined;
}

/** A directory's package.json name, or undefined when it has none. */
function packageName(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name;
  } catch {
    return undefined;
  }
}

/** Directory test that tolerates a dangling symlink. */
function isDir(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: node tools/patch-plugin-manager-page.mjs <node_modules-root> [...]");
  process.exit(2);
}

let patched = 0;
let skipped = 0;

for (const root of roots) {
  const packageDir = resolvePackageDir(root);
  const file = packageDir === undefined ? undefined : path.join(packageDir, TARGET_SUBPATH);
  if (file === undefined || !fs.existsSync(file)) {
    console.log(`[plugins-page] skipped ${path.join(root, TARGET)} (absent in this layout)`);
    continue;
  }
  const before = fs.readFileSync(file, "utf8");

  const slotsDone = before.includes(MARKER);
  const builtinDone = INTEGRATED_BUNDLES.every((name) => before.includes(`"${name}"`));
  if (slotsDone && builtinDone) {
    console.log(`[plugins-page] already patched: ${file}`);
    skipped += 1;
    continue;
  }

  let after = before;

  if (!slotsDone) {
    const declCount = countRe(after, ANCHOR_DECL);
    const variant = ANCHOR_RENDER_VARIANTS.find((candidate) => count(after, candidate.anchor) === 1);
    if (declCount !== 1 || variant === undefined) {
      const seen = ANCHOR_RENDER_VARIANTS
        .map((candidate) => `${candidate.since} ${count(after, candidate.anchor)}x`)
        .join(", ");
      console.error(
        `[plugins-page] ERROR: anchors moved in ${file} (slot declaration seen ${declCount}x, render site: ${seen}; expected 1 each).\n` +
          `  The Plugins page cannot be extended above its groups without them, so the image refuses to build. Re-anchor this script against the new upstream code.`,
      );
      process.exit(1);
    }
    const declaration = ANCHOR_DECL.exec(after)[0];
    const clone = declaration.replace('"plugins.item"', `"${MARKER}"`);
    after = after
      .replace(declaration, `${clone}\n${declaration}`)
      .replace(variant.anchor, `renderSlot("${MARKER}", {}), ${variant.anchor}`);
    console.log(`[plugins-page] render site: ${variant.since} shape`);
  }

  if (!builtinDone) {
    const found = ANCHOR_BUILTIN.exec(after);
    if (found === null) {
      console.error(
        `[plugins-page] ERROR: the exclusion list anchor is gone from ${file} (BUILTIN_PROFILE_BUNDLES not found).\n` +
          `  ${INTEGRATED_BUNDLES.join(", ")} would come back as duplicate cards, so the image refuses to build. Re-anchor this script against the new upstream code.`,
      );
      process.exit(1);
    }
    const body = found[1];
    const indent = (body.match(/\n([^\S\n]+)["']/u) ?? [null, "  "])[1];
    const missing = INTEGRATED_BUNDLES.filter((name) => !body.includes(`"${name}"`) && !body.includes(`'${name}'`));
    // Keep the original trailing whitespace so the closing bracket lands on its
    // own indentation, and supply the separator: upstream's last entry carries no
    // trailing comma (the built bundle and the source agree).
    const tail = /\s*$/u.exec(body)[0];
    const head = body.slice(0, body.length - tail.length);
    const separator = /,[ \t]*$/u.test(head) ? "" : ",";
    const grown = `${head}${separator}${missing.map((name) => `\n${indent}"${name}",`).join("")}${tail}`;
    after = after.replace(found[0], `const BUILTIN_PROFILE_BUNDLES = new Set([${grown}])`);
  }

  fs.writeFileSync(file, after);
  console.log(`[plugins-page] patched: ${file} (slots ${slotsDone ? "kept" : "added"}, exclusion list ${builtinDone ? "kept" : "extended"})`);
  patched += 1;
}

if (patched === 0 && skipped === 0) {
  console.error("[plugins-page] ERROR: no plugin-manager client bundle among: " + roots.join(", "));
  process.exit(1);
}
console.log(`[plugins-page] ok — ${patched} patched, ${skipped} already patched`);
