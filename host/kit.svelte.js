// The host runtime: everything that must SURVIVE an app update lives here and is never swapped.
//   state      one $state tree (path-level reactivity), written only through store.dispatch
//   store      Pangea-style reducer + op log (lib/store.js)
//   data       heavy files, versioned by hash (lib/data.js)
//   viewer     the persistent WebGL canvas, scene and camera
//   keys       the single keymap
// Parts (parts/*.js) are the swappable half; each gets a ctx whose cleanups run when it is replaced.
import { mount as svelteMount, unmount as svelteUnmount, untrack } from 'svelte'
import { createStore } from '../lib/store.js'
import { createData } from '../lib/data.js'
import { createKeys } from '../lib/keys.js'
import { selection } from '../lib/components.js'
import { getPath, setPath, stripTransient } from '../lib/util.js'
import { createSnapshotHistory, applyHistoryPatch, historyKey, hasNativeUndo } from '../lib/snaphistory.js'
import { createDerived } from '../lib/derived.js'
import { installPendingUI } from '../lib/derived-dom.js'

export function makeState() { const s = $state({}); return s }

/** Run fn in its own effect root; reads of `state` inside it re-run it. Returns a disposer. */
export function effect(fn) {
  return $effect.root(() => { $effect(() => { fn() }) })
}

/**
 * Persist on ANY change to the persistable state tree, including writes that bypass dispatch (`bind:value` in
 * Slider/Toggle writes the tree directly, so store.onAction never sees it). Reads the tree minus `_` keys, so
 * ephemeral writes never trigger it; skips when the serialized tree equals the last one seen (idempotent; the
 * first run only records the baseline, so booting writes nothing). `persist` is the debounced scheduler.
 */
export function persistOnChange(state, persist) {
  let last = null
  return effect(() => {
    const now = JSON.stringify(stripTransient(state))
    if (last !== null && now !== last) untrack(persist)
    last = now
  })
}

/**
 * Undo / redo of the whole persistable state tree (opt-in: `history: true` or `history: { limit, coalesceMs, exclude, passive, onApply(state, 'undo'|'redo') }`
 * in state.js; lib/snaphistory.js has the rules). Watches the tree exactly like persistOnChange, so it sees dispatch writes
 * and direct writes (`bind:value`) alike. A pointer held down is one gesture = one step; cmd/ctrl-Z, shift-cmd/ctrl-Z and
 * ctrl-Y are bound on the window unless focus is in a text field (native undo there). History lives in memory only: never
 * in the state, never persisted, never in the schema version. Returns the kit's `history` facility.
 */
export function trackHistory(state, opts = {}, target = globalThis.window) {
  const o = opts === true ? {} : opts, h = createSnapshotHistory(o)
  const ui = $state({ undo: 0, redo: 0 })
  const plain = () => JSON.parse(JSON.stringify(state))
  const sync = () => { const z = h.sizes; ui.undo = z.undo; ui.redo = z.redo }
  let first = true
  const off = effect(() => {
    const s = JSON.stringify(stripTransient(state)) // the read that subscribes this effect to every persistable leaf
    untrack(() => { const p = JSON.parse(s); if (first) { first = false; h.reset(p) } else h.observe(p); sync() })
  })
  const api = {
    undo() { const p = untrack(() => h.undo(plain())); if (p) { applyHistoryPatch(state, p); o.onApply?.(state, 'undo') } sync(); return !!p },
    redo() { const p = untrack(() => h.redo(plain())); if (p) { applyHistoryPatch(state, p); o.onApply?.(state, 'redo') } sync(); return !!p },
    /** Forget every step and take the live tree as the new baseline (a hot-swapped schema was upcast into it). */
    reset() { untrack(() => h.reset(plain())); sync() },
    get canUndo() { return ui.undo > 0 },
    get canRedo() { return ui.redo > 0 },
    get sizes() { return { undo: ui.undo, redo: ui.redo } },
    get limit() { return h.limit },
    dispose() { off(); for (const [t, f, c] of listeners) target?.removeEventListener(t, f, c) },
  }
  const listeners = []
  if (target) {
    let down = false
    const endGesture = () => setTimeout(() => { if (down) { down = false; h.end() } }, 0) // after the effect that records the gesture's last write
    const on = (t, f, c = true) => { target.addEventListener(t, f, c); listeners.push([t, f, c]) }
    on('pointerdown', () => { if (!down) { down = true; h.begin() } })
    on('pointerup', endGesture); on('pointercancel', endGesture); on('blur', endGesture)
    on('keydown', (e) => {
      const a = historyKey(e)
      if (!a || hasNativeUndo(e.target) || hasNativeUndo(target.document?.activeElement)) return
      e.preventDefault(); a === 'undo' ? api.undo() : api.redo()
    }, false)
  }
  return api
}

