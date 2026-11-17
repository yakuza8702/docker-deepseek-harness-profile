#!/usr/bin/env node
/**
 * cua-vnc-clip.mjs — the noVNC live view for a Windows computer, with a working
 * clipboard, and NOTHING preinstalled.
 *
 * WHY THIS FILE EXISTS
 *   The live view is `websockify + noVNC` on loopback. For a Windows guest that
 *   is a half-truth: QEMU's built-in VNC server accepts a ClientCutText from
 *   noVNC and drops it, because the guest runs no clipboard agent. A human who
 *   pastes gets the OLD clipboard; a human who copies gets nothing back.
 *
 *   The guest DOES have a clipboard agent now (docker/cua-clip-agent.ps1, task
 *   `cua-clip-agent`, interactive session), and the supervisor exposes it as two
 *   control-socket ops: `vmWindowsClipboardGet` / `vmWindowsClipboardSet`. This
 *   process is the RFB <-> control-socket adaptor, so a paste in noVNC lands in
 *   the guest and a copy in the guest appears in noVNC.
 *
 * WHAT IT REPLACES
 *   It IS the websockify for that port when the caller starts it: static files
 *   (`--web /usr/share/novnc`), the WebSocket handshake, the TCP client to the
 *   QEMU VNC port, and the RFB framing in between. One process, no pip, no
 *   external `websockify`, so a slim image can ship the live view without a
 *   Python runtime. The caller falls back to websockify if this fails to bind —
 *   that decision lives there, not here.
 *
 * THE CONTRACT (locked, and the reason each rule exists)
 *   1. Handshake + framing: `Sec-WebSocket-Accept` = base64(sha1(key + GUID));
 *      continuation frames (opcode 0x0) are reassembled before anything is
 *      inspected — noVNC can split a large paste, and a half-frame must never be
 *      read as a message type.
 *   2. INTERCEPTION, NOT FORWARDING. A ClientCutText (opcode 0x2, byte 0 = 0x06)
 *      is NOT forwarded to QEMU: QEMU would accept and drop it, and forwarding
 *      would make the guest's stale clipboard look like a successful paste. It
 *      is debounced 150 ms (a paste into a form fires one event per paste, but a
 *      browser can fire several) and written through the control socket. A
 *      control-socket failure is logged ONCE (`clip-write-failed`) and the RFB
 *      connection STAYS UP: the screen still works, only the paste does not.
 *   3. INJECTION is polled, not promised: `vmWindowsClipboardGet` every
 *      `--poll-ms`, and text is pushed to the browser only after TWO CONSECUTIVE
 *      IDENTICAL reads of a seq that changed. One read can be a clipboard caught
 *      mid-write; forwarding it would paste a truncated string into the other
 *      side and then "correct" it. noVNC handles each WS binary message as one
 *      RFB server message, so this sends `ServerCutText` frames directly — no
 *      FramebufferUpdate parsing anywhere in this file.
 *   4. UNICODE: the panel Clipboard path (`vmWindowsClipboardSet` over SSH with a
 *      UTF-8 file) is AUTHORITATIVE for CJK/emoji. RFB's ServerCutText is a byte
 *      string; this file sends latin1 when the text round-trips exactly and
 *      UTF-8 bytes (with `stats.encoding = 'utf-8'`, once) when it does not.
 *      noVNC's decoder is allowed to disagree with us on the mojibake; the panel
 *      path is the one that is right, and the header of the generated frame says
 *      so instead of silently mangling.
 *   5. LIMITS: `--max-chars` (default 262144) and 1 MiB of bytes; NULs are
 *      stripped (RFB and the Windows clipboard both treat a NUL as end-of-text,
 *      and a truncation at a random byte is a bug report). Oversized input is
 *      refused and counted, never truncated into a false success.
 *   6. LIFECYCLE: SIGTERM closes listeners and sockets and exits 0. A missing
 *      `--web` directory is not an error: the process is a WS-only bridge then
 *      (`kind: 'novnc-clip-bare'`), which is exactly what an image without noVNC
 *      needs when the caller serves the static files from elsewhere.
 *
 * WHAT IT NEVER DOES
 *   No disk writes (static files are read-only reads; nothing is logged to a
 *   file, only to stderr), no dependencies outside node:http, node:crypto,
 *   node:net, node:fs, node:path, no outbound connection except the VNC port it
 *   was told to use and the control socket it was told to use.
 *
 * CLI
 *   --http-port 127.0.0.1:6080      listen (LOOPBACK ONLY, refused otherwise)
 *   --vnc-port  127.0.0.1:5931      the QEMU VNC port (loopback only)
 *   --web       /usr/share/novnc    static root; missing => WS-only
 *   --control-sock /tmp/cua-vm/supervisor.sock
 *   --name      <vm>                the computer whose clipboard this is
 *   --poll-ms   1200                clipboard poll interval
 *   --max-chars 262144              per-direction text cap
 */

