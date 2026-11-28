#!/usr/bin/env node
/**
 * egress-router.mjs — a LOOPBACK forward proxy that routes a NAMED set of hosts
 * through the operator's proxy and tunnels everything else DIRECT.
 *
 * WHY THIS EXISTS (field report, 2026-11-28)
 * ------------------------------------------
 * `apply_egress_proxy` exported HTTPS_PROXY/HTTP_PROXY/ALL_PROXY to the whole
 * container, because chat.deepseek.com's edge answers a container-egress request
 * with a 403 / 202 non-JSON body and the Platform account surface then fails with
 * `stage: 'parse-json'`. That fixed nothing and broke everything: ONE bad proxy
 * address became the egress path for EVERY outbound socket the harness opens, so
 * every cloud model, every package fetch and the web UI's own upstream calls died
 * with the same error. "The proxy is down" must never mean "the container has no
 * internet".
 *
 * So: never hand the harness a proxy that is responsible for the whole internet.
 * Hand it THIS process on loopback. This process sends the two Platform hosts
 * upstream and never anything else, so:
 *
 *   api.deepseek.com, registry.npmjs.org, everything else  ->  DIRECT (as before)
 *   chat.deepseek.com, platform.deepseek.com               ->  upstream proxy
 *
 * FAIL-SAFE BY CONSTRUCTION
 * -------------------------
 * If the upstream proxy is unreachable, refusing CONNECT, or answering garbage,
 * the routed host falls back to DIRECT for that request (and is logged). The
 * container therefore behaves exactly like `DSH_EGRESS_PROXY` unset — never worse.
 * `EGRESS_STRICT=1` disables the fallback for operators who need a hard guarantee
 * that Platform traffic never leaves through the container's own address.
 *
 * USAGE
 * -----
 *   EGRESS_UPSTREAM=http://host.docker.internal:7890 \
 *     node egress-router.mjs                     # serve on 127.0.0.1:3090
 *   EGRESS_UPSTREAM=... node egress-router.mjs --probe [--json]
 *                                                # exit 0 usable / 3 CONNECT refused
 *                                                # / 2 unreachable — the entrypoint
 *                                                # uses this to decide whether to
 *                                                # export the proxy env at all
 *
 * ENV
 * ---
 *   EGRESS_UPSTREAM       http://user:pass@host:port (or https://) — required
 *   EGRESS_ROUTE_HOSTS    comma list, default chat.deepseek.com,platform.deepseek.com
 *   EGRESS_ROUTER_HOST    127.0.0.1 (never 0.0.0.0: this is an internal hop)
 *   EGRESS_ROUTER_PORT    3090
 *   EGRESS_STRICT         0 = fall back to DIRECT when the upstream fails, 1 = 502
 *   EGRESS_TIMEOUT_MS     20000 — per upstream TCP/CONNECT
 *   EGRESS_VERBOSE        1 = one line per decision, 0 = errors only
 *
 * Zero npm dependencies. Node >= 18.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const DEFAULT_ROUTES = ["chat.deepseek.com", "platform.deepseek.com"];
const argv = process.argv.slice(2);
const PROBE = argv.includes("--probe");
const JSON_OUT = argv.includes("--json");

const PORT = Number(process.env.EGRESS_ROUTER_PORT || 3090);
const HOST = process.env.EGRESS_ROUTER_HOST || "127.0.0.1";
const RAW_UPSTREAM = (process.env.EGRESS_UPSTREAM || "").trim();
const STRICT = (process.env.EGRESS_STRICT || "0") === "1";
const TIMEOUT_MS = Number(process.env.EGRESS_TIMEOUT_MS || 20000);
const VERBOSE = (process.env.EGRESS_VERBOSE ?? "1") !== "0";
const ROUTES = (process.env.EGRESS_ROUTE_HOSTS || DEFAULT_ROUTES.join(","))
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

/**
 * Parse the upstream proxy URL. A bare `host:port` is accepted as http:// —
 * operators paste that form from proxy clients, and refusing it would be a
 * papercut at the exact moment they are debugging egress.
 * @param {string} raw - value from EGRESS_UPSTREAM.
 * @returns {{hostname: string, port: number, tls: boolean, secure: boolean, label: string,
 *   auth: string | null, username: string, password: string} | null} parsed upstream or null.
 */
