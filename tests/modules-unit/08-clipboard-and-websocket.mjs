/**
 * 08-clipboard-and-websocket.mjs — the RFB clipboard wire format and the websocket subprotocol.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { WS_SUBPROTOCOLS, check, encodeCutText, isClientCutText, net, os, parseClientCutText, path, selectSubprotocol, serverCutTextFrame, startClipboardBridge, wsAccept } from './harness.mjs'


// ------------------------------------------------------------------ *
// WP-7: THE RFB CLIPBOARD WIRE FORMAT (noVNC talks exactly this)
// ------------------------------------------------------------------ *
{
  const frame = serverCutTextFrame('hi')
  check('WP-7: a ServerCutText is type 3 + 3 pad bytes + BE length + the bytes',
    frame.length === 10 && frame.equals(Buffer.from([3, 0, 0, 0, 0, 0, 0, 2, 104, 105])),
    frame.toString('hex'))
  const client = Buffer.from([6, 0, 0, 0, 0, 0, 0, 3, 65, 66, 67])
  check('WP-7: a ClientCutText is recognised by type 6 and parsed as ABC',
    isClientCutText(client) === true && parseClientCutText(client).text === 'ABC' && parseClientCutText(client).length === 3)
  check('WP-7: a non-cut-text frame is NOT swallowed (the rest is a passthrough)',
    isClientCutText(Buffer.from([0, 0, 0, 0])) === false && isClientCutText(Buffer.from([2, 0, 0, 0, 0, 0, 0, 1, 65])) === false)
  check('WP-7: the WebSocket handshake is base64(sha1(key + GUID))',
    wsAccept('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  // THE ENCODING LABEL: latin1 only when every code point fits in a byte, so a
  // decode on the other side reproduces the string exactly.
  const latin = encodeCutText('café')
  const wide = encodeCutText('中文')
  check('WP-7: encodeCutText labels latin1 for Latin-1 text and utf-8 for CJK',
    latin.encoding === 'latin1' && wide.encoding === 'utf-8' && wide.length === 6, `${latin.encoding}/${wide.encoding}`)
  check('WP-7: encodeCutText strips NUL (both the wire and the Windows clipboard stop at one)',
    encodeCutText('a\u0000b').length === 2)
}

// ------------------------------------------------------------------ *
// J22-8b: THE WEBSOCKET SUBPROTOCOL IS A NEGOTIATION, NOT A CONSTANT
//
// The reported defect: the bridge answered `Sec-WebSocket-Protocol: binary`
// unconditionally. RFC 6455 §4.2.2 says a server naming a protocol the client
// did not offer is a handshake the CLIENT MUST ABORT — and Debian's novnc 1.6.0
// offers none. The page loaded, the socket was dropped, the console said "not
// connected". selectSubprotocol() is the rule; these checks include a REAL
// upgrade exchange so the emitted header (not just the helper) is asserted.
// ------------------------------------------------------------------ *
{
  check('J22-8b: the only subprotocol this bridge speaks is `binary`',
    WS_SUBPROTOCOLS.length === 1 && WS_SUBPROTOCOLS[0] === 'binary')
  check('J22-8b: no offer → null (so the header is OMITTED, never guessed)',
    selectSubprotocol(undefined) === null && selectSubprotocol('') === null
    && selectSubprotocol('   ') === null && selectSubprotocol(null) === null)
  check("J22-8b: 'base64, binary' → 'binary' (the client's first protocol we support)",
    selectSubprotocol('base64, binary') === 'binary' && selectSubprotocol('binary, base64') === 'binary')
  check('J22-8b: ...echoed with the CLIENT\'s spelling, and only when offered',
    selectSubprotocol('BINARY') === 'BINARY' && selectSubprotocol('BINARY, base64') === 'BINARY'
    && selectSubprotocol('permessage-deflate') === null
    && selectSubprotocol('permessage-deflate, base64') === null)
  check('J22-8b: an empty supported list never invents a protocol',
    selectSubprotocol('binary', []) === null)

  // THE REAL HANDSHAKE. A loopback-only bridge on ephemeral ports; the VNC and
  // control endpoints are never dialled for an upgrade, so dummy values are fine.
  const bridge = startClipboardBridge({
    httpPort: '127.0.0.1:0',
    vncPort: '127.0.0.1:1',
    controlSock: path.join(os.tmpdir(), `cua-ws-probe-${process.pid}.sock`),
    name: 'ws-probe',
    pollMs: 60000,
    log: () => {}
  })
  const upgrade = (headers) => new Promise((resolve, reject) => {
    const port = Number(new URL(bridge.url).port)
    const socket = net.connect(port, '127.0.0.1')
    let buffer = ''
    const timer = setTimeout(() => { try { socket.destroy() } catch {} ; resolve(buffer) }, 4000)
    timer.unref?.()
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      const lines = [
        'GET /websockify HTTP/1.1',
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...headers,
        '', ''
      ]
      socket.write(lines.join('\r\n'))
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      if (buffer.includes('\r\n\r\n')) {
        clearTimeout(timer)
        try { socket.destroy() } catch {}
        resolve(buffer)
      }
    })
    socket.on('error', reject)
  })
  try {
    await bridge.ready
    const none = await upgrade([])
    check('J22-8b: an upgrade with NO Sec-WebSocket-Protocol gets 101 and NO protocol header',
      /^HTTP\/1\.1 101/u.test(none) && !/sec-websocket-protocol:/iu.test(none),
      none.split('\r\n').filter(Boolean).join(' | ').slice(0, 180))
    const offered = await upgrade(['Sec-WebSocket-Protocol: binary'])
    check('J22-8b: ...an upgrade that OFFERS binary gets the header back, named once',
      /^HTTP\/1\.1 101/u.test(offered)
      && (offered.match(/sec-websocket-protocol: binary/giu) ?? []).length === 1,
      offered.split('\r\n').filter(Boolean).join(' | ').slice(0, 180))
    const unsupported = await upgrade(['Sec-WebSocket-Protocol: permessage-deflate'])
    check('J22-8b: ...an offer we cannot speak is NOT echoed (no header at all)',
      /^HTTP\/1\.1 101/u.test(unsupported) && !/sec-websocket-protocol:/iu.test(unsupported))
  } finally {
    await bridge.close()
  }
}
