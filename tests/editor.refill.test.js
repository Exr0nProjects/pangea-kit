// The zone refill sentinel (lib/editor/refill.js; the owner 2026-11-10 21:22-21:25 PST): { type: 'refill', zone } carries no
// rows; applied to the state it meets it writes exactly `count` blank rows when the zone has no live row and nothing
// otherwise, with ids from the zone and a generation. Laws: a single application on an empty zone yields exactly 2 rows,
// on a non-empty zone 0; applying it twice is applying it once; two devices refilling the same state write the same rows
// (merge by id, never 4); a late or replayed refill is a no-op unless the zone is empty again; a tombstoned or relocated
// pad is never resurrected or overwritten (the generation moves on). Each law has a planted bug that turns it red.
import { describe, expect, it } from 'vitest'
import { createEditor, memoryLines, modelRun, initState, step } from '../lib/editor/editor.js'
import { declareEditor } from '../lib/editor/declare.js'
import { refillPuts, emptyZones, padId, isPadRow, checkRefill } from '../lib/editor/refill.js'
import { validate } from '../lib/validate.js'
import { planted } from './planted.js'

const ZONES = ['a', 'b', 'c']
const spec = { zones: ZONES, zoneOf: (r) => r.zone, make: (zone, k) => ({ kind: 'text', body: '', ord: k, zone, deleted_at: null, source: 'pad' }) }
const sortKey = (r) => [ZONES.indexOf(r.zone), r.ord, r.id]
const row = (id, zone, ord, body = 'x', extra = {}) => ({ id, zone, ord, body, deleted_at: null, ...extra })
const mem = (rows) => memoryLines(rows, { sortKey })
const app = { keys: ['Tab'], textOf: (r) => r.body ?? '', estimate: () => 20, items: (d) => d.lines().map((r) => ({ ...r, key: r.id, addr: r.id })), render: (it) => ({ tag: 'div', addr: it.id, children: it.body ? [it.body] : [{ tag: 'br' }] }), reduce(state, a, ctx) { if (a.type === 'key' && state.sel) { const r = ctx.get(state.sel.f.id); return r ? { puts: [{ id: r.id, set: { body: `  ${r.body}` } }] } : null } return null } }
const rng = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 } }

/** Every law of the sentinel over seeded random documents, against a given refillPuts. Returns the failures. */
function laws(refillPutsFn, runs = 2000) {
  const bad = [], r = rng(7)
  for (let n = 0; n < runs; n++) {
    const rows = []
    for (const z of ZONES) if (r() < 0.6) for (let i = 0, m = 1 + Math.floor(r() * 3); i < m; i++) rows.push(row(`${z}${i}`, z, i + 1, r() < 0.5 ? '' : 'w', r() < 0.2 ? { deleted_at: 'x' } : {}))
    if (r() < 0.3) rows.push(row(padId('a', 0, 1), 'a', 1, '', { deleted_at: 'dead', source: 'pad' }))
    const doc = mem(rows), lines = doc.lines()
    for (const z of ZONES) {
      const live = lines.some((x) => x.zone === z)
      const puts = refillPutsFn(lines, doc.peek, spec, z, 5)
      if (live && puts.length) bad.push(`non-empty ${z} got ${puts.length} rows (run ${n})`)
      if (!live && puts.length !== 2) bad.push(`empty ${z} got ${puts.length} rows (run ${n})`)
      for (const p of puts) if (doc.peek(p.id)) bad.push(`${p.id} reused a known row (run ${n})`)
      doc.put(puts)
      if (refillPutsFn(doc.lines(), doc.peek, spec, z, 6).length) bad.push(`second application changed ${z} (run ${n})`)
      if (!live && doc.lines().filter((x) => x.zone === z).length !== 2) bad.push(`${z} not exactly 2 after (run ${n})`)
    }
    // two devices from the same state write the same rows; merge by id leaves 2
    const a = mem(rows), b = mem(rows)
    const pa = refillPutsFn(a.lines(), a.peek, spec, 'b', 1), pb = refillPutsFn(b.lines(), b.peek, spec, 'b', 2)
    if (pa.map((p) => p.id).join() !== pb.map((p) => p.id).join()) bad.push(`devices disagree on ids (run ${n})`)
    a.put(pa); a.put(pb)
    if (!a.lines().some((x) => x.zone === 'b') !== false && a.lines().filter((x) => x.zone === 'b').length > 2 && !rows.some((x) => x.zone === 'b' && !x.deleted_at)) bad.push(`refills stacked (run ${n})`)
  }
  return bad
}

