// Pure scale logic for the kit's built-in axes and scale bars (3D viewer overlay and 2D ScaleBar share it).
// Kit convention: one scene unit = 1 µm. An app may declare `units` (label text) and `unitScale` (how many of
// `units` one scene unit is), in quicklook.json or state, e.g. a scene in µm shown in mm: units 'mm', unitScale 0.001.

const ALIASES = { nm: 'nm', mm: 'mm', cm: 'cm', m: 'm', px: 'px', 'µm': 'µm', um: 'µm', 'μm': 'µm', micron: 'µm', microns: 'µm', micrometer: 'µm', micrometers: 'µm', micrometre: 'µm', micrometres: 'µm', nanometer: 'nm', nanometers: 'nm', millimeter: 'mm', millimeters: 'mm', centimeter: 'cm', centimeters: 'cm', meter: 'm', meters: 'm', pixel: 'px', pixels: 'px' }

/** Canonical unit label: 'um'/'micron' -> 'µm' (U+00B5), case-insensitive aliases, anything else kept as the app wrote it. */
export function normalizeUnit(u) {
  if (typeof u !== 'string' || !u.trim()) return 'µm'
  const t = u.trim()
  return ALIASES[t.toLowerCase()] || t
}

/** Resolve the app's declared units; state wins over config (live override), then the kit default (µm, 1). */
export function resolveUnits(...sources) {
  let unit, scale
  for (const s of sources) {
    if (!s) continue
    if (unit === undefined && typeof s.units === 'string' && s.units.trim()) unit = normalizeUnit(s.units)
    const k = Number(s.unitScale)
    if (scale === undefined && s.unitScale != null && Number.isFinite(k) && k > 0) scale = k
  }
  return { unit: unit ?? 'µm', scale: scale ?? 1 }
}

/** Units for a ui component: its own props win, else the kit's resolved { unit, scale }, else µm / 1. */
export function pickUnits({ units, unitScale } = {}, kit = null) {
  const own = resolveUnits({ units, unitScale })
  return { unit: typeof units === 'string' && units.trim() ? own.unit : kit?.unit ?? own.unit, scale: unitScale != null && Number(unitScale) > 0 ? own.scale : kit?.scale ?? own.scale }
}

/** Length in scene units -> length in display units. */
export const toDisplay = (sceneLength, scale = 1) => sceneLength * scale

/** Largest 1/2/5 x 10^n that is <= x (x > 0). 137 -> 100, 4800 -> 2000, 0.07 -> 0.05. */
export function niceFloor(x) {
  if (!(x > 0) || !Number.isFinite(x)) return 0
  const p = Math.pow(10, Math.floor(Math.log10(x)))
  const m = x / p
  const f = m >= 5 ? 5 : m >= 2 ? 2 : 1
  return +(f * p).toPrecision(12)
}

/** Smallest 1/2/5 x 10^n that is >= x (x > 0). 154 -> 200, 20 -> 20. */
export function niceCeil(x) {
  if (!(x > 0) || !Number.isFinite(x)) return 0
  const p = Math.pow(10, Math.ceil(Math.log10(x)) - 1)
  for (const f of [1, 2, 5, 10]) if (f * p >= x * (1 - 1e-12)) return +(f * p).toPrecision(12)
  return 10 * p
}

/**
 * Scale bar: the round length (1/2/5 x 10^n, in display units) whose bar is at most `maxPx` wide.
 * `perPx` is display units per screen pixel. Returns { value, px } (px = bar width on screen, always
 * between 40% and 100% of maxPx, because consecutive 1/2/5 steps are at most 2.5x apart).
 */
export function scaleBar(perPx, { maxPx = 140 } = {}) {
  if (!(perPx > 0) || !Number.isFinite(perPx)) return null
  const value = niceFloor(perPx * maxPx)
  return { value, px: value / perPx }
}

/** Trim a number for a label: >=100 integer, >=10 one decimal, else two; trailing zeros dropped. */
export function formatNumber(v) {
  if (!Number.isFinite(v)) return ''
  const a = Math.abs(v)
  const d = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : a >= 0.1 ? 3 : 4
  return String(+v.toFixed(d))
}

/** A length with its unit: µm steps down to nm below 1 and up to mm from 1000; other units are shown as given. */
export function formatLength(value, unit = 'µm') {
  if (unit === 'µm') {
    if (Math.abs(value) < 1 && value !== 0) return { value: +(value * 1000).toPrecision(12), unit: 'nm', text: `${formatNumber(value * 1000)} nm` }
    if (Math.abs(value) >= 1000) return { value: +(value / 1000).toPrecision(12), unit: 'mm', text: `${formatNumber(value / 1000)} mm` }
  }
  return { value, unit, text: `${formatNumber(value)} ${unit}` }
}

/**
 * Tick values for an axis from 0 to `extent` (display units): 1/2/5 multiples, at most `target` + 1 of them, and the
 * extent itself always labelled (a nice tick closer than 40% of a step to it is replaced), so the end label IS the box size.
 */
export function niceTicks(extent, target = 5) {
  if (!(extent > 0) || !Number.isFinite(extent)) return [0]
  const step = niceCeil(extent / Math.max(1, target)) || extent
  const out = []
  for (let v = 0; v < extent - step * 0.4; v += step) out.push(+v.toPrecision(12))
  out.push(+extent.toPrecision(12))
  return out
}

/** Display-units per CSS pixel at the orbit target depth of a perspective camera (fov in degrees, viewport height in px). */
export function unitsPerPixel({ distance, fovDeg, heightPx, sceneScale = 1, unitScale = 1 }) {
  if (!(distance > 0) || !(heightPx > 0)) return 0
  const worldPerPx = (2 * distance * Math.tan((fovDeg * Math.PI) / 360)) / heightPx
  return (worldPerPx / (sceneScale || 1)) * unitScale
}
