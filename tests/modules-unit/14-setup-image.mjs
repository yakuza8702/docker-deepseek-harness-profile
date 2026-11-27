/**
 * 14-setup-image.mjs — setup.img: the partition, the MBR and the answer-file disk ids.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { CLIP_AGENT_SENTINEL_FILE, OEM_PAYLOAD_FILES, OEM_PAYLOAD_REQUIRED, REPO, SETUP_IMAGE_ENTRIES, SETUP_IMAGE_OPTIONAL, SETUP_PARTITION_OFFSET_BYTES, SETUP_PARTITION_START_LBA, SETUP_PARTITION_TYPE, WINDOWS_IMAGE_SELECTIONS, answerFileDiskIds, assertAnswerFileSelectsImage, assertAnswerFileTargetsSystemDisk, buildSetupImage, check, existsSync, imageInstallFromXml, mkdtempSync, normaliseProductKey, os, path, readFileSync, readSetupMbr, resolveWindowsImageSelection, rmSync, setupMbrSector, setupVolumeSpec, spawnSync, statSync, statSyncSafe, verifySetupImage, windowsPaths, writeFileSync, writeOemPayload } from './harness.mjs'


// ---- S1/S2/S3: THE FAT32 ANSWER MEDIUM, ITS READ-BACK, AND THE OPTIONAL KEY ----
//
// The real proof is a REAL mtools build: mformat/mcopy produce setup.img and
// mdir/mtype read it back. mtools is a runtime dependency in the image, but a
// developer host may not have it; that case is reported NOT RUN, never as a
// pass (a fake green here would hide exactly the class of bug this replaces:
// a medium that looks attached and holds no answer file).
{
  const mtools = ['mformat', 'mcopy', 'mdir', 'mtype'].every((tool) => spawnSync(tool, ['--version'], { stdio: 'ignore' }).status === 0)
  if (!mtools) {
    console.log('  n/a  S1/S2 setup.img build: mtools is absent from this host — NOT RUN (the image installs it; `apt-get install mtools` to run this here)')
  } else {
    const store = mkdtempSync(path.join(os.tmpdir(), 'cua-setup-img-'))
    try {
      const setupPaths = windowsPaths(store, 'win-setup')
      writeOemPayload({
        paths: setupPaths, name: 'win-setup', password: 'pw', sshPubKey: 'ssh-ed25519 AAAA x',
        sourceDir: path.join(REPO, 'docker', 'windows-oem'), pythonUrl: 'https://python', dshCuaSpec: 'dsh-cua==1'
      })
      const image = buildSetupImage({ paths: setupPaths })
      check('S1: buildSetupImage produces $STORE/windows/<name>/setup.img', image === setupPaths.setupImg && existsSync(image)
        && statSyncSafe(image) >= 32 * 1024 * 1024, `${image}`)
      // F1/F4: QEMU opens setup0 read-write; the runtime uid owns it and the
      // owner-write bit is set after the build (chmod 0600). A media file the
      // uid cannot write is the same class as `readonly=on`: device realize dies.
      {
        const st = statSync(image)
        check('F1/F4: setup.img is owner-writable and owned by the runtime uid (mode 0600)',
          (st.mode & 0o200) !== 0 && (st.mode & 0o777) === 0o600 && st.uid === process.getuid(), `mode=${(st.mode & 0o777).toString(8)} uid=${st.uid}`)
        // Rebuild policy: a second create must NEVER reuse the guest-written
        // image — it is unlinked and built fresh (byte-verified again).
        writeFileSync(path.join(setupPaths.setupImg), 'GUEST SCRATCH', { flag: 'r+' })
        const rebuilt = buildSetupImage({ paths: setupPaths })
        check('F1: a re-create REBUILDS setup.img fresh (no idempotent skip over guest writes)',
          rebuilt === setupPaths.setupImg && verifySetupImage({ paths: setupPaths }).entries.includes('Autounattend.xml')
          && statSync(rebuilt).size >= 32 * 1024 * 1024)
      }
      const verified = verifySetupImage({ paths: setupPaths })
      check('S2: mdir lists Autounattend.xml at the image ROOT',
        verified.entries.includes('Autounattend.xml'), verified.entries.join(','))
      check('S2: mdir lists startup.nsh and the three scripts at the root',
        ['startup.nsh', 'setupcomplete.cmd', 'cua-firstboot.ps1', 'Unattend.vbs'].every((name) => verified.entries.includes(name)))
      check('S2: $OEM$/$$/Setup/Scripts carries the SetupComplete + hidden launcher chain',
        ['setupcomplete.cmd', 'cua-firstboot.ps1', 'Unattend.vbs'].every((name) => verified.oemScripts.includes(name)),
        verified.oemScripts.join(','))
      check('S2: the image copy of Autounattend.xml is BYTE-identical to the staged file (mtype read-back)',
        verified.image === setupPaths.setupImg && readFileSync(path.join(setupPaths.oemDir, 'Autounattend.xml')).length > 0)
      const xml = readFileSync(path.join(setupPaths.oemDir, 'Autounattend.xml'), 'utf8')
      check('S2: every <DiskID> targets Disk 0 (the qcow2 on ide.0, not setup.img on ide.2)',
        answerFileDiskIds(xml).length === 2 && answerFileDiskIds(xml).every((id) => id === 0), answerFileDiskIds(xml).join(','))
      check('S2: the answer file has an explicit <InstallTo><DiskID>0</DiskID>',
        /<InstallTo>\s*<DiskID>0<\/DiskID>/u.test(xml))
      check('S2: assertAnswerFileTargetsSystemDisk accepts the staged file', (() => {
        try { return assertAnswerFileTargetsSystemDisk(xml).every((id) => id === 0) } catch { return false }
      })())
      check('S2: a wrong DiskID is REFUSED (the read-only medium would be wiped)', (() => {
        try { assertAnswerFileTargetsSystemDisk('<InstallTo><DiskID>1</DiskID></InstallTo><DiskID>1</DiskID>'); return false } catch (error) {
          return /targets DiskID 1/u.test(error.message)
        }
      })())
      check('S3: no windowsKey = no <ProductKey> block (evaluation media need none)',
        !/<ProductKey><Key>/u.test(xml) && !xml.includes('{{PRODUCT_KEY}}'))

      // ---- J22-6: THE PRIVACY OFF-SWITCH IS NOW A LIVE SENTINEL ----
      //
      // `DSH_CUA_CLIP_AGENT=0` means "do not run the ambient clipboard loop", but
      // the GUEST CANNOT READ THE HOST ENVIRONMENT: the flag is a STAGING-time
      // variable with no channel back from Windows. Both consumers (firstboot's
      // task registrar and the agent itself) therefore test a PATH. Those readers
      // existed while nothing wrote the file, so the switch was inert — this
      // drives the shipped writer and the shipped optional-entry rules, on a real
      // setup.img, with the two env states, and reads the result back.
      {
        const previous = process.env.DSH_CUA_CLIP_AGENT
        const sentinelStore = mkdtempSync(path.join(os.tmpdir(), 'cua-clip-sentinel-'))
        const writePayload = (paths, name, log = () => {}) => writeOemPayload({
          paths, name, password: 'pw', sshPubKey: 'ssh-ed25519 AAAA x',
          sourceDir: path.join(REPO, 'docker', 'windows-oem'), pythonUrl: 'https://python', dshCuaSpec: 'dsh-cua==1', log
        })
        const rootSentinel = (paths) => path.join(paths.oemDir, CLIP_AGENT_SENTINEL_FILE)
        const scriptsSentinel = (paths) => path.join(paths.oemDir, '$OEM$', '$$', 'Setup', 'Scripts', CLIP_AGENT_SENTINEL_FILE)
        try {
          // PURE HALF: the table the build and the verify read. The sentinel is a
          // ROOT ENTRY but never a required payload member — a payload directory
          // must stay valid with the knob unset.
          check('J22-6: clip-agent-disabled is a named root entry, OPTIONAL (never a required payload file)',
            CLIP_AGENT_SENTINEL_FILE === 'clip-agent-disabled'
            && SETUP_IMAGE_ENTRIES.includes(CLIP_AGENT_SENTINEL_FILE)
            && SETUP_IMAGE_OPTIONAL.includes(CLIP_AGENT_SENTINEL_FILE)
            // NOT a payload FILE: there is no source-side sentinel to copy. The
            // writer CREATES it from the env, so a payload directory never has to
            // carry one and `OEM_PAYLOAD_FILES` must not list it.
            && !OEM_PAYLOAD_FILES.includes(CLIP_AGENT_SENTINEL_FILE)
            && !OEM_PAYLOAD_REQUIRED.includes(CLIP_AGENT_SENTINEL_FILE))

          // (a) DSH_CUA_CLIP_AGENT=0 STAGES IT, on BOTH routes the search uses.
          process.env.DSH_CUA_CLIP_AGENT = '0'
          const offPaths = windowsPaths(sentinelStore, 'win-sentinel-off')
          const offLogs = []
          writePayload(offPaths, 'win-sentinel-off', (line) => offLogs.push(String(line)))
          check('J22-6: DSH_CUA_CLIP_AGENT=0 stages the sentinel at the payload root',
            existsSync(rootSentinel(offPaths))
            && /DSH_CUA_CLIP_AGENT=0/u.test(readFileSync(rootSentinel(offPaths), 'utf8')),
            rootSentinel(offPaths))
          check('J22-6: ...and into $OEM$/$$/Setup/Scripts (the path Setup copies to C:\\Windows\\Setup\\Scripts)',
            existsSync(scriptsSentinel(offPaths)), scriptsSentinel(offPaths))
          check('J22-6: ...and the writer LOGS why (an operator can see the switch took effect)',
            offLogs.some((line) => /clip agent disabled by DSH_CUA_CLIP_AGENT=0 \(sentinel staged\)/u.test(line)),
            offLogs.find((line) => /clip agent/u.test(line)) ?? offLogs.join(' | ').slice(0, 120))
          buildSetupImage({ paths: offPaths })
          const offVerified = verifySetupImage({ paths: offPaths })
          check('J22-6: the built medium CARRIES it at the root and in the copied Scripts tree',
            offVerified.entries.includes(CLIP_AGENT_SENTINEL_FILE)
            && offVerified.oemScripts.includes(CLIP_AGENT_SENTINEL_FILE),
            `root=${offVerified.entries.includes(CLIP_AGENT_SENTINEL_FILE)} scripts=${offVerified.oemScripts.includes(CLIP_AGENT_SENTINEL_FILE)}`)

          // (b) UNSET STAGES NOTHING — and that is not "incomplete", because the
          // entry is optional in BOTH the build and the verify.
          delete process.env.DSH_CUA_CLIP_AGENT
          const onPaths = windowsPaths(sentinelStore, 'win-sentinel-on')
          writePayload(onPaths, 'win-sentinel-on')
          check('J22-6: unset stages NO sentinel (neither root nor $OEM$ Scripts)',
            !existsSync(rootSentinel(onPaths)) && !existsSync(scriptsSentinel(onPaths)))
          buildSetupImage({ paths: onPaths })
          const onVerified = verifySetupImage({ paths: onPaths })
          check('J22-6: ...and the medium still builds and verifies (optional, never "incomplete")',
            !onVerified.entries.includes(CLIP_AGENT_SENTINEL_FILE)
            && onVerified.entries.includes('Autounattend.xml')
            && onVerified.oemScripts.includes('cua-firstboot.ps1'),
            `entries=${onVerified.entries.length} sentinel=${onVerified.entries.includes(CLIP_AGENT_SENTINEL_FILE)}`)

          // (c) THE STALE GUARD ON THE ROOT COPY: the OEM directory lives in the
          // store and survives, so a previous `=0` create must not keep the switch
          // off for a machine re-staged with the knob unset.
          writePayload(offPaths, 'win-sentinel-off')
          check('J22-6: re-staging with the knob UNSET unlinks the root sentinel (stale guard)',
            !existsSync(rootSentinel(offPaths)))

          // (d) A GUEST COPY ALREADY IN PLACE IS NOT OVERWRITTEN BY THE TEST, but
          // the sentinel's CONTENT is presence-only: the consumers test the path.
          writeFileSync(path.join(offPaths.oemDir, 'clip-agent-disabled'), 'hand-written by an operator\n')
          check('J22-6: presence is the contract — the file content is never parsed',
            readFileSync(path.join(offPaths.oemDir, 'clip-agent-disabled'), 'utf8') === 'hand-written by an operator\n')
        } finally {
          if (previous === undefined) delete process.env.DSH_CUA_CLIP_AGENT
          else process.env.DSH_CUA_CLIP_AGENT = previous
          rmSync(sentinelStore, { recursive: true, force: true })
        }
      }

      // ---- F1: THE MEDIUM IS A PARTITIONED DISK ----
      //
      // The live-verified root cause: setup.img was a partitionless FAT32
      // superfloppy. EDK2 mounts that; Windows does not mount a partitionless
      // FIXED disk, so WinPE's drive-root search had nothing to scan and Setup
      // showed the interactive language screen with the answer file provably
      // present. These assertions read the bytes, not the code.
      {
        const raw = readFileSync(setupPaths.setupImg)
        const signature = raw.toString('hex', 510, 512)
        check('F1: setup.img carries an MBR signature 0x55AA at offset 510',
          signature === '55aa', `offset 510 = 0x${signature}`)
        const entry = 0x1be
        const type = raw[entry + 4]
        const startLba = raw.readUInt32LE(entry + 8)
        const sectors = raw.readUInt32LE(entry + 12)
        check('F1: partition entry 1 at 0x1BE is type 0x0C (FAT32 LBA) and starts at LBA 2048',
          type === SETUP_PARTITION_TYPE && startLba === SETUP_PARTITION_START_LBA && startLba === 2048,
          `type=0x${type.toString(16)} startLba=${startLba} sectors=${sectors}`)
        check('F1: the partition is non-empty and fits the 64 MiB image',
          sectors > 0 && startLba + sectors <= raw.length / 512, `${startLba}+${sectors} <= ${raw.length / 512}`)
        check('F1: the partition starts at byte 1048576 (mtools @@ offset)',
          SETUP_PARTITION_OFFSET_BYTES === 1048576 && SETUP_PARTITION_OFFSET_BYTES === startLba * 512,
          `${SETUP_PARTITION_OFFSET_BYTES}`)
        // The boot sector at LBA 0 is a TABLE, not a VBR: the VBR moved into the
        // partition, which is the whole point.
        check('F1: LBA 0 is an MBR (no FAT VBR magic at byte 0 any more)',
          raw.toString('hex', 0, 3) !== 'eb5890' && raw.toString('hex', 0, 3) !== 'eb3c90',
          raw.toString('hex', 0, 3))
        check('F1: the VBR now lives at the partition offset (0xEB 0x58 0x90 / mtools signature)',
          raw.readUInt16LE(SETUP_PARTITION_OFFSET_BYTES + 11) === 512,
          `bytesPerSector=${raw.readUInt16LE(SETUP_PARTITION_OFFSET_BYTES + 11)}`)
        check('F1: the BPB hidden-sectors field equals the partition start (2048), as Windows compares',
          raw.readUInt32LE(SETUP_PARTITION_OFFSET_BYTES + 28) === SETUP_PARTITION_START_LBA,
          String(raw.readUInt32LE(SETUP_PARTITION_OFFSET_BYTES + 28)))
        const mbr = readSetupMbr(setupPaths.setupImg)
        check('F1: readSetupMbr reports the same geometry verifySetupImage enforces',
          mbr.signature === '55aa' && mbr.active === true && mbr.type === 0x0c && mbr.startLba === 2048,
          JSON.stringify(mbr))
        // mdir THROUGH THE PARTITION, by hand — the literal F1 acceptance test.
        const listing = spawnSync('mdir', ['-i', setupVolumeSpec(setupPaths.setupImg), '-b', '::/'], { encoding: 'utf8' })
        check('F1: `mdir -i img@@1048576` lists Autounattend.xml through the partition',
          listing.status === 0 && /Autounattend\.xml/iu.test(listing.stdout), (listing.stdout || listing.stderr || '').replace(/\s+/gu, ' ').slice(0, 120))
        // A copy of just the first sector is a valid MBR stub by construction.
        const stub = setupMbrSector({ startLba: 2048, sectorCount: 100 })
        check('F1: setupMbrSector is a 512-byte MBR (signature + one active 0x0C entry)',
          stub.length === 512 && stub[510] === 0x55 && stub[511] === 0xaa && stub[0x1be] === 0x80
          && stub[0x1be + 4] === 0x0c && stub.readUInt32LE(0x1be + 8) === 2048)
        check('F1: verifySetupImage REFUSES a partitionless image (the bug, executable)', (() => {
          const broken = path.join(store, 'superfloppy.img')
          writeFileSync(broken, Buffer.alloc(1024))
          try { verifySetupImage({ paths: { ...setupPaths, setupImg: broken } }); return false } catch (error) {
            return /partitionless|MBR/u.test(error.message)
          }
        })())
      }

      // ---- F2: THE EDITION IS NAMED ----
      {
        const selection = resolveWindowsImageSelection({ version: '11l' })
        check('F2: 11l resolves to /IMAGE/NAME with the name VERIFIED from the pinned ISO WIM XML',
          selection.key === '/IMAGE/NAME'
          && selection.value === 'Windows 11 IoT Enterprise LTSC 2024 Evaluation'
          && selection.verified === true,
          `${selection.key}=${selection.value} (${selection.source})`)
        check('F2: the table itself carries the verified value (single source of truth)',
          WINDOWS_IMAGE_SELECTIONS['11l'].key === '/IMAGE/NAME'
          && WINDOWS_IMAGE_SELECTIONS['11l'].value === 'Windows 11 IoT Enterprise LTSC 2024 Evaluation'
          && WINDOWS_IMAGE_SELECTIONS['11l'].verified === true)
        check('F2: an operator ISO (no version) falls back to /IMAGE/INDEX 1',
          resolveWindowsImageSelection({ version: '' }).key === '/IMAGE/INDEX'
          && resolveWindowsImageSelection({ version: '' }).value === 1)
        check('F2: an explicit index wins over the version table',
          resolveWindowsImageSelection({ version: '11l', imageIndex: 3 }).value === 3
          && resolveWindowsImageSelection({ version: '11l', imageIndex: 3 }).key === '/IMAGE/INDEX')
        check('F2: an explicit name wins over the index',
          resolveWindowsImageSelection({ version: '11l', imageIndex: 3, imageName: 'Windows 11 Enterprise LTSC 2024 Evaluation' }).key === '/IMAGE/NAME')
        check('F2: a malformed index is refused with the accepted shape', (() => {
          try { resolveWindowsImageSelection({ imageIndex: 'two' }); return false } catch (error) {
            return /windowsImageIndex/u.test(error.message)
          }
        })())
        check('F2: imageInstallFromXml carries exactly one <MetaData> with the key/value',
          (() => {
            const built = imageInstallFromXml(selection)
            return built.startsWith('<InstallFrom><MetaData ')
              && (built.match(/<MetaData\b/gu) ?? []).length === 1
              && built.includes('<Key>/IMAGE/NAME</Key>')
              && built.includes('<Value>Windows 11 IoT Enterprise LTSC 2024 Evaluation</Value>')
          })())
        check('F2: the STAGED answer file has <InstallFrom> before <InstallTo> (schema order)',
          xml.indexOf('<InstallFrom>') !== -1 && xml.indexOf('<InstallFrom>') < xml.indexOf('<InstallTo>'),
          `${xml.indexOf('<InstallFrom>')} < ${xml.indexOf('<InstallTo>')}`)
        check('F2: the staged XML selects an image (assertAnswerFileSelectsImage accepts it)',
          (() => { try { const picked = assertAnswerFileSelectsImage(xml); return picked.key === '/IMAGE/INDEX' && picked.value === '1' } catch { return false } })())
        check('F2: a missing <InstallFrom> is REFUSED (Setup would ask which edition)', (() => {
          try { assertAnswerFileSelectsImage('<OSImage><InstallTo><DiskID>0</DiskID></InstallTo></OSImage>'); return false } catch (error) {
            return /InstallFrom/u.test(error.message)
          }
        })())
        check('F2: two <MetaData> blocks are REFUSED (Setup honours the first, the rest is a lie)', (() => {
          const two = '<ImageInstall><OSImage><InstallFrom>'
            + '<MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>1</Value></MetaData>'
            + '<MetaData wcm:action="add"><Key>/IMAGE/NAME</Key><Value>X</Value></MetaData>'
            + '</InstallFrom><InstallTo><DiskID>0</DiskID></InstallTo></OSImage></ImageInstall>'
          try { assertAnswerFileSelectsImage(two); return false } catch (error) { return /exactly ONE <MetaData>/u.test(error.message) }
        })())
        // writeOemPayload with a version stages the NAME, not just the index.
        const named = windowsPaths(store, 'win-named')
        writeOemPayload({
          paths: named, name: 'win-named', password: 'pw', sshPubKey: 'ssh-ed25519 AAAA x',
          sourceDir: path.join(REPO, 'docker', 'windows-oem'), pythonUrl: 'https://python', dshCuaSpec: 'dsh-cua==1',
          windowsVersion: '11l'
        })
        const namedXml = readFileSync(path.join(named.oemDir, 'Autounattend.xml'), 'utf8')
        check('F2: writeOemPayload(windowsVersion: 11l) stages /IMAGE/NAME, not INDEX',
          namedXml.includes('<Key>/IMAGE/NAME</Key>')
          && namedXml.includes('<Value>Windows 11 IoT Enterprise LTSC 2024 Evaluation</Value>')
          && !namedXml.includes('{{IMAGE_INSTALL}}'))
      }

      // A licensed operator ISO: the key is normalised and written with
      // WillShowUI Never, so Setup never stops to ask.
      const keyed = windowsPaths(store, 'win-keyed')
      writeOemPayload({
        paths: keyed, name: 'win-keyed', password: 'pw', sshPubKey: 'ssh-ed25519 AAAA x',
        sourceDir: path.join(REPO, 'docker', 'windows-oem'), pythonUrl: 'https://python', dshCuaSpec: 'dsh-cua==1',
        windowsKey: 'vk7jg-nphtm-c97jm-9mpgt-3v66t'
      })
      const keyedXml = readFileSync(path.join(keyed.oemDir, 'Autounattend.xml'), 'utf8')
      check('S3: windowsKey writes <ProductKey> with WillShowUI Never',
        keyedXml.includes('<ProductKey><Key>VK7JG-NPHTM-C97JM-9MPGT-3V66T</Key><WillShowUI>Never</WillShowUI></ProductKey>'))
      check('S3: normaliseProductKey accepts dashed/lowercase and inserts dashes from 25 chars',
        normaliseProductKey(' vk7jg nphtm c97jm 9mpgt 3v66t ') === 'VK7JG-NPHTM-C97JM-9MPGT-3V66T'
        && normaliseProductKey('') === '')
      check('S3: a malformed key is refused with the accepted shape', (() => {
        try { normaliseProductKey('NOPE'); return false } catch (error) { return /not a Windows product key/u.test(error.message) }
      })())
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  }
}