function parseUpstream(raw) {
  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!url.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const username = decodeURIComponent(url.username || "");
  const password = decodeURIComponent(url.password || "");
  const auth = username ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` : null;
  return {
    hostname: url.hostname.replace(/^\[|\]$/g, ""),
    port,
    tls: url.protocol === "https:",
    secure: url.protocol === "https:",
    label: `${url.hostname}:${port}`,
    auth,
    username: username ? "set" : "unset",
    password: password ? "set" : "unset",
  };
}

const upstream = RAW_UPSTREAM ? parseUpstream(RAW_UPSTREAM) : null;

/** One line on stdout; docker logs are line-oriented. */
function log(line) {
  if (VERBOSE) console.log(`[egress-router] ${line}`);
}

/**
 * Does this hostname take the upstream path?
 * Exact match, or any subdomain of a listed name (`deepseek.com` covers
 * `platform.deepseek.com`). A trailing dot (FQDN form) is normalised away.
 * @param {string} host - hostname from CONNECT/absolute-form.
 * @returns {boolean} true when the host is routed upstream.
 */
function routed(host) {
  const name = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!name) return false;
  return ROUTES.some((pattern) => {
    if (pattern === name) return true;
    if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
    return name.endsWith(`.${pattern}`);
  });
}

/** Attach a hard deadline to a socket; throws a labelled ETIMEDOUT error. */
function arm(socket, ms, what) {
  socket.setTimeout(ms, () => {
    socket.destroy(Object.assign(new Error(`${what} timed out after ${ms} ms`), { code: "ETIMEDOUT" }));
  });
}

/**
 * Read an HTTP response head from a socket, keeping any bytes that arrived after
 * the head (a proxy may pipeline the tunnel's first bytes with its 200).
 * @param {import("node:net").Socket} socket - connected socket.
 * @param {number} ms - deadline.
 * @returns {Promise<{status: number, head: string, rest: Buffer}>} parsed head.
 */
function readHead(socket, ms) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      detach();
      reject(Object.assign(new Error("no response head"), { code: "ETIMEDOUT" }));
    }, ms);
    const detach = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffer.length > 16384) {
          detach();
          reject(Object.assign(new Error("response head too large"), { code: "EPROTO" }));
        }
        return;
      }
      detach();
      const head = buffer.subarray(0, end).toString("latin1");
      const status = Number(head.split(" ")[1] || 0);
      socket.pause();
      resolve({ status, head, rest: buffer.subarray(end + 4) });
    };
    const onError = (error) => {
      detach();
      reject(error);
    };
    const onClose = () => {
      detach();
      reject(Object.assign(new Error("upstream closed the socket"), { code: "ECONNRESET" }));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

/**
 * Open a TCP (or TLS) connection with a deadline and a labelled failure.
 * @param {{hostname: string, port: number, tls?: boolean, secure?: boolean}} target - endpoint.
 * @param {number} ms - connect deadline.
 * @returns {Promise<import("node:net").Socket>} connected socket.
 */
function connectSocket(target, ms) {
  return new Promise((resolve, reject) => {
    const options = { host: target.hostname, port: target.port };
    let socket;
    try {
      socket = target.tls
        ? tls.connect({ ...options, servername: target.hostname })
        : net.connect(options);
    } catch (error) {
      reject(error);
      return;
    }
    const onReady = () => {
      socket.setTimeout(0);
      socket.off("error", onError);
      socket.setNoDelay(true);
      resolve(socket);
    };
    const onError = (error) => {
      socket.destroy();
      reject(error);
    };
    arm(socket, ms, `TCP ${target.hostname}:${target.port}`);
    socket.once(target.tls ? "secureConnect" : "connect", onReady);
    socket.once("error", onError);
  });
}

/**
 * CONNECT through the upstream proxy and hand back the open tunnel.
 * @param {string} host - target host.
 * @param {number} port - target port.
 * @returns {Promise<{socket: import("node:net").Socket, rest: Buffer}>} tunnel.
 */
async function connectViaUpstream(host, port) {
  const socket = await connectSocket(upstream, TIMEOUT_MS);
  let head = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: keep-alive\r\n`;
  if (upstream.auth) head += `Proxy-Authorization: ${upstream.auth}\r\n`;
  head += "\r\n";
  socket.write(head);
  let response;
  try {
    response = await readHead(socket, TIMEOUT_MS);
  } catch (error) {
    socket.destroy();
    throw error;
  }
  if (response.status !== 200) {
    socket.destroy();
    throw Object.assign(new Error(`upstream CONNECT ${host}:${port} -> HTTP ${response.status}`), {
      code: `HTTP_${response.status}`,
      status: response.status,
    });
  }
  return { socket, rest: response.rest };
}

/**
 * Glue the client and the target together after the tunnel is up.
 * @param {import("node:net").Socket} client - the harness's socket.
 * @param {import("node:net").Socket} target - upstream or direct socket.
 * @param {Buffer} rest - bytes already read from the target that belong to the client.
 * @returns {void}
 */
function tunnel(client, target, rest) {
  client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: dsh-egress-router\r\n\r\n");
  if (rest && rest.length) client.write(rest);
  const drop = () => {
    client.destroy();
    target.destroy();
  };
  client.on("error", drop);
  target.on("error", drop);
  client.on("close", drop);
  target.on("close", drop);
  target.pipe(client);
  client.pipe(target);
}

