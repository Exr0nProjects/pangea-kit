// Vendored from ultrasound-imaging/tools/viewer5/src/core/persist.js. Changes for the kit: the storage is
// injected (a sandboxed quicklook page has no localStorage; see host/storage.js), the persisted record
// carries savedAt, transient (_) keys are stripped before saving, and a DOM-free flush() exists.
// Framework-owned versioned-persistence contract.
// Operating analysis: data loss from missing upcasters was a catastrophic, repeated bug
// ("if you'd used schema versions + upcasters we wouldn't have lost data").
// Contract: 3-tier hydrate (initial <- bundleDefaults <- persisted) · archive-raw-before-migrate
// · assertComplete · abort-on-unloadable (NEVER fall back to initial then persist → that clobbers).
// Quick `view()` scenes pass persistKey=null and opt out entirely.

import { stripTransient } from './util.js'

export class RuntimeAbort extends Error {}

export function deepMerge(base, over) {
  if (over == null) return base
  // kit fix: a null base (an unset camera) takes the persisted object; viewer5's version threw on it
  if (base == null || Array.isArray(base) || typeof base !== 'object') return structuredClone(over)
  const out = structuredClone(base)
  for (const k of Object.keys(over)) out[k] = deepMerge(base?.[k], over[k])
  return out
}

function keyset(o, p = '') {
  const ks = []
  if (o && typeof o === 'object' && !Array.isArray(o))
    for (const k of Object.keys(o)) ks.push(p + k, ...keyset(o[k], p + k + '.'))
  return ks
}
function assertComplete(initial, merged) {
  const missing = keyset(initial).filter((k) => !keyset(merged).includes(k))
  if (missing.length) throw new Error('missing state keys after migrate: ' + missing.join(', '))
}

function archiveRaw(storage, key, raw) {
  try { storage.setItem(`__archive__${key}__${Date.now()}`, raw) } catch {}
}
const defaultStorage = () => { try { return globalThis.localStorage ?? null } catch { return null } }

export function hydrate({ key, version, initial, migrations = {}, bundleDefaults = {}, storage = defaultStorage() }) {
  const base = deepMerge(structuredClone(initial), bundleDefaults)   // tiers 1+2
  if (!key || !storage) return base       // ephemeral (quick view)
  const raw = storage.getItem(key)
  if (!raw) return base
  try {
    const saved = JSON.parse(raw)
    let st = saved.state ?? {}, v = saved.version || 1
    if (v < version) archiveRaw(storage, key, raw)                            // archive BEFORE migrate, only when migrating
    while (v < version) {
      const up = migrations[v + 1]
      if (!up) throw new Error(`no upcaster for v${v + 1}`)
      st = up(st); v++
    }
    const merged = deepMerge(base, st)
    assertComplete(initial, merged)
    return merged
  } catch (e) {
    // abort — do NOT overwrite the unloadable bytes; surface loudly, let user fix+reload
    throw new RuntimeAbort(e.message)
  }
}

const timers = {}
const pending = {}
function write(storage, key, version, state, extra) {
  try { storage.setItem(key, JSON.stringify({ version, savedAt: Date.now(), state: stripTransient(state), ...(extra ? extra() : {}) })) } catch {}
}
export function schedulePersist(key, version, state, { storage = defaultStorage(), delay = 400, extra = null } = {}) {
  if (!key || !storage) return
  clearTimeout(timers[key])
  pending[key] = () => write(storage, key, version, $snapshot(state), extra)
  timers[key] = setTimeout(() => { delete pending[key]; write(storage, key, version, $snapshot(state), extra) }, delay)
}
// Write now what a debounce is still holding (pagehide, before a swap).
export function flushPersist(key) {
  clearTimeout(timers[key])
  const f = pending[key]; delete pending[key]
  if (f) f()
}
// $state proxies are not structured-cloneable; a plain JSON round trip is the snapshot.
function $snapshot(state) { return JSON.parse(JSON.stringify(state)) }
