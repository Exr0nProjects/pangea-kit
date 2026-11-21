// Unit tests for lib/engine: identity, deadlines, the telemetry lane, jobs, the durable outbox and its sender, the
// replica store, offline search, patches and the host transports.
import { describe, expect, it } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { isUlid, ulidFactory } from '../lib/engine/ulid.js'
import { createDeadlineFetch } from '../lib/engine/deadline.js'
import { createTelemetryLane } from '../lib/engine/lane.js'
import { createJobs, ledger } from '../lib/engine/jobs.js'
import { BackpressureError, createSender, memoryOutbox, openOutbox } from '../lib/engine/outbox.js'
import { openReplicaStore } from '../lib/engine/replica-store.js'
import { searchStore } from '../lib/engine/search.js'
import { apply, diff } from '../lib/engine/patch.js'
import { connectEngine, serveEngine } from '../lib/engine/host.js'

globalThis.IDBKeyRange ??= IDBKeyRange
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

describe('ulid', () => {
  it('is monotonic inside one millisecond and well formed', () => {
    const u = ulidFactory({ now: () => 1700000000000 })
    const ids = Array.from({ length: 50 }, u)
    expect(ids.every(isUlid)).toBe(true)
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(50)
  })
})

describe('deadline classes', () => {
  it('aborts past the class deadline and counts it', async () => {
    const net = createDeadlineFetch(() => new Promise(() => {}), { deadlines: { send: 20 } })
    await expect(net.fetchWithin('send', '/x')).rejects.toMatchObject({ name: 'DeadlineError' })
    expect(net.stats().send.deadline).toBe(1)
  })
  it('a newer request with the same key supersedes a stalled one', async () => {
    const signals = []
    const net = createDeadlineFetch((url, init) => new Promise((resolve, reject) => {
      signals.push(init.signal); init.signal.addEventListener('abort', () => reject(new Error('aborted')))
      if (url === '/b') setTimeout(() => resolve({ ok: true, url }), 5)
    }), { deadlines: { read: 1000 } })
    const a = net.fetchWithin('read', '/a', {}, { key: 'k' })
    const b = net.fetchWithin('read', '/b', {}, { key: 'k' })
    await expect(a).rejects.toMatchObject({ name: 'SupersededError' })
    await expect(b).resolves.toMatchObject({ url: '/b' })
    expect(signals[0].aborted).toBe(true)
  })
})

describe('telemetry lane', () => {
  it('is bounded and drops the oldest', () => {
    const lane = createTelemetryLane({ maxItems: 3, setTimer: () => 0 })
    for (let i = 0; i < 10; i++) lane.push({ i })
    expect(lane.depth()).toBe(3)
    expect(lane.counts().dropped).toBe(7)
  })
  it('a failed send drops the batch instead of retrying it', async () => {
    const lane = createTelemetryLane({ send: async () => { throw new Error('down') }, setTimer: () => 0 })
    lane.push({ a: 1 }); await lane.flush()
    expect(lane.counts()).toMatchObject({ failed: 1, depth: 0 })
  })
})

describe('jobs', () => {
  it('N triggers during a run cost at most two runs', async () => {
    const jobs = createJobs()
    let runs = 0
    const work = async () => { runs++; await tick(5) }
    const all = []
    for (let i = 0; i < 35; i++) all.push(jobs.run('evict', work)) // 35 appends cross the budget during one scan
    await Promise.all(all)
    expect(runs).toBeLessThanOrEqual(2)
    expect(jobs.stats().evict.coalesced).toBe(34)
  })
  it('the ledger orders eviction outside the window first', () => {
    const b = ledger()
    b.add('old', 10, 1, '2026-01-01'); b.add('recent', 10, 1, '2026-11-07'); b.add('older', 10, 1, '2025-01-01')
    expect(b.evictionOrder({ keepAfter: '2026-11-01' }).map((p) => p.id)).toEqual(['older', 'old', 'recent'])
    expect(b.total()).toBe(30); b.remove('old'); expect(b.total()).toBe(20)
  })
})

