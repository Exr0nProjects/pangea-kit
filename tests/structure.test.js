// lib/engine/structure.js: split and join as single ops with identity over per-field LWW rows (census A29; PANGEA3-DESIGN
// §11 keyed rows, §19). Each rule has its regression from the zai2 10,000-seed concurrent fuzz and a planted bug that
// turns it red.
import { describe, expect, it } from 'vitest'
import { mergeRow, stampOf, splitGroup } from '../lib/engine/rows.js'
import { identify, viewRow, viewDoc, viewStats, together, undoMoves, SEEN } from '../lib/engine/structure.js'
import { inverse, casStep } from '../lib/history.js'
import { memoryLines } from '../lib/editor/editor.js'
import { fuzzSeed } from '../lib/testing/convergence.js'
import model from '../lib/testing/example/lines.model.js'
import * as L from '../lib/testing/example/lines.js'
import { planted } from './planted.js'

// two replicas of one row store; a write is stamped by its device and delivered to both in a chosen order
const store = () => new Map()
let clockN = 0
const write = (puts, dev) => puts.map((p) => ({ id: p.id, set: p.set, at: Object.fromEntries(Object.keys(p.set).map((f) => [f, stampOf(1000 + ++clockN, dev, clockN)])) }))
const deliver = (m, patches) => { for (const p of patches) m.set(p.id, mergeRow(m.get(p.id), p)) }
const shown = (m) => [...m.values()].filter((r) => !r.deleted_at).sort((a, b) => a.ord - b.ord).map((r) => viewRow(r, (id) => m.get(id)).body)
const seedRow = { id: 'r', set: { body: 'alpha beta丁', ord: 1, mvseen: '' } }
const base = () => { const m = store(); deliver(m, write([seedRow], 'seed')); return m }

// device A splits r after "alpha " (the tail "beta丁" moves to new row n); device B, not having seen the split, rewrites
// r (types 丂 into the tail). Every delivery order must show each token once.
function splitVsRewrite({ identified = true } = {}) {
  const a = base(), b = base()
  const getA = (id) => viewRow(a.get(id), (x) => a.get(x))
  const split = { puts: [{ id: 'r', set: { body: 'alpha ' } }, { id: 'n', set: { body: 'beta丁', ord: 1.5 } }], moves: [{ op: 'n', from: 'r', start: 6, end: 11, to: 'n', pos: 0, at: 0 }] }
  const rewrite = { puts: [{ id: 'r', set: { body: 'alpha be丂ta丁' } }] }
  const getB = (id) => viewRow(b.get(id), (x) => b.get(x))
  const sp = write((identified ? identify(split, { get: getA, moves: split.moves }) : split).puts, 'A')
  const rw = write((identified ? identify(rewrite, { get: getB }) : rewrite).puts, 'B') // B's stamp is later: its text wins r
  return { orders: [[sp, rw], [rw, sp]].map((order) => { const m = base(); for (const ps of order) deliver(m, ps); return shown(m) }) }
}

describe('split and join are single ops with identity (census A29)', () => {
  it('a concurrent split and rewrite of one line leave every word in one row, in any delivery order', () => {
    const { orders } = splitVsRewrite()
    expect(orders[0]).toEqual(orders[1])
    const all = orders[0].join('|')
    for (const t of ['丁']) expect(all.split(t).length - 1).toBe(1)
    expect(orders[0]).toEqual(['alpha ', 'beta丁']) // the rewrite inside the moved tail is dropped with it (LWW), never copied
  })
  it('planted: the split as two plain row writes (no identity) duplicates the tail (the 515-seed bug)', () => {
    const { orders } = splitVsRewrite({ identified: false })
    expect(orders[0].join('|').split('丁').length - 1).toBe(2)
  })
  it('the undo of a split keeps its records marked undone and gives the line back whole', () => {
    const m = base(), get = (id) => viewRow(m.get(id), (x) => m.get(x))
    const op = identify({ puts: [{ id: 'r', set: { body: 'alpha ' } }, { id: 'n', set: { body: 'beta丁', ord: 1.5, deleted_at: null } }], moves: [{ op: 'n', from: 'r', start: 6, end: 11, to: 'n', pos: 0, at: 0 }] }, { get, moves: [{ op: 'n', from: 'r', start: 6, end: 11, to: 'n', pos: 0, at: 0 }] })
    const inv = undoMoves((b, p) => inverse(b, p, L.CAS))((id) => m.get(id), op.puts)
    deliver(m, write(op.puts, 'A'))
    const step = casStep(inv, op.puts, (id) => m.get(id), L.CAS)
    expect(step.conflict).toBeUndefined()
    deliver(m, write(step.puts, 'A'))
    expect(shown(m)).toEqual(['alpha beta丁'])
    expect(JSON.parse(m.get('r')['mv:n']).undone).toBe(true)
  })
})

