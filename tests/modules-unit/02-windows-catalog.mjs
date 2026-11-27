/**
 * 02-windows-catalog.mjs — the sixteen Windows codes, the keycode map and the first argv.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { WINDOWS_CATALOG, WINDOWS_VERSIONS, buildQemuArgs, charToKey, check, generatePassword, parseKeySpec, png, windowsEnabled, windowsPaths } from './harness.mjs'


// ---- windows: the spec contract ----
// WP-2: SIXTEEN CODES, the dockur/windows vocabulary. This list is the ONLY
// table: the catalog, the firmware profiles and the image selections are all
// derived from it, so a code added here without a row fails the very next check.
check('the sixteen Windows codes are the catalog set', WINDOWS_VERSIONS.join(',') === '11,11l,11e,10,10l,10e,7u,xp,2025,2022,2019,2016,2012,core11,tiny11,tiny10', WINDOWS_VERSIONS.join(','))
check('every code has a catalog row with a size, a firmware profile and a label', WINDOWS_VERSIONS.every((code) => {
  const entry = WINDOWS_CATALOG[code]
  return entry !== undefined && entry.sizeGb > 0 && (entry.bios === 'ovmf' || entry.bios === 'seabios') && typeof entry.label === 'string'
}), WINDOWS_VERSIONS.filter((code) => WINDOWS_CATALOG[code] === undefined).join(',') || 'all rows present')
check('xp is the only refused code, and its refusal is data', WINDOWS_VERSIONS.filter((code) => WINDOWS_CATALOG[code].refusal !== undefined).join(',') === 'xp'
  && WINDOWS_CATALOG.xp.refusal === 'legacy-installer-unsupported')
check('charToKey maps ASCII to physical qcodes', charToKey('a')?.qcode === 'a' && charToKey('A')?.shift === true && charToKey('!')?.qcode === '1' && charToKey(' ')?.qcode === 'spc' && charToKey('.')?.qcode === 'dot')
check('charToKey refuses non-ASCII (no clipboard)', charToKey('é') === null && charToKey('中') === null)
check('parseKeySpec handles named keys and modifiers', parseKeySpec('enter').qcode === 'ret' && parseKeySpec('ctrl+c').ctrl === true && parseKeySpec('shift+tab').shiftModifier === true)
let threw = false
try { parseKeySpec('ctrl+é') } catch { threw = true }
check('parseKeySpec refuses an untypable key with a reason', threw)
const pw = generatePassword()
check('generatePassword is 20 url/shell-safe chars', pw.length === 20 && /^[A-Za-z0-9_-]+$/u.test(pw), pw.slice(0, 4) + '…')
check('generatePassword does not repeat', generatePassword() !== generatePassword())
check('windowsEnabled() is on unless DSH_CUA_VM_WINDOWS=0', windowsEnabled() === true)

// A tar with one file, the shape Docker's archive endpoint returns.
function makeTar(name, body) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'ascii')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.write('        ', 148, 'ascii')
  header[156] = '0'.charCodeAt(0)
  header.write('ustar\0' + '00', 257, 'ascii')
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
  return Buffer.concat([header, body, padding, Buffer.alloc(1024)])
}
const tar = makeTar('cua-shot-1.png', png)
// ---- the Windows QEMU command line ----
const paths = windowsPaths('/cua-vm', 'win-1')
const argv = buildQemuArgs({
  name: 'win-1', cpu: 4, memory: 8, gpu: false, paths,
  isoPath: '/cua-vm/iso/w11.iso', driverIso: null, sshPort: 47100, vncPort: 5931, qmpPort: 46100,
  installPending: true, virtio: false
})
const has = (needle) => argv.includes(needle)
check('the firmware is OVMF code + per-computer vars', argv.join(' ').includes('if=pflash,format=raw,readonly=on,file=') && argv.join(' ').includes(paths.efiVars), 'pflash pair')
check('the TPM2 chardev points at the swtpm socket', argv.join(' ').includes(`socket,id=chrtpm,path=${paths.tpmSocket}`))
check('the system disk is a plain qcow2 (checkpointable)', argv.join(' ').includes(`file=${paths.disk},if=none,id=disk0,format=qcow2`) )
check('kvm + host cpu are the acceleration', has('q35,accel=kvm,smm=off') && has('host'))

export { argv, has, paths }
