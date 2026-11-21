import { describe, it, expect, vi } from 'vitest'
import { createDerived } from '../lib/derived.js'
import { boundLog, trimRecord } from '../lib/logbound.js'

// Manual clock and scheduler: every test controls when "after the next paint" happens and when a fake network call answers.
const rig = (opts = {}) => {
  const queue = []
  let t = 1000
  const timers = new Map(); let tid = 0
  const d = createDerived({ schedule: (f) => queue.push(f), now: () => t, setTimer: (f, ms) => { const id = ++tid; timers.set(id, { f, at: t + ms }); return id }, clearTimer: (id) => timers.delete(id), ...opts })
  const paint = () => { for (const f of queue.splice(0)) f() }
  const tick = async (ms) => { t += ms; for (const [id, x] of [...timers]) if (x.at <= t) { timers.delete(id); x.f() } for (let i = 0; i < 5; i++) await Promise.resolve() }
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
  return { d, paint, tick, flush, timers, queue }
}
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b }); return { p, resolve, reject } }

describe('status transitions and the sync rule', () => {
  it('set() returns before the function runs; status is pending at once, ready after the answer', async () => {
    const { d, paint, flush } = rig()
    const run = vi.fn(async (x) => x.n * 2)
    d.define('dbl', { run })
    expect(d.get('dbl').status).toBe('idle')
    const t0 = performance.now()
    d.set('dbl', { n: 4 })
    expect(performance.now() - t0).toBeLessThan(5)
    expect(run).not.toHaveBeenCalled()                 // dispatch/set never runs a derivation
    expect(d.get('dbl')).toMatchObject({ status: 'pending', pending: true, hasValue: false })
    expect(d.count).toBe(1)
    paint(); await flush()
    expect(run).toHaveBeenCalledTimes(1)
    expect(d.get('dbl')).toMatchObject({ status: 'ready', value: 8, pending: false, error: null })
    expect(d.count).toBe(0)
  })

  it('same inputs are deduped; a cached key is served at once with no run', async () => {
    const { d, paint, flush } = rig()
    const run = vi.fn(async (x) => x.n)
    d.define('a', { run })
    d.set('a', { n: 1 }); paint(); await flush()
    expect(d.set('a', { n: 1 })).toBe(false)           // identical inputs: nothing to do
    d.set('a', { n: 2 }); paint(); await flush()
    d.set('a', { n: 1 })                                // back to a cached key (what undo does)
    expect(d.get('a')).toMatchObject({ status: 'ready', value: 1, cached: true })
    expect(run).toHaveBeenCalledTimes(2)
    expect(d.count).toBe(0)
  })

  it('a custom key function decides identity (inputs may be large)', async () => {
    const { d, paint, flush } = rig()
    const run = vi.fn(async () => 'v')
    d.define('k', { run, key: (i) => i.id })
    d.set('k', { id: 'a', big: [1, 2, 3] }); paint(); await flush()
    expect(d.set('k', { id: 'a', big: [9] })).toBe(false)
    expect(d.get('k').inputsKey).toBe('a')
  })
})

describe('latest wins, cancel, stale-while-revalidate', () => {
  it('a superseded run is aborted and its late answer is dropped even if it ignores the signal', async () => {
    const { d, paint, flush } = rig()
    const calls = []
    d.define('s', { run: (x, { signal }) => { const q = deferred(); calls.push({ x, q, signal }); return q.p } })
    d.set('s', { n: 1 }); paint(); await flush()
    d.set('s', { n: 2 }); paint(); await flush()
    expect(calls.length).toBe(2)
    expect(calls[0].signal.aborted).toBe(true)
    expect(calls[1].signal.aborted).toBe(false)
    calls[1].q.resolve('two'); await flush()
    expect(d.get('s')).toMatchObject({ status: 'ready', value: 'two', inputsKey: '{"n":2}' })
    calls[0].q.resolve('one-late'); await flush()       // the old one answers last: must not win
    expect(d.get('s').value).toBe('two')
  })

  it('a run superseded before it started never runs', async () => {
    const { d, paint, flush } = rig()
    const run = vi.fn(async (x) => x.n)
    d.define('s', { run })
    d.set('s', { n: 1 }); d.set('s', { n: 2 }); d.set('s', { n: 3 }); paint(); await flush()
    expect(run).toHaveBeenCalledTimes(1)
    expect(d.get('s').value).toBe(3)
  })

  it('debounce: only the last input of a burst runs', async () => {
    const { d, paint, flush, tick } = rig()
    const run = vi.fn(async (x) => x.n)
    d.define('db', { run, debounceMs: 200 })
    d.set('db', { n: 1 }); await tick(100); d.set('db', { n: 2 }); await tick(100); d.set('db', { n: 3 })
    paint(); await flush(); expect(run).not.toHaveBeenCalled()
    await tick(250); paint(); await flush()
    expect(run).toHaveBeenCalledTimes(1); expect(d.get('db').value).toBe(3)
  })

  it('keep previous: status stale with the old value while the new one computes; keep none drops it', async () => {
    const { d, paint, flush } = rig()
    const q = [deferred(), deferred()]; let i = 0
    d.define('p', { run: () => q[i++].p })
    d.set('p', { n: 1 }); paint(); await flush(); q[0].resolve('A'); await flush()
    d.set('p', { n: 2 })
    expect(d.get('p')).toMatchObject({ status: 'stale', value: 'A', hasValue: true, pending: true })
    paint(); await flush(); q[1].resolve('B'); await flush()
    expect(d.get('p')).toMatchObject({ status: 'ready', value: 'B' })
    const none = rig(); none.d.define('n', { run: async (x) => x.n, keep: 'none' })
    none.d.set('n', { n: 1 }); none.paint(); await none.flush(); none.d.set('n', { n: 2 })
    expect(none.d.get('n')).toMatchObject({ status: 'pending', value: undefined, hasValue: false })
  })

  it('cancel() aborts, keeps the previous value as ready, or idles without one', async () => {
    const { d, paint, flush } = rig()
    const calls = []
    d.define('c', { run: (x, { signal }) => { const q = deferred(); calls.push({ q, signal }); return q.p } })
    d.set('c', { n: 1 }); paint(); await flush()
    expect(d.cancel('c')).toBe(true)
    expect(calls[0].signal.aborted).toBe(true)
    expect(d.get('c')).toMatchObject({ status: 'idle', pending: false })
    calls[0].q.resolve('late'); await flush(); expect(d.get('c').status).toBe('idle')
    d.set('c', { n: 1 }); paint(); await flush(); calls[1].q.resolve('ok'); await flush()
    d.set('c', { n: 2 }); d.cancel('c')
    expect(d.get('c')).toMatchObject({ status: 'ready', value: 'ok' })
  })
})