import { createServer as createHttpServer } from 'node:http'
import { connect as tcpConnect, isIP } from 'node:net'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { extname, normalize, resolve, sep } from 'node:path'

/** The WebSocket magic string from RFC 6455 §1.3. */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 262144 characters and 1 MiB of bytes: the two caps, named once. */
const MAX_MESSAGE_CHARS = 262144
const MAX_MESSAGE_BYTES = 1024 * 1024
/** A paste can fire more than once; 150 ms collapses them into one write. */
const SET_DEBOUNCE_MS = 150

// ---------------------------------------------------------------------------
// PURE HELPERS — exported so the tests can pin the wire format without a socket
// ---------------------------------------------------------------------------

/**
 * The handshake answer: base64(sha1(key + WS_GUID)).
 * @param {string} key the client's `Sec-WebSocket-Key`
 * @returns {string}
 */
export function wsAccept(key) {
  return createHash('sha1').update(String(key ?? '') + WS_GUID).digest('base64')
}

/**
 * Is this complete RFB message a ClientCutText (type 6)?
 *
 * The check is deliberately narrow — first byte, and the 8-byte header that
 * carries the length — because everything else in this file is a passthrough:
 * a false positive here would swallow a real RFB message.
 * @param {Buffer|Uint8Array} frame
 * @returns {boolean}
 */
export function isClientCutText(frame) {
  return Boolean(frame) && frame.length >= 8 && frame[0] === 0x06
}

/**
 * Parse a ClientCutText: type(1) padding(3) length(4, big-endian) text`.
 *
 * DECODING IS REVERSIBLE-ONLY. Bytes that are valid UTF-8 are read as UTF-8
 * (noVNC's own paste path emits UTF-8 for non-Latin-1 text); anything else is
 * read as latin1, which cannot fail. The result is always a string a JS caller
 * can hand to the guest without losing a code unit on the Latin-1 path.
 * @param {Buffer|Uint8Array} frame
 * @returns {{ text: string, length: number }}
 */
export function parseClientCutText(frame) {
  if (!frame || frame.length < 8) throw new Error('ClientCutText needs at least the 8-byte header')
  const length = frame.readUInt32BE(4)
  const body = Buffer.from(frame.subarray(8, 8 + length))
  return { text: decodeReversible(body), length }
}

/**
 * A ServerCutText frame: type(3) padding(3) length(4, big-endian) text.
 *
 * `length` is the LENGTH OF THE BYTES WE SEND, not of the JS string — the two
 * differ for non-latin1 text, and a header that disagrees with its payload makes
 * noVNC read the next message out of the middle of this one.
 * @param {string} text
 * @returns {Buffer}
 */
/** The 8-byte RFB header in front of already-encoded text bytes. */
function frameFromBytes(encoded) {
  const header = Buffer.alloc(8)
  header[0] = 0x03
  header[1] = 0x00
  header[2] = 0x00
  header[3] = 0x00
  header.writeUInt32BE(encoded.length, 4)
  return Buffer.concat([header, encoded])
}

