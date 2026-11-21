import { describe, expect, it } from 'vitest'
import { createApp, declare } from '../lib/model.js'
import { field, bool, num, list, flags, shape, scratch, set, merge, on, reset } from '../lib/schema.js'

const mem = (init = {}) => { const m = { ...init }; return { m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v } } }
const open = (decl, storage = mem(), more = {}) => createApp({ storage, device: 'd', ...more }).use(decl)

describe('field types', () => {
  it('repair to the default or a valid value, and undefined is the default', () => {
    expect(bool(true).clean(undefined)).toBe(true); expect(bool().clean(1)).toBe(true); expect(bool(true).clean(0)).toBe(false)
    const n = num(2, { int: true })
    expect([n.clean('3.6'), n.clean(-1), n.clean('x'), n.clean(''), n.clean(true), n.clean(Infinity), n.clean(undefined), num().clean(0.4)]).toEqual([4, 2, 2, 2, 2, 2, 2, 0.4])
    expect(list((v) => (typeof v === 'string' ? v.trim() : null)).clean([' a ', 'a', 3, ''])).toEqual(['a']); expect(list().clean('x')).toEqual([])
    expect(flags().clean({ a: true, b: 0, c: 'y' })).toEqual({ a: true, c: 'y' }); expect(flags().clean([1])).toEqual({})
    const s = shape({ speed: num(1.1), on: bool(true) })
    expect(s.init).toEqual({ speed: 1.1, on: true }); expect(s.clean({ speed: '2', on: 0, junk: 1 })).toEqual({ speed: 2, on: false }); expect(s.clean(null)).toEqual({ speed: 1.1, on: true })
    expect(scratch().clean(undefined)).toBeNull(); expect(field(5, String).clean(7)).toBe('7')
  })
})

const card = (over = {}) => declare({
  name: 'card', scope: 'local',
  fields: { to: field('', String), size: num(null, { int: true }), tags: list(), seen: flags(), draft: scratch(), box: shape({ a: num(1), b: bool() }) },
  actions: {
    'to.set': set('to', 'to'), 'size.set': set('size', 'px'), 'box.set': merge('box'), 'draft.set': set('draft'),
    'tag.add': on('tags', (t, { tag }) => [...t, tag]), 'seen.mark': on('seen', (m, { id }) => ({ ...m, [id]: true })),
    'card.reset': reset(), 'draft.clear': reset('draft'),
  },
  ...over,
})

