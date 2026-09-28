#!/usr/bin/env node
/**
 * seek-harness reverse proxy — the "0.0.0.0 fix" (smanx pattern).
 *
 * DeepSeek Harness' CLI intentionally refuses `--host 0.0.0.0`, so DSH is
 * bound to 127.0.0.1:$DSH_PORT inside the container and this proxy exposes
 * it on $PROXY_HOST:$PROXY_PORT with:
 *   - HTTP + WebSocket forwarding (/api/events.mux, /api/events.host, ...)
 *   - optional HTTP Basic Auth (HTTP *and* WS) when PROXY_USERNAME and
 *     PROXY_PASSWORD are both set
 *   - zero-auth LAN auto-login: the entrypoint captures the token `dsh web`
 *     prints at boot (DSH_TOKEN) and the proxy relays the 303 + session
 *     cookie it returns, so browsers just open the bare URL — no login
 *   - a crypto.randomUUID polyfill injected into served HTML — pages loaded
 *     over a LAN IP are a browser "non-secure context" where randomUUID is
 *     unavailable, which would leave the realtime WS channel pending forever
 *   - Host header rewritten to the loopback authority so DSH's browser-trust
 *     fence treats proxied requests as local (extra authorities can be
 *     whitelisted with DSH_TRUSTED_HOSTS in the entrypoint)
 *
 * Zero npm dependencies. Node >= 18.
 */
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import { timingSafeEqual } from "node:crypto";
// Recovery surface: when the harness cannot boot, no plugin inside it can render
// anything — this proxy is the process that survives, so it serves the failure,
// the profile list and the two fixes (switch profile / Safe Mode).
import { handleRecovery, recoveryPage, recoverySnapshot, wantsRecoveryPage } from "./recovery.mjs";

const PROXY_HOST = process.env.PROXY_HOST || "0.0.0.0";
const PROXY_PORT = parseInt(process.env.PROXY_PORT || "3080", 10);
const DSH_HOST = process.env.DSH_HOST || "127.0.0.1";
const DSH_PORT = parseInt(process.env.DSH_PORT || "3079", 10);
const AUTH_USER = process.env.PROXY_USERNAME || "";
const AUTH_PASS = process.env.PROXY_PASSWORD || "";
const AUTH_ENABLED = AUTH_USER !== "" && AUTH_PASS !== "";
const INJECT_POLYFILL = (process.env.PROXY_INJECT_POLYFILL ?? "1") !== "0";
const MAX_HTML_BUFFER = 8 * 1024 * 1024;
// DSH gates settings editing to loopback pages client-side (settings-scope:
// connection.isLoopback ? "host" : "memory"). For LAN use, rewrite served JS
// so every page gets host persistence. Set PROXY_UNLOCK_REMOTE_SETTINGS=0 to
// keep stock behaviour.
const UNLOCK_SETTINGS = process.env.PROXY_UNLOCK_REMOTE_SETTINGS !== "0";
const MAX_JS_BUFFER = 32 * 1024 * 1024;
// Boot token of `dsh web` (captured from its stdout by the entrypoint).
// Empty = passthrough (plain 401 from DSH reaches the client).
// The entrypoint starts this proxy BEFORE the token is printed, so the token
// is read lazily from a file too (env DSH_TOKEN wins for tests/tools).
const DSH_TOKEN = process.env.DSH_TOKEN || "";
const DSH_TOKEN_FILE = process.env.DSH_TOKEN_FILE || "/tmp/dsh-token";
let _tokenLogged = false;
function getDshToken() {
  if (DSH_TOKEN) return DSH_TOKEN;
  try {
    const t = fs.readFileSync(DSH_TOKEN_FILE, "utf8").trim();
    if (t && !_tokenLogged) {
      _tokenLogged = true;
      console.log("[proxy] zero-auth auto-login enabled (dsh web token loaded)");
    }
    return t;
  } catch {
    return "";
  }
}

// Static, non-sensitive assets are served without auth (smanx behaviour);
// forcing auth here makes browsers spam 401s for <link rel="manifest">.
const AUTH_BYPASS = new Set([
  "/manifest.webmanifest",
  "/favicon.svg",
  "/favicon.ico",
]);

