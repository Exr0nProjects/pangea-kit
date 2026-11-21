// Local outboxes and per-key states (webchat phases 4, 6, 7, 8): `durable` (read-modify-write against storage, saved
// before dispatch returns), `dropEmpty` (no record for a state equal to its initial value), and `legacy` entries with
// `archive: true` on a local state (the old key moved to `__archive__<key>` once the imported record is on disk).
import { describe, expect, it } from 'vitest'
import { createApp, createReplica, declare } from '../lib/model.js'
import { field, on, set } from '../lib/schema.js'

const mem = (init = {}) => { const m = { ...init }; const st = { m, writes: [], getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { st.writes.push(k); m[k] = String(v) }, removeItem: (k) => { st.writes.push(`-${k}`); delete m[k] } }; return st }
const box = (extra = {}) => declare({
  name: 'box', scope: 'local', durable: true, dropEmpty: true,
  fields: { items: field([], (v) => (Array.isArray(v) ? v : [])) },
  actions: {
    add: on('items', (items, { id }) => (items.some((x) => x.id === id) ? items : [...items, { id }])),
    drop: on('items', (items, { id }) => items.filter((x) => x.id !== id)),
  },
  ...extra,
})

describe('durable local state (an outbox)', () => {
  it('is on disk before dispatch returns, not on the next tick', () => {
    const st = mem()
    const r = createApp({ storage: st, device: 'd', schedule: () => {} }).use(box()) // a schedule that never runs
    r.dispatch('add', { id: 'a' })
    expect(JSON.parse(st.m['qk:box']).base.items).toEqual([{ id: 'a' }])
  })
  it('adopts what another tab wrote before applying its own action (no clobber)', () => {
    const st = mem()
    const a = createApp({ storage: st, device: 'a' }).use(box())
    const b = createApp({ storage: st, device: 'b' }).use(box())
    a.dispatch('add', { id: 'x' })
    b.dispatch('add', { id: 'y' }) // b hydrated before x existed
    expect(JSON.parse(st.m['qk:box']).base.items.map((i) => i.id)).toEqual(['x', 'y'])
    expect(a.get().items.map((i) => i.id)).toEqual(['x', 'y']) // a read sees the disk
  })
  it('an add of an id already there is a no-op and writes nothing (idempotent replay)', () => {
    const st = mem()
    const r = createApp({ storage: st, device: 'd' }).use(box())
    r.dispatch('add', { id: 'a' })
    const n = st.writes.length
    expect(r.dispatch('add', { id: 'a' })).toBe(null)
    expect(st.writes.length).toBe(n)
  })
  it('a failed save keeps the change in memory and reports it; the next dispatch retries', () => {
    const st = mem(); const errors = []
    const set0 = st.setItem; let fail = true
    st.setItem = (k, v) => { if (fail && k === 'qk:box') throw new Error('quota'); set0(k, v) }
    const r = createReplica(box(), { storage: st, device: 'd', onSaveError: (e) => errors.push(e.message) })
    r.dispatch('add', { id: 'a' })
    expect(errors).toEqual(['quota'])
    expect(r.get().items).toEqual([{ id: 'a' }]) // not replaced by the (empty) disk while unsaved
    fail = false
    r.dispatch('add', { id: 'b' })
    expect(JSON.parse(st.m['qk:box']).base.items.map((i) => i.id)).toEqual(['a', 'b'])
  })
})

describe('dropEmpty', () => {
  it('removes the record when the state is back to its initial value, and reads a missing record as initial', () => {
    const st = mem()
    const r = createApp({ storage: st, device: 'd' }).use(box())
    r.dispatch('add', { id: 'a' })
    r.dispatch('drop', { id: 'a' })
    expect('qk:box' in st.m).toBe(false)
    expect(r.get().items).toEqual([])
  })
  it('crossTab: a removal in another tab reaches this one as the initial value', () => {
    const st = mem()
    const decl = declare({ name: 'd1', scope: 'local', dropEmpty: true, crossTab: true, fields: { text: field('') }, actions: { set: set('text', 'text') } })
    const a = createApp({ storage: st, device: 'a', schedule: (f) => f() }).use(decl)
    const b = createApp({ storage: st, device: 'b', schedule: (f) => f() }).use(decl)
    a.dispatch('set', { text: 'hi' }); b.refresh()
    expect(b.get().text).toBe('hi')
    a.dispatch('set', { text: '' }); b.refresh()
    expect(b.get().text).toBe('')
  })
})

describe('local legacy with archive', () => {
  const decl = () => declare({ name: 'p', scope: 'local', fields: { n: field(1, Number) }, legacy: [{ key: 'old.n', into: 'n', archive: true }, { key: 'old.keep', into: 'k' }], actions: { set: set('n', 'n') } })
  it('imports, saves, then moves the old key to __archive__ (a keep-in-place entry stays)', () => {
    const st = mem({ 'old.n': '3', 'old.keep': 'x' })
    const r = createApp({ storage: st, device: 'd' }).use(decl())
    expect(r.get().n).toBe(3)
    expect(JSON.parse(st.m['qk:p']).base.n).toBe(3)
    expect(st.m['__archive__old.n']).toBe('3')
    expect('old.n' in st.m).toBe(false)
    expect(st.m['old.keep']).toBe('x')
  })
  it('keeps the old key when the record cannot be saved', () => {
    const st = mem({ 'old.n': '3' }); const s0 = st.setItem
    st.setItem = (k, v) => { if (k === 'qk:p') throw new Error('quota'); s0(k, v) }
    createApp({ storage: st, device: 'd' }).use(decl())
    expect(st.m['old.n']).toBe('3')
    expect('__archive__old.n' in st.m).toBe(false)
  })
  it('a second boot reads the record, not the archive', () => {
    const st = mem({ 'old.n': '3' })
    createApp({ storage: st, device: 'd', schedule: (f) => f() }).use(decl()).dispatch('set', { n: 5 })
    const again = createApp({ storage: st, device: 'd' }).use(decl())
    expect(again.get().n).toBe(5)
  })
})