export function serverCutTextFrame(text) {
  return frameFromBytes(encodeCutText(text))
}

/**
 * Text -> bytes for RFB, carrying its own encoding label.
 *
 * latin1 is used ONLY when every code point fits in one byte, i.e. when the
 * decode on the other side can reproduce the string exactly. Everything else
 * (CJK, emoji, combining marks above 0xFF) becomes UTF-8 and says so through
 * `bytes.encoding = 'utf-8'` — a Buffer with one extra property, so the return
 * value stays something `socket.write()` and `Buffer.concat()` accept.
 * @param {string} text
 * @returns {Buffer & { encoding: 'latin1'|'utf-8' }}
 */
export function encodeCutText(text) {
  const source = stripNul(text)
  let latin1 = true
  for (const char of source) {
    if (char.codePointAt(0) > 0xff) {
      latin1 = false
      break
    }
  }
  const bytes = latin1 ? Buffer.from(source, 'latin1') : Buffer.from(source, 'utf8')
  bytes.encoding = latin1 ? 'latin1' : 'utf-8'
  return bytes
}

/** Remove NULs: both the RFB wire and the Windows clipboard stop at one. */
function stripNul(text) {
  return String(text ?? '').replace(/\u0000/gu, '')
}

/**
 * UTF-8 when the bytes are valid UTF-8, latin1 otherwise. `TextDecoder` with
 * `fatal: true` is the only way to ask "is this really UTF-8?" without a
 * hand-written validator.
 */
function decodeReversible(bytes) {
  if (bytes.length === 0) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return bytes.toString('latin1')
  }
}