const POLYFILL = `<script>(function(){try{var c=window.crypto||window.msCrypto;if(!c){window.crypto=c={}}if(typeof c.randomUUID!=="function"){c.randomUUID=function(){var b=new Uint8Array(16);if(typeof c.getRandomValues==="function"){c.getRandomValues(b)}else{for(var i=0;i<16;i++){b[i]=Math.floor(Math.random()*256)}}b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var j=0;j<16;j++){h+=(b[j]|256).toString(16).slice(1)}return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}}}catch(e){}})();</script>`;

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function checkAuth(req) {
  if (!AUTH_ENABLED) return true;
  if (AUTH_BYPASS.has(new URL(req.url, "http://x").pathname)) return true;
  const header = req.headers.authorization || "";
  const m = /^Basic (.+)$/i.exec(header);
  if (!m) return false;
  let decoded;
  try {
    decoded = Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  return (
    safeEqual(decoded.slice(0, idx), AUTH_USER) &&
    safeEqual(decoded.slice(idx + 1), AUTH_PASS)
  );
}

function deny(res, upgrade) {
  const body = "401 Unauthorized";
  if (upgrade) {
    res.write(
      "HTTP/1.1 401 Unauthorized\r\n" +
        'WWW-Authenticate: Basic realm="seek-harness"\r\n' +
        "Content-Length: " + body.length + "\r\n" +
        "Connection: close\r\n\r\n" + body
    );
    res.destroy();
  } else {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="seek-harness"',
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }
}

function upstreamUnavailable(res, upgrade, req) {
  // A browser asking for a page while the harness is down gets the recovery
  // screen (boot failure + profile switch + Safe Mode) instead of a bare 502 —
  // this is the one moment where nothing inside the harness can help.
  if (!upgrade && req !== undefined && wantsRecoveryPage(req)) {
    let html;
    try {
      html = recoveryPage(recoverySnapshot(process.env));
    } catch (error) {
      console.log("[recovery] could not render the page:", error && error.message);
    }
    if (html !== undefined) {
      res.writeHead(503, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Retry-After": "3",
        "Content-Length": Buffer.byteLength(html),
      });
      res.end(html);
      return;
    }
  }
  const body = JSON.stringify({
    error: "dsh is not ready yet — reverse proxy is up, upstream starting",
  });
  if (upgrade) {
    res.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    res.destroy();
  } else {
    res.writeHead(502, {
      "Content-Type": "application/json",
      "Retry-After": "2",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }
}

/**
 * Client-boot watchdog, injected into every served HTML document.
 *
 * THE GAP THIS CLOSES: when a profile boots but its BROWSER half cannot compose
 * (a client bundle that fails to parse, a plugin that breaks the module loader),
 * the harness is HEALTHY — `/api/*` answers, the proxy is fine — while the page
 * the user is looking at renders "Failed to load plugins" with no controls at
 * all. The upstream-unavailable path never fires, and the profile switcher cannot
 * render because it is one of the bundles that failed. The user is stuck.
 *
 * So the document itself watches for that: if the harness shell has not taken
 * over the page within a few seconds, or it rendered its plugin-failure screen,
 * we hand off to the recovery surface, which can still switch the profile or boot
 * Safe Mode. The check is deliberately conservative: it only fires when the app
 * clearly did NOT boot, never on a slow-but-working load.
 */
const BOOT_WATCHDOG = `<script>(function(){
  // The recovery page offers "Open the main page anyway": a client-side failure
  // is not always something a profile switch can fix, and being unable to reach
  // the app at all is worse than a degraded one. That flag must survive the
  // navigation, so it is read from the URL and then remembered for this tab.
  try {
    if (/[?&]skipRecovery=1/.test(location.search)) sessionStorage.setItem("dsh-skip-recovery", "1");
    if (sessionStorage.getItem("dsh-skip-recovery") === "1") return;
  } catch (e) {}
  var RECOVERY = "/__recovery/page?from=client";
  var fired = false;
  // The shell renders this card when the composed client bundle aborts. It is the
  // authoritative signal: a FAILED shell must never be mistaken for a working one.
  function failed() {
    var text = (document.body && document.body.innerText) || "";
    return /Failed to load plugins/i.test(text) || /did not activate/i.test(text);
  }
  // A working shell renders the app chrome. Checked only when failure is absent.
  function booted() {
    if (document.querySelector('[class*="footArea"]')) return true;
    if (document.querySelector('[class*="sidebarCol"] button')) return true;
    return document.querySelectorAll("button").length >= 5;
  }
  function handoff(why) {
    if (fired || failed() === false && booted()) return;
    fired = true;
    window.location.replace(RECOVERY + "&reason=" + encodeURIComponent(failed() ? "client-failed" : (why || "client-timeout")));
  }
  // The plugin-failure card can appear as soon as the shell renders it.
  var observer = new MutationObserver(function(){ if (failed()) handoff("client-failed"); });
  try { observer.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
  // Give a healthy shell real time to mount before the timeout path can fire.
  setTimeout(function(){ observer.disconnect(); handoff("client-timeout"); }, 12000);
})();</script>`;

function injectPolyfill(html) {
  const headIdx = html.search(/<head(\s[^>]*)?>/i);
  if (headIdx >= 0) {
    const tagEnd = html.indexOf(">", headIdx);
    if (tagEnd >= 0) {
      return html.slice(0, tagEnd + 1) + POLYFILL + BOOT_WATCHDOG + html.slice(tagEnd + 1);
    }
  }
  return POLYFILL + BOOT_WATCHDOG + html;
}

function pipeSockets(client, upstream, head) {
  client.pipe(upstream);
  upstream.pipe(client);
  if (head && head.length) upstream.write(head);
  const kill = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", kill);
  upstream.on("error", kill);
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
}

// Buffer a text response, run `fn`, and send the (possibly rewritten) body.
function bufferAndRewrite(upRes, res, fn) {
  const parts = [];
  let size = 0;
  upRes.on("data", (c) => { parts.push(c); size += c.length; });
  upRes.on("end", () => {
    if (size > MAX_JS_BUFFER) {
      console.error("[proxy] JS chunk too large to rewrite; aborting");
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("proxy: JS chunk too large to rewrite");
      return;
    }
    const out = fn(Buffer.concat(parts));
    const headers = { ...upRes.headers };
    headers["content-length"] = String(out.length);
    delete headers["content-encoding"];
    delete headers["transfer-encoding"];
    res.writeHead(upRes.statusCode, headers);
    res.end(out);
  });
  upRes.on("error", () => res.destroy());
}

function looksLikeNavigation(req) {
  const sfm = String(req.headers["sec-fetch-mode"] || "");
  if (sfm) return sfm === "navigate";
  return String(req.headers.accept || "").includes("text/html");
}

function forwardToUpstream(req, res, autoAuthTried) {
  const headers = { ...req.headers };
  // Present the loopback authority to DSH so its browser-trust fence and
  // host checks behave as if the request were local.
  headers.host = `${DSH_HOST}:${DSH_PORT}`;
  headers["x-forwarded-host"] = req.headers.host || "";
  headers["x-forwarded-proto"] = "http";
  // Polyfill injection needs plain-text HTML; if DSH compresses the document
  // we cannot regex-inject into gzip/br bytes. Request navigations as identity
  // (non-document assets keep Accept-Encoding and stream through untouched).
  if (looksLikeNavigation(req)) delete headers["accept-encoding"];
  if (UNLOCK_SETTINGS && /\/plugins\/|\.js(?:\?|$)/.test(req.url || "")) {
    delete headers["accept-encoding"]; // JS may need the settings rewrite
  }
  // DSH's /api fence requires browser markers (Origin/Referer) to be same-origin
  // with the authority DSH sees (the rewritten loopback Host). Translate the
  // public authority to the loopback one - but only when the request is
  // same-origin at the public edge (Origin.host === incoming Host).
  // Cross-origin markers (CSRF from another site) pass through untouched so
  // the fence can still reject them.
  const publicHost = req.headers.host || "";
  const originHeader = req.headers.origin;
  if (publicHost && typeof originHeader === "string" && originHeader !== "null") {
    try {
      if (new URL(originHeader).host === publicHost) {
        const internal = `http://${DSH_HOST}:${DSH_PORT}`;
        headers.origin = internal;
        const referer = req.headers.referer;
        if (typeof referer === "string") {
          try {
            const refUrl = new URL(referer);
            if (refUrl.host === publicHost) {
              headers.referer = `${internal}${refUrl.pathname}${refUrl.search}`;
            }
          } catch {}
        }
      }
    } catch {}
  }

  const upstream = http.request(
    { host: DSH_HOST, port: DSH_PORT, method: req.method, path: req.url, headers },
    (upRes) => {
      // Zero-auth LAN mode: `dsh web` answers 401 to navigations without a
      // session. Re-request once with the boot token and relay the 303 +
      // Set-Cookie it returns — the browser gets a session without ever
      // seeing a token. Non-navigations (API/WS clients) keep the plain 401.
      if (
        upRes.statusCode === 401 &&
        !autoAuthTried &&
        getDshToken() &&
        looksLikeNavigation(req)
      ) {
        upRes.resume(); // drain and discard
        const sep = req.url.includes("?") ? "&" : "?";
        const authed = http.request(
          {
            host: DSH_HOST,
            port: DSH_PORT,
            method: req.method,
            path: `${req.url}${sep}token=${encodeURIComponent(getDshToken())}`,
            headers,
          },
          (authRes) => {
            res.writeHead(authRes.statusCode, authRes.headers);
            authRes.pipe(res);
          }
        );
        authed.on("error", (err) => {
          if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET") {
            upstreamUnavailable(res, false, req);
          } else {
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end("502 Bad Gateway");
          }
        });
        authed.end();
        return;
      }
      const ctype = String(upRes.headers["content-type"] || "");
      const isHtml = ctype.toLowerCase().includes("text/html");
      const isJs = /javascript|ecmascript/.test(ctype.toLowerCase());
      // Safety net: never touch a compressed body - stream it through so the
      // client can decode it (polyfill skipped in that rare case).
      const encoded = Boolean(upRes.headers["content-encoding"]);
      if (encoded || (!isHtml && !isJs) || (isHtml && !INJECT_POLYFILL)) {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        return;
      }
      if (isJs) {
        if (!UNLOCK_SETTINGS) {
          res.writeHead(upRes.statusCode, upRes.headers);
          upRes.pipe(res);
          return;
        }
        bufferAndRewrite(upRes, res, (body) => {
          const str = body.toString("utf8");
          // FIX (the dangling-receiver bug, seen again 2026-09-28): the pattern
          // MUST capture the FULL dotted receiver chain. A one-segment pattern
          // (`…$host.isLoopback ? …`) matches inside `ctx.remote.$host.isLoopback
          // ? "host" : "memory"` and replaces only that part, leaving a dangling
          // `ctx.remote.` prefix:
          //
          //   const persistence = ctx.remote."host";     // SyntaxError
          //
          // The client bundle then fails to parse, the entry never registers, and
          // every dependent plugin cascades:
          //   "web boot: 51 entries did not activate"
          // and the browser shows "Failed to load plugins" with no controls. It
          // only reproduces on a COLD load, because a warm browser serves the
          // bundle from cache — which is why it looked like an incognito-only bug.
          const re = /((?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*)\.isLoopback\s*\?\s*["']host["']\s*:\s*["']memory["']/g;
          const hits = str.match(re);
          if (!hits) {
            if (str.includes("isLoopback"))
              console.log("[proxy] WARNING: isLoopback present but settings pattern missed - check upstream shape");
            return body;
          }
          // Prove the rewrite is safe before serving it: a buffer that does not
          // parse must never leave the proxy. Fail OPEN (serve the original) —
          // a locked settings page beats a dead client.
          const rewritten = Buffer.from(str.replace(re, '"host"'), "utf8");
          try {
            new Function(rewritten.toString("utf8"));
          } catch (error) {
            console.log("[proxy] WARNING: settings rewrite would break the bundle — serving the original:", error.message);
            return body;
          }
          console.log("[proxy] unlocked remote settings persistence in served JS");
          return rewritten;
        });
        return;
      }
      // Buffer HTML (small SPA shells), inject the polyfill once.
      const len = parseInt(upRes.headers["content-length"] || "0", 10);
      if (len > MAX_HTML_BUFFER) {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        return;
      }
      const chunks = [];
      let size = 0;
      upRes.on("data", (c) => {
        chunks.push(c);
        size += c.length;
        if (size > MAX_HTML_BUFFER) {
          res.writeHead(upRes.statusCode, upRes.headers);
          for (const ch of chunks) res.write(ch);
          upRes.pipe(res);
          chunks.length = 0;
        }
      });
      upRes.on("end", () => {
        if (!chunks.length) return; // already streamed oversized body
        const html = Buffer.concat(chunks).toString("utf8");
        const patched = injectPolyfill(html);
        const out = Buffer.from(patched, "utf8");
        const headers = { ...upRes.headers };
        delete headers["content-length"];
        delete headers["content-security-policy"]; // inline polyfill needs it
        headers["content-length"] = out.length;
        delete headers["transfer-encoding"];
        res.writeHead(upRes.statusCode, headers);
        res.end(out);
      });
      upRes.on("error", () => {
        if (!res.headersSent) upstreamUnavailable(res, false, req);
        else res.destroy();
      });
    }
  );
  upstream.on("error", (err) => {
    if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET") {
      upstreamUnavailable(res, false, req);
    } else {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("502 Bad Gateway");
    }
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  if (!checkAuth(req, false)) return deny(res, false);
  // The recovery API answers even while DSH is down, so it must be routed before
  // anything else. It needs no writable upstream — only $DSH_HOME.
  handleRecovery(req, res, { log: console.log })
    .then((handled) => { if (!handled) forwardToUpstream(req, res, false); })
    .catch((error) => {
      console.log("[recovery] handler failed:", error && error.message);
      forwardToUpstream(req, res, false);
    });
});

// WebSocket upgrade → raw TCP tunnel (headers pass through untouched,
// incl. the Authorization header already validated above).
server.on("upgrade", (req, socket, head) => {
  if (!checkAuth(req, true)) return deny(socket, true);
  // Same-origin Origin translation for WS handshakes: DSH's /api fence also
  // gates upgrades (browsers attach Origin to them). Translate the public
  // authority to the loopback one only when the handshake is same-origin at
  // the public edge; foreign origins pass through so the fence rejects them.
  let originOverride = null;
  {
    const ph = req.headers.host || "";
    const oh = req.headers.origin;
    if (ph && typeof oh === "string" && oh !== "null") {
      try {
        if (new URL(oh).host === ph) originOverride = `http://${DSH_HOST}:${DSH_PORT}`;
      } catch {}
    }
  }
  const upstream = net.connect(DSH_PORT, DSH_HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const lower = name.toLowerCase();
      const value =
        lower === "origin" && originOverride
          ? originOverride
          : lower === "host"
            ? `${DSH_HOST}:${DSH_PORT}`
            : req.rawHeaders[i + 1];
      lines.push(`${name}: ${value}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    pipeSockets(socket, upstream, head);
  });
  upstream.on("error", (err) => {
    if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET") {
      upstreamUnavailable(socket, true);
    } else {
      socket.destroy();
    }
  });
});

server.listen(PROXY_PORT, PROXY_HOST, () => {
  console.log(
    `[proxy] listening on ${PROXY_HOST}:${PROXY_PORT} -> http://${DSH_HOST}:${DSH_PORT}` +
      (AUTH_ENABLED
        ? " (basic auth ON)"
        : DSH_TOKEN
          ? " (basic auth OFF, zero-auth auto-login)"
          : " (basic auth OFF)")
  );
});
