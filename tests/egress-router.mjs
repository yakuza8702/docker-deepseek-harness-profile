#!/usr/bin/env node
/**
 * tests/egress-router.mjs — the selective-egress contract, proved locally.
 *
 * WHAT THIS PROVES (no network, no image, no docker):
 *   1. a ROUTED host's CONNECT really reaches the upstream proxy (and the router
 *      does not silently send it direct);
 *   2. every OTHER host tunnels DIRECT, so adding a proxy can never again take
 *      the general internet away (api.deepseek.com, npmjs, the model routes);
 *   3. an upstream that will not answer degrades to DIRECT instead of failing the
 *      request — the exact regression that made every model unreachable;
 *   4. EGRESS_STRICT=1 turns that degradation into a 502 (opt-in hard guarantee);
 *   5. plain absolute-form HTTP requests take the same decision;
 *   6. `--probe` reports usable/unusable with the exit codes the entrypoint reads.
 *
 * The upstream and the "origin" are local stubs: the test must answer on a runner
 * with no internet at all, and it must never depend on the real DeepSeek edge.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER = join(HERE, "..", "docker", "egress-router.mjs");

let failures = 0;
let checks = 0;
/** Run one named assertion, printing immediately (CI logs stream). */
function check(name, fn) {
  checks += 1;
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((error) => {
      failures += 1;
      console.log(`  FAIL ${name} — ${error.message}`);
    });
}

