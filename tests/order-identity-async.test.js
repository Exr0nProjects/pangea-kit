// Offline / identity / async layer (DESIGN-CONFORMANCE section E step 2; PANGEA3-DESIGN A7, A8, section 5 assert_version,
// section 6 errors, section 7 guards, section 8 AsyncAction/JobHandle; rows #7, #8, #12, #15, #16, #17, #18-#22, #29, #31).
// Every rule here has a planted violation that turns its check red (a test that cannot fail is a defect, CEN A25, A34).
import { describe, expect, it } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { createHlc, compareHlc } from '../lib/engine/hlc.js'
import { createApp, createReplica, declare, compareEntries, fromStreamEntry, fold } from '../lib/model.js'
import { openRows, rowVersion, stampOf, stampHlc, mergeRow } from '../lib/engine/rows.js'
import { createMemoryStreamServer } from '../lib/stream-fake.js'
import { isUlid } from '../lib/engine/ulid.js'
import { request, declareComponent } from '../lib/components.js'
import { createRequester } from '../lib/engine/request.js'
import { createSnapshot, readSnapshot, stampSnapshot } from '../lib/snapshot.js'
import { serveEngine, connectEngine, microtaskChannel } from '../lib/engine/host.js'
import { ActionError, AsyncCancelledError, AsyncTimeoutError, AsyncFailedError, ConcurrencyConflictError, InvalidActionError, InvalidTransitionError, PangeaError, SagaCompensationFailedError, errorShape } from '../lib/errors.js'
import { runConvergenceFuzz } from '../lib/testing/convergence.js'
import model from '../lib/testing/example/lines.model.js'

globalThis.IDBKeyRange ??= IDBKeyRange
const mem = () => { const m = {}; return { m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v }, removeItem: (k) => { delete m[k] } } }
const tick = () => new Promise((r) => setTimeout(r, 0))
// the planted bug for every order law: a "clock" that is raw wall time (never observes what it ingested)
const wallClock = ({ now }) => ({ tick: () => ({ ts: Math.floor(now()), l: 0 }), observe() {}, peek: () => ({ ts: Math.floor(now()), l: 0 }) })

describe('HLC (lib/engine/hlc.js): the one order source', () => {
  it('never goes backwards, orders same-millisecond events, and is later than anything it observed', () => {
    let t = 1000; const c = createHlc({ now: () => t })
    const a = c.tick(); const b = c.tick(); expect(compareHlc(b, a)).toBeGreaterThan(0); expect(b).toEqual({ ts: 1000, l: 1 })
    t = 500; const back = c.tick(); expect(compareHlc(back, b)).toBeGreaterThan(0) // wall clock stepped back: still later
    c.observe({ ts: 90_000, l: 7 }); const after = c.tick(); expect(after).toEqual({ ts: 90_000, l: 8 })
    t = 100_000; expect(c.tick()).toEqual({ ts: 100_000, l: 0 })
    expect(createHlc({ now: () => 1, last: { ts: 5000, l: 2 } }).tick()).toEqual({ ts: 5000, l: 3 }) // restored: no reissue
  })
})

const doc = () => declare({ name: 'doc', initial: { title: '', items: [] }, actions: {
  title: (s, { title }) => (s.title === title ? s : { ...s, title }),
  add: (s, { text }) => ({ ...s, items: [...s.items, text] }), // not idempotent by design: two identical adds are two items
} })