describe('durable outbox', () => {
  it('commits before put resolves, survives a reopen, and is idempotent by id', async () => {
    const indexedDB = new IDBFactory()
    const box = await openOutbox({ indexedDB, name: 'o' })
    await box.put([{ id: 'A', stream: 's', body: { text: 'hi' } }])
    expect(await box.put([{ id: 'A', stream: 's', body: { text: 'changed' } }])).toBe(0)
    box.close()
    const again = await openOutbox({ indexedDB, name: 'o' })
    const rows = await again.all()
    expect(rows.map((r) => [r.id, r.body.text])).toEqual([['A', 'hi']])
  })
  it('refuses with a typed error when full; nothing is dropped', async () => {
    const box = memoryOutbox({ limits: { maxItems: 2 } })
    await box.put([{ id: 'a', body: 1 }, { id: 'b', body: 2 }])
    expect(() => box.admit(1)).toThrow(BackpressureError)
    expect((await box.all()).length).toBe(2)
  })
  it('the sender retries under the same id until delivered, in order per stream', async () => {
    const box = memoryOutbox()
    const seen = []
    let fail = 3
    const sender = createSender({ outbox: box, retryMs: [1], send: async (e) => { seen.push(e.id); if (fail-- > 0) throw new Error('down'); return { ok: true, status: 200 } } })
    const id1 = await sender.enqueue('s', { n: 1 }, { id: 'X1' })
    const id2 = await sender.enqueue('s', { n: 2 }, { id: 'X2' })
    for (let i = 0; i < 50 && box.size().items; i++) await tick(3)
    expect(box.size().items).toBe(0)
    expect(seen.filter((x) => x === id1).length).toBe(4)
    expect(seen.indexOf(id2)).toBeGreaterThan(seen.lastIndexOf(id1))
  })
  it('a permanent refusal is handed back, not retried', async () => {
    const box = memoryOutbox(); const refused = []
    const sender = createSender({ outbox: box, onRefused: (e) => refused.push(e.id), send: async () => ({ ok: false, status: 400 }) })
    await sender.enqueue('s', { n: 1 }, { id: 'R' }); await sender.kick()
    expect(refused).toEqual(['R']); expect(box.size().items).toBe(0)
  })
})

const rec = (key, part, at = '2026-11-08T00:00:00Z', text = 'x'.repeat(100)) => ({ key, part, at, text })

describe('replica store', () => {
  it('accounting is incremental and duplicate-safe, and persists across a reopen', async () => {
    const indexedDB = new IDBFactory()
    const s = await openReplicaStore({ indexedDB, name: 'r' })
    await s.append([rec(1, 'a'), rec(2, 'a'), rec(3, 'b')])
    const bytes = s.usage().bytes
    await s.append([rec(2, 'a'), rec(3, 'b')]) // re-delivered page
    expect(s.usage().bytes).toBe(bytes)
    expect(s.stats().duplicates).toBe(2)
    s.close()
    const t = await openReplicaStore({ indexedDB, name: 'r' })
    expect(t.usage()).toMatchObject({ bytes, records: 3, parts: 2 })
    expect((await t.readLatest('a', 1)).map((r) => r.key)).toEqual([2])
    expect((await t.readBefore('a', 2)).map((r) => r.key)).toEqual([1])
  })
  it('evicts least recent partitions outside the window first, single-flight', async () => {
    const now = Date.parse('2026-11-08T00:00:00Z')
    const s = await openReplicaStore({ indexedDB: new IDBFactory(), name: 'e', now: () => now, policy: { budgetBytes: 2000, windowMs: 7 * 864e5 } })
    let k = 0
    for (const [part, at] of [['old', '2026-09-01'], ['mid', '2026-10-15'], ['new', '2026-11-07']]) await s.append(Array.from({ length: 6 }, () => rec(++k, part, at)))
    await s.evict()
    await s.idle()
    const parts = s.parts().map((p) => p.id).sort()
    expect(parts).toContain('new')
    expect(parts).not.toContain('old')
    expect(s.usage().bytes).toBeLessThanOrEqual(2000)
  })
})

