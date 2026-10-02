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
 *   2. the page RENDERS it immediately before the "Official" group.
 *
 * `dsh-plugins-page-extras` then registers the component that fills it.
 *
 * Exactly two anchors, both asserted present and unique; the patch is idempotent
 * and FAILS THE BUILD if upstream moves either one — an upstream refactor must
 * never silently drop the section (same philosophy as
 * tools/patch-browser-use-exclusivity.mjs).
 *
 * Usage: node tools/patch-plugin-manager-page.mjs <node_modules-root> [...]
 */
import fs from "node:fs";
import path from "node:path";

const TARGET = path.join(
  "@deepseek-ai",
  "dsh-client-ui-plugin-manager",
  "lib",
  "client.js",
);

const MARKER = "plugins.page.top";

// 1. The slot contract: the page declares the child slots it renders. The file is
//    NOT minified — the declaration is a multi-line block — so this anchor is
//    whitespace-tolerant and the replacement CLONES the matched block (keeping the
//    file's own indentation) instead of hardcoding a layout.
const ANCHOR_DECL = /([ \t]*)"plugins\.item": \{\s*\n\s*kind: "list",\s*\n\s*scope: "root"\s*\n\s*\},/u;

// 2. The render site: immediately before the "Official" group (a single line).
const ANCHOR_RENDER = 'renderGroup("official", t("officialTitle"), officialCards)';
const REPLACE_RENDER = `renderSlot("${MARKER}", {}), ${ANCHOR_RENDER}`;

/** Occurrences of a literal, counted without regex escaping. */
const count = (text, needle) => text.split(needle).length - 1;
/** Occurrences of a pattern. */
const countRe = (text, pattern) => [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"))].length;

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: node tools/patch-plugin-manager-page.mjs <node_modules-root> [...]");
  process.exit(2);
}

let patched = 0;
let skipped = 0;

for (const root of roots) {
  const file = path.join(root, TARGET);
  if (!fs.existsSync(file)) {
    console.log(`[plugins-page] skipped ${file} (absent)`);
    continue;
  }
  const before = fs.readFileSync(file, "utf8");

  if (before.includes(MARKER)) {
    console.log(`[plugins-page] already patched: ${file}`);
    skipped += 1;
    continue;
  }

  const declCount = countRe(before, ANCHOR_DECL);
  const renderCount = count(before, ANCHOR_RENDER);
  if (declCount !== 1 || renderCount !== 1) {
    console.error(
      `[plugins-page] ERROR: anchors moved in ${file} (slot declaration seen ${declCount}x, render site seen ${renderCount}x, expected 1 each).\n` +
        `  The Plugins page cannot be extended above its groups without them, so the image refuses to build. Re-anchor this script against the new upstream code.`,
    );
    process.exit(1);
  }

  const declaration = ANCHOR_DECL.exec(before)[0];
  const clone = declaration.replace('"plugins.item"', `"${MARKER}"`);
  const after = before
    .replace(declaration, `${clone}\n${declaration}`)
    .replace(ANCHOR_RENDER, REPLACE_RENDER);
  fs.writeFileSync(file, after);
  console.log(`[plugins-page] patched: ${file}`);
  patched += 1;
}

if (patched === 0 && skipped === 0) {
  console.error("[plugins-page] ERROR: no plugin-manager client bundle among: " + roots.join(", "));
  process.exit(1);
}
console.log(`[plugins-page] ok — ${patched} patched, ${skipped} already patched`);
