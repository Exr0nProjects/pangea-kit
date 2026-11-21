// lib/history.js: undo/redo as an all-or-nothing compare-and-set by value (moved up from zai2, zai-pangea 2b0e0b2,
// test/undo-cas.test.js), and undoHistory's casSeek / drop over the same rule. Deterministic: one injected, strictly
// increasing clock drives every edit, stamp, tombstone and history step; crypto.getRandomValues (line ids) is seeded.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeRow, stampOf } from '../lib/engine/rows.js'
import { casStep, createCasHistory, inverse } from '../lib/history.js'
import { undoHistory, casSeek } from '../lib/components.js'
import * as D from '../lib/testing/example/lines.js'

const T0 = Date.UTC(2026, 10, 8, 12)
let t = T0
const tick = () => (t += 1)
const iso = () => new Date(tick()).toISOString()
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 } }
let cryptoSpy
beforeEach(() => {
  t = T0
  const r = rng(7)
  cryptoSpy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(r() * 256); return a })
})
afterEach(() => cryptoSpy.mockRestore())

function device(name, rows, { hist = D.createHistory({ now: () => t }), inv = D.inverse } = {}) {
  let n = 0
  // stamps as the rows module mints them (later than the field stamps being overwritten), on the injected clock
  const put = (puts) => {
    for (const p of puts) {
      n += 1
      const cur = rows.get(p.id)
      const floor = Math.max(-1, ...Object.keys(p.set).map((f) => (cur?._s?.[f] ? parseInt(cur._s[f].slice(0, 9), 36) : -1))) + 1
      const s = stampOf(Math.max(tick(), floor), name, n)
      rows.set(p.id, mergeRow(cur, { id: p.id, set: p.set, at: Object.fromEntries(Object.keys(p.set).map((f) => [f, s])) }))
    }
  }
  const live = () => [...rows.values()].filter(D.isLive).sort((a, b) => a.ord - b.ord)
  return {
    live, put, hist,
    apply(op) { hist.record(inv((id) => { const r = rows.get(id); return r && D.isLive(r) ? r : undefined }, op.puts), op.puts); put(op.puts) },
    undo() { tick(); const h = hist.undo((id) => rows.get(id)); if (h) put(h.puts); return h },
    redo() { tick(); const h = hist.redo((id) => rows.get(id)); if (h) put(h.puts); return h },
  }
}
const seed = (bodies) => {
  const m = new Map()
  bodies.forEach((b, i) => m.set(`l${i}`, mergeRow(undefined, { id: `l${i}`, set: { kind: 'text', body: b, ord: i + 1, zone: 'timeline', deleted_at: null }, at: Object.fromEntries(['kind', 'body', 'ord', 'zone', 'deleted_at'].map((f) => [f, stampOf(1, 's', 1)])) })))
  return m
}
const texts = (d) => d.live().map((r) => r.body)
// the pre-fix histories (zai2 before 2b0e0b2 and its intermediate shapes), for planting the bugs back
export function planted({ drop = true, perField = false, guard = true, rebase = false } = {}) {
  const now = () => t, undos = [], redos = []; let seq = 0
  const fresh = (puts) => { const at = new Date(now()).toISOString(); return puts.map((p) => ({ id: p.id, set: { ...p.set, updated_at: at } })) }
  const step = (puts, exp, get) => {
    if (!guard) return { puts: fresh(puts) }
    if (rebase) { // a body someone changed since is rebased (the step's own text change re-applied around theirs) when it does not overlap
      const e = new Map(exp.map((p) => [p.id, p.set])), out = []
      for (const p of puts) {
        const row = get(p.id), x = e.get(p.id), set = { ...p.set }
        if (row && x && 'body' in p.set && 'body' in x && (row.body ?? '') !== (x.body ?? '')) {
          const from = x.body ?? '', to = p.set.body ?? '', cur = row.body ?? ''
          let pre = 0; while (pre < from.length && pre < to.length && from[pre] === to[pre]) pre++
          let suf = 0; while (suf < from.length - pre && suf < to.length - pre && from[from.length - 1 - suf] === to[to.length - 1 - suf]) suf++
          const gone = from.length - pre - suf
          if (cur.slice(0, pre) !== from.slice(0, pre) || !cur.endsWith(from.slice(from.length - suf)) || cur.length - suf < pre + gone) return { puts: [], conflict: true }
          set.body = cur.slice(0, pre) + to.slice(pre, to.length - suf) + cur.slice(pre + gone)
        }
        out.push({ id: p.id, set })
      }
      return { puts: fresh(out) }
    }
    if (!perField) return casStep(puts, exp, get, { ...D.CAS, now })
    const e = new Map(exp.map((p) => [p.id, p.set])); const out = []; let conflict = false
    for (const p of puts) { const row = get(p.id), x = e.get(p.id); if (!row || !x) { out.push(p); continue } const set = {}; for (const f of Object.keys(p.set)) { if (f === 'updated_at' || f === 'indent' || (row[f] ?? null) === ((f in x ? x[f] : p.set[f]) ?? null)) set[f] = p.set[f]; else conflict = true } if (Object.keys(set).length) out.push({ id: p.id, set }) }
    return { puts: fresh(out), conflict }
  }
  return {
    record(inv, puts) { undos.push({ op: `h${++seq}`, back: inv, forward: puts }); redos.length = 0 },
    undo(get) { const e = undos.pop(); if (!e) return null; const r = step(e.back, e.forward, get); if (!r.conflict || !drop) redos.push(e); return { op: e.op, ...r } },
    redo(get) { const e = redos.pop(); if (!e) return null; const r = step(e.forward, e.back, get); if (!r.conflict || !drop) undos.push(e); return { op: e.op, ...r } },
    get sizes() { return { undo: undos.length, redo: redos.length } },
  }
}