/**
 * The reconciler: the scene is derived from the state, never the other way. spec maps a property path on
 * `obj` to a function of the state: sync(mesh, { visible: () => state.layers.gray, 'material.opacity': () => state.gray.opacity }).
 * Applied immediately when called (so a layer that loads late shows the CURRENT state, restored or pushed)
 * and again whenever any state it read changes.
 */
export function sync(obj, spec, { onApply = () => {} } = {}) {
  return effect(() => {
    for (const [path, read] of Object.entries(spec)) {
      const v = read()
      if (v === undefined) continue
      const ks = path.split('.'), last = ks.pop()
      const holder = ks.length ? getPath(obj, ks.join('.')) : obj
      if (holder && holder[last] !== v) holder[last] = v
    }
    onApply()
  })
}

/**
 * Derived state (docs/DERIVED-STATE.md). `derive(name, { inputs, run, ...options })` declares a value that is a function of
 * state: `inputs()` reads the state (tracked, then snapshotted to plain data), `run(inputs, { signal, progress, prev })` is
 * async and runs AFTER the next paint, latest wins, cancellable. `derived[name]` is the reactive record
 * { status, value, error, progress, ... }; `pending` is { count, list } for everything in flight. The pending indicator
 * (global bottom-right spinner and the slight dim of `data-derived` views) is installed on the first derive(), so an app that
 * declares nothing gets no extra DOM. A dispatch never runs a derivation: the effect below only marks the inputs.
 */
export function createDerivedKit({ doc = globalThis.document, core = createDerived() } = {}) {
  const derived = $state({}), pending = $state({ count: 0, list: [] })
  let ui = null
  core.subscribe(() => { for (const [n, s] of core.all()) if (derived[n] !== s) derived[n] = s; pending.count = core.count; pending.list = core.running() }, { sync: true })
  function derive(name, def) {
    const { inputs, ...opts } = def
    if (typeof inputs !== 'function') throw new Error(`derive("${name}"): inputs must be a function that reads the state`)
    if (!ui) ui = installPendingUI(core, doc)
    ui.track(name)
    const off = core.define(name, opts)
    derived[name] = core.get(name)
    const stop = effect(() => { const plain = $state.snapshot(inputs()); untrack(() => core.set(name, plain)) })
    return () => { stop(); off(); delete derived[name] }
  }
  return { derive, derived, pending, core, dispose() { ui?.dispose() } }
}

export function createKit({ state, store, data, viewer, keys, ui, deps, THREE, live, history = null, derivedKit = createDerivedKit() }) {
  // writes read the pre-state (for undo); inside an effect that must not become a dependency of the effect
  const quiet = { ...store, dispatch: (...a) => untrack(() => store.dispatch(...a)), undo: () => untrack(() => store.undo()), apply: (a) => untrack(() => store.apply(a)) }
  const kit = { state, history, derive: derivedKit.derive, derived: derivedKit.derived, pending: derivedKit.pending, derivedCore: derivedKit.core, store: quiet, dispatch: quiet.dispatch, data, viewer, keys, ui, deps, THREE, live, effect, sync, selection, getPath, setPath, parts: new Map(), commands: {} }
  return kit
}