describe('the refill sentinel (pure)', () => {
  it('on an empty zone exactly 2 blank rows, on a non-empty zone none, twice is once, devices agree by id (2000 random documents)', () => {
    expect(laws(refillPuts)).toEqual([])
  })
  it('ids are pad:<zone>:<generation>:<k>; a tombstoned pad is never resurrected (the generation moves on) and a pad moved to another zone is never overwritten', () => {
    const doc = mem([row('b1', 'b', 1), row('c1', 'c', 1), row(padId('a', 0, 1), 'a', 1, '', { deleted_at: 'x' }), row(padId('a', 0, 2), 'a', 2, '', { deleted_at: 'x' })])
    expect(refillPuts(doc.lines(), doc.peek, spec, 'a', 1).map((p) => p.id)).toEqual([padId('a', 1, 1), padId('a', 1, 2)])
    const moved = mem([row(padId('b', 0, 1), 'a', 1, 'typed then archived'), row('c1', 'c', 1)]) // pad:b:0:1 now lives in zone a
    expect(refillPuts(moved.lines(), moved.peek, spec, 'b', 1).map((p) => p.id)).toEqual([padId('b', 1, 1), padId('b', 1, 2)])
    expect(refillPuts(doc.lines(), doc.peek, spec, 'a', 1)[0].set).toMatchObject({ body: '', source: 'pad', zone: 'a', deleted_at: null })
    expect(isPadRow({ id: padId('a', 0, 1) })).toBe(true); expect(isPadRow({ id: 'zabc' })).toBe(false)
  })
  it('junk never chokes: an unknown zone, a missing spec, a non-string zone, a bad declaration', () => {
    const doc = mem([])
    for (const z of ['nowhere', 7, null, undefined, {}]) expect(refillPuts(doc.lines(), doc.peek, spec, z, 1)).toEqual([])
    expect(refillPuts(doc.lines(), doc.peek, null, 'a', 1)).toEqual([])
    expect(emptyZones(mem([row('x', 'b', 1)]).lines(), spec)).toEqual(['a', 'c'])
    expect(() => checkRefill({ zones: [], zoneOf() {}, make() {} })).toThrow(/zones/)
    expect(() => checkRefill({ zones: ['a'], zoneOf() {}, make() {}, extra: 1 })).toThrow(/unknown refill key/)
    expect(() => checkRefill({ zones: ['a:b'], zoneOf() {}, make() {} })).toThrow(/zones/)
  })
  it('a paged doc: a zone BEFORE the first loaded row may hold unread older rows, so it is never judged empty until the doc is complete; zones after it are', () => {
    const lines = mem([row('b9', 'b', 9)]).lines() // loaded window starts in zone b
    expect(emptyZones(lines, spec, false)).toEqual(['c'])
    expect(refillPuts(lines, () => undefined, spec, 'a', 1, false)).toEqual([])
    expect(emptyZones(lines, spec, true)).toEqual(['a', 'c'])
    expect(emptyZones([], spec, false)).toEqual([]) // nothing loaded: nothing can be said
    expect(refillPuts(lines, () => undefined, spec, 'a', 1, true).length).toBe(2)
  })
  it('planted: a refill that ignores a non-empty zone is red (stacks)', async () => {
    const mod = await planted('lib/editor/refill.js', 'for (const r of lines) if (spec.zoneOf(r) === zone) return [];', '')
    expect(laws(mod.refillPuts, 300).length).toBeGreaterThan(0)
  })
  it('planted: a refill that reuses the dead pad id (no generation) is red', async () => {
    const mod = await planted('lib/editor/refill.js', 'while (used()) g += 1;', '')
    expect(laws(mod.refillPuts, 800).length).toBeGreaterThan(0)
  })
})

