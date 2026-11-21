// lib/engine/rows.js: keyed rows for big documents (zai2). Convergence over seeded interleavings, coalescing, the
// crash-between-push-and-ack retry, pagination by sort key, reload, and the order independence of the merge.
import { describe, expect, it } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openRows, foldRows, mergeRow, stampOf } from '../lib/engine/rows.js'
import { createMemoryStreamServer } from '../lib/stream-fake.js'

globalThis.IDBKeyRange ??= IDBKeyRange
const RANK = { past: 0, now: 1, next: 2 }
const sortKey = (r) => [RANK[r.zone] ?? 1, r.ord ?? 0, r.id]
const live = (r) => !r.deleted_at && r.zone !== undefined
const rng = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const visible = (doc) => doc.view.rows().map((r) => `${r.zone}:${r.ord}:${r.body}`)
const strip = (rows) => rows.map(({ _s, _k, ...r }) => Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1)))).sort((a, b) => (a.id < b.id ? -1 : 1))

const device = (server, opts = {}) => openRows({ name: 'doc', indexedDB: opts.idb || new IDBFactory(), transport: server, sortKey, live, Broadcast: null, ...opts })

describe('rows: per-field LWW rows over the Stream', () => {
  it('merge is commutative and idempotent: any order of the same entries gives the same rows', () => {
    const r = rng(7)
    const entries = []
    for (let i = 0; i < 60; i++) entries.push({ payload: { type: 'rows', payload: { rows: [{ id: `l${Math.floor(r() * 6)}`, set: { body: `v${i}`, ord: Math.floor(r() * 9) }, at: { body: stampOf(1000 + Math.floor(r() * 50), `d${i % 3}`, i), ord: stampOf(1000 + i, 'd', i) } }] } } })
    const ref = new Map(); foldRows(ref, entries)
    for (let k = 0; k < 20; k++) {
      const shuffled = [...entries].sort(() => r() - 0.5)
      const m = new Map(); foldRows(m, shuffled); foldRows(m, shuffled.slice(0, 10)) // redelivery
      expect(JSON.stringify([...m].sort())).toBe(JSON.stringify([...ref].sort()))
    }
    expect(mergeRow(undefined, { id: 'x', set: { _k: 1 }, at: { _k: 'z' } })).toBe(undefined) // internal fields never travel
  })

  it('three devices converge over 40 seeded runs with offline gaps', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed), server = createMemoryStreamServer({ pageSize: 3 })
      let t = 1_700_000_000_000
      const devs = await Promise.all([0, 1, 2].map(() => device(server, { now: () => (t += Math.floor(r() * 5)) })))
      for (const d of devs) await d.load({ from: null })
      for (let step = 0; step < 30; step++) {
        const d = devs[Math.floor(r() * 3)]
        const x = r()
        if (x < 0.6) d.put([{ id: `l${Math.floor(r() * 8)}`, set: r() < 0.5 ? { body: `s${seed}-${step}`, zone: 'now', ord: Math.floor(r() * 5) } : { deleted_at: r() < 0.3 ? 'gone' : null, zone: 'past' } }])
        else if (x < 0.8) { server.state.offline = r() < 0.4; await d.sync().catch(() => {}) }
        else await d.flushed()
      }
      server.state.offline = false
      for (let k = 0; k < 2; k++) for (const d of devs) await d.sync()
      const all = await Promise.all(devs.map(async (d) => JSON.stringify(strip(await d.all()))))
      if (new Set(all).size !== 1) console.log(seed, all.join('\n'), JSON.stringify(devs.map(d=>d.status())))
      expect(new Set(all).size, `seed ${seed}`).toBe(1)
      const views = devs.map((d) => JSON.stringify(visible(d)))
      expect(new Set(views).size, `seed ${seed}`).toBe(1)
      for (const d of devs) await d.close()
    }
  })

  it('coalesces: 60 keystrokes on one line are one row in one Stream entry', async () => {
    const server = createMemoryStreamServer()
    const d = await device(server)
    await d.load({ from: null })
    let body = ''
    for (const ch of 'the quick brown fox jumps over the lazy dog, then naps a bit'.split('')) { body += ch; d.put([{ id: 'a', set: { body, zone: 'now', ord: 1 } }]) }
    await d.sync()
    expect(server.streams.get('doc').rows.length).toBe(1)
    expect(server.streams.get('doc').rows[0].payload.payload.rows).toHaveLength(1)
    expect(await d.pending()).toEqual([])
    const cold = await device(server); await cold.load({ from: null }); await cold.sync()
    expect(cold.view.rows().map((x) => x.body)).toEqual([body])
  })

  it('a lost ack re-sends the identical entry (idempotent duplicate), and edits made meanwhile stay pending', async () => {
    const server = createMemoryStreamServer()
    const idb = new IDBFactory()
    let fail = true
    const flaky = { push: async (s, rows) => { await server.push(s, rows); if (fail) throw new Error('ack lost') }, pull: (s, c) => server.pull(s, c) }
    const d = await device(flaky, { idb })
    await d.load({ from: null })
    d.put([{ id: 'a', set: { body: 'one', zone: 'now', ord: 1 } }])
    await expect(d.sync()).rejects.toThrow('ack lost')
    d.put([{ id: 'a', set: { body: 'one two' } }])
    await d.close()
    fail = false
    const again = await device(flaky, { idb }) // reload: same device, the outgoing entry is still on disk
    await again.load({ from: null })
    await again.sync()
    const rows = server.streams.get('doc').rows
    expect(rows.map((e) => e.device_seq)).toEqual([1, 2])
    expect(rows[1].payload.payload.rows[0].set).toEqual({ body: 'one two' })
    expect(await again.pending()).toEqual([])
  })

  it('paginates by sort key: newest part first, older pages prepend in order, deleted rows never load', async () => {
    const server = createMemoryStreamServer()
    const rows = []
    for (let i = 0; i < 1000; i++) rows.push({ id: `p${String(i).padStart(4, '0')}`, set: { zone: 'past', ord: i, body: `past ${i}`, deleted_at: i % 10 === 0 ? 'x' : null } })
    for (let i = 0; i < 5; i++) rows.push({ id: `n${i}`, set: { zone: 'now', ord: i, body: `now ${i}` } })
    // write, close, reopen the same database: what a reload sees
    const idb2 = new IDBFactory()
    const e = await device(server, { idb: idb2 })
    e.put(rows); await e.close()
    const r = await device(server, { idb: idb2 })
    expect(await r.load({ from: [1] })).toBe(5)
    expect(r.view.rows().map((x) => x.id)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4'])
    expect(await r.loadOlder(100)).toBe(100)
    expect(r.view.at(0).id).toBe('p0889') // 999 back to 889, skipping the deleted (multiples of 10)
    let pages = 1
    while (await r.loadOlder(100)) pages++
    expect(r.reachedStart).toBe(true)
    expect(r.view.size).toBe(905)
    const keys = r.view.rows().map((x) => (x.zone === 'past' ? 0 : 10000) + x.ord)
    expect(keys).toEqual([...keys].sort((a, b) => a - b))
    // a remote edit to a row above the loaded window stays out of memory until its page loads
    const s = await device(server, { idb: new IDBFactory() })
    await s.load({ from: [1] })
    await s.ingest([{ payload: { type: 'rows', payload: { rows: [{ id: 'p0005', set: { zone: 'past', ord: 5, body: 'edited' }, at: { zone: stampOf(9e12, 'z', 1), ord: stampOf(9e12, 'z', 1), body: stampOf(9e12, 'z', 1) } }] } } }])
    expect(s.view.has('p0005')).toBe(false)
    await s.loadOlder(10)
    expect(s.view.has('p0005')).toBe(true)
    r.close(); s.close()
  })
})