/** A part's ctx: the kit plus its own element and a cleanup list that runs (newest first) when it swaps. */
export function partContext(kit, name, root, { rank } = {}) {
  const el = document.createElement('div')
  el.dataset.part = name
  el.style.display = 'contents'
  // #qk-ui is pointer-events:none so empty UI space passes clicks to the 3D canvas; pointer-events inherits through the DOM (display:contents has no box, so no empty space is captured), so every element a part mounts is clickable by default. A part that wants pass-through (the scale bar) sets pointer-events:none on that element.
  el.style.pointerEvents = 'auto'
  root.appendChild(el)
  const cleanups = []
  const ctx = Object.assign(Object.create(kit), {
    name, el,
    cleanup(fn) { cleanups.push(fn); return fn },
    /** A derivation owned by this part: removed (and its in-flight run cancelled) when the part swaps. */
    derive(dname, def) { const off = kit.derive(dname, def); cleanups.push(off); return off },
    effect(fn) { const off = effect(fn); cleanups.push(off); return off },
    sync(obj, spec, opts) { const off = sync(obj, spec, opts); cleanups.push(off); return off },
    bindKeys(map, opts) { const off = kit.keys.bind(map, rank === undefined ? opts : { rank, ...opts }); cleanups.push(off); return off },
    onClick(fn) { const off = kit.viewer.onClick(fn); cleanups.push(off); return off },
    onFrame(fn) { const off = kit.viewer.onFrame(fn); cleanups.push(off); return off },
    /** Named actions other parts (the panel's buttons) can run; removed when this part swaps. */
    command(name, fn) { kit.commands[name] = fn; cleanups.push(() => { if (kit.commands[name] === fn) delete kit.commands[name] }); return fn },
    watch(file, fn) { const off = kit.data.watch(file, fn); cleanups.push(off); return off },
    /** Add a three.js object under the viewer's root; it is removed and its materials disposed when this part swaps. */
    add(obj, parent = kit.viewer.root) {
      parent.add(obj)
      cleanups.push(() => {
        parent.remove(obj)
        obj.traverse((o) => { const ms = o.material ? [].concat(o.material) : []; for (const m of ms) { m.map?.dispose?.(); m.dispose?.() } })
      })
      return obj
    },
    /** Mount a Svelte component into this part's element. */
    mount(Component, props = {}) {
      const c = svelteMount(Component, { target: el, props })
      cleanups.push(() => svelteUnmount(c))
      return c
    },
    /**
     * A layer fed by one data file: `build(json, scope)` runs when the file is first available and again each
     * time the file's content hash changes (a cells.json that appears or is replaced adds/swaps just that layer);
     * the scope's cleanups (scene objects, effects) run before every rebuild. Nothing else is touched.
     */
    layer(file, build) {
      let scope = null, token = 0
      const run = async () => {
        const mine = ++token
        if (!kit.data.has(file)) { scope?.dispose(); scope = null; return }
        let json
        try { json = await kit.data.json(file) } catch (e) { console.error(`[pangea-kit] ${file}`, e); return }
        if (mine !== token) return // a newer change superseded this load
        scope?.dispose()
        scope = partContext(kit, `${name}:${file}`, el, { rank }) // inside the part's own element: layer UI keeps part order whenever its data lands
        try { await build(json, scope) } catch (e) { scope.dispose(); scope = null; console.error(`[pangea-kit] layer ${file}`, e); kit.onError?.(`${name}:${file}`, e) }
      }
      const off = kit.data.watch(file, run)
      cleanups.push(() => { token++; off(); scope?.dispose() })
      return run()
    },
    dispose() { for (const f of cleanups.splice(0).reverse()) { try { f() } catch (e) { console.error(`[pangea-kit] cleanup in ${name}`, e) } } el.remove() },
  })
  return ctx
}

export { untrack }
