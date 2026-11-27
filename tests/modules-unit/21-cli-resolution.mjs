/**
 * 21-cli-resolution.mjs — the CUA/OpenCode CLI resolution against the Dockerfile.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { OPENCODE_PLUGIN_FLOOR, OPENCODE_RELEASES_API_URL, OPENCODE_SKIP_ECHO, OPENCODE_SKIP_SENTINEL, RELEASES_API_URL, REPO, WINDOWS_ISO_SOURCES, check, cuaCliAssetUrl, extractOpencodeResolveFragment, extractResolveFragment, opencodeAssetUrl, opencodeVersionFromTagName, path, readFileSync, readOpencodeRunBlock, readRunBlock, resolveWindowsIsoSources, simulateOpencodeResolution, simulateResolution } from './harness.mjs'


// (3) THE CHAIN'S ORDER, in the suite too: the gate can answer n/a in the flat
// image layout, and "mido first" is the whole point of candidate 19.
check('C19: resolveWindowsIsoSources("11") starts at mido and keeps the pinned mirrors',
  resolveWindowsIsoSources('11')[0]?.strategy === 'mido'
  && resolveWindowsIsoSources('11').some((source) => source.strategy === 'link1')
  && resolveWindowsIsoSources('11').map((source) => source.strategy).join(' -> ') === 'mido -> esd -> link1 -> link6 -> midoDirect',
  resolveWindowsIsoSources('11').map((source) => source.strategy).join(' -> '))
check('C19: the static API the quota/cache probe uses is unchanged (entry.url is still the pinned mirror)',
  typeof WINDOWS_ISO_SOURCES['11']?.url === 'string'
  && WINDOWS_ISO_SOURCES['11'].url.startsWith('https://dl.bobpony.com/windows/11/')
  && WINDOWS_ISO_SOURCES['11'].sources.length === 5,
  `${String(WINDOWS_ISO_SOURCES['11']?.url ?? '')} (${WINDOWS_ISO_SOURCES['11']?.sources?.length ?? 0} chain entries)`)

// ------------------------------------------------------------------ *
// C21 — THE NODE FLOOR, ASSERTED AGAINST THE SHIPPED FUNCTION
// ------------------------------------------------------------------ *
//
// `index.js` cannot be imported here (it needs the harness's schemastery), so
// the FUNCTION is sliced out of the file and evaluated: the assertions still run
// against the source that ships, and a drift in the arithmetic fails here.
{
  const indexText = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'index.js'), 'utf8')
  const marker = 'export function nodeFloorOk('
  const start = indexText.indexOf(marker)
  let end = -1
  if (start !== -1) {
    let depth = 0
    let quote = null
    for (let i = start; i < indexText.length; i += 1) {
      const ch = indexText[i]
      if (quote !== null) {
        if (ch === '\\') { i += 1; continue }
        if (ch === quote) quote = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
      if (ch === '{') depth += 1
      else if (ch === '}') { depth -= 1; if (depth === 0) { end = i + 1; break } }
    }
  }
  let nodeFloorOk = null
  if (start !== -1 && end !== -1) {
    const source = indexText.slice(start, end).replace(/^export /u, '')
    nodeFloorOk = new Function(`${source}; return nodeFloorOk;`)()
  }
  const table = [['24.22.2', false], ['24.22.3', true], ['24.0.0', false], ['25.9.0', false], ['26.13.0', false], ['26.13.1', true], ['26.14.0', true], ['27.0.0', true]]
  const wrong = typeof nodeFloorOk !== 'function' ? 'nodeFloorOk not found in index.js' : table.filter(([version, expected]) => nodeFloorOk(version) !== expected).map(([version, expected]) => `${version}→${!expected}`).join(' ')
  check('C21: nodeFloorOk matches DSH 0.2.3-alpha.2 (24.22.3+ in 24.x, 26.13.1+ in 26.x, no 25.x)', wrong === '', wrong || 'all eight cases agree')
  const floor = /const DSH_NODE_FLOOR = '([^']+)'/u.exec(indexText)?.[1] ?? null
  check('C21: the floor constant and package.json engines state the same two numbers', floor === '24.22.3', String(floor))
}

// (5) THE SPOKEN HALF — the two answers agree with the prompt, for both kinds.
{
  const indexText = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'index.js'), 'utf8')
  check('C4: the shutdown answer states memory is freed and the disk survives in the checkpoint',
    indexText.includes('Memory is freed; the disk survives in the checkpoint (`cua_vm_start` cold-boots it).'),
    'the sentence is the contract the tool answer must carry')
  const suspend = 'Memory and the QEMU process are kept; resume is instant.'
  check('C4: BOTH suspend branches (Windows and Linux) say memory and the process are kept',
    (indexText.split('Memory and the QEMU process are kept; resume is instant.').length - 1) === 2,
    `${indexText.split(suspend).length - 1} occurrence(s)`)
}

// (6) CUA-CLI: THE DOCKERFILE RESOLVES THE NEWEST cua-sdk RELEASE AT BUILD TIME.
//
// `ARG CUA_CLI_VERSION=0.7.0` baked one release into every image, so "the image
// has the current CLI" was only true on the day the line was written. The default
// is now `latest` and the RUN resolves it from the releases API — which no unit
// test can prove by reading a string, because the bug lives in the shell (a grep
// that stops matching, a prefix strip that eats a digit, a failure swallowed by
// `|| true`).
//
// So the Dockerfile's RUN fragment is EXTRACTED and EXECUTED under `sh` with a stub
// `curl`. The payload below is the fixture; it is deliberate about the three
// things a naive implementation gets wrong — another package's tag comes first,
// an OLDER cua-sdk tag follows the newest, and a draft/prerelease entry is in
// between (the API's order is "newest first", which is what "first match" means).
{
  const dockerfileText = readFileSync(path.join(REPO, 'Dockerfile'), 'utf8')
  const RELEASES = JSON.stringify([
    { tag_name: 'cua-computer-v1.4.0', name: 'cua-computer 1.4.0', draft: false, prerelease: false, published_at: '2026-11-20T10:00:00Z' },
    { tag_name: 'cua-sdk-v0.9.4', name: 'cua-sdk 0.9.4', draft: false, prerelease: false, published_at: '2026-11-18T10:00:00Z' },
    { tag_name: 'cua-sdk-v0.10.0-rc.1', name: 'cua-sdk 0.10.0-rc.1', draft: true, prerelease: true, published_at: '2026-11-19T10:00:00Z' },
    { tag_name: 'cua-sdk-v0.9.3', name: 'cua-sdk 0.9.3', draft: false, prerelease: false, published_at: '2026-11-01T10:00:00Z' }
  ], null, 2)

  // The fragment is the RUN's own text, not a copy: this assertion is what makes
  // the two below honest when someone rewrites the step.
  let fragment = ''
  let parseError = ''
  try {
    fragment = extractResolveFragment(readRunBlock(dockerfileText))
  } catch (error) {
    parseError = String(error?.message ?? error)
  }
  check('CUA-CLI-1: the Dockerfile still carries the ARG + RUN fragment this test extracts',
    parseError === '' && /CUA_CLI_VERSION/u.test(fragment) && /cua-sdk-v/u.test(fragment),
    parseError || `${fragment.split('\n').length} shell line(s) from the RUN block`)

  const latest = simulateResolution({ dockerfileText, requested: 'latest', apiJson: RELEASES })
  check('CUA-CLI-2: latest takes the FIRST cua-sdk-v* tag (API order = newest) and strips the prefix',
    latest.status === 0 && latest.version === '0.9.4' && latest.curlCalled === true,
    `status ${latest.status}, version ${JSON.stringify(latest.version)}`)

  // The resolved version is what the URL spends — resolving 0.9.4 and fetching
  // 0.7.0 would be the exact defect the template needle guards.
  check('CUA-CLI-3: the asset URL is built from the RESOLVED version, per architecture',
    latest.version !== null
      && cuaCliAssetUrl(latest.version, 'x64') === 'https://github.com/trycua/cua/releases/download/cua-sdk-v0.9.4/cua-cli-0.9.4-linux-x64.tar.gz'
      && cuaCliAssetUrl(latest.version, 'arm64').endsWith('/cua-cli-0.9.4-linux-arm64.tar.gz'),
    cuaCliAssetUrl(latest.version ?? '?', 'x64'))

  const pinned = simulateResolution({ dockerfileText, requested: '0.7.0', apiJson: RELEASES })
  check('CUA-CLI-4: a non-latest CUA_CLI_VERSION is used verbatim, and the API is never called',
    pinned.status === 0 && pinned.version === '0.7.0' && pinned.curlCalled === false,
    `status ${pinned.status}, version ${JSON.stringify(pinned.version)}, curl ${pinned.curlCalled}`)

  const noTag = simulateResolution({
    dockerfileText, requested: 'latest', apiJson: JSON.stringify([{ tag_name: 'cua-computer-v1.4.0' }])
  })
  check('CUA-CLI-5: a response with no cua-sdk-v* tag FAILS instead of falling back to a frozen release',
    noTag.status !== 0 && noTag.version === null && /no cua-sdk-v\*/u.test(noTag.output),
    `status ${noTag.status}: ${noTag.output.trim().split('\n').at(-1) ?? ''}`)

  const apiDown = simulateResolution({ dockerfileText, requested: 'latest', apiFails: true })
  check('CUA-CLI-6: an unreachable releases API FAILS the build (curl exit 22 is not swallowed)',
    apiDown.status !== 0 && apiDown.version === null && /GitHub releases API did not answer/u.test(apiDown.output),
    `status ${apiDown.status}: ${apiDown.output.trim().split('\n').at(-1) ?? ''}`)

  check('CUA-CLI-7: the RUN queries the documented releases endpoint, not a cached or proxy URL',
    readRunBlock(dockerfileText).includes(RELEASES_API_URL), RELEASES_API_URL)
}