/** `host:port` / `port` -> { host, port }, with a loopback-only policy. */
export function parseEndpoint(value, fallbackHost, label) {
  const raw = String(value ?? '').trim()
  if (raw === '') throw new Error(`${label} is required`)
  const colon = raw.lastIndexOf(':')
  const host = colon === -1 ? fallbackHost : raw.slice(0, colon)
  const portText = colon === -1 ? raw : raw.slice(colon + 1)
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${label} is not a port: ${raw}`)
  return { host: normaliseLoopbackHost(host, label), port }
}

/**
 * LOOPBACK ONLY, AND THAT IS THE SECURITY MODEL.
 *
 * The bridge carries a clipboard between a browser and a Windows desktop; it
 * has no authentication of its own. `0.0.0.0` would publish that to the LAN, so
 * a non-loopback bind is refused at startup instead of quietly honoured.
 */
export function normaliseLoopbackHost(host, label = 'host') {
  const value = String(host ?? '').trim().replace(/^\[|\]$/gu, '')
  if (value === '' || value === 'localhost') return '127.0.0.1'
  if (value === '::1') return '::1'
  if (isIP(value) === 4 && value.startsWith('127.')) return value
  throw new Error(`${label} must be a loopback address (got "${value}"); this bridge has no authentication`)
}

/** The default mime table for the handful of file types noVNC ships. */
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
})

// ---------------------------------------------------------------------------
// THE BRIDGE
// ---------------------------------------------------------------------------

/**
 * Start the static server + WebSocket server + VNC client + clipboard poller.
 *
 * @param {object} options
 * @param {string} options.httpPort      `127.0.0.1:<p>` (the WS listen address)
 * @param {string} options.vncPort       `127.0.0.1:<v>` (QEMU's VNC)
 * @param {string} [options.web]         static root, or '' for WS-only
 * @param {string} options.controlSock   the supervisor's unix socket
 * @param {string} options.name          the computer name
 * @param {number} [options.pollMs]      clipboard poll (default 1200)
 * @param {number} [options.maxChars]    per-direction cap (default 262144)
 * @param {(line: string) => void} [options.log]
 * @returns {{ url: string, kind: string, close: () => Promise<void>, stats: object }}
 */
export function startClipboardBridge(options = {}) {
  const endpoint = parseEndpoint(options.httpPort, '127.0.0.1', '--http-port')
  const vnc = parseEndpoint(options.vncPort, '127.0.0.1', '--vnc-port')
  const controlSock = String(options.controlSock ?? '').trim()
  const name = String(options.name ?? '').trim()
  const pollMs = Math.max(100, Number(options.pollMs) || 1200)
  const maxChars = Math.max(1, Number(options.maxChars) || MAX_MESSAGE_CHARS)
  const web = String(options.web ?? '').trim()
  const log = typeof options.log === 'function' ? options.log : (line) => process.stderr.write(`[cua-vnc-clip] ${line}\n`)

  if (!name) throw new Error('--name is required (the computer whose clipboard this is)')
  if (!controlSock) throw new Error('--control-sock is required (the supervisor socket)')

  const stats = {
    sent: 0,          // RFB messages client -> guest (everything except a paste)
    recv: 0,          // RFB messages guest -> client (the screen)
    injected: 0,      // ServerCutText frames pushed into the browser
    skipped: 0,       // clipboard reads that were refused, oversized or an echo
    lastSeq: null,    // the last seq the browser was given
    encoding: 'latin1', // what the last injected frame used
    errors: 0         // counted, never fatal
  }

  /** Set once a web root exists; `null` = static serving is off. */
  let webRoot = null
  let httpServer = null
  let pollTimer = null
  let closed = false

  /** The single live WebSocket client (noVNC opens one), plus its TCP peer. */
  const clients = new Set()
  /**
   * EVERY accepted TCP socket, upgraded or not. `httpServer.close()` waits for
   * open connections, and a socket that connected but never sent an Upgrade (a
   * port probe, a half-open noVNC tab) is exactly the kind that keeps SIGTERM
   * waiting forever. These are destroyed on close, so the close is bounded.
   */
  const sockets = new Set()

  // ----- control socket ----------------------------------------------------
  /** One JSON line in, one JSON line out; a short timeout, never a hang. */
  function control(op, payload = {}, timeoutMs = 4000) {
    return new Promise((resolvePromise) => {
      let settled = false
      const socket = tcpConnect(controlSock)
      let buffer = ''
      const done = (value) => {
        if (settled) return
        settled = true
        try { socket.destroy() } catch {}
        resolvePromise(value)
      }
      const timer = setTimeout(() => done({ ok: false, error: `control socket timeout after ${timeoutMs} ms` }), timeoutMs)
      timer.unref?.()
      socket.on('connect', () => socket.write(`${JSON.stringify({ op, name, ...payload })}\n`))
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const newline = buffer.indexOf('\n')
        if (newline === -1) return
        clearTimeout(timer)
        try {
          done(JSON.parse(buffer.slice(0, newline)))
        } catch {
          done({ ok: false, error: 'control socket answered a line that is not JSON' })
        }
      })
      socket.on('error', (error) => {
        clearTimeout(timer)
        done({ ok: false, error: error?.message ?? String(error) })
      })
      socket.on('close', () => {
        clearTimeout(timer)
        done({ ok: false, error: 'control socket closed without an answer' })
      })
    })
  }

  // ----- clipboard: guest -> browser --------------------------------------
  let pendingSeq = null        // a seq seen once, waiting for its second read
  let pendingText = null
  let lastInjectedText = null  // an echo of our own paste must not bounce back
  let lastWriteFailed = false  // log `clip-write-failed` once, not once per poll

  async function pollClipboard() {
    if (closed) return
    const answer = await control('vmWindowsClipboardGet')
    if (!answer || answer.ok !== true) {
      // Not ready, no SSH, a task that did not run: all normal states, none of
      // them worth a log line per poll. The RFB stream is untouched.
      return
    }
    const raw = String(answer.text ?? '')
    const text = stripNul(raw)
    // The backend reports `seq` when the guest's clip-state.json has one; a
    // backend without it still has to be deduplicated, so the content hash is
    // the fallback identity. Both are stable across identical reads.
    const seq = Number.isFinite(Number(answer.seq))
      ? Number(answer.seq)
      : createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16)

    if (seq !== pendingSeq) {
      // FIRST READ OF A NEW SEQ: remember it, forward nothing yet.
      pendingSeq = seq
      pendingText = text
      return
    }
    if (text !== pendingText) {
      // The same seq answered differently twice: it is mid-write. Re-arm.
      pendingSeq = seq
      pendingText = text
      return
    }
    if (seq === stats.lastSeq) return
    stats.lastSeq = seq
    if (text === '') return
    if (text === lastInjectedText) {
      stats.skipped += 1
      return
    }
    if (text.length > maxChars || Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
      stats.skipped += 1
      stats.errors += 1
      log(`clip-inject-skipped: ${text.length} chars / ${Buffer.byteLength(text, 'utf8')} bytes is over the cap`)
      return
    }
    // Encode ONCE: the header length and the payload have to agree, and the
    // encoding label is a property of these exact bytes.
    const encoded = encodeCutText(text)
    const frame = frameFromBytes(encoded)
    const encoding = encoded.encoding
    let delivered = 0
    for (const client of clients) {
      if (client.ready !== true) continue
      wsSendFrame(client.socket, 0x2, frame)
      delivered += 1
    }
    if (delivered === 0) return
    stats.injected += 1
    if (encoding === 'utf-8' && stats.encoding !== 'utf-8') {
      // ONCE per process: the panel path is the one that is authoritative for
      // non-latin1 text (see the header), and this is the line that says so.
      stats.encoding = 'utf-8'
      log('clip-inject-encoding: utf-8 bytes (RFB has no charset; the panel Clipboard path is authoritative for unicode)')
    }
    lastInjectedText = text
  }

  // ----- clipboard: browser -> guest --------------------------------------
  let debounceTimer = null
  let queuedText = null

  function queueSet(text) {
    queuedText = stripNul(text)
    if (!queuedText) return
    if (queuedText.length > maxChars || Buffer.byteLength(queuedText, 'utf8') > MAX_MESSAGE_BYTES) {
      stats.skipped += 1
      stats.errors += 1
      log(`clip-set-skipped: ${queuedText.length} chars is over the cap`)
      return
    }
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      const payload = queuedText
      queuedText = null
      if (payload === null) return
      control('vmWindowsClipboardSet', { text: payload }).then((answer) => {
        if (answer && answer.ok === true) {
          lastWriteFailed = false
          lastInjectedText = payload  // do not bounce our own paste back
          return
        }
        stats.errors += 1
        if (lastWriteFailed) return
        lastWriteFailed = true
        // ONE line per failure streak, and the RFB connection is NOT closed:
        // the screen still works, only this paste did not land.
        log(`clip-write-failed: ${answer?.error ?? answer?.reason ?? 'the supervisor refused the write'} (the live view stays connected)`)
      })
    }, SET_DEBOUNCE_MS)
    debounceTimer.unref?.()
  }

  // ----- WebSocket framing -------------------------------------------------
  function wsSendFrame(socket, opcode, payload) {
    if (socket.destroyed || !socket.writable) return
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '')
    const length = body.length
    let header
    if (length < 126) {
      header = Buffer.alloc(2)
      header[1] = length
    } else if (length < 65536) {
      header = Buffer.alloc(4)
      header[1] = 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[1] = 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    header[0] = 0x80 | opcode // FIN + opcode: one message per frame
    try {
      socket.write(Buffer.concat([header, body]))
    } catch (error) {
      stats.errors += 1
      log(`ws-write-failed: ${error?.message ?? error}`)
    }
  }

  /**
   * Read as many complete WebSocket frames as the buffer holds.
   *
   * Framing is handled to the byte: masked payloads are unmasked in place,
   * fragmented messages (opcode 0x0 continuation) are joined with their initial
   * frame before the caller sees them, and a text/binary payload becomes ONE
   * RFB message. Control frames (0x8/0x9/0xA) are answered here and never
   * forwarded — they are WebSocket's own layer, not RFB's.
   */
  function pumpFrames(client) {
    for (;;) {
      const buffer = client.buffer
      if (buffer.length < 2) return
      const first = buffer[0]
      const second = buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        const big = buffer.readBigUInt64BE(2)
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
          client.socket.destroy()
          return
        }
        length = Number(big)
        offset = 10
      }
      // A header claiming a gigabyte is a malformed frame, not a paste.
      if (length > 8 * MAX_MESSAGE_BYTES) {
        stats.errors += 1
        client.socket.destroy()
        return
      }
      if (buffer.length < offset + (masked ? 4 : 0) + length) return
      let maskKey = null
      if (masked) {
        maskKey = buffer.subarray(offset, offset + 4)
        offset += 4
      }
      const payload = Buffer.from(buffer.subarray(offset, offset + length))
      if (maskKey) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4]
      }
      client.buffer = buffer.subarray(offset + length)

      if (opcode === 0x08) {
        // Close: echo an empty close and let 'close' do the cleanup.
        try { client.socket.end(Buffer.from([0x88, 0x00])) } catch {}
        return
      }
      if (opcode === 0x09) {
        wsSendFrame(client.socket, 0x0a, payload) // ping -> pong, same payload
        continue
      }
      if (opcode === 0x0a) continue // an unsolicited pong: nothing to do

      if (opcode === 0x00) {
        if (!client.fragmentOpcode) continue
        client.fragments.push(payload)
        if (!fin) continue
        const message = Buffer.concat(client.fragments)
        const messageOpcode = client.fragmentOpcode
        client.fragments = []
        client.fragmentOpcode = 0
        handleMessage(client, messageOpcode, message)
        continue
      }
      if (!fin) {
        client.fragmentOpcode = opcode
        client.fragments = [payload]
        continue
      }
      handleMessage(client, opcode, payload)
    }
  }

  /**
   * One complete message, already reassembled.
   *
   * Binary/text from the browser is RFB. A paste is intercepted; everything else
   * is written to the VNC socket byte-for-byte (the original opcode does not
   * matter to QEMU — it reads a byte stream).
   */
  function handleMessage(client, opcode, message) {
    if (client.vnc === null) {
      // noVNC can send its first messages before the VNC connect finished.
      client.pendingVnc.push(message)
      return
    }
    if (isClientCutText(message)) {
      try {
        const { text } = parseClientCutText(message)
        queueSet(text)
      } catch (error) {
        stats.errors += 1
        log(`clip-parse-failed: ${error?.message ?? error}`)
      }
      return
    }
    stats.sent += 1
    try {
      client.vnc.write(message)
    } catch (error) {
      stats.errors += 1
      log(`vnc-write-failed: ${error?.message ?? error}`)
    }
  }

  // ----- static files ------------------------------------------------------
  /** Serve `--web` with no traversal: the resolved path must stay inside root. */
  async function serveStatic(request, response, webDir) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      response.writeHead(400).end('bad request')
      return
    }
    if (pathname === '/' || pathname === '') pathname = '/vnc.html'
    const target = resolve(webDir, `.${normalize(pathname)}`)
    if (target !== webDir && !target.startsWith(webDir + sep)) {
      response.writeHead(403).end('forbidden')
      return
    }
    try {
      const info = statSync(target)
      if (!info.isFile()) throw new Error('not a file')
      const body = await readFile(target)
      response.writeHead(200, {
        'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-cache'
      })
      response.end(body)
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
    }
  }

  // ----- wiring ------------------------------------------------------------
  httpServer = createHttpServer((request, response) => {
    if (webRoot === null) {
      // WS-only mode: no static tree, so a browser GET is an honest 404 that
      // says what to do instead of a directory listing or a hang.
      response
        .writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        .end('cua-vnc-clip is running without a web root (--web was not a readable directory); connect to /websockify\n')
      return
    }
    serveStatic(request, response, webRoot).catch((error) => {
      log(`static-failed: ${error?.message ?? error}`)
      try { response.writeHead(500).end('error') } catch {}
    })
  })

  httpServer.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
  })

  httpServer.on('upgrade', (request, socket, head) => {
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string' || key === '') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    const lines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${wsAccept(key)}`,
      // noVNC asks for `binary`; answering it keeps some clients from falling
      // back to base64 text framing.
      'Sec-WebSocket-Protocol: binary',
      '', ''
    ]
    socket.write(lines.join('\r\n'))
    socket.setNoDelay?.(true)

    const client = {
      socket,
      buffer: head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0),
      fragments: [],
      fragmentOpcode: 0,
      pendingVnc: [],
      vnc: null,
      ready: true
    }
    clients.add(client)

    const vncSocket = tcpConnect({ host: vnc.host, port: vnc.port })
    vncSocket.setNoDelay?.(true)
    vncSocket.on('connect', () => {
      client.vnc = vncSocket
      for (const frame of client.pendingVnc) {
        try { vncSocket.write(frame) } catch {}
      }
      client.pendingVnc = []
    })
    vncSocket.on('data', (chunk) => {
      stats.recv += 1
      wsSendFrame(socket, 0x2, chunk)
    })
    vncSocket.on('error', (error) => {
      stats.errors += 1
      log(`vnc-connect-failed: ${error?.message ?? error}`)
      client.ready = false
      try { socket.end() } catch {}
    })
    vncSocket.on('close', () => {
      client.ready = false
      try { socket.end() } catch {}
    })

    socket.on('data', (chunk) => {
      client.buffer = Buffer.concat([client.buffer, chunk])
      pumpFrames(client)
    })
    const cleanup = () => {
      client.ready = false
      clients.delete(client)
      try { vncSocket.destroy() } catch {}
    }
    socket.on('close', cleanup)
    socket.on('error', () => cleanup())
    // Whatever arrived with the upgrade request (a client that sent a frame
    // inside the same packet) is parsed only after the handlers exist.
    pumpFrames(client)
  })

  httpServer.on('error', (error) => {
    // A bind failure is the caller's fallback trigger, not a crash: log and let
    // `close()` be idempotent. The caller decides to use websockify instead.
    stats.errors += 1
    log(`http listen failed: ${error?.message ?? error}`)
  })

  // `--web` IS OPTIONAL, AND `kind` IS READ SYNCHRONOUSLY. A caller decides
  // between this and websockify from the returned object, so the probe cannot
  // be a promise: an async probe would hand back `kind: 'novnc-clip'` for a
  // directory that does not exist and the caller would serve 404s forever.
  if (web !== '') {
    try {
      if (statSync(resolve(web)).isDirectory()) webRoot = resolve(web)
    } catch {}
  }
  let boundPort = endpoint.port
  httpServer.on('listening', () => {
    const address = httpServer.address()
    if (address && typeof address === 'object') boundPort = address.port
  })
  httpServer.listen(endpoint.port, endpoint.host)

  const bridge = {
    get url() {
      const host = endpoint.host === '::1' ? '[::1]' : endpoint.host
      return `http://${host}:${boundPort}/`
    },
    // 'novnc-clip' = static + WS, 'novnc-clip-bare' = WS only (no --web, or the
    // directory is missing). The caller reports this instead of pretending.
    kind: webRoot === null ? 'novnc-clip-bare' : 'novnc-clip',
    // Resolves once the listener is up, so a caller can log the REAL port (a
    // `:0` request gets an ephemeral one). Not part of the locked shape; it is
    // additive and nothing requires it.
    ready: new Promise((resolveReady) => {
      if (httpServer.listening) resolveReady()
      else httpServer.once('listening', resolveReady)
      httpServer.once('error', resolveReady)
    }),
    stats,
    /** Idempotent: SIGTERM, an uncaught error path, and a test all call this. */
    async close() {
      if (closed) return
      closed = true
      if (pollTimer) clearInterval(pollTimer)
      if (debounceTimer) clearTimeout(debounceTimer)
      for (const client of clients) {
        client.ready = false
        try { client.socket.destroy() } catch {}
        try { client.vnc?.destroy() } catch {}
      }
      clients.clear()
      for (const socket of sockets) {
        try { socket.destroy() } catch {}
      }
      sockets.clear()
      // `closeAllConnections` (Node 18.2+) covers what the set above cannot see;
      // the 500 ms race makes the promise bounded even on an old runtime.
      try { httpServer.closeAllConnections?.() } catch {}
      await new Promise((done) => {
        const guard = setTimeout(done, 500)
        guard.unref?.()
        try {
          httpServer.close(() => {
            clearTimeout(guard)
            done()
          })
        } catch {
          clearTimeout(guard)
          done()
        }
      })
    }
  }
  if (webRoot === null && web !== '') log(`web root is missing: ${web} (running WS-only)`)

  pollTimer = setInterval(() => { pollClipboard().catch(() => {}) }, pollMs)
  pollTimer.unref?.()

  return bridge
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** `--key value` / `--key=value`, with the values' defaults from the header. */
export function parseArgs(argv) {
  const out = {
    httpPort: '127.0.0.1:6080',
    vncPort: '127.0.0.1:5931',
    web: '/usr/share/novnc',
    controlSock: '/tmp/cua-vm/supervisor.sock',
    name: '',
    pollMs: 1200,
    maxChars: MAX_MESSAGE_CHARS
  }
  const map = {
    '--http-port': 'httpPort',
    '--vnc-port': 'vncPort',
    '--web': 'web',
    '--control-sock': 'controlSock',
    '--name': 'name',
    '--poll-ms': 'pollMs',
    '--max-chars': 'maxChars'
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const eq = token.indexOf('=')
    const flag = eq === -1 ? token : token.slice(0, eq)
    const key = map[flag]
    if (!key) {
      if (flag === '--help' || flag === '-h') return { ...out, help: true }
      continue
    }
    const value = eq === -1 ? argv[i + 1] : token.slice(eq + 1)
    if (eq === -1) i += 1
    if (value === undefined) throw new Error(`${flag} needs a value`)
    out[key] = key === 'pollMs' || key === 'maxChars' ? Number(value) : value
  }
  return out
}

