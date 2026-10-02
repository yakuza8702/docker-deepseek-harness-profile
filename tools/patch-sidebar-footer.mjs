#!/usr/bin/env node
/**
 * Give the sidebar's Settings row a second, LIST slot at its trailing edge.
 *
 * WHY THIS EXISTS
 * ---------------
 * The sidebar's foot is a column: `sidebar.footer.action` (a list) above
 * `sidebar.settings` (a SINGLE slot — only one entry can ever register), and the
 * Settings row itself is the only thing that slot renders. So a plugin that wants
 * a control *beside Settings, at the far right* has nowhere to put it, and one
 * that parks it in `sidebar.footer.action` instead lands in the area above the
 * Settings row — where it competes with whatever else registered there.
 *
 * This adds the missing extension point, at build time and content-anchored:
 *
 *   1. the sidebar DECLARES a child list slot `sidebar.footer.trailing`, and
 *   2. renders it inside `settingsArea`, right after `sidebar.settings`, so its
 *      entries are laid out at the end of the Settings row.
 *
 * Together with the CSS appended below it gives the two arrangements the
 * container wants, from one registration:
 *
 *   EXPANDED   [profile] Settings ................ [glyphs]   (glyphs at the far right)
 *   COLLAPSED  the rail reads as a single centred column, the glyphs among the
 *              other icons, ordered by `order` below.
 *
 * The CSS is appended to the package's own stylesheet and therefore uses that
 * file's OWN hashed class names, resolved from its own class map at patch time —
 * never hardcoded, so a hash change on rebuild cannot silently drop the layout.
 * `data-dsh-sidebar-glyph` is the contract the glyph buttons carry (see
 * plugins/dsh-browser-desktop and plugins/dsh-workspace-browser).
 *
 * Every anchor is asserted present and unique; the patch is idempotent and FAILS
 * THE BUILD if upstream moves one (same philosophy as
 * tools/patch-plugin-manager-page.mjs).
 *
 * Usage: node tools/patch-sidebar-footer.mjs <node_modules-root> [...]
 */
import fs from "node:fs";
import path from "node:path";

const TARGET = path.join(
  "@deepseek-ai",
  "dsh-client-ui-sidebar",
  "lib",
  "client.js",
);

const MARKER = "sidebar.footer.trailing";

// 1. The slot contract: clone the existing LIST slot beside it (the file is not
//    minified, so the block is multi-line; cloning keeps its own indentation).
//    The trailing comma is optional — this block is upstream's last manifest
//    entry and carries none, so the clone supplies the separator instead.
const ANCHOR_SLOT = /([ \t]*)"sidebar\.footer\.action": \{\s*\n\s*kind: "list",\s*\n\s*scope: "root"\s*\n\s*\},?/u;

// 2. The render site: the Settings slot inside `settingsArea`. Wrapped in an array
//    so the trailing slot becomes its next sibling in the same flex row.
const ANCHOR_RENDER = 'renderSlot("sidebar.settings", { wide })';
const REPLACE_RENDER = `[${ANCHOR_RENDER}, renderSlot("${MARKER}", { wide })]`;

