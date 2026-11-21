import { describe, expect, it } from 'vitest'
import { createApp, declare } from '../lib/model.js'
import { field, set } from '../lib/schema.js'
import { range, counter, cache, advance, mint, keyed, storageKeys, marker, marked, onceId, idOf } from '../lib/recipes.js'

const mem = (init = {}) => { const m = { ...init }; return { m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v) }, removeItem: (k) => { delete m[k] } } }

describe('range and counter fields', () => {
  it('range keeps [min,max] and repairs the rest to the default', () => {
    const f = range(1, 0.85, 1.5)
    expect([f.clean('1.2'), f.clean(0.85), f.clean(3), f.clean('x'), f.clean(''), f.clean(null), f.clean(undefined)]).toEqual([1.2, 0.85, 1, 1, 1, 1, 1])
  })
  it('counter is a non-negative integer', () => {
    const f = counter()
    expect([f.clean('7'), f.clean(-2), f.clean('abc'), f.clean(3.9)]).toEqual([7, 0, 0, 3])
  })
})

describe('cache field', () => {
  it('keeps an object or array whole, anything else is null', () => {
    const f = cache()
    expect([f.clean({ a: 1 }), f.clean([1]), f.clean('x'), f.clean(0), f.clean(undefined)]).toEqual([{ a: 1 }, [1], null, null, null])
  })
})

describe('advance and mint', () => {
  const decl = declare({ name: 'seq', scope: 'local', durable: true, fields: { n: counter() }, actions: { 'n.advance': advance('n') } })
  it('advance never moves back; a stale or repeated value is a no-op', () => {
    const r = createApp({ storage: mem(), device: 'd' }).use(decl)
    r.dispatch('n.advance', { to: 5 })
    expect(r.dispatch('n.advance', { to: 3 })).toBe(null)
    expect(r.dispatch('n.advance', { to: 5 })).toBe(null)
    expect(r.get().n).toBe(5)
  })
  it('mint hands out each number once across two tabs, saved before it is returned', () => {
    const st = mem()
    const a = createApp({ storage: st, device: 'a' }).use(decl), b = createApp({ storage: st, device: 'b' }).use(decl)
    expect([mint(a, 'n', 'n.advance'), mint(b, 'n', 'n.advance'), mint(a, 'n', 'n.advance')]).toEqual([1, 2, 3])
    expect(JSON.parse(st.m['qk:seq']).base.n).toBe(3)
  })
  it('mint falls back to the clock when storage refuses', () => {
    const st = mem(); st.setItem = () => { throw new Error('quota') }
    const r = createApp({ storage: st, device: 'a' }).use(decl)
    expect(mint(r, 'n', 'n.advance', () => 999)).toBe(999)
  })
})

describe('keyed family', () => {
  const drafts = keyed('draft', {
    fields: { text: field('', (v) => (typeof v === 'string' ? v : '')) },
    legacy: (key) => [{ key: `old-draft:${key}`, into: 'text', archive: true }],
    legacyPrefix: 'old-draft:',
    actions: { 'text.set': set('text', 'text') },
  })
  it('one record per key, removed when empty, old keys imported then archived', () => {
    const st = mem({ 'old-draft:b': 'from before' })
    const app = createApp({ storage: st, device: 'd', schedule: (f) => f() })
    expect(drafts.keys(st).sort()).toEqual(['b'])
    drafts.use(app, 'a').dispatch('text.set', { text: 'hi' })
    expect(JSON.parse(st.m['qk:draft:a']).base.text).toBe('hi')
    expect(drafts.use(app, 'b').get().text).toBe('from before')
    expect(st.m['__archive__old-draft:b']).toBe('from before')
    expect(drafts.keys(st).sort()).toEqual(['a', 'b'])
    drafts.use(app, 'a').dispatch('text.set', { text: '' })
    expect('qk:draft:a' in st.m).toBe(false)
    expect(drafts.keys(st)).toEqual(['b'])
    expect(drafts.decl('a')).toBe(drafts.decl('a'))
  })
  it('storageKeys reads a real Storage shape too', () => {
    const fake = { length: 2, key: (i) => ['x', 'y'][i] }
    expect(storageKeys(fake)).toEqual(['x', 'y'])
  })
})

describe('marker', () => {
  it('marks a day in the tab storage, imports and archives the old key from that same storage', () => {
    const tab = mem({ 'old-landed': '2026-11-07' }), dev = mem()
    const app = createApp({ storage: dev, tabStorage: tab, device: 'd', schedule: (f) => f() })
    const r = app.use(marker('landed', { storage: 'tab', legacyKey: 'old-landed' }))
    expect(marked(r, '2026-11-07')).toBe(true)
    expect(tab.m['__archive__old-landed']).toBe('2026-11-07')
    r.dispatch('mark', { at: '2026-11-08' })
    expect(JSON.parse(tab.m['qk:landed']).base.at).toBe('2026-11-08')
    expect(Object.keys(dev.m).filter((k) => k !== 'qk:device')).toEqual([])
    expect(r.dispatch('mark', { at: '2026-11-08' })).toBe(null)
  })
})

describe('onceId', () => {
  it('mints once, the first writer wins across tabs, an old id is adopted and left in place', () => {
    const st = mem()
    const a = createApp({ storage: st, device: 'a' }).use(onceId('dev'))
    const b = createApp({ storage: st, device: 'b' }).use(onceId('dev'))
    expect(idOf(a, () => 'first')).toBe('first')
    expect(idOf(b, () => 'second')).toBe('first')
    const old = mem({ 'old.device': 'dev-x' })
    const c = createApp({ storage: old, device: 'c' }).use(onceId('dev', { legacyKey: 'old.device' }))
    expect(idOf(c, () => 'new')).toBe('dev-x')
    expect(old.m['old.device']).toBe('dev-x')
  })
})
