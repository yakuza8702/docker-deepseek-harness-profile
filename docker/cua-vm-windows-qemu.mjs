/**
 * cua-vm-windows-qemu — a Windows computer as a DIRECT QEMU process.
 *
 * WHY THIS EXISTS (and what it replaced)
 * --------------------------------------
 * Windows used to be a third-party Windows container image on a Docker Engine sidecar.
 * That architecture had three problems that could not be fixed from inside it:
 *
 *   1. it needed a second container runtime (privileged DinD) just to hold a
 *      QEMU that this image can run itself;
 *   2. its own monitor owned port 7100, so our QMP collided with it at boot;
 *   3. the store was split — the container's `/storage` bind had to be the same
 *      volume as `/cua-vm` or frames and credentials lived in two places.
 *
 * So Windows is now what Linux already is: `qemu-system-x86_64` started by the
 * supervisor, with the SAME /dev/kvm, the SAME `/cua-vm` store, the SAME
 * lifecycle locks and the SAME shutdown/checkpoint machinery. What changes is
 * only the firmware and the guest-facing devices:
 *
 *   firmware   OVMF (UEFI), with a per-computer vars store under
 *              `$STORE/windows/<name>/efi-vars.qcow2`, plus a swtpm TPM2 so
 *              Windows 11's installer is satisfied honestly instead of being
 *              talked past with registry bypasses.
 *   disks      qcow2 under `$STORE/windows/<name>/disk.qcow2` — a plain qcow2,
 *              which is why `qemu-img convert` checkpointing keeps working.
 *   install    the pinned Microsoft ISO, an MBR + FAT32 answer DISK built with
 *              mtools from `Autounattend.xml` + the OEM scripts (see
 *              docker/windows-oem/), and — when the operator provides it — the
 *              virtio-win drivers ISO.
 *   control    QMP on loopback (screendump / input-send-event / query-status /
 *              system_powerdown / quit) and a VNC display on loopback that the
 *              proxy relays, so "Show VM" is a live stream the user drives.
 *
 * WHAT THIS MODULE IS, AND IS NOT
 * -------------------------------
 * It is a COMMAND BUILDER plus lifecycle helpers over injected primitives
 * (`spawn`, `qmp`, `log`, `now`), so the argv can be asserted in a test without
 * a hypervisor, and so the supervisor keeps owning every lock, the registry and
 * the quotas. It never reads the registry and never writes it.
 */

import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import os from 'node:os'
import { pngSize } from './cua-vm-space.mjs'
import { KVM_DEVICE, deviceNodePresent, kvmPreflightError, kvmStatus, regularFilePresent } from './cua-vm-kvm.mjs'

/* ------------------------------------------------------------------ *
 * The catalog: sixteen codes, one row each
 * ------------------------------------------------------------------ */

/**
 * SIXTEEN CODES, ONE CATALOG.
 *
 * The five-version list this module used to carry was an artefact of the
 * Evaluation Center (Windows 11 LTSC, Windows 10 LTSC, Server 2022, Server
 * 2025, plus two "no public link" placeholders), so "Windows 11 Enterprise" or
 * "Server 2019" had no spelling at all and every caller had to hand in a
 * `windowsIso`. The catalog below is the dockur/windows vocabulary — the same
 * ids the docker-windows images use — so an operator who knows that project can
 * create a computer here, and every code carries the three things the create
 * path actually needs:
 *
 *   sizeGb     the store reservation and the honest download timeout
 *   bios       which firmware profile the guest boots on (see STEP 4:
 *              WINDOWS_FIRMWARE_PROFILES — 7u has no UEFI, so q35+OVMF+TPM was
 *              never a working configuration for it)
 *   selection  which image inside the media Setup must install
 *
 * `refusal` marks a code that is LISTED but not installable by this backend
 * (today: xp). Listing it IS the point: answering "Windows XP" with "unknown
 * version" is a lie about the catalog, and the refusal states the real obstacle
 * (no UEFI, and Setup reads winnt.sif from a floppy/ISO root, which this OEM
 * payload does not build) instead of pretending the code does not exist.
 */
export const WINDOWS_VERSIONS = ['11', '11l', '11e', '10', '10l', '10e', '7u', 'xp', '2025', '2022', '2019', '2016', '2012', 'core11', 'tiny11', 'tiny10']

export const WINDOWS_CATALOG = Object.freeze({
  '11': Object.freeze({ id: 'win11x64', label: 'Windows 11 Pro', sizeGb: 7.9, bios: 'ovmf', selection: { key: '/IMAGE/INDEX', value: 1 } }),
  '11l': Object.freeze({ id: 'win11x64-enterprise-ltsc-eval', label: 'Windows 11 LTSC', sizeGb: 4.7, bios: 'ovmf', selection: { key: '/IMAGE/NAME', value: 'Windows 11 IoT Enterprise LTSC 2024 Evaluation', verified: true } }),
  '11e': Object.freeze({ id: 'win11x64-enterprise-eval', label: 'Windows 11 Enterprise', sizeGb: 6.6, bios: 'ovmf', selection: { key: '/IMAGE/INDEX', value: 1 } }),
  '10': Object.freeze({ id: 'win10x64', label: 'Windows 10 Pro', sizeGb: 5.7, bios: 'ovmf', selection: { key: '/IMAGE/INDEX', value: 1 } }),
  '10l': Object.freeze({ id: 'win10x64-enterprise-ltsc-eval', label: 'Windows 10 LTSC', sizeGb: 4.6, bios: 'ovmf', selection: { key: '/IMAGE/INDEX', value: 1 } }),
  '10e': Object.freeze({ id: 'win10x64-enterprise-eval', label: 'Windows 10 Enterprise', sizeGb: 5.2, bios: 'ovmf', selection: { key: '/IMAGE/INDEX', value: 1 } }),
  '7u': Object.freeze({ id: 'win7x64-ultimate', label: 'Windows 7 Ultimate', sizeGb: 3.1, bios: 'seabios', selection: { key: '/IMAGE/NAME', value: 'Windows 7 Ultimate', verified: true } }),
  xp: Object.freeze({
    id: 'winxpx86',
    label: 'Windows XP Professional',
    sizeGb: 0.6,
    bios: 'seabios',
    // LISTED, NOT INSTALLABLE — and the refusal is data, so every surface
    // (resolveWindowsIso, buildQemuArgs, the CLI answer) quotes one sentence
    // instead of inventing its own.
    refusal: 'legacy-installer-unsupported',
    refusalDetail: 'Windows XP has no UEFI and no Autounattend.xml path: its Setup reads winnt.sif from a floppy/ISO root, which this OEM payload does not build. Use windowsIso with your own answer medium on a host that can run a BIOS machine.'
  }),
  '2025': Object.freeze({ id: 'win2025-eval', label: 'Windows Server 2025', sizeGb: 7.6, bios: 'ovmf', selection: { key: '/IMAGE/INDEX', value: 2 } }),
  '2022': Object.freeze({ id: 'win2022-eval', label: 'Windows Server 2022', sizeGb: 6.0, bios: 'ovmf', selection: { key: '/IMAGE/INDEX', value: 2 } }),
  '2019': Object.freeze({ id: 'win2019-eval', label: 'Windows Server 2019', sizeGb: 5.3, bios: 'ovmf', selection: { key: '/IMAGE/INDEX', value: 2 } }),
  '2016': Object.freeze({ id: 'win2016-eval', label: 'Windows Server 2016', sizeGb: 6.5, bios: 'ovmf', selection: { key: '/IMAGE/INDEX', value: 2 } }),
  '2012': Object.freeze({ id: 'win2012r2-eval', label: 'Windows Server 2012', sizeGb: 4.3, bios: 'ovmf', selection: { key: '/IMAGE/INDEX', value: 2 } }),
  core11: Object.freeze({ id: 'core11', label: 'Tiny11 Core', sizeGb: 3.0, bios: 'ovmf', selection: { key: '/IMAGE/INDEX', value: 1 } }),
  tiny11: Object.freeze({ id: 'tiny11', label: 'Tiny11', sizeGb: 5.3, bios: 'ovmf', selection: { key: '/IMAGE/INDEX', value: 1 } }),
  tiny10: Object.freeze({ id: 'tiny10', label: 'Tiny10', sizeGb: 3.6, bios: 'ovmf', selection: { key: '/IMAGE/INDEX', value: 1 } })
})

/**
 * Aliases people type, plus the spellings the five-version list used to own.
 *
 * `ltsc11` (the old Windows-11-LTSC code), `win11`, `11p`, `'25'`, `win7` and
 * `windowsxp` all resolve, because a create that dies on "unknown version" for
 * a spelling the old backend accepted is a regression dressed as a typo. The
 * map is frozen and lower-cased at lookup time, so `Win11` works too.
 */
export const WINDOWS_VERSION_ALIASES = Object.freeze({
  '11p': '11', pro11: '11', win11: '11', windows11: '11', '11ltsc': '11l', ltsc11: '11l', win11l: '11l', 'win11-ltsc': '11l', '11iot': '11l', iot11: '11l', '11i': '11l',
  '10p': '10', pro10: '10', win10: '10', windows10: '10', '10ltsc': '10l', ltsc10: '10l', win10l: '10l', 'win10-ltsc': '10l', '10iot': '10l', iot10: '10l',
  '7': '7u', win7: '7u', win7u: '7u', windows7: '7u', '7e': '7u',
  xp32: 'xp', winxp: 'xp', winxp86: 'xp', windowsxp: 'xp',
  '25': '2025', win25: '2025', win2025: '2025', windows2025: '2025',
  '22': '2022', win22: '2022', win2022: '2022', windows2022: '2022',
  '19': '2019', win19: '2019', win2019: '2019', windows2019: '2019',
  '16': '2016', win16: '2016', win2016: '2016', windows2016: '2016',
  '2012r2': '2012', win2012: '2012', win2012r2: '2012', windows2012: '2012',
  'core 11': 'core11', tiny11core: 'core11', tiny11_core: 'core11',
  'tiny 11': 'tiny11', tiny_11: 'tiny11', 'tiny 10': 'tiny10', tiny_10: 'tiny10'
})

/** An Error that carries a machine-readable `code`, like the rest of the seam. */
function windowsCodeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * THE CANONICAL VERSION FOR A USER-SUPPLIED STRING (alias-aware).
 *
 * Case- and whitespace-tolerant, because " Windows 11 " is what a CLI argument
 * looks like after a shell hands it over. An EMPTY value is not an unknown
 * version: it is the ABSENCE of one, which is the operator-ISO path (`windowsIso`
 * with no version at all), so it passes through as '' and every resolver treats
 * it as "no version declared". A non-empty string that is neither a code nor an
 * alias throws with the full sixteen-code list — silently defaulting to Windows
 * 11 would install 8 GB of the wrong thing.
 */
export function canonicalWindowsVersion(version) {
  const raw = String(version ?? '').trim()
  if (raw === '') return ''
  const lowered = raw.toLowerCase().replace(/\s+/gu, ' ')
  const alias = WINDOWS_VERSION_ALIASES[lowered]
  const code = typeof alias === 'string' ? alias : lowered
  if (WINDOWS_CATALOG[code] !== undefined) return code
  throw new Error(`windowsVersion "${raw}" is not a Windows version this backend can create: expected one of ${WINDOWS_VERSIONS.join(', ')} (aliases such as ltsc11/win11/win7 also work), or give windowsIso instead.`)
}

/** The catalog row for a code (alias-aware); unknown → { code: 'unknown-version' }. */
export function windowsCatalogEntry(version) {
  const raw = String(version ?? '').trim()
  const lowered = raw.toLowerCase().replace(/\s+/gu, ' ')
  const alias = WINDOWS_VERSION_ALIASES[lowered]
  const code = typeof alias === 'string' ? alias : lowered
  const entry = code === '' ? undefined : WINDOWS_CATALOG[code]
  if (entry === undefined) {
    throw windowsCodeError('unknown-version', `unknown Windows version "${raw}": the catalog has ${WINDOWS_VERSIONS.length} codes — ${WINDOWS_VERSIONS.join(', ')}`)
  }
  return entry
}



/* ------------------------------------------------------------------ *
 * Where the install media come from — ordered strategy chains
 * ------------------------------------------------------------------ */

/**
 * WHY A CHAIN, AND WHY THIS ORDER.
 *
 * One pinned URL per version was always a bet on a Microsoft CDN keeping an
 * object alive. The bet lost: on 2026-11-15 four of the five URLs this module
 * used to carry answered HTTP 400, because the evaluation media moved behind a
 * session-token page. A single pinned URL that 400s is worse than no pin at
 * all — the first create of a version dies inside the download with a generic
 * error, after the quota has been reserved.
 *
 * So a version is a CHAIN, tried in order, each attempt cheap and each failure
 * named:
 *
 *   mido        Microsoft's own LIVE download page, driven by the four calls its
 *               own JavaScript makes (tags → mdt → reply → sku → link). This is
 *               the only strategy that yields an official, current media URL,
 *               so it goes first wherever the page still publishes one.
 *   midoDirect  the official static prss.microsoft.com object the page resolves
 *               to. Pinned with its byte count and SHA-256, so a substituted
 *               object is refused instead of installed.
 *   esd         the ESD catalog cab behind go.microsoft.com/fwlink. PRODUCTS ARE
 *               NOT INSTALLED FOR THIS: a catalog is only read when 7z or
 *               cabextract is ALREADY in PATH; otherwise the strategy reports
 *               `skipped: 'no cab extractor'` and the chain moves on.
 *   link1/2/6   pinned mirrors (bobpony, files.dog, archive.org). Last, because
 *               a mirror is somebody else's copy — and each is pinned with its
 *               byte count and digest so "somebody else's copy" is still the
 *               exact bytes this module expects.
 *
 * `bytes` and `sha256` are the ONLY trusted description of the file: the
 * download is checked against both, and an entry that legitimately does not know
 * its size (bytes: 0) or its digest (sha256: '') only skips THAT assertion —
 * never the ones it does know.
 */

/** One strategy descriptor. `bytes: 0` / `sha256: ''` mean "not known", not "any". */
const isoSource = (strategy, fields = {}) => Object.freeze({ strategy, bytes: 0, sha256: '', ...fields })

const ISO_SOURCE_CHAINS = Object.freeze({
  '11': Object.freeze([
    isoSource('mido', { label: 'live Microsoft page (ProductEditionId 3321, /en-us/software-download/windows11)', live: true, productId: '3321', page: 'https://www.microsoft.com/en-us/software-download/windows11' }),
    isoSource('esd', { label: 'ESD catalog via go.microsoft.com/fwlink?linkid=2156292', url: 'https://go.microsoft.com/fwlink?linkid=2156292', catalog: true }),
    isoSource('link1', { url: 'https://dl.bobpony.com/windows/11/en-us_windows_11_25h2_x64.iso', bytes: 6927149056, sha256: 'f5ffe9313eebc6299fba9e6eeb2971007264e6c6be013073a89b5ae9bd85bfb3' }),
    isoSource('link6', { url: 'https://archive.org/download/W11x64_26200.6584/26200.6584.250915-1905.25h2_ge_release_svc_refresh_CLIENT_CONSUMER_x64FRE_en-us.iso', bytes: 7736125440, sha256: 'd141f6030fed50f75e2b03e1eb2e53646c4b21e5386047cb860af5223f102a32' }),
    isoSource('midoDirect', { url: 'https://software-static.download.prss.microsoft.com/dbazure/888969d5-f34g-4e03-ac9d-1f9786c66749/26200.6584.250915-1905.25h2_ge_release_svc_refresh_CLIENT_CONSUMER_x64FRE_en-us.iso', bytes: 7736125440, sha256: 'd141f6030fed50f75e2b03e1eb2e53646c4b21e5386047cb860af5223f102a32' })
  ]),
  '11l': Object.freeze([
    isoSource('midoDirect', {
      url: 'https://software-static.download.prss.microsoft.com/dbazure/998969d5-f34g-4e03-ac9d-1f9786c66749/26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_IOT_LTSC_EVAL_x64FRE_en-us.iso',
      bytes: 5060020224,
      sha256: '2cee70bd183df42b92a2e0da08cc2bb7a2a9ce3a3841955a012c0f77aeb3cb29',
      probed: '2026-11-15: HTTP 206 (ranged GET)',
      selection: Object.freeze({ key: '/IMAGE/NAME', value: 'Windows 11 IoT Enterprise LTSC 2024 Evaluation', verified: true })
    }),
    isoSource('midoDirect', {
      url: 'https://software-static.download.prss.microsoft.com/dbazure/888969d5-f34g-4e03-ac9d-1f9786c66749/26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_LTSC_EVAL_x64FRE_en-us.iso',
      bytes: 5112850432,
      sha256: '67cec5865eaa037a72ddc633a717a10a2bed50778862267223ddb9c60ef5da68',
      selection: Object.freeze({ key: '/IMAGE/NAME', value: 'Windows 11 Enterprise LTSC 2024 Evaluation', verified: false })
    }),
    isoSource('link1', {
      url: 'https://dl.bobpony.com/windows/11/X23-81951_26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_ENTERPRISES_OEM_x64FRE_en-us.iso',
      bytes: 5144817664,
      sha256: '4f59662a96fc1da48c1b415d6c369d08af55ddd64e8f1c84e0166d9e50405d7a',
      selection: Object.freeze({ key: '/IMAGE/INDEX', value: 1 })
    }),
    isoSource('link6', {
      url: 'https://archive.org/download/Windows11LTSC/X23-81951_26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_ENTERPRISES_OEM_x64FRE_en-us.iso',
      bytes: 5144817664,
      sha256: '4f59662a96fc1da48c1b415d6c369d08af55ddd64e8f1c84e0166d9e50405d7a',
      selection: Object.freeze({ key: '/IMAGE/INDEX', value: 1 })
    })
  ]),
  '11e': Object.freeze([
    isoSource('esd', { label: 'ESD catalog via go.microsoft.com/fwlink?linkid=2156292', url: 'https://go.microsoft.com/fwlink?linkid=2156292', catalog: true }),
    isoSource('midoDirect', {
      url: 'https://software-static.download.prss.microsoft.com/dbazure/888969d5-f34g-4e03-ac9d-1f9786c66749/26200.6584.250915-1905.25h2_ge_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso',
      bytes: 7092807680,
      sha256: 'a61adeab895ef5a4db436e0a7011c92a2ff17bb0357f58b13bbc4062e535e7b9'
    })
  ]),
  '10': Object.freeze([
    isoSource('mido', { label: 'live Microsoft page (ProductEditionId 2618, /en-us/software-download/windows10ISO)', live: true, productId: '2618', page: 'https://www.microsoft.com/en-us/software-download/windows10ISO' }),
    isoSource('esd', { label: 'ESD catalog via go.microsoft.com/fwlink/?LinkId=841361', url: 'https://go.microsoft.com/fwlink/?LinkId=841361', catalog: true }),
    isoSource('link1', { url: 'https://dl.bobpony.com/windows/10/en-us_windows_10_22h2_x64.iso', bytes: 5723299840, sha256: '316f718f21fc9b386d81dadd62dc60268a1cfd65b184ac6a052875a454c3431b' }),
    isoSource('link6', { url: 'https://archive.org/download/windows-10-business-editions-version-22h2-updated-oct-2025-en-us/en-us_windows_10_business_editions_version_22h2_updated_oct_2025_x64_dvd_d2eef4b0.iso', bytes: 6985445376, sha256: '2c23bc8b95a9314f15ebff881dcbea49651f52a96a0327d7aaf523aa66043765' })
  ]),
  '10l': Object.freeze([
    isoSource('midoDirect', {
      url: 'https://software-download.microsoft.com/download/pr/19044.1288.211006-0501.21h2_release_svc_refresh_CLIENT_LTSC_EVAL_x64FRE_en-us.iso',
      bytes: 4898582528,
      sha256: 'e4ab2e3535be5748252a8d5d57539a6e59be8d6726345ee10e7afd2cb89fefb5',
      selection: Object.freeze({ key: '/IMAGE/INDEX', value: 1 })
    }),
    isoSource('link1', { url: 'https://dl.bobpony.com/windows/10/en-us_windows_10_enterprise_ltsc_2021_x64_dvd_d289cf96.iso', bytes: 4899461120, sha256: 'c90a6df8997bf49e56b9673982f3e80745058723a707aef8f22998ae6479597d' }),
    isoSource('link6', { url: 'https://archive.org/download/en-us_windows_10_enterprise_ltsc_2021_x64_dvd_d289cf96_202302/en-us_windows_10_enterprise_ltsc_2021_x64_dvd_d289cf96.iso', bytes: 4899461120, sha256: 'c90a6df8997bf49e56b9673982f3e80745058723a707aef8f22998ae6479597d' })
  ]),
  '10e': Object.freeze([
    isoSource('esd', { label: 'ESD catalog via go.microsoft.com/fwlink/?LinkId=841361', url: 'https://go.microsoft.com/fwlink/?LinkId=841361', catalog: true }),
    isoSource('midoDirect', {
      url: 'https://software-static.download.prss.microsoft.com/dbazure/988969d5-f34g-4e03-ac9d-1f9786c66750/19045.2006.220908-0225.22h2_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso',
      bytes: 5550497792,
      sha256: 'ef7312733a9f5d7d51cfa04ac497671995674ca5e1058d5164d6028f0938d668'
    })
  ]),
  '7u': Object.freeze([
    isoSource('link1', { url: 'https://dl.bobpony.com/windows/7/en_windows_7_with_sp1_x64.iso', bytes: 3320836096, sha256: '0b738b55a5ea388ad016535a5c8234daf2e5715a0638488ddd8a228a836055a1' }),
    isoSource('link2', { url: 'https://files.dog/MSDN/Windows%207/en_windows_7_ultimate_with_sp1_x64_dvd_u_677332.iso', bytes: 3320903680, sha256: '36f4fa2416d0982697ab106e3a72d2e120dbcdb6cc54fd3906d06120d0653808' }),
    isoSource('link6', { url: 'https://archive.org/download/win7-ult-sp1-english/Win7_Ult_SP1_English_x64.iso', bytes: 3320903680, sha256: '36f4fa2416d0982697ab106e3a72d2e120dbcdb6cc54fd3906d06120d0653808' })
  ]),
  xp: Object.freeze([
    isoSource('link1', { url: 'https://dl.bobpony.com/windows/xp/professional/en_windows_xp_professional_with_service_pack_3_x86_cd_x14-80428.iso', bytes: 617756672, sha256: '62b6c91563bad6cd12a352aa018627c314cfc5162d8e9f8af0756a642e602a46' }),
    isoSource('link2', { url: 'https://files.dog/MSDN/Windows%20XP/en_windows_xp_professional_with_service_pack_3_x86_cd_x14-80428.iso', bytes: 617756672, sha256: '62b6c91563bad6cd12a352aa018627c314cfc5162d8e9f8af0756a642e602a46' })
  ]),
  '2025': Object.freeze([
    isoSource('midoDirect', {
      url: 'https://software-static.download.prss.microsoft.com/dbazure/998969d5-f34g-4e03-ac9d-1f9786c66749/26100.32230.260111-0550.lt_release_svc_refresh_SERVER_EVAL_x64FRE_en-us.iso',
      bytes: 8152356864,
      sha256: '7b052573ba7894c9924e3e87ba732ccd354d18cb75a883efa9b900ea125bfd51',
      selection: Object.freeze({ key: '/IMAGE/INDEX', value: 2 })
    }),
    isoSource('midoDirect', {
      url: 'https://software-static.download.prss.microsoft.com/dbazure/888969d5-f34g-4e03-ac9d-1f9786c66749/26100.1742.240906-0331.ge_release_svc_refresh_SERVER_EVAL_x64FRE_en-us.iso',
      // SIZE UNKNOWN, DIGEST UNKNOWN: the object answered 206 on 2026-11-15 but
      // its total length was not read then, so this entry asserts neither. The
      // Content-Length of ITS OWN response is still authoritative at download.
      bytes: 0,
      sha256: '',
      probed: '2026-11-15: HTTP 206 (ranged GET)',
      selection: Object.freeze({ key: '/IMAGE/INDEX', value: 2 })
    }),
    isoSource('link1', {
      url: 'https://dl.bobpony.com/windows/server/2025/en-us_windows_server_2025_updated_oct_2025_x64_dvd_6c0c5aa8.iso',
      bytes: 7571058688,
      sha256: 'd273d0a85565ffbc06a3d46313f619103e2830a3373306ddbb9a08b8824f509d',
      selection: Object.freeze({ key: '/IMAGE/NAME', value: 'Windows Server 2025 SERVERSTANDARD', verified: true })
    }),
    isoSource('link6', {
      url: 'https://archive.org/download/en-us_windows_server_2025_updated_dec_2025_x64_dvd_c54ab58b/en-us_windows_server_2025_updated_dec_2025_x64_dvd_c54ab58b.iso',
      bytes: 8145395712,
      sha256: 'f3e277e75acdb793e6f08f4880b514ae0046cedf618c22f727890e54367075e6',
      selection: Object.freeze({ key: '/IMAGE/NAME', value: 'Windows Server 2025 SERVERSTANDARD', verified: true })
    })
  ]),
  '2022': Object.freeze([
    isoSource('midoDirect', {
      url: 'https://software-static.download.prss.microsoft.com/sg/download/888969d5-f34g-4e03-ac9d-1f9786c66749/SERVER_EVAL_x64FRE_en-us.iso',
      bytes: 5044094976,
      sha256: '3e4fa6d8507b554856fc9ca6079cc402df11a8b79344871669f0251535255325',
      selection: Object.freeze({ key: '/IMAGE/INDEX', value: 2 })
    }),
    isoSource('link1', {
      url: 'https://dl.bobpony.com/windows/server/2022/en-us_windows_server_2022_updated_oct_2025_x64_dvd_26e9af36.iso',
      bytes: 6023239680,
      sha256: '5d6d91efa972cbdd6701d78db1dcf6a34c7024ca931c1718e7cb3d0c6dd54e88',
      selection: Object.freeze({ key: '/IMAGE/NAME', value: 'Windows Server 2022 SERVERSTANDARD', verified: true })
    }),
    isoSource('link6', {
      url: 'https://archive.org/download/en-us_windows_server_2022_x64_dvd_620d7eac_202405/en-us_windows_server_2022_x64_dvd_620d7eac.iso',
      bytes: 5550684160,
      sha256: '5a077ee2a95976ef9f3623eb4040e25cdf7f8f01dee3b8165a32a7626f39f025',
      selection: Object.freeze({ key: '/IMAGE/NAME', value: 'Windows Server 2022 SERVERSTANDARD', verified: true })
    })
  ]),
  '2019': Object.freeze([
    isoSource('midoDirect', {
      url: 'https://software-download.microsoft.com/download/pr/17763.737.190906-2324.rs5_release_svc_refresh_SERVER_EVAL_x64FRE_en-us_1.iso',
      bytes: 5296713728,
      sha256: '549bca46c055157291be6c22a3aaaed8330e78ef4382c99ee82c896426a1cee1',
      selection: Object.freeze({ key: '/IMAGE/INDEX', value: 2 })
    }),
    isoSource('link1', {
      url: 'https://dl.bobpony.com/windows/server/2019/en-us_windows_server_2019_updated_aug_2021_x64_dvd_a6431a28.iso',
      bytes: 5575774208,
      sha256: '0067afe7fdc4e61f677bd8c35a209082aa917df9c117527fc4b2b52a447e89bb',
      selection: Object.freeze({ key: '/IMAGE/NAME', value: 'Windows Server 2019 SERVERSTANDARD', verified: true })
    }),
    isoSource('link6', {
      url: 'https://archive.org/download/en-us_windows_server_2019_x64_dvd_f9475476_202603/en-us_windows_server_2019_x64_dvd_f9475476.iso',
      bytes: 5651695616,
      sha256: 'ea247e5cf4df3e5829bfaaf45d899933a2a67b1c700a02ee8141287a8520261c',
      selection: Object.freeze({ key: '/IMAGE/NAME', value: 'Windows Server 2019 SERVERSTANDARD', verified: true })
    })
  ]),
  '2016': Object.freeze([
    isoSource('midoDirect', {
      url: 'https://software-download.microsoft.com/download/pr/Windows_Server_2016_Datacenter_EVAL_en-us_14393_refresh.ISO',
      bytes: 6972221440,
      sha256: '1ce702a578a3cb1ac3d14873980838590f06d5b7101c5daaccbac9d73f1fb50f',
      selection: Object.freeze({ key: '/IMAGE/INDEX', value: 2 })
    }),
    isoSource('link1', {
      url: 'https://dl.bobpony.com/windows/server/2016/en_windows_server_2016_updated_feb_2018_x64_dvd_11636692.iso',
      bytes: 6006587392,
      sha256: 'af06e5483c786c023123e325cea4775050324d9e1366f46850b515ae43f764be',
      selection: Object.freeze({ key: '/IMAGE/NAME', value: 'Windows Server 2016 SERVERSTANDARD', verified: true })
    }),
    isoSource('link6', {
      url: 'https://archive.org/download/en_windows_server_2016_updated_feb_2018_x64_dvd_11636692/en_windows_server_2016_updated_feb_2018_x64_dvd_11636692.iso',
      bytes: 6006587392,
      sha256: 'af06e5483c786c023123e325cea4775050324d9e1366f46850b515ae43f764be',
      selection: Object.freeze({ key: '/IMAGE/NAME', value: 'Windows Server 2016 SERVERSTANDARD', verified: true })
    })
  ]),
  '2012': Object.freeze([
    isoSource('midoDirect', {
      url: 'https://download.microsoft.com/download/6/2/A/62A76ABB-9990-4EFC-A4FE-C7D698DAEB96/9600.17050.WINBLUE_REFRESH.140317-1640_X64FRE_SERVER_EVAL_EN-US-IR3_SSS_X64FREE_EN-US_DV9.ISO',
      bytes: 4542291968,
      sha256: '6612b5b1f53e845aacdf96e974bb119a3d9b4dcb5b82e65804ab7e534dc7b4d5'
    }),
    isoSource('link1', { url: 'https://dl.bobpony.com/windows/server/2012r2/en_windows_server_2012_r2_with_update_x64_dvd_6052708-004.iso', bytes: 5397889024, sha256: 'f351e89eb88a96af4626ceb3450248b8573e3ed5924a4e19ea891e6003b62e4e' }),
    isoSource('link2', { url: 'https://files.dog/MSDN/Windows%20Server%202012%20R2%20with%20Update/en_windows_server_2012_r2_with_update_x64_dvd_6052708.iso', bytes: 5397889024, sha256: 'f351e89eb88a96af4626ceb3450248b8573e3ed5924a4e19ea891e6003b62e4e' }),
    isoSource('link6', { url: 'https://archive.org/download/en_windows_server_2012_r2_with_update_x64_dvd_6052708_202006/en_windows_server_2012_r2_with_update_x64_dvd_6052708.iso', bytes: 5397889024, sha256: 'f351e89eb88a96af4626ceb3450248b8573e3ed5924a4e19ea891e6003b62e4e' })
  ]),
  core11: Object.freeze([
    isoSource('link6', { url: 'https://archive.org/download/tiny11_25H2/tiny11core_25H2_Nov25.iso', bytes: 3304132608, sha256: 'c0e0252b24144b8defb6c7ded2bc09f9297daf1fb8369b16c5b85382331eb47f' })
  ]),
  tiny11: Object.freeze([
    isoSource('link6', { url: 'https://archive.org/download/tiny11_25H2/tiny11_25H2_Nov25.iso', bytes: 5730246656, sha256: '7b24815845684add7250808b3b0027ba4e94cf52c62e9ef40d5b965dd304d6ca' })
  ]),
  tiny10: Object.freeze([
    isoSource('link6', { url: 'https://archive.org/download/tiny-10-23-h2/tiny10%20x64%2023h2.iso', bytes: 3839819776, sha256: 'a11116c0645d892d6a5a7c585ecc1fa13aa66f8c7cc6b03bf1f27bd16860cc35' })
  ])
})

/**
 * THE PUBLIC TABLE, one row per code.
 *
 * `url`/`bytes`/`sha256` at the top level are the COMPAT view: the supervisor
 * reserves quota from `.url` and keeps the pinned media alive with it, and it
 * must stay a value a synchronous caller can download. So they name the first
 * STATIC url in the chain — a `mido` or `esd` strategy has no url until it has
 * been resolved, which needs the network and therefore cannot be a `.url`.
 * `sources` is the real, ordered chain that ensureIsoForSource() walks.
 */
export const WINDOWS_ISO_SOURCES = Object.freeze(Object.fromEntries(
  WINDOWS_VERSIONS.map((code) => {
    const entry = WINDOWS_CATALOG[code]
    const sources = ISO_SOURCE_CHAINS[code] ?? []
    const direct = sources.find((source) => typeof source.url === 'string' && source.url !== '' && source.live !== true && source.catalog !== true)
    return [code, Object.freeze({
      code,
      label: entry.label,
      sizeGb: entry.sizeGb,
      url: direct?.url ?? null,
      bytes: direct?.bytes ?? 0,
      sha256: direct?.sha256 ?? '',
      sources: Object.freeze(sources)
    })]
  })
))

/**
 * The ordered chain for a version, with the environment-dependent strategies
 * annotated (ESD without a cab extractor is `skipped`, not attempted).
 *
 * A REFUSED version refuses HERE: this is the one synchronous gate every create
 * passes through before bytes move (the create itself lives in the supervisor,
 * which calls resolveWindowsIso()). XP is refused with its catalog detail, and
 * the error still carries `.sources` so a caller can inspect the chain it will
 * not download.
 */
export function resolveWindowsIsoSources(version) {
  const entry = windowsCatalogEntry(version)
  const code = canonicalWindowsVersion(version)
  if (typeof entry.refusal === 'string') {
    const error = windowsCodeError(entry.refusal, `${entry.label} cannot be installed by this backend: ${entry.refusalDetail}`)
    error.detail = entry.refusalDetail
    error.sources = WINDOWS_ISO_SOURCES[code].sources
    throw error
  }
  return WINDOWS_ISO_SOURCES[code].sources.map((source) => {
    const copy = { ...source, code }
    if (source.strategy === 'esd' && cabExtractor() === '') copy.skipped = 'no cab extractor'
    return copy
  })
}

/**
 * Resolve a version to a DIRECTLY DOWNLOADABLE source, or explain precisely why
 * there is none. Called BEFORE any download so the refusal is cheap and
 * actionable.
 *
 * It returns the first STATIC url in the chain (see WINDOWS_ISO_SOURCES `.url`):
 * the live `mido` strategy needs an async handshake and belongs to
 * ensureIsoForSource(). When nothing static exists the error is
 * `no-public-link` and names both remediations.
 */
export function resolveWindowsIso(version) {
  const code = canonicalWindowsVersion(version)
  const entry = windowsCatalogEntry(version)
  const sources = resolveWindowsIsoSources(version)
  const chosen = sources.find((source) => typeof source.url === 'string' && source.url !== '' && source.live !== true && source.catalog !== true && source.skipped === undefined)
  if (chosen === undefined) {
    const error = windowsCodeError('no-public-link', `windowsVersion "${code}" (${entry.label}) has no public direct ISO link: Microsoft serves it from a session-token page. `
      + 'Pass windowsIso instead — either a direct https URL, or a local .iso file inside the VM store or the workspace. '
      + `Versions with a pinned, probed link: ${WINDOWS_VERSIONS.filter((key) => WINDOWS_ISO_SOURCES[key].url !== null).join(', ') || 'none'}.`)
    error.code = 'no-public-link'
    throw error
  }
  return { ...chosen, entry, code, url: chosen.url }
}

/** Floors a Windows install does not survive below (same as the old backend). */
export const WINDOWS_MIN_MEMORY_GB = 6
export const WINDOWS_MIN_DISK_GB = 64
export const WINDOWS_MIN_CPU = 2
export const WINDOWS_DEFAULT_CPU = 2
export const WINDOWS_DEFAULT_MEMORY_GB = 6
export const WINDOWS_DEFAULT_DISK_GB = 64
export const WINDOWS_USERNAME = 'cua'

/** Which QEMU this module drives. The system build is the only one with OVMF.** */
export const WINDOWS_QEMU = process.env.DSH_CUA_WINDOWS_QEMU || '/usr/bin/qemu-system-x86_64'
/** OVMF code image (read-only) and the template for the per-VM vars store. */
export const OVMF_CODE = process.env.DSH_CUA_WINDOWS_OVMF_CODE || '/usr/share/OVMF/OVMF_CODE_4M.fd'
export const OVMF_VARS_TEMPLATE = process.env.DSH_CUA_WINDOWS_OVMF_VARS || '/usr/share/OVMF/OVMF_VARS_4M.fd'
/** swtpm (TPM2 emulator) — a software TPM, no hardware needed. */
export const SWTPM = process.env.DSH_CUA_WINDOWS_SWTPM || '/usr/bin/swtpm'
/** Optional virtio-win drivers ISO (see attachDrivers()). */
export const VIRTIO_WIN_ISO = process.env.DSH_CUA_WINDOWS_VIRTIO_ISO || ''

