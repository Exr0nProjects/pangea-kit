import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import * as svelte from 'svelte'
import * as svelteClient from 'svelte/internal/client'
import * as discloseVersion from 'svelte/internal/disclose-version'
import * as ui from '../ui/index.js'
import { createViewer } from './viewer.js'
import { installPerf } from './perf.js'
import { createKitStorage } from './storage.js'
import { makeState, createKit, partContext, effect, persistOnChange, trackHistory } from './kit.svelte.js'
import { createStore } from '../lib/store.js'
import { createData } from '../lib/data.js'
import { createKeys } from '../lib/keys.js'
import { selection } from '../lib/components.js'
import { connectLive, createReporter } from '../lib/live.js'
import { boundLog, trimRecord } from '../lib/logbound.js'
import { hydrate, schedulePersist, flushPersist, RuntimeAbort, deepMerge } from '../lib/persist.js'
import { planChange, mountParts } from '../lib/parts.js'
import { hostDeps, kitDepKeys } from '../lib/externals.js'
import { applyPatch } from '../lib/util.js'
import { resolveUnits } from '../lib/scale.js'

// Keys the KIT owns in every app's state tree (merged under the app's own `initial`, so no app declares them):
//   axes: the built-in axes / bbox / scale bar / gizmo toggle (key `x`). Optional app keys: units, unitScale (see GUIDE 3.10).
const KIT_INITIAL = { axes: true }
const withKit = (schema) => { schema.initial = { ...KIT_INITIAL, ...(schema.initial || {}) }; return schema }

const base = new URL('.', location.href).href
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- chrome: stage, ui overlay, status chip, error list (plain DOM; the host has no framework of its own) ----
document.documentElement.style.cssText = 'height:100%'
document.body.style.cssText = 'margin:0;height:100%;background:#0e0e0e;color:#ddd;font:12px ui-monospace,Menlo,monospace;overflow:hidden'
const stage = Object.assign(document.createElement('div'), { id: 'qk-stage' }); stage.style.cssText = 'position:absolute;inset:0'
const uiRoot = Object.assign(document.createElement('div'), { id: 'qk-ui' }); uiRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none'
const chip = Object.assign(document.createElement('div'), { id: 'qk-chip' }); chip.style.cssText = 'position:absolute;right:8px;bottom:6px;color:#888;z-index:9;text-align:right;max-width:60vw'
document.body.append(stage, uiRoot, chip)
const errors = new Map()
const pending = new Set() // parts still mounting and data files still loading: shown so a slow layer reads as loading, not broken
let liveStatus = 'connecting'
function paintChip() {
  const busy = pending.size ? `<div style="color:#888">loading ${[...pending].map((k) => k.replace(/</g, '&lt;')).join(', ')}…</div>` : ''
  const dot = liveStatus === 'live' ? '<span style="color:#5c5">●</span> live' : liveStatus === 'reconnecting' ? '<span style="color:#c95">○</span> reconnecting' : `<span style="color:#888">○</span> ${liveStatus}`
  chip.innerHTML = [...errors].map(([k, m]) => `<div style="color:#f66;white-space:pre-wrap">${k}: ${String(m).replace(/</g, '&lt;')}</div>`).join('') + busy + dot
}
const fail = (key, e) => { console.error(`[pangea-kit] ${key}`, e); errors.set(key, e?.stack?.split('\n').slice(0, 3).join('\n') || e?.message || e); paintChip() }
const ok = (key) => { if (errors.delete(key)) paintChip() }
const busy = (key, on) => { if (on ? !pending.has(key) : pending.has(key)) { on ? pending.add(key) : pending.delete(key); paintChip() } }
paintChip()
addEventListener('error', (e) => fail('error', e.error || e.message))
addEventListener('unhandledrejection', (e) => fail('rejection', e.reason))

// ---- deps parts are built against (lib/build.mjs maps each external import to __pangea.deps.<id>) ----
const deps = hostDeps({ svelte, svelteClient, discloseVersion, THREE, ui })
globalThis.__pangea = { deps }

