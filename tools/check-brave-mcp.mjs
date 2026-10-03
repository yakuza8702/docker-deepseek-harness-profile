#!/usr/bin/env node
/**
 * Build gate for the `brave-devtools-mcp` row — the browser TROUBLESHOOTING tool
 * surface ("Browser tools brave" on the Plugins page).
 *
 * WHY THIS EXISTS
 * ---------------
 * The row is only useful if FOUR separate pieces agree, and three of them live in
 * different files that a refactor can silently unsync:
 *
 *   1. the server itself — a pinned `brave-mcp` in the image, behind the stable
 *      wrapper the row spawns;
 *   2. the row — the bundle patch that mounts `@deepseek-ai/dsh-mcp-client`;
 *   3. the SWITCH — the Plugins-page host table (which row id it may toggle) and
 *      its client half (which title it renders);
 *   4. the duplicate-card suppression — the name must stay in the page's
 *      `BUILTIN_PROFILE_BUNDLES` set, or the integrated feature reappears as a
 *      second, ordinary card underneath.
 *
 * A green image with any ONE of those missing looks exactly like success until the
 * user opens the page. So this gate EXECUTES the server (a real MCP handshake, no
 * browser needed: brave-mcp connects lazily, on the first tool that needs one) and
 * then asserts every wiring point by reading the installed files.
 *
 * Usage: node tools/check-brave-mcp.mjs <wrapper> <expected-version> <dsh-root> [...]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [wrapperPath, expectedVersion, ...roots] = process.argv.slice(2);
if (!wrapperPath || !expectedVersion || roots.length === 0) {
  console.error("usage: node tools/check-brave-mcp.mjs <wrapper> <expected-version> <dsh-root> [...]");
  process.exit(2);
}

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

/** The bundle the row belongs to, and the identity the wiring must carry. */
const BUNDLE = "dsh-brave-devtools-mcp";
const ROW_ID = "brave-devtools-mcp";
const SERVER_NAME = "brave-devtools";
const DESKTOP_GUARD = "DSH_DESKTOP_ENABLED";

/** The tools this row exists FOR: the diagnostic surface Playwright does not have. */
const REQUIRED_TOOLS = [
  "list_console_messages",
  "get_console_message",
  "list_network_requests",
  "get_network_request",
  "get_css_styles",
  "performance_start_trace",
  "performance_stop_trace",
  "performance_analyze_insight",
  "lighthouse_audit",
  "take_heapsnapshot",
  "evaluate_script",
  "take_snapshot",
  "navigate_page"
];

/* ------------------------------------------------------------------ 1. server */
console.log(`[check-brave-mcp] 1/4 the server behind ${wrapperPath}`);

expect(fs.existsSync(wrapperPath), "wrapper exists");
if (fs.existsSync(wrapperPath)) {
  const mode = fs.statSync(wrapperPath).mode;
  expect((mode & 0o111) !== 0, "wrapper is executable", `mode ${(mode & 0o777).toString(8)}`);
}

/** Run the wrapper and capture stdout, with a hard deadline. */
const run = (args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(wrapperPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, out, err, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, out, err: String(error), timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut: false });
    });
  });

const version = await run(["--version"], 60000);
expect(
  version.out.trim() === expectedVersion,
  "the wrapper reports the pinned version",
  `${version.out.trim() || version.err.trim() || "no output"} (expected ${expectedVersion})`
);

/**
 * A real MCP session over stdio: initialize, then tools/list. The endpoint is
 * deliberately a port nothing listens on — the gate must not depend on a browser
 * existing at build time, and brave-mcp connects lazily, so a successful
 * handshake with an unreachable browser is exactly the expected shape.
 */
const handshake = () =>
  new Promise((resolve) => {
    const child = spawn(wrapperPath, ["--browserUrl=http://127.0.0.1:9222", "--no-performance-crux"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let buffer = "";
    let stderr = "";
    const settled = { done: false };
    const finish = (value) => {
      if (settled.done) return;
      settled.done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(value);
    };
    const timer = setTimeout(() => finish({ error: "handshake timed out after 60s", tools: [] }), 60000);
    const pending = new Map();
    let nextId = 1;
    const call = (method, params) =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { res, rej });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line === "") continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const waiter = message.id !== undefined ? pending.get(message.id) : undefined;
        if (waiter === undefined) continue;
        pending.delete(message.id);
        message.error ? waiter.rej(new Error(JSON.stringify(message.error))) : waiter.res(message.result);
      }
    });
    child.on("error", (error) => finish({ error: String(error), tools: [] }));

    (async () => {
      const info = await call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "check-brave-mcp", version: "1.0.0" }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const listed = await call("tools/list", {});
      finish({ serverInfo: info?.serverInfo, tools: (listed?.tools ?? []).map((tool) => tool.name) });
    })().catch((error) => finish({ error: error.message, tools: [], stderr }));
  });

const session = await handshake();
if (session.error !== undefined) {
  bad("MCP handshake through the wrapper", session.error);
} else {
  ok("MCP handshake through the wrapper", `server "${session.serverInfo?.name}" ${session.serverInfo?.version}`);
  const tools = new Set(session.tools);
  expect(tools.size >= 30, "the server exposes the full tool surface", `${tools.size} tools`);
  const missing = REQUIRED_TOOLS.filter((tool) => !tools.has(tool));
  expect(
    missing.length === 0,
    "every diagnostic tool this row is for is present",
    missing.length === 0 ? `${REQUIRED_TOOLS.length} required tools checked` : `missing: ${missing.join(", ")}`
  );
}

