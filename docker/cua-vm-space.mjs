/**
 * cua-vm-space — ONE coordinate space, measured instead of assumed.
 *
 * THE BUG THIS MODULE EXISTS FOR
 * ------------------------------
 * cua captures at most ~900k pixels. A 1280x800 desktop therefore comes back as
 * a 1200x750 PNG, and every "the click landed 6% up and to the left" report was
 * that ratio: the model read a pixel in the image, the tool clicked a *display*
 * pixel, and the two spaces differed by 0.9375.
 *
 * The old code papered over it twice:
 *   * it hardcoded 1200x750 as the desktop (`DESKTOP_RESOLUTION`) and hoped the
 *     provisioning script had applied it, and
 *   * it resolved fractional coordinates with `Math.sqrt(900000 / area)`, i.e.
 *     it GUESSED the capture size from cua's pixel budget instead of looking at
 *     the PNG that had just been taken.
 *
 * Both assumptions are wrong the moment the guest ignores the mode (Xorg on a
 * virtio EDID that does not advertise 1200x750), the user restarts the desktop
 * at another size, or cua changes its cap. So this module MEASURES:
 *
 *   display size   `xdotool getdisplaygeometry` inside the guest (the truth the
 *                  X server uses for pointer coordinates).
 *   screenshot     the PNG's own IHDR chunk, read here with zero dependencies
 *                  (signature + IHDR width/height, 24 bytes in). That is the
 *                  truth cua itself sees, because it is the file cua wrote.
 *   scale          display / screenshot — how much to multiply an image
 *                  coordinate by to get a display coordinate. 1 means the two
 *                  spaces are identical and nobody has to think.
 *
 * WHAT THE CALLER GETS
 * --------------------
 * Every pointer or typing result carries one line:
 *
 *   screenshot 1200x750 · display 1280x800 · scale 1.0667
 *
 * and, when scale ≠ 1, one more:
 *
 *   image px = 0.9375 × display px; cua maps it — do not rescale
 *
 * The second line is the whole contract: `cua do click` takes SCREENSHOT pixels
 * and maps them internally, so a model that "fixes" the ratio by hand is the
 * only way left to be wrong.
 *
 * WHY A CACHE, AND WHY 30 SECONDS
 * -------------------------------
 * A pointer poll runs twice a second and a click runs three commands; measuring
 * the display through `sb exec` on every one of them would double the latency of
 * an interactive desktop. The geometry only changes when the desktop restarts,
 * so it is cached per computer for 30 s and invalidated EXPLICITLY by the four
 * actions that can change it: resume, restart, zoom, unzoom.
 */

/** cua's capture budget. Above this, the PNG is smaller than the display. */
export const CAPTURE_MAX_PIXELS = 900_000
export const SPACE_CACHE_MS = 30_000

/**
 * The PNG's intrinsic size, from its IHDR chunk.
 *
 * Zero dependencies on purpose: the image is already on disk (cua just wrote
 * it), ImageMagick's `identify` is a process spawn, and a module that needs a
 * library to read 24 bytes would not be usable from the guest-side tool path.
 * Returns null for anything that is not a PNG — the caller then falls back to
 * the display size rather than inventing a number.
 */
export function pngSize(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? [])
  if (buffer.length < 24) return null
  // \x89PNG\r\n\x1a\n
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null
  // The first chunk MUST be IHDR: 4-byte length, "IHDR", then width and height.
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (!width || !height) return null
  return { width, height }
}

/** One line, and the only one a caller has to print. */
export function formatSpace(space) {
  if (!space) return 'screenshot unknown · display unknown · scale unknown'
  const shot = space.screenshot ?? {}
  const display = space.display ?? {}
  return `screenshot ${shot.width ?? '?'}x${shot.height ?? '?'} · display ${display.width ?? '?'}x${display.height ?? '?'} · scale ${formatScale(space.scale)}`
}

/** Four significant digits, no trailing zeroes: 1, 1.0667, 0.9375. */
export function formatScale(scale) {
  const value = Number(scale)
  if (!Number.isFinite(value) || value <= 0) return '?'
  return String(Math.round(value * 10000) / 10000)
}

/**
 * The warning the contract asks for, or '' when the two spaces agree.
 *
 * `1 / scale` is the ratio the model would be tempted to apply ("the image is
 * 6% smaller, so my click must be 6% bigger"); the sentence says the opposite,
 * because cua already applies it.
 */
export function formatSpaceWarning(space) {
  const scale = Number(space?.scale)
  if (!Number.isFinite(scale) || scale <= 0 || Math.abs(scale - 1) < 1e-6) return ''
  const inverse = Math.round((1 / scale) * 10000) / 10000
  return `image px = ${inverse} × display px; cua maps it — do not rescale`
}

