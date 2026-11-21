import { describe, expect, it } from 'vitest'
import { createApp, declare, fold, toStreamEntry, fromStreamEntry, compareEntries } from '../lib/model.js'
import { createMemoryStreamServer } from '../lib/stream-fake.js'
import { assign, setMember, members, bump, total } from '../lib/fields.js'

const mem = (init = {}) => { const m = { ...init }; return { m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v }, removeItem: (k) => { delete m[k] } } }
const manual = () => { const q = []; return { schedule: (f) => q.push(f), run: () => q.splice(0).forEach((f) => f()), q } }

const side = (over = {}) => declare({
  name: 'sidebar', version: 1, scope: 'local', initial: { open: {}, folded: false, name: '' },
  actions: {
    'folder.open': (s, { key, open }) => (Boolean(s.open[key]) === open ? s : { ...s, open: setMember(s.open, key, open) }),
    'main.fold': (s, { folded }) => assign(s, { folded }),
    'name.set': (s, { name }) => assign(s, { name }),
  }, ...over,
})

describe('declare', () => {
  it('rejects bad declarations', () => {
    expect(() => declare({})).toThrow(/name/)
    expect(() => declare({ name: 'x', scope: 'p', actions: { a: (s) => s }, initial: 1 })).toThrow(/scope/)
    expect(() => declare({ name: 'x', initial: 1 })).toThrow(/actions/)
    expect(() => declare({ name: 'x', actions: { a: (s) => s } })).toThrow(/initial/)
  })
  it('defaults to scope cloud (persist by default, opt out)', () => { expect(declare({ name: 'x', initial: 0, actions: { a: (s) => s } }).scope).toBe('cloud') })
})

describe('replica: local', () => {
  it('hydrates synchronously from the saved record and is the first thing the subscriber sees', () => {
    const st = mem()
    const a = createApp({ storage: st, device: 'd' }); const s1 = a.use(side())
    s1.dispatch('folder.open', { key: 'k', open: true }); s1.flush()
    const b = createApp({ storage: st, device: 'd' }).use(side())
    let first; b.subscribe((v) => { first ??= v })
    expect(first.open).toEqual({ k: true })
  })
  it('coalesces many dispatches into one write and flushes on demand', () => {
    const st = mem(); let writes = 0; const set = st.setItem; st.setItem = (k, v) => { if (k === 'qk:sidebar') writes++; set(k, v) }
    const q = manual(); const r = createApp({ storage: st, device: 'd', schedule: q.schedule }).use(side())
    for (let i = 0; i < 20; i++) r.dispatch('folder.open', { key: 'k' + i, open: true })
    expect(writes).toBe(0); q.run(); expect(writes).toBe(1)
    r.dispatch('main.fold', { folded: true }); r.flush(); expect(writes).toBe(2)
  })
  it('a no-op action is not logged, saved or notified', () => {
    const q = manual(); const r = createApp({ storage: mem(), device: 'd', schedule: q.schedule }).use(side())
    let n = 0; r.subscribe(() => n++); n = 0
    expect(r.dispatch('main.fold', { folded: false })).toBeNull()
    expect(n).toBe(0); expect(q.q.length).toBe(0)
  })
  it('unknown action throws at dispatch', () => { expect(() => createApp({ storage: mem(), device: 'd' }).use(side()).dispatch('nope')).toThrow(/unknown action/) })
  it('replay is idempotent: dispatching the same absolute action twice equals once', () => {
    const r = createApp({ storage: mem(), device: 'd' }).use(side())
    r.dispatch('folder.open', { key: 'a', open: true }); const once = JSON.stringify(r.get())
    r.dispatch('folder.open', { key: 'a', open: true }); expect(JSON.stringify(r.get())).toBe(once)
  })
  it('imports a legacy value once, when no record exists, without deleting it', () => {
    const st = mem({ old: JSON.stringify({ f: 1 }) })
    const d = side({ legacy: (s) => { const o = JSON.parse(s.getItem('old')); return { folded: o.f === 1 } } })
    const r = createApp({ storage: st, device: 'd' }).use(d)
    expect(r.get().folded).toBe(true); expect(st.getItem('old')).not.toBeNull()
    r.dispatch('main.fold', { folded: false }); r.flush()
    expect(createApp({ storage: st, device: 'd' }).use(d).get().folded).toBe(false) // record wins over legacy afterwards
  })
  it('migrates by version, archiving the raw record first, and never clobbers an unloadable one', () => {
    const st = mem({ 'qk:sidebar': JSON.stringify({ version: 1, base: { open: {}, folded: true } }) })
    const d = side({ version: 2, initial: { open: {}, folded: false, name: '', extra: 1 }, migrations: { 2: (s) => ({ ...s, extra: 2 }) } })
    const r = createApp({ storage: st, device: 'd' }).use(d)
    expect(r.get()).toMatchObject({ folded: true, extra: 2 })
    expect(Object.keys(st.m).some((k) => k.startsWith('__archive__'))).toBe(true)
    const bad = mem({ 'qk:sidebar': JSON.stringify({ version: 1, base: {} }) })
    const r2 = createApp({ storage: bad, device: 'd' }).use(side({ version: 3 }))
    expect(r2.aborted).toMatch(/upcaster/); r2.dispatch('main.fold', { folded: true }); r2.flush()
    expect(JSON.parse(bad.m['qk:sidebar']).version).toBe(1) // unloadable bytes kept
  })
  it('does not archive on an ordinary same-version boot', () => {
    const st = mem(); const a = createApp({ storage: st, device: 'd' }).use(side()); a.dispatch('main.fold', { folded: true }); a.flush()
    createApp({ storage: st, device: 'd' }).use(side()); createApp({ storage: st, device: 'd' }).use(side())
    expect(Object.keys(st.m).filter((k) => k.startsWith('__archive__'))).toEqual([])
  })
  it('ephemeral state is never written; a broken storage never throws into the app', () => {
    const st = mem(); const r = createApp({ storage: st, device: 'd' }).use(side({ scope: 'ephemeral' }))
    r.dispatch('main.fold', { folded: true }); r.flush(); expect(st.getItem('qk:sidebar')).toBeNull()
    const bad = { getItem() { throw new Error('off') }, setItem() { throw new Error('quota') } }
    const r2 = createApp({ storage: bad, device: 'd' }).use(side()); r2.dispatch('main.fold', { folded: true }); expect(() => r2.flush()).not.toThrow()
    expect(r2.get().folded).toBe(true)
  })
})