/** Free loopback port: bind 0, read it, close. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Wait until a loopback port accepts a connection (or fail loudly). */
async function waitPort(port, ms = 8000) {
  const started = Date.now();
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch (error) {
      if (Date.now() - started > ms) throw new Error(`port ${port} never opened: ${error.code || error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/**
 * An upstream-proxy stub: records what it was asked to CONNECT/GET and answers
 * 200 with a marker, so the test can prove WHICH path a request took.
 * @param {{status?: number}} [options] - CONNECT status to answer with.
 */
async function proxyStub(options = {}) {
  const status = options.status ?? 200;
  const seen = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buffer.slice(0, end);
      const line = head.split("\r\n")[0];
      seen.push(line);
      if (line.startsWith("CONNECT ")) {
        if (status !== 200) {
          socket.end(`HTTP/1.1 ${status} Forbidden\r\nContent-Length: 0\r\n\r\n`);
          return;
        }
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.write(`VIA-UPSTREAM ${line.slice(8)}\n`);
      } else {
        const target = line.split(" ")[1];
        const body = `VIA-UPSTREAM ${target}`;
        socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nContent-Type: text/plain\r\n\r\n${body}`);
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A direct-origin stub: answers any HTTP request with a marker. */
async function httpOrigin() {
  const server = net.createServer((socket) => {
    socket.on("data", () => {
      const body = "DIRECT-ORIGIN";
      socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nContent-Type: text/plain\r\n\r\n${body}`);
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A WebSocket-ish origin: answers 101, then echoes whatever it receives. */
async function upgradeOrigin() {
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      socket.write("WS-ORIGIN\n");
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Echo origin for CONNECT-through-direct assertions. */
async function tcpEcho() {
  const server = net.createServer((socket) => {
    socket.write("DIRECT-ECHO\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * Start the router; resolves with the real port and a log buffer.
 * @param {Record<string, string>} env - extra environment.
 */
async function startRouter(env) {
  const child = spawn(process.execPath, [ROUTER], {
    env: { ...process.env, EGRESS_ROUTER_PORT: "0", EGRESS_ROUTER_HOST: "127.0.0.1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (chunk) => log.push(chunk.toString()));
  child.stderr.on("data", (chunk) => log.push(chunk.toString()));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`router did not report a port: ${log.join("")}`)), 8000);
    const onData = () => {
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(log.join(""));
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`router exited ${code}: ${log.join("")}`));
    });
  });
  return { child, port, log };
}

/**
 * Send one CONNECT and read the head plus the tunnel's first marker.
 *
 * The 200 head and the tunneled bytes arrive in separate packets (the router
 * writes the head itself, then pipes), so stopping at the first newline would
 * assert on the head alone and never see what the tunnel actually carries.
 */
function connectThrough(port, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let data = "";
    let idle = null;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("CONNECT timed out"));
    }, 5000);
    const settle = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(data);
    };
    socket.once("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      // Resolve as soon as a marker proves which path the request took, or once
      // the socket has been quiet for 300 ms after the head.
      if (/VIA-UPSTREAM|DIRECT-ECHO|502 Bad Gateway/.test(data)) {
        settle();
        return;
      }
      if (data.includes("\r\n\r\n")) {
        clearTimeout(idle);
        idle = setTimeout(settle, 300);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Send one absolute-form HTTP request through the router. */
function requestThrough(port, absoluteUrl) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("HTTP request timed out"));
    }, 5000);
    socket.once("connect", () => {
      socket.write(`GET ${absoluteUrl} HTTP/1.1\r\nHost: ${new URL(absoluteUrl).host}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => (data += chunk.toString("latin1")));
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(data);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Send one absolute-form Upgrade request through the router and read the reply. */
function upgradeThrough(port, absoluteUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(absoluteUrl);
    const socket = net.connect({ host: "127.0.0.1", port });
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("upgrade request timed out"));
    }, 5000);
    socket.once("connect", () => {
      socket.write(
        `GET ${absoluteUrl} HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGVzdA==\r\n\r\n`,
      );
    });
    let idle = null;
    const settle = () => {
      clearTimeout(timer);
      clearTimeout(idle);
      socket.destroy();
      resolve(data);
    };
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      // The 101 head and the first frame can arrive in separate packets.
      if (/WS-ORIGIN|502 Bad Gateway|404 Not Found/.test(data)) {
        settle();
        return;
      }
      if (data.includes("\r\n\r\n")) {
        clearTimeout(idle);
        idle = setTimeout(settle, 300);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const children = [];
const stubs = [];

/* ------------------------------------------------------------------ tests */

async function main() {
  const upstream = await proxyStub();
  const echo = await tcpEcho();
  const origin = await httpOrigin();
  const ws = await upgradeOrigin();
  stubs.push(upstream, echo, origin, ws);

  /* 1. routed host -> upstream */
  {
    const router = await startRouter({
      EGRESS_UPSTREAM: `http://127.0.0.1:${upstream.port}`,
      EGRESS_ROUTE_HOSTS: "chat.deepseek.com,platform.deepseek.com",
    });
    children.push(router.child);
    await check("routed CONNECT takes the upstream path", async () => {
      const reply = await connectThrough(router.port, "chat.deepseek.com:443");
      assert.match(reply, /200 Connection Established/);
      assert.match(reply, /VIA-UPSTREAM chat\.deepseek\.com:443/);
      assert.ok(
        upstream.seen.includes("CONNECT chat.deepseek.com:443 HTTP/1.1"),
        `upstream saw: ${upstream.seen.join(" | ")}`,
      );
    });

    /* 2. any other host -> direct (never the upstream) */
    await check("non-routed CONNECT tunnels DIRECT and never touches the upstream", async () => {
      const before = upstream.seen.length;
      const reply = await connectThrough(router.port, `127.0.0.1:${echo.port}`);
      assert.match(reply, /200 Connection Established/);
      assert.match(reply, /DIRECT-ECHO/);
      assert.equal(upstream.seen.length, before, "upstream must not see non-routed traffic");
    });

    /* 5. absolute-form HTTP follows the same decision */
    await check("absolute-form HTTP: routed host goes upstream, other host goes direct", async () => {
      const routed = await requestThrough(router.port, "http://chat.deepseek.com/whatever");
      assert.match(routed, /VIA-UPSTREAM http:\/\/chat\.deepseek\.com\/whatever/);
      assert.ok(upstream.seen.includes("GET http://chat.deepseek.com/whatever HTTP/1.1"));
      const direct = await requestThrough(router.port, `http://127.0.0.1:${origin.port}/x`);
      assert.match(direct, /DIRECT-ORIGIN/);
    });

    /* 5b. WebSocket upgrades survive the router (noVNC + the harness event stream
     *     are reached THROUGH this router once the desktop browser is pointed at
     *     it: a proxy that eats upgrades would break the panel it was added for). */
    await check("absolute-form Upgrade (websocket) is relayed, not dropped", async () => {
      const direct = await upgradeThrough(router.port, `http://127.0.0.1:${ws.port}/ws`);
      assert.match(direct, /101 Switching Protocols/);
      assert.match(direct, /WS-ORIGIN/);
      const routed = await upgradeThrough(router.port, "http://chat.deepseek.com/ws");
      assert.ok(
        upstream.seen.includes("GET http://chat.deepseek.com/ws HTTP/1.1"),
        `upstream saw: ${upstream.seen.join(" | ")}`,
      );
      assert.match(routed, /HTTP\/1\.1 200 OK/);
    });

    router.child.kill();
  }

  /* 3. unreachable upstream -> DIRECT fallback (the regression that broke egress) */
  {
    const dead = await freePort();
    const router = await startRouter({
      EGRESS_UPSTREAM: `http://127.0.0.1:${dead}`,
      EGRESS_ROUTE_HOSTS: "127.0.0.1",
      EGRESS_TIMEOUT_MS: "1500",
    });
    children.push(router.child);
    await check("a dead upstream falls back to DIRECT instead of failing the request", async () => {
      const reply = await connectThrough(router.port, `127.0.0.1:${echo.port}`);
      assert.match(reply, /200 Connection Established/);
      assert.match(reply, /DIRECT-ECHO/);
      const log = router.log.join("");
      assert.match(log, /falling back to DIRECT/, `router log: ${log}`);
    });
    router.child.kill();
  }

  /* 4. EGRESS_STRICT=1 -> 502 instead of a fallback */
  {
    const dead = await freePort();
    const router = await startRouter({
      EGRESS_UPSTREAM: `http://127.0.0.1:${dead}`,
      EGRESS_ROUTE_HOSTS: "127.0.0.1",
      EGRESS_STRICT: "1",
      EGRESS_TIMEOUT_MS: "1500",
    });
    children.push(router.child);
    await check("EGRESS_STRICT=1 refuses (502) rather than leaking DIRECT", async () => {
      const reply = await connectThrough(router.port, `127.0.0.1:${echo.port}`);
      assert.match(reply, /502 Bad Gateway/);
      assert.doesNotMatch(reply, /DIRECT-ECHO/);
    });
    router.child.kill();
  }

  /* 6. probe: usable / unusable, with the exit codes the entrypoint reads */
  await check("--probe reports usable (exit 0) against a working upstream", async () => {
    const result = await runProbe(`http://127.0.0.1:${upstream.port}`, "chat.deepseek.com");
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.verdict, "usable");
    assert.equal(report.routes[0].connect, 200);
  });

  await check("--probe reports unusable (exit 2) when the upstream port is closed", async () => {
    const dead = await freePort();
    const result = await runProbe(`http://127.0.0.1:${dead}`, "chat.deepseek.com");
    assert.equal(result.code, 2, `stdout: ${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.verdict, "unusable");
    assert.notEqual(report.tcp, "ok");
  });

  await check("--probe reports CONNECT-refused (exit 3) when the proxy answers 403", async () => {
    const denying = await proxyStub({ status: 403 });
    stubs.push(denying);
    const result = await runProbe(`http://127.0.0.1:${denying.port}`, "chat.deepseek.com");
    assert.equal(result.code, 3, `stdout: ${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).verdict, "upstream-reachable-but-connect-refused");
  });
}

/** Run the router once in --probe --json mode. */
function runProbe(upstreamUrl, routes) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ROUTER, "--probe", "--json"], {
      env: {
        ...process.env,
        EGRESS_UPSTREAM: upstreamUrl,
        EGRESS_ROUTE_HOSTS: routes,
        EGRESS_TIMEOUT_MS: "1500",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("exit", (code) => resolve({ code, stdout: stdout.trim(), stderr }));
  });
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.log(`  FAIL harness — ${error.stack || error.message}`);
} finally {
  for (const child of children) child.kill("SIGKILL");
  for (const stub of stubs) await stub.close().catch(() => {});
}

console.log(`\negress-router: ${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