/** The installed entry point; imported by tests only through the exports above. */
async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`[cua-vnc-clip] ${error.message}\n`)
    process.exit(2)
  }
  if (args.help) {
    process.stdout.write('usage: cua-vnc-clip.mjs --http-port 127.0.0.1:<p> --vnc-port 127.0.0.1:<v> --name <vm> [--web <dir>] [--control-sock <path>] [--poll-ms 1200] [--max-chars 262144]\n')
    return
  }
  let bridge
  try {
    bridge = startClipboardBridge(args)
  } catch (error) {
    process.stderr.write(`[cua-vnc-clip] ${error.message}\n`)
    process.exit(2)
  }
  // Wait for the listener so the port in the line is the REAL one (`:0` is legal
  // and is what the supervisor uses to avoid a fixed-port race).
  try { await bridge.ready } catch {}
  process.stderr.write(`[cua-vnc-clip] ${bridge.kind} on ${bridge.url} -> vnc ${args.vncPort}, clipboard of "${args.name}" every ${args.pollMs} ms\n`)
  const stop = async (signal) => {
    process.stderr.write(`[cua-vnc-clip] ${signal}: closing (sent=${bridge.stats.sent} recv=${bridge.stats.recv} injected=${bridge.stats.injected})\n`)
    try { await bridge.close() } catch {}
    process.exit(0)
  }
  process.on('SIGTERM', () => { stop('SIGTERM') })
  process.on('SIGINT', () => { stop('SIGINT') })
}

// Run the CLI only when executed directly: importing this module for the pure
// helpers (the tests do) must never bind a port or exit on a missing --name.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
