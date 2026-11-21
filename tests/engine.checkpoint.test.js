// lib/engine/checkpoint.js + rows.js seed/seedDone: a cold device that starts from a checkpoint (hot part first, rest in the
// background, the tail pulled meanwhile) converges to exactly the rows of a device that folded the whole log (PANGEA3-DESIGN
// §11, row #43). Seeded random logs with tombstones, revived rows, concurrent writers; every arrival order of hot, tail and
// rest; a crash after the hot part; a newer checkpoint after the crash; and a planted early seedDone that must go red.
import { describe, expect, it } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openRows, foldRows, stampOf } from '../lib/engine/rows.js'
import { createMemoryStreamServer } from '../lib/stream-fake.js'
import { splitCheckpoint, sealCheckpoint, sealPart, openPart, partHeader, coldStart, rowPatch, laterCursor } from '../lib/engine/checkpoint.js'

globalThis.IDBKeyRange ??= IDBKeyRange
const RANK = { past: 0, now: 1, next: 2 }
const sortKey = (r) => [RANK[r.zone] ?? 1, r.ord ?? 0, r.id]
const live = (r) => !r.deleted_at && r.zone !== undefined
const rng = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))
const strip = (rows) => rows.map(({ _k, _s, ...r }) => JSON.stringify({ ...sorted(r), _s: sorted(_s || {}) })).sort()
const SECRET = 'test-secret-0123456789abcdefghijklmnop'
const device = (server, opts = {}) => openRows({ name: 'doc', indexedDB: opts.idb || new IDBFactory(), transport: server, sortKey, live, Broadcast: null, ...opts })

/** A random log written straight to the server: rows created, edited, moved between zones, deleted and revived by 4 writers. */
async function writeLog(server, r, n, t0 = 1000) {
  for (let i = 0; i < n; i++) {
    const rows = []
    for (let k = 0, m = 1 + Math.floor(r() * 6); k < m; k++) {
      const id = `l${Math.floor(r() * 60)}`, w = `w${Math.floor(r() * 4)}`, s = stampOf(t0 + i * 10 + Math.floor(r() * 30), w, k)
      const x = r(), set = x < 0.15 ? { deleted_at: 'gone' } : x < 0.25 ? { deleted_at: null } : x < 0.5 ? { zone: ['past', 'now', 'next'][Math.floor(r() * 3)], ord: Math.floor(r() * 50) } : { body: `b${i}.${k}`, zone: r() < 0.5 ? 'past' : 'now', ord: Math.floor(r() * 50) }
      rows.push({ id, set, at: Object.fromEntries(Object.keys(set).map((f) => [f, s])) })
    }
    const dev = `src${i % 3}`, seq = (server.streams.get('doc')?.rows.filter((e) => e.device_id === dev).length ?? 0) + 1
    await server.push('doc', [{ entry_id: `${dev}:${seq}`, device_id: dev, device_seq: seq, event_time: new Date(i).toISOString(), payload: { type: 'rows', payload: { rows } } }])
  }
}
/** The checkpoint a writer would make at the server's current head: fold everything, split, seal. */
async function checkpointAt(server, opts = {}) {
  const log = server.streams.get('doc').rows, m = new Map()
  foldRows(m, log)
  const cut = splitCheckpoint([...m.values()], { sortKey, live, landing: (r) => (RANK[r.zone] ?? 1) >= 1, before: 5, after: 8, chunkBytes: 600, ...opts })
  return { cursor: String(log.length), parts: await sealCheckpoint({ secret: SECRET, name: 'doc', cursor: String(log.length), ...cut }), cut }
}
const fetcherOf = (ck) => async (part) => ck.parts.get(part) ?? null

