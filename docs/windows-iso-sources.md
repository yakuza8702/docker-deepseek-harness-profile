# Windows ISO sources — sixteen codes, one ordered chain each

This is the reference for **where a Windows install medium comes from** in this
image, per code, with the exact URL, byte count and SHA-256 the build checks. It
is generated from `docker/cua-vm-windows-qemu.mjs` (`WINDOWS_VERSIONS`,
`WINDOWS_CATALOG`, `ISO_SOURCE_CHAINS`, `WINDOWS_ISO_SOURCES`) and **enforced**
by the `J1-6` assertion in [`tools/check-cua-vm.mjs`](../tools/check-cua-vm.mjs):
that gate imports `WINDOWS_ISO_SOURCES` (whose `sources` array IS
`ISO_SOURCE_CHAINS`), parses every table below, and compares all five columns —
`strategy`, `url`, `bytes`, `sha256`, `selection` — row by row, failing with the
first divergent code and field (for example `code 11l row 2 sha256`). A hand
edit here cannot pass the gate, so this page and the module cannot disagree.

**Why it changed.** The five-version list pinned ONE Microsoft CDN object per
version. On 2026-11-15 four of the five answered **HTTP 400**: the evaluation
media had moved behind a session-token page. A single pinned URL that 400s is
worse than no pin at all — the first create of that version dies inside a 5.5 GB
download, after the quota has already been reserved. A version is now an
**ordered chain**, tried in order, each attempt cheap and each failure named.

## The strategies

| strategy | what it is | notes |
|---|---|---|
| `mido` | Microsoft's own **live** download page, driven by the four calls its own JavaScript makes: `vlscppe.microsoft.com/tags` → `ov-df.microsoft.com/mdt.js?instanceId=…` → `ov-df.microsoft.com/?…` → `software-download-connector/api/getskuinformationbyproductedition` → `software-download-connector/api/GetProductDownloadLinksBySku` | the only strategy that yields an official, current URL. Constants: `MIDO_PROFILE=606624d44113`, `MIDO_ORG_ID=y6jn8c31`, `MIDO_INSTANCE=560dc9f3…`. Only `11` and `10` still publish a page this code can drive |
| `esd` | the ESD catalog CAB behind `go.microsoft.com/fwlink?linkid=2156292` (Windows 11) and `go.microsoft.com/fwlink/?LinkId=841361` (Windows 10) | read **only** when `7z`/`7za`/`cabextract` is already in `PATH`; otherwise the entry reports `skipped: no cab extractor` and the chain continues. Nothing is installed into the image to read a catalog |
| `link1` / `link2` / `link6` | pinned mirrors: `dl.bobpony.com/windows/…`, `files.dog/MSDN/…`, `archive.org/download/…` | last, and pinned with **bytes + SHA-256**, so "somebody else's copy" is still the exact bytes this build expects |
| `midoDirect` | the static `software-static.download.prss.microsoft.com` / `software-download.microsoft.com` object the page resolves to | used when the live handshake fails but the object is known |

## How a download is verified

1. the server's `Content-Length` is compared with the pinned `bytes` **before** the
   body is written (an entry with `bytes: 0` has no size to check and skips it);
2. the body is hashed while it streams; the result is compared with `sha256`
   (`''` skips it);
3. a mismatch throws `code: iso-digest-mismatch` — "do not boot this" is not a
   boolean a caller may ignore;
4. a verified download writes a `<name>.sha256` **sidecar**; a later boot trusts
   the sidecar (no second 5.5 GB hash), but a sidecar that disagrees with the pin,
   or a size that does not match, makes the file NOT a cache and it is fetched
   again;
5. `DSH_CUA_WIN_ISO_SHA256=0` disables (2)–(4). It is faster and it gives up the
   only evidence that the media is the one that was asked for.

The cache file name is a **function of the URL**:
`<basename>-<sha1(url)[:8]>.iso` (`isoFileName`). It used to append random bytes,
so the quota reservation and the actual write named different paths and every
restart downloaded a second copy.

## Selections

`selection` is the `<InstallFrom><MetaData>` the answer file writes. `/IMAGE/INDEX`
is coarser but cannot be misspelled; `/IMAGE/NAME` is exact and fails the install
with "the image is not found" if it does not match the media — `verified: true`
means the value was READ from that ISO's own `sources/install.wim`, not guessed.
The catalog's selection is the default; a chain entry may pin its own (a mirror
that serves `SERVERSTANDARD` says so), and the caller can override with
`windowsImageIndex` / `windowsImageName`.