/** Occurrences of a literal. */
const count = (text, needle) => text.split(needle).length - 1;
/** Occurrences of a pattern. */
const countRe = (text, pattern) => [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"))].length;

/**
 * The class names this package's own stylesheet uses, read from its class map so
 * the appended rules survive a rebuild that changes the hash.
 * @param source - the built client module.
 * @returns the names the appended CSS needs.
 */
function classNames(source) {
  const of = (name) => {
    const found = new RegExp(`"${name}":\\s*"([^"]+)"`).exec(source);
    return found === null ? null : found[1];
  };
  const names = {
    footArea: of("footArea"),
    footerActions: of("footerActions"),
    settingsArea: of("settingsArea"),
    collapsed: of("collapsed"),
  };
  const missing = Object.entries(names).filter(([, value]) => value === null).map(([key]) => key);
  if (missing.length > 0) throw new Error(`class map has no ${missing.join(", ")}`);
  return names;
}

/**
 * The CSS this patch adds, in this build's own class names.
 * @param names - {@link classNames} result.
 * @returns the rules to append.
 */
function stylesheet(names) {
  return [
    /* The Settings row becomes the flex line the trailing glyphs hang off. */
    `.${names.settingsArea}{display:flex;align-items:center;gap:4px}`,
    /* The row itself takes the free space and gives up its "100% + 4px" width, so
       the glyphs after it sit at the trailing edge rather than being pushed out. */
    `.${names.settingsArea}>[data-slot='sidebar.settings']>*{flex:1 1 auto;min-width:0;width:auto;margin:4px 0}`,
    /* The glyph contract: 36x36 like the profile control, same radius token, same
       theme variables for hover and active — no literal fallbacks, so a missing
       variable stays consistent with the surrounding UI instead of glowing. */
    `[data-dsh-sidebar-glyph]{box-sizing:border-box;flex:0 0 auto;width:36px;height:36px;padding:0;border:0;border-radius:var(--dsw-radius-md,12px);background:none;color:var(--dsw-alias-label-primary,inherit);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background-color 120ms ease}`,
    `[data-dsh-sidebar-glyph]:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
    `[data-dsh-sidebar-glyph]:active{background:var(--dsw-alias-interactive-bg-active)}`,
    `[data-dsh-sidebar-glyph]:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}`,
    /* Rail: both areas dissolve so every icon becomes one item of a single centred
       column, and the order below is what puts the glyphs above the profile. */
    `.${names.collapsed} .${names.footerActions},.${names.collapsed} .${names.settingsArea}{display:contents}`,
    `.${names.collapsed} .${names.footArea} [data-dsh-sidebar-glyph]{margin:3px 0}`,
    `.${names.collapsed} .${names.footArea} [data-dsh-sidebar-glyph='browser']{order:1}`,
    `.${names.collapsed} .${names.footArea} [data-dsh-sidebar-glyph='folder']{order:2}`,
    /* The profile switcher's rail control; anything else registered in the
       footer keeps the default order 0 and stays at the top of the column. */
    `.${names.collapsed} .${names.footArea} .dsh-ps__wrap{order:3}`,
    `.${names.collapsed} .${names.footArea} [data-slot='sidebar.settings']>*{order:4}`,
  ].join("");
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: node tools/patch-sidebar-footer.mjs <node_modules-root> [...]");
  process.exit(2);
}

let patched = 0;
let skipped = 0;

for (const root of roots) {
  const file = path.join(root, TARGET);
  if (!fs.existsSync(file)) {
    console.log(`[sidebar-footer] skipped ${file} (absent)`);
    continue;
  }
  const before = fs.readFileSync(file, "utf8");

  if (before.includes(MARKER)) {
    console.log(`[sidebar-footer] already patched: ${file}`);
    skipped += 1;
    continue;
  }

  const slotCount = countRe(before, ANCHOR_SLOT);
  const renderCount = count(before, ANCHOR_RENDER);
  if (slotCount !== 1 || renderCount !== 1) {
    console.error(
      `[sidebar-footer] ERROR: anchors moved in ${file} (list slot seen ${slotCount}x, Settings render site seen ${renderCount}x, expected 1 each).\n` +
        `  The sidebar cannot grow a trailing slot in its Settings row without them, so the image refuses to build. Re-anchor this script against the new upstream code.`,
    );
    process.exit(1);
  }

  const names = classNames(before);

  // The stylesheet is one string literal; anchor on the class map's own hash so a
  // different variable name or minifier output cannot break the match.
  const CSS_RE = /"((?:[^"\\]|\\.)*)"/g;
  const candidates = [...before.matchAll(CSS_RE)].filter((match) => match[1].includes(`${names.footArea}{`));
  if (candidates.length !== 1) {
    console.error(
      `[sidebar-footer] ERROR: expected exactly one stylesheet literal naming ${names.footArea} in ${file}, found ${candidates.length}.\n` +
        `  Appending the layout rules to the wrong string would ship dead CSS, so the image refuses to build.`,
    );
    process.exit(1);
  }
  const css = candidates[0];
  const cssStart = css.index + 1;
  const cssEnd = cssStart + css[1].length;

  const slot = ANCHOR_SLOT.exec(before)[0];
  const block = slot.replace(/,\s*$/u, "");
  const clone = `${block.replace('"sidebar.footer.action"', `"${MARKER}"`)},`;
  const regrown = `${clone}\n${slot}`;

  const after = (
    before.slice(0, cssEnd) + stylesheet(names) + before.slice(cssEnd)
  )
    .replace(slot, regrown)
    .replace(ANCHOR_RENDER, REPLACE_RENDER);

  fs.writeFileSync(file, after);
  console.log(`[sidebar-footer] patched: ${file} (classes ${names.footArea}/${names.settingsArea})`);
  patched += 1;
}

if (patched === 0 && skipped === 0) {
  console.error("[sidebar-footer] ERROR: no sidebar client bundle among: " + roots.join(", "));
  process.exit(1);
}
console.log(`[sidebar-footer] ok — ${patched} patched, ${skipped} already patched`);
