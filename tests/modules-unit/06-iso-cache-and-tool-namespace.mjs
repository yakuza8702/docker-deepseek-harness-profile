/**
 * 06-iso-cache-and-tool-namespace.mjs — the unpinned-cache refusal and the public tool namespace.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { DEFAULT_SERVER_NAME, DOCTOR_TOOL_NAME, REVEAL_TOOL_NAME, SSH_KEEPALIVE, TOOL_PREFIX, check, ensureIso, http, isoFileName, mkdtempSync, os, path, rmSync, sshArgv, windowsGuestToolName, windowsToolName, writeFileSync } from './harness.mjs'


// ------------------------------------------------------------------ *
// J1-5: AN UNPINNED CACHE IS NOT A PASS
//
// The old hit test was `exists && size > 1 MB`, and with no pin
// (`wantSha === ''`) it returned ok:true having verified nothing. Now the only
// claim available is the sidecar, and it is checked against the FILE; without
// one the cache is refused as `unpinned-cache` and downloaded again. A local
// HTTP server stands in for the CDN so the re-download is real but instant.
// ------------------------------------------------------------------ *
{
  const body = Buffer.from('a re-downloaded medium\n')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length), 'content-type': 'application/octet-stream' })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/unpinned-media.iso`
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'iso-unpinned-'))
  try {
    // 2 MiB with NO `.sha256` sidecar: the old code called this a cache hit.
    writeFileSync(path.join(cacheDir, isoFileName(url)), Buffer.alloc(2 * 1024 * 1024, 0x5a))
    const logs = []
    const answer = await ensureIso({ url, isoDir: cacheDir, log: (line) => logs.push(String(line)) })
    check('J1-5: a cached ISO with no pin and no sidecar is refused as unpinned-cache',
      logs.some((line) => /rejected \(unpinned-cache\)/u.test(line)),
      logs.find((line) => /rejected/u.test(line)) ?? logs.join(' | ').slice(0, 160))
    check('J1-5: ...and the refusal costs a real re-download (never a silent pass)',
      answer.downloaded === true && answer.verified === false && answer.bytes === body.length,
      JSON.stringify({ downloaded: answer.downloaded, verified: answer.verified, bytes: answer.bytes }))
  } finally {
    rmSync(cacheDir, { recursive: true, force: true })
    await new Promise((resolve) => server.close(resolve))
  }
}

// ------------------------------------------------------------------ *
// WP-5: THE PUBLIC TOOL NAMESPACE AND THE SSH KEEPALIVE
// ------------------------------------------------------------------ *
{
  check('WP-5: the server name and prefix are the harness vocabulary',
    DEFAULT_SERVER_NAME === 'windows' && TOOL_PREFIX === 'mcp__windows__'
    && REVEAL_TOOL_NAME === 'windows_desktop' && DOCTOR_TOOL_NAME === 'windows_mcp_doctor')
  check('WP-5: windowsToolName produces the public name and never doubles the prefix',
    windowsToolName('tool_click_at') === 'mcp__windows__tool_click_at'
    && windowsToolName('mcp__windows__tool_click_at') === 'mcp__windows__tool_click_at'
    && windowsToolName('some tool/x') === 'mcp__windows__some_tool_x')
  check('WP-5: windowsGuestToolName is the reverse mapping', windowsGuestToolName('mcp__windows__find_elements') === 'find_elements'
    && windowsGuestToolName('find_elements') === 'find_elements')
  const argv = sshArgv({ port: 47100, keyPath: '/cua-vm/windows/win-1/id_ed25519' })
  check('WP-5: sshArgv carries -T (no pty), the per-computer key and ServerAliveCountMax=2',
    argv.includes('-T') && argv.includes('-i') && argv.includes('/cua-vm/windows/win-1/id_ed25519')
    && argv.includes('ServerAliveInterval=10') && argv.includes('ServerAliveCountMax=2')
    && argv.includes('BatchMode=yes') && argv.at(-1).includes('dsh_cua.server --stdio'),
    argv.join(' ').slice(0, 160))
  check('WP-5: SSH_KEEPALIVE disables agent/X11/local-command forwarding',
    SSH_KEEPALIVE.includes('ForwardAgent=no') && SSH_KEEPALIVE.includes('ForwardX11=no') && SSH_KEEPALIVE.includes('PermitLocalCommand=no'))
}