## Upstream credit

The strategy vocabulary (`mido`, `esd`, the fwlink ids, the product ids) and the
mirror set follow **dockur/windows** (`github.com/dockur/windows`, MIT), which is
where this media-resolution approach was worked out. This module does not vendor
or run their image — the guest installs from the per-code chain above on direct
QEMU (a live Microsoft page for `11`/`10`, a pinned object for every other code)
— but the "ask Microsoft's own page, then fall back to a pinned mirror" idea is
theirs, and their `assets/` catalogue is what the tiny11/tiny10 archive.org
coordinates and the 7z/cabextract feature detection are modelled on.

---

## What the create does with that chain

The chain above is not decoration: `cua_vm_create` walks it. This changed in
0.2.3, and it is the difference between "the chain's declared order is honoured"
and "the first static mirror is the only thing ever tried".

**What "live" applies to, precisely.** Only `11` and `10` have a Microsoft
product page this code can drive (`MIDO_PRODUCTS` has exactly those two keys), so
only they re-resolve Microsoft's newest release on every create. `11e`/`10e`
start at the ESD catalog, `11l` and `2025`–`2012` at their pinned `midoDirect`
object (a fixed Microsoft CDN build), and `7u`/`core11`/`tiny11`/`tiny10` at the
mirrors they have — no live Microsoft source exists for those.

| what the create does | before this release | now |
|---|---|---|
| version path | `resolveWindowsIso()` → the first **static** URL (`dl.bobpony.com` for `11`) | `ensureIsoForSource(resolveWindowsIsoSources(code))` → the chain's declared order (live `mido` for `11`/`10`; the pinned `midoDirect`/`esd`/mirror entry for every other code) |
| on every recreate | the same pinned mirror forever | for `11`/`10` it re-resolves Microsoft's page (`productEditionId` is read **live**), so a new release is picked up; the other codes re-walk their pinned chain |
| explicit `windowsIso` | one URL | **unchanged** — a named URL is a pin, recorded as `isoMedia: "pinned"` |
| provenance | a log line | the row records `isoSourceId` (`mido` / `esd` / `link1` / …), `isoMedia` and `isoResolvedAt` |
| switch | — | `DSH_CUA_WINDOWS_ISO_MIDO=0` restores the static-only order |

`resolveWindowsIso()` is still called first on the version path, so the refusal a
code like `xp` gets, and the quota sizing for the download, are unchanged: the
gate stayed, only the download moved. A medium delivered by the chain is
referenced by its computer's row, and `cua_vm_gc` prunes it once that row is gone
and the retention window has passed.

# The codes

Every row below is one entry of `ISO_SOURCE_CHAINS`, in the order it is tried.
`—` means "not known", never "any": an unknown size or digest only skips that one
assertion.

### `11` — Windows 11 Pro

* firmware **ovmf**, 7.9 GB virtual disk, catalog selection /IMAGE/INDEX `1`

| strategy | URL | bytes | sha256 | selection |
|---|---|---|---|---|
| mido | (live handshake: live Microsoft page (ProductEditionId 3321, /en-us/software-download/windows11)) | — | — | catalog default |
| esd | https://go.microsoft.com/fwlink?linkid=2156292 | — | — | catalog default |
| link1 | https://dl.bobpony.com/windows/11/en-us_windows_11_25h2_x64.iso | 6927149056 | `f5ffe9313eebc6299fba9e6eeb2971007264e6c6be013073a89b5ae9bd85bfb3` | catalog default |
| link6 | https://archive.org/download/W11x64_26200.6584/26200.6584.250915-1905.25h2_ge_release_svc_refresh_CLIENT_CONSUMER_x64FRE_en-us.iso | 7736125440 | `d141f6030fed50f75e2b03e1eb2e53646c4b21e5386047cb860af5223f102a32` | catalog default |
| midoDirect | https://software-static.download.prss.microsoft.com/dbazure/888969d5-f34g-4e03-ac9d-1f9786c66749/26200.6584.250915-1905.25h2_ge_release_svc_refresh_CLIENT_CONSUMER_x64FRE_en-us.iso | 7736125440 | `d141f6030fed50f75e2b03e1eb2e53646c4b21e5386047cb860af5223f102a32` | catalog default |

### `11l` — Windows 11 LTSC