describe('model.js: order is the HLC, advanced on ingest (A8, census A26)', () => {
  // device z's clock runs 60 s ahead; device a saw z's write and edits after it. Device ids put a before z in the
  // tie-break, so only the clock can order a's edit after z's.
  async function skewed(clock) {
    const server = createMemoryStreamServer(); let t = 1_700_000_000_000
    const Z = createReplica(doc(), { storage: mem(), device: 'z', now: () => t + 60_000, transport: server, clock })
    const A = createReplica(doc(), { storage: mem(), device: 'a', now: () => t, transport: server, clock })
    Z.dispatch('title', { title: 'from the future' }); await Z.sync()
    await A.sync(); t += 5; A.dispatch('title', { title: 'edited after seeing it' }); await A.sync(); await Z.sync()
    return { A, Z, server }
  }
  it('a device whose clock runs behind orders its later edit after what it saw, on every replica', async () => {
    const { A, Z, server } = await skewed(undefined)
    expect(A.get().title).toBe('edited after seeing it'); expect(Z.get().title).toBe('edited after seeing it')
    const all = server.streams.get('doc').rows.map(fromStreamEntry).sort(compareEntries)
    expect(all.map((e) => e.device)).toEqual(['z', 'a'])
    expect(A.clock.ts).toBeGreaterThanOrEqual(1_700_000_060_000) // the clock advanced on ingest
  })
  it('planted: raw wall time as the order loses the edit (red)', async () => {
    const { A, Z } = await skewed(wallClock)
    expect(A.get().title).toBe('from the future'); expect(Z.get().title).toBe('from the future')
  })
  it('same millisecond on two devices: the second, having seen the first, orders after it', async () => {
    const run = async (clock) => {
      const server = createMemoryStreamServer()
      const Z = createReplica(doc(), { storage: mem(), device: 'z', now: () => 1000, transport: server, clock })
      const A = createReplica(doc(), { storage: mem(), device: 'a', now: () => 1000, transport: server, clock })
      Z.dispatch('title', { title: 'first' }); await Z.sync(); await A.sync()
      A.dispatch('title', { title: 'second' }); await A.sync(); await Z.sync()
      return [A.get().title, Z.get().title]
    }
    expect(await run(undefined)).toEqual(['second', 'second'])
    expect(await run(wallClock)).toEqual(['first', 'first']) // planted: (ts, device) tie-break puts a before z
  })
  it('the clock survives a reload (persisted with the record) and orders the entries the record holds', async () => {
    const st = mem(); const server = createMemoryStreamServer()
    const r1 = createReplica(doc(), { storage: st, device: 'd', now: () => 5000, transport: server })
    r1.dispatch('title', { title: 'x' }); r1.dispatch('title', { title: 'y' }); r1.flush()
    const r2 = createReplica(doc(), { storage: st, device: 'd', now: () => 10, transport: server }) // wall clock reset
    const e = r2.dispatch('title', { title: 'z' })
    expect(compareEntries(e, r2.pending[1])).toBeGreaterThan(0); expect(e.ts).toBe(5000)
  })
})

describe('identity minted once (A7): ULID intents, idempotent by id', () => {
  it('every entry gets a ULID; two identical actions are two intents; a retried id is a no-op', () => {
    const r = createApp({ storage: mem(), device: 'd', engine: false }).use(doc())
    const a = r.dispatch('add', { text: 'same' }), b = r.dispatch('add', { text: 'same' })
    expect(isUlid(a.id) && isUlid(b.id)).toBe(true); expect(a.id).not.toBe(b.id)
    expect(r.get().items).toEqual(['same', 'same'])
    const c = r.dispatch('add', { text: 'retry' }, { id: 'intent-1' }); const again = r.dispatch('add', { text: 'retry' }, { id: 'intent-1' })
    expect(again).toBe(c); expect(r.get().items).toEqual(['same', 'same', 'retry']); expect(r.pending.length).toBe(3)
  })
  it('the intent id rides the Stream entry and is remembered after a reload', async () => {
    const st = mem(); const server = createMemoryStreamServer()
    const r1 = createReplica(doc(), { storage: st, device: 'd', transport: server })
    r1.dispatch('add', { text: 'x' }, { id: 'once' }); await r1.sync(); r1.flush()
    expect(server.streams.get('doc').rows[0].payload.id).toBe('once')
    const r2 = createReplica(doc(), { storage: st, device: 'd', transport: server })
    expect(r2.dispatch('add', { text: 'x' }, { id: 'once' })).not.toBe(undefined)
    expect(r2.get().items).toEqual(['x'])
  })
  it('planted: an id from a content hash collapses two identical intents (red)', () => {
    const r = createApp({ storage: mem(), device: 'd', engine: false }).use(doc())
    const hashId = (type, p) => `h:${type}:${JSON.stringify(p)}`
    r.dispatch('add', { text: 'same' }, { id: hashId('add', { text: 'same' }) }); r.dispatch('add', { text: 'same' }, { id: hashId('add', { text: 'same' }) })
    expect(r.get().items).toEqual(['same']) // the second, a real second intent, was dropped
  })
})

