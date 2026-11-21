// localOutbox (lib/engine/outbox-local.js): A2's outbox contract, synchronous, over Web Storage.
//   - differential against memoryOutbox, the contract's reference, over seeded op sequences (300 seeds);
//   - the outbox law (no loss, one id, exactly once) with createSender, as engine.laws.test.js states it;
//   - synchronous read at first render, two tabs on one storage, refusal is loud;
//   - legacy import once, and on-ack retirement from the old key (a rolled-back build finds exactly what is owed).
import { describe, expect, it } from 'vitest'
import { createSender, memoryOutbox, BackpressureError } from '../lib/engine/outbox.js'
import { localOutbox } from '../lib/engine/outbox-local.js'
import { ulidFactory } from '../lib/engine/ulid.js'

function rng(seed) { let s = seed | 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const flushMicro = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve() }

export function memoryStorage({ refuse = () => false } = {}) {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (refuse(k, v)) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e } m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size },
    dump: () => Object.fromEntries(m)
  }
}

const strip = (rows) => rows.map((r) => ({ id: r.id, stream: r.stream, body: r.body, size: r.size }))

describe('localOutbox matches the contract reference (memoryOutbox)', () => {
  it('300 seeds x 40 ops: put, delete, all, has, size, admit give the same answers', async () => {
    let compared = 0
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed)
      const limits = { maxItems: 3 + Math.floor(r() * 10), maxBytes: 200 + Math.floor(r() * 2000) }
      const ref = memoryOutbox({ limits })
      const box = localOutbox({ storage: memoryStorage(), key: 'k', limits })
      const ids = Array.from({ length: 8 }, (_, i) => `id${i}`)
      for (let step = 0; step < 40; step++) {
        const roll = r()
        const pick = () => ids[Math.floor(r() * ids.length)]
        let a, b
        if (roll < 0.35) {
          const entries = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({ id: pick(), stream: `s${Math.floor(r() * 2)}`, body: { t: Math.floor(r() * 1e6), pad: 'x'.repeat(Math.floor(r() * 80)) } }))
          a = await ref.put(entries); b = await box.put(entries)
        } else if (roll < 0.55) { const del = [pick(), pick()]; a = await ref.delete(del); b = await box.delete(del) }
        else if (roll < 0.7) { const s = r() < 0.5 ? null : 's1'; a = strip(await ref.all(s)); b = strip(await box.all(s)) }
        else if (roll < 0.8) { const id = pick(); a = ref.has(id); b = box.has(id) }
        else if (roll < 0.9) { a = ref.size(); b = box.size() }
        else { const n = Math.floor(r() * 400); const t = (o) => { try { o.admit(n); return 'ok' } catch (e) { return e instanceof BackpressureError ? 'full' : 'other' } }; a = t(ref); b = t(box) }
        expect(b, `seed ${seed} step ${step}`).toEqual(a)
        compared += 1
      }
    }
    expect(compared).toBe(12_000)
  })
})

describe('outbox law on localOutbox: no loss, one id per intent, exactly once at an idempotent server', () => {
  it('holds over 60 random failure schedules', async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed)
      const box = localOutbox({ storage: memoryStorage(), key: 'law', limits: { maxItems: 1000 } })
      const applied = new Map()
      const send = async (e) => {
        const roll = r()
        if (roll < 0.3) throw new Error('network')
        if (roll < 0.4) return { ok: false, status: 503 }
        if (roll < 0.5) { applied.set(e.id, applied.get(e.id) || 1); throw new Error('lost reply after apply') }
        if (!applied.has(e.id)) applied.set(e.id, 1)
        return { ok: true, status: 200 }
      }
      const timers = []
      const sender = createSender({ outbox: box, send, mintId: ulidFactory({ now: () => seed * 1000 }), retryMs: [1], setTimer: (fn) => { timers.push(fn); return timers.length }, clearTimer: () => {} })
      const enqueued = []
      for (let i = 0; i < 1 + Math.floor(r() * 12); i++) enqueued.push(await sender.enqueue(`s${Math.floor(r() * 3)}`, { i }))
      for (let round = 0; round < 400 && box.size().items; round++) { await flushMicro(); const t = timers.shift(); if (t) t(); else await sender.kick() }
      expect(box.size().items, `seed ${seed}`).toBe(0)
      expect([...applied.keys()].sort()).toEqual([...enqueued].sort())
      expect([...applied.values()].every((n) => n === 1)).toBe(true)
    }
  })
})