describe('the refill sentinel through the kit reducer and the declaration gate', () => {
  it('step applies { type: refill, zone } to the doc it meets; a replay of the logged actions reaches the same rows', () => {
    const rows = [row('b1', 'b', 1)]
    const log = [{ type: 'refill', zone: 'a', id: 'r1', at: 10 }, { type: 'refill', zone: 'a', id: 'r2', at: 11 }, { type: 'refill', zone: 'b', id: 'r3', at: 12 }, { type: 'refill', zone: 'c', id: 'r4', at: 13 }]
    const m1 = modelRun(app, rows, log, { sortKey, refill: spec }), m2 = modelRun(app, rows, log, { sortKey, refill: spec })
    expect(m1.doc.lines().map((r) => r.id)).toEqual([padId('a', 0, 1), padId('a', 0, 2), 'b1', padId('c', 0, 1), padId('c', 0, 2)])
    expect(m2.doc.lines()).toEqual(m1.doc.lines())
    expect(modelRun(app, rows, log, { sortKey }).doc.lines().map((r) => r.id)).toEqual(['b1']) // a reducer with no declaration skips it, never chokes
  })
  it('validate runs every law (idempotent among them) over the declared sentinel, with coverage', async () => {
    const contract = { name: 'refill-laws', actions: [], refill: spec, sortKey, sample: [row('b1', 'b', 1, 'first line'), row('b2', 'b', 2, 'second line here'), row('c1', 'c', 1, 'last')] }
    const d = declareEditor(contract, app)
    const r = await validate({ decls: [d.view, d.edits], ui: true, timing: false })
    expect(r.failures.map((f) => `${f.name}: ${f.law}: ${f.detail}`).join('\n')).toBe('')
    const v = r.decls.find((x) => x.name === 'editor:refill-laws')
    expect(v.coverage.refill).toBeGreaterThan(0); expect(v.uncovered).toEqual([])
  }, 60000)
})