describe('checkpoint: sealed parts', () => {
  it('round-trips, binds name, part and cursor, and refuses a tampered byte', async () => {
    const rows = [{ id: 'a', body: 'x', zone: 'now', _s: { body: stampOf(5, 'w'), zone: stampOf(5, 'w') } }]
    const b = await sealPart({ secret: SECRET, name: 'doc', part: 'hot', cursor: '42', rows, parts: ['rest.0'] })
    expect(partHeader(b).header).toMatchObject({ part: 'hot', cursor: '42', n: 1, parts: ['rest.0'] })
    const o = await openPart({ secret: SECRET, name: 'doc', bytes: b })
    expect(o.rows).toEqual([rowPatch(rows[0])]); expect(o.cursor).toBe('42'); expect(o.parts).toEqual(['rest.0'])
    await expect(openPart({ secret: SECRET, name: 'other', bytes: b })).rejects.toThrow()
    await expect(openPart({ secret: 'another-secret-0123456789abcdefghijk', name: 'doc', bytes: b })).rejects.toThrow()
    const t = b.slice(); t[t.length - 3] ^= 1
    await expect(openPart({ secret: SECRET, name: 'doc', bytes: t })).rejects.toThrow()
    const h = b.slice(); h.set(new TextEncoder().encode(JSON.stringify({ v: 1, name: 'doc', part: 'hot', cursor: '43', n: 1, parts: ['rest.0'] })), 4) // a header rewritten to another cursor
    await expect(openPart({ secret: SECRET, name: 'doc', bytes: h })).rejects.toThrow()
    expect(laterCursor('9', '10')).toBe('10'); expect(laterCursor(null, '3')).toBe('3')
  })
  it('split: the hot part is the landing window in sort order, every other row (tombstones too) is in exactly one rest part', () => {
    const rows = []
    for (let i = 0; i < 40; i++) rows.push({ id: `r${i}`, zone: i < 20 ? 'past' : i < 30 ? 'now' : 'next', ord: i, ...(i % 7 === 0 ? { deleted_at: 'x' } : {}), _s: { zone: 'a' } })
    const { hot, rest } = splitCheckpoint(rows, { sortKey, live, landing: (r) => r.zone === 'now', before: 3, after: 4, chunkBytes: 200 })
    expect(hot.map((r) => r.id)).toEqual(['r17', 'r18', 'r19', 'r20', 'r22', 'r23', 'r24'])
    const all = [...hot, ...rest.flat()].map((r) => r.id).sort()
    expect(all).toEqual(rows.map((r) => r.id).sort())
    expect(rest.length).toBeGreaterThan(1)
  })
})