* firmware **ovmf**, 4.7 GB virtual disk, catalog selection /IMAGE/NAME `Windows 11 IoT Enterprise LTSC 2024 Evaluation` (verified)

| strategy | URL | bytes | sha256 | selection |
|---|---|---|---|---|
| midoDirect | https://software-static.download.prss.microsoft.com/dbazure/998969d5-f34g-4e03-ac9d-1f9786c66749/26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_IOT_LTSC_EVAL_x64FRE_en-us.iso | 5060020224 | `2cee70bd183df42b92a2e0da08cc2bb7a2a9ce3a3841955a012c0f77aeb3cb29` | /IMAGE/NAME `Windows 11 IoT Enterprise LTSC 2024 Evaluation` |
| midoDirect | https://software-static.download.prss.microsoft.com/dbazure/888969d5-f34g-4e03-ac9d-1f9786c66749/26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_LTSC_EVAL_x64FRE_en-us.iso | 5112850432 | `67cec5865eaa037a72ddc633a717a10a2bed50778862267223ddb9c60ef5da68` | /IMAGE/NAME `Windows 11 Enterprise LTSC 2024 Evaluation` |
| link1 | https://dl.bobpony.com/windows/11/X23-81951_26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_ENTERPRISES_OEM_x64FRE_en-us.iso | 5144817664 | `4f59662a96fc1da48c1b415d6c369d08af55ddd64e8f1c84e0166d9e50405d7a` | /IMAGE/INDEX `1` |
| link6 | https://archive.org/download/Windows11LTSC/X23-81951_26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_ENTERPRISES_OEM_x64FRE_en-us.iso | 5144817664 | `4f59662a96fc1da48c1b415d6c369d08af55ddd64e8f1c84e0166d9e50405d7a` | /IMAGE/INDEX `1` |

### `11e` — Windows 11 Enterprise

* firmware **ovmf**, 6.6 GB virtual disk, catalog selection /IMAGE/INDEX `1`

| strategy | URL | bytes | sha256 | selection |
|---|---|---|---|---|
| esd | https://go.microsoft.com/fwlink?linkid=2156292 | — | — | catalog default |
| midoDirect | https://software-static.download.prss.microsoft.com/dbazure/888969d5-f34g-4e03-ac9d-1f9786c66749/26200.6584.250915-1905.25h2_ge_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso | 7092807680 | `a61adeab895ef5a4db436e0a7011c92a2ff17bb0357f58b13bbc4062e535e7b9` | catalog default |

### `10` — Windows 10 Pro

* firmware **ovmf**, 5.7 GB virtual disk, catalog selection /IMAGE/INDEX `1`

| strategy | URL | bytes | sha256 | selection |
|---|---|---|---|---|
| mido | (live handshake: live Microsoft page (ProductEditionId 2618, /en-us/software-download/windows10ISO)) | — | — | catalog default |
| esd | https://go.microsoft.com/fwlink/?LinkId=841361 | — | — | catalog default |
| link1 | https://dl.bobpony.com/windows/10/en-us_windows_10_22h2_x64.iso | 5723299840 | `316f718f21fc9b386d81dadd62dc60268a1cfd65b184ac6a052875a454c3431b` | catalog default |
| link6 | https://archive.org/download/windows-10-business-editions-version-22h2-updated-oct-2025-en-us/en-us_windows_10_business_editions_version_22h2_updated_oct_2025_x64_dvd_d2eef4b0.iso | 6985445376 | `2c23bc8b95a9314f15ebff881dcbea49651f52a96a0327d7aaf523aa66043765` | catalog default |

### `10l` — Windows 10 LTSC

* firmware **ovmf**, 4.6 GB virtual disk, catalog selection /IMAGE/INDEX `1`

| strategy | URL | bytes | sha256 | selection |
|---|---|---|---|---|
| midoDirect | https://software-download.microsoft.com/download/pr/19044.1288.211006-0501.21h2_release_svc_refresh_CLIENT_LTSC_EVAL_x64FRE_en-us.iso | 4898582528 | `e4ab2e3535be5748252a8d5d57539a6e59be8d6726345ee10e7afd2cb89fefb5` | /IMAGE/INDEX `1` |
| link1 | https://dl.bobpony.com/windows/10/en-us_windows_10_enterprise_ltsc_2021_x64_dvd_d289cf96.iso | 4899461120 | `c90a6df8997bf49e56b9673982f3e80745058723a707aef8f22998ae6479597d` | catalog default |
| link6 | https://archive.org/download/en-us_windows_10_enterprise_ltsc_2021_x64_dvd_d289cf96_202302/en-us_windows_10_enterprise_ltsc_2021_x64_dvd_d289cf96.iso | 4899461120 | `c90a6df8997bf49e56b9673982f3e80745058723a707aef8f22998ae6479597d` | catalog default |