const D = { sortKey: (r) => [r.ord ?? 0, r.id], live: (r) => !r.deleted_at }
const rowsOpen = (idb, server, extra = {}) => openRows({ name: 'step2-rows', indexedDB: idb, transport: server, sortKey: D.sortKey, live: D.live, Broadcast: null, locks: null, ...extra })

describe('rows.js: HLC stamps, intents, assert_version', () => {
  it('stamps are HLC times: a later tick sorts later; an old-format stamp of the same millisecond sorts below', () => {
    expect(stampOf(1000, 'w', 2) > stampOf(1000, 'w', 1)).toBe(true)
    expect(stampOf(1000, 'a', 1) > `${(1000).toString(36).padStart(9, '0')}.zzzz.0000009`).toBe(true)
    expect(stampHlc(stampOf(1234, 'w', 5))).toEqual({ ts: 1234, l: 5 })
  })
  async function behindOverwrites(clock) {
    const server = createMemoryStreamServer()
    const ahead = await rowsOpen(new IDBFactory(), server, { now: () => Date.now() + 60_000 })
    const behind = await rowsOpen(new IDBFactory(), server, { clock })
    await ahead.load({ from: null }); await behind.load({ from: null })
    ahead.put([{ id: 'l1', set: { body: 'from the future', ord: 1 } }]); await ahead.sync(); await behind.sync()
    behind.put([{ id: 'l1', set: { body: 'edit' } }])
    const local = behind.view.get('l1')?.body
    await behind.flushed(); await behind.sync(); await ahead.sync()
    const out = { local, ahead: ahead.view.get('l1').body }
    await ahead.close(); await behind.close()
    return out
  }
  it('a device whose clock runs behind overwrites a value from a device ahead (no stamp floor: the clock observed it)', async () => {
    expect(await behindOverwrites(undefined)).toEqual({ local: 'edit', ahead: 'edit' })
  })
  it('planted: a wall-clock stamp loses the local edit (red)', async () => {
    expect(await behindOverwrites(wallClock)).toEqual({ local: 'from the future', ahead: 'from the future' })
  })
  it('a reopened tab is later than everything this browser wrote (the clock is on disk), even at the same millisecond', async () => {
    const run = async (clock) => {
      const idb = new IDBFactory(), server = createMemoryStreamServer()
      const a = await rowsOpen(idb, server, { now: () => 1000, clock }); await a.load({ from: [5] }) // loads nothing: row not observed
      a.put([{ id: 'r', set: { body: 'old', ord: 1 } }]); await a.flushed(); await a.close()
      const b = await rowsOpen(idb, server, { now: () => 1000, clock }); await b.load({ from: [5] })
      b.put([{ id: 'r', set: { body: 'new' } }]); await b.flushed()
      const row = (await b.all()).find((x) => x.id === 'r'); await b.close(); return row.body
    }
    expect(await run(undefined)).toBe('new')
    // planted: without the persisted clock, a same-millisecond write of the unloaded row ties on (ts, l) and the
    // writer id decides; across 12 random writer ids the new edit loses at least once
    const results = []; for (let i = 0; i < 12; i++) results.push(await run(wallClock))
    expect(results).toContain('old')
  })
  it('intents: a put is idempotent by its intent (also after a reopen); identical content with new intents applies twice', async () => {
    const idb = new IDBFactory(), server = createMemoryStreamServer()
    const a = await rowsOpen(idb, server); await a.load({ from: null })
    expect(a.put([{ id: 'n', set: { body: 'x', ord: 1 } }], { intent: 'I1' }).length).toBe(1)
    expect(a.put([{ id: 'n', set: { body: 'y' } }], { intent: 'I1' })).toEqual([])
    expect(a.view.get('n').body).toBe('x')
    await a.flushed(); expect((await a.pending())[0].intent).toBe('I1')
    await a.sync(); expect(server.streams.get('step2-rows').rows[0].payload.payload.rows[0].intent).toBe('I1')
    await a.close()
    const b = await rowsOpen(idb, server); await b.load({ from: null })
    expect(b.put([{ id: 'n', set: { body: 'z' } }], { intent: 'I1' })).toEqual([])
    const s1 = b.put([{ id: 'n', set: { body: 'q' } }])[0]._s.body, s2 = b.put([{ id: 'n', set: { body: 'q' } }])[0]?._s.body
    expect(s2 > s1).toBe(true) // a second intent with identical content is a second write, not collapsed
    await b.close()
  })
  it('assert_version: a put against a row that moved is refused whole, nothing applied', async () => {
    const a = await rowsOpen(new IDBFactory(), createMemoryStreamServer()); await a.load({ from: null })
    a.put([{ id: 'v', set: { body: 'one', ord: 1 } }])
    const seen = rowVersion(a.view.get('v'))
    a.put([{ id: 'v', set: { body: 'two' } }]) // someone else's write since the caller looked
    expect(() => a.put([{ id: 'v', set: { body: 'mine' } }, { id: 'w', set: { body: 'also', ord: 2 } }], { assertVersion: { v: seen } })).toThrow(ConcurrencyConflictError)
    expect(a.view.get('v').body).toBe('two'); expect(a.view.get('w')).toBeUndefined()
    a.put([{ id: 'v', set: { body: 'mine' } }], { assertVersion: { v: rowVersion(a.view.get('v')), x: null } })
    expect(a.view.get('v').body).toBe('mine')
    await a.close()
  })
})