describe('synchronous, shared, loud', () => {
  it('a row put is readable at once, with no await, by this box and by a second tab on the same storage', () => {
    const storage = memoryStorage()
    const tab1 = localOutbox({ storage, key: 'room' })
    const tab2 = localOutbox({ storage, key: 'room' })
    expect(tab1.putSync([{ id: 'a', stream: 'r', body: { text: 'hi' } }])).toBe(1)
    expect(tab2.rows().map((x) => x.body.text)).toEqual(['hi'])
    tab2.putSync([{ id: 'b', stream: 'r', body: { text: 'two' } }])
    tab1.deleteSync(['a'])
    expect(tab2.rows().map((x) => x.id)).toEqual(['b'])
    expect(tab1.patchSync('b', (b) => ({ ...b, attempts: 1 }))).toBe(true)
    expect(tab2.rows()[0].body).toEqual({ text: 'two', attempts: 1 })
    expect(tab1.patchSync('zz', (b) => b)).toBe(false)
  })
  it('storage that refuses the write throws (the row is not durable), and nothing half-written is read back', () => {
    const storage = memoryStorage({ refuse: () => true })
    const box = localOutbox({ storage, key: 'q' })
    expect(() => box.putSync([{ id: 'a', body: 1 }])).toThrow(/Quota/u)
    expect(box.rows()).toEqual([])
  })
  it('unreadable JSON reads as empty and is kept aside, not overwritten', () => {
    const storage = memoryStorage()
    storage.setItem('q', '{not json')
    const box = localOutbox({ storage, key: 'q', now: () => 7 })
    expect(box.rows()).toEqual([])
    expect(storage.getItem('__archive__q__7')).toBe('{not json')
  })
})

describe('legacy import and on-ack retirement', () => {
  const legacy = [{
    key: 'old-unsent',
    entries: (raw) => JSON.parse(raw).map((e) => ({ id: e.id, stream: 'room', body: e })),
    remove: (raw, ids) => { const kept = JSON.parse(raw).filter((e) => !ids.has(e.id)); return kept.length ? JSON.stringify(kept) : null }
  }]
  it('imports once; an entry leaves the old key only when it leaves the outbox; a rollback finds exactly what is owed', () => {
    const storage = memoryStorage()
    storage.setItem('old-unsent', JSON.stringify([{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }]))
    const box = localOutbox({ storage, key: 'new', legacy })
    expect(box.rows().map((r) => r.id)).toEqual(['a', 'b'])
    // the old key is untouched by the import: a rollback right now sees both
    expect(JSON.parse(storage.getItem('old-unsent')).map((e) => e.id)).toEqual(['a', 'b'])
    box.deleteSync(['a']) // delivered
    expect(JSON.parse(storage.getItem('old-unsent')).map((e) => e.id)).toEqual(['b'])
    // a new entry is not written to the old key (it belongs to this build's sender)
    box.putSync([{ id: 'c', stream: 'room', body: { id: 'c', text: 'three' } }])
    expect(JSON.parse(storage.getItem('old-unsent')).map((e) => e.id)).toEqual(['b'])
    // the old build writes to its key again (rolled back, then forward): no re-import, this key already exists
    storage.setItem('old-unsent', JSON.stringify([{ id: 'b', text: 'two' }, { id: 'x', text: 'old build' }]))
    expect(localOutbox({ storage, key: 'new', legacy }).rows().map((r) => r.id)).toEqual(['b', 'c'])
    box.deleteSync(['b'])
    expect(JSON.parse(storage.getItem('old-unsent')).map((e) => e.id)).toEqual(['x'])
  })
})

describe('replaceSync: a caller that owns an ordered list', () => {
  it('takes the listed order, keeps held rows (same seq), commits new ones, retires the dropped from the old key', () => {
    const storage = memoryStorage()
    storage.setItem('old', JSON.stringify([{ id: 'a' }, { id: 'b' }]))
    const box = localOutbox({ storage, key: 'k', legacy: [{ key: 'old', entries: (raw) => JSON.parse(raw).map((e) => ({ id: e.id, body: e })), remove: (raw, ids) => JSON.stringify(JSON.parse(raw).filter((e) => !ids.has(e.id))) }] })
    const seqA = box.rows()[0].seq
    expect(box.replaceSync([{ id: 'c', body: { id: 'c' } }, { id: 'a', body: { id: 'a', n: 1 } }, { id: 'c', body: 'dup' }])).toEqual({ put: 1, deleted: 1 })
    expect(box.rows().map((r) => [r.id, r.body])).toEqual([['c', { id: 'c' }], ['a', { id: 'a', n: 1 }]])
    expect(box.rows()[1].seq).toBe(seqA)
    expect(JSON.parse(storage.getItem('old')).map((e) => e.id)).toEqual(['a'])
    expect(box.replaceSync([{ id: 'c', body: { id: 'c' } }, { id: 'a', body: { id: 'a', n: 1 } }])).toEqual({ put: 0, deleted: 0 })
  })
})
