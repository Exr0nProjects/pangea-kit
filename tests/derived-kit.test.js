import { describe, it, expect } from 'vitest'
import { flushSync } from 'svelte'
import { makeState, createKit, partContext, trackHistory, createDerivedKit } from '../host/kit.svelte.js'
import { createStore } from '../lib/store.js'
import { createDerived } from '../lib/derived.js'
import { stripTransient } from '../lib/util.js'

// The host binding: state -> inputs -> derivation -> reactive record, the indicator DOM, and the rules that matter to the
// owner: a dispatch is synchronous and never runs a derivation; undo restores inputs and the derivation re-runs.
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b }); return { p, resolve, reject } }
const mk = () => {
  const queue = [], state = makeState(); Object.assign(state, { preset: 'a', n: 1, _info: '' })
  const core = createDerived({ schedule: (f) => queue.push(f) })
  const kit = createKit({ state, store: createStore({ state }), derivedKit: createDerivedKit({ core }) })
  const paint = async () => { for (const f of queue.splice(0)) f(); for (let i = 0; i < 30; i++) await Promise.resolve() }
  return { state, kit, core, queue, paint }
}

describe('kit.derive binding', () => {
  it('dispatch returns before the derivation runs; the record is pending at once and ready after paint', async () => {
    const { state, kit, paint } = mk()
    const q = deferred(); let ran = 0
    kit.derive('scene', { inputs: () => ({ preset: state.preset }), run: (i) => { ran++; return q.p.then(() => `scene:${i.preset}`) } })
    flushSync(); await paint()
    q.resolve(); await paint()
    expect(kit.derived.scene).toMatchObject({ status: 'ready', value: 'scene:a' })
    const t0 = performance.now()
    kit.dispatch('set', { path: 'preset', value: 'b' }); flushSync()
    const dt = performance.now() - t0
    expect(dt).toBeLessThan(20)
    expect(ran).toBe(1)                                  // not run synchronously by the dispatch
    expect(kit.derived.scene).toMatchObject({ status: 'stale', value: 'scene:a', pending: true })
    expect(kit.pending.count).toBe(1)
    expect(document.documentElement.getAttribute('data-qk-pending')).toBe('scene')
    await paint(); expect(ran).toBe(2); await paint()
    expect(kit.derived.scene).toMatchObject({ status: 'ready', value: 'scene:b' })
    expect(document.documentElement.hasAttribute('data-qk-pending')).toBe(false)
  })

  it('the indicator: a bottom-right spinner element, a dim rule for data-derived views, nothing before the first derive', async () => {
    document.head.innerHTML = ''; document.body.innerHTML = ''
    const { kit, state } = mk()
    expect(document.getElementById('qk-derived')).toBe(null)         // an app that declares nothing gets no DOM
    kit.derive('scene', { inputs: () => state.n, run: async () => 1 })
    flushSync()
    const box = document.getElementById('qk-derived')
    expect(box).toBeTruthy(); expect(box.querySelector('.qk-dspin')).toBeTruthy()
    const css = document.getElementById('qk-derived-style').textContent
    expect(css).toMatch(/right:12px;bottom:30px/)
    expect(css).toMatch(/html\[data-qk-pending~="scene"\] \[data-derived~="scene"\]\{opacity:0\.85\}/)
    expect(css).toMatch(/animation:qk-dspin/)
  })

  it('undo restores the inputs and the derivation re-runs (cache hit: ready at once)', async () => {
    const { state, kit, paint } = mk()
    let ran = 0
    kit.derive('scene', { inputs: () => ({ n: state.n }), run: async (i) => { ran++; return i.n * 10 } })
    const h = trackHistory(state, { limit: 10, coalesceMs: 0 }, null)
    flushSync(); await paint(); expect(kit.derived.scene.value).toBe(10)
    kit.dispatch('set', { path: 'n', value: 2 }); flushSync(); await paint(); await paint()
    expect(kit.derived.scene.value).toBe(20)
    h.undo(); flushSync()
    expect(state.n).toBe(1)
    expect(kit.derived.scene).toMatchObject({ status: 'ready', value: 10, cached: true })   // inputs restored, derivation served from its cache
    expect(ran).toBe(2)
    h.redo(); flushSync(); expect(kit.derived.scene.value).toBe(20)
  })

  it('derived values are never persisted: they are not in the state tree, and a _ key written from them is stripped', async () => {
    const { state, kit, paint } = mk()
    kit.derive('scene', { inputs: () => state.n, run: async (n) => ({ big: new Array(100).fill(n) }) })
    flushSync(); await paint()
    expect(kit.derived.scene.value.big.length).toBe(100)
    expect(JSON.stringify(stripTransient(state))).not.toContain('big')
    expect(Object.keys(state)).not.toContain('derived')
  })

  it('a part-owned derivation is cancelled and removed when the part swaps', async () => {
    const { state, kit, paint } = mk()
    const root = document.createElement('div'); document.body.appendChild(root)
    const ctx = partContext(kit, 'p', root)
    let sig; ctx.derive('x', { inputs: () => state.n, run: (n, { signal }) => { sig = signal; return new Promise(() => {}) } })
    flushSync(); await paint(); expect(kit.pending.count).toBe(1)
    ctx.dispose()
    expect(sig.aborted).toBe(true); expect(kit.derived.x).toBeUndefined(); expect(kit.pending.count).toBe(0)
  })

  it('network-shaped derivation: simulated latency, failure, retry from the record', async () => {
    const { state, kit, core, paint } = mk()
    let fail = true
    kit.derive('llm', { inputs: () => ({ n: state.n }), run: async (i) => { await new Promise((r) => setTimeout(r, 20)); if (fail) throw new Error('503'); return `answer ${i.n}` } })
    flushSync(); await paint(); await new Promise((r) => setTimeout(r, 40)); await paint()
    expect(kit.derived.llm).toMatchObject({ status: 'error', error: { message: '503' } })
    fail = false; core.retry('llm'); await paint(); await new Promise((r) => setTimeout(r, 40)); await paint()
    expect(kit.derived.llm).toMatchObject({ status: 'ready', value: 'answer 1' })
  })
})