describe('model.js: assert_version, guards, typed errors', () => {
  it('assertVersion refuses a stale write with ConcurrencyConflictError and logs nothing', () => {
    const r = createApp({ storage: mem(), device: 'd', engine: false }).use(doc())
    const v = r.version; r.dispatch('title', { title: 'a' })
    let err; try { r.dispatch('title', { title: 'b' }, { assertVersion: v }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ConcurrencyConflictError); expect(err.status).toBe(409)
    expect(err).toMatchObject({ expected_version: v, actual_version: v + 1 })
    expect(r.get().title).toBe('a'); expect(r.pending.length).toBe(1)
    r.dispatch('title', { title: 'c' }, { assertVersion: r.version }); expect(r.get().title).toBe('c')
  })
  it('version is equal on converged replicas (entries folded), so a version read on one device holds on another', async () => {
    const server = createMemoryStreamServer()
    const A = createApp({ storage: mem(), device: 'A', transport: server, engine: false }).use(doc())
    const B = createApp({ storage: mem(), device: 'B', transport: server, engine: false }).use(doc())
    A.dispatch('add', { text: '1' }); B.dispatch('add', { text: '2' }); await A.sync(); await B.sync(); await A.sync()
    expect(A.version).toBe(2); expect(B.version).toBe(2)
  })
  const guarded = () => declare({ name: 'g', scope: 'local', initial: { owner: 'al', title: '' },
    actions: { title: (s, { title }) => (s.title === title ? s : { ...s, title }) },
    guards: { title: [(s, a) => (a.actor && a.actor !== s.owner ? { code: 'NOT_AUTHORIZED', message: 'owner only', resolution: { type: 'none', message: 'ask the owner' } } : null)] } })
  it('a guard refuses at dispatch with an ActionError (403 + resolution) before the reducer; nothing changes', () => {
    const r = createApp({ storage: mem(), device: 'd', engine: false }).use(guarded())
    let err; try { r.dispatch('title', { title: 'x' }, { actor: 'mallory' }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ActionError); expect(err.code).toBe('NOT_AUTHORIZED'); expect(err.status).toBe(403); expect(err.resolution.message).toBe('ask the owner')
    expect(r.get().title).toBe(''); expect(r.version).toBe(0)
    r.dispatch('title', { title: 'ok' }, { actor: 'al' }); expect(r.get().title).toBe('ok')
  })
  it('guards decide at acceptance only: a fold applies an accepted entry whatever the guards say now', () => {
    const d = guarded(); expect(fold(d, d.initial, [{ type: 'title', payload: { title: 'remote' } }]).title).toBe('remote')
  })
  it('a malformed guards declaration is refused at declare', () => {
    expect(() => declare({ name: 'g2', initial: {}, actions: { a: (s) => s }, guards: { b: [() => null] } })).toThrow(/undeclared action/)
    expect(() => declare({ name: 'g3', initial: {}, actions: { a: (s) => s }, guards: { a: 'no' } })).toThrow(/non-empty list/)
  })
  it('refusals are typed: unknown action, lifecycle edge, terminal state (codes kept for callers)', () => {
    const life = declare({ name: 'life', scope: 'ephemeral', initial: { state: 'a' }, states: ['a', 'b', 'c'], transitions: { a: ['b'], b: ['c'], c: [] }, terminal: ['c'],
      actions: { go: (s, { to }) => ({ ...s, state: to }) } })
    const r = createApp({ storage: mem(), device: 'd', engine: false }).use(life)
    expect(() => r.dispatch('nope')).toThrow(InvalidActionError)
    let e1; try { r.dispatch('go', { to: 'c' }) } catch (e) { e1 = e }
    expect(e1).toBeInstanceOf(InvalidTransitionError); expect(e1).toMatchObject({ code: 'InvalidTransition', from_state: 'a', to_state: 'c', valid_next: ['b'] })
    r.dispatch('go', { to: 'b' }); r.dispatch('go', { to: 'c' })
    let e2; try { r.dispatch('go', { to: 'a' }) } catch (e) { e2 = e }
    expect(e2.code).toBe('TerminalState'); expect(e2.valid_next).toEqual([])
  })
  it('the error hierarchy: kinds, statuses, deterministic rendering, requires_human always true', () => {
    const e = new ConcurrencyConflictError({ entity_type: 't', entity_id: 'i', expected_version: 1, actual_version: 2 })
    expect(e).toBeInstanceOf(PangeaError); expect(e.kind).toBe('runtime'); expect(e.message).toBe('ConcurrencyConflictError(entity_type="t", entity_id="i", expected_version=1, actual_version=2)')
    expect(new AsyncTimeoutError({ job_id: 'j', timeout_ms: 5 }).transient).toBe(true)
    expect(new SagaCompensationFailedError({ saga_id: 's', failed_step: 1, failed_comp: 0, requires_human: false }).requires_human).toBe(true)
    expect(errorShape(new ActionError({ code: 'RATE_LIMITED', message: 'slow down' }))).toMatchObject({ name: 'ActionError', code: 'RATE_LIMITED', message: 'slow down' })
  })
})

// a manual timer queue for deadlines
const timers = () => { let n = 0; const q = new Map(); return { setTimer: (f, ms) => { const id = ++n; q.set(id, { f, ms }); return id }, clearTimer: (id) => q.delete(id), fire: () => { for (const [id, t] of [...q]) { q.delete(id); t.f() } }, size: () => q.size } }
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b }); return { p, resolve, reject } }