describe('createEditor dispatches the sentinel', () => {
  const mount = (rows, opts = {}) => {
    document.body.innerHTML = '<div><div id="d" contenteditable="true"></div></div>'
    let t = 1e12; const doc = mem(rows)
    const ed = createEditor({ root: document.getElementById('d'), app, doc, contract: { name: `refill-ed-${Math.random()}`, actions: [], refill: spec, sortKey }, clock: () => (t += 10), ...opts })
    return { ed, doc }
  }
  it('nothing before the app says its rows are in; then one refill per empty zone; the log carries only { type: refill, zone }', () => {
    let ready = false
    const { ed, doc } = mount([row('b1', 'b', 1)], { refillReady: () => ready })
    expect(doc.lines().length).toBe(1)
    ed.dispatch({ type: 'remote' }); expect(doc.lines().length).toBe(1)
    ready = true; ed.refillNow()
    expect(doc.lines().map((r) => r.id)).toEqual([padId('a', 0, 1), padId('a', 0, 2), 'b1', padId('c', 0, 1), padId('c', 0, 2)])
    const refills = ed.log.filter((a) => a.type === 'refill')
    expect(refills.map((a) => Object.keys(a).sort().join())).toEqual(['at,id,type,zone', 'at,id,type,zone'])
    ed.refillNow(); ed.dispatch({ type: 'remote' }); expect(doc.lines().length).toBe(5) // idempotent: nothing more
    ed.dispose()
  })
  it('emptying a zone (the last row deleted, or archived out of it) refills it; typing into a pad is an ordinary row and no refill follows', () => {
    const { ed, doc } = mount([row('a1', 'a', 1), row('b1', 'b', 1), row('c1', 'c', 1)])
    ed.refillNow(); expect(doc.lines().length).toBe(3)
    doc.put([{ id: 'b1', set: { deleted_at: 'x' } }]); ed.dispatch({ type: 'remote' })
    expect(doc.lines().filter((r) => r.zone === 'b').map((r) => r.id)).toEqual([padId('b', 0, 1), padId('b', 0, 2)])
    doc.put([{ id: padId('b', 0, 1), set: { body: 'typed' } }]); ed.dispatch({ type: 'remote' })
    expect(doc.lines().filter((r) => r.zone === 'b').length).toBe(2) // typed pad + the other pad: nothing added
    doc.put([{ id: padId('b', 0, 1), set: { deleted_at: 'x' } }, { id: padId('b', 0, 2), set: { deleted_at: 'x' } }]); ed.dispatch({ type: 'remote' })
    expect(doc.lines().filter((r) => r.zone === 'b').map((r) => r.id)).toEqual([padId('b', 1, 1), padId('b', 1, 2)]) // no resurrection, no loop
    ed.dispose()
  })
  it('a press in an inert gap that declares data-qk-gap puts the caret at the end of the line above it, through the reducer', () => {
    const gapApp = { ...app, items: (d) => d.lines().flatMap((r, i) => (i === 1 ? [{ key: 'gap', gap: true }] : []).concat([{ ...r, key: r.id, addr: r.id }])), render: (it) => (it.gap ? { tag: 'div', cls: 'gap', inert: true, editable: false, attrs: { 'data-qk-gap': '' }, children: [{ tag: 'span', text: 'ZONE' }] } : app.render(it)) }
    document.body.innerHTML = '<div><div id="d" contenteditable="true"></div></div>'
    const doc = mem([row('a1', 'a', 1, 'hello'), row('a2', 'a', 2, 'world')])
    const ed = createEditor({ root: document.getElementById('d'), app: gapApp, doc, contract: { name: `gap-${Math.random()}`, actions: [] } })
    const gap = document.querySelector('[data-qk-gap]'); expect(gap).toBeTruthy()
    const before = ed.log.length
    gap.querySelector('span').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    expect(ed.state.sel).toEqual({ a: { id: 'a1', off: 5 }, f: { id: 'a1', off: 5 } })
    expect(ed.log.slice(before)[0].type).toBe('select') // one id-keyed action, not a DOM-only fix (a focus follows)
    expect(ed.log.slice(before)[0].id).toBeTruthy()
    ed.dispose()
  })
  it('a press on the document padding or the margin beside it acts as a press on the row at that height: a divider as its own press, a line at its start (left of it) or end; the scrollbar is left alone', () => {
    const gapApp = { ...app, items: (d) => d.lines().flatMap((r, i) => (i === 1 ? [{ key: 'gap', gap: true }] : []).concat([{ ...r, key: r.id, addr: r.id }])), render: (it) => (it.gap ? { tag: 'div', cls: 'gap', inert: true, editable: false, attrs: { 'data-qk-gap': '' }, children: [{ tag: 'span', text: 'ZONE' }] } : app.render(it)) }
    document.body.innerHTML = '<div id="s"><div id="d" contenteditable="true"></div></div>'
    const scroller = document.getElementById('s'), root = document.getElementById('d')
    Object.defineProperty(scroller, 'clientWidth', { value: 400 }) // 400 px of content, then the scrollbar
    scroller.getBoundingClientRect = () => ({ left: 0, top: 0, right: 415, bottom: 100, width: 415, height: 100 })
    const doc = mem([row('a1', 'a', 1, 'hello'), row('a2', 'a', 2, 'world!')])
    const ed = createEditor({ root, scroller, app: gapApp, doc, contract: { name: `margin-${Math.random()}`, actions: [] } })
    root.getBoundingClientRect = () => ({ left: 40, right: 360, top: 0, bottom: 60, width: 320, height: 60 })
    const rows = [...root.children].filter((e) => e.hasAttribute('data-addr') || e.hasAttribute('data-qk-gap')); expect(rows.length).toBe(3)
    rows.forEach((e, i) => { e.getBoundingClientRect = () => ({ left: 50, right: 350, top: i * 20, bottom: i * 20 + 20, width: 300, height: 20 }) })
    const press = (el, x, y, extra = {}) => { const ev = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...extra }); el.dispatchEvent(ev); return ev }
    const sel = () => JSON.stringify(ed.state.sel)
    const at = (id, off) => JSON.stringify({ a: { id, off }, f: { id, off } })
    press(scroller, 10, 30); expect(sel(), 'margin left of the divider: the end of the line above').toBe(at('a1', 5))
    press(root, 360, 30); expect(sel(), 'the root padding right of the divider: the same').toBe(at('a1', 5))
    press(scroller, 10, 50); expect(sel(), 'margin left of a line: its start').toBe(at('a2', 0))
    press(scroller, 380, 50); expect(sel(), 'margin right of a line: its end').toBe(at('a2', 6))
    press(scroller, 10, 5); expect(sel(), 'margin left of the first line: its start').toBe(at('a1', 0))
    press(scroller, 380, 900); expect(sel(), 'far below the last row: the last line end').toBe(at('a2', 6))
    const n = ed.log.length, ev = press(scroller, 410, 30) // the scrollbar (x past clientWidth)
    expect(ev.defaultPrevented).toBe(false); expect(ed.log.length).toBe(n); expect(sel()).toBe(at('a2', 6))
    const n2 = ed.log.length; press(scroller, 10, 30)
    expect(ed.log.slice(n2).map((a) => a.type)).toContain('select')
    ed.dispose()
  })
})