describe('offline search', () => {
  it('finds partitions where every token appears, and reports coverage', async () => {
    const s = await openReplicaStore({ indexedDB: new IDBFactory(), name: 's' })
    await s.append([rec(1, 'a', '', 'the onda tank quote'), rec(2, 'b', '', 'tank only'), rec(3, 'c', '', 'nothing')])
    const r = await searchStore(s, 'onda tank', { titles: [{ id: 'b', title: 'Onda' }] })
    expect(r.hits.map((h) => h.part).sort()).toEqual(['a', 'b'])
    expect(r).toMatchObject({ complete: true, scanned: 3 })
  })
})

describe('patches', () => {
  it('apply(prev, diff(prev, next)) equals next, and a streamed item is a one-item splice', () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ i }))
    const prev = { rev: 1, conversations: { a: { t: 1 }, b: { t: 2 } }, items: { a: items }, seen: new Map() }
    const next = { ...prev, rev: 2, conversations: { a: prev.conversations.a, c: { t: 3 } }, items: { a: [...items.slice(0, 999), { i: 'x' }] } }
    const p = diff(prev, next, { maps: ['conversations', 'items'], skip: ['seen'] })
    expect(p.maps.items.splice.a[2]).toEqual([{ i: 'x' }])
    const got = apply(structuredClone(prev), structuredClone(p))
    expect(got.conversations).toEqual(next.conversations)
    expect(got.items.a).toEqual(next.items.a)
  })
})

function counterServer() {
  let state = { n: 0, log: {} }
  const subs = new Set()
  return serveEngine({
    methods: { add: (id) => { if (!state.log[id]) { state = { n: state.n + 1, log: { ...state.log, [id]: true } }; for (const f of subs) f() } return state.n } },
    view: () => state, subscribe: (f) => subs.add(f), diffOptions: { maps: ['log'] }
  })
}

describe('host transports', () => {
  it('local: snapshot then patches; calls resolve after the patch that shows their effect', async () => {
    const c = connectEngine({ name: 't', local: counterServer, prefer: 'local' })
    await c.ready
    expect(await c.call('add', 'a')).toBe(1)
    await tick(5)
    expect(c.state().n).toBe(1)
    expect(c.kind).toBe('local')
  })
  it('shared: two tabs on one engine see each other', async () => {
    const server = counterServer()
    const shared = () => { const ch = new MessageChannel(); server.connect(ch.port1); return { port: ch.port2 } }
    const a = connectEngine({ name: 's', shared, hasShared: true })
    const b = connectEngine({ name: 's', shared, hasShared: true })
    await a.ready; await b.ready
    await a.call('add', 'x'); await b.call('add', 'x'); await b.call('add', 'y')
    await tick(10)
    expect(a.state().n).toBe(2); expect(b.state().n).toBe(2)
    expect(a.kind).toBe('shared')
  })
  it('leader: one tab runs the engine; when it goes, the next takes over and calls are re-sent', async () => {
    // a fake lock manager with a queue; release() frees the holder (its tab "closed")
    const queue = []; let holder = null
    const grant = () => { if (!holder && queue.length) { holder = queue.shift(); Promise.resolve(holder.cb()).then(() => { holder = null; grant() }) } }
    const nav = (who) => ({ locks: { request: (name, cb) => { queue.push({ who, cb }); grant() } } })
    const servers = []
    const local = () => { const s = counterServer(); servers.push(s); return s }
    const a = connectEngine({ name: 'L', local, nav: nav('a'), hasShared: false, hasWorker: false })
    const b = connectEngine({ name: 'L', local, nav: nav('b'), hasShared: false, hasWorker: false })
    await a.ready; await tick(20); await b.ready
    expect(a.kind).toBe('leader')
    expect(await b.call('add', 'p')).toBe(1)
    await tick(20)
    expect(a.state().n).toBe(1)
    expect(servers.length).toBe(1)
    a.close()                              // the leader's tab closes: b is next in the lock queue
    const late = b.call('add', 'q')        // sent while the hand-over happens; re-sent to the new engine
    await tick(20)
    expect(b.kind).toBe('leader')
    expect(servers.length).toBe(2)
    expect(await late).toBeGreaterThanOrEqual(1)
  })
})