describe('async answers: request() + createRequester (AsyncAction lifecycle as kit state, JobHandle)', () => {
  const setup = (comp = request(), opts = {}) => {
    const r = createApp({ storage: mem(), device: 'd', engine: false }).use(declare(declareComponent('req', comp, { scope: 'ephemeral' })))
    const tm = timers(); let id = 0
    const runner = createRequester(r, { setTimer: tm.setTimer, clearTimer: tm.clearTimer, mint: () => `01J00000000000000000000${String(++id).padStart(3, '0')}`, ...opts })
    return { r, tm, runner }
  }
  it('pending -> running -> completed; JobHandle reports status, progress and the result', async () => {
    const { r, runner } = setup(); const d = deferred()
    const job = runner.run(({ progress }) => { progress(0.5, 'half'); return d.p })
    await tick(); expect(job.status()).toBe('running'); expect(job.progress()).toEqual({ value: 0.5, text: 'half' })
    d.resolve({ hits: 3 }); await expect(job.await_completion()).resolves.toEqual({ hits: 3 })
    expect(r.get()).toMatchObject({ status: 'completed', result: { hits: 3 }, progress: 1 }); expect(job.job_type).toBe('async_action')
  })
  it('latest wins: a superseded request is aborted and its late answer is dropped', async () => {
    const { r, runner } = setup(); const d1 = deferred(), d2 = deferred(); let sig1
    const j1 = runner.run(({ signal }) => { sig1 = signal; return d1.p }); const j2 = runner.run(() => d2.p)
    await tick(); expect(sig1.aborted).toBe(true); expect(j1.status()).toBe('superseded')
    d1.resolve('old'); d2.resolve('new'); await j2.await_completion()
    expect(r.get().result).toBe('new'); await expect(j1.await_completion()).rejects.toBeInstanceOf(AsyncCancelledError)
  })
  it('planted: an answer reducer that ignores the request id lets the stale answer win (red)', async () => {
    const base = request(); const leaky = { ...base, actions: { ...base.actions, complete: (s, { result = null }) => (s.status === 'running' ? { ...s, status: 'completed', result, progress: 1 } : s) } }
    const { r, runner } = setup(leaky); const d1 = deferred(), d2 = deferred()
    runner.run(() => d1.p); runner.run(() => d2.p); await tick()
    d1.resolve('old'); await tick(); await tick(); d2.resolve('new'); await tick(); await tick()
    expect(r.get().result).toBe('old')
  })
  it('the deadline fails the request with AsyncTimeoutError, aborts the work, and a late answer is a no-op', async () => {
    const { r, tm, runner } = setup(); const d = deferred(); let sig
    const job = runner.run(({ signal }) => { sig = signal; return d.p }, { deadlineMs: 50 }); await tick()
    tm.fire(); expect(sig.aborted).toBe(true); expect(job.status()).toBe('failed')
    await expect(job.await_completion()).rejects.toBeInstanceOf(AsyncTimeoutError)
    d.resolve('late'); await tick(); await tick(); expect(r.get().status).toBe('failed'); expect(r.get().result).toBe(null)
  })
  it('cancel aborts the signal, ends in cancelled, result() throws AsyncCancelledError; a failure keeps its code', async () => {
    const { runner } = setup(); let sig
    const job = runner.run(({ signal }) => { sig = signal; return new Promise(() => {}) }); await tick()
    expect(job.cancel()).toBe(true); expect(sig.aborted).toBe(true); expect(job.status()).toBe('cancelled')
    expect(() => job.result()).toThrow(AsyncCancelledError); expect(job.cancel()).toBe(false)
    const j2 = runner.run(() => Promise.reject(Object.assign(new Error('offline'), { code: 'E_NET' })))
    const err = await j2.await_completion().catch((e) => e); expect(err).toBeInstanceOf(AsyncFailedError); expect(err.code).toBe('E_NET')
  })
  it('duplicate and late lifecycle actions are no-ops at dispatch (intent ids <request>.<op>) and in the reducer', async () => {
    const { r, runner } = setup(); const job = runner.run(() => 'v'); await job.await_completion()
    const before = r.get()
    expect(r.dispatch('complete', { id: job.job_id, result: 'again' }, { id: `${job.job_id}.complete` })).not.toBe(undefined)
    r.dispatch('complete', { id: job.job_id, result: 'again' }); r.dispatch('fail', { id: job.job_id, error: 'X' })
    expect(r.get()).toBe(before)
  })
  it('declares a waits exit edge for pending and running (a spinner that cannot be stuck forever)', () => {
    const c = request({ deadline_ms: 5000 }); expect(c.waits.pending).toEqual({ deadline_ms: 5000, to: 'failed' }); expect(c.transitions.pending).toContain('failed'); expect(c.transitions.running).toContain('failed')
    expect(declareComponent('x', c).waits).toEqual(c.waits)
  })
})

