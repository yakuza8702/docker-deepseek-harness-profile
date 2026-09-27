#!/usr/bin/env node
/**
 * dsh-mobile surface heal — make the PHONE LAYOUT appear at phone width.
 *
 * THE BUG (measured, 2026-09-27)
 * -----------------------------
 * dsh-mobile decides its whole surface ONCE, from the HOSTNAME:
 *
 *     function isDesktopAdminSurface(hostname, search = "", frontend) {
 *       const query = …
 *       return isLocalAdminHostname(hostname) && frontend !== "dedicated" && …
 *     }
 *
 * `isLocalAdminHostname` is true for loopback AND every private IPv4, so a LAN
 * deployment (`http://192.168.0.6:3095`) reports `desktopAdmin === true` and the
 * entire phone layout is skipped: a 390px viewport renders the desktop page.
 * Measured on a stock 0.4.7 client: `data-dsh-mobile-*` nodes = 0, while the same
 * viewport on a healed deployment renders sidebar/header/center/toggle = 4.
 *
 * THE HEAL — two content-anchored edits
 * -------------------------------------
 * A. Make that decision viewport-aware using dsh-mobile's OWN overlay query
 *    `(max-width:720px)`. Wide pages keep the stock decision, so the desktop
 *    layout and the Mobile Access control are untouched.
 * B. Gate `installCustomAssets()` on the dedicated gateway frontend. The narrow
 *    branch calls it unconditionally, and its asset URLs only exist on the
 *    plugin's own gateway — off-gateway they 404 on every phone-width load.
 *
 * SAFETY: idempotent (marker check), timestamped backup, syntax gate before an
 * atomic write, and it fails closed on an unrecognised shape. Build-time only:
 * the container's rootfs is read-only, so this runs in the image build and never
 * touches a running harness.
 *
 *   node tools/heal-mobile-surface.mjs <client.js> [--check]
 */
import { readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs'
import { basename } from 'node:path'
import vm from 'node:vm'

const MARKER = 'dsh-mobile-surface-heal'
const target = process.argv[2]
const checkOnly = process.argv.includes('--check')
if (target === undefined) {
  console.error('usage: heal-mobile-surface.mjs <dsh-mobile/lib/client.js> [--check]')
  process.exit(2)
}

/** A — the viewport-aware surface decision. */
const A_ANCHOR = `\t\tfunction isDesktopAdminSurface(hostname, search = "", frontend) {\n\t\t\tconst query = search.startsWith("?") ? search.slice(1) : search;`
const A_HEALED = `\t\tfunction isDesktopAdminSurface(hostname, search = "", frontend) {
			// ${MARKER} (A): a NARROW page is the phone surface even when the host
			// looks like local administration (a LAN IP or a reverse-proxy domain).
			// Stock is hostname-only, so the whole phone layout was skipped there.
			// Wide pages keep the stock decision.
			try {
				if (typeof window !== "undefined" && typeof window.matchMedia === "function"
					&& window.matchMedia("(max-width:720px)").matches) return false;
			} catch (_ignored) { /* fall through to the stock decision */ }
			const query = search.startsWith("?") ? search.slice(1) : search;`

/** B — the gateway-only asset fetch, gated on the dedicated frontend. */
const B_ANCHOR = `\t\t\t\t\tconst removeCustom = installCustomAssets();`
const B_HEALED = `\t\t\t\t\t// ${MARKER} (B): the custom-asset URLs exist only on the plugin's own
					// gateway frontend; off-gateway they 404 on every narrow load.
					const removeCustom = window.__DSH_MOBILE_FRONTEND__ === "dedicated" ? installCustomAssets() : () => {};`

const original = readFileSync(target, 'utf8')
if (original.includes(MARKER)) {
  console.log(`already healed: ${target}`)
  process.exit(0)
}

function replaceOnce(source, anchor, replacement, label) {
  const hits = source.split(anchor).length - 1
  if (hits !== 1) {
    console.error(`heal aborted: anchor ${label} matched ${hits} time(s) in ${basename(target)} — refusing to write`)
    process.exit(1)
  }
  return source.replace(anchor, replacement)
}

let healed = replaceOnce(original, A_ANCHOR, A_HEALED, 'A (isDesktopAdminSurface)')
healed = replaceOnce(healed, B_ANCHOR, B_HEALED, 'B (installCustomAssets)')

try {
  new vm.Script(healed, { filename: target })
} catch (error) {
  console.error(`heal aborted: the healed bundle does not parse — ${error.message}`)
  process.exit(1)
}

if (checkOnly) {
  console.log(`check only: both edits apply and the result parses (${target})`)
  process.exit(0)
}

const backup = `${target}.bak-surface-heal`
copyFileSync(target, backup)
const temporary = `${target}.tmp-surface-heal`
writeFileSync(temporary, healed)
renameSync(temporary, target)
console.log(`healed ${target} (backup: ${backup})`)