describe('createCasHistory: undo as compare-and-set by value', () => {
  it('undoing a merge after another device appended to the merged line is skipped whole (no rebase, no duplicate)', () => {
    const rows = seed(['ab', 'cd']); const a = device('A', rows), b = device('B', rows)
    a.apply(D.backspaceAtStart(a.live(), 1, tick()))
    b.put(D.typed(rows.get('l0'), 'abcd!', tick()).puts)
    expect(a.undo().conflict).toBe(true)
    expect(texts(a)).toEqual(['abcd!'])
    expect(a.redo()).toBe(null)
  })
  it('undoing a merge after another device split the merged line is skipped (the split-off words are not revived twice)', () => {
    const rows = seed(['ab', 'cd']); const a = device('A', rows), b = device('B', rows)
    a.apply(D.backspaceAtStart(a.live(), 1, tick()))
    b.put(D.enter(b.live(), 0, 2, tick()).puts)
    expect(a.undo().conflict).toBe(true)
    expect(texts(a)).toEqual(['ab', 'cd'])
  })
  it('an undo whose text another device rewrote is skipped, keeping the newer write (bug 2: no overwrite)', () => {
    const rows = seed(['hello']); const a = device('A', rows), b = device('B', rows)
    a.apply(D.typed(rows.get('l0'), 'hello world', tick()))
    b.put(D.typed(rows.get('l0'), 'hello there', tick()).puts)
    expect(a.undo().conflict).toBe(true)
    expect(texts(a)).toEqual(['hello there'])
  })
  it('never revives a line another device deleted after the step it undoes (bug 2: no resurrection)', () => {
    const rows = seed(['ab', 'cd']); const a = device('A', rows), b = device('B', rows)
    a.apply(D.enter(a.live(), 1, 2, tick()))
    const nid = a.live()[2].id
    a.apply(D.typed(rows.get(nid), 'new', tick()))
    b.put([{ id: nid, set: { deleted_at: iso() } }])
    a.undo(); a.undo(); a.redo(); a.redo()
    expect(texts(a)).toEqual(['ab', 'cd'])
  })
  it('undoing the creation of a line another device typed into keeps the line', () => {
    const rows = seed(['ab']); const a = device('A', rows), b = device('B', rows)
    a.apply(D.enter(a.live(), 0, 2, tick()))
    const nid = a.live()[1].id
    b.put(D.typed(rows.get(nid), 'theirs', tick()).puts)
    expect(a.undo().conflict).toBe(true)
    expect(texts(a)).toEqual(['ab', 'theirs'])
  })
  it('single device: undo and redo are exact (no remote writes, no conflicts)', () => {
    const rows = seed(['one', 'two']); const a = device('A', rows)
    a.apply(D.typed(rows.get('l0'), 'one!', tick()))
    a.apply(D.backspaceAtStart(a.live(), 1, tick()))
    a.apply(D.enter(a.live(), 0, 2, tick()))
    const end = texts(a)
    for (let k = 0; k < 3; k++) expect(a.undo().conflict).toBeFalsy()
    expect(texts(a)).toEqual(['one', 'two'])
    for (let k = 0; k < 3; k++) expect(a.redo().conflict).toBeFalsy()
    expect(texts(a)).toEqual(end)
  })
  // zai2's three causal-fuzz finds (bug 3: undo/redo duplicated text), minimal forms; each is also run against the bug it
  // found, planted back (the pre-fix history), and must fail there
  const SEEDS = {
    302: (opt) => { // a step skipped as a conflict leaves history, so a later redo cannot apply it twice
      const rows = seed(['ab']); const a = device('A', rows, opt()), b = device('B', rows)
      a.apply(D.typed(rows.get('l0'), 'abXY', tick()))
      b.put(D.typed(rows.get('l0'), 'abX!Y', tick()).puts)
      expect(a.undo().conflict).toBe(true)
      a.redo()
      expect(texts(a)).toEqual(['abX!Y'])
      expect(a.hist.sizes).toEqual({ undo: 0, redo: 0 })
    },
    754: (opt) => { // undoing a split whose new line another device deleted (moving its words) is skipped
      const rows = seed(['timeline 3']); const a = device('A', rows, opt()), b = device('B', rows)
      a.apply(D.enter(a.live(), 0, 4, tick()))
      const nid = a.live()[1].id
      b.put(D.replaceRange(b.live(), 0, 4, 1, 0, 'X\n', tick()).puts)
      const before = texts(a)
      a.undo()
      expect(texts(a)).toEqual(before)
      expect(texts(a).join('').split('line 3').length - 1).toBe(1)
      expect(rows.get(nid).deleted_at).toBeTruthy()
    },
    7504: (opt) => { // redo of a merge is refused when the removed line has been written to since (removal carries words)
      const rows = seed(['top', 'mid']); const a = device('A', rows, opt()), b = device('B', rows)
      a.apply(D.backspaceAtStart(a.live(), 1, tick()))
      a.undo()
      b.put(D.typed(rows.get('l1'), 'mid!', tick()).puts)
      a.redo()
      expect(texts(a)).toEqual(['top', 'mid!'])
    },
  }
  const SEEDS2 = {
    splitMerge: (opt) => { // undoing a merge after another device split the merged line: per-field skipping revives the removed line beside the split-off copy
      const rows = seed(['ab', 'cd']); const a = device('A', rows, opt()), b = device('B', rows)
      a.apply(D.backspaceAtStart(a.live(), 1, tick()))
      b.put(D.enter(b.live(), 0, 2, tick()).puts)
      a.undo()
      expect(texts(a)).toEqual(['ab', 'cd'])
    },
  }
  it('split-merge form passes on the kit history', () => SEEDS2.splitMerge(() => ({})))
  const fixed = () => ({})
  const PLANTED = {
    302: () => ({ hist: planted({ drop: false }) }),     // conflict moved to the other stack instead of dropped
    754: () => ({ hist: planted({ rebase: true }) }),   // a moved body rebased instead of a conflict (the text rebase zai2 dropped)
    7504: () => ({ inv: (b, p) => inverse(b, p, { ...D.CAS, carry: [] }) }), // removal inverse without the words
  }
  for (const n of Object.keys(SEEDS)) {
    it(`seed ${n}: passes on the kit history`, () => SEEDS[n](fixed))
    it(`seed ${n}: fails with its bug planted back`, () => expect(() => SEEDS[n](PLANTED[n])).toThrow())
    if (n === '302') it('seed 302 shape: skipping only the conflicting fields (per-field) fails the split-merge form', () => expect(() => SEEDS2.splitMerge(() => ({ hist: planted({ perField: true }) }))).toThrow())
    it(`seed ${n}: an unguarded action-log undo (no compare-and-set) fails it too`, () => expect(() => SEEDS[n](() => ({ hist: planted({ guard: false }), inv: (b, p) => inverse(b, p, { ...D.CAS, carry: [] }) }))).toThrow())
  }
  it('record dedupes by id: a duplicate delivery of the same op lands no second entry', () => {
    const h = createCasHistory({ now: () => t })
    const puts = [{ id: 'a', set: { body: 'x' } }], inv = [{ id: 'a', set: { body: '' } }]
    const op = h.record(inv, puts, { id: 'op-1' })
    expect(h.record(inv, puts, { id: 'op-1' })).toBe(op)
    expect(h.sizes).toEqual({ undo: 1, redo: 0 })
    expect(h.record(inv, puts, { id: 'op-2' })).not.toBe(op)
    expect(h.sizes.undo).toBe(2)
  })
  it('without get the step applies unguarded (single-replica callers keep the old behaviour)', () => {
    const h = createCasHistory({ now: () => t })
    h.record([{ id: 'a', set: { body: 'old' } }], [{ id: 'a', set: { body: 'new' } }])
    const r = h.undo()
    expect(r.conflict).toBeUndefined()
    expect(r.puts[0].set.body).toBe('old')
    expect(typeof r.puts[0].set.updated_at).toBe('string')
  })
})