describe('errors, retries, timeouts, offline fallback, progress (network or model call shaped work)', () => {
  it('a throw is status error with the shape and the previous value; retry() re-runs with the same inputs', async () => {
    const { d, paint, flush } = rig()
    let fail = false
    d.define('e', { run: async (x) => { if (fail) throw Object.assign(new Error('boom'), { code: 'E_BOOM' }); return x.n } })
    d.set('e', { n: 1 }); paint(); await flush()
    fail = true; d.set('e', { n: 2 }); paint(); await flush()
    expect(d.get('e')).toMatchObject({ status: 'error', value: 1, error: { message: 'boom', code: 'E_BOOM' }, pending: false })
    fail = false; expect(d.retry('e')).toBe(true)
    expect(d.get('e').status).toBe('stale'); paint(); await flush()
    expect(d.get('e')).toMatchObject({ status: 'ready', value: 2, error: null })
    expect(d.retry('e')).toBe(false)                   // nothing to retry
  })

  it('automatic retries with backoff, then success; attempt count is visible', async () => {
    const { d, paint, flush, tick } = rig()
    let n = 0
    d.define('net', { retries: 2, retryBackoffMs: 100, run: async () => { if (++n < 3) throw new Error('503'); return 'ok' } })
    d.set('net', { q: 1 }); paint(); await flush()
    expect(d.get('net')).toMatchObject({ status: 'pending', attempt: 1 })
    await tick(150); await flush()
    expect(d.get('net').attempt).toBe(2)
    await tick(250); await flush()
    expect(d.get('net')).toMatchObject({ status: 'ready', value: 'ok' }); expect(n).toBe(3)
  })

  it('timeout aborts the work and reports AsyncTimeout, even if the function ignores the signal', async () => {
    const { d, paint, flush, tick } = rig()
    let sig
    d.define('slow', { timeoutMs: 5000, run: (x, { signal }) => { sig = signal; return new Promise(() => {}) } })
    d.set('slow', { q: 1 }); paint(); await flush()
    expect(d.get('slow').status).toBe('pending')
    await tick(5001); await flush()
    expect(sig.aborted).toBe(true)
    expect(d.get('slow')).toMatchObject({ status: 'error', error: { code: 'AsyncTimeout', timeout_ms: 5000 } })
  })

  it('model calls: no timeout by default (Infinity)', async () => {
    const { d, paint, flush, tick } = rig()
    const q = deferred(); d.define('llm', { run: () => q.p })
    d.set('llm', { prompt: 'x' }); paint(); await flush(); await tick(10 * 60_000)
    expect(d.get('llm').status).toBe('pending'); q.resolve('text'); await flush(); expect(d.get('llm').value).toBe('text')
  })

  it('fallback (shrimp -> local): the primary fails, the fallback answers, via says so', async () => {
    const { d, paint, flush } = rig()
    d.define('dop', { run: async () => { throw new Error('shrimp unreachable') }, fallback: async (x, ctx, err) => `local:${x.n}:${err.message}` })
    d.set('dop', { n: 7 }); paint(); await flush()
    expect(d.get('dop')).toMatchObject({ status: 'ready', value: 'local:7:shrimp unreachable', via: 'fallback', error: null })
    expect(d.get('dop').fallbackReason.message).toBe('shrimp unreachable')
    const both = rig(); both.d.define('x', { run: async () => { throw new Error('a') }, fallback: async () => { throw new Error('b') } })
    both.d.set('x', {}); both.paint(); await both.flush()
    expect(both.d.get('x')).toMatchObject({ status: 'error', error: { message: 'b' } })
  })

  it('progress is reported for the current run only', async () => {
    const { d, paint, flush } = rig()
    const calls = []
    d.define('pr', { run: (x, { progress }) => { const q = deferred(); calls.push({ progress, q }); return q.p } })
    d.set('pr', { n: 1 }); paint(); await flush()
    calls[0].progress(0.4, 'beamforming')
    expect(d.get('pr').progress).toEqual({ fraction: 0.4, text: 'beamforming' })
    d.set('pr', { n: 2 }); paint(); await flush()
    calls[0].progress(0.9)                              // the superseded run can no longer report
    expect(d.get('pr').progress).toBe(null)
    expect(d.running()[0]).toMatchObject({ name: 'pr', status: 'pending' })
  })
})