/** The kill switch: DSH_CUA_VM_WINDOWS=0 removes the option entirely. */
export function windowsEnabled() {
  return String(process.env.DSH_CUA_VM_WINDOWS ?? '1') !== '0'
}

/* ------------------------------------------------------------------ *
 * D3: DID THE INSTALLED DISK ACTUALLY BOOT?
 * ------------------------------------------------------------------ */

/**
 * THE POST-INSTALL BOOT, AS THE FIRMWARE PRINTS IT.
 *
 * A Windows guest writes NOTHING to the serial console (its EMS/SPCR output is
 * off — we never run `bcdedit /ems`), so the serial log is OVMF's own boot
 * narration. That is still enough to know which disk booted: OVMF prints the
 * boot option it is about to use, and the user-reported line was
 *
 *   Boot0004 "Windows Boot Manager" ... HD(1,GPT,...)
 *
 * `Windows Boot Manager` is an entry that only exists after Setup wrote a BCD to
 * the system disk's ESP — the install CD is described as a DVD-ROM. So the
 * presence of that description is the "the installed disk is booting" signal,
 * and it is the SAME signal the user read off the console.
 *
 * WHY THIS MATTERS (D3): the watcher used to complete on the SSH banner ONLY, so
 * a successful install that never got OpenSSH looked identical to Setup still
 * running — the panel said "installing (35 min)" next to a booted desktop and
 * the 60-minute timeout would have marked it `error`. With this signal the row
 * can say "booted, waiting for OpenSSH", which is both true and actionable.
 */
export const WINDOWS_HD_BOOT_PATTERN = /Boot[0-9A-F]{4}[^\n]*Windows Boot Manager/iu

/**
 * The BDS "loading BootNNNN" line, used as a weaker second signal when the
 * description and the device are on different lines. It only counts together
 * with a HARD DISK hint (`HD(1,GPT`, `HD(2,MBR`, QEMU's own disk model), so a
 * CD/DVD boot can never be read as an installed-disk boot.
 */
export const WINDOWS_HD_LOADING_PATTERN = /loading Boot[0-9A-F]{4}/iu
export const WINDOWS_HD_DEVICE_PATTERN = /HD\([0-9]+,(?:GPT|MBR)|QEMU HARDDISK/iu

/**
 * True when the serial log shows the INSTALLED disk booting.
 *
 * Pure and exported: the watcher's done-detection is the thing that regressed,
 * so it must be unit-testable without a Windows install.
 */
export function windowsBootedFromDisk(serialText) {
  const text = String(serialText ?? '')
  if (text === '') return false
  if (WINDOWS_HD_BOOT_PATTERN.test(text)) return true
  return WINDOWS_HD_LOADING_PATTERN.test(text) && WINDOWS_HD_DEVICE_PATTERN.test(text)
}

/** The stage of a Windows install, from its serial log. */
export function windowsInstallStageFromSerial(serialText) {
  return windowsBootedFromDisk(serialText) ? 'booted' : 'installing'
}

/**
 * D3/D5: THE TWO SENTENCES THE PANEL MUST PRINT VERBATIM.
 *
 * They are constants, not template text, because the user asked for the exact
 * words and a future edit must not paraphrase them by accident. Both say what is
 * TRUE and what to DO — the old "still installing" line next to a running
 * desktop said neither.
 */
export const WINDOWS_BOOTED_DETAIL = 'Windows booted from the installed disk; waiting for OpenSSH (installed by firstboot) — if this never answers, firstboot failed (see the Unattend.vbs error on the desktop)'
export const WINDOWS_SSH_MISSING_DETAIL = 'OpenSSH did not answer — the firstboot script likely failed; use the noVNC view to check, and Force delete + recreate to retry'

/**
 * AFTER THE DISK BOOTS, HOW LONG OPENSSH GETS BEFORE THE ROW SAYS SO.
 *
 * The 60-minute install window is measured from the START of Setup and is about
 * DISK WORK. Once the installed disk boots, the remaining work is firstboot
 * (OpenSSH, a python installer download, pip) — a different clock, and one the
 * old elapsed-minutes check would have cut short: a slow install that booted at
 * minute 55 had five minutes left to finish provisioning. Five minutes is long
 * enough to call it missing, short enough to tell the user before the hard stop.
 */
export const WINDOWS_SSH_MISSING_MINUTES = 5

/**
 * THE INSTALL PROGRESS SENTENCE — pure, so it can be asserted without a VM.
 *
 * WHAT WENT WRONG (user report): the panel showed
 *   `installing (10 min): undefined answering, QMP not running`
 * and the store really was mid-install. Two independent defects produced that
 * one line, and both are why this function exists rather than a template string
 * at the call site:
 *
 *   1. `verdict.endpoint` was `undefined`. The readiness probe dialled a port
 *      field that does not exist on a registry row (`spec.sshPort` vs
 *      `ports.ssh`), threw inside `probe()`, and `ready()` returned early —
 *      before it ever set `endpoint: 'none'`. Interpolating the raw field put
 *      the word "undefined" into a user-facing sentence.
 *   2. `QMP not running` was a LIE about a live QEMU: `status` was '' because
 *      the same bad port threw, and `'' || 'not running'` collapsed "the
 *      monitor did not answer" into "there is no monitor".
 *
 * So: no raw field ever reaches the text (`text()` + `endpointLabel()`), QMP has
 * three named states instead of two, and during Setup the sentence names what is
 * ACTUALLY being watched — the serial log and QMP — because SSH cannot answer
 * until the answer file has installed OpenSSH.
 *
 * @param {object} input
 * @param {'install'|'running'} [input.phase]        which readiness phase
 * @param {object} [input.verdict]                   windowsBackend.ready()'s answer
 * @param {number} [input.elapsedMinutes]            minutes since this attempt started
 * @param {string|string[]} [input.serialTail]       the last serial-log lines (already read)
 * @param {'installing'|'booted'} [input.installStage] D3: Setup running, or the installed disk booted
 * @param {number} [input.bootedMinutes]             minutes since the installed disk booted
 */
export function formatWindowsInstallDetail({ phase = 'install', verdict = {}, elapsedMinutes = 0, serialTail = '', sshPort = 0, installStage = 'installing', bootedMinutes = 0 } = {}) {
  // D3/D5: ONCE THE INSTALLED DISK BOOTS, THE SENTENCE IS ABOUT FIRSTBOOT, NOT
  // ABOUT SETUP. It is the exact text the user asked for (see the constants),
  // and it has its own 5-minute threshold: past it the honest answer is "the
  // firstboot script failed", with the two things a human can do about it.
  // THE STAGE MAY ARRIVE INSIDE THE VERDICT. The watcher passes ONE object
  // (`{ phase: 'install', verdict, elapsedMinutes, serialTail }`) and keeps the
  // stage on `verdict.installStage`, so its call site stays one line and the
  // deadline it computed is the stage this sentence describes.
  const stage = installStage === 'booted' || verdict?.installStage === 'booted' ? 'booted' : 'installing'
  const sinceBoot = Number(bootedMinutes) > 0 ? Math.round(Number(bootedMinutes)) : (Number(verdict?.bootedMinutes) > 0 ? Math.round(Number(verdict.bootedMinutes)) : 0)
  if (stage === 'booted') {
    return sinceBoot >= WINDOWS_SSH_MISSING_MINUTES
      ? WINDOWS_SSH_MISSING_DETAIL
      : WINDOWS_BOOTED_DETAIL
  }
  const minutes = Number(elapsedMinutes) > 0 ? Math.round(Number(elapsedMinutes)) : 0
  const qmp = qmpStateLabel(verdict)
  const endpoint = endpointLabel(verdict)
  const tail = windowsTailLines(serialTail, 5)
  const port = Number(sshPort) > 0 ? Number(sshPort) : (Number(verdict?.sshPort) > 0 ? Number(verdict.sshPort) : 0)
  // F4: THE TWO HONEST HEADLINES. `ready()` early-returns WITHOUT an endpoint
  // when the QEMU process is not alive (or is not `running`), and the old
  // template then interpolated the missing field straight into the panel:
  // "installing (10 min): undefined answering, QMP not running" — a sentence
  // that was wrong twice (there was no endpoint, and the empty QMP status became
  // "not running" even for a live guest). Each state now gets its own words.
  const dead = verdict?.alive === false
  const waiting = !dead && qmp !== 'running'
  const watched = phase === 'install'
    // SSH IS NOT EXPECTED YET during Setup — saying "no SSH yet" (or worse,
    // interpolating a missing endpoint) reads like a failure, when the guest is
    // simply still inside Windows Setup.
    ? 'watching the serial-log tail + QMP (the SSH banner cannot answer until the answer file has installed OpenSSH)'
    : 'watching QMP + the SSH banner'
  const headline = dead
    ? `QEMU not alive (see qemu-stderr.log tail)`
    : `QMP ${qmp}${waiting ? '' : ', guest running'}`
  const signals = `ready when the SSH banner answers AND QMP says running (now: ${endpoint}, QMP ${qmp})`
  const where = !dead && endpoint === 'no endpoint yet' && port > 0
    ? ` waiting for SSH on 127.0.0.1:${port}`
    : ''
  const beyond = 'then the badge flips to Ready and /vm/port/<name>/ becomes the noVNC stream you can drive'
  const head = `installing (${minutes} min): ${headline}. ${watched}. ${signals};${where} ${beyond}.`
  // LAST LINE OF DEFENCE: no raw field can put the word in the sentence.
  const text = tail.length === 0
    ? `${head} Serial log: no lines yet (Windows Setup has not printed to the serial console).`
    : `${head} Serial log (last ${tail.length}): ${tail.join(' | ')}`
  return text.replace(/\bundefined\b/gu, 'unknown')
}

/** `running` / `paused` / `not answering` / `no qemu` — never an empty string. */
export function qmpStateLabel(verdict = {}) {
  const record = verdict && typeof verdict === 'object' ? verdict : {}
  if (record.alive === false) return 'no qemu'
  const explicit = typeof record.qmp === 'string' ? record.qmp.trim() : ''
  if (explicit !== '') return explicit
  const status = typeof record.status === 'string' ? record.status.trim() : ''
  return status === '' ? 'not answering' : status
}

/** `ssh` / `vnc` / `none` — the endpoint never reads as "undefined". */
export function endpointLabel(verdict = {}) {
  const record = verdict && typeof verdict === 'object' ? verdict : {}
  const value = typeof record.endpoint === 'string' ? record.endpoint.trim() : ''
  return value === '' || value === 'none' ? 'no endpoint yet' : value
}

/** The last `count` NON-EMPTY lines of a serial tail, as an array. */
export function windowsTailLines(serialTail, count = 5) {
  const limit = Math.max(1, Math.min(40, Number(count) || 5))
  const lines = Array.isArray(serialTail)
    ? serialTail
    : String(serialTail ?? '').split('\n')
  return lines.map((line) => String(line).trim()).filter((line) => line !== '').slice(-limit)
}

/**
 * The readiness contract, spelled once: the payload and the tool text both read
 * it from here, so "how do I know it finished" cannot drift between the panel
 * and the model.
 */
export function windowsReadinessSignals(name = '<name>') {
  return {
    signals: ['the guest SSH banner answers', 'QMP says running'],
    onReady: `the panel badge flips to Ready, and /vm/port/${name}/ becomes the noVNC stream you can drive`,
    watchedDuringInstall: ['serial-log tail', 'QMP query-status', 'SSH banner (not expected until the answer file has installed OpenSSH)']
  }
}

/* ------------------------------------------------------------------ *
 * QEMU's OWN DIAGNOSTICS: capture, classify, and degrade honestly
 * ------------------------------------------------------------------ */

/**
 * HOW LONG A START MUST SURVIVE BEFORE IT COUNTS.
 *
 * A QEMU that dies during init leaves exactly the fingerprint the user reported:
 * the spawn succeeded (a pid existed for a moment), `qemu.pid` was NEVER written
 * (QEMU writes it after its init), the serial log stayed 0 bytes (the guest never
 * spoke) and the supervisor watched a dead computer for the full 60-minute
 * install timeout. Fifteen seconds is the honest window: a QEMU that is going to
 * boot writes its pidfile in well under a second, so waiting the whole window is
 * only ever paid by a start that is already dead.
 *
 * Overridable so the smoke suite can exercise the SAME code without spending 15 s
 * per case (a test that stubs the timer would not be testing this code).
 *
 * UNSET IS NOT ZERO. The previous version did `Number(process.env.X ?? '')`,
 * which turns an UNSET variable into `Number('') === 0`; `0 >= 0` then passed and
 * the function returned 0 ms — the fallback was unreachable, so the default boot
 * window on every real host was 0 ms. `waitForQemuBoot` polled once against an
 * already-expired deadline and declared a QEMU that was ~1 ms old dead ("died
 * during init (none): no stderr output"). The raw string is inspected FIRST:
 * only a non-empty value is parsed, so unset and '' both reach the 15000 default.
 */
export function qemuBootWindowMs() {
  const raw = process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(120000, Math.max(0, Math.trunc(parsed)))
  }
  return 15000
}

/**
 * R1: THE "PRESS ANY KEY TO BOOT FROM CD OR DVD" WINDOW.
 *
 * VERIFIED LIVE: OVMF boots the install CD, `cdboot.efi 10.0.26100.1` prints
 * "Press any key to boot from CD or DVD", nobody presses a key, `cdboot` waits
 * ~5 s, prints `EFI_TIMEOUT`, and BDS falls through to the EFI Internal Shell —
 * a dead end with a firmware prompt no unattended install can leave.
 *
 * So the backend presses the key itself, over the same QMP input path the GUI
 * uses. The delay list below is the FALLBACK: three points inside that window
 * (1.5 s / 3.5 s / 5.5 s by default), overridable for tests and for a host
 * whose firmware is slower.
 *
 * F2: WHY A FIXED SCHEDULE WAS NOT ENOUGH (VERIFIED LIVE, inside the guest).
 * The forensic child proved the FIRST boot missed the ~3 s window entirely: the
 * presses at 1.5 / 3.5 / 5.5 s after spawn landed while OVMF was still
 * enumerating devices, so `cdboot.efi` printed its prompt to a keyboard nobody
 * had touched yet and timed out. Wall-clock delays are measured from SPAWN, but
 * the window opens when the FIRMWARE reaches the CD — a variable ~2-6 s.
 *
 * So the schedule is anchored on SERIAL ACTIVITY (`serial.log`): the watcher
 * polls the file's size (cheap stat) and its tail, and fires the presses when
 * the log carries the cdboot prompt signature ("Press any key to boot from CD"
 * or "BdsDxe: starting Boot0001"), or — for a firmware that prints neither —
 * once output has appeared and `armDelayMs` (~1.5 s) has passed since it did.
 * From that anchor the presses repeat every 0.8 s: a prompt anchor stops after
 * `attempts` = 3, a growth anchor retries until the ~8 s window closes (a guess
 * must not be the last press). The fixed-time list above is the fallback, and it
 * runs in two cases only: the detection window closes with no anchor at all
 * (console silent), replayed with its own relative gaps; or QEMU never created
 * the serial log, where the offsets run exactly as before.
 *
 * NOT a keystroke into an installed guest: scheduling is gated on
 * `installPending`, so a normal boot of a finished disk never sees a key.
 */
export function cdbootKeyScheduleMs() {
  const raw = process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS
  if (raw !== undefined && raw !== '') {
    const parsed = String(raw)
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .map((value) => Math.min(120000, Math.trunc(value)))
    if (parsed.length > 0) return parsed
  }
  return [1500, 3500, 5500]
}

/**
 * F2: THE SIGNATURE OF THE CDBOOT PROMPT, AS THE FIRMWARE PRINTS IT.
 *
 * Two spellings are accepted because two firmwares are in play on this path:
 * the install CD's `cdboot.efi` prints "Press any key to boot from CD or DVD",
 * and OVMF's BDS announces the same boot attempt as "BdsDxe: starting
 * Boot0001" (the CD's boot entry while `installPending`). Matching either
 * anchors the key schedule on real serial activity instead of on a spawn-
 * relative timer that was measured against the wrong event.
 */
export const CDBOOT_PROMPT_PATTERN = /Press any key to boot from CD|BdsDxe:\s*starting Boot0001/iu

/** True when a serial tail carries the cdboot prompt (or BDS naming the CD). */
export function cdbootPromptSeen(text) {
  return CDBOOT_PROMPT_PATTERN.test(String(text ?? ''))
}

/**
 * F2: the last `bytes` bytes of a file, or '' when it is missing/empty/shorter.
 *
 * Deliberately small and allocation-light: the watcher calls it every poll on a
 * file the guest is appending to, so it stats first and reads only the tail
 * (the prompt is near the end of what cdboot writes, and the log can grow to
 * megabytes once Setup starts).
 */
export function readSerialTail(file, bytes = 8192) {
  const limit = Math.max(1, Math.min(262144, Number(bytes) || 8192))
  try {
    const { size } = statSync(file)
    if (!(size > 0)) return ''
    const start = Math.max(0, size - limit)
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(size - start)
      readSync(fd, buffer, 0, buffer.length, start)
      return buffer.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

/**
 * R1/F2 (the mechanism): press Enter for the cdboot prompt, ANCHORED ON THE
 * PROMPT ITSELF, and RE-ARMED when the firmware loops the CD boot again.
 *
 * WHY THE OLD ANCHOR WAS WRONG (verified against a real QEMU): the watcher took
 * "the first byte ever written to serial.log" as its anchor and pressed 1.5 s
 * later. The first bytes are OVMF's banner at ~0.2 s, so the presses landed at
 * ~1.7-7.4 s while `cdboot.efi` had not even started — and cdboot's "Press any
 * key to boot from CD or DVD" appeared seconds later, unanswered, until it
 * printed EFI_TIMEOUT and BDS fell into the EFI Shell. The prompt branch existed
 * but could only win by accident: it was reached only when the prompt text was
 * already in the tail BEFORE first-output + 1.5 s, which is almost never.
 *
 * THE SHAPE NOW:
 *
 *   1. WATCH THE PROMPT, not the banner. `readSerialTail()` (the tail, not the
 *      whole log) is polled every ~300 ms for `CDBOOT_PROMPT_PATTERN`, for up to
 *      `maxWindowMs` (~90 s from the call site). The press sequence starts on
 *      the poll that SEES the prompt, not on a spawn-relative guess.
 *   2. RE-ARM. BDS re-loops the CD boot when the first attempt is not answered
 *      (and a re-loop reprints the prompt). After a cycle the watcher keeps
 *      polling, and a prompt in output that ARRIVED AFTER the previous cycle
 *      starts another cycle — bounded by `cycles` (12 at the call site) and by
 *      `watchMs`, and stopped the moment `isAlive()` says the QEMU is gone.
 *   3. DELIVERY IS PART OF THE PRESS. A monitor that refuses the event answers
 *      `{error: …}` — a RESOLVED value, not a throw — so a press is only
 *      reported as pressed when the QMP reply carries no error. A refused press
 *      is logged as `could not press … : <error>` and the next attempt covers it.
 *
 * `sendKey`, `wait`, `now` and `readSerial` are INJECTED so the suite can prove
 * the schedule against a stubbed serial timeline (prompt at 4 s → presses at
 * ~4.2/5.0/5.8 s; a silent console → the fixed-time fallback) without a
 * hypervisor or a real clock.
 *
 * Modes:
 *   * NO serial source: the original fixed-time loop, byte for byte.
 *   * WITH one: prompt-anchored presses. The GROWTH anchor (first output +
 *     `armDelayMs`) survives only for a caller that opts into it — `armDelayMs
 *     <= 0` disables it — because for this guest it is the guess that was
 *     measured wrong. When no prompt appears inside `maxWindowMs`, the fixed
 *     list is replayed with its own relative gaps and logged as the fallback.
 *
 * A failed or refused send never throws and never stops the schedule: this is
 * background belt-and-braces, not a boot precondition.
 */
export async function runCdbootKeys({
  scheduleMs = cdbootKeyScheduleMs(),
  serialLog = null,
  readSerial = null,
  pollMs = 300,
  armDelayMs = 1500,
  retryGapMs = 800,
  attempts = 3,
  maxWindowMs = 8000,
  cycles = 1,
  watchMs = 0,
  isAlive = null,
  now = null,
  sendKey,
  wait,
  log = () => {},
  key = 'enter',
  name = '<name>'
} = {}) {
  const delays = (Array.isArray(scheduleMs) ? scheduleMs : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b)
  const sleep = typeof wait === 'function' ? wait : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const clock = typeof now === 'function' ? now : () => Date.now()
  const startedAt = clock()
  const elapsed = () => Math.max(0, Math.round(clock() - startedAt))
  const reader = typeof readSerial === 'function'
    ? readSerial
    : (typeof serialLog === 'string' && serialLog !== '' ? () => readSerialTail(serialLog) : null)
  const poll = Math.max(1, Math.min(2000, Number(pollMs) || 300))
  const gap = Math.max(0, Math.min(120000, Number(retryGapMs) || 0))
  // `armDelayMs <= 0` DISABLES the growth anchor (see the header): the call site
  // passes 0 because a real cdboot prints the prompt, and pressing before it
  // appears is the bug this function now exists to not repeat.
  const armAfter = Math.max(0, Math.min(120000, Number(armDelayMs) || 0))
  const growthAnchorEnabled = Number(armDelayMs) > 0
  const window = Math.max(0, Math.min(180000, Number(maxWindowMs) || 0))
  const totalAttempts = Math.max(1, Math.min(20, Math.trunc(Number(attempts) || 1)))
  const maxCycles = Math.max(1, Math.min(64, Math.trunc(Number(cycles) || 1)))
  const watchLimit = Math.max(0, Math.min(3600000, Number(watchMs) || 0))
  const sent = []
  const press = async (reason, at) => {
    try {
      const result = await sendKey(key)
      // A monitor that REFUSES the event answers `{error: …}` as a RESULT. The
      // old code only caught throws, so a refused press was logged as "pressed"
      // — the schedule looked healthy while nothing reached the keyboard.
      const refused = cdbootPressFailure(result)
      if (refused !== null) {
        log(`windows: ${name} could not press ${key} at ~${Math.round(at)} ms ${reason} (not fatal, the next attempt covers it): ${refused}`)
        return false
      }
      sent.push(Math.round(at))
      log(`windows: ${name} pressed ${key} at ~${Math.round(at)} ms ${reason} to get past "Press any key to boot from CD or DVD"`)
      return true
    } catch (error) {
      log(`windows: ${name} could not press ${key} at ~${Math.round(at)} ms ${reason} (not fatal, the next attempt covers it): ${error?.message ?? error}`)
      return false
    }
  }

  // NO SERIAL SOURCE: the historical behaviour, byte for byte.
  if (reader === null) {
    let previous = 0
    for (const at of delays) {
      const delay = Math.max(0, at - previous)
      previous = Math.max(previous, at)
      try {
        await sleep(delay)
      } catch {
        return sent
      }
      await press('(fixed-time schedule)', at)
    }
    return sent
  }

  const serialFile = typeof serialLog === 'string' && serialLog !== '' ? serialLog : null
  const serialFilePresent = () => {
    if (serialFile === null) return true
    try {
      statSync(serialFile)
      return true
    } catch {
      return false
    }
  }
  /** The log's SIZE, or null for an injected reader (no file to stat). */
  const serialSize = () => {
    if (serialFile === null) return null
    try {
      return statSync(serialFile).size
    } catch {
      return null
    }
  }
  const readTail = () => {
    try {
      return String(reader() ?? '')
    } catch {
      return ''
    }
  }
  const alive = () => (typeof isAlive === 'function' ? isAlive() === true : true)
  const outOfWatch = () => watchLimit > 0 && elapsed() >= watchLimit

  // REPLAY THE FIXED SCHEDULE WITH ITS OWN RELATIVE GAPS, starting now. The
  // nominal offsets are kept in the log line so the fallback is never mistaken
  // for an anchored press.
  const replayFixed = async (reason) => {
    let previousAt = null
    for (const at of delays) {
      const gapMs = previousAt === null ? 0 : Math.max(0, at - previousAt)
      previousAt = at
      if (gapMs > 0) {
        try {
          await sleep(gapMs)
        } catch {
          return sent
        }
      }
      await press(reason, at)
    }
    return sent
  }

  /**
   * Wait for an anchor. `null` means the window closed with none.
   *
   * The prompt wins over everything: `cdbootPromptSeen` is checked BEFORE the
   * growth anchor on every poll, so the first press can never fire on the
   * banner while the prompt is still megabytes of serial log away.
   */
  const detectAnchor = async () => {
    let firstGrowthAt = null
    for (;;) {
      const t = elapsed()
      const text = readTail()
      if (text.length > 0 && firstGrowthAt === null) firstGrowthAt = t
      if (cdbootPromptSeen(text)) return { at: t, reason: '(serial: cdboot prompt seen)', prompt: true, text }
      if (growthAnchorEnabled && firstGrowthAt !== null && t - firstGrowthAt >= armAfter) {
        return { at: t, reason: `(serial: boot output seen at ~${firstGrowthAt} ms)`, prompt: false, text }
      }
      // NO CONSOLE AT ALL: QEMU was told `-serial file:` but never created the
      // file (a stub, or a QEMU that never got that far). Nothing can ever be
      // anchored, so the historical schedule takes over — its first offset is
      // the grace period a real QEMU needs to open the file.
      if (firstGrowthAt === null && !serialFilePresent() && t >= (delays[0] ?? 1500)) {
        return { at: t, reason: '(fixed-time schedule: no serial console)', noConsole: true, text }
      }
      if (t >= window) return null
      const step = Math.max(1, Math.min(poll, window - t))
      try {
        await sleep(step)
      } catch {
        return null
      }
    }
  }

  /**
   * One press cycle from an anchor.
   *
   * A PROMPT anchor is certain, so `attempts` presses cover a dropped event. A
   * GROWTH anchor is only a guess, so it keeps retrying every `retryGapMs` until
   * the window closes — an early press must never be the last one.
   */
  const pressCycle = async (anchor, cycle) => {
    const promptAnchored = anchor.prompt === true
    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 0) {
        try {
          await sleep(gap)
        } catch {
          return
        }
      }
      await press(anchor.reason, elapsed())
      if (!alive()) return
      // CYCLE 1 keeps the historical bounds exactly (the fallback window for a
      // guess anchor); a RE-ARMED cycle is already inside the prompt, so it gets
      // the same bounded `attempts` a prompt anchor gets.
      const finished = promptAnchored || cycle > 1 ? attempt + 1 >= totalAttempts : elapsed() + gap > window
      if (finished) break
    }
  }

  /**
   * Wait for a prompt that ARRIVED AFTER the previous cycle.
   *
   * "After" is a byte offset, not a timestamp: the prompt we already answered is
   * still in the tail (`readSerialTail` returns the last 8 KB), so matching the
   * text alone would re-fire on the SAME line forever. When the reader is
   * injected there is no size to compare, and the text itself must change.
   */
  const waitForNextPrompt = async ({ afterSize, afterText, afterAt }) => {
    for (;;) {
      if (!alive() || outOfWatch()) return null
      const t = elapsed()
      const text = readTail()
      const size = serialSize()
      const changed = size === null || afterSize === null ? text !== afterText : size > afterSize
      if (changed && t > afterAt && cdbootPromptSeen(text)) {
        return { at: t, reason: '(serial: cdboot prompt seen again)', prompt: true, text }
      }
      if (t - afterAt > (window > 0 ? window : 60000)) return null
      try {
        await sleep(poll)
      } catch {
        return null
      }
    }
  }

  let anchor = await detectAnchor()
  if (anchor === null) return replayFixed('(fixed-time fallback: the prompt never appeared)')
  if (anchor.noConsole === true) return replayFixed(anchor.reason)

  for (let cycle = 1; ; cycle += 1) {
    const afterSize = serialSize()
    await pressCycle(anchor, cycle)
    if (cycle >= maxCycles || !alive() || outOfWatch()) break
    const next = await waitForNextPrompt({ afterSize, afterText: anchor.text, afterAt: anchor.at })
    if (next === null) break
    anchor = next
  }
  return sent
}

/**
 * A press is only delivered when the QMP reply carries no `error`.
 *
 * The supervisor's qmp primitive RESOLVES the monitor's refusal (`{error: {desc}}`,
 * `{error: '…'}` or an array with such an entry) instead of throwing it, so the
 * caller must read the RESULT: treating it as success is how a run of refused
 * presses read as "pressed enter at ~1.7 s" while the guest never saw a key.
 */
export function cdbootPressFailure(result) {
  if (result === null || result === undefined || typeof result !== 'object') return null
  const entries = Array.isArray(result) ? result : [result]
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.error === undefined || entry.error === null) continue
    const error = entry.error
    const message = typeof error === 'string'
      ? error
      : String(error.desc ?? error.message ?? error.class ?? '')
    return (message || 'the monitor refused the event').slice(0, 300)
  }
  return null
}

/** A hard switch for a host that wants the old behaviour (keys not sent). */
export function cdbootKeysEnabled() {
  const raw = process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS
  if (raw === undefined || raw === '') return true
  return !/^(0|false|no|off)$/iu.test(String(raw).trim())
}