describe('cursor-stamped snapshots (lib/snapshot.js) and engine patches (host.js epoch)', () => {
  it('a snapshot derived at another cursor is rejected and rebuilt; the current one is a hit', () => {
    const r = createApp({ storage: mem(), device: 'd', engine: false }).use(declare({ name: 's', scope: 'local', initial: { n: 0 }, actions: { set: (s, { n }) => (s.n === n ? s : { n }) } }))
    const st = mem(); let derived = 0
    const snap = createSnapshot({ key: 'n2', storage: st, source: r, derive: (s) => { derived += 1; return s.n * 2 } })
    expect(snap.read()).toBe(0); r.dispatch('set', { n: 4 })
    expect(snap.peek()).toMatchObject({ value: 0, stale: true })
    expect(snap.read()).toBe(8); expect(snap.read()).toBe(8); expect(derived).toBe(2)
    expect(snap.stats()).toMatchObject({ hits: 1, rejected: 1 })
    const again = createSnapshot({ key: 'n2', storage: st, source: r, derive: () => { throw new Error('should hit') } })
    expect(again.read()).toBe(8) // a reload reads the stored snapshot because its cursor still matches
    // planted: a reader that ignores the cursor shows the stale projection (red)
    r.dispatch('set', { n: 5 }); const naive = JSON.parse(st.getItem('qk-snap:n2')).value; expect(naive).toBe(8)
    expect(readSnapshot(JSON.parse(st.getItem('qk-snap:n2')), r.version)).toBeUndefined()
    expect(readSnapshot(stampSnapshot('v', { a: 1 }), { a: 1 })).toBe('v')
  })
  it('rows.version advances with every committed write (the cursor for a snapshot of rows)', async () => {
    const a = await rowsOpen(new IDBFactory(), createMemoryStreamServer()); await a.load({ from: null })
    const v0 = a.version; a.put([{ id: 'x', set: { body: '1', ord: 1 } }]); await a.flushed(); expect(a.version).toBe(v0 + 1)
    await a.ingest([{ payload: { type: 'rows', payload: { rows: [{ id: 'y', set: { body: 'r', ord: 2 }, at: { body: stampOf(9e12, 'z', 0), ord: stampOf(9e12, 'z', 0) } }] } } }])
    expect(a.version).toBe(v0 + 2); expect(a.clock.ts).toBe(9e12) // ingest advanced the clock
    await a.close()
  })
  it('a tab never applies a patch from another engine incarnation (epoch), even when the rev numbers line up', async () => {
    // a scripted engine: hand-written snap/patch messages on a channel, so the test controls epoch and rev exactly
    const ports = []; const fake = { connect: (p) => { ports.push(p); p.onmessage = () => {} } }
    const ch = microtaskChannel
    const client = connectEngine({ name: 'e', local: () => fake, prefer: 'local', channel: ch })
    await tick(); const port = ports[0]
    port.postMessage({ t: 'snap', epoch: 'E1', rev: 3, state: { n: 1 }, status: null }); await tick()
    port.postMessage({ t: 'patch', epoch: 'E2', from: 3, to: 4, p: null, status: null }); await tick()
    expect(client.state()).toEqual({ n: 1 }); expect(client.stats().resyncs).toBe(1)
    // the real engine stamps its epoch on both
    const server = serveEngine({ methods: {}, view: () => ({ k: 1 }), schedule: (f) => f() }); expect(typeof server.epoch).toBe('string')
    client.close()
  })
})

describe('convergence harness on the kit HLC', () => {
  it('planted: rows stamped from raw wall time lose local writes under clock skew (red)', () => {
    const r = runConvergenceFuzz({ ...model, clock: (now) => wallClock({ now }) }, { seeds: 60, modes: ['concurrent'] })
    expect(r.ok).toBe(false); expect(r.failures.map((f) => f.error).join('\n')).toMatch(/local write lost|diverged/)
  })
})