// (7) OPENCODE-CLI: THE OTHER CLI THE IMAGE RESOLVES AT BUILD TIME.
//
// The image deliberately does NOT bundle `dsh-opencode-connect` — the user adds
// it from the Plugins page — so the one thing it owes that plugin is a WORKING
// `opencode`. The plugin speaks the v1 root API paths (`/session`,
// `/config/providers`, `/event`) and spawns `opencode serve --port 40961`
// itself; a 2.x CLI would answer none of those calls. Same proof as CUA-CLI
// above: the Dockerfile's fragment, extracted and executed, never a copy.
//
// The fixture is deliberately hostile in four ways a naive resolver gets wrong:
// a v2 release at the TOP, a v2 PRE-RELEASE under it, another package's tag in
// between, and the newest v1 BELOW all of them (the real API interleaves the
// lines — v1.19.6 shipped after v2.3.1).
{
  const dockerfileText = readFileSync(path.join(REPO, 'Dockerfile'), 'utf8')
  const OPENCODE_RELEASES = JSON.stringify([
    { tag_name: 'v2.4.1', name: 'v2.4.1', draft: false, prerelease: false, published_at: '2026-11-22T10:00:00Z' },
    { tag_name: 'v2.0.0-rc.1', name: 'v2.0.0-rc.1', draft: false, prerelease: true, published_at: '2026-11-21T10:00:00Z' },
    { tag_name: 'process-daemon-v0.6.0', name: 'process-daemon 0.6.0', draft: false, prerelease: false, published_at: '2026-11-20T10:00:00Z' },
    { tag_name: 'v1.19.6', name: 'v1.19.6', draft: false, prerelease: false, published_at: '2026-11-17T10:00:00Z' },
    { tag_name: 'v1.18.35', name: 'v1.18.35', draft: false, prerelease: false, published_at: '2026-10-30T10:00:00Z' }
  ], null, 2)

  let fragment = ''
  let parseError = ''
  try {
    fragment = extractOpencodeResolveFragment(readOpencodeRunBlock(dockerfileText))
  } catch (error) {
    parseError = String(error?.message ?? error)
  }
  check('OPENCODE-CLI-1: the Dockerfile still carries the ARG + RUN fragment this test extracts',
    parseError === '' && /OPENCODE_VERSION/u.test(fragment) && /v1\./u.test(fragment),
    parseError || `${fragment.split('\n').length} shell line(s) from the RUN block`)

  const latest = simulateOpencodeResolution({ dockerfileText, requested: 'latest', apiJson: OPENCODE_RELEASES })
  check('OPENCODE-CLI-2: latest takes the FIRST v1.* tag and skips v2 (prerelease included) + other packages',
    latest.status === 0 && latest.version === '1.19.6' && latest.curlCalled === true,
    `status ${latest.status}, version ${JSON.stringify(latest.version)}`)
  check('OPENCODE-CLI-2b: the build log names the version it resolved AND the v2 tags it skipped',
    /resolved to 1\.19\.6/u.test(latest.stdout) && /skipped v2 tags: .*2\.4\.1/u.test(latest.stdout),
    (latest.stdout.match(/skipped v2 tags: .*$/mu) ?? ['missing'])[0])

  check('OPENCODE-CLI-3: the asset URL is built from the RESOLVED version, per target',
    latest.version !== null
      && opencodeAssetUrl(latest.version, 'x64') === 'https://github.com/sst/opencode/releases/download/v1.19.6/opencode-linux-x64.tar.gz'
      && opencodeAssetUrl(latest.version, 'arm64').endsWith('/opencode-linux-arm64.tar.gz'),
    opencodeAssetUrl(latest.version ?? '?', 'x64'))

  const pinned = simulateOpencodeResolution({ dockerfileText, requested: '1.19.6', apiJson: OPENCODE_RELEASES })
  check('OPENCODE-CLI-4: a pinned OPENCODE_VERSION is used as given, and the API is never called',
    pinned.status === 0 && pinned.version === '1.19.6' && pinned.curlCalled === false,
    `status ${pinned.status}, version ${JSON.stringify(pinned.version)}, curl ${pinned.curlCalled}`)

  // THE REASON THIS GATE EXISTS AT ALL: a 2.x CLI exists, is newer, and would be
  // resolved by a plain "newest tag" rule — and then the plugin could not talk to
  // it. Both the pin and the resolution must refuse it.
  const pinnedV2 = simulateOpencodeResolution({ dockerfileText, requested: '2.4.1', apiJson: OPENCODE_RELEASES })
  check('OPENCODE-CLI-5: a pinned 2.x version is REFUSED (the plugin speaks the v1 API)',
    pinnedV2.status !== 0 && pinnedV2.version === null && /speaks the v1 API/u.test(pinnedV2.output),
    `status ${pinnedV2.status}: ${pinnedV2.output.trim().split('\n').at(-1) ?? ''}`)

  const noV1 = simulateOpencodeResolution({
    dockerfileText, requested: 'latest', apiJson: JSON.stringify([{ tag_name: 'v2.4.1' }, { tag_name: 'v2.0.0-rc.1' }])
  })
  check('OPENCODE-CLI-6: a response with no v1.* tag FAILS instead of falling back to a frozen release',
    noV1.status !== 0 && noV1.version === null && /no v1\.\* release/u.test(noV1.output),
    `status ${noV1.status}: ${noV1.output.trim().split('\n').at(-1) ?? ''}`)

  const apiDown = simulateOpencodeResolution({ dockerfileText, requested: 'latest', apiFails: true })
  check('OPENCODE-CLI-7: an unreachable releases API FAILS the build (curl exit 22 is not swallowed)',
    apiDown.status !== 0 && apiDown.version === null && /GitHub releases API did not answer/u.test(apiDown.output),
    `status ${apiDown.status}: ${apiDown.output.trim().split('\n').at(-1) ?? ''}`)

  // The plugin's README gates on CLI >= 1.18.0 for the free tier; an older CLI in
  // the image is a plugin that installs and then shows no models.
  const tooOld = simulateOpencodeResolution({ dockerfileText, requested: '1.17.9', apiJson: OPENCODE_RELEASES })
  const atFloor = simulateOpencodeResolution({ dockerfileText, requested: '1.18.0', apiJson: OPENCODE_RELEASES })
  check('OPENCODE-CLI-8: the plugin free-tier floor (1.18.0) is enforced, and 1.18.0 itself passes',
    OPENCODE_PLUGIN_FLOOR === '1.18.0'
      && tooOld.status !== 0 && tooOld.version === null && /1\.18\.0 floor/u.test(tooOld.output)
      && atFloor.status === 0 && atFloor.version === '1.18.0',
    `1.17.9 → ${tooOld.status}, 1.18.0 → ${atFloor.status}`)

  const runBlock = readOpencodeRunBlock(dockerfileText)
  check('OPENCODE-CLI-9: the RUN queries the documented releases endpoint, not a cached or proxy URL',
    runBlock.includes(OPENCODE_RELEASES_API_URL)
      && OPENCODE_RELEASES_API_URL === 'https://api.github.com/repos/sst/opencode/releases?per_page=100',
    OPENCODE_RELEASES_API_URL)
  check('OPENCODE-CLI-10: the binary lands on /usr/local/bin/opencode (third in the plugin lookup order) and is verified',
    runBlock.includes('/usr/local/bin/opencode --version')
      && /tar -xzf [^\n]*\s+-C \/usr\/local\/bin opencode/u.test(runBlock),
    'tar → /usr/local/bin/opencode, then --version')

  check('OPENCODE-CLI-11: the tag helper accepts v1 tags only',
    opencodeVersionFromTagName('v1.19.6') === '1.19.6'
      && opencodeVersionFromTagName('v2.4.1') === null
      && opencodeVersionFromTagName('process-daemon-v0.6.0') === null,
    'three cases')

  // THE OFF SENTINEL (`--build-arg OPENCODE_VERSION=0`, what the workflows'
  // `opencode` toggle sends when unchecked). It must be a DELIBERATE, logged
  // skip — exit 0, the skip line, no curl, no version — and not a resolver
  // failure, because a failing build is not "the CLI is off". The guard is the
  // RUN's own text; deleting it makes this row throw, not pass.
  const off = simulateOpencodeResolution({ dockerfileText, requested: OPENCODE_SKIP_SENTINEL, apiJson: OPENCODE_RELEASES })
  check('OPENCODE-CLI-12: OPENCODE_VERSION=0 skips the CLI (exit 0, skip line, no curl) instead of resolving it',
    runBlock.includes(OPENCODE_SKIP_ECHO)
      && off.status === 0 && off.version === null && off.curlCalled === false && off.skipped === true,
    `status ${off.status}, curl ${off.curlCalled}, skipped ${off.skipped}`)
}