/** An integer env knob with a floor and a ceiling; anything else is the default. */
function cdbootNumber(name, fallback, min, max) {
  const parsed = Number(process.env[name])
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

/**
 * HOW LONG TO WATCH THE SERIAL CONSOLE FOR THE PROMPT.
 *
 * 90 s, not 8 s: on a cold q35+OVMF boot the DVD's `cdboot.efi` appears after
 * device enumeration, a virtio/SCSI scan and the network option ROMs — measured
 * well past the old 8 s window, which is why the wait ended before the prompt
 * ever existed. The window is only a BOUND: the presses fire on the poll that
 * sees the prompt, so a fast boot is served in milliseconds.
 */
export function cdbootPromptWindowMs() {
  return cdbootNumber('DSH_CUA_WINDOWS_CDBOOT_PROMPT_MS', 90000, 1000, 600000)
}

/** How many prompt cycles one boot may serve (a re-looping BDS reprints it). */
export function cdbootRearmCycles() {
  return cdbootNumber('DSH_CUA_WINDOWS_CDBOOT_CYCLES', 12, 1, 64)
}

/** The re-arm watcher's own bound — it stops sooner when the QEMU exits. */
export function cdbootRearmWatchMs() {
  return cdbootNumber('DSH_CUA_WINDOWS_CDBOOT_WATCH_MS', 180000, 0, 3600000)
}

/**
 * The QMP budget for ONE press.
 *
 * 3 s, not the 15 s default: a monitor that is mid-`query-status` refuses the
 * event quickly, and a 15 s wait for a refusal consumed the whole cdboot window
 * — one collision and the prompt timed out. A short budget leaves the retry gap
 * to do the retrying.
 */
export function cdbootPressTimeoutMs() {
  return cdbootNumber('DSH_CUA_WINDOWS_CDBOOT_PRESS_MS', 3000, 500, 60000)
}

/** The last `lines` NON-EMPTY lines of a stderr capture, or '' when empty. */
export function qemuStderrExcerpt(stderr, lines = 20) {
  const limit = Math.max(1, Math.min(200, Number(lines) || 20))
  return String(stderr ?? '')
    .split('\n')
    .map((line) => line.replace(/[\r\t]+$/u, '').trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(-limit)
    .join('\n')
}

/** The first non-empty line that looks like the CAUSE (QEMU prefixes errors). */
export function qemuStderrReason(stderr) {
  const lines = qemuStderrExcerpt(stderr, 40).split('\n').filter((line) => line.trim() !== '')
  const chosen = lines.find((line) => /error|failed|cannot|unable|no .*available|unsupported/iu.test(line)) ?? lines[0] ?? ''
  return chosen.replace(/^.*?qemu-system-x86_64:\s*/u, '').trim().slice(0, 300)
}

/**
 * WHICH KIND OF INIT FAILURE IS THIS? The answer decides whether boot() may
 * degrade (a display/GPU backend that the host cannot provide) or must refuse
 * loudly (the accelerator: the kvmStatus preflight owns that fix, and quietly
 * booting a Windows guest on TCG would be a 30-minute lie).
 *
 *   'kvm'     the accelerator could not be used — NEVER degrade
 *   'display' the EGL/render-node/virgl path could not initialize — degrade once
 *   'init'    anything else QEMU said — the caller may still retry a GPU attempt
 *   'none'    QEMU said nothing at all (killed, OOM, an exec problem)
 */
export function classifyQemuInitFailure(stderr) {
  const text = String(stderr ?? '')
  if (text.trim() === '') return 'none'
  // KVM FIRST: an EGL message and a KVM message can appear together, and the
  // accelerator is the one that must not be papered over.
  if (/(\/dev\/kvm|kvm_init|kvm[_ ]?init|cannot access memory|KVM_CREATE|accel=kvm|accel 'kvm'|kvm: |hardware acceleration is not supported|Failed to initialize KVM)/iu.test(text)) return 'kvm'
  if (/(egl|render node|rendernode|virgl|virtio-gpu|drm|opengl|glx|display|gtk|sdl)/iu.test(text)) return 'display'
  return 'init'
}

/**
 * DID THIS QEMU ACTUALLY COME UP?
 *
 * "spawn() returned a pid" is not "QEMU is running": a QEMU that rejects its own
 * argv exits a few milliseconds later, and the supervisor then watched a dead
 * computer for the whole install timeout (the user report: "installing (N min):
 * undefined answering, QMP not running" for 60 minutes on a store whose
 * serial.log was 0 bytes and whose qemu.pid was never written).
 *
 * Two facts are required, in this order, within `windowMs`:
 *
 *   1. the PIDFILE exists — QEMU writes it AFTER its init, so its absence after
 *      the window is the cleanest "never started" signal there is;
 *   2. the pid in it is ALIVE (not a zombie from this very child).
 *
 * It resolves EARLY when the child exits, so a dead start is reported in
 * milliseconds rather than after the full window. It never throws: the answer is
 * a value, and `boot()` decides what to do with it.
 */
export async function waitForQemuBoot({ child, pidFile, isAlive, windowMs = 15000, pollMs = 50 } = {}) {
  const step = Math.max(10, Number(pollMs) || 50)
  // THE FLOOR IS ONE FULL POLL INTERVAL. A window of 0 was never "do not wait":
  // when it was the *effective* value (the unset→0 defect above, or a caller that
  // asked for 0), the loop below ran ONE check against a deadline that had
  // already passed and reported a one-millisecond-old QEMU dead. A start that is
  // given any window at least gets to observe one real interval, so `pollMs`
  // (≥10 ms) is the floor — and `Date.now() >= deadline` only fires after that
  // observation, never before it. An explicitly-set 0 is still honored as "the
  // shortest window there is", not silently upgraded to 15 s.
  const window = Math.max(step, Math.max(0, Number(windowMs) || 0))
  const deadline = Date.now() + window
  let exited = false
  let pidFileInvalid = false
  let exitCode = null
  let exitSignal = null
  const noteExit = (code, signal) => { exited = true; exitCode = code ?? null; exitSignal = signal ?? null }
  try { child?.once?.('exit', noteExit) } catch {}
  for (;;) {
    const pid = (() => {
      try {
        const value = Number(readFileSync(pidFile, 'utf8').trim())
        if (Number.isFinite(value) && value > 0) return value
        // A file that exists but names nothing is noted (and reported at the
        // deadline, never immediately: QEMU may be mid-write).
        pidFileInvalid = true
        return 0
      } catch {
        return 0
      }
    })()
    if (pid > 0) {
      const alive = typeof isAlive === 'function' ? isAlive(pid) : pid > 0
      if (alive) return { ok: true, pid, pidFile: true, exited }
      // The pidfile names a pid nobody owns: an init that wrote it and died.
      return { ok: false, pid, pidFile: true, exited: true, exitCode, exitSignal, reason: 'pidfile' }
    }
    if (exited) {
      // The child is reaped and the pidfile never appeared — the init failure the
      // user reported, now with a cause instead of a 60-minute wait.
      return { ok: false, pid: 0, pidFile: false, exited: true, exitCode, exitSignal, reason: 'exited' }
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        pid: 0,
        pidFile: pidFileInvalid,
        exited: false,
        exitCode,
        exitSignal,
        reason: pidFileInvalid ? 'pidfile-invalid' : 'timeout'
      }
    }
    await new Promise((resolve) => setTimeout(resolve, step))
  }
}

/**
 * THE ERROR A DEAD INIT DESERVES: the captured stderr, the classification, and
 * the next step — never a bare "QEMU exited".
 *
 * The text is what reaches the row's `error`/`errorLog`, the supervisor log and
 * the panel, so it carries the file it read (`qemu-stderr.log`, named because
 * that is where a human looks next) and the QEMU lines verbatim.
 */
export function qemuInitError({ name = '<name>', kind = 'none', reason = '', excerpt = '', stderrPath = '', retriedWithoutGpu = false } = {}) {
  const what = kind === 'kvm'
    ? 'QEMU could not use the KVM accelerator'
    : kind === 'display'
      ? 'QEMU could not initialize the display/GPU backend'
      : 'QEMU exited during init before writing its pidfile'
  const head = retriedWithoutGpu
    ? `${what} (the GPU-less retry failed too)`
    : what
  const lines = [`windows: ${name}: ${head}${reason === '' ? '' : ` — ${reason}`}`]
  if (excerpt !== '') lines.push('', `QEMU stderr (last lines of ${path.basename(stderrPath || 'qemu-stderr.log')}):`, excerpt)
  else lines.push('', `QEMU wrote nothing to ${path.basename(stderrPath || 'qemu-stderr.log')} — it was killed or could not exec (check the supervisor log and \`dmesg\` for an OOM kill).`)
  if (kind === 'kvm') {
    // NEVER DEGRADED. The preflight said the device is usable; if QEMU still
    // cannot use it, the fix is the device/gid one, and this module must not
    // quietly boot Windows on TCG.
    lines.push('', 'This is a KVM/accelerator failure, not a display failure: the create is NOT retried without the GPU, because a Windows guest on emulated TCG is not the computer that was asked for.', 'Run `cua_vm_doctor` and check /dev/kvm (device present, gid usable by this uid).')
  } else if (kind === 'display') {
    lines.push('', 'The GPU display backend could not initialize on this host; a create retries once with `-display none` and an emulated VGA framebuffer. If this text appeared after that retry, the host cannot give this guest any display.')
  }
  lines.push('', `Full QEMU output: ${stderrPath || '<store>/windows/<name>/qemu-stderr.log'}`)
  return Object.assign(new Error(lines.join('\n')), { code: 'QEMU_INIT_FAILED', kind, stderrExcerpt: excerpt, stderrPath })
}

/**
 * The capacity advice for a Windows computer.
 *
 * The three numbers below are RECOMMENDATIONS (the defaults), not gates: a
 * smaller computer is created when it is asked for, and this function produces
 * the warnings that travel with the result and the panel. It is pure so the
 * decision can be tested without a hypervisor.
 */
export function windowsCapacityWarnings({ diskGb, memory, cpu }) {
  const warnings = []
  if (Number(diskGb) < WINDOWS_MIN_DISK_GB) {
    warnings.push({
      code: 'disk-below-floor',
      message: `disk ${diskGb} GB is below the recommended ${WINDOWS_MIN_DISK_GB} GB floor; a Windows install needs roughly 52 GB after updates, so Windows Update will run out of space and the install may fail. Created anyway on request (the quota still counts the real bytes).`
    })
  }
  if (Number(memory) < WINDOWS_MIN_MEMORY_GB) {
    warnings.push({
      code: 'memory-below-floor',
      message: `RAM ${memory} GB is below the recommended ${WINDOWS_MIN_MEMORY_GB} GB floor; Setup and the first logon will be very slow and may fail. Created anyway on request.`
    })
  }
  if (Number(cpu) < WINDOWS_MIN_CPU) {
    warnings.push({
      code: 'cpu-below-floor',
      message: `${cpu} vCPU is below the recommended ${WINDOWS_MIN_CPU}; Windows Setup will be slow. Created anyway on request.`
    })
  }
  return warnings
}

/* ------------------------------------------------------------------ *
 * U4: THE FREE SPACE THAT IS ACTUALLY LEFT
 * ------------------------------------------------------------------ */

/**
 * Below this many free bytes on C:, Windows Update and Setup's own working set
 * are the next thing to fail — the live computer was reported at 6.8 GB free on
 * a 64 GB disk, and "the install failed" then reads like a Windows bug.
 */
export const WINDOWS_FREE_FLOOR_GB = 10

/**
 * `(Get-PSDrive -Name C).Free` answers a bare integer, but the remote shell is
 * cmd.exe and PowerShell's formatting can add a header, a blank line or (on a
 * localized image) a warning. Taking the FIRST run of digits is deliberately
 * conservative: a "0" on a broken probe would read as "the disk is full", which
 * is a louder lie than "unknown". A probe that answers no digits is unknown.
 */
export function parseFreeSpaceProbe(stdout) {
  const text = String(stdout ?? '')
  const match = /(\d+)/u.exec(text)
  if (match === null) return null
  const bytes = Number(match[1])
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null
}

/**
 * The measured free space, its one-line form and the below-floor warning.
 * Returns null when the probe produced no number, so the caller reports
 * "unavailable" instead of printing 0 GB.
 */
export function formatWindowsFreeSpace(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null
  const gb = bytes / 1024 ** 3
  const text = gb >= 10 ? `${gb.toFixed(1)} GB` : `${gb.toFixed(2)} GB`
  const below = gb < WINDOWS_FREE_FLOOR_GB
  return {
    bytes,
    freeGb: Number(gb.toFixed(2)),
    line: `${text} free on C:`,
    belowFloor: below,
    warning: below
      ? `only ${text} free on C: (the recommended minimum is ${WINDOWS_FREE_FLOOR_GB} GB): Windows Update, Setup and a pip install all need room, and the install fails with an unrelated-looking error once the disk is full`
      : undefined
  }
}

/**
 * Is this host able to boot a Windows computer at all?
 *
 * `kvm` used to be `statSync('/dev/kvm').isFile()`, which is FALSE for a device
 * node: a container with the device mounted, mode 0666, answered "kvm: false"
 * and the create said "needs /dev/kvm (compose.emulator.yaml)". Two facts are
 * now reported separately, because they have two different fixes:
 *
 *   kvm         the device node is present (a CHARACTER device, not a file)
 *   kvmUsable   access(R_OK|W_OK) SUCCEEDS for this uid — a present-but-denied
 *               node is `kvm: true, kvmUsable: false`, and its error names the
 *               gid/group_add fix instead of telling the user to mount it again
 *
 * `kvmStatus` is exported too, so the doctor and the create path quote the same
 * observation (mode, usr:grp, this process's groups) instead of re-deriving it.
 */
export function windowsHostCaps() {
  // SELF-TEST HOOK. The create path (quota → ports → ISO → OEM payload → boot) is
  // the part worth testing, and it cannot run on a host without qemu/OVMF/swtpm.
  // This makes the capability check report "present" so the smoke suite can drive
  // the real code. It is never set in compose/.env, and a gate forbids that.
  if (String(process.env.DSH_CUA_WINDOWS_FAKE_HOST_CAPS ?? '') === '1') {
    return { qemu: true, ovmfCode: true, ovmfVars: true, swtpm: true, virtioWin: false, kvm: true, kvmUsable: true, render: true, faked: true }
  }
  const kvm = kvmStatus()
  return {
    qemu: regularFilePresent(WINDOWS_QEMU),
    ovmfCode: regularFilePresent(OVMF_CODE),
    ovmfVars: regularFilePresent(OVMF_VARS_TEMPLATE),
    swtpm: regularFilePresent(SWTPM),
    virtioWin: VIRTIO_WIN_ISO !== '' && regularFilePresent(VIRTIO_WIN_ISO),
    // A device node is presence; whether THIS uid may open it is `kvmUsable`.
    kvm: deviceNodePresent(KVM_DEVICE) || kvm.exists,
    kvmUsable: kvm.state === 'ok',
    kvmMode: kvm.info === null ? null : kvm.info.modeText,
    kvmOwner: kvm.info === null ? null : `${kvm.info.uid}:${kvm.info.gid}`,
    kvmGroups: kvm.identity.groups,
    kvmReason: kvm.reason,
    render: deviceNodePresent('/dev/dri/renderD128')
  }
}

/**
 * The Windows backend's KVM preflight, as one exported value.
 *
 * Both the supervisor (before a single byte of ISO is downloaded) and `boot()`
 * (before swtpm is spawned) ask THIS, so the two refusals cannot drift apart —
 * and neither can fall back to the old "needs /dev/kvm (compose.emulator.yaml)"
 * sentence, which was wrong for a mounted-but-denied device.
 */
export function windowsKvmPreflight() {
  // The documented self-test hook reports the capabilities present; the device
  // refusal must honour it too, or the smoke suite would pass on this host and
  // fail on a CI runner that has no /dev/kvm.
  if (String(process.env.DSH_CUA_WINDOWS_FAKE_HOST_CAPS ?? '') === '1') return null
  return kvmPreflightError(kvmStatus(), { purpose: 'the Windows backend' })
}

/* ------------------------------------------------------------------ *
 * Paths — everything Windows lives under $STORE
 * ------------------------------------------------------------------ */

/**
 * ONE DIRECTORY PER COMPUTER, and nothing outside `$STORE`.
 *
 *   $STORE/windows/<name>/disk.qcow2        the system disk (plain qcow2)
 *   $STORE/windows/<name>/efi-vars.qcow2    OVMF NVRAM (boot order, keys)
 *   $STORE/windows/<name>/tpm/              swtpm state (persisted TPM2)
 *   $STORE/windows/<name>/oem/              Autounattend.xml + Setup scripts
 *   $STORE/windows/<name>/credentials.json  the generated password + SSH key
 *   $STORE/windows/<name>/serial.log        the console (also the install tail)
 *   $STORE/iso/                             downloaded install media
 */
export function windowsPaths(store, name) {
  const dir = path.join(store, 'windows', name)
  return {
    dir,
    disk: path.join(dir, 'disk.qcow2'),
    efiVars: path.join(dir, 'efi-vars.qcow2'),
    tpmDir: path.join(dir, 'tpm'),
    tpmSocket: path.join(dir, 'swtpm.sock'),
    tpmPid: path.join(dir, 'swtpm.pid'),
    oemDir: path.join(dir, 'oem'),
    // THE ANSWER-FILE MEDIUM. A partitioned FAT32 image, not the host
    // directory: WinPE mounts a real disk and lists its root, while a
    // directory-backed vvfat node was not reliably visible. Setup then reads
    // Autounattend.xml only from REMOVABLE-media roots, so the image is
    // delivered through usb-storage with removable=on — see buildQemuArgs()
    // and buildSetupImage().
    setupImg: path.join(dir, 'setup.img'),
    credentials: path.join(dir, 'credentials.json'),
    sshKey: path.join(dir, 'id_ed25519'),
    sshKeyPub: path.join(dir, 'id_ed25519.pub'),
    serialLog: path.join(dir, 'serial.log'),
    // QEMU'S OWN STDERR, NOT THE GUEST CONSOLE. `-serial file:` above records
    // what the GUEST prints; a QEMU that dies during init (a bad display
    // backend, an unusable accelerator, a missing firmware file) writes its
    // diagnosis to STDERR and nowhere else. With `stdio: 'ignore'` that text was
    // discarded, which is why a user-reported dead create left one line
    // ("qemu started (pid 906, installing)") and no reason anywhere.
    qemuStderr: path.join(dir, 'qemu-stderr.log'),
    // The GPU-less retry writes its own file, so the reason the first attempt
    // died (the EGL/render-node line the panel quotes) is never overwritten.
    qemuStderrRetry: path.join(dir, 'qemu-stderr-retry.log'),
    qemuPid: path.join(dir, 'qemu.pid'),
    qmp: path.join(dir, 'qmp.json'),
    isoDir: path.join(store, 'iso')
  }
}

/* ------------------------------------------------------------------ *
 * Ports — ONE shape, whichever object the caller hands in
 * ------------------------------------------------------------------ */

/**
 * THE ROW AND THE BOOT SPEC DO NOT SHARE A PORT SHAPE, and that mismatch was a
 * user-visible bug.
 *
 * `boot()` is called with FLAT fields (`qmpPort`, `vncPort`, `sshPort`) because
 * it builds QEMU's argv. Every lifecycle helper (`probe`, `ready`, `qmpFor`,
 * `screenshot`, `click`, …) is called with the REGISTRY ROW, which stores the
 * same three numbers under `ports: { qmp, ssh, vnc }` and has no flat field at
 * all. So `qmpFor(spec)` dialled `undefined`:
 *
 *   * `net.connect(undefined)` throws `TypeError: The "options" or "port" or
 *     "path" argument must be specified`;
 *   * `probe()` swallowed that into `error` and reported `status: ''`;
 *   * `ready()` returned `{ ready: false, endpoint: undefined }` (it never
 *     reached the `endpoint: 'none'` line because the throw happened first);
 *   * the watcher interpolated that straight into the panel:
 *     `installing (10 min): undefined answering, QMP not running`.
 *
 * The whole sentence was true about nothing. One resolver, used by every helper,
 * makes the shape invisible to the caller — and it is also what keeps the row
 * authoritative after a port reconcile moved the triple.
 */
export function windowsPortsOf(spec) {
  const record = spec && typeof spec === 'object' ? spec : {}
  const ports = record.ports && typeof record.ports === 'object' ? record.ports : {}
  const first = (...values) => {
    for (const value of values) {
      const port = Number(value)
      if (Number.isFinite(port) && port > 0) return port
    }
    return 0
  }
  return {
    qmpPort: first(record.qmpPort, ports.qmp),
    vncPort: first(record.vncPort, ports.vnc),
    sshPort: first(record.sshPort, ports.ssh)
  }
}

/** This computer's ports, in the flat shape QEMU's argv wants. */
export function windowsBootSpec(spec) {
  return { ...spec, ...windowsPortsOf(spec) }
}

/**
 * R2: A REGISTRY ROW HAS NO `name` FIELD — ITS NAME IS THE MAP KEY.
 *
 * The supervisor stored rows as `{ vms: { "win-box": { kind, ports, … } } }`, and
 * every lifecycle helper read `spec.name`. For a row that is `undefined`, so
 * `pathsFor(undefined)` resolved `/cua-vm/windows/undefined/qemu.pid`, nothing
 * was ever alive at that path, and the install watcher printed
 *
 *     QEMU not alive (see qemu-stderr.log tail)
 *
 * forever while QMP answered `running` — the reported "fake dead" computer.
 *
 * The fix is at both ends: rows are WRITTEN with `name` (and the read migration
 * injects it for rows that predate this), and every helper resolves through this
 * one function so a caller that only has the map key still works.
 */
export function windowsRowName(spec, fallback = '') {
  if (typeof spec === 'string' && spec !== '') return spec
  const direct = spec && typeof spec === 'object' ? spec.name : ''
  if (typeof direct === 'string' && direct !== '') return direct
  return typeof fallback === 'string' ? fallback : ''
}

/* ------------------------------------------------------------------ *
 * The command line
 * ------------------------------------------------------------------ */

/**
 * D2: THE THREE DEVICE NAMES THE INSTALL MEDIA HAVE, IN ONE PLACE.
 *
 * `cd` and `setup` are BLOCK-node ids (`-drive ...,id=cd0|setup0`); `setupDevice`
 * is the QDEV id of the usb-storage frontend. QMP `eject` takes the block node,
 * `device_del` takes the qdev id — two different namespaces, and mixing them up
 * produces a `DeviceNotFound` that looks like "the media are already gone".
 */
export const INSTALL_MEDIA_DEVICE_IDS = Object.freeze({ cd: 'cd0', setup: 'setup0', setupDevice: 'setupusb' })

/**
 * The QEMU argv for one Windows computer.
 *
 * DESIGN NOTES THAT MATTER WHEN SOMETHING DOES NOT BOOT:
 *
 *   * `q35` + `-cpu host` + KVM: the same acceleration the Linux guest uses;
 *     without /dev/kvm this refuses at start rather than crawling.
 *   * The two pflash drives are the firmware. OVMF_CODE is read-only and
 *     SHARED; `efi-vars.qcow2` is PER COMPUTER, so boot entries and the TPM's
 *     measured state survive a restart (a fresh vars file re-runs Setup).
 *   * `swtpm` is a separate process listening on a unix socket; QEMU's chardev
 *     connects to it. Both are cleaned up by `stopSwtpm`.
 *   * The install medium is the untouched Microsoft ISO on a CD-ROM. The
 *     answer file and its scripts live on a SEPARATE DISK (`setup.img`, built
 *     with mtools), attached WRITABLE: MBR + one FAT32 partition at LBA 2048,
 *     with `Autounattend.xml` at the volume root. It is delivered as a
 *     **removable usb-storage stick** since the live forensic round: WinPE
 *     mounts it, lists the answer file, and STILL ignored it as a fixed disk,
 *     because Setup only scans removable-media roots (and the boot media) for
 *     an answer file. The old `fat:ro:` vvfat directory behind usb-storage was
 *     not seen by Setup at all, and neither is a PARTITIONLESS FAT32 image: the
 *     firmware mounts one, Windows never does (it enumerates fixed disks through
 *     their partition table), and the symptom is Setup silently showing its
 *     interactive language screen. That is why the MBR is part of the build and
 *     why it is asserted — see buildSetupImage(). **NOT a dockur/windows
 *     mirror**: their overlay is also FAT32 but partitionless, and it works in
 *     their flow, not in this one. The disk is writable because QEMU 10 refuses
 *     a read-only block node behind `ide-hd` (it is legal on usb-storage, which
 *     is verified both ways now) and because Setup may write logs/scratch to
 *     the medium.
 *   * `bootindex` ORDERS THE BOOT, and the order follows the INTENT of each
 *     phase instead of the order the devices happen to be declared in:
 *
 *       installPending: true   CD bootindex=1, disk bootindex=2 — Setup must
 *                              run from the install media on a disk that has
 *                              nothing bootable on it yet. The old argv had
 *                              this BACKWARDS (disk 1, CD 2) while its comment
 *                              claimed the ISO booted first: OVMF created
 *                              Boot0002 for the unbootable HDD, tried it, said
 *                              "HDD Not Found", and only then fell through to
 *                              the DVD. Pinning the CD first removes a full
 *                              failed-start cycle from every install.
 *       installPending: false  disk bootindex=1, NO CD and NO setup.img — after
 *                              Setup the disk owns the boot order and the
 *                              session must see only its system disk. The
 *                              INSTALLING session cannot rebuild its argv, so
 *                              the same end state is reached at the ready
 *                              transition with QMP (`eject` + `device_del`, see
 *                              detachInstallMedia()).
 *   * Networking is SLIRP: outbound internet, the host reachable at 10.0.2.2,
 *     and SSH forwarded from 127.0.0.1:<port> to guest :22. No bridge, no tap,
 *     no CAP_NET_ADMIN — the harness keeps `cap_drop ALL`.
 *   * Video: `-vga std` by default (a plain framebuffer every Windows has an
 *     inbox driver for). With `gpu: true` the display becomes virtio-gpu backed
 *     by the host's render node — the SAME virgl wiring as the Linux guest —
 *     with the honest caveat documented in the README: Windows has no
 *     accelerated 3D driver here, so Direct3D falls back to WARP (CPU).
 */

/**
 * J1-3: A COMMA IN A PATH IS NOT AN OPTION SEPARATOR.
 *
 * Every value this file interpolates into a QEMU option string — `-drive
 * file=…`, `-chardev socket,path=…` — is parsed by QEMU's own QemuOpts splitter,
 * which cuts on commas. An operator who names a medium `win11,beta.iso` (or a
 * store path containing a comma) therefore hands QEMU `file=win11` plus a
 * mystery `beta.iso` option: a refusal at best, and at worst a different file
 * attached to the guest. QEMU's documented escape inside an option value is
 * `,,`, and it is the ONLY escape that works there (quoting does not: the
 * splitter runs before any shell-like parsing).
 *
 * Exported because a test has to be able to prove the escaping without a QEMU,
 * and because every future interpolation should call this one function.
 */
export function qemuEscapeOptionValue(value) {
  return String(value ?? '').replace(/,/gu, ',,')
}

export function buildQemuArgs(spec) {
  const p = spec.paths
  const boot = spec.installPending === true
  // THE FIRMWARE IS DECIDED BEFORE THE ARGV IS, never inferred from it.
  // A `seabios` profile rewrites five decisions (machine, pflash, TPM, disk,
  // NIC); letting any one of them stay at its UEFI value produces a QEMU that
  // starts and a guest that never boots, which reads as "corrupt ISO".
  const firmware = spec.firmware ?? windowsFirmwareForSpec(spec)
  const legacyBios = firmware.bios === 'seabios'
  const declaredVersion = String(spec.windowsVersion ?? spec.version ?? '').trim()
  // XP: REFUSED HERE TOO, not only in resolveWindowsIso(). The supervisor calls
  // this from a boot of a row that already exists, so a row created before the
  // refusal existed must still fail with the real reason instead of booting an
  // ISO whose Setup waits for a winnt.sif nobody built.
  if (declaredVersion !== '') {
    const catalog = windowsCatalogEntry(declaredVersion)
    if (typeof catalog.refusal === 'string') throw windowsCodeError(catalog.refusal, `${catalog.label} cannot be installed by this backend: ${catalog.refusalDetail}`)
    // 7u ON A LEGACY BIOS IS OPT-IN. The default is "allowed, with a warning"
  }
  // THE MEDIA CAN REFUSE TOO. An operator ISO named `..._xp_...` arrives with no
  // `windowsVersion` at all (the supervisor blanks it for the windowsIso path),
  // so the declared-version gate above never sees it — and the heuristic would
  // otherwise boot a machine whose Setup waits forever for a winnt.sif that this
  // payload does not build.
  if (firmware.code === 'xp') {
    const catalog = WINDOWS_CATALOG.xp
    throw windowsCodeError(catalog.refusal, `${catalog.label} cannot be installed by this backend: ${catalog.refusalDetail}`)
  }
  // (DSH_CUA_WIN_LEGACY_BIOS unset): the profile exists precisely so Windows 7
  // can install, and refusing by default would make the code dead. `=0` is the
  // kill switch for a host that does not want an unsupported firmware path.
  if (legacyBios && String(process.env.DSH_CUA_WIN_LEGACY_BIOS ?? '1') === '0') {
    throw windowsCodeError('legacy-bios-disabled', `this computer needs a legacy BIOS (${firmware.code || 'pre-UEFI media'}), but DSH_CUA_WIN_LEGACY_BIOS=0 disables that firmware path`)
  }
  // R4: ONE ORDER, DECIDED BY THE PHASE. While installing the CD is FIRST and
  // the (still empty) disk second; afterwards the disk is FIRST and no CD is
  // attached. The old argv always put the disk at 1 and the CD at 2 and left a
  // comment claiming the opposite.
  const diskBootIndex = boot ? 2 : 1
  // q35/ICH9 for UEFI; pc/i440FX+PIIX for a BIOS guest, whose inbox drivers
  // cover IDE and e1000e and nothing else.
  const machine = legacyBios ? `${firmware.machine},accel=kvm` : `${firmware.machine},accel=kvm,smm=off`
  const args = [
    '-name', `dsh-win-${spec.name}`,
    '-machine', machine,
    '-cpu', 'host',
    '-smp', String(spec.cpu),
    '-m', String(spec.memory * 1024),
    // firmware: shared code + per-computer NVRAM — UEFI ONLY. A BIOS guest has
    // no pflash at all, and handing it one is QEMU's "unsupported machine
    // configuration" instead of a boot.
    ...(firmware.efiVars
      ? ['-drive', `if=pflash,format=raw,readonly=on,file=${qemuEscapeOptionValue(OVMF_CODE)}`,
        '-drive', `if=pflash,format=qcow2,file=${qemuEscapeOptionValue(p.efiVars)}`]
      : []),
    // TPM2: char socket to swtpm + the TPM device Windows 11 requires. Windows 7
    // has no TPM driver and its Setup does not need one; attaching the device
    // anyway is a device tree it will simply report as unknown hardware.
    ...(firmware.tpm
      ? ['-chardev', `socket,id=chrtpm,path=${qemuEscapeOptionValue(p.tpmSocket)}`,
        '-tpmdev', 'emulator,id=tpm0,chardev=chrtpm',
        '-device', 'tpm-crb,tpmdev=tpm0']
      : []),
    // system disk — SECOND while installing (see diskBootIndex above)
    '-drive', `file=${qemuEscapeOptionValue(p.disk)},if=none,id=disk0,format=qcow2,cache=writeback,discard=unmap`,
    '-device', legacyBios
      // FROM THE PROFILE, so the argv cannot disagree with the table a reader
      // consults: seabios says `ide-hd`, and an IDE disk is the only one whose
      // driver Windows 7 has in the box.
      ? `${firmware.disk},drive=disk0,bus=ide.0,bootindex=${diskBootIndex}`
      : spec.virtio ? `virtio-blk-pci,drive=disk0,bootindex=${diskBootIndex}` : `ide-hd,drive=disk0,bus=ide.0,bootindex=${diskBootIndex}`,
    // install medium (only while installing) + drivers + OEM payload.
    // R4: THE CD IS bootindex=1 DURING INSTALL. Booting a blank disk first made
    // OVMF create a Boot0002 HDD entry, try it, print "HDD Not Found" and only
    // then reach the DVD — one wasted boot cycle per install, and the reason the
    // CD's "Press any key to boot from CD or DVD" window was ever entered late.
    // S1/F1: THE ANSWER-FILE MEDIUM, AFTER THE SYSTEM DISK. `ide.0` is the
    // qcow2 and therefore Windows DISK 0 — which is what Autounattend.xml's
    // <DiskID>0</DiskID> targets. On QEMU's q35 (ICH9 AHCI) the slots are:
    //
    //   ide.0  system qcow2      -> Windows Disk 0  (EFI/MSR/Primary)
    //   ide.1  install CD-ROM    -> not a disk, but the boot device during install
    //   ide.3  virtio-win CD-ROM -> not a disk (when a driver ISO is supplied)
    //
    // F1: AND IT IS NO LONGER AN ide-hd. VERIFIED INSIDE THE GUEST, with the
    // answer image mounted and byte-correct: WinPE mounted setup.img as C:,
    // `dir C:\` listed Autounattend.xml, `more C:\Autounattend.xml` was byte-
    // verified, there were NO Panther parse errors — and Setup STILL showed its
    // interactive language page. The cause is the DELIVERY CLASS, not the file:
    // WinPE/Setup searches for Autounattend.xml on REMOVABLE-media roots (and on
    // the boot media), NOT on fixed-disk roots. An `ide-hd` is a fixed disk: the
    // firmware mounted it, Windows mounted it, and Setup never scanned it. The
    // same image on usb-storage with `removable=on` reports removable media and
    // IS scanned. (Windows' documented search order: removable drives, the boot
    // media, %WINDIR%\Panther\Unattend / $WINNT$.~BT, and the
    // UnattendFile/HKLM\SYSTEM\Setup registry override — a fixed disk root is
    // nowhere in it.)
    //
    // The drive node stays declared here, right after the system disk, so the
    // block graph keeps the same order and the image is attached BEFORE any
    // device names it. The usb-storage device itself is declared AFTER the xHCI
    // controller (below), because QEMU parses argv in order and a device that
    // names `bus=xhci.0` before `-device qemu-xhci` dies with "Bus 'xhci.0' not
    // found".
    //
    // THE NODE IS WRITABLE, AND THAT IS STILL NOT NEGOTIABLE: QEMU 10 refuses a
    // read-only block node behind an IDE hard disk ("Block node is read-only",
    // which used to cascade into "swtpm did not create its socket"), and Setup
    // may write logs/scratch to the medium. It is now legal on BOTH shapes —
    // verified on this container's QEMU 10.0.13: usb-storage accepts a writable
    // node AND a read-only one, and `query-block` reports `removable: true` for
    // `removable=on` (and `false` for `removable=off` or the property omitted,
    // which is why the property is explicit). The image is rebuilt fresh on
    // every create anyway (see buildSetupImage), so guest writes never leak into
    // the next install.
    ...(boot
      ? ['-drive', `file=${qemuEscapeOptionValue(p.setupImg)},format=raw,if=none,id=setup0`]
      : []),
    ...(boot
      ? ['-drive', `file=${qemuEscapeOptionValue(spec.isoPath)},media=cdrom,readonly=on,if=none,id=cd0`,
        '-device', 'ide-cd,drive=cd0,bus=ide.1,bootindex=1']
      : []),
    ...(spec.driverIso !== null
      ? ['-drive', `file=${qemuEscapeOptionValue(spec.driverIso)},media=cdrom,readonly=on,if=none,id=cd1`,
        '-device', 'ide-cd,drive=cd1,bus=ide.3']
      : []),
    // THE USB CONTROLLER COMES FIRST. QEMU parses argv in order, so a device
    // that names `bus=xhci.0` before `-device qemu-xhci,id=xhci` dies with
    // "Bus 'xhci.0' not found" (verified on QEMU 10). Order is asserted by a
    // gate needle, because it is invisible in a diff.
    '-device', 'qemu-xhci,id=xhci',
    // F1: THE ANSWER MEDIUM IS A REMOVABLE USB STICK, NOT A FIXED IDE DISK.
    // `removable=on` is the SEMANTIC that makes Windows classify the device as
    // removable media, and removable media roots are what WinPE scans for
    // Autounattend.xml — a fixed-disk root is never scanned, which is the whole
    // reported bug. QEMU's usb-storage `removable` property is explicit here
    // because QEMU 10 defaults it to OFF when omitted (verified with query-block
    // on this container's 10.0.13: omitted → removable=false, `removable=on` →
    // removable=true), and a default is not a contract.
    //
    // This is NOT a return of the old `fat:ro:` vvfat OEM stick: that was a
    // directory-backed vvfat node (read-only, no partition table, unreliable
    // even as removable media). setup.img stays a REAL MBR + FAT32 partitioned
    // image, built by mtools, attached writable — only its delivery class
    // changed.
    // D2: THE DEVICE HAS AN EXPLICIT ID (`id=setupusb`) SO IT CAN BE HOT-UNPLUGGED.
    // The install media are attached for the INSTALL ONLY (this whole block is
    // gated on `installPending`), but the QEMU process that installed the
    // computer keeps running with that argv — so the CD and this stick stayed
    // visible to a Windows that had long since booted from its own disk (the
    // user's D2: "SETUP (D:) and the CD drive stay attached"). `detachInstallMedia()`
    // fixes the RUNNING session: QMP `eject` for the CD and `device_del` for this
    // frontend. `device_del` needs the device's qdev id, which is why the id is
    // explicit here instead of left to QEMU's generated one.
    ...(boot
      ? ['-device', `usb-storage,drive=setup0,removable=on,bus=xhci.0,id=${INSTALL_MEDIA_DEVICE_IDS.setupDevice}`]
      : []),
    // networking: SLIRP + the SSH forward. The NIC follows the profile: a BIOS
    // guest gets e1000e (an inbox Windows 7 driver) even when this host could
    // give it virtio — virtio needs the virtio-win ISO, and an unattended
    // install with no NIC installs no SSH and every later step is dead.
    '-netdev', `user,id=net0,hostfwd=tcp:127.0.0.1:${spec.sshPort}-:22`,
    '-device', legacyBios ? `${firmware.nic},netdev=net0` : spec.virtio ? 'virtio-net-pci,netdev=net0' : `${firmware.nic},netdev=net0`,
    // input: absolute pointer (QMP input-send-event) + keyboard
    '-device', 'usb-kbd',
    '-device', 'usb-tablet',
    // display: the panel's live view and the agent's frames
    '-display', spec.gpu && spec.virgl ? 'egl-headless,rendernode=/dev/dri/renderD128' : 'none',
    // QEMU READS THIS AS A DISPLAY NUMBER, NOT A PORT: `-vnc host:31` binds
    // 5900+31. Passing the raw port (5931) binds 11831 — the relay, the banner
    // probe and websockify all point at 5931, so the live view never connects
    // and the non-SSH readiness probe never answers. The conversion lives in one
    // function so it cannot drift again.
    '-vnc', `127.0.0.1:${vncDisplayFor(spec.vncPort)}`,
    // GPU: virgl only when the distro QEMU advertises virtio-gpu-gl-pci AND a
    // render node exists — otherwise a plain virtio-gpu framebuffer. Windows has
    // no accelerated driver either way (Direct3D is WARP); the difference is that
    // virgl routes the guest's GL through the host render node, which is what the
    // Linux guest does.
    '-device', spec.gpu ? (spec.virgl ? 'virtio-gpu-gl-pci' : 'virtio-gpu-pci') : 'VGA,vgamem_mb=32',
    // control + observability
    '-qmp', `tcp:127.0.0.1:${spec.qmpPort},server=on,wait=off`,
    '-monitor', 'none',
    '-serial', `file:${p.serialLog}`,
    '-pidfile', p.qemuPid,
    '-no-user-config'
  ]
  return args
}

/**
 * VNC takes a DISPLAY NUMBER, not a port: QEMU computes `5900 + n`.
 * These helpers are the only place that arithmetic happens.
 */
export function vncDisplayFor(port) {
  return Math.max(0, Number(port) - 5900)
}

export function vncPortFor(display) {
  return 5900 + Number(display)
}

/* ------------------------------------------------------------------ *
 * The live Microsoft download page (the "mido" strategy)
 * ------------------------------------------------------------------ */

/**
 * MICROSOFT'S OWN DOWNLOAD PAGE IS AN API WITH FOUR CALLS.
 *
 * `/en-us/software-download/windows11` looks like a marketing page; behind it
 * is a session handshake whose every value this module has to reproduce, in
 * order, because any skip makes the connector answer "Sentinel marked this
 * request as rejected":
 *
 *   1. TAGS  vlscppe.microsoft.com/tags?org_id=…&session_id=…   (empty Accept)
 *      The org id is what the page's own script sends; an empty Accept header
 *      is not a bug — the endpoint distinguishes "browser" from "curl" by it.
 *   2. MDT   ov-df.microsoft.com/mdt.js?instanceId=…&PageId=si&session_id=…
 *      Returns the telemetry shim that CARRIES the two handshake values the
 *      reply call needs (`w` and `rticks`); they are per-session, so they are
 *      read from the body, never hard-coded.
 *   3. REPLY ov-df.microsoft.com/?session_id=…&CustomerId=…&PageId=si&w=…&mdt=…&rticks=…
 *      Registers the session. ~200 ms later the connector starts answering.
 *   4. SKU   software-download-connector/api/getskuinformationbyproductedition
 *      → the edition list; the English one is the one to install.
 *   5. LINK  software-download-connector/api/GetProductDownloadLinksBySku
 *      → ProductDownloadOptions[]; DownloadType 1 is the direct ISO.
 *
 * Both connector calls need the page as `Referer`, or they 403 as if the SKU
 * were unknown. Every value below is a constant of THAT page: nothing here is
 * fetched from a third party, and no dependency is added — `node:https` only.
 */
export const MIDO_PROFILE = '606624d44113'
export const MIDO_ORG_ID = 'y6jn8c31'
export const MIDO_INSTANCE = '560dc9f3-1aa5-4a2f-b63c-9e18f8d0e175'
export const MIDO_PRODUCTS = Object.freeze({
  '11': Object.freeze({ productId: '3321', page: 'https://www.microsoft.com/en-us/software-download/windows11', type: 1 }),
  '10': Object.freeze({ productId: '2618', page: 'https://www.microsoft.com/en-us/software-download/windows10ISO', type: 1 })
})
export const MIDO_TAGS_URL = (session) => `https://vlscppe.microsoft.com/tags?org_id=${MIDO_ORG_ID}&session_id=${session}`
export const MIDO_MDT_URL = (session) => `https://ov-df.microsoft.com/mdt.js?instanceId=${MIDO_INSTANCE}&PageId=si&session_id=${session}`
export const MIDO_REPLY_URL = (session, w, mdt, rticks) => `https://ov-df.microsoft.com/?session_id=${session}&CustomerId=${MIDO_INSTANCE}&PageId=si&w=${w}&mdt=${mdt}&rticks=${rticks}`
export const MIDO_SKU_URL = (session, productId) => `https://www.microsoft.com/software-download-connector/api/getskuinformationbyproductedition?profile=${MIDO_PROFILE}&ProductEditionId=${productId}&SKU=undefined&friendlyFileName=undefined&Locale=en-US&sessionID=${session}`
export const MIDO_LINK_URL = (session, skuId) => `https://www.microsoft.com/software-download-connector/api/GetProductDownloadLinksBySku?profile=${MIDO_PROFILE}&ProductEditionId=undefined&SKU=${skuId}&friendlyFileName=undefined&Locale=en-US&sessionID=${session}`

/** The two sentences that mean "this session is not a browser session". */
const MIDO_REJECTIONS = ['Sentinel marked this request as rejected.', 'We are unable to complete your request at this time.']

/** One browser-ish UA: the connector rejects the default `node` agent header. */
const MIDO_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Read a whole response, refusing to buffer more than `maxBytes`. */
function readResponseBody(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let received = 0
    response.on('data', (chunk) => {
      received += chunk.length
      if (received > maxBytes) {
        response.destroy()
        reject(windowsCodeError('response-too-large', `the response exceeded ${maxBytes} bytes (${response.statusCode})`))
        return
      }
      chunks.push(chunk)
    })
    response.on('error', reject)
    response.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

/**
 * One HTTPS call with redirects, a timeout and a hard size cap.
 *
 * `node:https` only: this module adds no dependency for a handshake that runs at
 * most twice per create. The cap is not decoration — a connector that answers
 * with a 200 and an endless body must not become an unbounded buffer.
 */
function httpsRequest(url, { method = 'GET', headers = {}, maxBytes = 256 * 1024, hops = 5, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const visit = (target, remaining) => {
      const client = String(target).startsWith('https:') ? https : http
      const request = client.request(target, { method, headers, timeout: timeoutMs }, (response) => {
        const status = Number(response.statusCode || 0)
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume()
          if (remaining <= 0) {
            reject(windowsCodeError('too-many-redirects', `too many redirects starting at ${url}`))
            return
          }
          // J1-1: A `Location` HEADER IS EXTERNAL INPUT. `new URL()` throws on
          // one the parser refuses (`\n`, a bare `://`, an empty string with a
          // base-less caller), and an exception thrown from inside this response
          // callback escapes the promise — an uncaught exception that takes the
          // WHOLE supervisor down, in a code path an attacker-adjacent server
          // controls. A bad redirect is THIS STRATEGY's failure: reject, so the
          // chain records it and moves to the next source.
          let next
          try {
            next = new URL(String(response.headers.location), target).toString()
          } catch (error) {
            reject(windowsCodeError('bad-redirect', `the redirect from ${target} carried an invalid Location header (${String(response.headers.location).slice(0, 120)}): ${String(error?.message ?? error)}`))
            return
          }
          visit(next, remaining - 1)
          return
        }
        readResponseBody(response, maxBytes).then(
          (body) => resolve({ status, headers: response.headers, body, url: target }),
          reject
        )
      })
      request.on('timeout', () => request.destroy(windowsCodeError('http-timeout', `no answer from ${target} within ${timeoutMs} ms`)))
      request.on('error', reject)
      request.end()
    }
    visit(String(url), hops)
  })
}