/** Split "host:port" (CONNECT authority form, IPv6 in brackets). */
function splitAuthority(authority) {
  const value = String(authority || "");
  const match = /^\[([^\]]+)\]:(\d+)$/.exec(value) || /^([^:]+):(\d+)$/.exec(value);
  if (match) return { host: match[1], port: Number(match[2]) };
  if (value && !value.includes(":")) return { host: value, port: 443 };
  return null;
}

/** Handle one CONNECT: routed -> upstream, everything else -> direct. */
async function handleConnect(req, client, head) {
  const authority = splitAuthority(req.url);
  if (!authority || !authority.port) {
    client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const { host, port } = authority;
  if (routed(host) && upstream) {
    try {
      const { socket, rest } = await connectViaUpstream(host, port);
      log(`CONNECT ${host}:${port} -> upstream ${upstream.label}`);
      tunnel(client, socket, Buffer.concat([head || Buffer.alloc(0), rest]));
      return;
    } catch (error) {
      const code = error.code || error.message;
      if (STRICT) {
        log(`CONNECT ${host}:${port} -> upstream ${upstream.label} FAILED (${code}) — EGRESS_STRICT=1, refusing`);
        client.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      log(`CONNECT ${host}:${port} -> upstream ${upstream.label} FAILED (${code}) — falling back to DIRECT`);
    }
  }
  try {
    const socket = await connectSocket({ hostname: host, port }, TIMEOUT_MS);
    if (routed(host)) log(`CONNECT ${host}:${port} -> direct (upstream unavailable)`);
    tunnel(client, socket, head);
  } catch (error) {
    log(`CONNECT ${host}:${port} -> direct FAILED (${error.code || error.message})`);
    client.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n`);
  }
}

/** Handle one absolute-form HTTP request (undici/curl use these for plain http). */
function handleRequest(req, res) {
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("egress-router: absolute-form request URI required\n");
    return;
  }
  if (target.protocol !== "http:") {
    res.writeHead(501, { "content-type": "text/plain" });
    res.end("egress-router: https destinations must use CONNECT\n");
    return;
  }
  const headers = { ...req.headers };
  delete headers["proxy-connection"];
  delete headers["proxy-authorization"];
  headers.host = target.host;
  const viaUpstream = routed(target.hostname) && upstream;
  const options = viaUpstream
    ? {
        host: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: target.href,
        headers: upstream.auth ? { ...headers, "proxy-authorization": upstream.auth } : headers,
      }
    : {
        host: target.hostname,
        port: Number(target.port || 80),
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
      };
  const request = (viaUpstream && upstream.tls ? https : http).request(options, (response) => {
    if (viaUpstream) log(`HTTP ${req.method} ${target.origin}${target.pathname} -> upstream ${upstream.label} (${response.statusCode})`);
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  request.setTimeout(TIMEOUT_MS, () => request.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
  request.on("error", (error) => {
    log(`HTTP ${req.method} ${target.origin} FAILED (${error.code || error.message})`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`egress-router: ${error.code || error.message}\n`);
  });
  req.pipe(request);
}

/**
 * Handle a WebSocket/Upgrade request. A forward proxy that drops these does not
 * merely break a websocket: pointing the desktop browser at the router would
 * take the noVNC panel and the harness UI's own event streams down with it. The
 * bytes are relayed verbatim after the request head, so the handshake and the
 * frames that follow are untouched.
 */
async function handleUpgrade(req, client, head) {
  let target;
  try {
    target = new URL(req.url);
  } catch {
    client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  if (target.protocol !== "http:") {
    client.end("HTTP/1.1 501 Not Implemented\r\n\r\n");
    return;
  }
  const viaUpstream = routed(target.hostname) && upstream;
  const lines = [
    `${req.method} ${viaUpstream ? target.href : `${target.pathname}${target.search}`} HTTP/1.1`,
    `Host: ${target.host}`,
  ];
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.startsWith("proxy-")) continue;
    if (name === "host") continue;
    lines.push(`${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
  }
  if (viaUpstream && upstream.auth) lines.push(`Proxy-Authorization: ${upstream.auth}`);
  let socket;
  try {
    socket = viaUpstream
      ? await connectSocket(upstream, TIMEOUT_MS)
      : await connectSocket({ hostname: target.hostname, port: Number(target.port || 80) }, TIMEOUT_MS);
  } catch (error) {
    log(`UPGRADE ${target.origin}${target.pathname} FAILED (${error.code || error.message})`);
    client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    return;
  }
  log(`UPGRADE ${target.origin}${target.pathname} -> ${viaUpstream ? `upstream ${upstream.label}` : "direct"}`);
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  if (head && head.length) socket.write(head);
  const drop = () => {
    client.destroy();
    socket.destroy();
  };
  client.on("error", drop);
  socket.on("error", drop);
  client.on("close", drop);
  socket.on("close", drop);
  socket.pipe(client);
  client.pipe(socket);
}

/* ------------------------------------------------------------------ probe */

/** TCP reachability of the upstream proxy. */
function tcpProbe(target, ms) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = net.connect({ host: target.hostname, port: target.port });
    } catch (error) {
      resolve({ ok: false, code: error.code || "ECONNREFUSED", message: error.message });
      return;
    }
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    arm(socket, ms, `TCP ${target.hostname}:${target.port}`);
    socket.once("connect", () => finish({ ok: true, code: "ok" }));
    socket.once("error", (error) => finish({ ok: false, code: error.code || "ECONNREFUSED", message: error.message }));
  });
}