### `10e` — Windows 10 Enterprise

* firmware **ovmf**, 5.2 GB virtual disk, catalog selection /IMAGE/INDEX `1`

| strategy | URL | bytes | sha256 | selection |
|---|---|---|---|---|
| esd | https://go.microsoft.com/fwlink/?LinkId=841361 | — | — | catalog default |
| midoDirect | https://software-static.download.prss.microsoft.com/dbazure/988969d5-f34g-4e03-ac9d-1f9786c66750/19045.2006.220908-0225.22h2_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso | 5550497792 | `ef7312733a9f5d7d51cfa04ac497671995674ca5e1058d5164d6028f0938d668` | catalog default |

### `7u` — Windows 7 Ultimate

* firmware **seabios**, 3.1 GB virtual disk, catalog selection /IMAGE/NAME `Windows 7 Ultimate` (verified)

| strategy | URL | bytes | sha256 | selection |
|---|---|---|---|---|
| link1 | https://dl.bobpony.com/windows/7/en_windows_7_with_sp1_x64.iso | 3320836096 | `0b738b55a5ea388ad016535a5c8234daf2e5715a0638488ddd8a228a836055a1` | catalog default |
| link2 | https://files.dog/MSDN/Windows%207/en_windows_7_ultimate_with_sp1_x64_dvd_u_677332.iso | 3320903680 | `36f4fa2416d0982697ab106e3a72d2e120dbcdb6cc54fd3906d06120d0653808` | catalog default |
| link6 | https://archive.org/download/win7-ult-sp1-english/Win7_Ult_SP1_English_x64.iso | 3320903680 | `36f4fa2416d0982697ab106e3a72d2e120dbcdb6cc54fd3906d06120d0653808` | catalog default |

### `xp` — Windows XP Professional

* firmware **seabios**, 0.6 GB virtual disk, catalog selection —, **refused** (`legacy-installer-unsupported`)

| strategy | URL | bytes | sha256 | selection |
|---|---|---|---|---|
| link1 | https://dl.bobpony.com/windows/xp/professional/en_windows_xp_professional_with_service_pack_3_x86_cd_x14-80428.iso | 617756672 | `62b6c91563bad6cd12a352aa018627c314cfc5162d8e9f8af0756a642e602a46` | catalog default |
| link2 | https://files.dog/MSDN/Windows%20XP/en_windows_xp_professional_with_service_pack_3_x86_cd_x14-80428.iso | 617756672 | `62b6c91563bad6cd12a352aa018627c314cfc5162d8e9f8af0756a642e602a46` | catalog default |

### `2025` — Windows Server 2025

* firmware **ovmf**, 7.6 GB virtual disk, catalog selection /IMAGE/INDEX `2`

| strategy | URL | bytes | sha256 | selection |
|---|---|---|---|---|
| midoDirect | https://software-static.download.prss.microsoft.com/dbazure/998969d5-f34g-4e03-ac9d-1f9786c66749/26100.32230.260111-0550.lt_release_svc_refresh_SERVER_EVAL_x64FRE_en-us.iso | 8152356864 | `7b052573ba7894c9924e3e87ba732ccd354d18cb75a883efa9b900ea125bfd51` | /IMAGE/INDEX `2` |
| midoDirect | https://software-static.download.prss.microsoft.com/dbazure/888969d5-f34g-4e03-ac9d-1f9786c66749/26100.1742.240906-0331.ge_release_svc_refresh_SERVER_EVAL_x64FRE_en-us.iso | — | — | /IMAGE/INDEX `2` |
| link1 | https://dl.bobpony.com/windows/server/2025/en-us_windows_server_2025_updated_oct_2025_x64_dvd_6c0c5aa8.iso | 7571058688 | `d273d0a85565ffbc06a3d46313f619103e2830a3373306ddbb9a08b8824f509d` | /IMAGE/NAME `Windows Server 2025 SERVERSTANDARD` |
| link6 | https://archive.org/download/en-us_windows_server_2025_updated_dec_2025_x64_dvd_c54ab58b/en-us_windows_server_2025_updated_dec_2025_x64_dvd_c54ab58b.iso | 8145395712 | `f3e277e75acdb793e6f08f4880b514ae0046cedf618c22f727890e54367075e6` | /IMAGE/NAME `Windows Server 2025 SERVERSTANDARD` |