/* ------------------------------------------------------- 2. the bundle + row */
console.log(`[check-brave-mcp] 2/4 the row the bundle mounts`);

const bundleDir = roots.map((root) => path.join(root, BUNDLE)).find((candidate) => fs.existsSync(candidate));
expect(bundleDir !== undefined, `"${BUNDLE}" is installed in a DSH installation tree`, bundleDir ?? roots.join(", "));

if (bundleDir !== undefined) {
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, "package.json"), "utf8"));
  expect(
    manifest.dsh?.bundle?.patch === "./cordis.patch.yml",
    "the bundle declares its patch, so the Plugins page lists it",
    String(manifest.dsh?.bundle?.patch)
  );
  const patchPath = path.join(bundleDir, "cordis.patch.yml");
  const patch = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, "utf8") : "";
  expect(patch.includes(`id: ${ROW_ID}`), `the patch mounts the row id "${ROW_ID}"`);
  expect(patch.includes(`serverName: ${SERVER_NAME}`), `the row's tool namespace is "${SERVER_NAME}"`);
  expect(patch.includes("dsh-mcp-client"), "the row is a plain MCP client row");
  expect(
    patch.includes(`command: ${wrapperPath}`) || patch.includes("command: /usr/local/bin/dsh-brave-devtools-mcp"),
    "the row spawns the wrapper this gate just exercised"
  );
  expect(patch.includes("127.0.0.1"), "the row attaches over loopback CDP, never a remote browser");
  expect(patch.includes("--no-performance-crux"), "the privacy default is in the row (no trace URLs to Google)");
  expect(patch.includes(DESKTOP_GUARD), "the row honours the desktop switch", DESKTOP_GUARD);
}

/* ------------------------------------------------------------- 3. the switch */
console.log("[check-brave-mcp] 3/4 the Plugins-page switch");

const extras = roots.map((root) => path.join(root, "dsh-plugins-page-extras")).find((candidate) => fs.existsSync(candidate));
expect(extras !== undefined, "the Plugins-page extras bundle is installed", extras ?? "not found");
if (extras !== undefined) {
  const host = fs.readFileSync(path.join(extras, "index.js"), "utf8");
  expect(
    new RegExp(`id:\\s*'${ROW_ID}',\\s*bundle:\\s*'${BUNDLE}'`, "u").test(host),
    "the host half may toggle this row (id + bundle pair)"
  );
  const client = fs.readFileSync(path.join(extras, "client.js"), "utf8");
  expect(client.includes(`row: '${ROW_ID}'`), "the client half renders a row for it");
  expect(client.includes("Browser tools brave"), 'the row is titled "Browser tools brave"');
  // The order is the requirement: between the driving tools and the desktop row.
  const order = ["row: 'browser-mcp'", `row: '${ROW_ID}'`, "row: 'browser-desktop'"].map((needle) => client.indexOf(needle));
  expect(
    order.every((position) => position >= 0) && order[0] < order[1] && order[1] < order[2],
    "it sits BETWEEN \"Browser tools\" and \"Browser Use\"",
    order.join(" < ")
  );
}

/* ------------------------------------------------- 4. no duplicate card, ever */
console.log("[check-brave-mcp] 4/4 the bundle stays out of the page's own list");

for (const root of roots) {
  const page = path.join(root, "@deepseek-ai", "dsh-client-ui-plugin-manager", "lib", "client.js");
  if (!fs.existsSync(page)) {
    console.log(`  --   ${page} absent in this tree`);
    continue;
  }
  const source = fs.readFileSync(page, "utf8");
  const set = /const BUILTIN_PROFILE_BUNDLES = new Set\(\[([\s\S]*?)\]\)/u.exec(source);
  expect(set !== null, `the exclusion set is still where the patch expects it (${path.dirname(page)})`);
  if (set !== null) {
    expect(
      set[1].includes(`"${BUNDLE}"`) || set[1].includes(`'${BUNDLE}'`),
      `${BUNDLE} is excluded from the ordinary list (no second card under "Installed")`
    );
    expect(set[1].includes('"dsh-browser-mcp"'), "the sibling bundles are still excluded too");
  }
  expect(source.includes("plugins.page.top"), "the top slot the rows render into is present");
}

/* --------------------------------------------------------- the boot selection */
console.log("[check-brave-mcp] extras: the entrypoint knows how to select it");
// Overridable so the gate can also be dry-run against a checkout rather than only
// against the image layout (the image never sets it).
const entry = process.env.BRAVE_MCP_CHECK_ENTRYPOINT ?? "/opt/seek-harness/entrypoint.sh";
if (fs.existsSync(entry)) {
  const text = fs.readFileSync(entry, "utf8");
  expect(text.includes("seed_brave_devtools_bundle"), "the entrypoint defines/calls the seeder");
  expect(text.includes("DSH_BRAVE_DEVTOOLS_MCP"), "the opt-out switch exists");
  expect(
    /seed_brave_devtools_bundle\s*\n/u.test(text) || /^\s*seed_brave_devtools_bundle$/mu.test(text),
    "the seeder is actually invoked at boot"
  );
} else {
  console.log(`  --   ${entry} absent in this tree`);
}

console.log(`[check-brave-mcp] ${failed === 0 ? "ok" : "FAILED"} — ${checks - failed}/${checks} checks passed`);
process.exit(failed === 0 ? 0 : 1);