function run(code, name) {
  const s = document.createElement('script')
  s.textContent = `${code}\n;__pangea.__part = __pangeaPart;\n//# sourceURL=qk-${name}.js`
  document.head.appendChild(s); s.remove()
  const out = globalThis.__pangea.__part; globalThis.__pangea.__part = undefined
  return out
}
async function loadScript(file, hash) {
  const res = await fetch(`${base}${file}?v=${hash}`)
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`)
  return run(await res.text(), file.replace(/\W+/g, '-'))
}

export async function boot() {
  const reporter = createReporter({ base })
  let known = null
  const queued = []
  let onFiles = null, onState = null
  const firstFiles = new Promise((resolve) => {
    connectLive({
      base,
      onStatus: (s) => { liveStatus = s; paintChip() },
      onFiles: (files, kind) => { if (!known) { known = files; resolve(files) } else onFiles?.(files, kind) },
      onState: (obj) => { if (onState) onState(obj); else queued.push(obj) },
    })
  })
  const [files, record] = await Promise.all([
    Promise.race([firstFiles, sleep(8000).then(() => { throw new Error('no live channel (__live): is this page served from /view/<ULID>/ ?') })]),
    fetch(`${base}view.json?t=${Date.now()}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ])
  if (!files['state.js']) throw new Error('artifact has no state.js (the state schema)')
  let schema = withKit(await loadScript('state.js', files['state.js']))

  const key = `qk:${schema.name || 'app'}`
  const trim = (v) => trimRecord(v, 200_000) // the server copy is size-capped (256 KB): drop the oldest log entries until it fits (one parse; lib/logbound.js)
  const storage = createKitStorage({ key, legacyKeys: (schema.legacyNames || []).map((n) => `qk:${n}`), serverRecord: record, post: (k, v) => reporter.report(trim(v)) })
  let aborted = null, initialState
  try { initialState = hydrate({ key, version: schema.version || 1, initial: schema.initial || {}, migrations: schema.migrations || {}, storage }) } catch (e) {
    if (!(e instanceof RuntimeAbort)) throw e
    aborted = e.message; initialState = structuredClone(schema.initial || {}); fail('state', `saved state unloadable, NOT persisting (bytes kept): ${e.message}`)
  }
  const state = makeState()
  const meta = makeState(); Object.assign(meta, { axes: true, units: null, unitScale: null }) // meta.json: title, axes:false (opt-out), units, unitScale
  const loadMeta = () => fetch(`${base}meta.json?t=${Date.now()}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((m) => {
    if (!m) return
    if (m.title && !(typeof state.title === 'string' && state.title)) document.title = m.title
    meta.axes = m.axes !== false; meta.units = m.units ?? null; meta.unitScale = m.unitScale ?? null
  }).catch(() => {})
  loadMeta()
  Object.assign(state, initialState)
  let savedLog = []
  try { savedLog = JSON.parse(storage.getItem(key) || '{}').log || [] } catch {}
  const persist = () => { if (!aborted) schedulePersist(key, schema.version || 1, state, { storage, extra: () => ({ log: boundLog(store.log, 150_000) }) }) }
  const store = createStore({ state, log: savedLog, deviceId: Math.random().toString(36).slice(2, 8), onAction: persist })
  persistOnChange(state, persist) // bind:value writes skip dispatch; any non-_ state change persists
  const setup = () => schema.setup?.(store, { selection })
  setup()
  const history = schema.history ? trackHistory(state, schema.history) : null // opt-in undo/redo (state.js `history`), in memory only

  const data = createData({ baseUrl: base, onProgress: (name, phase) => busy(name, phase === 'start') })
  data.setManifest(files)
  const viewer = createViewer({ THREE, OrbitControls, container: stage })
  if (state.camera) viewer.setCamera(state.camera)
  effect(() => { if (typeof state.title === 'string' && state.title) document.title = state.title }) // live tab title: dispatch/push {title:'...'}
  effect(() => { viewer.setCamera(state.camera) }) // pushed or restored camera -> scene; same-value writes are no-ops
  viewer.onCameraEnd(() => store.dispatch('set', { path: 'camera', value: viewer.getCamera() }))
  const keys = createKeys(window)
  // built-in axes: state.axes (default on, persisted) toggled by `x`; quicklook.json "axes": false removes them for non-spatial apps
  effect(() => viewer.axes.setAvailable(meta.axes !== false))
  effect(() => viewer.axes.setEnabled(state.axes !== false))
  effect(() => { const u = resolveUnits(state, meta); viewer.axes.setUnits(u) })
  keys.bind({ x: () => { if (meta.axes !== false) store.dispatch('set', { path: 'axes', value: state.axes === false }) } }, { rank: -1 }) // ranked below every part: an app's own `x` wins
  const kit = createKit({ state, store, data, viewer, keys, ui, deps, THREE, live: { status: () => liveStatus }, history })
  Object.defineProperty(kit, 'units', { get: () => resolveUnits(state, meta), enumerable: true }) // { unit, scale }; reactive, read by ui/ScaleBar
  kit.onError = fail
  for (const k of kitDepKeys) deps[k] = kit
  globalThis.__pangea.kit = kit
  globalThis.__pangea.derived = kit.derivedCore // harness hook: await __pangea.derived.idle(), __pangea.derived.running()
  installPerf(kit) // kit.perf.slow: interactions over the 50 ms budget
  addEventListener('pagehide', () => { flushPersist(key); reporter.flush() })

  // ---- parts ----
  const mounted = new Map() // name -> ctx
  const partFiles = (f) => Object.keys(f).filter((n) => /^parts\/[^/]+\.js$/u.test(n)).sort()
  const rankOf = (name) => { const i = partFiles(known).indexOf(`parts/${name}.js`); return i < 0 ? undefined : i }
  // the context is created synchronously (DOM slot and keymap rank in file order); the factory's own awaits (its data) block nobody else
  async function mountPart(name, factory, rank = rankOf(name)) {
    const ctx = partContext(kit, name, uiRoot, { rank })
    busy(name, true)
    try { const r = await factory(ctx); if (typeof r === 'function') ctx.cleanup(r); mounted.set(name, ctx); ok(`part ${name}`) } catch (e) { ctx.dispose(); fail(`part ${name}`, e) } finally { busy(name, false) }
  }
  // every part script is fetched at once and every part mounts without waiting for another part's data (lib/parts.js mountParts)
  await mountParts(partFiles(files), { load: (file) => loadScript(file, files[file]), mount: mountPart, fail: (name, e) => fail(`part ${name}`, e) })

  // ---- hot swap: only what the manifest says changed ----
  async function handle(next) {
    const plan = planChange(known, next)
    known = next
    if (plan.reload) { flushPersist(key); await reporter.flush(); location.reload(); return } // the host itself changed (kit upgrade)
    if (plan.schema) {
      try {
        const fresh = withKit(await loadScript('state.js', next['state.js']))
        const oldV = schema.version || 1
        schema = fresh
        const merged = deepMerge(structuredClone(schema.initial || {}), JSON.parse(JSON.stringify(state)))
        applyPatch(state, merged) // new keys appear, nothing existing is reset
        let v = oldV
        if ((schema.version || 1) > oldV) { // a bumped schema upcasts the live state too
          let st = JSON.parse(JSON.stringify(state))
          while (v < schema.version) { const up = schema.migrations?.[v + 1]; if (!up) throw new Error(`no upcaster for v${v + 1}`); st = up(st); v++ }
          applyPatch(state, st)
        }
        setup(); history?.reset(); ok('state.js'); persist() // the upcast / merge above is not an undo step
      } catch (e) { fail('state.js', e) }
    }
    // 1. fetch the new code of every changed part first (a failed fetch leaves the old part running)
    const loaded = (await Promise.all(plan.parts.map((file) => loadScript(file, next[file]).then((f) => [file.slice(6, -3), f], (e) => { fail(`part ${file.slice(6, -3)}`, e); return null })))).filter(Boolean)
    // 2. dispose exactly those parts, 3. let the data layer notify the parts that stay, 4. mount the new ones
    for (const f of plan.removedParts) { mounted.get(f.slice(6, -3))?.dispose(); mounted.delete(f.slice(6, -3)); ok(`part ${f.slice(6, -3)}`) }
    for (const [name] of loaded) { mounted.get(name)?.dispose(); mounted.delete(name) }
    data.setManifest(next)
    if (plan.data.includes('meta.json')) loadMeta()
    await Promise.all(loaded.map(([name, factory]) => mountPart(name, factory))) // contexts created in order, data awaited concurrently
  }
  onFiles = (f) => { handle(f).catch((e) => fail('swap', e)) }

  const applyActions = (obj) => {
    for (const a of obj.actions || []) {
      try { store.apply({ ...a, actor: a.actor || 'agent' }) } catch (e) { fail(`push ${a.id}`, e) }
    }
  }
  onState = applyActions
  for (const q of queued.splice(0)) applyActions(q)
  return kit
}
