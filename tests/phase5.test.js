import { describe, expect, it } from 'vitest'
import { createApp, declare } from '../lib/model.js'
import { createMemoryStreamServer } from '../lib/stream-fake.js'
import { field, on } from '../lib/schema.js'

const mem = (init = {}) => { const m = { ...init }; return { m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v }, removeItem: (k) => { delete m[k] } } }

const outbox = (extra = {}) => declare({
  name: 'box', scope: 'cloud',
  fields: { ids: field({}, (v) => (v && typeof v === 'object' ? v : {})) },
  legacy: [{ key: 'old.outbox', json: true, actions: (list) => list.map((id) => ['add', { id }]) }],
  actions: { add: on('ids', (ids, { id }) => (ids[id] ? ids : { ...ids, [id]: true })) },
  ...extra,
})

describe('legacy outbox replay', () => {
  it('replays old entries through the reducer into the op log, archives the old key, and is idempotent', () => {
    const st = mem({ 'old.outbox': JSON.stringify(['a', 'b', 'a']) })
    const r = createApp({ storage: st, device: 'd' }).use(outbox())
    expect(r.get().ids).toEqual({ a: true, b: true })
    expect(r.pending.map((e) => e.payload.id)).toEqual(['a', 'b']) // the duplicate was a no-op, not a second entry
    expect('old.outbox' in st.m).toBe(false)
    expect(JSON.parse(st.m['__archive__old.outbox'])).toEqual(['a', 'b', 'a'])
    expect(JSON.parse(st.m['qk:box']).pending).toHaveLength(2) // on disk before the old key went
    const again = createApp({ storage: st, device: 'd' }).use(outbox())
    expect(again.pending).toHaveLength(2)
  })
  it('replayed entries are delivered by sync like any other', async () => {
    const server = createMemoryStreamServer()
    const st = mem({ 'old.outbox': JSON.stringify(['a', 'b']) })
    const r = createApp({ storage: st, device: 'd' }).use(outbox(), { transport: server })
    await r.sync()
    expect(r.pending).toEqual([])
    expect(server.streams.get('box').rows.map((x) => x.device_seq)).toEqual([1, 2])
  })
  it('keeps the old key when the record cannot be saved', () => {
    const st = mem({ 'old.outbox': JSON.stringify(['a']) })
    const set = st.setItem; st.setItem = (k, v) => { if (k === 'qk:box') throw new Error('quota'); set(k, v) }
    createApp({ storage: st, device: 'd' }).use(outbox())
    expect('old.outbox' in st.m).toBe(true)
  })
})

describe('per-state transport', () => {
  it('a state brings its own sink; others stay local', async () => {
    const server = createMemoryStreamServer()
    const app = createApp({ storage: mem(), device: 'd' })
    const a = app.use(outbox(), { transport: server })
    const b = app.use(outbox({ name: 'other' }))
    a.dispatch('add', { id: 'x' }); b.dispatch('add', { id: 'y' })
    await app.sync()
    expect(server.streams.has('box')).toBe(true)
    expect(server.streams.has('other')).toBe(false)
  })
})

describe('rebinding a transport', () => {
  it('use() again with a transport swaps the sink (a remounted component hands over fresh closures); without one it keeps it', async () => {
    const spy = (log) => ({ push: async (_s, rows) => { log.push(...rows.map((e) => e.payload.payload.id)) }, pull: async () => ({ entries: [], cursor: null, more: false }) })
    const a = [], b = []
    const app = createApp({ storage: mem(), device: 'd' })
    const r = app.use(outbox(), { transport: spy(a) })
    r.dispatch('add', { id: 'x' }); await r.sync()
    app.use(outbox()); r.dispatch('add', { id: 'y' }); await r.sync()
    app.use(outbox(), { transport: spy(b) }); r.dispatch('add', { id: 'z' }); await r.sync()
    expect(a).toEqual(['x', 'y'])
    expect(b).toEqual(['z'])
  })
})

describe('crossTab local state', () => {
  const nameDecl = (crossTab) => declare({ name: 'who', scope: 'local', crossTab, fields: { name: field('') }, actions: { set: on('name', (_, { name }) => name) } })
  it('adopts another tab\'s save on a storage event, only when declared crossTab', () => {
    const st = mem()
    const tabA = createApp({ storage: st, device: 'd' }).use(nameDecl(true))
    const tabB = createApp({ storage: st, device: 'd' }).use(nameDecl(true))
    const plainB = createApp({ storage: st, device: 'd' }).use(nameDecl(false))
    tabA.dispatch('set', { name: 'Bob' }); tabA.flush()
    const seen = []; tabB.subscribe((v) => seen.push(v.name))
    expect(tabB.refresh()).toBe(true)
    expect(tabB.get().name).toBe('Bob'); expect(seen).toEqual(['', 'Bob'])
    expect(tabB.refresh()).toBe(false) // nothing new
    expect(plainB.refresh()).toBe(false); expect(plainB.get().name).toBe('')
  })
  it('app.attachLifecycle routes the storage event by key', () => {
    const st = mem(); const handlers = {}
    const win = { addEventListener: (t, f) => { handlers[t] = f }, removeEventListener() {} }
    const tabA = createApp({ storage: st, device: 'd' }).use(nameDecl(true))
    const appB = createApp({ storage: st, device: 'd' }); const tabB = appB.use(nameDecl(true)); appB.attachLifecycle(win)
    tabA.dispatch('set', { name: 'Ann' }); tabA.flush()
    handlers.storage({ key: 'qk:other' }); expect(tabB.get().name).toBe('')
    handlers.storage({ key: 'qk:who' }); expect(tabB.get().name).toBe('Ann')
  })
})
