// Vendored from ultrasound-imaging/tools/viewer5/src/core/util.js (getPath, setPath, percentileClim); applyPatch and plain are the kit's.
// pure helpers (unit-tested)
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}
export function setPath(obj, path, val) {
  const ks = path.split('.')
  let o = obj
  for (let i = 0; i < ks.length - 1; i++) {
    if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = {}
    o = o[ks[i]]
  }
  o[ks[ks.length - 1]] = val
  return obj
}
// robust percentile clim for auto-clim (kills the "just black" / NaN-clim bug class)
export function percentileClim(arr, lo = 0.5, hi = 99.5) {
  const v = []
  for (let i = 0; i < arr.length; i++) { const x = arr[i]; if (Number.isFinite(x)) v.push(x) }
  if (!v.length) return [0, 1]
  v.sort((a, b) => a - b)
  const q = (p) => v[Math.min(v.length - 1, Math.max(0, Math.floor((p / 100) * v.length)))]
  let a = q(lo), b = q(hi)
  if (!(b > a)) b = a + 1e-9          // never collapse to a zero-width clim
  return [a, b]
}

export const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// A pushed state writes ONLY the keys it names: objects recurse, everything else (numbers,
// arrays, strings) is assigned. Keys it does not name are never touched, so a push of
// {em:{contrast:2}} cannot reset the camera, the selection or any other control. Mutates `target`
// in place, path by path, so a Svelte $state proxy invalidates only the leaves that changed.
export function applyPatch(target, patch) {
  for (const k of Object.keys(patch)) {
    const v = patch[k]
    if (plain(v) && plain(target[k])) applyPatch(target[k], v)
    else if (plain(v)) target[k] = structuredClone(v)
    else target[k] = Array.isArray(v) ? structuredClone(v) : v
  }
  return target
}

// Keys starting with "_" are transient (derived info, hover, loading flags): never persisted.
export function stripTransient(o) {
  if (Array.isArray(o)) return o.map(stripTransient)
  if (!plain(o)) return o
  const out = {}
  for (const k of Object.keys(o)) if (!k.startsWith('_')) out[k] = stripTransient(o[k])
  return out
}