/** The pair of lines every result carries. */
export function spaceLine(space) {
  const warning = formatSpaceWarning(space)
  return warning === '' ? formatSpace(space) : `${formatSpace(space)}\n${warning}`
}

/**
 * Resolutions above cua's capture budget are refused at create time unless the
 * operator says otherwise.
 *
 * WHY REFUSE RATHER THAN SCALE: a 1920x1080 desktop is a 0.694 capture, and
 * every screenshot the model reads is then a resampled image. Click precision
 * degrades exactly where the UI is densest (toolbar buttons, list rows), and the
 * failure looks like a model mistake. DSH_CUA_VM_RESOLUTION_ALLOW_SCALE=1 keeps
 * the old behaviour for someone who really wants a bigger desktop and accepts
 * the 1:1.44 mapping; the space line then reports it honestly.
 */
export function resolutionProblem(resolution, allowScale = process.env.DSH_CUA_VM_RESOLUTION_ALLOW_SCALE === '1') {
  const matched = /^(\d{3,5})x(\d{3,5})$/u.exec(String(resolution ?? '').trim())
  if (!matched) return `desktop resolution "${resolution}" is not WxH (e.g. 1200x750)`
  const width = Number(matched[1])
  const height = Number(matched[2])
  const pixels = width * height
  if (pixels <= CAPTURE_MAX_PIXELS || allowScale) return null
  return `desktop resolution ${width}x${height} is ${pixels} px, above cua's ~${CAPTURE_MAX_PIXELS} px capture budget: `
    + 'screenshots would be resampled and every click coordinate would need the image→display ratio. '
    + 'Use 1200x750 (exactly the budget, so image px = display px), or set DSH_CUA_VM_RESOLUTION_ALLOW_SCALE=1 to accept a scaled capture.'
}

/**
 * The space object.
 *
 * `display(name)` and `capture(name)` are injected by the supervisor (they are a
 * guest exec and a `cua do screenshot` respectively) so this module stays a pure
 * measurement/arithmetic layer that can be unit-tested without a VM.
 */
export function createSpace({ display, capture, log = () => {}, now = Date.now } = {}) {
  const cache = new Map()

  async function measure(name, { force = false } = {}) {
    const cached = cache.get(name)
    if (!force && cached && now() - cached.at < SPACE_CACHE_MS) return cached.space
    let shown = null
    try {
      shown = await display(name)
    } catch (error) {
      log(`space: could not read the display size of ${name} (${error?.message ?? error})`)
    }
    let shot = null
    try {
      shot = await capture(name)
    } catch (error) {
      log(`space: could not capture ${name} (${error?.message ?? error})`)
    }
    if (shown === null && shot === null) return cached?.space ?? null
    // A missing half is NOT guessed: the known side fills in, and `source` says
    // which measurement the scale came from.
    const displaySize = shown ?? { width: shot.width, height: shot.height }
    const shotSize = shot ?? { width: displaySize.width, height: displaySize.height }
    const scale = shotSize.width > 0 ? displaySize.width / shotSize.width : 1
    const space = {
      name,
      display: { width: displaySize.width, height: displaySize.height },
      screenshot: { width: shotSize.width, height: shotSize.height },
      scale,
      source: shot !== null ? 'png' : 'display',
      at: now()
    }
    cache.set(name, { space, at: now() })
    return space
  }

  return {
    measure,
    /** Drop the cache for one computer (resume, restart, zoom change). */
    invalidate(name) {
      cache.delete(name)
    },
    clear() {
      cache.clear()
    },
    cached(name) {
      return cache.get(name)?.space ?? null
    }
  }
}

/**
 * A fraction of the screen (0..1) in SCREENSHOT pixels.
 *
 * This replaces `Math.round(x * width * Math.sqrt(900000 / (width * height)))`:
 * a fraction is invariant across the mapping, so it resolves against the capture
 * that was actually taken. With a measured capture the arithmetic is one
 * multiplication, and with a 1:1 desktop it is the identity.
 */
export function relativeToPixels(space, x, y) {
  const shot = space?.screenshot ?? {}
  const width = Number(shot.width) || 0
  const height = Number(shot.height) || 0
  if (width === 0 || height === 0) throw new Error('the capture size is unknown; take a screenshot first')
  const fx = Math.min(1, Math.max(0, Number(x) || 0))
  const fy = Math.min(1, Math.max(0, Number(y) || 0))
  return { x: Math.round(fx * width), y: Math.round(fy * height) }
}

/**
 * A screenshot pixel in DISPLAY coordinates — the xdotool fallback only.
 *
 * cua's own verbs take image pixels, so this is used when `cua do click` is not
 * available (a daemon that will not answer): `round(x * scale)`.
 */
export function toDisplayPixels(space, x, y) {
  const scale = Number(space?.scale)
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1
  return { x: Math.round((Number(x) || 0) * factor), y: Math.round((Number(y) || 0) * factor) }
}