### `2022` — Windows Server 2022

* firmware **ovmf**, 6 GB virtual disk, catalog selection /IMAGE/INDEX `2`

| strategy | URL | bytes | sha256 | selection |
|---|---|---|---|---|
| midoDirect | https://software-static.download.prss.microsoft.com/sg/download/888969d5-f34g-4e03-ac9d-1f9786c66749/SERVER_EVAL_x64FRE_en-us.iso | 5044094976 | `3e4fa6d8507b554856fc9ca6079cc402df11a8b79344871669f0251535255325` | /IMAGE/INDEX `2` |
| link1 | https://dl.bobpony.com/windows/server/2022/en-us_windows_server_2022_updated_oct_2025_x64_dvd_26e9af36.iso | 6023239680 | `5d6d91efa972cbdd6701d78db1dcf6a34c7024ca931c1718e7cb3d0c6dd54e88` | /IMAGE/NAME `Windows Server 2022 SERVERSTANDARD` |
| link6 | https://archive.org/download/en-us_windows_server_2022_x64_dvd_620d7eac_202405/en-us_windows_server_2022_x64_dvd_620d7eac.iso | 5550684160 | `5a077ee2a95976ef9f3623eb4040e25cdf7f8f01dee3b8165a32a7626f39f025` | /IMAGE/NAME `Windows Server 2022 SERVERSTANDARD` |

### `2019` — Windows Server 2019

* firmware **ovmf**, 5.3 GB virtual disk, catalog selection /IMAGE/INDEX `2`

| strategy | URL | bytes | sha256 | selection |
|---|---|---|---|---|
| midoDirect | https://software-download.microsoft.com/download/pr/17763.737.190906-2324.rs5_release_svc_refresh_SERVER_EVAL_x64FRE_en-us_1.iso | 5296713728 | `549bca46c055157291be6c22a3aaaed8330e78ef4382c99ee82c896426a1cee1` | /IMAGE/INDEX `2` |
| link1 | https://dl.bobpony.com/windows/server/2019/en-us_windows_server_2019_updated_aug_2021_x64_dvd_a6431a28.iso | 5575774208 | `0067afe7fdc4e61f677bd8c35a209082aa917df9c117527fc4b2b52a447e89bb` | /IMAGE/NAME `Windows Server 2019 SERVERSTANDARD` |
| link6 | https://archive.org/download/en-us_windows_server_2019_x64_dvd_f9475476_202603/en-us_windows_server_2019_x64_dvd_f9475476.iso | 5651695616 | `ea247e5cf4df3e5829bfaaf45d899933a2a67b1c700a02ee8141287a8520261c` | /IMAGE/NAME `Windows Server 2019 SERVERSTANDARD` |

### `2016` — Windows Server 2016

* firmware **ovmf**, 6.5 GB virtual disk, catalog selection /IMAGE/INDEX `2`

| strategy | URL | bytes | sha256 | selection |
|---|---|---|---|---|
| midoDirect | https://software-download.microsoft.com/download/pr/Windows_Server_2016_Datacenter_EVAL_en-us_14393_refresh.ISO | 6972221440 | `1ce702a578a3cb1ac3d14873980838590f06d5b7101c5daaccbac9d73f1fb50f` | /IMAGE/INDEX `2` |
| link1 | https://dl.bobpony.com/windows/server/2016/en_windows_server_2016_updated_feb_2018_x64_dvd_11636692.iso | 6006587392 | `af06e5483c786c023123e325cea4775050324d9e1366f46850b515ae43f764be` | /IMAGE/NAME `Windows Server 2016 SERVERSTANDARD` |
| link6 | https://archive.org/download/en_windows_server_2016_updated_feb_2018_x64_dvd_11636692/en_windows_server_2016_updated_feb_2018_x64_dvd_11636692.iso | 6006587392 | `af06e5483c786c023123e325cea4775050324d9e1366f46850b515ae43f764be` | /IMAGE/NAME `Windows Server 2016 SERVERSTANDARD` |

### `2012` — Windows Server 2012