describe('several derivations, the global count, subscribers', () => {
  it('count and running() cover every in-flight derivation; idle() resolves when all settle', async () => {
    const { d, paint, flush } = rig()
    const qs = { a: deferred(), b: deferred() }
    d.define('a', { run: () => qs.a.p, label: 'scene' }); d.define('b', { run: () => qs.b.p })
    d.set('a', { n: 1 }); d.set('b', { n: 1 }); paint(); await flush()
    expect(d.count).toBe(2); expect(d.running().map((r) => r.label)).toEqual(['scene', 'b'])
    let idled = false; d.idle().then(() => { idled = true })
    qs.a.resolve(1); await flush(); expect(d.count).toBe(1); expect(idled).toBe(false)
    qs.b.reject(new Error('x')); await flush(); await flush()
    expect(d.count).toBe(0); expect(idled).toBe(true)
  })

  it('subscribers are called once per burst (coalesced), not per change', async () => {
    const { d, paint, flush } = rig()
    d.define('a', { run: async () => 1 })
    const f = vi.fn(); d.subscribe(f)
    d.set('a', { n: 1 }); d.set('a', { n: 2 }); d.set('a', { n: 3 }); await flush()
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('redefining a name (hot-swapped part) cancels the old run; disposing removes it', async () => {
    const { d, paint, flush } = rig()
    let sig; d.define('a', { run: (x, { signal }) => { sig = signal; return new Promise(() => {}) } })
    d.set('a', { n: 1 }); paint(); await flush()
    const off = d.define('a', { run: async () => 'new' })
    expect(sig.aborted).toBe(true); expect(d.count).toBe(0)
    d.set('a', { n: 1 }); paint(); await flush(); expect(d.get('a').value).toBe('new')
    off(); expect(d.get('a')).toBe(null)
  })

  it('refuses a name that cannot be a CSS attribute value, and set() on an undefined name', () => {
    const { d } = rig()
    expect(() => d.define('a b', { run() {} })).toThrow(/must match/)
    expect(() => d.set('nope', {})).toThrow(/not defined/)
  })

  it('invalidate() drops the cache and recomputes with the same inputs', async () => {
    const { d, paint, flush } = rig(); let n = 0
    d.define('a', { run: async () => ++n })
    d.set('a', { x: 1 }); paint(); await flush()
    d.invalidate('a'); paint(); await flush()
    expect(d.get('a').value).toBe(2)
  })
})

describe('log bound (profiling fix): persisted log is bounded by bytes in O(n)', () => {
  const entry = (i, kb) => ({ id: `d:${i}`, seq: i, op: 'patch', payload: { v: 'x'.repeat(kb * 1000) }, prev: { v: 'y'.repeat(kb * 1000) } })
  it('keeps the newest suffix that fits and always the newest entry', () => {
    const log = Array.from({ length: 120 }, (_, i) => entry(i, 12))
    const kept = boundLog(log, 150_000)
    expect(kept.length).toBeGreaterThan(3); expect(kept.length).toBeLessThan(10)
    expect(kept.at(-1)).toBe(log.at(-1))
    expect(boundLog([entry(0, 500)], 1000).length).toBe(1)
    expect(boundLog(log.slice(0, 2), 1_000_000)).toHaveLength(2)
  })
  it('trimRecord does one parse and is fast on the measured case (was 1.9 s)', () => {
    const log = Array.from({ length: 120 }, (_, i) => entry(i, 12))
    const text = JSON.stringify({ version: 1, state: { a: 1 }, log })
    const t0 = performance.now(); const out = trimRecord(text, 200_000); const ms = performance.now() - t0
    expect(out.length).toBeLessThanOrEqual(200_000); expect(JSON.parse(out).log.at(-1).id).toBe('d:119')
    expect(ms).toBeLessThan(300)
    expect(trimRecord('{"log":[]}', 200_000)).toBe('{"log":[]}')
  })
})
