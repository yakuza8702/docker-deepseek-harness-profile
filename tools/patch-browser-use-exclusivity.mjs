#!/usr/bin/env node
/**
 * Make the official Playwright MCP browser-use provider NON-EXCLUSIVE.
 *
 * WHY THIS EXISTS
 * ---------------
 * `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` passes
 * `exclusive: config.mode === "attach"` to the browser-use runtime, so in attach
 * mode exactly ONE live Session may hold the attached browser. Upstream is
 * explicit that this is intentional (runtime README, "Known Limitations"):
 *
 *   "Attachment mode reserves one external browser for a single Session."
 *   "A busy attachment skips startup permanently for that live activation."
 *   "Releasing the attachment does not retry skipped activations; a newly
 *    created or resumed Agent can acquire it."
 *
 * In a container that boots with sessions already open, the winner of that race
 * is whichever activation happens first — often not the session you are using —
 * and every other session is then left without browser tools, silently and
 * permanently. That is the behaviour this fork removes: every live Session gets
 * its own MCP client attached to the SAME visible browser, so the tools are
 * always there and human takeover still works.
 *
 * The cost is honest and documented: the browser is one browser, so its cookies,
 * logins and tabs are shared between Sessions, and two Sessions driving it at
 * the same time compete for the active tab.
 *
 * Set DSH_BROWSER_USE_EXCLUSIVE=1 to get upstream's single-owner behaviour back.
 *
 * HOW IT PATCHES
 * --------------
 * Content-anchored and idempotent, like tools/apply-profile-patch.mjs: it matches
 * the exact upstream expression, refuses to guess, and FAILS the build when the
 * anchor is gone — so an upstream refactor is a loud build error, never a silent
 * revert to the behaviour this fork removed.
 *
 * Usage: node tools/patch-browser-use-exclusivity.mjs <node_modules-root> [...]
 */
import fs from "node:fs";
import path from "node:path";

const TARGET_SUBPATH = path.join(
  "@deepseek-ai",
  "dsh-experimental-browser-use-playwright-mcp",
  "lib",
  "index.js",
);

// The exact upstream expression. Quoting must match the published file.
const ANCHOR = 'exclusive: config.mode === "attach"';
const REPLACEMENT =
  'exclusive: process.env.DSH_BROWSER_USE_EXCLUSIVE === "1" ? config.mode === "attach" : false';
const MARKER = "DSH_BROWSER_USE_EXCLUSIVE";

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: patch-browser-use-exclusivity.mjs <node_modules-root> [...]");
  process.exit(2);
}

let patched = 0;
let already = 0;
let missingRoot = 0;

for (const root of roots) {
  const file = path.join(root, TARGET_SUBPATH);
  if (!fs.existsSync(file)) {
    console.log(`[patch-browser-use] not installed here: ${file}`);
    missingRoot++;
    continue;
  }
  const source = fs.readFileSync(file, "utf8");

  if (source.includes(MARKER)) {
    console.log(`[patch-browser-use] already patched: ${file}`);
    already++;
    continue;
  }

  const hits = source.split(ANCHOR).length - 1;
  if (hits !== 1) {
    console.error(
      `[patch-browser-use] ERROR: expected exactly one occurrence of the anchor in ${file}, found ${hits}.\n` +
        `  anchor: ${ANCHOR}\n` +
        `  Upstream changed shape — inspect the provider before bumping DSH_VERSION.`,
    );
    process.exit(1);
  }

  fs.writeFileSync(file, source.replace(ANCHOR, REPLACEMENT));
  console.log(`[patch-browser-use] patched: ${file}`);
  patched++;
}

if (patched + already === 0) {
  console.error(
    `[patch-browser-use] ERROR: the provider was found in no installation root (${roots.join(", ")}).\n` +
      `  The browser-use packages are installed earlier in this Dockerfile — check that step.`,
  );
  process.exit(1);
}

console.log(
  `[patch-browser-use] done: ${patched} patched, ${already} already patched, ${missingRoot} root(s) without the provider`,
);