* firmware **ovmf**, 4.3 GB virtual disk, catalog selection /IMAGE/INDEX `2`

| strategy | URL | bytes | sha256 | selection |
|---|---|---|---|---|
| midoDirect | https://download.microsoft.com/download/6/2/A/62A76ABB-9990-4EFC-A4FE-C7D698DAEB96/9600.17050.WINBLUE_REFRESH.140317-1640_X64FRE_SERVER_EVAL_EN-US-IR3_SSS_X64FREE_EN-US_DV9.ISO | 4542291968 | `6612b5b1f53e845aacdf96e974bb119a3d9b4dcb5b82e65804ab7e534dc7b4d5` | catalog default |
| link1 | https://dl.bobpony.com/windows/server/2012r2/en_windows_server_2012_r2_with_update_x64_dvd_6052708-004.iso | 5397889024 | `f351e89eb88a96af4626ceb3450248b8573e3ed5924a4e19ea891e6003b62e4e` | catalog default |
| link2 | https://files.dog/MSDN/Windows%20Server%202012%20R2%20with%20Update/en_windows_server_2012_r2_with_update_x64_dvd_6052708.iso | 5397889024 | `f351e89eb88a96af4626ceb3450248b8573e3ed5924a4e19ea891e6003b62e4e` | catalog default |
| link6 | https://archive.org/download/en_windows_server_2012_r2_with_update_x64_dvd_6052708_202006/en_windows_server_2012_r2_with_update_x64_dvd_6052708.iso | 5397889024 | `f351e89eb88a96af4626ceb3450248b8573e3ed5924a4e19ea891e6003b62e4e` | catalog default |

### `core11` — Tiny11 Core

* firmware **ovmf**, 3 GB virtual disk, catalog selection /IMAGE/INDEX `1`

| strategy | URL | bytes | sha256 | selection |
|---|---|---|---|---|
| link6 | https://archive.org/download/tiny11_25H2/tiny11core_25H2_Nov25.iso | 3304132608 | `c0e0252b24144b8defb6c7ded2bc09f9297daf1fb8369b16c5b85382331eb47f` | catalog default |

### `tiny11` — Tiny11

* firmware **ovmf**, 5.3 GB virtual disk, catalog selection /IMAGE/INDEX `1`

| strategy | URL | bytes | sha256 | selection |
|---|---|---|---|---|
| link6 | https://archive.org/download/tiny11_25H2/tiny11_25H2_Nov25.iso | 5730246656 | `7b24815845684add7250808b3b0027ba4e94cf52c62e9ef40d5b965dd304d6ca` | catalog default |

### `tiny10` — Tiny10

* firmware **ovmf**, 3.6 GB virtual disk, catalog selection /IMAGE/INDEX `1`

| strategy | URL | bytes | sha256 | selection |
|---|---|---|---|---|
| link6 | https://archive.org/download/tiny-10-23-h2/tiny10%20x64%2023h2.iso | 3839819776 | `a11116c0645d892d6a5a7c585ecc1fa13aa66f8c7cc6b03bf1f27bd16860cc35` | catalog default |
---

# Known gaps

* **`mido` is a moving target.** It follows Microsoft's page, and that page can
  change its instance id or add a challenge. When it fails the chain falls through
  to a pinned entry, and `resolveWindowsIso()` still refuses with the remediation
  instead of a 400 mid-download.
* **`esd` is feature-detected, not packaged.** A host without a cab extractor has
  no ESD strategy at all — by design (installing an extractor on a download path
  is a supply-chain change nobody asked for).
* **Mirror entries are somebody else's copy.** They are pinned by digest, so a
  substituted file is refused, but availability is not something this repository
  controls. `link1`/`link2`/`link6` are the last resort, never the first.
* **`tiny11`/`tiny10`/`core11` are community builds**, served from archive.org
  only, with no Microsoft page. They install like any other media, but their
  contents are not auditable here — pinning the bytes is the most this build can
  honestly promise.
* **`xp` is listed and refused.** Its chain exists so the refusal can show what it
  will not download; `code: legacy-installer-unsupported` names the real obstacle
  (no UEFI, and `winnt.sif` on a floppy/ISO root, which this OEM payload does not
  build).
* **No digest pin on the guest's base disk image** — see the README's
  "Image provenance & known gaps" section. The Microsoft media ARE pinned; the
  `cua`-managed Linux image is not.