describe('declare with fields', () => {
  it('derives initial, normalize and persist; actions are no-ops when nothing changes', () => {
    const r = open(card())
    expect(r.get()).toEqual({ to: '', size: null, tags: [], seen: {}, draft: null, box: { a: 1, b: false } })
    expect(r.dispatch('to.set', { to: 'Kat' })).not.toBeNull(); expect(r.dispatch('to.set', { to: 'Kat' })).toBeNull()
    r.dispatch('size.set', { px: 300.4 }); expect(r.get().size).toBe(300); expect(r.dispatch('size.set', { px: 300.2 })).toBeNull()
    r.dispatch('box.set', { b: 1 }); expect(r.get().box).toEqual({ a: 1, b: true }); expect(r.dispatch('box.set', { b: true })).toBeNull()
    r.dispatch('tag.add', { tag: 'x' }); r.dispatch('tag.add', { tag: 'x' }); expect(r.get().tags).toEqual(['x']) // list repairs the duplicate away
    r.dispatch('seen.mark', { id: 'k' }); expect(r.dispatch('seen.mark', { id: 'k' })).toBeNull()
    r.dispatch('draft.set', { draft: 'hi' })
    expect(r.dispatch('draft.clear')).not.toBeNull(); expect(r.dispatch('draft.clear')).toBeNull()
    r.dispatch('card.reset'); expect(r.get().to).toBe(''); expect(r.dispatch('card.reset')).toBeNull()
  })
  it('an ephemeral field is never saved, a save() projection is, and hydrate repairs hand-edited records', () => {
    const st = mem(); const r = open(card()); const a = open(card(), st)
    a.dispatch('draft.set', { draft: 'secret' }); a.dispatch('to.set', { to: 'Zed' }); a.flush()
    expect(JSON.parse(st.m['qk:card']).base.draft).toBeNull()
    expect(open(card(), st).get()).toMatchObject({ to: 'Zed', draft: null }); expect(r.get().to).toBe('')
    const hand = mem({ 'qk:card': JSON.stringify({ version: 1, base: { to: 7, size: -2, tags: 'no', junk: 1 } }) })
    expect(open(card(), hand).get()).toEqual({ to: '7', size: null, tags: [], seen: {}, draft: null, box: { a: 1, b: false } })
    const save = declare({ name: 's', scope: 'local', fields: { v: field(1, (x) => x, { save: (x, s) => x + s.w }), w: field(10) }, actions: { 'v.set': set('v', 'v') } })
    const rs = open(save); rs.dispatch('v.set', { v: 5 }); rs.flush(); expect(rs.saved.base).toEqual({ v: 15, w: 10 })
  })
  it('a spec normalize runs after the fields and a spec persist wins', () => {
    const d = declare({ name: 'n', scope: 'local', fields: { v: field(1) }, normalize: (s) => (s.v > 9 ? { ...s, v: 9 } : s), persist: () => ({ v: 0 }), actions: { 'v.set': set('v', 'v') } })
    const r = open(d); r.dispatch('v.set', { v: 50 }); expect(r.get().v).toBe(9); r.flush(); expect(r.saved.base).toEqual({ v: 0 })
  })
  it('rejects a shorthand without fields or naming an unknown field', () => {
    expect(() => declare({ name: 'x', initial: {}, actions: { a: set('v', 'v') } })).toThrow(/needs `fields`/)
    expect(() => declare({ name: 'x', fields: { v: field(1) }, actions: { a: set('nope', 'v') } })).toThrow(/unknown field/)
  })
})

describe('legacy imports', () => {
  const d = (over) => declare({ name: 'old', scope: 'local', fields: { a: field(0, Number), b: bool(), c: field(null) }, actions: { 'a.set': set('a', 'a') }, ...over })
  it('imports each present old key once, json or raw, with into or read, ignoring bad values and absent keys', () => {
    const legacy = [{ key: 'old.a', json: true, into: 'a' }, { key: 'old.b', read: (v) => ({ b: v === '1' }) }, { key: 'old.c', json: true, read: (v) => v && { c: v.x } }, { key: 'old.bad', json: true, into: 'a' }, { key: 'old.none', into: 'c' }]
    const st = mem({ 'old.a': '4', 'old.b': '1', 'old.c': '{"x":"y"}', 'old.bad': '{nope' })
    expect(open(d({ legacy }), st).get()).toEqual({ a: 4, b: true, c: 'y' })
    expect(open(d({ legacy }), mem({ 'old.c': 'null', 'old.bad': '{nope' })).get()).toEqual({ a: 0, b: false, c: null })
    expect(open(d({ legacy }), mem({ 'old.a': '4', 'qk:old': JSON.stringify({ version: 1, base: { a: 9 } }) })).get().a).toBe(9) // a saved record wins; the old keys are left alone
  })
  it('a function legacy still works', () => {
    expect(open(d({ legacy: (s) => ({ a: Number(s.getItem('x')) }) }), mem({ x: '8' })).get().a).toBe(8)
  })
})

describe('storage: tab', () => {
  it('a state declared for the tab uses the tab storage, others the device storage', () => {
    const dev = mem(), tab = mem()
    const app = createApp({ storage: dev, tabStorage: tab, device: 'd' })
    const t = app.use(card({ name: 'tabbed', storage: 'tab' })), l = app.use(card({ name: 'plain' }))
    t.dispatch('to.set', { to: 'T' }); l.dispatch('to.set', { to: 'L' }); app.flush()
    expect(Object.keys(tab.m).includes('qk:tabbed')).toBe(true); expect(Object.keys(dev.m).includes('qk:plain')).toBe(true)
    expect(Object.keys(dev.m).includes('qk:tabbed')).toBe(false)
  })
})