describe('checkpoint: a cold start converges to the full fold', () => {
  it('hot, tail and rest in every order, over 30 seeded logs, equal a device that pulled the whole log', { timeout: 180_000 }, async () => {
    let cases = 0
    for (let seed = 1; seed <= 30; seed++) {
      const r = rng(seed), server = createMemoryStreamServer({ pageSize: 4 })
      await writeLog(server, r, 40)
      const ck = await checkpointAt(server)
      await writeLog(server, r, 15, 5000) // the tail after the checkpoint (newer stamps)
      const full = await device(server); await full.load({ from: null }); await full.sync()
      const want = strip(await full.all())
      for (const order of ['hot-rest-tail', 'hot-tail-rest', 'tail-during-rest']) {
        const cold = await device(server); await cold.load({ from: null })
        let release; const gate = new Promise((ok) => { release = ok }) // the rest parts arrive only when the order says so
        const cs = await coldStart({ rows: cold, secret: SECRET, name: 'doc', fetchPart: async (p) => { if (p !== 'hot' && order === 'hot-tail-rest') await gate; return ck.parts.get(p) ?? null } })
        expect(cold.seeding).toMatchObject({ from: ck.cursor })
        if (order === 'hot-rest-tail') { await cs.rest; await cold.sync() }
        else if (order === 'hot-tail-rest') { await cold.sync(); expect(cold.status().cursor).toBe(null); release(); await cs.rest }
        else { await Promise.all([cs.rest, cold.sync()]); await cold.sync() }
        expect(cold.seeding).toBe(null)
        expect(cold.status().cursor).toBe(String(server.streams.get('doc').rows.length))
        expect(strip(await cold.all())).toEqual(want)
        expect(cold.stats.pulled).toBeLessThanOrEqual(15 + 4) // only the tail (one page may straddle), never the whole log
        cases++
      }
    }
    expect(cases).toBe(90)
  })

  it('the hot part alone paints the landing window before the rest arrives', async () => {
    const server = createMemoryStreamServer(); await writeLog(server, rng(3), 60)
    const ck = await checkpointAt(server)
    const cold = await device(server); await cold.load({ from: null })
    let release; const gate = new Promise((ok) => { release = ok })
    const cs = await coldStart({ rows: cold, secret: SECRET, name: 'doc', fetchPart: async (p) => { if (p !== 'hot') await gate; return ck.parts.get(p) } })
    expect(cs.hot).toBe(ck.cut.hot.length)
    expect(cold.view.rows().map((x) => x.id).sort()).toEqual(ck.cut.hot.map((x) => x.id).sort())
    release(); await cs.rest
    expect(cold.view.size).toBe(ck.cut.hot.length + ck.cut.rest.flat().filter(live).length)
  })

  it('a crash after the hot part re-seeds on the next start (from a newer checkpoint too) and still converges', async () => {
    for (const newer of [false, true]) {
      const server = createMemoryStreamServer({ pageSize: 3 }), r = rng(newer ? 11 : 12)
      await writeLog(server, r, 30)
      const ck1 = await checkpointAt(server)
      const idb = new IDBFactory()
      const a = await device(server, { idb }); await a.load({ from: null })
      const cs = await coldStart({ rows: a, secret: SECRET, name: 'doc', fetchPart: async (p) => (p === 'hot' ? ck1.parts.get(p) : null) })
      await expect(cs.rest).rejects.toThrow(/gone/)
      await a.sync() // the tail is pulled into the seed's progress, not claimed as coverage
      expect(a.status().cursor).toBe(null)
      await a.close()
      await writeLog(server, r, 10, 4000)
      const ck2 = newer ? await checkpointAt(server) : ck1
      await writeLog(server, r, 5, 6000)
      const b = await device(server, { idb }); await b.load({ from: null })
      expect(b.seeding).not.toBe(null)
      const cs2 = await coldStart({ rows: b, secret: SECRET, name: 'doc', fetchPart: fetcherOf(ck2) })
      await cs2.rest; await b.sync()
      const full = await device(server); await full.load({ from: null }); await full.sync()
      expect(strip(await b.all())).toEqual(strip(await full.all()))
    }
  })

  it('a synced device never seeds; a device with no checkpoint pulls the whole log as before', async () => {
    const server = createMemoryStreamServer(); await writeLog(server, rng(5), 20)
    const ck = await checkpointAt(server)
    const d = await device(server); await d.load({ from: null }); await d.sync()
    expect(await coldStart({ rows: d, secret: SECRET, name: 'doc', fetchPart: fetcherOf(ck) })).toBe(null)
    const e = await device(server); await e.load({ from: null })
    expect(await coldStart({ rows: e, secret: SECRET, name: 'doc', fetchPart: async () => null })).toBe(null)
    await e.sync(); expect(strip(await e.all())).toEqual(strip(await d.all()))
  })

  it('planted: claiming the cursor after the hot part alone (seedDone before rest) loses rows (red)', async () => {
    const server = createMemoryStreamServer(); await writeLog(server, rng(9), 50)
    const ck = await checkpointAt(server)
    const full = await device(server); await full.load({ from: null }); await full.sync()
    const cold = await device(server); await cold.load({ from: null })
    await coldStart({ rows: cold, secret: SECRET, name: 'doc', fetchPart: async (p) => (p === 'hot' ? ck.parts.get(p) : new Promise(() => {})) })
    await cold.seedDone(ck.cursor) // the bug: coverage claimed with the rest parts never folded
    await cold.sync()
    expect(strip(await cold.all())).not.toEqual(strip(await full.all()))
  })
})