describe('undoHistory + casSeek: the same compare-and-set for the log component', () => {
  const run = (s, comp, ops) => { for (const [op, p] of ops) { const g = comp.gestures[op]; const a = g ? g(s, p) : [op, p]; if (a) s = comp.actions[a[0]](s, a[1]) } return s }
  it('an undone entry whose row moved since is a conflict: no puts, and drop removes it so redo cannot replay it', () => {
    const comp = undoHistory()
    const rows = new Map([['a', { id: 'a', body: 'abX!Y', deleted_at: null }]])
    let s = run(comp.initial, comp, [['record', { id: 'e1', actions: [{ id: 'a', set: { body: 'abXY' }, prev: { body: 'ab' } }] }]])
    const before = s; s = run(s, comp, [['undo', {}]])
    const r = casSeek(before, s, (id) => rows.get(id))
    expect(r).toEqual({ puts: [], drop: ['e1'] })
    s = run(s, comp, [['drop', { id: 'e1' }]])
    expect(s.entries).toEqual([]); expect(s.position).toBe(0)
    expect(comp.gestures.redo(s, {})).toBe(null)
  })
  it('a clean undo and redo return guarded puts; a multi-step seek sees its own earlier steps', () => {
    const comp = undoHistory()
    const rows = new Map([['a', { id: 'a', body: 'abc', deleted_at: null }]])
    let s = run(comp.initial, comp, [
      ['record', { id: 'e1', actions: [{ id: 'a', set: { body: 'ab' }, prev: { body: 'a' } }] }],
      ['record', { id: 'e2', actions: [{ id: 'a', set: { body: 'abc' }, prev: { body: 'ab' } }] }],
    ])
    const before = s; s = comp.actions.seek(s, { position: 0 })
    const r = casSeek(before, s, (id) => rows.get(id), { stamp: null })
    expect(r.drop).toEqual([]); expect(r.puts.map((p) => p.set.body)).toEqual(['ab', 'a'])
    rows.set('a', { id: 'a', body: 'a', deleted_at: null })
    const b2 = s; s = comp.actions.seek(s, { position: 2 })
    expect(casSeek(b2, s, (id) => rows.get(id), { stamp: null }).puts.map((p) => p.set.body)).toEqual(['ab', 'abc'])
  })
  it('drop of an unknown id is the same state (no-op), and dropping a done entry moves the position back', () => {
    const comp = undoHistory()
    let s = run(comp.initial, comp, [['record', { id: 'e1', actions: [] }], ['record', { id: 'e2', actions: [] }]])
    expect(comp.actions.drop(s, { id: 'nope' })).toBe(s)
    s = comp.actions.drop(s, { id: 'e1' })
    expect(s.entries.map((e) => e.ids[0])).toEqual(['e2']); expect(s.position).toBe(1)
  })
})