describe('Stream mapping and fields', () => {
  it('an action maps one to one onto a Stream entry and back', () => {
    const e = { device: 'a', seq: 3, ts: 1700000000000, type: 'x', payload: { n: 1 } }
    expect(toStreamEntry(e)).toMatchObject({ entry_id: 'a:3', device_id: 'a', device_seq: 3, event_time: '2023-11-14T22:13:20.000Z' })
    expect(fromStreamEntry(toStreamEntry(e))).toEqual(e)
  })
  it('field helpers return the same reference when nothing changes', () => {
    const s = { a: 1 }; expect(assign(s, { a: 1 })).toBe(s); expect(assign(s, { a: 2 })).not.toBe(s)
    const m = { k: true }; expect(setMember(m, 'k', true)).toBe(m); expect(members(setMember(m, 'j', true)).sort()).toEqual(['j', 'k']); expect(setMember(m, 'k', false)).toEqual({})
    expect(total(bump(bump({}, 'a', 2), 'b', 3))).toBe(5); const c = {}; expect(bump(c, 'a', 0)).toBe(c)
  })
})

const doc = () => declare({
  name: 'doc', initial: { open: {}, title: '', n: {} },
  actions: {
    open: (s, { key, open }) => (Boolean(s.open[key]) === open ? s : { ...s, open: setMember(s.open, key, open) }),
    title: (s, { title }) => assign(s, { title }),
    bump: (s, { device, by }) => ({ ...s, n: bump(s.n, device, by) }),
  },
})
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }

describe('cloud sync through the Stream fake', () => {
  it('pushes the action log, pulls the other device and renders both', async () => {
    const server = createMemoryStreamServer()
    const A = createApp({ storage: mem(), device: 'A', transport: server, now: () => 10 }).use(doc())
    const B = createApp({ storage: mem(), device: 'B', transport: server, now: () => 20 }).use(doc())
    A.dispatch('title', { title: 'a' }); B.dispatch('title', { title: 'b' })
    await A.sync(); await B.sync(); await A.sync()
    expect(A.get().title).toBe('b'); expect(B.get().title).toBe('b') // later event_time wins
    expect(A.pending).toEqual([]); expect(server.streams.get('doc').rows.length).toBe(2)
  })
  it('offline dispatches queue, survive a reload, and flush in order on reconnect (idempotent retry)', async () => {
    const server = createMemoryStreamServer(); const st = mem()
    const a1 = createApp({ storage: st, device: 'A', transport: server }).use(doc())
    server.state.offline = true
    a1.dispatch('open', { key: 'x', open: true }); a1.dispatch('open', { key: 'y', open: true })
    await expect(a1.sync()).rejects.toThrow('offline'); a1.flush()
    const a2 = createApp({ storage: st, device: 'A', transport: server }).use(doc()) // reload
    expect(a2.pending.length).toBe(2); expect(a2.get().open).toEqual({ x: true, y: true })
    server.state.offline = false; await a2.sync(); await a2.sync()
    expect(a2.pending.length).toBe(0); expect(server.streams.get('doc').rows.map((r) => r.device_seq)).toEqual([1, 2])
  })
  it('a late remote entry reorders: confirmed is refolded and pending re-applied on top', async () => {
    const server = createMemoryStreamServer()
    const A = createApp({ storage: mem(), device: 'A', transport: server, now: () => 100 }).use(doc())
    const B = createApp({ storage: mem(), device: 'B', transport: server, now: () => 50 }).use(doc())
    B.dispatch('title', { title: 'older' }); await B.sync()
    A.dispatch('title', { title: 'newer' }) // pending on A, never pushed yet
    await A.sync() // pulls B's older entry; view stays newer
    expect(A.get().title).toBe('newer')
    expect(A.log.map((e) => e.device)).toEqual(['B', 'A'])
  })
  it('property: random interleavings of three devices converge to the fold of all entries in total order', async () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed); const server = createMemoryStreamServer({ pageSize: 3 })
      const clocks = { A: 0, B: 0, C: 0 }
      const rs = Object.fromEntries(['A', 'B', 'C'].map((d) => [d, createApp({ storage: mem(), device: d, transport: server, now: () => (clocks[d] += Math.floor(r() * 5)) }).use(doc())]))
      const names = Object.keys(rs)
      for (let i = 0; i < 40; i++) {
        const d = names[Math.floor(r() * 3)], x = rs[d], p = r()
        if (p < 0.4) x.dispatch('open', { key: 'k' + Math.floor(r() * 4), open: r() < 0.5 })
        else if (p < 0.55) x.dispatch('title', { title: 't' + Math.floor(r() * 5) })
        else if (p < 0.65) x.dispatch('bump', { device: d, by: 1 })
        else { server.state.offline = r() < 0.2; try { await x.sync() } catch { /* offline */ } server.state.offline = false }
      }
      for (let k = 0; k < 3; k++) for (const d of names) await rs[d].sync()
      const all = server.streams.get('doc').rows.map(fromStreamEntry).sort(compareEntries)
      const want = fold(doc(), doc().initial, all)
      for (const d of names) expect(rs[d].get(), `seed ${seed} device ${d}`).toEqual(want)
    }
  })
})

describe('GUIDE worked example 1: the greeting card', () => {
  it('is the 20-line app in the guide and survives a reload', () => {
    const decl = declare({
      name: 'card', scope: 'local', initial: { to: '', msg: 'Happy birthday', color: 'pink' },
      actions: { 'to.set': (s, { to }) => assign(s, { to }), 'msg.set': (s, { msg }) => assign(s, { msg }), 'color.set': (s, { color }) => assign(s, { color }) },
    })
    const st = mem(); const card = createApp({ storage: st, device: 'd' }).use(decl)
    card.dispatch('to.set', { to: 'Ana' }); card.dispatch('color.set', { color: 'blue' }); card.flush()
    expect(createApp({ storage: st, device: 'd' }).use(decl).get()).toEqual({ to: 'Ana', msg: 'Happy birthday', color: 'blue' })
    const cloud = createApp({ storage: mem(), device: 'e', transport: createMemoryStreamServer() }).use({ ...decl, scope: 'cloud' }) // one word
    cloud.dispatch('msg.set', { msg: 'hi' }); expect(cloud.pending.length).toBe(1)
  })
})

describe('lifecycle', () => {
  it('flushes on pagehide and detaches', () => {
    const ls = {}; const win = { addEventListener: (n, f) => { ls[n] = f }, removeEventListener: (n) => { delete ls[n] } }
    const q = manual(); const st = mem(); const app = createApp({ storage: st, device: 'd', schedule: q.schedule })
    const r = app.use(side()); const off = app.attachLifecycle(win)
    r.dispatch('main.fold', { folded: true }); expect(st.getItem('qk:sidebar')).toBeNull()
    ls.pagehide(); expect(JSON.parse(st.getItem('qk:sidebar')).base.folded).toBe(true)
    off(); expect(ls.pagehide).toBeUndefined()
  })
})

describe('persist projection', () => {
  it('saves only what survives a reload; the live view keeps the rest', () => {
    const decl = declare({
      name: 'tabs', scope: 'local', initial: { open: [], scratch: null },
      persist: (s) => ({ ...s, scratch: null }),
      actions: { 'open.set': (s, { open }) => assign(s, { open }), 'scratch.set': (s, { id }) => assign(s, { scratch: id }) },
    })
    const st = mem(); const r = createApp({ storage: st, device: 'd' }).use(decl)
    r.dispatch('open.set', { open: ['a'] }); r.dispatch('scratch.set', { id: 'tmp' }); r.flush()
    expect(r.get()).toEqual({ open: ['a'], scratch: 'tmp' })
    expect(createApp({ storage: st, device: 'd' }).use(decl).get()).toEqual({ open: ['a'], scratch: null })
  })
})