/**
 * Probe the upstream once and report, per routed host, whether CONNECT succeeds.
 * Exit codes: 0 usable, 3 upstream TCP ok but CONNECT refused for every route,
 * 2 unusable (no upstream, unparseable, or TCP unreachable).
 */
async function runProbe() {
  const report = {
    upstream: RAW_UPSTREAM || null,
    target: upstream ? upstream.label : null,
    tcp: null,
    detail: null,
    routes: [],
    verdict: "unusable",
  };
  let code = 2;
  if (!upstream) {
    report.detail = RAW_UPSTREAM ? "EGRESS_UPSTREAM is not an http(s) proxy URL" : "EGRESS_UPSTREAM is not set";
  } else if (upstream.hostname === HOST && upstream.port === PORT && PORT !== 0) {
    report.detail = "EGRESS_UPSTREAM points at this router (loop)";
  } else {
    const tcp = await tcpProbe(upstream, Math.min(TIMEOUT_MS, 8000));
    report.tcp = tcp.ok ? "ok" : tcp.code;
    report.detail = tcp.ok ? null : tcp.message || null;
    if (tcp.ok) {
      let reachable = 0;
      for (const host of ROUTES) {
        try {
          const { socket } = await connectViaUpstream(host, 443);
          socket.destroy();
          report.routes.push({ host, connect: 200 });
          reachable += 1;
        } catch (error) {
          report.routes.push({ host, connect: error.status || error.code || "error" });
        }
      }
      if (reachable > 0) {
        report.verdict = "usable";
        code = 0;
      } else {
        report.verdict = "upstream-reachable-but-connect-refused";
        code = 3;
      }
    }
  }
  if (JSON_OUT) {
    console.log(JSON.stringify(report));
  } else {
    console.error(`egress-router probe: upstream=${report.target || "(unset)"} tcp=${report.tcp || "n/a"}${report.detail ? ` (${report.detail})` : ""}`);
    for (const route of report.routes) console.error(`egress-router probe: ${route.host}:443 CONNECT ${route.connect}`);
    console.error(`egress-router probe: verdict=${report.verdict}`);
  }
  process.exit(code);
}

/* ------------------------------------------------------------------- main */

if (PROBE) {
  await runProbe();
}

if (RAW_UPSTREAM && !upstream) {
  console.error(`egress-router: EGRESS_UPSTREAM is not an http(s) proxy URL: ${RAW_UPSTREAM}`);
  process.exit(2);
}
if (upstream && upstream.hostname === HOST && upstream.port === PORT && PORT !== 0) {
  console.error(`egress-router: EGRESS_UPSTREAM points at this router (${HOST}:${PORT}) — refusing a loop`);
  process.exit(2);
}

const server = http.createServer((req, res) => handleRequest(req, res));
server.on("connect", (req, client, head) => {
  handleConnect(req, client, head).catch((error) => {
    log(`CONNECT ${req.url} crashed: ${error.message}`);
    client.destroy();
  });
});
server.on("upgrade", (req, client, head) => {
  handleUpgrade(req, client, head).catch((error) => {
    log(`UPGRADE ${req.url} crashed: ${error.message}`);
    client.destroy();
  });
});
server.on("clientError", (error, socket) => {
  log(`client error: ${error.code || error.message}`);
  socket.destroy();
});
server.on("error", (error) => {
  console.error(`egress-router: cannot listen on ${HOST}:${PORT}: ${error.code || error.message}`);
  process.exit(2);
});
server.listen(PORT, HOST, () => {
  // The actual port matters when EGRESS_ROUTER_PORT=0: the tests pick a free
  // port that way instead of racing a fixed one.
  const actual = server.address().port;
  log(`listening on ${HOST}:${actual} — routes [${ROUTES.join(", ")}] -> ${upstream ? upstream.label : "(none: DIRECT)"}, everything else direct${STRICT ? ", STRICT" : ""}`);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