describe('text and mvseen are written together (one invariant, enforced by the store)', () => {
  it('rows.put refuses a patch that writes one of the group without the other (openRows({ together }))', () => {
    expect(splitGroup({ id: 'r', set: { body: 'x' } }, together())).toMatch(/without mvseen/)
    expect(splitGroup({ id: 'r', set: { body: 'x', [SEEN]: '' } }, together())).toBe(null)
    expect(splitGroup({ id: 'r', set: { deleted_at: 'x' } }, together())).toBe(null)
  })
  it('a removal inverse that carries the words carries the row\'s mvseen too (zai2 concurrent seed 1976)', () => {
    const before = { id: 'r', body: 'w', mvseen: 'x1' }
    const inv = undoMoves((b, p) => inverse(b, p, L.CAS))(() => before, [{ id: 'r', set: { deleted_at: 't', updated_at: 't' } }])
    expect(splitGroup(inv[0], together())).toBe(null)
    expect(inv[0].set.mvseen).toBe('x1')
  })
  it('planted: identify without mvseen on text writes is caught by the harness (every put, every path)', async () => {
    const S = await planted('lib/engine/structure.js', '    p.set[SEEN] = joinSeen(s);', '    void s;')
    const bad = { ...model, edit: (ctx) => { const st = model.edit(ctx); return st?.op ? { ...st, op: S.identify({ puts: st.op.puts.map((p) => ({ id: p.id, set: Object.fromEntries(Object.entries(p.set).filter(([k]) => k !== SEEN)) })) }, { get: ctx.get }) } : st } }
    let hit = null
    for (let s = 1; s < 40 && !hit; s++) hit = fuzzSeed(bad, 'concurrent', s, { shrink: false })
    expect(hit?.error).toMatch(/without mvseen/)
  })
})

describe('the zai2-class regressions replay on the kit example model', () => {
  // seeds from the kit example model whose concurrent runs exercise split, join, paste tails, undo of moves and chains
  it('300 concurrent seeds: no word ends in two rows, replicas converge', () => {
    for (let s = 1; s <= 300; s++) expect(fuzzSeed(model, 'concurrent', s, { shrink: false }), `seed ${s}`).toBe(null)
  })
})

describe('per-keystroke work at 30,000 rows', () => {
  it('lines() through viewDoc derives only the rows that changed', () => {
    const rows = Array.from({ length: 30000 }, (_, k) => ({ id: `r${k}`, ord: k, body: `line ${k}`, mvseen: '' }))
    rows[5] = { ...rows[5], 'mv:x': JSON.stringify({ to: 'r6', base: 'line 5 tail', start: 7, end: 11, seen: [] }) }
    const doc = viewDoc(memoryLines(rows, { sortKey: (r) => [r.ord, r.id] }))
    doc.lines() // warm
    const d0 = viewStats.derived
    doc.put([{ id: 'r100', set: { body: 'typed', mvseen: '' } }])
    doc.lines()
    // the bound is counted work, not wall time (a time limit flakes under a loaded suite): one derivation for the one row
    // the keystroke wrote; every other row is a WeakMap hit
    expect(viewStats.derived - d0).toBe(1)
  })
})