describe('rows: scope separates the on-device copy, never the stream', () => {
  it('two scopes on one IndexedDB keep their own rows and outbox while both push to the stream named by `name`', async () => {
    const idb = new IDBFactory(), pushed = []
    const transport = { async push(name, rows) { pushed.push([name, rows.length]); return { ok: true } }, async pull() { return { entries: [], cursor: '0', more: false } } }
    const a = await openRows({ name: 'doc', scope: 'u_a', indexedDB: idb, transport, sortKey, live, Broadcast: null })
    const b = await openRows({ name: 'doc', scope: 'u_b', indexedDB: idb, transport, sortKey, live, Broadcast: null })
    await a.load({ from: null }); await b.load({ from: null })
    a.put([{ id: 'only-a', set: { body: 'a line', zone: 'now', ord: 1 } }])
    await a.flushed(); await b.flushed(); await a.sync(); await b.sync()
    expect(a.view.has('only-a')).toBe(true)
    expect(b.view.has('only-a')).toBe(false)
    a.close(); b.close()
    const again = await openRows({ name: 'doc', scope: 'u_b', indexedDB: idb, transport, sortKey, live, Broadcast: null })
    await again.load({ from: null })
    expect(again.view.has('only-a')).toBe(false)
    const back = await openRows({ name: 'doc', scope: 'u_a', indexedDB: idb, transport, sortKey, live, Broadcast: null })
    await back.load({ from: null })
    expect(back.view.has('only-a')).toBe(true)
    expect(pushed.length).toBeGreaterThan(0)
    expect(pushed.every(([n]) => n === 'doc')).toBe(true) // the stream name carries no scope
    again.close(); back.close()
    // planted: without a scope the two share one copy (the old behaviour), proving the test can fail
    const x = await openRows({ name: 'doc', indexedDB: idb, transport, sortKey, live, Broadcast: null }), y = await openRows({ name: 'doc', indexedDB: idb, transport, sortKey, live, Broadcast: null })
    await x.load({ from: null })
    x.put([{ id: 'shared', set: { body: 's', zone: 'now', ord: 2 } }]); await x.flushed()
    await y.load({ from: null })
    expect(y.view.has('shared')).toBe(true)
    x.close(); y.close()
  })
})


describe('rows: rewriteSet', () => {
  it('lets the app add the fields a write implies (the first text in an empty row stamps created_at)', async () => {
    const server = createMemoryStreamServer({ pageSize: 3 })
    let t = 1_700_000_000_000
    const rewriteSet = (cur, set) => (cur && !(cur.body || '').trim() && (set.body || '').trim() && !set.created_at ? { ...set, created_at: new Date(t).toISOString() } : set)
    const d = await device(server, { now: () => t, rewriteSet })
    await d.load({ from: null })
    d.put([{ id: 'a', set: { zone: 'now', ord: 1, body: '', created_at: 'old' } }])
    t += 5000
    d.put([{ id: 'a', set: { body: 'hello' } }])
    expect(d.view.rows().find((r) => r.id === 'a').created_at).toBe(new Date(t).toISOString())
    t += 5000
    d.put([{ id: 'a', set: { body: 'hello again' } }]) // a non-empty row keeps its date
    expect(d.view.rows().find((r) => r.id === 'a').created_at).toBe(new Date(t - 5000).toISOString())
  })
})