/** JSON, tolerating a BOM or a JSONP wrapper (the connector does both). */
function parseJsonDocument(text) {
  const trimmed = String(text ?? '').replace(/^\uFEFF/u, '').trim()
  if (trimmed === '') return null
  try { return JSON.parse(trimmed) } catch {}
  const wrapped = /^[^(]*\(([\s\S]*)\)[;\s]*$/u.exec(trimmed)
  if (wrapped !== null) {
    try { return JSON.parse(wrapped[1]) } catch {}
  }
  return null
}

function midoRejected(text) {
  const body = String(text ?? '')
  return MIDO_REJECTIONS.some((needle) => body.includes(needle))
}

/** The product id the page publishes today (the fallback when 3321/2618 drift). */
async function scrapeMidoProductId(page) {
  const answer = await httpsRequest(page, { headers: { 'User-Agent': MIDO_UA, Accept: 'text/html' }, maxBytes: 2 * 1024 * 1024 })
  const match = /<option[^>]*value="(\d+)"/u.exec(answer.body.toString('utf8'))
  return match === null ? null : match[1]
}

/**
 * The four-call handshake for one product id.
 *
 * Throws with a precise sentence at the call that failed, so the chain can log
 * "mido: the SKU list came back rejected" instead of a generic timeout.
 */
async function midoHandshake(product, productId) {
  const session = randomUUID()
  const pageHeaders = { 'User-Agent': MIDO_UA, Referer: product.page, Accept: 'application/json, text/plain, */*' }
  // 1. TAGS — an EMPTY Accept is what the page sends; some proxies rewrite it.
  await httpsRequest(MIDO_TAGS_URL(session), { headers: { Accept: '' }, maxBytes: 100 * 1024 })
  // 2. MDT — carries `w`, `mdt` and `rticks` for THIS session.
  const mdtText = (await httpsRequest(MIDO_MDT_URL(session), { headers: { 'User-Agent': MIDO_UA, Accept: '*/*' }, maxBytes: 512 * 1024 })).body.toString('utf8')
  if (midoRejected(mdtText)) throw windowsCodeError('mido-rejected', 'the live page rejected the session (mdt.js)')
  const w = /\b(?:var|let|const)?\s*\bw\b\s*[:=]\s*['"]?([A-Za-z0-9._~%+-]{3,})['"]?/u.exec(mdtText)?.[1]
  const rticks = /\b(?:var|let|const)?\s*\brticks\b\s*[:=]\s*['"]?([0-9]{2,})['"]?/u.exec(mdtText)?.[1]
  const mdt = /\b(?:var|let|const)?\s*\bmdt\b\s*[:=]\s*['"]?([A-Za-z0-9._~%+-]{1,})['"]?/u.exec(mdtText)?.[1] ?? '0'
  if (typeof w !== 'string' || w === '' || typeof rticks !== 'string' || rticks === '') {
    throw windowsCodeError('mido-handshake', 'the live page did not return its w/rticks handshake values (mdt.js changed shape)')
  }
  // 3. REPLY — registers the session; the connector is ready ~200 ms later.
  await delay(200)
  const reply = (await httpsRequest(MIDO_REPLY_URL(session, w, mdt, rticks), { headers: { ...pageHeaders, Accept: 'text/html,application/javascript,*/*' }, maxBytes: 256 * 1024 })).body.toString('utf8')
  if (midoRejected(reply)) throw windowsCodeError('mido-rejected', 'the live page rejected the session (reply)')
  // 4. SKU — the edition list; English is the one this backend installs.
  const skuText = (await httpsRequest(MIDO_SKU_URL(session, productId), { headers: pageHeaders, maxBytes: 512 * 1024 })).body.toString('utf8')
  if (midoRejected(skuText)) throw windowsCodeError('mido-rejected', 'the live page rejected the session (sku)')
  const skuDocument = parseJsonDocument(skuText)
  const skus = Array.isArray(skuDocument?.Skus) ? skuDocument.Skus : []
  const english = skus.find((entry) => String(entry?.Language ?? '').toLowerCase() === 'english')
    ?? skus.find((entry) => String(entry?.LanguageCode ?? '').toLowerCase() === 'en-us')
    ?? skus[0]
  const skuId = String(english?.Id ?? '')
  if (skuId === '') throw windowsCodeError('mido-sku', 'the SKU list carried no English edition')
  // 5. LINK — the first DownloadType 1 option is the direct ISO.
  const linkText = (await httpsRequest(MIDO_LINK_URL(session, skuId), { headers: pageHeaders, maxBytes: 512 * 1024 })).body.toString('utf8')
  if (midoRejected(linkText)) throw windowsCodeError('mido-rejected', 'the live page rejected the session (link)')
  const linkDocument = parseJsonDocument(linkText)
  const options = Array.isArray(linkDocument?.ProductDownloadOptions) ? linkDocument.ProductDownloadOptions : []
  const option = options.find((entry) => Number(entry?.DownloadType) === 1) ?? options[0]
  const uri = String(option?.Uri ?? '')
  if (!/^https:\/\//iu.test(uri)) throw windowsCodeError('mido-link', 'the download link list carried no https URI')
  return {
    strategy: 'mido',
    url: uri,
    label: `live Microsoft page (ProductEditionId ${productId}, ${product.page.replace('https://www.microsoft.com', '')})`,
    // The connector does not publish a digest; its Content-Length is still the
    // authority at download time (see ensureIso).
    bytes: Number(option?.SizeInBytes ?? 0) || 0,
    sha256: '',
    productId
  }
}

/**
 * THE LIVE URL FOR A VERSION, or a precise refusal.
 *
 * A rejected/failed handshake retries ONCE after re-scraping the page for its
 * current product id: Microsoft renumbers these between releases, and a pinned
 * 3321 that no longer exists is exactly the drift this strategy exists to
 * absorb. Two failures are reported, never looped.
 */
export async function resolveMidoUrl(version) {
  const code = canonicalWindowsVersion(version)
  const product = MIDO_PRODUCTS[code]
  if (product === undefined) {
    throw windowsCodeError('no-mido-product', `no live Microsoft download page is known for "${code}": the mido strategy exists for ${Object.keys(MIDO_PRODUCTS).join(', ')}`)
  }
  let productId = product.productId
  let failure = null
  for (let round = 0; round < 2; round += 1) {
    try {
      return await midoHandshake(product, productId)
    } catch (error) {
      failure = error
      if (round === 1) break
      let rebuilt = null
      try { rebuilt = await scrapeMidoProductId(product.page) } catch { rebuilt = null }
      if (typeof rebuilt !== 'string' || rebuilt === '' || rebuilt === productId) break
      productId = rebuilt
    }
  }
  throw failure ?? windowsCodeError('mido-failed', `the live Microsoft page for "${code}" did not answer`)
}

/* ------------------------------------------------------------------ *
 * The ESD catalog (cab), and the extractors we refuse to install
 * ------------------------------------------------------------------ */

const CAB_EXTRACTORS = ['7z', '7za', 'cabextract']

/** Is `name` an executable in PATH? Pure fs walk — never runs anything. */
function hasBinary(name) {
  const dirs = String(process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== '')
  for (const dir of dirs) {
    const candidate = path.join(dir, name)
    try {
      if (statSync(candidate).isFile()) return true
    } catch {}
  }
  return false
}

/** The first cab extractor already present, or '' (never installed by us). */
export function cabExtractor() {
  for (const name of CAB_EXTRACTORS) {
    if (hasBinary(name)) return name
  }
  return ''
}

/** Which product family a code wants out of the ESD catalog's XML. */
const ESD_FAMILY = {
  '11': /client|consumer|business|windows[_ ]11/iu,
  '11e': /enterprise/iu,
  '10': /client|consumer|business|windows[_ ]10/iu,
  '10e': /enterprise/iu
}

/**
 * THE ESD CATALOG, READ ONLY WHEN AN EXTRACTOR ALREADY EXISTS.
 *
 * The fwlink resolves to a `catalog.cab` whose `products.xml` lists the media.
 * A container that does not ship 7z/cabextract simply does not get this
 * strategy (`skipped: 'no cab extractor'`) — installing a package from a
 * download path would be a supply-chain change nobody asked for, and the
 * pinned mirrors are already verified by digest.
 *
 * Returns null when the catalog could not be read OR did not contain a matching
 * en-us ISO: both mean "try the next strategy", never "install something else".
 */
async function resolveEsdUrl(source, code) {
  const extractor = cabExtractor()
  if (extractor === '') return null
  const cab = (await httpsRequest(source.url, { maxBytes: 64 * 1024 * 1024, timeoutMs: 120000 })).body
  const work = mkdtempSync(path.join(os.tmpdir(), 'dsh-esd-'))
  try {
    const cabPath = path.join(work, 'catalog.cab')
    writeFileSync(cabPath, cab)
    if (extractor === 'cabextract') execFileSync(extractor, ['-q', '-d', work, cabPath], { timeout: 120000, stdio: 'ignore' })
    else execFileSync(extractor, ['x', '-y', `-o${work}`, cabPath], { timeout: 120000, stdio: 'ignore' })
    const xmlName = readdirSync(work).find((file) => file.toLowerCase().endsWith('.xml'))
    if (xmlName === undefined) return null
    const xml = readFileSync(path.join(work, xmlName), 'utf8')
    const family = ESD_FAMILY[code] ?? null
    const products = [...xml.matchAll(/<Product>([\s\S]*?)<\/Product>/gu)].map((match) => match[1])
    const candidates = []
    for (const product of products) {
      const name = /<Name>([\s\S]*?)<\/Name>/u.exec(product)?.[1] ?? ''
      for (const file of product.matchAll(/<File>([\s\S]*?)<\/File>/gu)) {
        const body = file[1]
        const fileName = /<FileName>([\s\S]*?)<\/FileName>/u.exec(body)?.[1] ?? ''
        const filePath = /<FilePath>([\s\S]*?)<\/FilePath>/u.exec(body)?.[1] ?? fileName
        const language = /<LanguageCode>([\s\S]*?)<\/LanguageCode>/u.exec(body)?.[1] ?? ''
        if (!/\.iso$/iu.test(filePath)) continue
        if (!/^en-us$/iu.test(language)) continue
        candidates.push({
          name,
          path: filePath,
          bytes: Number(/<Size>(\d+)<\/Size>/u.exec(body)?.[1] ?? 0) || 0
        })
      }
    }
    const chosen = (family === null ? candidates[0] : candidates.find((entry) => family.test(entry.name) || family.test(entry.path))) ?? null
    if (chosen === null) return null
    return {
      strategy: 'esd',
      url: `https://software-download.microsoft.com/download/${chosen.path.replace(/^\/+/u, '')}`,
      label: `${chosen.name || 'ESD catalog entry'} (${chosen.path})`,
      bytes: chosen.bytes,
      sha256: ''
    }
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch {}
  }
}

/* ------------------------------------------------------------------ *
 * ISO handling
 * ------------------------------------------------------------------ */

/** Where an ISO URL will land. Exported so the caller can tell "cached" from
 *  "about to download 5.5 GB" BEFORE calling ensureIso (and reserve for it). */
export function isoTargetPath(isoDir, url) {
  return path.join(isoDir, isoFileName(url))
}

/**
 * A stable file name for a URL.
 *
 * STABLE IS THE WHOLE POINT. The old name appended `randomBytes(4)`, so the
 * SAME url produced a different file name on every call: `isoTargetPath()` (the
 * quota reservation and the prune keep-list) named one path while `ensureIso`
 * wrote another, and every restart re-downloaded 5.5 GB into a second copy.
 * A digest OF THE URL keeps the readable base name and makes the mapping a
 * function again: same url → same path, two urls → two paths.
 */
export function isoFileName(url) {
  const base = decodeURIComponent(String(url).split('/').pop() || 'windows.iso').replace(/[^\w.-]+/gu, '-')
  const digest = createHash('sha1').update(String(url)).digest('hex').slice(0, 8)
  const stem = base.toLowerCase().endsWith('.iso') ? base.slice(0, -4) : base
  return `${stem}-${digest}.iso`
}

/** url → { bytes, sha256 } for every pinned object, so a bare ensureIso(url) is still verified. */
const ISO_PINS_BY_URL = (() => {
  const pins = new Map()
  for (const entry of Object.values(WINDOWS_ISO_SOURCES)) {
    for (const source of entry.sources) {
      if (typeof source.url !== 'string' || source.url === '') continue
      if (source.bytes <= 0 && source.sha256 === '') continue
      pins.set(source.url, { bytes: Number(source.bytes) || 0, sha256: String(source.sha256 ?? '') })
    }
  }
  return pins
})()

/**
 * A streaming SHA-256 of a file, compared against the pinned digest.
 *
 * Throws `{ code: 'iso-digest-mismatch' }` rather than returning false: a
 * digest that does not match is not a boolean to be ignored by the caller, it is
 * the single fact that says "do not boot this".
 */
export async function verifyIsoDigest(file, expectedSha256) {
  const want = String(expectedSha256 ?? '').trim().toLowerCase()
  if (want === '') return { path: file, sha256: '', verified: false }
  const hasher = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hasher.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  const digest = hasher.digest('hex')
  if (digest !== want) {
    throw windowsCodeError('iso-digest-mismatch', `${path.basename(file)} has SHA-256 ${digest} but this source pins ${want} — refusing to install an image nobody verified`)
  }
  return { path: file, sha256: digest, verified: true }
}

/**
 * J20-1a: THE DOCUMENTED OPT-OUT FROM THE PINNED DIGEST.
 *
 * `DSH_CUA_WIN_ISO_SHA256=0` exists for one real situation: an operator points
 * `windowsIso` at a mirror that serves byte-identical media under a different
 * object, or at a locally rebuilt ISO, and the pinned digest cannot match by
 * construction. It is deliberately the STRING `'0'` only — unset and `'1'` keep
 * the full check, so a stray empty env value can never silence it.
 *
 * It disables the DIGEST comparison and NOTHING ELSE: `expectedBytes` is still
 * enforced before the first byte is written and after the last one, and every
 * result that skipped the digest says `verified: false` plus this note. A
 * skipped check must be visible in the answer, never inferred from silence.
 */
export const ISO_DIGEST_DISABLED_NOTE = 'digest check disabled by DSH_CUA_WIN_ISO_SHA256=0'

export function isoDigestCheckDisabled() {
  return String(process.env.DSH_CUA_WIN_ISO_SHA256 ?? '') === '0'
}

/** A `.sha256` sidecar's content must be a digest, not a sentence. */
const SHA256_HEX = /^[0-9a-f]{64}$/u

/**
 * A CACHED ISO IS ONLY CACHED IF IT IS THE FILE WE PINNED.
 *
 * The old hit test was `exists && size > 1 MB`, which accepted a half-written
 * file from a killed download, an ISO of a different build that happened to
 * share the name, and a downloaded-then-patched image. The three facts that
 * decide it are the pinned size, the `.sha256` sidecar written next to a
 * verified download, and one streaming hash of the file itself.
 *
 * J1-5: TWO HOLES CLOSED.
 *   * NO PIN IS NOT A PASS. `wantSha === ''` used to return `ok: true`
 *     silently: a cache hit that verified nothing, for the one class of file
 *     nobody had ever checked. Now the sidecar is the only claim available, and
 *     it is verified AGAINST THE FILE — digest the bytes, compare to the
 *     sidecar — or the cache is refused with `unpinned-cache` and downloaded
 *     again. "Unpinned" must cost a download, not a lie.
 *   * A MATCHING SIDECAR IS NOT A PASS EITHER. A sidecar is a text file that
 *     anything on the host can write; trusting it is trusting the last writer.
 *     When a pin exists the file is hashed and compared to the pin, sidecar or
 *     no sidecar (the sidecar is then refreshed from the measured value).
 */
async function inspectCachedIso(target, { sidecar, wantBytes, wantSha }) {
  const size = statSync(target).size
  if (wantBytes > 0 && size !== wantBytes) return { ok: false, reason: `size ${size} ≠ pinned ${wantBytes}` }
  const digestDisabled = isoDigestCheckDisabled()
  let recorded = ''
  try { recorded = readFileSync(sidecar, 'utf8').trim().toLowerCase() } catch {}
  if (wantSha === '') {
    if (!SHA256_HEX.test(recorded)) {
      return { ok: false, reason: 'unpinned-cache' }
    }
    if (digestDisabled) {
      return { ok: true, verified: false, sha256: '', note: ISO_DIGEST_DISABLED_NOTE }
    }
    try {
      const verified = await verifyIsoDigest(target, recorded)
      return { ok: true, verified: true, sha256: verified.sha256 }
    } catch (error) {
      return { ok: false, reason: `the sidecar names ${recorded.slice(0, 12)}… but the cached file hashes differently: ${String(error?.message ?? error)}` }
    }
  }
  if (digestDisabled) {
    // The SIZE was enforced above; the digest comparison is what the operator
    // asked to skip, and saying so is part of the answer.
    return { ok: true, verified: false, sha256: '', note: ISO_DIGEST_DISABLED_NOTE }
  }
  if (recorded !== '' && recorded !== wantSha) {
    return { ok: false, reason: `sidecar digest ${recorded.slice(0, 12)}… ≠ pinned ${wantSha.slice(0, 12)}…` }
  }
  try {
    const verified = await verifyIsoDigest(target, wantSha)
    try { writeFileSync(sidecar, `${verified.sha256}\n`) } catch {}
    return { ok: true, verified: true, sha256: verified.sha256 }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/**
 * Make sure an ISO is on disk, downloading it once.
 *
 * WHY A TIMEOUT AND A PROGRESS HOOK: a 7 GB download over a slow link is tens of
 * minutes, and a create that reports nothing for minutes looks hung. The
 * supervisor turns `onProgress` into a log line and keeps the row's
 * `installDetail` moving; `timeoutMs` bounds the whole transfer, and its default
 * is derived from the version's own size (120 min at 7 GB and up, 60 min below)
 * because a flat hour is a lie for Windows 11 and a waste for Tiny10.
 *
 * WHAT IS ASSERTED, AND WHERE:
 *   * `expectedBytes` vs the server's Content-Length → a substituted object is
 *     refused BEFORE 8 GB are written;
 *   * the running SHA-256 of the body vs `expectedSha256` → the file that lands
 *     is the file that was pinned (and `.sha256` records it for the next boot);
 *   * `received` vs Content-Length → a connection that drops at 80% is not a
 *     usable ISO;
 *   * a bytes-0 / sha256-'' entry only skips the assertions IT cannot make.
 */
export async function ensureIso({
  url,
  isoDir,
  bytes = 0,
  sha256 = '',
  expectedBytes = 0,
  expectedSha256 = '',
  sizeGb = 0,
  timeoutMs = 0,
  onProgress = () => {},
  log = () => {}
}) {
  if (!/^https?:\/\//iu.test(String(url || ''))) return { path: url, downloaded: false, bytes: 0, sha256: '', verified: false }
  mkdirSync(isoDir, { recursive: true })
  // A bare `ensureIso({url})` (the supervisor's shape) still gets the pins: the
  // URL itself is the key into the catalog.
  const pin = ISO_PINS_BY_URL.get(String(url)) ?? { bytes: 0, sha256: '' }
  const wantBytes = Number(expectedBytes || bytes || pin.bytes || 0)
  const wantSha = String(expectedSha256 || sha256 || pin.sha256 || '').trim().toLowerCase()
  // J20-1b: the opt-out is decided ONCE per download, so the pre-write size
  // check, the streaming digest and the returned `note` cannot disagree.
  const digestDisabled = isoDigestCheckDisabled()
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : (Number(sizeGb) >= 7 ? 120 : 60) * 60 * 1000
  const target = path.join(isoDir, isoFileName(url))
  const sidecar = `${target}.sha256`

  if (existsSync(target) && statSync(target).size > 1024 * 1024) {
    const cached = await inspectCachedIso(target, { sidecar, wantBytes, wantSha })
    if (cached.ok) {
      const size = statSync(target).size
      log(`iso: ${path.basename(target)} is cached (${(size / 1024 ** 3).toFixed(2)} GB${cached.verified ? ', digest verified' : ''}${cached.note ? `, ${cached.note}` : ''})`)
      return { path: target, downloaded: false, bytes: size, sha256: cached.sha256, verified: cached.verified, ...(cached.note ? { note: cached.note } : {}) }
    }
    log(`iso: cached ${path.basename(target)} rejected (${cached.reason}); re-downloading`)
    try { unlinkSync(target) } catch {}
    try { unlinkSync(sidecar) } catch {}
  }

  const partial = `${target}.part`
  // A killed download leaves a `.part` behind; the next attempt must not append
  // to it (which is how a truncated ISO ends up "complete").
  try { unlinkSync(partial) } catch {}

  const started = Date.now()
  let received = 0
  let expected = 0
  let lastReport = 0
  let hasher = null

  const fetchTo = (from) => new Promise((resolve, reject) => {
    const client = String(from).startsWith('https:') ? https : http
    let settled = false
    let stream = null
    const fail = (error) => {
      if (settled) return
      settled = true
      try { stream?.destroy() } catch {}
      try { request.destroy() } catch {}
      try { unlinkSync(partial) } catch {}
      reject(error)
    }
    const request = client.get(from, { timeout: 60000 }, (response) => {
      // Redirects are normal for Microsoft's CDN.
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        // J1-1: same rule as httpsRequest() — a `Location` the URL parser
        // rejects is a failure of THIS HOP, reported through `fail()` (which
        // unlinks the .part and rejects) instead of an exception thrown out of
        // a socket callback. `ensureIsoForSource()` then counts it as this
        // strategy's error and tries the next one.
        let next
        try {
          next = new URL(response.headers.location, from).toString()
        } catch (error) {
          fail(windowsCodeError('bad-redirect', `the redirect from ${from} carried an invalid Location header (${String(response.headers.location).slice(0, 120)}): ${String(error?.message ?? error)}`))
          return
        }
        settled = true
        resolve({ redirect: next })
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        fail(windowsCodeError('iso-http', `ISO download failed: HTTP ${response.statusCode} for ${from}`))
        return
      }
      const declared = Number(response.headers['content-length'] || 0)
      // THE PIN IS CHECKED BEFORE THE FIRST BYTE IS WRITTEN. A CDN that starts
      // serving a different object answers with a different length; writing it
      // and only noticing at the digest costs the transfer twice.
      if (wantBytes > 0 && declared > 0 && declared !== wantBytes) {
        fail(windowsCodeError('iso-size-mismatch', `the server offers ${declared} bytes but this source pins ${wantBytes} bytes (${from})`))
        return
      }
      expected = declared
      hasher = createHash('sha256')
      stream = createWriteStream(partial)
      response.on('data', (chunk) => {
        received += chunk.length
        hasher.update(chunk)
        if (Date.now() - started > budget) {
          fail(windowsCodeError('iso-timeout', `ISO download timed out after ${Math.round(budget / 1000)} s (${(received / 1024 ** 3).toFixed(2)} GB received)`))
          return
        }
        if (Date.now() - lastReport > 5000) {
          lastReport = Date.now()
          onProgress(expected > 0 ? received / expected : null, received)
        }
      })
      response.on('aborted', () => fail(new Error('the ISO connection was aborted')))
      response.on('error', fail)
      stream.on('error', fail)
      response.pipe(stream)
      stream.on('finish', () => {
        if (settled) return
        // SHORT READ = A BROKEN ISO. Content-Length is authoritative; without
        // this check a connection that drops at 80% leaves a 4 GB file that
        // `existsSync && size > 1 MB` would happily reuse forever.
        if (expected > 0 && received !== expected) {
          fail(windowsCodeError('iso-truncated', `ISO download was truncated: ${received} of ${expected} bytes`))
          return
        }
        const digest = hasher.digest('hex')
        // INCREMENTAL, NOT A SECOND PASS: the hash was fed while writing, so a
        // mismatch costs nothing extra and the file never wears the final name.
        if (wantSha !== '' && !digestDisabled && digest !== wantSha) {
          fail(windowsCodeError('iso-digest-mismatch', `${path.basename(target)} downloaded as SHA-256 ${digest} but this source pins ${wantSha} — refusing to keep it`))
          return
        }
        stream.close(() => {
          if (settled) return
          settled = true
          try {
            // SAME DIRECTORY → a real atomic rename. `copyFileSync` here meant
            // another 5.5 GB write and a window where a kill left a half-copied
            // file wearing the final name.
            renameSync(partial, target)
            try { writeFileSync(sidecar, `${digest}\n`) } catch {}
            log(`iso: ${path.basename(target)} (${(statSync(target).size / 1024 ** 3).toFixed(2)} GB${wantSha !== '' && !digestDisabled ? ', digest verified' : ''}${digestDisabled ? `, ${ISO_DIGEST_DISABLED_NOTE}` : ''})`)
            resolve({ path: target, sha256: digest, verified: wantSha !== '' && !digestDisabled, ...(digestDisabled ? { note: ISO_DIGEST_DISABLED_NOTE } : {}) })
          } catch (error) {
            fail(error)
          }
        })
      })
    })
    request.on('timeout', () => fail(new Error('ISO download socket timed out')))
    request.on('error', fail)
  })

  let current = url
  for (let hop = 0; hop < 5; hop += 1) {
    const result = await fetchTo(current)
    if (result.redirect !== undefined) {
      current = result.redirect
      received = 0
      expected = 0
      hasher = null
      continue
    }
    return { path: result.path, downloaded: true, bytes: statSync(result.path).size, sha256: result.sha256, verified: result.verified, ...(result.note ? { note: result.note } : {}) }
  }
  throw new Error(`ISO download followed too many redirects (>5) starting at ${url}`)
}

/**
 * WALK A VERSION'S CHAIN and return the first medium that actually landed.
 *
 * Every strategy is tried exactly once, a failure sleeps 1 s (a CDN that just
 * 429'd must not be hammered by the next attempt) and the AGGREGATE error names
 * every strategy and its first line — "no ISO" without the four reasons is the
 * kind of error that sends an operator to the wrong fix.
 *
 * Returns `{ path, downloaded, bytes, sha256, verified, attempts, sourceId }`;
 * `sourceId` is the strategy that won, which the row can show ("downloaded from
 * link1") instead of leaving the provenance invisible.
 */
export async function ensureIsoForSource(sources, { isoDir, sizeGb = 0, timeoutMs = 0, onProgress = () => {}, log = () => {}, sleepMs = 1000 } = {}) {
  const list = Array.isArray(sources) ? sources.filter((source) => source !== null && typeof source === 'object') : []
  // A REFUSED VERSION HAS NO DOWNLOAD, even when a caller reaches this with the
  // chain in hand: XP's bytes exist on mirrors, and fetching 600 MB of media
  // whose Setup cannot be answered is the exact waste the refusal exists to
  // prevent. Belt and braces with resolveWindowsIso(), which is the usual gate.
  for (const source of list) {
    const entry = source.code === undefined ? undefined : WINDOWS_CATALOG[source.code]
    if (entry !== undefined && typeof entry.refusal === 'string') {
      const error = windowsCodeError(entry.refusal, `${entry.label} cannot be installed by this backend: ${entry.refusalDetail}`)
      error.detail = entry.refusalDetail
      throw error
    }
  }
  const attempts = []
  for (const source of list) {
    const strategy = String(source.strategy ?? 'source')
    try {
      const resolved = await resolveIsoSourceToUrl(source, { log })
      if (resolved === null) {
        attempts.push({ strategy, error: String(source.skipped ?? 'skipped') })
        continue
      }
      const result = await ensureIso({
        url: resolved.url,
        isoDir,
        bytes: Number(resolved.bytes ?? source.bytes ?? 0) || 0,
        sha256: String(resolved.sha256 ?? source.sha256 ?? ''),
        // THE SIZE PICKS THE BUDGET. A 7.9 GB Windows 11 ISO on a 20 Mbit link is
        // 55 minutes; the old flat hour killed that download at 90%. When the
        // caller does not state a size, the catalog's own `sizeGb` does.
        sizeGb: Number(sizeGb) || Number(WINDOWS_CATALOG[source.code]?.sizeGb) || 0,
        timeoutMs,
        onProgress,
        log
      })
      log(`iso: ${strategy} delivered ${path.basename(result.path)}`)
      return { ...result, attempts, sourceId: strategy, sha256: result.sha256 ?? '', bytes: result.bytes ?? 0 }
    } catch (error) {
      const message = String(error?.message ?? error)
      attempts.push({ strategy, error: message })
      log(`iso: ${strategy} failed (${firstLine(message)}); trying the next source`)
      if (sleepMs > 0) await delay(sleepMs)
    }
  }
  const error = windowsCodeError('iso-unavailable', `no install medium for this version could be downloaded; ${attempts.length} strategies tried: ${attempts.map((entry) => `${entry.strategy}: ${firstLine(entry.error)}`).join(' | ')}`)
  error.attempts = attempts
  throw error
}

/** The first line of a message, for a one-line aggregate. */
function firstLine(text) {
  return String(text ?? '').split('\n')[0].trim() || 'failed'
}

/**
 * Turn ONE strategy descriptor into a concrete URL.
 *
 * `null` means "this strategy cannot run here" (a skipped ESD catalog, an empty
 * descriptor) — the chain records it as `skipped` and moves on, which is
 * different from a failure and must not be reported as one.
 */
async function resolveIsoSourceToUrl(source, { log = () => {} } = {}) {
  if (typeof source.skipped === 'string' && source.skipped !== '') {
    log(`iso: ${source.strategy} skipped (${source.skipped})`)
    return null
  }
  if (source.strategy === 'mido') {
    const live = await resolveMidoUrl(source.code)
    return { url: live.url, bytes: Number(live.bytes) || 0, sha256: '' }
  }
  if (source.strategy === 'esd') {
    return await resolveEsdUrl(source, source.code)
  }
  if (typeof source.url === 'string' && source.url !== '') {
    return { url: source.url, bytes: Number(source.bytes) || 0, sha256: String(source.sha256 ?? '') }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * The OEM payload
 * ------------------------------------------------------------------ */

/**
 * THE FOUR FILES THE UNATTENDED INSTALL CANNOT RUN WITHOUT.
 *
 * Exported because both the error text and the image gate talk about the same
 * list: a fifth file added here without its COPY is exactly the drift this
 * constant prevents. These four are what makes a payload DIRECTORY a payload
 * directory (`oemPayloadDirStatus`), so they stay the identity test.
 */
export const OEM_PAYLOAD_REQUIRED = Object.freeze(['Autounattend.xml', 'setupcomplete.cmd', 'cua-firstboot.ps1', 'Unattend.vbs'])

/**
 * THE CLIPBOARD AGENT'S SCRIPT — payload, but with its own source chain.
 *
 * The guest needs `C:\ProgramData\cua\clip-agent.ps1` for the `cua-clip-agent`
 * task that firstboot registers, and the SAME file must be reachable by
 * `cua-firstboot.ps1` at first logon (it searches `$PSScriptRoot`,
 * `C:\Windows\Setup\Scripts` and the removable roots), which is why it is
 * staged at the medium's ROOT as well as into `$OEM$`.
 *
 * It is listed with the payload but NOT required inside one payload directory:
 * the image copies it into `/usr/local/share/cua-vm/windows-oem/`, while a
 * checkout keeps it BESIDE that directory (`docker/cua-clip-agent.ps1` next to
 * `docker/windows-oem/`). resolveOemClipAgentSource() accepts both layouts, and
 * the difference is only where the bytes are found — never whether they ship.
 */
export const OEM_CLIP_AGENT_FILE = 'cua-clip-agent.ps1'

/**
 * J22-6: THE PRIVACY OFF-SWITCH, MATERIALIZED AS A FILE.
 *
 * `DSH_CUA_CLIP_AGENT=0` means "do not run the ambient clipboard loop", but the
 * GUEST CANNOT READ THE HOST ENVIRONMENT — the flag is a staging-time variable
 * and there is no channel back to it from Windows. Both consumers therefore test
 * a path, not an env var:
 *
 *   windows-oem/cua-firstboot.ps1   refuses to register the logon task and
 *                                   records `skipped: true, reason: clip-agent-disabled`
 *   docker/cua-clip-agent.ps1       exits quietly at startup, so a machine whose
 *                                   task was registered before the switch was
 *                                   flipped also stops
 *
 * Those consumers existed with nothing writing the sentinel, so the switch was
 * inert. THIS backend is the writer: writeOemPayload() stages this file beside
 * the payload when (and only when) the knob is `0`, and it travels to the guest
 * on BOTH routes the other payload files use — the setup.img ROOT (SETUP_IMAGE_
 * ENTRIES) and `$OEM$/$$/Setup/Scripts`, which Setup copies into
 * `C:\Windows\Setup\Scripts`. Those are the same locations firstboot searches
 * for `cua-clip-agent.ps1`; firstboot copies the sentinel from its search
 * locations to `C:\ProgramData\cua\` BEFORE the off-switch check, which is what
 * turns "a file on the medium" into the path both consumers test. (That guest
 * copy step is a small firstboot change landing in the same commit.)
 *
 * IT IS NOT PART OF OEM_PAYLOAD_REQUIRED: a payload directory must stay valid
 * with the knob unset, and this file legitimately does not exist then.
 */
export const CLIP_AGENT_SENTINEL_FILE = 'clip-agent-disabled'

/** Every file the answer medium carries: the four answer-file members + the agent. */
export const OEM_PAYLOAD_FILES = Object.freeze([...OEM_PAYLOAD_REQUIRED, OEM_CLIP_AGENT_FILE])

/**
 * The first place `cua-clip-agent.ps1` can be read from, or null.
 *
 * Each candidate is tried as a DIRECTORY (image layout:
 * `<payload-dir>/cua-clip-agent.ps1`) and then as a SIBLING of that directory
 * (checkout layout: `docker/cua-clip-agent.ps1` beside `docker/windows-oem/`).
 * Exported so the error text and a test can name the same chain.
 */
export function resolveOemClipAgentSource(candidates = []) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    for (const probe of [path.join(candidate, OEM_CLIP_AGENT_FILE), path.join(candidate, '..', OEM_CLIP_AGENT_FILE)]) {
      try {
        if (statSync(probe).isFile()) return probe
      } catch {}
    }
  }
  return null
}

/**
 * S1: THE ANSWER-FILE MEDIUM'S ROOT ENTRIES.
 *
 * This is the list copied into `setup.img`'s ROOT — the same layout dockur uses:
 *
 *   Autounattend.xml                     what WinPE reads
 *   startup.nsh                          the EFI Shell fallback (see R5)
 *   $OEM$/$$/Setup/Scripts/*.cmd|ps1|vbs  copied by Setup into C:\Windows\Setup\Scripts
 *
 * `setupcomplete.cmd` and `cua-firstboot.ps1` are ALSO at the root: Setup finds
 * the `$OEM$` copies, and the root copies are what a human can inspect from the
 * medium. `Unattend.vbs` is the hidden launcher (see docker/windows-oem/).
 *
 * `cua-clip-agent.ps1` is at the root for a different reader: firstboot looks
 * for it on `$PSScriptRoot`, `C:\Windows\Setup\Scripts` AND the removable
 * roots (C:..H:), so a copy at the medium root is what makes the agent survive
 * a firstboot that runs from the fallback path rather than from Setup\Scripts.
 */
export const SETUP_IMAGE_ENTRIES = Object.freeze([
  'Autounattend.xml',
  'setupcomplete.cmd',
  'cua-firstboot.ps1',
  'Unattend.vbs',
  OEM_CLIP_AGENT_FILE,
  // J22-6: present ONLY when DSH_CUA_CLIP_AGENT=0 at staging time. Listed here
  // because the medium's root is one of the places firstboot searches (and the
  // copy it makes is what reaches C:\ProgramData\cua\); it is optional in
  // SETUP_IMAGE_OPTIONAL, so an unset knob changes nothing that must exist.
  CLIP_AGENT_SENTINEL_FILE,
  'startup.nsh'
])

/**
 * The SETUP_IMAGE_ENTRIES that are staged CONDITIONALLY.
 *
 * The sentinel exists only when the privacy knob is `0`, so "is this entry
 * missing?" cannot be answered without knowing whether it was supposed to be
 * staged. Everything in this list is skipped by the build/verify checks when the
 * staged file is absent — and asserted (copy + read-back) when it is present,
 * which is the half that proves the switch reaches the guest at all.
 */
export const SETUP_IMAGE_OPTIONAL = Object.freeze([CLIP_AGENT_SENTINEL_FILE])

/** The FAT32 volume label Setup presents as the answer medium. */
export const SETUP_IMAGE_LABEL = 'SETUP'

/**
 * FAT32's minimum useful size (the format needs >= 65525 clusters of 512 B),
 * rounded up to 64 MiB: sparse on the host, trivial for the guest, and large
 * enough that mtools never has to guess about cluster geometry.
 */
export const SETUP_IMAGE_BYTES = 64 * 1024 * 1024

/** The mtools commands, named once so a gate and the error text agree. */
export const MTOOLS = Object.freeze({ format: 'mformat', copy: 'mcopy', dir: 'mdir', type: 'mtype' })

/* ------------------------------------------------------------------ *
 * F1: THE ANSWER DISK IS A REAL DISK WITH A REAL PARTITION TABLE
 * ------------------------------------------------------------------ */

/**
 * WHY THERE IS AN MBR HERE AT ALL — the live-verified root cause of the
 * interactive language screen.
 *
 * This module used to hand `mformat`/`mcopy` a bare 64 MiB file: a FAT32
 * "superfloppy", VBR at LBA 0, no MBR and no GPT. mtools' own VBR template puts
 * bytes at 0x1BE that look like a partition entry but are not one.
 *
 * That medium is legal, and the FIRMWARE likes it: EDK2 mounts a raw FAT volume
 * from any block device and even wrote its NvVars to it (the blockstats showed
 * 114 KB of firmware writes on `setup0` and nothing else). WINDOWS IS NOT THE
 * FIRMWARE: WinPE enumerates *fixed disks* through their partition table, so a
 * partitionless fixed disk is never given a drive letter, never mounted, and
 * Setup's drive-root search for `Autounattend.xml` had nothing to scan. The
 * result was the interactive language screen on every install, with the answer
 * file provably present in the image.
 *
 * So the build now writes an MBR with one active type-0x0C (FAT32 LBA) partition
 * starting at LBA 2048 — the conventional 1 MiB alignment — and points EVERY
 * mtools call at the volume through mtools' `@@<byte-offset>` syntax:
 *
 *     mformat -i /path/setup.img@@1048576 …
 *     mcopy  -i /path/setup.img@@1048576 …
 *
 * `@@` takes a BYTE offset (verified against mtools 4.0.48: `@@2048` lands the
 * volume at byte 2048 and mtools rejects the unaligned geometry as "non DOS
 * media", while `@@4194304` = LBA 2048 formats cleanly and `mdir` reads it back).
 *
 * mtools cannot write an MBR, and no partitioner is installed in the image, so
 * the 512-byte stub is generated here in Node and written with `writeSync`.
 * That is deliberately one fewer runtime dependency rather than one more: no
 * `sfdisk`/`parted` addition to the Dockerfile, nothing to keep in sync with
 * util-linux, and the bytes are assertable in a test.
 */
export const SETUP_SECTOR_BYTES = 512

/** First partition sector: 1 MiB of alignment, the universal convention. */
export const SETUP_PARTITION_START_LBA = 2048

/** Where the FAT32 volume actually begins inside setup.img (1 048 576). */
export const SETUP_PARTITION_OFFSET_BYTES = SETUP_PARTITION_START_LBA * SETUP_SECTOR_BYTES

/** MBR partition type 0x0C = FAT32 LBA (0x0B is FAT32 CHS; 0x0C is LBA-mapped). */
export const SETUP_PARTITION_TYPE = 0x0c

/** The boot signature every firmware and Windows' disk driver look for. */
export const SETUP_MBR_SIGNATURE = Object.freeze({ offset: 510, bytes: Object.freeze([0x55, 0xaa]) })

/**
 * The `-i` argument for every mtools call on setup.img: the image PLUS the byte
 * offset of its partition. One function so the build and the read-back can
 * never disagree about where the volume starts.
 */
export function setupVolumeSpec(imagePath) {
  return `${imagePath}@@${SETUP_PARTITION_OFFSET_BYTES}`
}

/**
 * The 512-byte MBR sector: one active FAT32-LBA partition and the 0x55AA
 * signature. Pure, so a test can assert the geometry without a disk.
 *
 * CHS fields are written as 0xFE/0xFF/0xFF — the "too big, use LBA" encoding
 * mtools itself emits — because a 63 MiB partition does not fit the legacy
 * 10/8/6-bit tuple in any meaningful way and every consumer that matters reads
 * the LBA fields.
 */
export function setupMbrSector({ startLba = SETUP_PARTITION_START_LBA, sectorCount = 0, active = true } = {}) {
  if (!Number.isInteger(startLba) || startLba <= 0) throw new Error(`setupMbrSector: startLba must be a positive integer (got ${startLba})`)
  if (!Number.isInteger(sectorCount) || sectorCount <= 0) throw new Error(`setupMbrSector: sectorCount must be a positive integer (got ${sectorCount})`)
  const sector = Buffer.alloc(SETUP_SECTOR_BYTES)
  const entry = 0x1be
  sector[entry] = active ? 0x80 : 0x00
  sector[entry + 1] = 0xfe
  sector[entry + 2] = 0xff
  sector[entry + 3] = 0xff
  sector[entry + 4] = SETUP_PARTITION_TYPE
  sector[entry + 5] = 0xfe
  sector[entry + 6] = 0xff
  sector[entry + 7] = 0xff
  sector.writeUInt32LE(startLba, entry + 8)
  sector.writeUInt32LE(sectorCount, entry + 12)
  sector[SETUP_MBR_SIGNATURE.offset] = SETUP_MBR_SIGNATURE.bytes[0]
  sector[SETUP_MBR_SIGNATURE.offset + 1] = SETUP_MBR_SIGNATURE.bytes[1]
  return sector
}

/** How many sectors the FAT32 volume mformat just laid down, or 0. */
export function setupVolumeSectors(imagePath) {
  const fd = openSync(imagePath, 'r')
  try {
    const bpb = Buffer.alloc(64)
    if (readSync(fd, bpb, 0, 64, SETUP_PARTITION_OFFSET_BYTES) < 64) return 0
    // A BPB only counts if its sector size is the one mtools formats with.
    if (bpb.readUInt16LE(11) !== SETUP_SECTOR_BYTES) return 0
    const total32 = bpb.readUInt32LE(32)
    return total32 > 0 ? total32 : bpb.readUInt16LE(19)
  } finally { closeSync(fd) }
}

/**
 * Write the MBR over an image whose FAT32 volume is already formatted at
 * SETUP_PARTITION_OFFSET_BYTES, and return the partition geometry.
 *
 * ORDER MATTERS: this runs AFTER mformat and BEFORE mcopy. mformat only touches
 * the volume at the offset (verified: LBA 0 survives a `@@`-offset format), but
 * writing the table last means the partition size can be the FAT's real length
 * instead of a guess.
 */
export function writeSetupMbr(imagePath) {
  const totalSectors = Math.floor(statSync(imagePath).size / SETUP_SECTOR_BYTES)
  const available = totalSectors - SETUP_PARTITION_START_LBA
  if (available <= 0) {
    throw new Error(`setup.img is too small to hold a partition at LBA ${SETUP_PARTITION_START_LBA} (${totalSectors} sectors)`)
  }
  const fatSectors = setupVolumeSectors(imagePath)
  // The partition covers the formatted volume (so Windows' idea of the volume
  // length matches the BPB), never more than the disk.
  const sectorCount = fatSectors > 0 ? Math.min(fatSectors, available) : available
  const fd = openSync(imagePath, 'r+')
  try {
    writeSync(fd, setupMbrSector({ startLba: SETUP_PARTITION_START_LBA, sectorCount }), 0, SETUP_SECTOR_BYTES, 0)
  } finally { closeSync(fd) }
  return { startLba: SETUP_PARTITION_START_LBA, offsetBytes: SETUP_PARTITION_OFFSET_BYTES, sectorCount, type: SETUP_PARTITION_TYPE }
}

/** Read the MBR back: the structural assertion that the medium is a DISK. */
export function readSetupMbr(imagePath) {
  const fd = openSync(imagePath, 'r')
  let mbr
  try {
    mbr = Buffer.alloc(SETUP_SECTOR_BYTES)
    if (readSync(fd, mbr, 0, SETUP_SECTOR_BYTES, 0) < SETUP_SECTOR_BYTES) {
      throw new Error(`setup.img has no MBR (shorter than one sector): ${imagePath}`)
    }
  } finally { closeSync(fd) }
  const entry = 0x1be
  return {
    signature: mbr.toString('hex', SETUP_MBR_SIGNATURE.offset, SETUP_MBR_SIGNATURE.offset + 2),
    active: mbr[entry] === 0x80,
    type: mbr[entry + 4],
    startLba: mbr.readUInt32LE(entry + 8),
    sectorCount: mbr.readUInt32LE(entry + 12)
  }
}

/**
 * F2: THE EDITION — SETUP MUST NEVER BE ASKED *WHICH* IMAGE TO INSTALL.
 *
 * `<InstallFrom>` was missing from the answer file. Everything else could be
 * right and Setup still stopped: with no image named, WinPE shows its "Select
 * the operating system you want to install" list, and on a multi-edition
 * evaluation medium (Server 2025 carries four images) that is a page no
 * unattended install can skip.
 *
 * `/IMAGE/NAME` is preferred where the name is KNOWN AND VERIFIED, because it is
 * stable across media revisions that add or reorder indexes. Verified by reading
 * the WIM XML resource straight out of the pinned 11ltsc evaluation ISO
 * (`26100.1742…CLIENT_IOT_LTSC_EVAL_x64FRE_en-us.iso`, read on 2026-11-16):
 *
 *   <IMAGE INDEX="1"> … <NAME>Windows 11 IoT Enterprise LTSC 2024 Evaluation</NAME>
 *                    … <DISPLAYNAME>Windows 11 IoT Enterprise LTSC Evaluation</DISPLAYNAME>
 *
 * Note the media's NAME is the LONG form with the year and the word
 * "Evaluation" — the short label on Microsoft's download page does NOT match it,
 * and a NAME that does not match fails Setup with "the image is not found".
 *
 * `/IMAGE/INDEX` is used where the exact name cannot be verified offline (the
 * media is not on this host) or where the caller supplies an operator ISO. An
 * index is coarser but cannot misspell a name, and index 1 exists on every
 * Windows ISO Microsoft ships.
 */

/**
 * The selection shape every caller sees: which key, which value, and why.
 *
 * DERIVED, NOT DUPLICATED. Every entry comes from `WINDOWS_CATALOG[code]
 * .selection`, so the sixteen-code catalog is the only table that can drift: the
 * old hand-written map still said `11ltsc` after the code became `11l`, and the
 * one code that a create actually needs (the LTSC `NAME`) was reachable under a
 * spelling the catalog no longer accepted. `verified: true` is carried through
 * only where the value was READ from the media (11l / 7u); everything else is
 * an index, which cannot be misspelled but was never confirmed offline.
 */
export const WINDOWS_IMAGE_SELECTIONS = Object.freeze(Object.fromEntries(
  WINDOWS_VERSIONS
    .filter((code) => WINDOWS_CATALOG[code].selection !== undefined)
    .map((code) => {
      const selection = WINDOWS_CATALOG[code].selection
      return [code, Object.freeze({
        key: selection.key,
        value: selection.value,
        verified: selection.verified === true,
        note: `${WINDOWS_CATALOG[code].label}: ${selection.verified === true ? 'read from the media' : 'index reasoned from the media layout'}`
      })]
    })
))

/**
 * Decide the `<InstallFrom>` selection for one create.
 *
 * PRECEDENCE, and every step exists for a different caller:
 *
 *   1. explicit `imageName`         — the operator knows their own ISO;
 *   2. explicit `imageIndex`        — same, but coarser;
 *   3. `sourceSelection`            — the strategy that will actually serve the
 *                                    bytes (link1 pins SERVERSTANDARD by NAME);
 *   4. the catalog's selection      — the DEFAULT for a stock version;
 *   5. `/IMAGE/INDEX 1`             — a version we know nothing about.
 *
 * An empty `version` is not an error here: it is the operator-ISO shape, and it
 * falls straight through to step 5.
 */
export function resolveWindowsImageSelection({ version = '', imageIndex = 0, imageName = '', sourceSelection = null } = {}) {
  const name = String(imageName ?? '').trim()
  const indexText = String(imageIndex ?? '').trim()
  const index = Number(indexText === '' ? 0 : indexText)
  if (indexText !== '' && index !== 0) {
    if (!Number.isInteger(index) || index < 1 || index > 999) {
      throw new Error(`windowsImageIndex "${imageIndex}" is not a Windows image index: expected a whole number 1-999 (see /sources/install.wim in the ISO)`)
    }
  }
  if (name !== '') {
    if (/[<>]/u.test(name)) throw new Error(`windowsImageName "${name}" contains XML delimiters; give the plain edition name, e.g. "Windows 11 IoT Enterprise LTSC 2024 Evaluation"`)
    return { key: '/IMAGE/NAME', value: name, verified: true, source: 'caller' }
  }
  if (index !== 0) return { key: '/IMAGE/INDEX', value: index, verified: true, source: 'caller' }
  if (sourceSelection !== null && typeof sourceSelection === 'object' && typeof sourceSelection.key === 'string') {
    const source = { key: sourceSelection.key, value: sourceSelection.value, verified: sourceSelection.verified === true, source: 'source' }
    if (source.key === '/IMAGE/INDEX' || (typeof source.key === 'string' && source.key.startsWith('/IMAGE/') && source.value !== undefined && source.value !== '')) return source
  }
  const declared = String(version ?? '').trim()
  if (declared === '') return { key: '/IMAGE/INDEX', value: 1, verified: false, source: 'default' }
  // Unknown here THROWS (canonicalWindowsVersion is the one gate), because a
  // create that names a version we cannot resolve must not silently install
  // image 1 of whichever media it happens to find.
  const selection = WINDOWS_CATALOG[canonicalWindowsVersion(declared)].selection
  if (selection !== undefined) return { key: selection.key, value: selection.value, verified: selection.verified === true, source: 'version' }
  return { key: '/IMAGE/INDEX', value: 1, verified: false, source: 'default' }
}

/* ------------------------------------------------------------------ *
 * Firmware profiles — OVMF/UEFI and SeaBIOS are two different computers
 * ------------------------------------------------------------------ */

/**
 * WHY A PROFILE AND NOT A BOOLEAN.
 *
 * The backend was written for Windows 11 and hard-coded its firmware: q35 +
 * OVMF + swtpm + virtio-blk + virtio-net. Every one of those is wrong for the
 * media that predate UEFI:
 *
 *   Windows 7   x64 Setup boots under BIOS only; OVMF reaches "Press any key"
 *               and then finds no bootable device, and the swtpm is a device its
 *               installer has never heard of.
 *   Windows XP  has no UEFI at all and no Autounattend path (see the catalog's
 *               refusal) — it is listed to be REFUSED, not booted.
 *
 * So the five device decisions move into one named profile and buildQemuArgs()
 * branches on `firmware.bios`. The pair below is the honest split:
 *
 *   ovmf     q35 (ICH9, AHCI, PCIe), UEFI, TPM2, virtio disk + virtio NIC
 *   seabios  pc (i440FX, PIIX), legacy BIOS, no TPM, IDE disk, e1000e NIC —
 *            every one of which Windows 7 has an INBOX driver for, which is the
 *            only reason an unattended install can finish without virtio-win.
 */
export const WINDOWS_FIRMWARE_PROFILES = Object.freeze({
  ovmf: Object.freeze({ machine: 'q35', bios: 'ovmf', tpm: true, efiVars: true, disk: 'virtio-blk', nic: 'virtio-net-pci' }),
  seabios: Object.freeze({ machine: 'pc', bios: 'seabios', tpm: false, efiVars: false, disk: 'ide-hd', nic: 'e1000e' })
})

/**
 * The firmware profile a code boots on.
 *
 * An EMPTY code is the operator-ISO shape and takes the modern profile: it is
 * the only guess that cannot make a working configuration worse, and the media
 * heuristic in windowsFirmwareForSpec() refines it when an ISO path is known.
 */
export function windowsFirmwareProfile(version) {
  const declared = String(version ?? '').trim()
  if (declared === '') return Object.freeze({ code: '', ...WINDOWS_FIRMWARE_PROFILES.ovmf, legacy: false })
  const entry = windowsCatalogEntry(declared)
  const profile = WINDOWS_FIRMWARE_PROFILES[entry.bios]
  if (profile === undefined) {
    throw windowsCodeError('unknown-firmware', `${entry.label} names the firmware "${entry.bios}", which this backend does not implement (${Object.keys(WINDOWS_FIRMWARE_PROFILES).join(', ')})`)
  }
  return Object.freeze({ code: canonicalWindowsVersion(declared), ...profile, legacy: profile.bios === 'seabios' })
}

/** The media that only a BIOS machine can install, recognised from its file name. */
const LEGACY_MEDIA = Object.freeze([
  Object.freeze({ code: 'xp', pattern: /win(?:dows)?[ _.-]?xp|xpsp\d|x14-\d{5}/iu }),
  Object.freeze({ code: '7u', pattern: /win(?:dows)?[ _.-]?7(?![\d])|win7|677332|win7_ult/iu }),
  // Vista / Server 2008 are not catalog codes, but their media are the same
  // legacy class: a caller's own ISO must still boot under a BIOS.
  Object.freeze({ code: '7u', pattern: /vista|server[ _.-]?2008/iu })
])

/** A legacy profile for a media file name, or null. */
function legacyMediaCode(isoPath) {
  const text = String(isoPath ?? '')
  if (text === '') return null
  for (const entry of LEGACY_MEDIA) {
    if (entry.pattern.test(text)) return entry.code
  }
  return null
}

/** Where a computer records the firmware it was CREATED with. */
function firmwareMarkerPath(dir) {
  return typeof dir === 'string' && dir !== '' ? path.join(dir, 'firmware.json') : ''
}

function readFirmwareMarker(dir) {
  const file = firmwareMarkerPath(dir)
  if (file === '') return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeFirmwareMarker(dir, firmware) {
  const file = firmwareMarkerPath(dir)
  if (file === '' || firmware === null || typeof firmware !== 'object') return
  try {
    const body = JSON.stringify({ code: firmware.code ?? '', bios: firmware.bios ?? 'ovmf' })
    let current = ''
    try { current = readFileSync(file, 'utf8').trim() } catch {}
    if (current !== body) writeFileSync(file, body)
  } catch {}
}

/**
 * THE FIRMWARE FOR ONE BOOT, in a chain that cannot guess wrong silently.
 *
 * `spec.firmware` (a caller that decided) → the declared version → the marker
 * this computer was created with → the MEDIA FILE NAME → OVMF.
 *
 * Why the marker and the file name exist at all: the supervisor builds the boot
 * spec from the registry row, which records ports, disk, memory and `isoPath` —
 * but not `windowsVersion`. Without them a Windows 7 computer would come back
 * from a restart on q35+OVMF (no bootable device) after installing correctly on
 * pc+SeaBIOS, a failure that only appears on the SECOND boot. The marker is
 * written by the first successful boot; the file name is the fallback that works
 * even before the marker exists (`en_windows_7_with_sp1_x64.iso` is not
 * ambiguous, and neither is `Win7_Ult_SP1_English_x64.iso`).
 */
export function windowsFirmwareForSpec(spec = {}) {
  const record = spec !== null && typeof spec === 'object' ? spec : {}
  const explicit = record.firmware
  if (explicit !== null && typeof explicit === 'object' && typeof explicit.bios === 'string' && WINDOWS_FIRMWARE_PROFILES[explicit.bios] !== undefined) {
    const profile = WINDOWS_FIRMWARE_PROFILES[explicit.bios]
    return Object.freeze({ code: String(explicit.code ?? ''), ...profile, legacy: profile.bios === 'seabios' })
  }
  const declared = String(record.windowsVersion ?? record.version ?? '').trim()
  if (declared !== '') return windowsFirmwareProfile(declared)
  const dir = record.paths !== null && typeof record.paths === 'object' ? record.paths.dir : record.dir
  const marker = readFirmwareMarker(dir)
  if (marker !== null && typeof marker.bios === 'string' && WINDOWS_FIRMWARE_PROFILES[marker.bios] !== undefined) {
    const profile = WINDOWS_FIRMWARE_PROFILES[marker.bios]
    return Object.freeze({ code: String(marker.code ?? ''), ...profile, legacy: profile.bios === 'seabios' })
  }
  const code = legacyMediaCode(record.isoPath)
  if (code !== null) return windowsFirmwareProfile(code)
  return Object.freeze({ code: '', ...WINDOWS_FIRMWARE_PROFILES.ovmf, legacy: false })
}

/**
 * THE WARNINGS A FIRMWARE CHOICE OWES THE CALLER.
 *
 * A legacy-BIOS computer is supported but EXPERIMENTAL: it is the only way to
 * install Windows 7, and it is also the shape no CI run has exercised end to
 * end. Reporting that as a warning on the row is the difference between "we
 * chose this" and "nobody knew".
 */
export function windowsFirmwareWarnings(firmware = {}) {
  const warnings = []
  if (firmware !== null && typeof firmware === 'object' && firmware.bios === 'seabios') {
    warnings.push({
      code: 'legacy-bios-experimental',
      message: 'this computer boots on a legacy BIOS (pc/SeaBIOS, IDE disk, e1000e NIC) because its Windows version predates UEFI; that path is supported but experimental — set DSH_CUA_WIN_LEGACY_BIOS=0 to refuse it outright'
    })
  }
  return warnings
}

/** The `<InstallFrom>` element for a selection, escaped and schema-ordered. */
export function imageInstallFromXml(selection) {
  const escape = (text) => String(text)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
  return '<InstallFrom><MetaData wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">'
    + `<Key>${escape(selection.key)}</Key><Value>${escape(selection.value)}</Value>`
    + '</MetaData></InstallFrom>'
}

/**
 * S3: PRODUCT KEYS ARE OPTIONAL, AND VALIDATED BEFORE THEY REACH XML.
 *
 * The pinned media are EVALUATION images (11ltsc, 2025): they need no key, and
 * an evaluation image ignores a <ProductKey> it is handed. A future operator
 * ISO (a volume/licensed Windows) can pass `windowsKey`, which is written into
 * the staged Autounattend.xml with `<WillShowUI>Never</WillShowUI>` so Setup
 * never stops to ask. Accepts the canonical 25-character form with or without
 * dashes; anything else is refused with the accepted shape in the message.
 */
export function normaliseProductKey(value) {
  const text = String(value ?? '').trim().toUpperCase().replace(/\s+/gu, '')
  if (text === '') return ''
  const compact = text.replace(/-/gu, '')
  if (!/^[A-Z0-9]{25}$/u.test(compact)) {
    throw new Error(`windowsKey "${value}" is not a Windows product key: expected 25 letters/digits, with or without dashes (XXXXX-XXXXX-XXXXX-XXXXX-XXXXX). Leave it empty for the pinned EVALUATION media, which need no key.`)
  }
  return compact.match(/.{5}/gu).join('-')
}

/** Every `<DiskID>` an answer file names, in document order. */
export function answerFileDiskIds(xml) {
  return [...String(xml).matchAll(/<DiskID>\s*(\d+)\s*<\/DiskID>/gu)].map((match) => Number(match[1]))
}

/**
 * S2: THE ANSWER FILE MUST TARGET THE SYSTEM DISK, AND THE SYSTEM DISK MUST BE
 * THE QCOW2.
 *
 * The QEMU argv puts the qcow2 on `ide.0` (first, a fixed disk) and setup.img on
 * a REMOVABLE usb-storage stick (a second disk), so Windows sees the qcow2 as
 * Disk 0. If a future argv change reorders those, Setup would install onto the
 * answer medium and fail in a way that looks like a corrupt ISO. This is the
 * check that makes the ordering a contract instead of a comment.
 */
export function assertAnswerFileTargetsSystemDisk(xml, { expected = 0 } = {}) {
  const ids = answerFileDiskIds(xml)
  if (ids.length === 0) throw new Error('Autounattend.xml has no <DiskID> — Setup would ask which disk to use')
  const wrong = ids.filter((id) => id !== expected)
  if (wrong.length > 0) {
    throw new Error(`Autounattend.xml targets DiskID ${wrong.join(', ')} but the system qcow2 is Disk ${expected} (QEMU: disk0 on ide.0, setup.img on a removable usb-storage stick). Fix the disk order in buildQemuArgs() or the XML together — never one alone.`)
  }
  if (!/<InstallTo>\s*<DiskID>\s*0\s*<\/DiskID>/u.test(String(xml))) {
    throw new Error('Autounattend.xml has no <InstallTo><DiskID>0</DiskID> — Setup would not know where to install Windows')
  }
  return ids
}

/**
 * F2: THE STAGED ANSWER FILE MUST NAME THE IMAGE IT WANTS.
 *
 * Setup's "Select the operating system you want to install" page is the second
 * interactive stop after the language page, and it appears whenever
 * `<ImageInstall><OSImage>` carries no `<InstallFrom>`. This asserts the exact
 * shape Setup requires — one `<MetaData>` with `/IMAGE/NAME` or `/IMAGE/INDEX`
 * INSIDE `<InstallFrom>`, and `<InstallFrom>` BEFORE `<InstallTo>` (schema
 * order; the reverse is rejected as an unparseable answer file on some media).
 */
export function assertAnswerFileSelectsImage(xml) {
  const text = String(xml)
  const installFrom = /<InstallFrom>([\s\S]*?)<\/InstallFrom>/u.exec(text)
  if (installFrom === null) {
    throw new Error('Autounattend.xml has no <ImageInstall><OSImage><InstallFrom> — Setup would stop at "Select the operating system you want to install"')
  }
  // Comments are prose: the template explains the shape in an XML comment that
  // names <MetaData>, so counting raw occurrences would fail on our own advice.
  const body = installFrom[1].replace(/<!--[\s\S]*?-->/gu, '')
  const key = /<Key>\s*(\/IMAGE\/(?:NAME|INDEX))\s*<\/Key>/u.exec(body)
  const value = /<Value>\s*([^<]+?)\s*<\/Value>/u.exec(body)
  if (key === null || value === null) {
    throw new Error(`Autounattend.xml's <InstallFrom> has no <Key>/IMAGE/NAME|/IMAGE/INDEX + <Value> (found ${body.trim().slice(0, 120) || 'nothing'})`)
  }
  const metadata = (body.match(/<MetaData\b/gu) ?? []).length
  if (metadata !== 1) {
    throw new Error(`Autounattend.xml's <InstallFrom> must carry exactly ONE <MetaData> (found ${metadata}); Setup honours the first and ignores the rest, so a second one is a silent lie`)
  }
  if (key[1] === '/IMAGE/INDEX' && !/^\d+$/u.test(value[1])) {
    throw new Error(`Autounattend.xml selects ${key[1]} but its <Value> "${value[1]}" is not a number`)
  }
  if (key[1] === '/IMAGE/NAME' && /^(Microsoft )?Windows$/iu.test(value[1])) {
    throw new Error(`Autounattend.xml selects ${key[1]} "${value[1]}", which is not an edition name`)
  }
  const installTo = text.indexOf('<InstallTo>')
  if (installTo !== -1 && installTo < text.indexOf('<InstallFrom>')) {
    throw new Error('Autounattend.xml puts <InstallTo> before <InstallFrom>; the answer-file schema requires InstallFrom first')
  }
  return { key: key[1], value: value[1] }
}

/**
 * D1 (H1): `$OEM$` IS IGNORED UNLESS THE ANSWER FILE ASKS FOR IT.
 *
 * THE REPORTED DEFECT: after a fully automatic install the desktop showed
 *
 *   Windows Script Host — Can not find script file
 *   "C:\Windows\Setup\Scripts\Unattend.vbs"
 *
 * That is the oobeSystem FirstLogonCommand running against a directory Setup
 * never populated. The cause is not the XML's FirstLogonCommands: it is that
 * Windows Setup only copies `<answer>\$OEM$\$$\…` into `C:\Windows\Setup\Scripts`
 * when the answer file sets `<UseConfigurationSet>true</UseConfigurationSet>` in
 * its windowsPE `Microsoft-Windows-Setup` component ([MS Learn: UseConfigurationSet];
 * dockur/windows' `setConfigurationXML` inserts exactly this element before
 * `<UserData>`). Without it `$OEM$` is inert — the media carry it, Setup walks
 * past it, and every script it was supposed to stage is missing.
 *
 * This is asserted on the STAGED file (writeOemPayload calls it), so a template
 * edit that drops the element fails the create instead of the desktop.
 */
export function assertAnswerFileUsesConfigurationSet(xml) {
  const text = String(xml ?? '').replace(/<!--[\s\S]*?-->/gu, '')
  const windowsPe = /<settings pass="windowsPE">([\s\S]*?)<\/settings>/u.exec(text)
  if (windowsPe === null) throw new Error('Autounattend.xml has no <settings pass="windowsPE"> — Setup would never read an answer file at all')
  const component = /<component name="Microsoft-Windows-Setup"[\s\S]*?<\/component>/u.exec(windowsPe[1])
  if (component === null) {
    throw new Error('Autounattend.xml\'s windowsPE pass has no Microsoft-Windows-Setup component — <UseConfigurationSet> has nowhere to live and $OEM$ would never be copied')
  }
  const hits = (component[0].match(/<UseConfigurationSet\b/gu) ?? []).length
  if (hits !== 1) {
    throw new Error(`Autounattend.xml has ${hits} <UseConfigurationSet> element(s) in Microsoft-Windows-Setup; exactly one <UseConfigurationSet>true</UseConfigurationSet> is required or Windows Setup NEVER copies $OEM$\\$$\\Setup\\Scripts into C:\\Windows\\Setup\\Scripts (the reported "Can not find script file C:\\Windows\\Setup\\Scripts\\Unattend.vbs")`)
  }
  if (!/<UseConfigurationSet>\s*true\s*<\/UseConfigurationSet>/iu.test(component[0])) {
    throw new Error('Autounattend.xml sets <UseConfigurationSet> to something other than true — the $OEM$ tree would be ignored and firstboot would never run')
  }
  return true
}

/**
 * D1 (H2): THE FIRSTBOOT FALLBACK COMMAND, SHARED BY THE XML AND THE GATE.
 *
 * The primary launcher is dockur's: Setup copies `$OEM$` into
 * `C:\Windows\Setup\Scripts` and the FirstLogonCommand runs `Unattend.vbs` from
 * there. With H1 fixed that is the intended path — but it has ONE dependency
 * (the copy) and the failure mode is invisible (a WSH dialog on a desktop nobody
 * is looking at). This second FirstLogonCommand is the belt:
 *
 *   * it looks for `cua-firstboot.ps1` on the ROOTS of drives C:..H: — the
 *     SETUP volume's drive letter is assigned by Windows at boot and is not
 *     knowable on the host (in WinPE it was C:, after installation the image is
 *     usually D:/E:);
 *   * it runs the script FROM THE MEDIUM with `powershell -File`, so it needs
 *     neither the `$OEM$` copy nor `Unattend.vbs` to exist;
 *   * the script is idempotent (`C:\cua-provision.json`), so if the primary
 *     launcher already succeeded this pass is a no-op.
 *
 * It is a plain `cmd /c` one-liner because FirstLogonCommands run through
 * CreateProcess: a batch FILE on the medium would be a third thing that can be
 * missing, and `for %d` (single percent) is the command-line form.
 */
export const FIRSTBOOT_FALLBACK_COMMAND = 'cmd /c for %d in (c d e f g h) do @if exist "%d:\\cua-firstboot.ps1" powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%d:\\cua-firstboot.ps1"'

/**
 * Both firstboot layers must be present in the staged answer file: the hidden
 * `$OEM$` launcher AND the drive-scanning fallback. Deleting either turns one
 * copy failure into a computer without OpenSSH (and therefore without cua_vm_exec).
 */
export function assertAnswerFileFirstbootLayers(xml) {
  const text = String(xml ?? '').replace(/<!--[\s\S]*?-->/gu, '')
  if (!/wscript \/\/nologo C:\\Windows\\Setup\\Scripts\\Unattend\.vbs/u.test(text)) {
    throw new Error('Autounattend.xml has no FirstLogonCommand running C:\\Windows\\Setup\\Scripts\\Unattend.vbs — the $OEM$ layer of firstboot is gone')
  }
  if (!text.includes(FIRSTBOOT_FALLBACK_COMMAND)) {
    throw new Error(`Autounattend.xml has no drive-scanning firstboot fallback (expected: ${FIRSTBOOT_FALLBACK_COMMAND}) — if Setup fails to copy $OEM$, nothing would install OpenSSH and cua_vm_exec would never work`)
  }
  return true
}

/**
 * S1: BUILD `$STORE/windows/<name>/setup.img` — a FAT32 hard-disk image whose
 * ROOT holds the answer file and whose `$OEM$` tree holds the Setup scripts.
 *
 * WHY A DISK IMAGE AND NOT A vvfat DIRECTORY: a directory-backed vvfat stick
 * behind usb-storage was not visible to Setup in practice, while a real MBR +
 * FAT32 image IS mounted by WinPE. The image is then delivered as REMOVABLE
 * media (usb-storage, removable=on), because Setup only scans removable-media
 * roots — and the boot media — for `Autounattend.xml`; see the argv comments.
 *
 * WHERE THIS DELIBERATELY DIFFERS FROM dockur/windows (CORRECTED VERDICT — the
 * old comment claimed the two were identical and that claim was the bug): their
 * overlay is a plain FAT32 image formatted as a *superfloppy* (no partition
 * table), and it works THERE because of how their run flow hands the medium to
 * QEMU. Here the identical superfloppy was attached as a fixed disk and the
 * result was the interactive language screen: the firmware mounted the raw FAT volume
 * (EDK2 wrote its NvVars into it — 114 KB, the only writes that block device
 * ever saw), but Windows does not mount a partitionless FIXED disk at all, so
 * WinPE's drive-root search had no drive to look at. `setup.img` must therefore
 * carry an MBR with one FAT32 partition; see the F1 block above. Both media are
 * FAT32 — only one of them is a disk Windows will ever enumerate.
 *
 * The build is deterministic and verified in the same call:
 *   1. truncate a 64 MiB raw image (sparse);
 *   2. `mformat -F -H 2048 -v SETUP` on the volume at byte offset 1 MiB;
 *   3. write the MBR partition table (type 0x0C, start LBA 2048) over sector 0;
 *   4. `mcopy -s` the root files and `$OEM$` tree INTO that partition;
 *   5. `mdir` must list Autounattend.xml at the volume root, `mtype` must return
 *      bytes IDENTICAL to the staged file, and the MBR must read back as a
 *      signature + partition entry (so "a disk Windows can enumerate" is
 *      asserted, not assumed).
 *
 * F1: REBUILD POLICY — ALWAYS FRESH, ON EVERY CREATE. The image is attached
 * WRITABLE (QEMU 10 rejects `readonly=on` behind an IDE hard disk; usb-storage
 * accepts either, and Setup may write logs/scratch to the medium),
 * so the guest can legitimately leave bytes behind. There is deliberately no
 * "skip if it already exists" branch: a re-create of the same computer must
 * start from a byte-exact answer medium, never from a possibly-modified one.
 * The old file is unlinked and rebuilt, and the FAT32 image is chmod 0600 for
 * the runtime uid so QEMU can open it read-write.
 *
 * mtools is a runtime dependency in the image (see the Dockerfile); a host
 * without it gets an error naming the package, not a QEMU that cannot boot.
 */
export function buildSetupImage({ paths: p, log = () => {}, expectedDiskId = 0 } = {}) {
  if (!p || typeof p.setupImg !== 'string' || typeof p.oemDir !== 'string') {
    throw new Error('buildSetupImage needs paths.setupImg and paths.oemDir')
  }
  // J22-6: OPTIONAL ENTRIES ARE COPIED ONLY IF STAGED. The sentinel is absent
  // whenever DSH_CUA_CLIP_AGENT was unset (the normal case), so handing its
  // path to mcopy would fail the build for a feature nobody asked for — while a
  // present sentinel must still ride into the medium's root, or firstboot's
  // search (and the switch) never sees it.
  const isOptionalEntry = (name) => SETUP_IMAGE_OPTIONAL.includes(name)
  const staged = SETUP_IMAGE_ENTRIES
    .filter((name) => !isOptionalEntry(name) || existsSync(path.join(p.oemDir, name)))
    .map((name) => path.join(p.oemDir, name))
  const missing = SETUP_IMAGE_ENTRIES.filter((name) => !isOptionalEntry(name) && !existsSync(path.join(p.oemDir, name)))
  if (missing.length > 0) {
    throw new Error(`the staged OEM payload is incomplete (missing ${missing.join(', ')} in ${p.oemDir}); writeOemPayload() must run first`)
  }
  // S2: the answer file's disk target, checked BEFORE the image is built.
  assertAnswerFileTargetsSystemDisk(readFileSync(path.join(p.oemDir, 'Autounattend.xml'), 'utf8'), { expected: expectedDiskId })
  const oemTree = path.join(p.oemDir, '$OEM$')
  if (!existsSync(path.join(oemTree, '$$', 'Setup', 'Scripts', 'setupcomplete.cmd'))) {
    throw new Error(`the staged $OEM$/$$/Setup/Scripts tree is missing under ${p.oemDir}; Setup would never run SetupComplete.cmd`)
  }
  try {
    execFileSync(MTOOLS.format, ['--version'], { stdio: 'ignore', timeout: 10000 })
  } catch {
    throw new Error(`mtools is not installed (${MTOOLS.format} not found on PATH). The Windows answer-file disk needs mtools: install the "mtools" package in the image.`)
  }
  mkdirSync(path.dirname(p.setupImg), { recursive: true })
  try { unlinkSync(p.setupImg) } catch {}
  const fd = openSync(p.setupImg, 'w')
  try { ftruncateSync(fd, SETUP_IMAGE_BYTES) } finally { closeSync(fd) }
  const run = (command, args) => execFileSync(command, args, { stdio: 'pipe', timeout: 120000 })
  // F1: THE VOLUME LIVES AT LBA 2048, NOT AT BYTE 0. Every mtools call names
  // the partition through `@@<byte-offset>`; `-H 2048` writes the matching
  // "hidden sectors" value into the BPB, which is what Windows compares against
  // the partition table when it mounts the volume.
  const volume = setupVolumeSpec(p.setupImg)
  run(MTOOLS.format, ['-i', volume, '-F', '-H', String(SETUP_PARTITION_START_LBA), '-v', SETUP_IMAGE_LABEL, '::'])
  // The table goes on AFTER the format (mformat only touches its own volume, but
  // the partition length is read from the BPB it just wrote).
  const partition = writeSetupMbr(p.setupImg)
  // `-s` recurses into $OEM$; the explicit root list keeps startup.nsh and the
  // scripts visible at the medium's root where a human (and the EFI Shell for
  // startup.nsh) expects them.
  run(MTOOLS.copy, ['-i', volume, '-s', ...staged, oemTree, '::'])
  // F1: the medium is WRITABLE by the user that runs QEMU (uid 1000). mkstemp's
  // default mode is already owner-writable, but pinning it makes the contract
  // explicit and survives a restrictive umask / a copied store.
  chmodSync(p.setupImg, 0o600)
  const verified = verifySetupImage({ paths: p })
  log(`windows: setup.img built (${(SETUP_IMAGE_BYTES / 1024 ** 2).toFixed(0)} MB MBR + FAT32 partition at LBA ${partition.startLba}, ${verified.entries.length} root entries, Autounattend.xml byte-verified)`)
  return p.setupImg
}

/**
 * S2: READ THE IMAGE BACK. This is the assertion that would have caught the
 * invisible-media bug: `mdir` must list `Autounattend.xml` at the root, the
 * `$OEM$` script path must exist, and `mtype` must return the SAME BYTES that
 * were staged (a FAT write that silently truncates is a Setup that asks
 * questions).
 *
 * F1: AND IT READS THROUGH THE PARTITION. The MBR is verified first — 0x55AA at
 * 510, one active type-0x0C entry at 0x1BE starting at LBA 2048 — because a
 * perfectly populated FAT32 volume that Windows never enumerates is exactly the
 * bug this replaced. The listing then goes through `@@<offset>`, the same
 * volume spec the build used.
 */
export function verifySetupImage({ paths: p } = {}) {
  const mbr = readSetupMbr(p.setupImg)
  if (mbr.signature !== '55aa') {
    throw new Error(`setup.img has no valid MBR signature at 510 (found ${mbr.signature || 'nothing'}) — Windows never mounts a partitionless fixed disk, so Setup would show the interactive language screen`)
  }
  if (mbr.type !== SETUP_PARTITION_TYPE || mbr.startLba !== SETUP_PARTITION_START_LBA) {
    throw new Error(`setup.img's first partition is type 0x${mbr.type.toString(16)} at LBA ${mbr.startLba}; the answer volume must be type 0x${SETUP_PARTITION_TYPE.toString(16)} at LBA ${SETUP_PARTITION_START_LBA}`)
  }
  if (mbr.sectorCount <= 0) throw new Error('setup.img\'s MBR partition has zero sectors')
  const volume = setupVolumeSpec(p.setupImg)
  const readDir = (spec) => {
    const listing = execFileSync(MTOOLS.dir, ['-i', volume, '-b', spec], { encoding: 'utf8', timeout: 30000 })
    return listing
      .split(/\r?\n/u)
      .map((line) => line.trim().replace(/^::[\\/]?/u, '').replace(/\\/gu, '/'))
      .filter(Boolean)
      // mdir prints a nested listing with the whole path; callers compare names.
      .map((entry) => entry.split('/').filter(Boolean).pop())
  }
  const root = readDir('::/')
  for (const required of SETUP_IMAGE_ENTRIES) {
    // J22-6: the sentinel is asserted when it was staged and skipped when it was
    // not — a switch that silently never reached the medium would otherwise read
    // as "off" on the host and "on" on the guest.
    if (SETUP_IMAGE_OPTIONAL.includes(required) && !existsSync(path.join(p.oemDir, required))) continue
    if (!root.includes(required)) {
      throw new Error(`setup.img does not list ${required} at its root (mdir said: ${root.slice(0, 12).join(', ') || 'nothing'}). Setup will not find the answer file.`)
    }
  }
  // The `$OEM$` tree is a DIRECTORY entry at the root; its contents need their
  // own listing. Setup copies these into C:\Windows\Setup\Scripts, and
  // SetupComplete.cmd is what makes the provisioning run at all.
  const oemScripts = readDir('::/$OEM$/$$/Setup/Scripts')
  // THE AGENT IS VERIFIED LIKE THE OTHER THREE: Setup copies $OEM$\$$\Setup\
  // Scripts into C:\Windows\Setup\Scripts, which is one of the four places
  // firstboot searches for it. A listing that misses it means the guest gets
  // firstboot's embedded floor instead of the tested script — silently.
  for (const script of ['setupcomplete.cmd', 'cua-firstboot.ps1', 'Unattend.vbs', OEM_CLIP_AGENT_FILE]) {
    if (!oemScripts.includes(script)) {
      throw new Error(`setup.img's $OEM$/$$/Setup/Scripts is missing ${script} (listed: ${oemScripts.join(', ') || 'nothing'}) — Setup would never stage it into C:\\Windows\\Setup\\Scripts`)
    }
  }
  // J22-6: AND THE SENTINEL, THE SAME WAY. `$OEM$\$$\Setup\Scripts` is the
  // second route into C:\Windows\Setup\Scripts, i.e. one of firstboot's search
  // locations; when the switch is on it must be listed here too.
  if (existsSync(path.join(p.oemDir, CLIP_AGENT_SENTINEL_FILE)) && !oemScripts.includes(CLIP_AGENT_SENTINEL_FILE)) {
    throw new Error(`setup.img's $OEM$/$$/Setup/Scripts is missing ${CLIP_AGENT_SENTINEL_FILE} (listed: ${oemScripts.join(', ') || 'nothing'}) — the clip-agent off-switch would not reach the guest`)
  }
  // BYTE COMPARE, exactly like dockur: the host copy and the image copy must be
  // indistinguishable. mtype emits the raw file.
  const rootFiles = ['Autounattend.xml', 'setupcomplete.cmd', 'cua-firstboot.ps1', 'Unattend.vbs', OEM_CLIP_AGENT_FILE]
  if (existsSync(path.join(p.oemDir, CLIP_AGENT_SENTINEL_FILE))) rootFiles.push(CLIP_AGENT_SENTINEL_FILE)
  for (const name of rootFiles) {
    const staged = readFileSync(path.join(p.oemDir, name))
    const fromImage = execFileSync(MTOOLS.type, ['-i', volume, `::/${name}`], { timeout: 30000 })
    if (!staged.equals(fromImage)) {
      throw new Error(`setup.img's ${name} differs from the staged copy (${fromImage.length} vs ${staged.length} bytes) — the answer medium is corrupt`)
    }
  }
  const startup = execFileSync(MTOOLS.type, ['-i', volume, '::/startup.nsh'], { timeout: 30000 })
  if (!startup.equals(readFileSync(path.join(p.oemDir, 'startup.nsh')))) {
    throw new Error('setup.img\'s startup.nsh differs from the staged copy — the EFI Shell fallback would not run')
  }
  return { entries: root, oemScripts, image: p.setupImg, mbr, partition: { startLba: mbr.startLba, offsetBytes: SETUP_PARTITION_OFFSET_BYTES, sectorCount: mbr.sectorCount } }
}

/**
 * R5 (BELT AND BRACES): THE EFI SHELL'S `startup.nsh`.
 *
 * If R1's QMP key press misses, OVMF's BDS falls into the EFI Internal Shell.
 * The firmware Shell runs `startup.nsh` from the filesystem it lands on, so this
 * script tries `\efi\boot\bootx64.efi` on every mapped FS0..FS5 and chain-loads
 * the install media instead of stopping at a prompt. It is shipped at the ROOT
 * of setup.img (the medium we author ourselves), which is where the Shell looks.
 */
export function startupNshText() {
  // The EFI Shell dialect: `%f` iterates the word list, `if exist` tests the
  // mapping, and a bare path on its own line chain-loads it.
  const lines = [
    '@echo -off',
    "REM R5: written by dsh-cua-vm. If Windows Setup was not reached (R1's key",
    'REM press missed, or cdboot timed out), chain-load the install media itself',
    'REM instead of stopping at this prompt. The CD is one of FS0..FS5.',
    'for %f in fs0 fs1 fs2 fs3 fs4 fs5',
    '  if exist %f:\\efi\\boot\\bootx64.efi then',
    '    echo "cua: chaining to %f:\\efi\\boot\\bootx64.efi"',
    '    %f:\\efi\\boot\\bootx64.efi',
    '  endif',
    'endfor',
    'echo "cua: no bootable \\efi\\boot\\bootx64.efi on FS0..FS5 - Windows Setup did not start."',
    'echo "cua: the install medium is missing or unreadable; see qemu-stderr.log / serial.log on the host."'
  ]
  return `${lines.join('\n')}\n`
}

/** Where this module itself lives — the last-resort source of the payload. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * A directory that holds ALL of `OEM_PAYLOAD_FILES`, or null.
 *
 * A directory is enough — the flat image check tree (`/opt/seek-harness/
 * cua-check/`) keeps the same files at its root, so the same predicate
 * answers "is this a payload directory?" for both layouts.
 *
 * EACCES IS NOT "MISSING". `existsSync` answers false for BOTH, which is how a
 * permission bug shipped reading like a missing-payload bug: the files were in
 * the image, but the directory arrived `drw-r--r--` from `COPY --chmod=0644`
 * (that flag applies to the directories it creates too), so a uid-1000 process
 * could not traverse it and the user was told to pull a newer image. Anything
 * other than ENOENT/ENOTDIR is reported as a PERMISSION problem by name.
 */
export function oemPayloadDirStatus(dir) {
  if (typeof dir !== 'string' || dir.length === 0) {
    return { dir: String(dir ?? ''), ok: false, missing: [], denied: null }
  }
  const missing = []
  // THE AGENT IS NOT PART OF THE IDENTITY TEST: a checkout has it beside the
  // directory, not inside it (see OEM_CLIP_AGENT_FILE). Requiring it here would
  // declare the repository's own payload directory "not a payload".
  for (const file of OEM_PAYLOAD_REQUIRED) {
    const target = path.join(dir, file)
    try {
      statSync(target)
    } catch (error) {
      const code = error?.code
      if (code === 'EACCES' || code === 'EPERM') {
        return { dir, ok: false, missing, denied: { path: target, code, cause: error } }
      }
      missing.push(file)
    }
  }
  return { dir, ok: missing.length === 0, missing, denied: null }
}

export function oemPayloadDir(dir) {
  return oemPayloadDirStatus(dir).ok ? dir : null
}

/**
 * The first directory among `candidates` that carries the whole payload.
 * Order matters: the configured source wins, the fallbacks are self-healing.
 */
export function resolveOemSourceDir(candidates) {
  for (const candidate of candidates) {
    const found = oemPayloadDir(candidate)
    if (found !== null) return found
  }
  return null
}

/**
 * The first candidate whose TRAVERSAL was denied (EACCES), or null.
 *
 * Used only to choose the error text: a denied directory is an image PERMISSION
 * defect, and telling that user to rebuild with newer media is wrong advice.
 */
export function oemPayloadDeniedDir(candidates) {
  for (const candidate of candidates) {
    const status = oemPayloadDirStatus(candidate)
    if (status.denied !== null) return candidate
  }
  return null
}

/**
 * WHAT THE USER SEES WHEN THE IMAGE HAS NO WINDOWS BACKEND.
 *
 * The old one-liner ("the OEM payload is missing from this image: <path>") named
 * a path and nothing else: no reason, no rebuild steps, no way to tell a stale
 * image from a broken mount. It is a failure of the IMAGE, not of the computer
 * spec, so the message says so in that order and ends with a command to run.
 */
/**
 * THE OTHER IMAGE FAILURE: THE FILES ARE THERE, THE PROCESS MAY NOT READ THEM.
 *
 * `COPY --chmod=0644 docker/windows-oem/ <dest>/` applies 0644 to EVERY copied
 * entry, the destination DIRECTORY included, so a hardened container that runs
 * as uid 1000 could not traverse it while the files were verifiably in the
 * pushed layer. The symptom is identical to the missing-payload one (`ls:
 * Permission denied`, `existsSync === false`), and the old advice — pull a newer
 * image — is exactly wrong. Say which mode/owner is wrong and what the fix is.
 */
export function oemPayloadDeniedError({ sourceDir, denied, deniedDir, fallbackDirs }) {
  const looked = [sourceDir, ...fallbackDirs].filter(Boolean)
  const describe = (target) => {
    try {
      const s = statSync(target)
      return `${(s.mode & 0o777).toString(8).padStart(4, '0')} ${s.uid}:${s.gid}`
    } catch {
      return null
    }
  }
  // The mode that decides whether the payload is reachable is the DIRECTORY's:
  // a 0644 directory denies traversal before any file's own mode is consulted,
  // so `stat`-ing the file itself is the one thing guaranteed to fail here.
  const dir = deniedDir ?? path.dirname(denied)
  const dirMode = describe(dir)
  const fileMode = describe(denied)
  // Neither the file nor the directory may be stat'ed at all when a PARENT is
  // the non-traversable one (the same COPY creates /usr/local/share/cua-vm), so
  // the message walks up to the first ancestor that can still be described.
  const firstReachable = (() => {
    let current = dir
    for (let hop = 0; hop < 4; hop += 1) {
      const mode = describe(current)
      if (mode !== null) return { path: current, mode }
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    return null
  })()
  const where = fileMode !== null
    ? `EACCES on ${denied} (mode/owner: ${fileMode})`
    : dirMode !== null
      ? `EACCES traversing ${dir} (dir mode/owner: ${dirMode})`
      : `EACCES reaching ${denied} — neither the file nor its directory could be opened, so an ANCESTOR is not traversable (last readable: ${firstReachable === null ? 'none' : `${firstReachable.path} ${firstReachable.mode}`})`
  return Object.assign(new Error([
    `the Windows OEM payload is present but NOT READABLE by uid ${typeof process.getuid === 'function' ? process.getuid() : '?'} — ${where}`,
    `(searched ${looked.join(' or ')})`,
    '',
    'This is an IMAGE PERMISSIONS defect, not a missing payload and not a computer setting.',
    'A directory needs its execute bit to be traversed, and `COPY --chmod=0644` sets 0644 on',
    'the directories it CREATES as well as on the files, which leaves',
    '`/usr/local/share/cua-vm/windows-oem` as `drw-r--r--` — the three files are in the image',
    'and no non-root process can open them.',
    '',
    'FIXED IN THE IMAGE by creating the parent 0755, copying as the runtime uid, and',
    'normalising the copied directory modes afterwards:',
    '  RUN install -d -m 0755 /usr/local/share/cua-vm',
    '  COPY --chown=1000:1000 --chmod=0644 docker/windows-oem/ /usr/local/share/cua-vm/windows-oem/',
    '  RUN chmod -R a+rX /usr/local/share/cua-vm/windows-oem',
    'Pull or rebuild an image that carries it, then recreate the container:',
    '  docker compose -f compose.windows.yaml up -d --force-recreate',
    '',
    'To work around it without rebuilding (the rootfs is read_only, so `chmod` inside the',
    'container answers "Read-only file system"), shadow the directory with a read-only mount',
    'from a checkout — the mount\'s own modes replace the image\'s:',
    '  # compose override',
    '  volumes: [./docker/windows-oem:/usr/local/share/cua-vm/windows-oem:ro]',
    '  docker compose -f compose.yaml -f compose.windows.yaml up -d',
    'then verify as the runtime user:',
    '  docker compose exec seek-harness ls -l /usr/local/share/cua-vm/windows-oem/',
  ].join('\n')), { code: 'EACCES', deniedPath: denied, deniedDir: dir })
}

export function oemPayloadMissingError({ sourceDir, fallbackDirs }) {
  const looked = [sourceDir, ...fallbackDirs].filter(Boolean)
  return new Error([
    `the Windows OEM payload is missing from this image: no ${OEM_PAYLOAD_FILES.join(', ')} under ${looked.join(' or ')}`,
    '',
    'A Windows computer is a DIRECT-QEMU guest: its unattended install reads those files from',
    `the image (default /usr/local/share/cua-vm/windows-oem/). An image without the Windows backend —`,
    'a main-branch build, or any build older than the one that added the Windows backend — cannot',
    'create one, and no computer setting can fix that. Pull or build a newer image:',
    '',
    '  1. build it from branch cua-vm-improve WITH the virgl QEMU (the Windows guest needs it):',
    '     git fetch origin && git checkout cua-vm-improve',
    '     docker build --build-arg WITH_VIRGL_QEMU=1 -t ghcr.io/OWNER/REPO:local .',
    '     (or run Actions → docker-build on cua-vm-improve with channel=github-tag, virgl=true,',
    '      which publishes ghcr.io/OWNER/REPO:latest; then docker pull ghcr.io/OWNER/REPO:latest)',
    '  2. recreate the container against the NEW image, with the SAME compose env you use now',
    '     (notably DSH_CUA_VM_GPU=virgl if your computer is a GPU one), keeping the /cua-vm',
    '     volume mounted at /cua-vm so the existing store and its computers survive:',
    '     docker compose -f compose.windows.yaml up -d --force-recreate',
    '  3. confirm the payload actually landed, from inside the running container',
    '     (`seek-harness` is the service name in compose.yaml / compose.windows.yaml):',
    `     docker compose exec seek-harness ls -l /usr/local/share/cua-vm/windows-oem/${OEM_PAYLOAD_FILES.join(' ')}`,
    '',
    'If step 3 lists all the files and this error persists, DSH_CUA_WINDOWS_OEM_DIR points',
    `somewhere else — unset it (it currently overrides the image default with ${sourceDir}).`
  ].join('\n'))
}

/**
 * Write the unattended-answer payload into `$STORE/windows/<name>/oem/`.
 *
 * The files live in the repository (`docker/windows-oem/`) so they can be read,
 * diffed and fixed without touching JavaScript, exactly like the guest shell
 * scripts. The supervisor copies them with the per-computer substitutions:
 *
 *   {{COMPUTERNAME}}  a DNS-safe name derived from the computer name
 *   {{PASSWORD}}      the generated administrator password
 *   {{SSH_PUBKEY}}    the supervisor's public key (authorized_keys)
 *   {{PYTHON_URL}}    the pinned python.org installer
 *   {{DSH_CUA_PIP}}   the dsh-cua package spec
 *   {{PRODUCT_KEY}}   empty for evaluation media, or a <ProductKey> block when
 *                     the operator passed a licensed-ISO windowsKey
 *   {{IMAGE_INSTALL}} the <InstallFrom> block naming the edition (F2). Resolved
 *                     from windowsImageName / windowsImageIndex / the version
 *                     table — see resolveWindowsImageSelection().
 *
 * SELF-HEALING: `sourceDir` is the image path the supervisor resolves; the
 * `fallbackDirs` are the other places the SAME files are known to exist
 * (the image's flat check tree, the module's own directory, a checkout). A file
 * or two missing from `sourceDir` therefore costs a log line, not a failed
 * computer create — as long as ONE candidate directory is complete.
 */
export function writeOemPayload({ paths: p, name, password, sshPubKey, sourceDir, fallbackDirs = [], pythonUrl, dshCuaSpec, windowsKey = '', windowsVersion = '', windowsImageIndex = 0, windowsImageName = '', log = () => {} }) {
  mkdirSync(p.oemDir, { recursive: true })
  const productKey = normaliseProductKey(windowsKey)
  // F2: the edition, decided BEFORE a byte of XML is written and asserted after,
  // so "Setup asks which image" cannot come back as a surprise at the console.
  const imageSelection = resolveWindowsImageSelection({ version: windowsVersion, imageIndex: windowsImageIndex, imageName: windowsImageName })
  const substitutions = {
    '{{COMPUTERNAME}}': `cua-${name}`.slice(0, 15).toUpperCase(),
    '{{PASSWORD}}': password,
    '{{SSH_PUBKEY}}': sshPubKey.trim(),
    '{{PYTHON_URL}}': pythonUrl,
    '{{DSH_CUA_PIP}}': dshCuaSpec,
    // S3: EVALUATION MEDIA IGNORE THIS; a licensed operator ISO uses it and
    // Setup never shows a product-key page (WillShowUI Never).
    '{{PRODUCT_KEY}}': productKey === ''
      ? ''
      : `<ProductKey><Key>${productKey}</Key><WillShowUI>Never</WillShowUI></ProductKey>`,
    '{{IMAGE_INSTALL}}': imageInstallFromXml(imageSelection)
  }
  const files = OEM_PAYLOAD_REQUIRED
  const candidates = [sourceDir, ...fallbackDirs, path.join(MODULE_DIR, 'windows-oem'), path.resolve(MODULE_DIR, '..', 'docker', 'windows-oem')]
  const resolved = resolveOemSourceDir(candidates)
  if (resolved === null) {
    // EACCES before ENOENT: a denied directory is an image permission defect and
    // must not be reported as "the payload is missing" (they were the same
    // symptom for `existsSync`, and the wrong advice sent users to re-pull).
    const deniedDir = oemPayloadDeniedDir(candidates)
    if (deniedDir !== null) {
      const deniedPath = oemPayloadDirStatus(deniedDir).denied?.path ?? deniedDir
      throw oemPayloadDeniedError({ sourceDir, denied: deniedPath, deniedDir, fallbackDirs })
    }
    throw oemPayloadMissingError({ sourceDir, fallbackDirs })
  }
  if (path.resolve(resolved) !== path.resolve(sourceDir)) {
    log(`windows: OEM payload not found at ${sourceDir}; using the copy at ${resolved}`)
  }
  for (const file of files) {
    const source = path.join(resolved, file)
    let text = readFileSync(source, 'utf8')
    for (const [needle, value] of Object.entries(substitutions)) text = text.split(needle).join(value)
    writeFileSync(path.join(p.oemDir, file), text)
  }
  // THE CLIP AGENT IS STAGED, NOT SUBSTITUTED. Its bytes are the agent's own
  // (no {{PLACEHOLDER}} contract), and it comes from its own chain because a
  // checkout keeps it beside `docker/windows-oem/` rather than inside it.
  const agentSource = resolveOemClipAgentSource([
    resolved,
    sourceDir,
    ...fallbackDirs,
    MODULE_DIR,
    path.resolve(MODULE_DIR, '..'),
    path.resolve(MODULE_DIR, '..', 'docker'),
    path.resolve(MODULE_DIR, '..', 'docker', 'windows-oem')
  ])
  if (agentSource === null) {
    // A MISSING AGENT IS A BROKEN PAYLOAD, not a warning: firstboot would fall
    // back to its embedded copy, but the point of shipping the file is that the
    // guest runs the SAME script this repository tests. Naming every place that
    // was searched is what turns this into a one-line fix.
    throw new Error(`the clipboard agent ${OEM_CLIP_AGENT_FILE} is missing from the OEM payload: no copy under `
      + `${[resolved, sourceDir, ...fallbackDirs, MODULE_DIR, path.resolve(MODULE_DIR, '..', 'docker')].filter(Boolean).join(', ')} `
      + '(the image copies it into windows-oem/, a checkout keeps it beside it as docker/cua-clip-agent.ps1)')
  }
  copyFileSync(agentSource, path.join(p.oemDir, OEM_CLIP_AGENT_FILE))
  log(`windows: ${name} clipboard agent staged from ${agentSource} (${statSync(agentSource).size} bytes)`)
  // J22-6: THE PRIVACY OFF-SWITCH'S WRITER. `DSH_CUA_CLIP_AGENT=0` is a STAGING
  // variable; the guest can only see a file. This stages `clip-agent-disabled`
  // beside the payload, and buildSetupImage() carries it into both places
  // firstboot searches — the medium's ROOT and `$OEM$/$$/Setup/Scripts` (which
  // Setup copies to C:\Windows\Setup\Scripts). firstboot then copies it from a
  // search location to C:\ProgramData\cua\ BEFORE its off-switch check, and
  // docker/cua-clip-agent.ps1 exits early on the same path.
  const clipAgentDisabled = String(process.env.DSH_CUA_CLIP_AGENT ?? '').trim() === '0'
  const sentinelPath = path.join(p.oemDir, CLIP_AGENT_SENTINEL_FILE)
  if (clipAgentDisabled) {
    // ASCII ONLY, deliberately: the guest may read this file in any editor, and
    // the presence semantics never depend on the content.
    writeFileSync(sentinelPath, `${CLIP_AGENT_SENTINEL_FILE}: staged because DSH_CUA_CLIP_AGENT=0.`
      + ' Presence disables the ambient clipboard agent on this guest.\n')
    log(`windows: ${name} clip agent disabled by DSH_CUA_CLIP_AGENT=0 (sentinel staged)`)
  } else {
    // A STALE SENTINEL IS THE SAME BUG AS NONE. The OEM directory lives under
    // the VM store and survives a re-create, so a previous `=0` create would
    // otherwise keep the switch OFF for a machine created with the knob unset.
    try { unlinkSync(sentinelPath) } catch {}
  }
  // F2: the staged answer file must actually name the edition, in the schema
  // position Setup reads. A placeholder left unreplaced is caught here, not on
  // the install console.
  const stagedXml = readFileSync(path.join(p.oemDir, 'Autounattend.xml'), 'utf8')
  if (stagedXml.includes('{{')) {
    const leftover = [...stagedXml.matchAll(/\{\{[A-Z_]+\}\}/gu)].map((match) => match[0])
    throw new Error(`the staged Autounattend.xml still contains ${[...new Set(leftover)].join(', ')} — Setup would read a literal placeholder`)
  }
  const selected = assertAnswerFileSelectsImage(stagedXml)
  // D1: THE TWO FAILURES THAT MADE A FULLY AUTOMATIC INSTALL LAND WITHOUT
  // OpenSSH. `$OEM$` is inert without UseConfigurationSet/L (H1), and the
  // firstboot layers must both be in the file (H2) — asserted here, on the
  // STAGED bytes, so a template regression fails the create with the reason
  // instead of a WSH dialog on the guest's desktop.
  assertAnswerFileUsesConfigurationSet(stagedXml)
  assertAnswerFileFirstbootLayers(stagedXml)
  // The staged payload is a DIRECTORY on the host; buildSetupImage() copies it
  // into the FAT32 partition at the ROOT (where Setup reads Autounattend.xml)
  // and into $OEM$ (so Setup copies the scripts into C:\Windows\Setup\Scripts).
  const setupDir = path.join(p.oemDir, '$OEM$', '$$', 'Setup', 'Scripts')
  mkdirSync(setupDir, { recursive: true })
  // S4: the SAME scripts Setup copies into C:\Windows\Setup\Scripts.
  // SetupComplete.cmd is the SYSTEM pass and Unattend.vbs is the hidden
  // first-logon launcher; both invoke cua-firstboot.ps1 idempotently.
  for (const file of ['setupcomplete.cmd', 'cua-firstboot.ps1', 'Unattend.vbs', OEM_CLIP_AGENT_FILE]) {
    copyFileSync(path.join(p.oemDir, file), path.join(setupDir, file))
  }
  // J22-6: THE SENTINEL RIDES THE SAME COPY when the switch is on, so it lands
  // in C:\Windows\Setup\Scripts (a firstboot search location) as well as at the
  // medium root. Absent when the knob is unset — nothing to copy, nothing to
  // require.
  if (existsSync(sentinelPath)) copyFileSync(sentinelPath, path.join(setupDir, CLIP_AGENT_SENTINEL_FILE))
  // R5: the EFI Shell fallback script goes in the medium's ROOT (that is where
  // firmware Shell looks for `startup.nsh`), not under $OEM$. buildSetupImage()
  // copies it into setup.img's root beside Autounattend.xml.
  writeFileSync(path.join(p.oemDir, 'startup.nsh'), startupNshText())
  log(`windows: ${name} OEM payload written (${files.length} files + $OEM$ scripts + startup.nsh fallback; ${selected.key}=${selected.value} from ${imageSelection.source}${imageSelection.verified === false ? ', UNVERIFIED' : ''})`)
  return p.oemDir
}

/* ------------------------------------------------------------------ *
 * The backend
 * ------------------------------------------------------------------ */

/**
 * R3: THE TWO QMP SIGNATURES, JOINED.
 *
 * The backend's helpers dial `qmp(host, port, commands, opts)`; the supervisor's
 * one implementation is `qmpCommands(port, commands, { timeoutMs, host })`. The
 * supervisor used to pass its primitive in directly, so the backend's HOST
 * string arrived as the supervisor's PORT argument and every probe died before
 * a byte reached the monitor:
 *
 *     probe(row) → qmpFor → qmp('127.0.0.1', 46100, …)
 *     qmpCommands('127.0.0.1', 46100, …) → net.connect('127.0.0.1' as port) → throws
 *     → status '' → qmp 'not answering' → a RUNNING QEMU never became ready.
 *
 * This adapter is the fix at the seam: it accepts the backend's signature and
 * forwards the supervisor's, so neither side has to change its contract and a
 * test can prove the join with a faithful stub. It is also tolerant of a plain
 * `(port, commands, opts)` primitive (a test or an older caller), which is
 * resolved by the argument TYPES — a number first is a port, a string first is
 * a host.
 */
/** Marks a function that already IS an adapter, so wrapping is idempotent. */
const QMP_ADAPTED = Symbol.for('dsh.cua.windows.qmpAdapted')

export function windowsQmpAdapter(primitive) {
  if (typeof primitive !== 'function') {
    throw new Error('the Windows backend needs a QMP primitive: (host, port, commands, opts) => Promise<object[]>')
  }
  // DOUBLE WRAPPING IS A REAL CALL PATH: the supervisor wraps its primitive AND
  // `createWindowsBackend` wraps whatever it is handed (a test may pass a stub
  // with no wrapper at all). Without this marker the second wrap treats the
  // backend-shaped call as a supervisor-shaped one — port becomes the command
  // array — which is the same class of bug as the one being fixed.
  if (primitive[QMP_ADAPTED] === true) return primitive
  const adapted = function qmp(host, port, commands, opts = {}) {
    // A caller that already speaks the supervisor's shape: (port, commands, opts).
    if (typeof host === 'number' && Array.isArray(port) && commands === undefined) {
      return primitive(host, port, opts)
    }
    return primitive(port, commands, { ...opts, host })
  }
  Object.defineProperty(adapted, QMP_ADAPTED, { value: true })
  return adapted
}

/**
 * The lifecycle object.
 *
 * @param {object} options
 * @param {string} options.store            the VM store
 * @param {(host: string, port: number, commands: object[], opts?: object) => Promise<object[]>} options.qmp
 * @param {(...parts: any[]) => void} options.log
 * @param {object|null} [options.transport] U2: the clipboard channel —
 *        `{ sshRun(spec, command, opts), putText(spec, guestPath, text),
 *        getText(spec, guestPath) }`. INJECTED so a unit test drives the real
 *        clipboard code with a stub and asserts the ORDER (file before task);
 *        the supervisor passes its ssh/scp helpers. `null` means "no SSH",
 *        which the CLIENTS report as a disabled state rather than as an error.
 */

/**
 * THE TWO PURE PIECES OF THE CLIPBOARD AGENT PROTOCOL.
 *
 * They live at module scope, not inside the backend, because they are the
 * CONTRACT between this host and a guest-side agent that ships separately: a
 * test must be able to prove "this ack does not describe that job" without a
 * hypervisor, an SSH server or a QEMU.
 */

/** SHA-256 (hex) of a clipboard payload — the only thing an ack compares. */
export function clipSha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/**
 * Does the agent's ack describe OUR job?
 *
 * `equal: true` is the agent's own statement that the bytes it placed on the
 * clipboard hash to the digest it was handed; the seq check makes a surviving
 * ack from an earlier write impossible to mistake for this one, and the digest
 * check (when both sides carry one) catches an agent that acked a different
 * payload. All three must agree: a partial match is a MISMATCH, never a pass.
 */
/**
 * J21-2: A SHORT, SINGLE-LINE NAME FOR WHY THE AGENT SAID NO.
 *
 * An ack can carry the agent's own failure (`ok: false`, `error: "…"`), and the
 * caller's reason string is what the panel prints and what the fallback reports
 * as `fastPathReason`. The code (when the agent sends one) is the useful part;
 * a message is truncated to one line so a PowerShell exception cannot become a
 * multi-line reason.
 */
function clipAgentErrorCode(ack = {}) {
  const code = ack?.code ?? ack?.err ?? ack?.errno
  if (typeof code === 'string' || typeof code === 'number') {
    const text = String(code).replace(/[\r\n]+/gu, ' ').trim()
    if (text !== '') return text.slice(0, 40)
  }
  const message = String(ack?.error ?? ack?.message ?? '').replace(/[\r\n]+/gu, ' ').trim()
  return (message === '' ? 'agent-error' : message).slice(0, 60)
}

/**
 * THE VERDICT, WITH A REASON — the shape the backend needs and the boolean
 * cannot carry.
 *
 * `equal: true` is the agent's own statement that the bytes it placed on the
 * clipboard hash to the digest it was handed; the seq check makes a surviving
 * ack from an earlier write impossible to mistake for this one, and the digest
 * check (when both sides carry one) catches an agent that acked a different
 * payload. All three must agree: a partial match is a MISMATCH, never a pass.
 *
 * J21-2: AN AGENT THAT REPORTS ITS OWN FAILURE IS NOT A DIGEST MISMATCH. The
 * old code looked only at `equal`/`seq`/`sha256`, so `{ ok: false, error:
 * 'clipboard is locked by another process' }` fell through to the generic
 * `ack-mismatch` — a reason that sends the operator to look at hashing and
 * encoding instead of at the agent's real complaint. `ok: false`, or any
 * non-empty `error` string, answers `agent-error:<code or short message>`.
 */
export function clipAckVerdict(expected = {}, ack = null) {
  if (ack === null || typeof ack !== 'object') return { ok: false, reason: 'ack-mismatch', detail: 'no ack was written by the agent' }
  // ONLY an explicit failure counts: agents that predate the field send no
  // `ok` at all, and `undefined !== false`.
  if (ack.ok === false || (typeof ack.error === 'string' && ack.error.trim() !== '')) {
    return { ok: false, reason: `agent-error:${clipAgentErrorCode(ack)}`, detail: `the agent reported a failure: ${String(ack.error ?? '').slice(0, 200) || 'no message'}` }
  }
  const seq = Number(expected?.seq ?? 0)
  const ackSeq = Number(ack.seq ?? 0)
  if (seq !== 0 && ackSeq !== seq) {
    return { ok: false, reason: 'ack-mismatch', detail: `the agent acked seq ${ackSeq}, not ${seq}` }
  }
  if (ack.equal !== true) {
    return { ok: false, reason: 'ack-mismatch', detail: 'the agent did not confirm the payload it placed on the clipboard' }
  }
  const want = String(expected?.sha256 ?? '')
  const got = String(ack.sha256 ?? '')
  if (want !== '' && got !== '' && want !== got) {
    return { ok: false, reason: 'ack-mismatch', detail: `the agent acked ${got.slice(0, 12)}…, the job carried ${want.slice(0, 12)}…` }
  }
  return { ok: true, reason: '', detail: '' }
}

/** The boolean half of the same contract (kept: existing callers and tests). */
export function clipAckMatches(expected = {}, ack = null) {
  return clipAckVerdict(expected, ack).ok
}

export function createWindowsBackend({ store, qmp, log = () => {}, transport = null }) {
  /** Monotonic counter so two frames never share a serial name. */
  let FRAME_SEQUENCE = 0

  /**
   * R3: ONE QMP CALL SIGNATURE IN, THE SUPERVISOR'S ONE OUT.
   *
   * The backend's helpers all dial `qmp(host, port, commands, opts)` (that is
   * what `qmpFor` writes), but the primitive the supervisor injects has always
   * been `qmpCommands(port, commands, { timeoutMs, host })`. Passing it straight
   * in therefore sent the HOST as the PORT: the monitor dial threw
   * `ECONNREFUSED`/`ERR_INVALID_ARG_TYPE` on every probe, `probe()` reported
   * `qmp: 'not answering'`, and a perfectly running QEMU never became ready —
   * even after the row's `name` was fixed.
   *
   * `windowsQmpAdapter` is that missing half, exported so a test can prove the
   * two shapes line up instead of trusting the wiring.
   */
  const callQmp = windowsQmpAdapter(qmp)

  /**
   * ACCEPT A NAME *OR* A ROW. Every helper below is called with the registry row
   * in production and with a flat spec in tests; resolving once here keeps both
   * correct (R2).
   */
  function namedSpec(spec, fallback = '') {
    const name = windowsRowName(spec, fallback)
    if (spec && typeof spec === 'object') return spec.name === name ? spec : { ...spec, name }
    return { name }
  }
  /** One QEMU child per computer, so stop/kill act on the right process. */
  const children = new Map()

  /**
   * R2: A NAME, OR A ROW THAT CARRIES ONE.
   *
   * The supervisor's rows are keyed by name and (before this fix) had no `name`
   * field at all, so `pathsFor(row.name)` was `pathsFor(undefined)` →
   * `$STORE/windows/undefined/qemu.pid`, and every liveness answer was a lie.
   * Resolving through `windowsRowName` here means the same helper is correct
   * whether it is handed `'win-box'` or the row for it.
   */
  function pathsFor(target) {
    const base = windowsPaths(store, windowsRowName(target))
    // THE FIRMWARE RIDES WITH THE PATHS. `usesEfiVars` is the one bit the boot
    // path must know BEFORE it creates anything: a BIOS computer has no NVRAM
    // file and no swtpm, and creating them anyway leaves a qcow2 the next
    // q35 boot silently adopts. Resolving here (rather than at each call site)
    // means `pathsFor(row)` and `pathsFor('name')` cannot disagree.
    const record = target !== null && typeof target === 'object' ? target : {}
    const firmware = windowsFirmwareForSpec({ ...record, paths: base })
    return { ...base, firmware, usesEfiVars: firmware.efiVars === true }
  }

  /** Which of our two QEMU processes is alive (pidfile is written by QEMU). */
  function qemuPid(target) {
    try {
      const pid = Number(readFileSync(pathsFor(target).qemuPid, 'utf8').trim())
      return Number.isFinite(pid) && pid > 0 ? pid : 0
    } catch {
      return 0
    }
  }

  function pidAlive(pid) {
    if (!pid) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  }

  /**
   * WHAT THE SPAWNED CHILD ITSELF SAYS: `exited` is true only when the child has
   * been reaped. It exists because "no pidfile" has two very different causes —
   * QEMU never started, or QEMU has not WRITTEN the pidfile yet — and only this
   * distinguishes them. Without it the install watchdog would call a QEMU that
   * is one millisecond away from writing its pidfile dead.
   */
  function childState(name) {
    const child = children.get(`qemu:${windowsRowName(name)}`)
    if (child === undefined) return { known: false, exited: false }
    return { known: true, exited: child.exitCode !== null || child.signalCode !== null }
  }

  /** The ports one computer uses: QMP, VNC and the SSH forward. */
  function portsFor(spec) {
    return windowsPortsOf(spec)
  }

  /**
   * START SWTMP FIRST, THEN QEMU.
   *
   * swtpm owns the TPM state directory and the socket; QEMU connects to it as a
   * chardev, so a QEMU that starts before the socket exists fails with "Failed
   * to connect to socket". It is a plain child process, killed by `stopSwtpm`.
   */
  function startSwtpm(target) {
    const name = windowsRowName(target)
    const p = pathsFor(name)
    mkdirSync(p.tpmDir, { recursive: true })
    try { unlinkSync(p.tpmSocket) } catch {}
    const child = spawn(SWTPM, [
      'socket', '--tpm2',
      // J1-3 FOR SWTPM TOO. swtpm parses `--ctrl/--tpmstate/--pid/--log` values
      // with the same comma-splitting option grammar QEMU uses, so a store path
      // containing a comma (`/srv/vms,beta/...`) used to hand swtpm a truncated
      // path plus a mystery option — "could not open pid file", or a log written
      // somewhere else. `,,` is the documented escape inside a value; quoting is
      // not, because the split runs first. One escaper, every interpolation.
      '--ctrl', `type=unixio,path=${qemuEscapeOptionValue(p.tpmSocket)}`,
      '--tpmstate', `dir=${qemuEscapeOptionValue(p.tpmDir)},mode=0600`,
      '--pid', `file=${qemuEscapeOptionValue(p.tpmPid)}`,
      '--log', `file=${qemuEscapeOptionValue(path.join(p.dir, 'swtpm.log'))},level=1`,
      '--flags', 'not-need-init,startup-clear'
    ], { stdio: 'ignore', detached: true })
    child.unref()
    children.set(`tpm:${name}`, child)
    // Wait for the socket: QEMU connects immediately.
    for (let index = 0; index < 100; index += 1) {
      if (existsSync(p.tpmSocket)) return true
      execFileSync('sleep', ['0.1'])
    }
    return existsSync(p.tpmSocket)
  }

  function stopSwtpm(target) {
    const name = windowsRowName(target)
    const child = children.get(`tpm:${name}`)
    children.delete(`tpm:${name}`)
    try { child?.kill('SIGTERM') } catch {}
    try {
      const pid = Number(readFileSync(pathsFor(name).tpmPid, 'utf8').trim())
      if (pidAlive(pid)) process.kill(pid, 'SIGTERM')
    } catch {}
  }

  /**
   * Boot the computer, or bring it back.
   *
   * `installPending` is decided by the caller from the disk's existence: a fresh
   * create boots the install ISO; every later start boots the disk.
   */
  async function boot(rawSpec, { installPending = false, allowGpuFallback = true } = {}) {
    // ACCEPT EITHER SHAPE: the create path hands in flat fields, a start path
    // could hand in a registry row. buildQemuArgs only reads the flat ones.
    const spec = windowsBootSpec(rawSpec)
    const p = pathsFor(spec)
    mkdirSync(p.dir, { recursive: true })
    const caps = windowsHostCaps()
    if (!caps.qemu) throw new Error(`the Windows backend needs ${WINDOWS_QEMU} (install qemu-system-x86 in the image)`)
    // THE DEVICE SPLIT. A missing node and a mounted-but-denied node are two
    // different defects with two different fixes, and the old single sentence
    // ("needs /dev/kvm (compose.emulator.yaml)") was wrong for both of the new
    // cases: wrong for a char device (isFile() is false) and wrong advice for a
    // GID problem. `kvmPreflightError` quotes the observed mode/owner/groups.
    const kvmError = windowsKvmPreflight()
    if (kvmError !== null) throw kvmError
    // ONLY THE FIRMWARE THIS COMPUTER USES IS REQUIRED. A BIOS guest was being
    // refused on a host with no OVMF and no swtpm — two packages it will never
    // open — which made `7u` unusable for a reason that had nothing to do with
    // Windows 7.
    if (p.usesEfiVars && (!caps.ovmfCode || !caps.ovmfVars)) {
      throw new Error(`the Windows backend needs OVMF (${OVMF_CODE} + ${OVMF_VARS_TEMPLATE}); install the ovmf package in the image`)
    }
    if (p.firmware.tpm === true && !caps.swtpm) throw new Error(`the Windows backend needs swtpm (${SWTPM}); install the swtpm package in the image`)
    if (p.usesEfiVars && !existsSync(p.efiVars)) {
      // OVMF fails with "Could not open backing file" when vars qcow2 is missing.
      mkdirSync(path.dirname(p.efiVars), { recursive: true })
      execFileSync('/usr/bin/qemu-img', ['create', '-f', 'qcow2', '-b', OVMF_VARS_TEMPLATE, '-F', 'raw', p.efiVars, '4M'], { timeout: 30000 })
      log(`windows: ${spec.name} EFI vars created from ${OVMF_VARS_TEMPLATE}`)
    }
    // THE CHOICE IS PERSISTED BEFORE THE FIRST BOOT, because the supervisor's
    // start path does not carry `windowsVersion`: without this file a Windows 7
    // computer installs on pc/SeaBIOS and comes back from a restart on
    // q35/OVMF, where the disk is not bootable. See windowsFirmwareForSpec().
    writeFirmwareMarker(p.dir, p.firmware)
    if (p.firmware.tpm === true) {
      if (!startSwtpm(spec.name)) throw new Error('swtpm did not create its socket (see swtpm.log)')
    } else {
      // A legacy guest must not inherit an emulator a previous shape started.
      stopSwtpm(spec.name)
    }
    // FROM HERE swtpm IS RUNNING, so every failure has to stop it again: a
    // leaked swtpm keeps the TPM state directory open and the next boot fails
    // with "TPM is already in use" — the kind of failure that only appears on
    // the SECOND attempt, long after the first error was read.
    const attempt = async (attemptSpec, { stderrFile = p.qemuStderr } = {}) => {
      // A STALE PIDFILE IS NOT THIS BOOT. `qemuPid()` is how the watchdog below
      // (and every other helper) decides "alive"; a pidfile left by a previous
      // boot names a pid that is gone or, worse, recycled. QEMU rewrites it
      // after init, but the WINDOW between spawn and that write must not be
      // filled by last night's answer.
      try { unlinkSync(p.qemuPid) } catch {}
      const argv = buildQemuArgs({
        ...attemptSpec,
        paths: p,
        // ONE FIRMWARE, DECIDED ONCE. `pathsFor()` already resolved it from the
        // row, the marker and the media name; passing it through means a retry
        // or a GPU-less second attempt cannot re-resolve it differently.
        firmware: p.firmware,
        installPending,
        virtio: Boolean(caps.virtioWin),
        driverIso: caps.virtioWin ? VIRTIO_WIN_ISO : null
      })
      // QEMU'S STDERR IS THE ONLY PLACE AN INIT FAILURE IS EXPLAINED, and it
      // used to go to /dev/null: the reported create left one supervisor line
      // ("qemu started (pid 906, installing)"), an EMPTY serial.log and no QEMU
      // diagnosis anywhere on the host. `-serial file:` records the GUEST;
      // this records QEMU itself, on both streams, truncated per attempt so the
      // excerpt read after a failure belongs to the attempt that failed.
      const stderrFd = openSync(stderrFile, 'w')
      let child
      try {
        child = spawn(WINDOWS_QEMU, argv, { stdio: ['ignore', stderrFd, stderrFd], detached: true })
      } finally {
        // The child holds its own copy; keeping ours open would leak an fd per
        // restart and delay nothing.
        try { closeSync(stderrFd) } catch {}
      }
      children.set(`qemu:${spec.name}`, child)
      // A SPAWN ERROR IS AN EVENT, NOT A THROW: without this listener, a missing
      // qemu binary (or E2BIG on a bad argv) raises an unhandled 'error' and takes
      // the whole supervisor down — every computer with it.
      child.on('error', (error) => {
        log(`windows: ${spec.name} qemu failed to start: ${error?.message ?? error}`)
        stopSwtpm(spec.name)
      })
      child.unref()
      log(`windows: ${spec.name} qemu started (pid ${child.pid}${installPending ? ', installing' : ''})`)
      // R1/F2: THE INSTALL CD'S "PRESS ANY KEY" WINDOW, PRESSED FOR THE USER.
      //
      // VERIFIED LIVE: OVMF reaches the DVD, `cdboot.efi 10.0.26100.1` prints
      // "Press any key to boot from CD or DVD", nobody presses a key within 5 s,
      // cdboot prints EFI_TIMEOUT and BDS falls into the EFI Internal Shell —
      // where the install simply stops. This schedules QMP key presses inside
      // that window and deliberately does NOT await them: boot()'s pidfile
      // window must not be extended by a keystroke.
      //
      // F2: THE ANCHOR IS THE SERIAL CONSOLE, NOT THE SPAWN CLOCK. The live
      // forensic child proved the fixed 1.5/3.5/5.5 s presses land while OVMF is
      // still enumerating, i.e. BEFORE cdboot prints its prompt, so the first
      // boot missed the window entirely. `serial.log` is watched for the prompt
      // signature (or for first output + ~1.5 s) and the presses fire from
      // there, every 0.8 s; the fixed schedule survives only as the fallback
      // for a console that stays silent. See runCdbootKeys().
      //
      // ONLY WHILE INSTALLING. A boot of an already-installed disk has no
      // prompt to dismiss, and typing into a live guest would be a keystroke
      // the user never asked for.
      //
      // Failure to send is NOT fatal (the firmware may not have the keyboard up
      // yet, or the child may have exited): it is logged, and the next attempt
      // in the schedule covers the same window.
      if (installPending && cdbootKeysEnabled() && child?.pid) {
        const keyedSpec = windowsBootSpec({ ...attemptSpec, paths: p })
        void runCdbootKeys({
          scheduleMs: cdbootKeyScheduleMs(),
          serialLog: p.serialLog,
          // THE PROMPT IS THE ANCHOR, AND IT IS WATCHED FOR 90 s (measured: on a
          // cold q35/OVMF boot cdboot prints well after 8 s). `armDelayMs: 0`
          // disables the first-output anchor, whose 1.5 s guess landed on the
          // OVMF banner instead of on the prompt.
          maxWindowMs: cdbootPromptWindowMs(),
          armDelayMs: 0,
          pollMs: 300,
          // THE CD BOOT MAY BE LOOPED: BDS re-enters the DVD when nobody
          // answers, and it reprints the prompt. Re-arm on it, but never more
          // than a dozen cycles and never after the QEMU is gone.
          cycles: cdbootRearmCycles(),
          watchMs: cdbootRearmWatchMs(),
          isAlive: () => child.exitCode === null && child.signalCode === null,
          log,
          name: spec.name,
          sendKey: (key) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              throw new Error('this QEMU child exited before the key was due')
            }
            // A SHORT PER-PRESS BUDGET: a monitor busy with another command
            // refuses quickly, and waiting 15 s for the refusal burned the whole
            // prompt window. The retry gap presses again instead.
            return sendKeys(keyedSpec, { key, timeoutMs: cdbootPressTimeoutMs() })
          }
        }).catch(() => {})
      }
      const settled = await waitForQemuBoot({
        child,
        pidFile: p.qemuPid,
        isAlive: (pid) => pidAlive(pid),
        windowMs: qemuBootWindowMs()
      })
      return { child, display: attemptSpec.gpu && attemptSpec.virgl ? 'egl-headless' : 'none', ...settled }
    }

    const readStderr = (file = p.qemuStderr) => {
      try { return readFileSync(file, 'utf8') } catch { return '' }
    }

    // THE FIRMWARE CHOICE IS PART OF THE ANSWER. A legacy-BIOS computer is
    // supported but experimental, and the row must say so instead of leaving a
    // reader to infer it from the argv.
    const firmwareWarnings = windowsFirmwareWarnings(p.firmware)
    for (const warning of firmwareWarnings) log(`windows: ${spec.name} ${warning.message}`)
    /**
     * J1-2: A THROW IS A FAILURE TOO, SO IT CLEANS UP TOO.
     *
     * The invariant above ("every failure has to stop it again") was enforced
     * only for the `ok: false` path: `attempt()` rejects nothing normally, but
     * `buildQemuArgs` throws for a refused version, `openSync` throws for an
     * unwritable stderr file and `waitForQemuBoot` can throw. Every one of those
     * escaped `boot()` with swtpm STILL RUNNING — the leaked emulator holds the
     * per-computer TPM state directory, and the NEXT boot dies with "TPM is
     * already in use", a failure that appears long after the real one.
     */
    const stopBootResidue = (name) => {
      // ORDER MATTERS: take the handle out of the map, kill it, and only then
      // forget it — the reverse order throws the only handle away.
      const child = children.get(`qemu:${name}`)
      children.delete(`qemu:${name}`)
      try { child?.kill('SIGKILL') } catch {}
      stopSwtpm(name)
    }

    let first
    try {
      first = await attempt(spec)
    } catch (error) {
      // No `first` means no child we can name; the map lookup inside
      // stopBootResidue is the handle, and an absent one is not an error.
      stopBootResidue(spec.name)
      throw error
    }
    if (first.ok) return { pid: first.pid, installPending, display: spec.gpu && spec.virgl ? 'egl-headless' : 'none', gpuFallback: false, firmware: p.firmware.bios, warnings: firmwareWarnings }

    const stderr = readStderr()
    const excerpt = qemuStderrExcerpt(stderr, 20)
    const reason = qemuStderrReason(stderr)
    const kind = classifyQemuInitFailure(stderr)
    // NOTHING OF THE DEAD ATTEMPT MAY SURVIVE: its child has exited (or is
    // about to), and its swtpm socket belongs to a TPM the next QEMU must be
    // able to claim.
    try { children.delete(`qemu:${spec.name}`) } catch {}
    try { first.child?.kill('SIGKILL') } catch {}
    stopSwtpm(spec.name)
    log(`windows: ${spec.name} qemu died during init (${kind}): ${reason || 'no stderr output'}`)
    if (excerpt !== '') log(`windows: ${spec.name} qemu-stderr.log tail:\n${excerpt}`)

    // F3: THE DISPLAY PATH MAY DEGRADE, THE ACCELERATOR MAY NOT.
    //
    // A host whose EGL/render-node/virgl stack cannot initialize is a host that
    // cannot give Windows an accelerated display — but Windows renders on an
    // emulated VGA/WARP framebuffer perfectly well, which is the documented
    // behaviour of this backend. Retrying ONCE with `-display none` + VGA turns
    // a dead create into a working computer WITH a warning naming the captured
    // reason.
    //
    // KVM is the opposite: the preflight already proved the device is usable, so
    // a KVM failure here is news (a host that lost the device, a nested-VM
    // restriction) and booting on TCG would be a 30-minute silent lie. It is
    // surfaced with the captured stderr and NEVER degraded.
    const canFallback = allowGpuFallback && first.display !== 'none' && kind !== 'kvm' && kind !== 'none' && (kind === 'display' || kind === 'init')
    if (canFallback) {
      // THE TPM MUST BE BACK BEFORE THE RETRY. The cleanup above stopped swtpm
      // (a QEMU that has exited leaves the emulator with a dead data client, and
      // the next QEMU would die on "Failed to connect to socket"), so the retry
      // gets a FRESH emulator on the SAME per-computer state directory — the TPM
      // therefore keeps its state and the reinstall does not re-measure it.
      if (p.firmware.tpm === true) {
        try {
          if (!startSwtpm(spec.name)) throw new Error('swtpm did not restart for the GPU-less retry (see swtpm.log)')
        } catch (error) {
          // The retry never gets an emulator, so the failed one must not linger.
          stopBootResidue(spec.name)
          throw error
        }
      }
      log(`windows: ${spec.name} retrying once without the GPU display (-display none, plain VGA)`)
      // THE RETRY WRITES ITS OWN FILE: `qemu-stderr.log` keeps the FIRST
      // attempt's diagnosis (the EGL line the warning quotes), and a second
      // failure has its own evidence at `qemu-stderr-retry.log`.
      // J1-2: the retry's own throw (a refused argv, an unwritable file) is the
      // same leak, one attempt later.
      let retry
      try {
        retry = await attempt({ ...spec, gpu: false, virgl: false }, { stderrFile: p.qemuStderrRetry })
      } catch (error) {
        stopBootResidue(spec.name)
        throw error
      }
      if (retry.ok) {
        const warning = {
          code: 'gpu-fallback',
          message: `virgl/EGL display unavailable on this host (${reason || 'QEMU could not initialize the egl-headless display'}); continuing without GPU display — Windows renders on emulated VGA/WARP as documented`
        }
        log(`windows: ${spec.name} ${warning.message}`)
        return { pid: retry.pid, installPending, display: 'none', gpuFallback: true, firmware: p.firmware.bios, warnings: [warning, ...firmwareWarnings], stderrExcerpt: excerpt }
      }
      const retryStderr = readStderr(p.qemuStderrRetry)
      const retryExcerpt = qemuStderrExcerpt(retryStderr, 20) || excerpt
      const retryReason = qemuStderrReason(retryStderr) || reason
      const retryKind = classifyQemuInitFailure(retryStderr)
      try { children.delete(`qemu:${spec.name}`) } catch {}
      try { retry.child?.kill('SIGKILL') } catch {}
      stopSwtpm(spec.name)
      log(`windows: ${spec.name} the GPU-less retry ALSO failed (${retryKind}): ${retryReason || 'no stderr output'}`)
      throw qemuInitError({
        name: spec.name,
        kind: retryKind === 'none' ? kind : retryKind,
        reason: retryReason,
        excerpt: retryExcerpt,
        stderrPath: p.qemuStderrRetry,
        retriedWithoutGpu: true
      })
    }

    throw qemuInitError({ name: spec.name, kind, reason, excerpt, stderrPath: p.qemuStderr, retriedWithoutGpu: false })
  }

  /** QMP to this computer's loopback socket, with the supervisor's client. */
  async function qmpFor(spec, commands, { timeoutMs = 15000 } = {}) {
    // THE ROW HAS `ports: { qmp }`, the boot spec has `qmpPort`. Resolving here
    // means no caller can dial `undefined` (see windowsPortsOf).
    const { qmpPort } = windowsPortsOf(spec)
    if (qmpPort <= 0) throw new Error('this computer has no QMP port recorded (the row is missing ports.qmp)')
    return callQmp('127.0.0.1', qmpPort, commands, { timeoutMs })
  }

  /** `query-status` plus the process table: the only trustworthy "is it up". */
  async function probe(rawSpec, { name = '' } = {}) {
    const spec = namedSpec(rawSpec, name)
    const alive = pidAlive(qemuPid(spec))
    let status = ''
    let error = ''
    if (alive) {
      try {
        const answer = await qmpFor(spec, [{ execute: 'query-status' }], { timeoutMs: 5000 })
        status = String(answer?.[0]?.return?.status ?? '')
      } catch (caught) {
        error = caught?.message ?? String(caught)
      }
    }
    // `qmp` is the fact the PANEL prints. It is deliberately not `status ||
    // 'not running'` at the call sites: "QEMU is alive but its monitor did not
    // answer" is a third state, and collapsing it into "not running" is what
    // made a live install read as dead.
    const qmp = !alive ? 'no qemu' : status === '' ? 'not answering' : status
    return { alive, status, qmp, error, name: spec.name }
  }

  /**
   * READY = QMP `running` AND a guest endpoint that answers.
   *
   * The endpoint is SSH by default (the OEM script installs it, and exec/put/get
   * depend on it), with VNC-accept as the fallback for a computer created with
   * `ssh: false` or one whose first boot is still finishing. `paused` is NOT
   * ready — a paused guest keeps its VNC port open and used to read as running.
   */
  async function ready(rawSpec, { ssh = true, phase = 'running', name = '' } = {}) {
    const spec = namedSpec(rawSpec, name)
    const state = await probe(spec)
    const ports = windowsPortsOf(spec)
    if (!state.alive || state.status !== 'running') return { ready: false, endpoint: 'none', phase, ...state }
    if (phase === 'install') {
      // DURING SETUP only SSH counts. QEMU's VNC socket answers from the first
      // second of setup.exe, so a VNC probe called a half-installed Windows
      // "ready", set installComplete, and the next Start booted the half-written
      // disk. SSH exists only after the answer file has run.
      const banner = ports.sshPort > 0 ? await bannerProbe('127.0.0.1', ports.sshPort, { timeoutMs: 3000 }) : null
      if (banner !== null) return { ready: true, endpoint: 'ssh', banner: banner.slice(0, 24), phase, ...state }
      return { ready: false, endpoint: 'none', phase, ...state }
    }
    if (ssh) {
      const banner = ports.sshPort > 0 ? await bannerProbe('127.0.0.1', ports.sshPort) : null
      if (banner !== null) return { ready: true, endpoint: 'ssh', banner: banner.slice(0, 24), phase, ...state }
    }
    const vnc = ports.vncPort > 0 ? await bannerProbe('127.0.0.1', ports.vncPort) : null
    if (vnc !== null) return { ready: true, endpoint: 'vnc', phase, ...state }
    return { ready: false, endpoint: 'none', phase, ...state }
  }

  /** A PNG frame of the guest's framebuffer (QMP screendump). */
  async function screenshot(rawSpec, { saveTo = null } = {}) {
    const spec = namedSpec(rawSpec)
    const p = pathsFor(spec)
    const unique = `${(FRAME_SEQUENCE += 1)}-${randomBytes(4).toString('hex')}`
    const file = path.join(p.dir, `shot-${unique}.png`)
    await qmpFor(spec, [{ execute: 'screendump', arguments: { filename: file } }])
    let png = null
    for (let attempt = 0; attempt < 40 && png === null; attempt += 1) {
      if (existsSync(file)) {
        png = readFileSync(file)
        try { unlinkSync(file) } catch {}
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    if (png === null) throw new Error('the guest produced no frame (screendump wrote nothing)')
    if (typeof saveTo === 'string' && saveTo !== '') writeFileSync(saveTo, png)
    return { png }
  }

  /** Absolute pointer, in frame pixels (the frame IS the display). */
  async function click(rawSpec, x, y, { width, height, button = 'left' } = {}) {
    const spec = namedSpec(rawSpec)
    const toAbsolute = (value, extent) => Math.max(0, Math.min(0x7fff, Math.round((Number(value) / Math.max(1, Number(extent))) * 0x7fff)))
    const events = [
      { type: 'abs', data: { axis: 'x', value: toAbsolute(x, width) } },
      { type: 'abs', data: { axis: 'y', value: toAbsolute(y, height) } },
      { type: 'btn', data: { down: true, button } },
      { type: 'btn', data: { down: false, button } }
    ]
    await qmpFor(spec, [{ execute: 'input-send-event', arguments: { events } }])
    return { x: Number(x), y: Number(y) }
  }

  async function move(rawSpec, x, y, { width, height } = {}) {
    const spec = namedSpec(rawSpec)
    const toAbsolute = (value, extent) => Math.max(0, Math.min(0x7fff, Math.round((Number(value) / Math.max(1, Number(extent))) * 0x7fff)))
    await qmpFor(spec, [{
      execute: 'input-send-event',
      arguments: {
        events: [
          { type: 'abs', data: { axis: 'x', value: toAbsolute(x, width) } },
          { type: 'abs', data: { axis: 'y', value: toAbsolute(y, height) } }
        ]
      }
    }])
    return { x: Number(x), y: Number(y) }
  }

  async function drag(rawSpec, fromX, fromY, toX, toY, { width, height } = {}) {
    const spec = namedSpec(rawSpec)
    const toAbsolute = (value, extent) => Math.max(0, Math.min(0x7fff, Math.round((Number(value) / Math.max(1, Number(extent))) * 0x7fff)))
    const at = (x, y) => [
      { type: 'abs', data: { axis: 'x', value: toAbsolute(x, width) } },
      { type: 'abs', data: { axis: 'y', value: toAbsolute(y, height) } }
    ]
    await qmpFor(spec, [{ execute: 'input-send-event', arguments: { events: [...at(fromX, fromY), { type: 'btn', data: { down: true, button: 'left' } }] } }])
    await qmpFor(spec, [{ execute: 'input-send-event', arguments: { events: at(toX, toY) } }])
    await qmpFor(spec, [{ execute: 'input-send-event', arguments: { events: [...at(toX, toY), { type: 'btn', data: { down: false, button: 'left' } }] } }])
    return { from: { x: Number(fromX), y: Number(fromY) }, to: { x: Number(toX), y: Number(toY) } }
  }

  /** Keys and ASCII text, as physical qcodes with the right modifiers. */
  async function sendKeys(rawSpec, { text = null, key = null, timeoutMs = 0 } = {}) {
    const spec = namedSpec(rawSpec)
    const events = []
    const press = (qcode, { shift = false, ctrl = false, alt = false } = {}) => {
      const modifiers = []
      if (ctrl) modifiers.push('ctrl')
      if (alt) modifiers.push('alt')
      if (shift) modifiers.push('shift')
      for (const modifier of modifiers) events.push({ type: 'key', data: { down: true, key: { type: 'qcode', data: modifier } } })
      events.push({ type: 'key', data: { down: true, key: { type: 'qcode', data: qcode } } })
      events.push({ type: 'key', data: { down: false, key: { type: 'qcode', data: qcode } } })
      for (const modifier of modifiers.reverse()) events.push({ type: 'key', data: { down: false, key: { type: 'qcode', data: modifier } } })
    }
    if (key !== null) {
      const parsed = parseKeySpec(key)
      press(parsed.qcode, { shift: parsed.shift || parsed.shiftModifier, ctrl: parsed.ctrl, alt: parsed.alt })
    }
    if (text !== null) {
      for (const char of String(text)) {
        const mapped = charToKey(char)
        if (mapped === null) {
          throw new Error(`"${char}" cannot be typed on a Windows computer: the QMP keyboard sends physical keys, so only printable ASCII is supported (no clipboard)`)
        }
        press(mapped.qcode, { shift: mapped.shift })
      }
    }
    if (events.length === 0) return { sent: 0 }
    const budget = Number(timeoutMs) > 0 ? Math.min(120000, Math.trunc(Number(timeoutMs))) : 15000
    const replies = await qmpFor(spec, [{ execute: 'input-send-event', arguments: { events } }], { timeoutMs: budget })
    // A REFUSED EVENT IS A RESOLVED RESULT, NOT A THROW. Reporting `{sent: n}`
    // without reading it is how the cdboot scheduler logged "pressed enter" for
    // every key the monitor had refused (see cdbootPressFailure()).
    const refused = cdbootPressFailure(replies)
    if (refused !== null) return { sent: 0, error: refused }
    return { sent: events.length }
  }

  /** Suspend is QMP `stop` (pause the VM, keep RAM); resume is `cont`. */
  async function pause(rawSpec) {
    await qmpFor(namedSpec(rawSpec), [{ execute: 'stop' }])
    return { paused: true }
  }

  async function unpause(rawSpec) {
    await qmpFor(namedSpec(rawSpec), [{ execute: 'cont' }])
    return { unpaused: true }
  }

  /** F2: how long a mid-install guest may have for ACPI before `quit`. */
  function installShutdownWindowMs() {
    const raw = Number(process.env.DSH_CUA_WINDOWS_INSTALL_SHUTDOWN_MS)
    return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 30000) : 5000
  }

  /**
   * Graceful power-off: `system_powerdown`, then wait, then `quit`.
   *
   * The supervisor owns the checkpoint and the registry; this only makes the
   * process stop. Returns which method worked so shutdown can mark `mayBeTorn`.
   *
   * F2 — TWO GUESTS THAT CANNOT HONOUR A 120 s ACPI WAIT, and used to burn it
   * anyway:
   *
   *   * PAUSED. `query-status` says `paused` (a suspend left the machine paused,
   *     or it was created `-S` and never continued). A paused guest does not run
   *     its ACPI handler at all: `system_powerdown` is accepted by QEMU and then
   *     nothing happens for the whole timeout. Sending `cont` FIRST is the fix —
   *     the guest gets to run the handler, and a suspend→resume→shutdown is
   *     honest instead of a 120 s stall ending in `quit`.
   *
   *   * MID-INSTALL. A WinPE / Setup screen has no ACPI handler either, so a
   *     shutdown during a half-finished install is never "clean". It gets a
   *     SHORT explicit window and then `quit`, and the result says
   *     `installing: true` + `forced: true` so the supervisor marks `mayBeTorn`:
   *     the disk is half-written and must never be recorded as a clean restore
   *     point that Start would silently cold-boot.
   *
   * A NORMAL RUNNING GUEST keeps the full timeout semantics (the 120 s default
   * is for a slow init).
   */
  async function shutdown(rawSpec, { timeoutMs = 120000 } = {}) {
    const spec = namedSpec(rawSpec)
    const state = await probe(spec)
    if (!state.alive) {
      stopSwtpm(spec)
      return { method: 'already-off', exited: true, installInProgress: false }
    }
    // F2a: a paused machine ignores ACPI. Continue it first, or the powerdown
    // below is a no-op that costs the entire timeout.
    const paused = state.status === 'paused' || state.status === 'suspended'
    if (paused) {
      try {
        await qmpFor(spec, [{ execute: 'cont' }], { timeoutMs: 5000 })
      } catch {
        // A monitor that will not `cont` still has `quit`; fall through and let
        // the powerdown/quit path decide.
      }
    }
    // F2b: classify the row, not just the process. `installing`/`booting` is a
    // guest in Setup: no ACPI handler, half-written disk.
    const rowState = String(rawSpec?.state ?? '')
    const installInProgress = rowState === 'installing' || rowState === 'booting'
    const waitMs = installInProgress ? installShutdownWindowMs() : Math.max(1000, timeoutMs)
    let method = 'acpi'
    try {
      const answer = await qmpFor(spec, [{ execute: 'system_powerdown' }], { timeoutMs: 15000 })
      if (answer?.[0]?.error) {
        method = 'quit'
      }
    } catch {
      method = 'quit'
    }
    const deadline = Date.now() + Math.max(installInProgress ? 0 : 1000, waitMs)
    while (Date.now() < deadline) {
      if (!pidAlive(qemuPid(spec))) {
        stopSwtpm(spec)
        // F2b: a mid-install exit is still a torn disk — never a clean restore
        // point — so it carries `forced` even when ACPI appeared to work.
        return { method, exited: true, ...(installInProgress ? { forced: true } : {}), installInProgress }
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    method = 'quit'
    try {
      await qmpFor(spec, [{ execute: 'quit' }], { timeoutMs: 10000 })
    } catch {}
    for (let index = 0; index < 30; index += 1) {
      if (!pidAlive(qemuPid(spec))) {
        stopSwtpm(spec)
        // F2b: `forced` is the truth the supervisor persists as `mayBeTorn`. A
        // guest that actually honoured ACPI is NOT forced; a mid-install `quit`
        // is, even though it exited — the disk is half-written either way.
        return { method, exited: true, forced: true, installInProgress }
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return { method: 'quit', exited: false, forced: true, installInProgress }
  }

  /* ------------------------------------------------------------------ *
   * U2: THE CLIPBOARD, THROUGH THE GUEST'S INTERACTIVE SESSION
   * ------------------------------------------------------------------ */

  /**
   * THE ONLY WORKING CLIPBOARD PATH OF A WINDOWS GUEST — and why it is built
   * this way.
   *
   * Two routes look obvious and BOTH ARE DEAD (each was tried on the live VM):
   *
   *   RFB ClientCutText  QEMU's VNC server accepts the message and drops it:
   *                      the guest runs no clipboard agent, so the desktop
   *                      never sees the text. A human who pasted got the
   *                      guest's OLD clipboard — the send "worked" and did
   *                      nothing, which is the worst possible failure.
   *   Set-Clipboard      sshd runs in SESSION 0. Session 0 has its own window
   *   over SSH           station and its own (empty) clipboard, so the command
   *                      exits 0 and the user sees nothing change.
   *
   * What DOES work is the only context that owns the visible clipboard: the
   * logged-on user's own session. `cua-firstboot.ps1` registers two on-demand
   * tasks with `/it` (interactive) whose bodies run `Set-Clipboard` /
   * `Get-Clipboard` THERE, and the pair below drives them over the SSH channel
   * the supervisor already has:
   *
   *   set  text -> C:\\ProgramData\\cua\\clip.txt  -> schtasks /run /tn cua-clip-set
   *   get  schtasks /run /tn cua-clip-get -> C:\\ProgramData\\cua\\clip-read.txt
   *
   * THREE THINGS THAT MAKE THE DIFFERENCE BETWEEN WORKING AND LOOKING LIKE IT:
   *
   *   1. THE ORDER. clip.txt is written BEFORE the task runs, always: a task
   *      that fires first reads the PREVIOUS paste, which is the same
   *      "old clipboard" symptom one layer up.
   *   2. THE COMPLETION. `schtasks /run` answers "SUCCESS: Attempted to run"
   *      as soon as the task is QUEUED; it says nothing about the body. The
   *      task's own `Last Result` from `/query /fo LIST /v` is the exit code,
   *      and a non-zero one is reported as a failure — never as a paste.
   *   3. THE STALE RESULT. The get direction deletes clip-read.txt first, so a
   *      task that did not run cannot be answered with yesterday's clipboard.
   *
   * The transport is INJECTED (this.options.sshRun / scpRun), so a test drives
   * this exact code against a stub and asserts the order instead of trusting a
   * comment.
   */
  const CLIP_DIR = 'C:\\ProgramData\\cua'
  const CLIP_TEXT_PATH = `${CLIP_DIR}\\clip.txt`
  const CLIP_READ_PATH = `${CLIP_DIR}\\clip-read.txt`
  const CLIP_SET_TASK = 'cua-clip-set'
  const CLIP_GET_TASK = 'cua-clip-get'
  /**
   * THE AGENT'S CONTRACT — one file it writes, one directory we write to, one
   * file it acknowledges in.
   *
   * The task path above works and stays as the fallback, but it is slow and
   * blind: `schtasks /run` queues, the body executes in the interactive
   * session, and the only completion channel is a `Last Result` poll that takes
   * seconds and cannot prove the CLIPBOARD content. The agent path is a file
   * drop with a digest ack: ~250 ms, and the answer says whether the bytes that
   * reached the clipboard are the bytes we sent.
   *
   * Everything lives under the same ProgramData directory the two tasks
   * already use — no new provisioning, and nothing in a user profile (SSH lands
   * in Session 0, the clipboard owner is the interactive session).
   */
  const CLIP_STATE_PATH = `${CLIP_DIR}\\clip-state.json`
  const CLIP_CURRENT_PATH = `${CLIP_DIR}\\clip-current.txt`
  const CLIP_OUTBOX_DIR = `${CLIP_DIR}\\outbox`
  const CLIP_ACK_PATH = `${CLIP_DIR}\\clip-ack.json`
  const CLIP_AGENT_TASK = 'cua-clip-agent'
  /** How old `clip-state.json` may be before the agent is presumed gone. */
  const CLIP_AGENT_STALE_MS = 5000
  /** A clipboard is small; anything larger is a caller mistake, not a paste. */
  const CLIP_MAX_BYTES = 1024 * 1024
  /**
   * J21-5c: THE AGENT REFUSES A JOB FILE, NOT A TEXT.
   *
   * The agent's own guard is on the JSON file it is handed (`clip-<seq>.json`,
   * ~110 bytes of wrapper around the text, plus JSON string escaping), so a
   * text that is legal for the TASK path at 1 MiB - 1 becomes a job the agent
   * drops as too-large — one wasted round trip and an `agent-error:too-large`
   * that looks like an agent bug. The outbox budget is therefore reduced by a
   * conservative wrapper allowance, and the EXACT serialized size is checked
   * after the job is built; either way a too-large job never leaves the host.
   */
  const CLIP_OUTBOX_WRAPPER_BUDGET = 2048
  const CLIP_OUTBOX_MAX_TEXT_BYTES = CLIP_MAX_BYTES - CLIP_OUTBOX_WRAPPER_BUDGET
  /**
   * J21-4: HOW MANY TIMES THE ACK AND THE READ-BACK ARE RE-READ.
   *
   * The agent writes `clip-ack.json` BEFORE it rewrites `clip-current.txt`, so
   * a single immediate read of the copy can catch the PREVIOUS payload while
   * the ack (and the clipboard) already hold ours: a false `readBackEqual:
   * false` on a paste that worked. Three reads, 250 ms apart, and the LAST
   * ack whose seq matches is the final word.
   */
  const CLIP_ACK_READ_ATTEMPTS = 3
  /** How long the get direction waits for the interactive task to write. */
  const clipSettleMs = () => Math.max(0, Number(process.env.DSH_CUA_WIN_CLIP_SETTLE_MS ?? 1500))
  const CLIP_POLL_MS = 250
  const CLIP_POLLS = 12
  /** The injected channel, or null: `null` is the DISABLED state, not a throw. */
  const clipTransport = () => transport

  function clipText(text) {
    // The text NEVER travels on a command line: batch-mode SSH runs cmd.exe as
    // the remote shell and a `;` `&` `|` or a quote in the payload would be
    // re-parsed there. It goes in a file, and the file is what the task reads.
    if (typeof text !== 'string') throw new Error('clipboardSet needs the text to paste')
    if (Buffer.byteLength(text, 'utf8') > CLIP_MAX_BYTES) {
      throw new Error(`the clipboard text is larger than ${CLIP_MAX_BYTES} bytes, which is a file transfer, not a paste (use cua_vm_put)`)
    }
    return text
  }

  /**
   * Run one on-demand task and wait until it reports a Last Result.
   *
   * `/query /fo LIST /v` carries `Status` (Running while the body executes) and
   * `Last Result` (the program's exit code). While an instance is still running
   * Last Result is the PREVIOUS run's code, so both are read: only "not running
   * AND has a code" is an answer.
   */
  async function runClipTask(spec, task, { timeoutMs = 20000 } = {}) {
    const t = clipTransport()
    if (t === null) return { ok: false, code: -1, detail: 'no SSH transport is wired into the Windows backend' }
    const started = await t.sshRun(spec, `schtasks /run /tn ${task}`, { timeoutMs: 15000 })
    // A non-zero /run means it never even queued: that is a real failure and it
    // must not be reported as a clipboard operation.
    if (started.code !== 0) {
      return {
        ok: false,
        code: started.code,
        detail: `schtasks /run /tn ${task} exited ${started.code}: ${(started.stderr || started.stdout || '').trim() || 'no output'}`
      }
    }
    const deadline = Date.now() + Math.max(1000, timeoutMs)
    let last = ''
    while (Date.now() < deadline) {
      const query = await t.sshRun(spec, `schtasks /query /tn ${task} /fo LIST /v`, { timeoutMs: 15000 })
      last = `${query.stdout || ''}\n${query.stderr || ''}`
      const result = /Last Result:\s*(-?\d+)/iu.exec(last)?.[1]
      const status = /Status:\s*([^\r\n]+)/iu.exec(last)?.[1]?.trim() ?? ''
      const running = /running/iu.test(status)
      if (!running && result !== undefined) {
        const code = Number(result)
        return { ok: code === 0, code, detail: code === 0 ? '' : `task ${task} exited ${code} (Last Result)` }
      }
      await new Promise((resolve) => setTimeout(resolve, CLIP_POLL_MS))
    }
    return { ok: false, code: -1, detail: `task ${task} did not report a Last Result within ${timeoutMs} ms (last status line: ${last.trim().split('\n').slice(-1)[0] || 'none'})` }
  }

  /* ------------------------- clipboard, agent-first ------------------------- */

  /** One guest file parsed as JSON, or null when absent/unreadable/not JSON. */
  function clipJson(text) {
    try {
      const parsed = JSON.parse(String(text ?? '').replace(/^\uFEFF/u, '').trim())
      return parsed !== null && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * ONE sshRun for the whole liveness question.
   *
   * `type clip-state.json` is a single round trip, and its failure IS the
   * answer: no agent. The age test is symmetric on purpose — a freshly booted
   * Windows VM's clock can be a few seconds AHEAD of the host before w32time
   * settles, and a one-sided `now - ts <= 5000` would then call a live agent
   * stale and silently take the slow path forever.
   */
  async function readClipState(spec, t) {
    const answer = await t.sshRun(spec, `type "${CLIP_STATE_PATH}"`, { timeoutMs: 15000 })
    if (answer?.code !== 0) return null
    const state = clipJson(answer.stdout)
    if (state === null) return null
    // J21-1a: THE AGENT HAS SHIPPED THREE SPELLINGS OF ITS CLOCK. `at` is what
    // the shipped cua-clip-agent.ps1 writes; `ts` is what an earlier build and
    // this backend's own test stubs write; `updatedAt` is the JSON-idiomatic
    // name. Reading only `ts` meant a live agent evaluated as age 0 → Infinity
    // → "stale", and the fast path never ran. A missing stamp is 0 on purpose:
    // the caller then reports `agent-stale` (the honest answer) instead of
    // inventing freshness from `undefined`.
    let stamp = 0
    for (const key of ['at', 'ts', 'updatedAt']) {
      const value = Number(state[key])
      if (Number.isFinite(value) && value > 0) { stamp = value; break }
    }
    const ageMs = stamp > 0 ? Date.now() - stamp : Number.POSITIVE_INFINITY
    return { ...state, stamp, stampMissing: stamp === 0, ageMs, fresh: Math.abs(ageMs) <= CLIP_AGENT_STALE_MS }
  }

  /**
   * THE FAST PATH: drop a job in the outbox, wait for the agent's ack.
   *
   * ORDER IS THE CONTRACT, and it has three steps that each prevent a specific
   * lie:
   *
   *   1. DELETE THE OLD ACK FIRST. An ack from the previous sequence that
   *      survives into this one would answer "equal: true" for a write the agent
   *      never saw — the same class of bug as the stale `clip-read.txt`.
   *   2. THE JOB CARRIES ITS OWN DIGEST. The agent hashes what it put on the
   *      clipboard and echoes `equal`; we compare against the digest WE
   *      computed, so a textEncoding/base64 accident is caught at the agent, not
   *      reported as a paste.
   *   3. THE READ-BACK. `clip-current.txt` is what the agent says is on the
   *      clipboard; hashing it is the only end-to-end proof, and `readBackEqual`
   *      reports it rather than folding it into `ok`.
   */
  async function clipSetViaAgent(spec, t, payload) {
    // J21-5c: FAIL FAST, BEFORE ANY ROUND TRIP. The agent's limit is the job
    // FILE, not the text, so the outbox budget is the file limit minus the
    // wrapper allowance. Asking the guest to read a job it will reject is a
    // round trip that can only end in `agent-error:too-large`.
    const textBytes = Buffer.byteLength(payload, 'utf8')
    if (textBytes > CLIP_OUTBOX_MAX_TEXT_BYTES) {
      return {
        ok: false,
        reason: 'too-large',
        bytes: textBytes,
        limit: CLIP_OUTBOX_MAX_TEXT_BYTES,
        detail: `the text is ${textBytes} bytes; the clipboard agent accepts at most ${CLIP_OUTBOX_MAX_TEXT_BYTES} bytes in a job file (${CLIP_MAX_BYTES} bytes minus a ${CLIP_OUTBOX_WRAPPER_BUDGET}-byte wrapper)`
      }
    }
    const state = await readClipState(spec, t)
    if (state === null) return { ok: false, reason: 'no-agent' }
    if (state.fresh !== true) return { ok: false, reason: 'agent-stale', ageMs: state.ageMs, stampMissing: state.stampMissing === true, seq: Number(state.seq ?? 0) }
    const seq = Date.now()
    const digest = clipSha256(payload)
    const job = JSON.stringify({ seq, sha256: digest, text: payload })
    // THE EXACT SERIALIZED SIZE, because escaping is not linear: a text of
    // quotes/backslashes/controls inflates well beyond the wrapper allowance.
    const jobBytes = Buffer.byteLength(job, 'utf8')
    if (jobBytes > CLIP_MAX_BYTES) {
      return {
        ok: false,
        reason: 'too-large',
        bytes: textBytes,
        jobBytes,
        limit: CLIP_MAX_BYTES,
        detail: `the job file would be ${jobBytes} bytes, over the agent's ${CLIP_MAX_BYTES}-byte limit; the text encodes larger than it looks (use cua_vm_put)`
      }
    }
    const cleared = await t.sshRun(spec, `if exist "${CLIP_ACK_PATH}" del /f /q "${CLIP_ACK_PATH}"`, { timeoutMs: 15000 })
    if (cleared?.code !== 0) return { ok: false, reason: 'ssh', detail: `could not clear ${CLIP_ACK_PATH}: exit ${cleared?.code}` }
    const made = await t.sshRun(spec, `if not exist "${CLIP_OUTBOX_DIR}" mkdir "${CLIP_OUTBOX_DIR}"`, { timeoutMs: 15000 })
    if (made?.code !== 0) return { ok: false, reason: 'ssh', detail: `could not create ${CLIP_OUTBOX_DIR}: exit ${made?.code}` }
    const jobPath = `${CLIP_OUTBOX_DIR}\\clip-${seq}.json`
    const uploaded = await t.putText(spec, jobPath, job)
    if (uploaded?.code !== 0) {
      return { ok: false, reason: 'upload', path: jobPath, detail: `the text did not reach ${jobPath}: ${(uploaded?.stderr || '').trim() || `exit ${uploaded?.code}`}`, code: uploaded?.code }
    }
    let ack = null
    for (let attempt = 0; attempt < CLIP_POLLS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, CLIP_POLL_MS))
      const answer = await t.sshRun(spec, `type "${CLIP_ACK_PATH}"`, { timeoutMs: 15000 })
      if (answer?.code !== 0) continue
      ack = clipJson(answer.stdout)
      if (ack !== null && Number(ack.seq ?? 0) === seq) break
    }
    if (ack === null || Number(ack.seq ?? 0) !== seq) return { ok: false, reason: 'ack-timeout', seq, sha256: digest }
    let verdict = clipAckVerdict({ seq, sha256: digest }, ack)
    if (!verdict.ok) return { ok: false, reason: verdict.reason, detail: verdict.detail, seq, sha256: digest, ack }
    let readBackEqual = false
    if (typeof t.getText === 'function') {
      // J21-4: THE READ-BACK IS RETRIED, THE VERDICT IS NOT RUSHED. The agent
      // acking BEFORE it rewrites clip-current.txt means one immediate read can
      // describe the PREVIOUS payload on a paste that already worked. Re-read
      // both, up to CLIP_ACK_READ_ATTEMPTS times, and keep the LAST ack whose
      // seq matches: a newer matching ack is the agent's final word, while a
      // lagging clip-current.txt only costs another 250 ms.
      for (let round = 0; round < CLIP_ACK_READ_ATTEMPTS; round += 1) {
        if (round > 0) {
          await new Promise((resolve) => setTimeout(resolve, CLIP_POLL_MS))
          const again = await t.sshRun(spec, `type "${CLIP_ACK_PATH}"`, { timeoutMs: 15000 })
          if (again?.code === 0) {
            const next = clipJson(again.stdout)
            if (next !== null && Number(next.seq ?? 0) === seq) {
              ack = next
              verdict = clipAckVerdict({ seq, sha256: digest }, ack)
              // A NEW matching ack that reports a failure wins over the older
              // success: the agent's last statement about this seq is the one
              // that describes the clipboard.
              if (!verdict.ok) return { ok: false, reason: verdict.reason, detail: verdict.detail, seq, sha256: digest, ack }
            }
          }
        }
        const readBack = await t.getText(spec, CLIP_CURRENT_PATH)
        readBackEqual = readBack?.code === 0 && clipSha256(String(readBack.text ?? '')) === digest
        if (readBackEqual) break
      }
    }
    return { ok: true, verified: ack.equal === true, seq, sha256: digest, readBackEqual, via: 'agent', path: jobPath, task: CLIP_AGENT_TASK }
  }

  /**
   * THE READ DIRECTION, AGENT-FIRST.
   *
   * Two reads, because the agent's state is the INDEX and `clip-current.txt` is
   * the CONTENT: the state names the digest of what the agent last put on the
   * clipboard, so hashing the file against it is a real verification rather than
   * a hope. Both are single SSH round trips, so the slow path is only taken when
   * the agent is genuinely absent (an older guest, a failed firstboot).
   */
  async function clipGetViaAgent(spec, t) {
    const state = await readClipState(spec, t)
    if (typeof t.getText !== 'function') return { ok: false, reason: 'no-agent' }
    const current = await t.getText(spec, CLIP_CURRENT_PATH)
    if (current?.code !== 0) {
      return { ok: false, reason: state === null ? 'no-agent' : 'agent-stale', ageMs: state?.ageMs }
    }
    const text = String(current.text ?? '')
    const digest = clipSha256(text)
    const expected = state !== null && typeof state.sha256 === 'string' ? state.sha256 : ''
    return {
      ok: true,
      verified: expected !== '' && expected === digest,
      seq: Number(state?.seq ?? 0),
      sha256: digest,
      text,
      via: 'agent',
      state: state === null ? 'absent' : state.fresh === true ? 'fresh' : 'stale'
    }
  }

  /**
   * PASTE `text` INTO THE GUEST'S CLIPBOARD (session 2).
   *
   * AGENT FIRST, TASK SECOND. The agent path is ~250 ms and verified end to end;
   * the task path is the ORIGINAL contract (the file exists BEFORE the task
   * runs, and the task's Last Result is the exit code) and stays as the fallback
   * for a guest where the agent is not running — an older install, a firstboot
   * that failed after OpenSSH came up, or the operator's own image.
   *
   * A decline is REPORTED (`fastPathReason`), never absorbed: "pasted, slowly"
   * and "pasted, verified" are different facts about the guest, and hiding which
   * one happened is how a broken agent stays unnoticed for months.
   */
  async function clipboardSet(rawSpec, text) {
    const spec = namedSpec(rawSpec)
    const t = clipTransport()
    if (t === null) {
      return { ok: false, reason: 'no-ssh', detail: 'clipboardSet needs the guest SSH transport, which is not wired into this backend' }
    }
    const payload = clipText(text)
    let fast = { ok: false, reason: 'no-agent' }
    try {
      fast = await clipSetViaAgent(spec, t, payload)
    } catch (error) {
      fast = { ok: false, reason: 'ssh', detail: String(error?.message ?? error) }
    }
    if (fast.ok === true) {
      const bytes = Buffer.byteLength(payload, 'utf8')
      return {
        ...fast,
        bytes,
        detail: `${bytes} byte(s) are on the guest clipboard (${CLIP_AGENT_TASK} acknowledged seq ${fast.seq}${fast.readBackEqual ? ', read back equal' : ''})`
      }
    }
    // ---- the task fallback: unchanged order, unchanged guarantees ----
    const made = await t.sshRun(spec, `if not exist "${CLIP_DIR}" mkdir "${CLIP_DIR}"`, { timeoutMs: 15000 })
    if (made.code !== 0) {
      return { ok: false, reason: 'ssh', fastPathReason: fast.reason, detail: `could not create ${CLIP_DIR} over SSH: exit ${made.code} ${(made.stderr || '').trim()}`, code: made.code }
    }
    const uploaded = await t.putText(spec, CLIP_TEXT_PATH, payload)
    if (uploaded?.code !== 0) {
      return { ok: false, reason: 'upload', fastPathReason: fast.reason, path: CLIP_TEXT_PATH, detail: `the text did not reach ${CLIP_TEXT_PATH}: ${(uploaded?.stderr || '').trim() || `exit ${uploaded?.code}`}`, code: uploaded?.code }
    }
    const ran = await runClipTask(spec, CLIP_SET_TASK)
    if (!ran.ok) {
      return { ok: false, reason: 'task', fastPathReason: fast.reason, path: CLIP_TEXT_PATH, task: CLIP_SET_TASK, detail: ran.detail, code: ran.code }
    }
    const bytes = Buffer.byteLength(payload, 'utf8')
    const base = `${bytes} byte(s) are on the guest clipboard (${CLIP_SET_TASK} ran in the interactive session${fast.reason === 'no-agent' ? '; the fast-path agent is not running' : `; fast path declined: ${fast.reason}`})`
    // J21-6: A NUL IN THE TEXT IS A TRUNCATION, NOT A PASTE. The Windows
    // clipboard (and every consumer that reads it as a C string) stops at the
    // first U+0000, so reporting `ok: true` alone would claim bytes that never
    // landed. The paste DID happen — the prefix is on the clipboard — so the
    // result stays ok, but it is explicitly unverified and says how much
    // survived.
    const nulIndex = payload.indexOf('\u0000')
    if (nulIndex !== -1) {
      const landed = Array.from(payload.slice(0, nulIndex)).length
      const total = Array.from(payload).length
      return {
        ok: true,
        verified: false,
        task: CLIP_SET_TASK,
        path: CLIP_TEXT_PATH,
        via: 'task',
        fastPathReason: fast.reason,
        bytes,
        nulTruncated: { landed, total },
        detail: `${base}; the text contains NUL characters; the guest clipboard stops at the first NUL (${landed} of ${total} characters landed)`
      }
    }
    return {
      ok: true,
      verified: false,
      task: CLIP_SET_TASK,
      path: CLIP_TEXT_PATH,
      via: 'task',
      fastPathReason: fast.reason,
      bytes,
      detail: base
    }
  }

  /**
   * READ THE GUEST'S CLIPBOARD (session 2).
   *
   * The agent path proves WHAT it read: the state file names the digest the agent
   * last placed on the clipboard, so hashing `clip-current.txt` either matches
   * it or says `verified: false` — the first honest answer this direction has
   * ever been able to give. The task fallback keeps its stale-result discipline:
   * clip-read.txt is deleted before the task runs, so a task that did not run
   * cannot answer with yesterday's clipboard.
   */
  async function clipboardGet(rawSpec) {
    const spec = namedSpec(rawSpec)
    const t = clipTransport()
    if (t === null) {
      return { ok: false, reason: 'no-ssh', detail: 'clipboardGet needs the guest SSH transport, which is not wired into this backend' }
    }
    let fast = { ok: false, reason: 'no-agent' }
    try {
      fast = await clipGetViaAgent(spec, t)
    } catch (error) {
      fast = { ok: false, reason: 'ssh', detail: String(error?.message ?? error) }
    }
    if (fast.ok === true) {
      return {
        ...fast,
        detail: `read from the guest clipboard (${fast.verified ? 'digest verified against the agent state' : 'the agent state does not describe these bytes'})`
      }
    }
    // ---- the task fallback ----
    const cleared = await t.sshRun(spec, `if exist "${CLIP_READ_PATH}" del /f /q "${CLIP_READ_PATH}"`, { timeoutMs: 15000 })
    if (cleared.code !== 0) {
      return { ok: false, reason: 'ssh', fastPathReason: fast.reason, detail: `could not clear ${CLIP_READ_PATH}: exit ${cleared.code} ${(cleared.stderr || '').trim()}`, code: cleared.code }
    }
    const ran = await runClipTask(spec, CLIP_GET_TASK)
    if (!ran.ok) return { ok: false, reason: 'task', fastPathReason: fast.reason, task: CLIP_GET_TASK, detail: ran.detail, code: ran.code }
    const settle = clipSettleMs()
    if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle))
    let fetched = null
    for (let attempt = 0; attempt < CLIP_POLLS; attempt += 1) {
      fetched = await t.getText(spec, CLIP_READ_PATH)
      if (fetched?.code === 0) break
      await new Promise((resolve) => setTimeout(resolve, CLIP_POLL_MS))
    }
    if (fetched?.code !== 0) {
      // A task that reported 0 but produced no file is a REAL failure: saying
      // "empty clipboard" here would be the same lie as the RFB path.
      return { ok: false, reason: 'missing', fastPathReason: fast.reason, task: CLIP_GET_TASK, detail: `task ${CLIP_GET_TASK} reported success but ${CLIP_READ_PATH} is not readable: ${(fetched?.stderr || '').trim() || `exit ${fetched?.code}`}`, code: fetched?.code }
    }
    const text = String(fetched.text ?? '')
    return { ok: true, verified: false, task: CLIP_GET_TASK, path: CLIP_READ_PATH, via: 'task', fastPathReason: fast.reason, text, sha256: clipSha256(text), detail: 'read from the guest clipboard (the interactive session)' }
  }

  /** Kill the process (last resort, after `shutdown` refused to exit). */
  function kill(target) {
    const name = windowsRowName(target)
    const child = children.get(`qemu:${name}`)
    children.delete(`qemu:${name}`)
    try { child?.kill('SIGKILL') } catch {}
    const pid = qemuPid(name)
    if (pidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
    stopSwtpm(name)
  }

  /**
   * FORCE KILL: the escape hatch behind "Force delete".
   *
   * A stuck install can leave a QEMU whose row is `installing` and whose pid
   * file is the ONLY handle on the process (the supervisor may have been
   * restarted, so `children` is empty). `kill()` sends the signal but cannot
   * say whether it worked — and the delete manifest MUST be able to say so,
   * because it decides whether the disk may be unlinked.
   *
   * So this waits, re-reads the pid file (QEMU may rewrite it) and reports the
   * truth: `qemuGone` / `swtpmGone` after `waitMs`. It never throws: a pid that
   * vanished between the two `process.kill` calls is `gone`, not a failure.
   */
  async function forceKill(target, { waitMs = 3000 } = {}) {
    const name = windowsRowName(target)
    const firstPid = qemuPid(name)
    kill(name)
    const deadline = Date.now() + Math.max(200, Number(waitMs) || 3000)
    let pid = firstPid
    while (Date.now() < deadline) {
      // The child we spawned is reaped asynchronously; the pid file is the
      // durable answer, and it may have been rewritten by a late QEMU start.
      const fromFile = qemuPid(name)
      if (fromFile > 0 && fromFile !== pid && pidAlive(fromFile)) {
        pid = fromFile
        try { process.kill(fromFile, 'SIGKILL') } catch {}
      }
      if (!pidAlive(pid) && !pidAlive(fromFile)) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const finalPid = qemuPid(name) || pid
    const swtpmPid = (() => {
      try {
        const value = Number(readFileSync(pathsFor(name).tpmPid, 'utf8').trim())
        return Number.isFinite(value) && value > 0 ? value : 0
      } catch {
        return 0
      }
    })()
    return {
      pid: finalPid,
      qemuGone: !pidAlive(finalPid),
      swtpmPid,
      swtpmGone: !pidAlive(swtpmPid),
      detail: !pidAlive(finalPid)
        ? `QEMU (pid ${finalPid || 'none'}) is gone, swtpm is ${pidAlive(swtpmPid) ? `STILL RUNNING (pid ${swtpmPid})` : 'stopped'}`
        : `QEMU (pid ${finalPid}) is STILL RUNNING after SIGKILL`
    }
  }

  /**
   * D2: EJECT THE INSTALL MEDIA FROM THE RUNNING SESSION.
   *
   * The argv for an INSTALL boot carries the Microsoft ISO (`cd0`) and the
   * answer medium (`setup0` behind usb-storage) because Setup needs both. That
   * QEMU process keeps running after Setup finishes — it is the same process
   * that boots the installed disk — so a freshly ready computer still listed the
   * Windows DVD and the SETUP volume (D:) in Explorer, and its next reboot could
   * boot the DVD again. The user's report (D2) asked for both to go away once the
   * install is done.
   *
   * The supervisor calls this at the READY transition (not at "the disk booted" —
   * the firstboot fallback layer may still want the medium at first logon).
   *
   * WHY QMP AND NOT A RESTART: a restart just to change the device list throws
   * away the booted desktop the user is looking at. `eject` opens the DVD tray
   * (the guest sees the medium go away), and `device_del` unplugs the USB stick
   * (usb-storage is hot-unpluggable). The block nodes stay allocated but with no
   * frontend — nothing presents them to the guest.
   *
   * NON-FATAL BY CONTRACT: an already-ejected tray, a QEMU that does not answer,
   * a device id the running argv never had (an older row started before the id
   * was added) — none of these may fail the transition to ready. Everything is
   * attempted, everything is logged, and the result says what happened.
   */
  async function detachInstallMedia(rawSpec) {
    const spec = namedSpec(rawSpec)
    const result = { attempted: [], commands: [], errors: [], skipped: [] }
    // QUERY FIRST: it tells an already-detached session apart from one that
    // needs the work, so a second call is silent instead of a wall of
    // DeviceNotFound errors.
    let blocks = []
    try {
      const answer = await qmpFor(spec, [{ execute: 'query-block' }], { timeoutMs: 5000 })
      if (Array.isArray(answer) && Array.isArray(answer[0]?.return)) blocks = answer[0].return
    } catch (error) {
      // No QMP is not a reason to skip the attempts: an older QMP may not
      // answer query-block, and the eject/device_del below are what actually
      // matter.
      result.errors.push({ command: 'query-block', error: String(error?.message ?? error) })
    }
    const present = (name) => blocks.some((entry) => entry?.device === name || entry?.qdev === name)
    const plan = []
    if (blocks.length === 0 || present(INSTALL_MEDIA_DEVICE_IDS.cd)) {
      plan.push({ execute: 'eject', arguments: { device: INSTALL_MEDIA_DEVICE_IDS.cd, force: true } })
    } else {
      result.skipped.push(INSTALL_MEDIA_DEVICE_IDS.cd)
    }
    if (blocks.length === 0 || present(INSTALL_MEDIA_DEVICE_IDS.setup) || present(INSTALL_MEDIA_DEVICE_IDS.setupDevice)) {
      // THE QDEV ID: `device_del` addresses the frontend by its QOM id, which is
      // why buildQemuArgs() names it (`id=setupusb`). Fall back to the constant
      // for a session started before that id existed; QMP answers
      // DeviceNotFound and the row keeps working.
      const qdev = blocks.find((entry) => entry?.device === INSTALL_MEDIA_DEVICE_IDS.setup && typeof entry?.qdev === 'string' && entry.qdev !== '')?.qdev
      plan.push({ execute: 'device_del', arguments: { id: qdev || INSTALL_MEDIA_DEVICE_IDS.setupDevice } })
    } else {
      result.skipped.push(INSTALL_MEDIA_DEVICE_IDS.setup)
    }
    for (const command of plan) {
      result.attempted.push(command)
      try {
        await qmpFor(spec, [command], { timeoutMs: 5000 })
        result.commands.push(command)
      } catch (error) {
        result.errors.push({ command: command.execute, error: String(error?.message ?? error) })
      }
    }
    const failed = result.errors.filter((entry) => entry.command !== 'query-block')
    if (failed.length > 0) {
      log(`windows: ${spec.name} could not detach every install medium (non-fatal): ${failed.map((entry) => `${entry.command}: ${entry.error}`).join('; ')}`)
    } else if (result.commands.length > 0) {
      log(`windows: ${spec.name} install media detached (${result.commands.map((command) => command.execute).join(', ')})`)
    }
    return result
  }

  return {
    enabled: windowsEnabled,
    hostCaps: windowsHostCaps,
    paths: pathsFor,
    portsFor,
    qemuPid,
    pidAlive,
    childState,
    boot,
    probe,
    ready,
    qmpFor,
    screenshot,
    click,
    move,
    drag,
    sendKeys,
    pause,
    unpause,
    shutdown,
    installShutdownWindowMs,
    detachInstallMedia,
    kill,
    forceKill,
    stopSwtpm,
    clipboardSet,
    clipboardGet
  }
}

/* ------------------------------------------------------------------ *
 * TCP banner probe (readiness, zero dependencies)
 * ------------------------------------------------------------------ */

/** The first bytes a service says, or null when nothing answers. */
export async function bannerProbe(host, port, { timeoutMs = 1500, readBytes = 32 } = {}) {
  const net = await import('node:net')
  return new Promise((resolve) => {
    const socket = net.connect(port, host)
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      try { socket.destroy() } catch {}
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => {
      // SSH speaks first; VNC's server also speaks first. Read the banner.
      socket.once('data', (chunk) => finish(chunk.subarray(0, readBytes).toString('latin1')))
    })
    socket.on('timeout', () => finish(null))
    socket.on('error', () => finish(null))
  })
}

/* ------------------------------------------------------------------ *
 * Keyboard mapping (ASCII only — a physical keyboard has no key for "é")
 * ------------------------------------------------------------------ */

const QCODE_PUNCT = {
  ' ': 'spc', '-': 'minus', '=': 'equal', '[': 'bracket_left', ']': 'bracket_right',
  '\\': 'backslash', ';': 'semicolon', "'": 'apostrophe', '`': 'grave_accent',
  ',': 'comma', '.': 'dot', '/': 'slash', '\n': 'ret', '\t': 'tab'
}

const QCODE_SHIFT = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8',
  '(': '9', ')': '0', '_': 'minus', '+': 'equal', '{': 'bracket_left', '}': 'bracket_right',
  '|': 'backslash', ':': 'semicolon', '"': 'apostrophe', '~': 'grave_accent',
  '<': 'comma', '>': 'dot', '?': 'slash'
}

const NAMED_KEYS = {
  enter: 'ret', return: 'ret', tab: 'tab', escape: 'esc', esc: 'esc', space: 'spc',
  backspace: 'backspace', delete: 'delete', del: 'delete', insert: 'insert',
  up: 'up', down: 'down', left: 'left', right: 'right',
  home: 'home', end: 'end', pageup: 'pgup', pagedown: 'pgdn',
  f1: 'f1', f2: 'f2', f3: 'f3', f4: 'f4', f5: 'f5', f6: 'f6',
  f7: 'f7', f8: 'f8', f9: 'f9', f10: 'f10', f11: 'f11', f12: 'f12'
}

export function charToKey(char) {
  if (Object.prototype.hasOwnProperty.call(QCODE_SHIFT, char)) return { qcode: QCODE_SHIFT[char], shift: true }
  if (Object.prototype.hasOwnProperty.call(QCODE_PUNCT, char)) return { qcode: QCODE_PUNCT[char], shift: false }
  if (/^[a-z0-9]$/u.test(char)) return { qcode: char, shift: false }
  if (/^[A-Z]$/u.test(char)) return { qcode: char.toLowerCase(), shift: true }
  return null
}

export function parseKeySpec(spec) {
  const text = String(spec ?? '').trim()
  if (text === '') throw new Error('key is required')
  const parts = text.split('+').filter((part) => part !== '')
  const base = parts.pop() ?? ''
  const modifiers = parts.map((part) => part.toLowerCase())
  const named = NAMED_KEYS[base.toLowerCase()]
  const character = named ? null : (base.length === 1 ? charToKey(base) : null)
  if (named === undefined && character === null) {
    throw new Error(`unsupported key for a Windows computer: ${spec} (ASCII keys and ${Object.keys(NAMED_KEYS).join('/')} only)`)
  }
  return {
    qcode: named ?? character.qcode,
    shift: character?.shift === true,
    ctrl: modifiers.includes('ctrl') || modifiers.includes('control'),
    alt: modifiers.includes('alt'),
    shiftModifier: modifiers.includes('shift')
  }
}

/** A generated Windows password: url/shell-safe, 20 chars, ~118 bits. */
export function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_'
  return Array.from(randomBytes(20), (byte) => alphabet[byte % alphabet.length]).join('')
}

/** The frame's own size: a QMP screendump IS the display, so scale is always 1. */
export function frameSpace(png) {
  const size = pngSize(png) ?? { width: 0, height: 0 }
  return {
    display: { width: size.width, height: size.height },
    screenshot: { width: size.width, height: size.height },
    scale: 1,
    source: 'qmp'
  }
}
