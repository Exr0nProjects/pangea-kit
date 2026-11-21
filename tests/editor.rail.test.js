// The rail (lib/editor/rail.js; zai3 stream of recent highlights, parity with old zai's NotesStream): its state is a kit declaration with absolute actions
// (a reload of the list replaces it whole, junk items are dropped, a javascript: href never survives), and the pure helpers (ago column, the written-ids
// mark) are exact. Laws run by validate over random actions.
import { describe, expect, it } from 'vitest'
import { railDecl, cleanItem, cleanItems, shortAgo, oneLine, writtenIds, MAX_ITEMS } from '../lib/editor/rail.js'
import { createReplica } from '../lib/model.js'
import { validate } from '../lib/validate.js'

const mem = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v) }, del: async (k) => { m.delete(k) }, keys: async () => [...m.keys()], m } }

describe('railDecl', () => {
  it('validate runs every law over the rail actions (idempotent, total, reload)', async () => {
    const d = railDecl('t-rail')
    const r = await validate({ decls: [d], ui: true, timing: false })
    expect(r.ok, JSON.stringify(r).slice(0, 700)).toBe(true)
  }, 60000)
  it('loaded replaces the list whole, keeps the limit, flags more; failed keeps the old list and says why; open is absolute', () => {
    const d = railDecl('t-rail-2'), acts = d.actions
    let s = d.initial
    s = acts['rail.loaded'](s, { items: [{ id: 'a', text: 'one', at: 5, href: 'https://x.test/r?note=a' }], limit: 20, more: true, at: 9 })
    expect(s.items.map((x) => x.id)).toEqual(['a']); expect(s.limit).toBe(20); expect(s.more).toBe(true); expect(s.status).toBe('ready')
    s = acts['rail.loaded'](s, { items: [{ id: 'b' }, { id: 'a' }], limit: 40, more: false })
    expect(s.items.map((x) => x.id)).toEqual(['b', 'a'])
    const f = acts['rail.failed'](s, { err: 'offline' }); expect(f.status).toBe('error'); expect(f.items).toBe(s.items); expect(f.err).toBe('offline')
    expect(acts['rail.open'](s, { on: true }).open).toBe(true); expect(acts['rail.open'](s, { on: 'yes' })).toBe(s)
    const o = acts['rail.open'](s, { on: true }); expect(acts['rail.open'](o, { on: true })).toBe(o)
  })
})

describe('items', () => {
  it('junk is dropped, a non-http href never survives, text is clipped', () => {
    expect(cleanItem({ id: 'a', href: 'javascript:alert(1)' }).href).toBe('')
    expect(cleanItem({ id: 'a', href: 'https://chat.test/reader?doc=1' }).href).toBe('https://chat.test/reader?doc=1')
    expect(cleanItem({ text: 'no id' })).toBeNull(); expect(cleanItem(null)).toBeNull(); expect(cleanItem({ id: 5 })).toBeNull()
    expect(cleanItem({ id: 'a', text: 'x'.repeat(5000) }).text).toHaveLength(2000)
    expect(cleanItems('x')).toEqual([]); expect(cleanItems(Array.from({ length: MAX_ITEMS + 9 }, (_, i) => ({ id: `i${i}` })))).toHaveLength(MAX_ITEMS)
  })
  it('the ago column and the one-line quote', () => {
    const now = Date.UTC(2026, 10, 12, 12)
    expect(shortAgo(now - 20_000, now)).toBe('now'); expect(shortAgo(now - 3 * 60_000, now)).toBe('3m'); expect(shortAgo(now - 2 * 3600_000, now)).toBe('2h'); expect(shortAgo(now - 5 * 86_400_000, now)).toBe('5d')
    expect(shortAgo(0, now)).toBe(''); expect(shortAgo(NaN, now)).toBe('')
    expect(oneLine('  a\n  b \t c ')).toBe('a b c')
  })
  it('writtenIds finds the items whose backlink is already in the document', () => {
    const items = cleanItems([{ id: 'n1', href: 'https://r.test/reader?doc=d&section=2&note=n1' }, { id: 'n2', href: 'https://r.test/reader?doc=d&note=n2' }, { id: 'n3' }])
    expect([...writtenIds(['plain', 'from Book https://r.test/reader?doc=d&section=2&note=n1'], items)]).toEqual(['n1'])
    expect([...writtenIds([], items)]).toEqual([])
  })
})
