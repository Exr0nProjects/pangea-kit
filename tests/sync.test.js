import { describe, it, expect } from 'vitest'
import { flushSync } from 'svelte'
import * as THREE from 'three'
import { makeState, sync, effect } from '../host/kit.svelte.js'
import { createStore } from '../lib/store.js'
import { selection } from '../lib/components.js'
import { applyPatch } from '../lib/util.js'

// The scene is DERIVED from the store: set store keys, the scene objects' properties match, including for a layer
// that is created after the state was already restored or pushed (the desync that came from DOM and mesh being two sources of truth).
const initial = () => ({ gray: { opacity: 0.12, visible: true }, grubb: { on: { 0: true, 3: false } }, cells: { opacity: 1, on: {} } })
const mk = () => { const state = makeState(); Object.assign(state, initial()); return { state, store: createStore({ state }) } }

describe('reconciler: store -> scene', () => {
  it('sets properties from the store and follows every later change', () => {
    const { state, store } = mk()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
    const off = sync(mesh, { visible: () => state.gray.visible, 'material.opacity': () => state.gray.opacity })
    flushSync()
    expect([mesh.visible, mesh.material.opacity]).toEqual([true, 0.12])
    store.dispatch('set', { path: 'gray.opacity', value: 0.7 }); store.dispatch('set', { path: 'gray.visible', value: false })
    flushSync()
    expect([mesh.visible, mesh.material.opacity]).toEqual([false, 0.7])
    off()
    store.dispatch('set', { path: 'gray.opacity', value: 0.2 }); flushSync()
    expect(mesh.material.opacity).toBe(0.7) // a disposed reconciler no longer writes
  })

  it('a layer that loads AFTER the state was restored shows the restored state at once', () => {
    const { state, store } = mk()
    store.dispatch('patch', { grubb: { on: { 3: true } }, cells: { on: { astrocyte: false } } }) // a restore or a push, before any mesh exists
    const g3 = new THREE.Mesh(), astro = new THREE.Mesh()
    sync(g3, { visible: () => state.grubb.on[3] === true })
    sync(astro, { visible: () => state.cells.on.astrocyte !== false })
    flushSync()
    expect(g3.visible).toBe(true)
    expect(astro.visible).toBe(false)
  })

  it('a push names only what it sets: other controls and the camera are untouched', () => {
    const { state, store } = mk()
    store.dispatch('set', { path: 'camera', value: { p: [1, 2, 3], t: [0, 0, 0] } })
    const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    sync(m, { 'material.opacity': () => state.gray.opacity, visible: () => state.gray.visible })
    store.apply({ id: 'push-1', op: 'patch', payload: { gray: { opacity: 1 } } })
    flushSync()
    expect(state.camera).toEqual({ p: [1, 2, 3], t: [0, 0, 0] })
    expect([m.material.opacity, m.visible, state.gray.visible]).toEqual([1, true, true])
  })

  it('an effect that writes transient info through dispatch does not loop or re-run itself', () => {
    const { state, store } = mk()
    store.component('sel', selection())
    let runs = 0
    effect(() => { runs++; store.dispatch('set', { path: '_selInfo', value: `n=${state.sel.ids.length}` }) })
    flushSync()
    store.dispatch('sel/set', { ids: [1, 2, 3] }); flushSync()
    expect(state._selInfo).toBe('n=3')
    expect(runs).toBeLessThan(5)
  })

  it('applyPatch on a $state proxy invalidates only the touched leaf', () => {
    const { state } = mk()
    const seen = []
    effect(() => { seen.push(['opacity', state.gray.opacity]) })
    effect(() => { seen.push(['visible', state.gray.visible]) })
    flushSync()
    applyPatch(state, { gray: { opacity: 0.5 } }); flushSync()
    expect(seen).toEqual([['opacity', 0.12], ['visible', true], ['opacity', 0.5]])
  })
})

describe('persistence follows state, not only dispatch', () => {
  it('a direct (bind:value style) write persists, debounced; _ keys and no-ops do not', async () => {
    const { vi } = await import('vitest')
    const { persistOnChange } = await import('../host/kit.svelte.js')
    const { schedulePersist, flushPersist } = await import('../lib/persist.js')
    vi.useFakeTimers()
    try {
      const state = makeState(); Object.assign(state, { bars: { opacity: 0.9 }, _hover: 'x' })
      const writes = []
      const storage = { getItem: () => null, setItem: (k, v) => writes.push(JSON.parse(v)) }
      const store = createStore({ state, onAction: () => schedulePersist('k', 1, state, { storage }) })
      const off = persistOnChange(state, () => schedulePersist('k', 1, state, { storage }))
      flushSync(); vi.advanceTimersByTime(1000)
      expect(writes).toHaveLength(0) // boot writes nothing
      state._hover = 'y'; flushSync(); vi.advanceTimersByTime(1000)
      expect(writes).toHaveLength(0) // ephemeral key
      state.bars.opacity = 0.4 // what bind:value does: no dispatch
      state.bars.opacity = 0.4 // same value again: no-op
      flushSync(); vi.advanceTimersByTime(1000)
      expect(writes).toHaveLength(1)
      expect(writes[0].state).toEqual({ bars: { opacity: 0.4 } })
      expect(store.log).toHaveLength(0) // the op log is untouched by a bound write
      store.dispatch('set', { path: 'bars.opacity', value: 0.2 }, { undoable: true }); flushSync(); vi.advanceTimersByTime(1000)
      expect(writes.at(-1).state.bars.opacity).toBe(0.2)
      store.undo(); flushSync(); vi.advanceTimersByTime(1000)
      expect(writes.at(-1).state.bars.opacity).toBe(0.4)
      off(); flushPersist('k')
    } finally { vi.useRealTimers() }
  })
})
