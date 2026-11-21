// The easy-kit bar: `app.use(decl)` with scope 'cloud' is robust with no app code. Durable outbox, deadlines, auto
// sync that never drops, telemetry lane, cross-tab pull.
import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createApp, declare } from '../lib/model.js'
import { createMemoryStreamServer } from '../lib/stream-fake.js'

const mem = () => { const m = {}; return { m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v) }, removeItem: (k) => { delete m[k] } } }
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, n = 100) => { for (let i = 0; i < n && !fn(); i++) await tick(5); return fn() }
const notes = () => declare({ name: 'notes', initial: { items: [] }, actions: { add: (s, { id, text }) => (s.items.some((x) => x.id === id) ? s : { items: [...s.items, { id, text }] }) } })

describe('scope cloud, robust by default', () => {
  it('a dispatch reaches the Stream with no sync call', async () => {
    const server = createMemoryStreamServer()
    const app = createApp({ storage: mem(), device: 'd1', transport: server, engine: { indexedDB: new IDBFactory(), Broadcast: null } })
    const n = app.use(notes())
    await n.ready
    n.dispatch('add', { id: 'a', text: 'hello' })
    expect(await until(() => server.streams.get('notes')?.rows.length === 1)).toBe(true)
    expect(await until(() => n.pending.length === 0)).toBe(true)
  })

  it('offline: nothing is lost even when the localStorage record is; a reload restores from the outbox and delivers', async () => {
    const server = createMemoryStreamServer()
    server.state.offline = true
    const indexedDB = new IDBFactory()
    const storage = mem()
    const app1 = createApp({ storage, device: 'd1', transport: server, engine: { indexedDB, Broadcast: null, retryMs: [5] } })
    const n1 = app1.use(notes())
    await n1.ready
    n1.dispatch('add', { id: 'a', text: 'typed offline' })
    await tick(20)
    expect(n1.status().attempts).toBeGreaterThan(0)
    app1.engine.close()
    delete storage.m['qk:notes'] // the record is gone (cleared site data for localStorage only, a clobber)
    server.state.offline = false
    const app2 = createApp({ storage, device: 'd1', transport: server, engine: { indexedDB, Broadcast: null } })
    const n2 = app2.use(notes())
    await n2.ready
    expect(n2.status().restored).toBe(1)
    expect(await until(() => server.streams.get('notes')?.rows.length === 1)).toBe(true)
    expect(n2.get().items.map((x) => x.text)).toEqual(['typed offline'])
  })

  it('a hung transport is cut at its deadline and retried; the entry is never dropped', async () => {
    const server = createMemoryStreamServer()
    let hang = true
    const transport = { push: (s, r) => (hang ? new Promise(() => {}) : server.push(s, r)), pull: (s, c) => server.pull(s, c) }
    const app = createApp({ storage: mem(), device: 'd1', transport, engine: { indexedDB: new IDBFactory(), Broadcast: null, deadlines: { push: 20, pull: 20 }, retryMs: [5] } })
    const n = app.use(notes())
    await n.ready
    n.dispatch('add', { id: 'a', text: 'x' })
    await tick(40)
    expect(n.status().lastError).toMatch(/deadline/)
    hang = false
    expect(await until(() => server.streams.get('notes')?.rows.length === 1)).toBe(true)
    expect(app.telemetry.counts().accepted).toBeGreaterThan(0)
  })

  it('a second tab pulls what the first pushed', async () => {
    const server = createMemoryStreamServer()
    const indexedDB = new IDBFactory()
    const a = createApp({ storage: mem(), device: 'ta', transport: server, engine: { indexedDB, outboxName: 'oa' } }).use(notes())
    const b = createApp({ storage: mem(), device: 'tb', transport: server, engine: { indexedDB, outboxName: 'ob' } }).use(notes())
    await a.ready; await b.ready
    a.dispatch('add', { id: 'x', text: 'from a' })
    expect(await until(() => b.get().items.length === 1)).toBe(true)
  })

  it('opts.scope picks cloud for a declaration and engine:false turns the defaults off', async () => {
    const app = createApp({ storage: mem(), device: 'd', engine: false })
    expect(app.telemetry).toBe(null)
    const local = declare({ name: 'l', scope: 'local', initial: { v: 0 }, actions: { set: (s, { v }) => (s.v === v ? s : { v }) } })
    expect(app.use(local, { scope: 'cloud' }).decl.scope).toBe('cloud')
  })

  it('KNOWN LIMIT: two tabs on one device id outside the shared engine collide on device:seq; reported, entries kept', async () => {
    const server = createMemoryStreamServer()
    const storage = mem()
    const indexedDB = new IDBFactory()
    const a = createApp({ storage, device: 'same', transport: server, engine: { indexedDB, Broadcast: null, outboxName: 'xa' } }).use(notes())
    const b = createApp({ storage, device: 'same', transport: server, engine: { indexedDB, Broadcast: null, outboxName: 'xb' } }).use(notes())
    await a.ready; await b.ready
    a.dispatch('add', { id: 'x', text: 'tab a' })
    b.dispatch('add', { id: 'y', text: 'tab b' })
    await until(() => a.status().synced + b.status().synced >= 1 && (a.status().blocked || b.status().blocked))
    const blocked = a.status().blocked || b.status().blocked
    expect(blocked?.status).toBe(409)
    expect(a.pending.length + b.pending.length).toBe(1) // the loser keeps its entry
  })
})
