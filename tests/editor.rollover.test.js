// The day rollover (lib/editor/rollover.js; the owner 2026-11-12 18:55 and 19:01 PST: a 10:47 pm line "should've been auto-archived at
// the day rollover (4am)"; "a simple state extension based on clock / timer"): { type: 'day.roll', boundary } moves the rows of
// the `from` zone last touched before `boundary` to the end of `to`. Laws: idempotent by value; two devices that roll the same
// state write the same puts and merge by id; a row edited after the boundary stays; a future boundary is a no-op; a missed day
// is caught up by the next roll; undo (the app's history of the puts) restores; a day starts at 04:00 in the OWNER's zone across
// both DST changes. Each law has a planted bug that turns it red.
import { describe, expect, it } from 'vitest'
import { createEditor, memoryLines, modelRun, step, initState } from '../lib/editor/editor.js'
import { declareEditor } from '../lib/editor/declare.js'
import { rollPuts, rollRows, dayKey, boundaryMs, dayStart, checkRollover, startDayClock } from '../lib/editor/rollover.js'
import { validate } from '../lib/validate.js'
import { every } from '../lib/timers.js'
import { planted } from './planted.js'

const LA = 'America/Los_Angeles'
const ZONES = ['past', 'now', 'next']
const spec = { from: 'now', to: 'past', zoneOf: (r) => r.zone, hour: 4 }
const sortKey = (r) => [ZONES.indexOf(r.zone), r.ord, r.id]
const iso = (ms) => new Date(ms).toISOString()
const row = (id, zone, ord, body, at, extra = {}) => ({ id, zone, ord, body, kind: 'text', created_at: iso(at), updated_at: iso(at), deleted_at: null, ...extra })
const mem = (rows) => memoryLines(rows, { sortKey })
const rng = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 } }
const B = Date.parse('2026-11-12T12:00:00Z') // 04:00 PST on 2026-11-12

describe('a day starts at 04:00 in the owner\'s zone', () => {
  it('10:47 pm belongs to the day before; 3:59 am is still that day; 4:00 am starts the next', () => {
    expect(dayKey(Date.parse('2026-11-12T06:47:00Z'), LA)).toBe('2026-11-11')
    expect(dayKey(Date.parse('2026-11-12T11:59:59Z'), LA)).toBe('2026-11-11')
    expect(dayKey(B, LA)).toBe('2026-11-12')
    expect(boundaryMs('2026-11-12', LA)).toBe(B)
    expect(dayStart(Date.parse('2026-11-13T02:55:00Z'), LA)).toBe(B) // 6:55 pm that evening
  })
  it('the zone is the owner\'s, not the device\'s: the same instant is another day in Tokyo', () => {
    const t = Date.parse('2026-11-12T11:59:59Z')
    expect(dayKey(t, LA)).toBe('2026-11-11'); expect(dayKey(t, 'Asia/Tokyo')).toBe('2026-11-12')
    expect(boundaryMs('2026-11-12', 'Asia/Tokyo')).toBe(Date.parse('2026-11-11T19:00:00Z'))
  })
  it('across both DST changes the boundary is 04:00 wall time: a 23 h and a 25 h day', () => {
    const h = 3_600_000
    expect(boundaryMs('2026-03-07', LA)).toBe(Date.parse('2026-03-07T12:00:00Z')) // PST
    expect(boundaryMs('2026-03-08', LA)).toBe(Date.parse('2026-03-08T11:00:00Z')) // PDT (clocks went forward at 2 am)
    expect(boundaryMs('2026-03-08', LA) - boundaryMs('2026-03-07', LA)).toBe(23 * h)
    expect(boundaryMs('2026-10-31', LA)).toBe(Date.parse('2026-10-31T11:00:00Z')) // PDT
    expect(boundaryMs('2026-11-01', LA)).toBe(Date.parse('2026-11-01T12:00:00Z')) // PST (clocks went back at 2 am)
    expect(boundaryMs('2026-11-01', LA) - boundaryMs('2026-10-31', LA)).toBe(25 * h)
    expect(dayKey(Date.parse('2026-03-08T10:59:00Z'), LA)).toBe('2026-03-07'); expect(dayKey(Date.parse('2026-03-08T11:00:00Z'), LA)).toBe('2026-03-08')
    expect(dayKey(Date.parse('2026-11-01T11:59:00Z'), LA)).toBe('2026-10-31'); expect(dayKey(Date.parse('2026-11-01T12:00:00Z'), LA)).toBe('2026-11-01')
  })
  it('a wall time that does not exist (02:30 in the spring gap) is the first instant after it; every day of two years round-trips', () => {
    expect(boundaryMs('2026-03-08', LA, 2)).toBe(Date.parse('2026-03-08T10:00:00Z')) // 03:00 PDT
    for (let t = Date.parse('2025-01-01T00:00:00Z'); t < Date.parse('2027-01-01T00:00:00Z'); t += 86_400_000) {
      const day = dayKey(t, LA), b = boundaryMs(day, LA)
      expect(dayKey(b, LA)).toBe(day); expect(dayKey(b - 1, LA)).not.toBe(day)
    }
  })
  it('junk never throws', () => { expect(() => checkRollover({ from: 'a', to: 'a', zoneOf() {} })).toThrow(/two zone keys/); expect(() => checkRollover({ from: 'a', to: 'b', zoneOf() {}, x: 1 })).toThrow(/unknown rollover key/); expect(checkRollover(null)).toBe(null) })
})

describe('which rows move, and where', () => {
  const rows = [
    row('p1', 'past', 1, 'old past', B - 9e9), row('p2', 'past', 2, 'old past 2', B - 8e9),
    row('last-night', 'now', 1, 'pangea, linknotes', B - 5_000_000), // 10:37 pm
    row('mid', 'now', 2, '- [ ] still open', B - 90_000_000), // the day before that
    row('edited', 'now', 3, 'touched at 5 am', B - 9e7, { updated_at: iso(B + 3_600_000) }),
    row('blank', 'now', 4, '', B - 5e6), row('rule', 'now', 5, '', B - 5e6, { kind: 'break' }),
    row('today', 'now', 6, 'written after 4 am', B + 60_000),
    row('n1', 'next', 1, 'plan', B - 9e9),
  ]
  it('everything non-blank in NOW last written before the boundary goes to the end of Past in its order; NEXT, blanks, edits after the boundary stay', () => {
    const puts = rollPuts(mem(rows).lines(), spec, B, B + 1)
    expect(puts).toEqual([{ id: 'last-night', set: { zone: 'past', ord: 3 } }, { id: 'mid', set: { zone: 'past', ord: 4 } }])
    const doc = mem(rows); doc.put(puts)
    expect(doc.lines().map((r) => `${r.zone}:${r.id}`)).toEqual(['past:p1', 'past:p2', 'past:last-night', 'past:mid', 'now:edited', 'now:blank', 'now:rule', 'now:today', 'next:n1'])
  })
  it('idempotent: a second roll writes nothing; the same state rolled by two devices writes the same puts', () => {
    const doc = mem(rows); doc.put(rollPuts(doc.lines(), spec, B, B + 1))
    expect(rollPuts(doc.lines(), spec, B, B + 2)).toEqual([])
    expect(rollPuts(mem(rows).lines(), spec, B, B + 99)).toEqual(rollPuts(mem(rows).lines(), spec, B, B + 1))
  })
  it('a boundary in the future, a junk boundary, a missing spec, an unloaded Past in a paged doc: nothing moves', () => {
    const lines = mem(rows).lines()
    expect(rollPuts(lines, spec, B + 1, B)).toEqual([])
    for (const b of [NaN, null, undefined, 'x', Infinity]) expect(rollPuts(lines, spec, b, B + 1)).toEqual([])
    expect(rollPuts(lines, null, B, B + 1)).toEqual([])
    const noPast = mem(rows.filter((r) => r.zone !== 'past')).lines()
    expect(rollPuts(noPast, spec, B, B + 1, false)).toEqual([])
    expect(rollRows(noPast, spec, B, B + 1).length).toBe(2) // but the clock sees it is pending, so it loads older rows first
    expect(rollPuts(noPast, spec, B, B + 1, true).map((p) => p.set.ord)).toEqual([1, 2]) // a complete doc with an empty Past
  })
  it('a missed day: the next roll moves everything older than the latest boundary, however many days were skipped', () => {
    const lines = mem([row('a', 'now', 1, 'monday', B - 4 * 86_400_000), row('b', 'now', 2, 'tuesday', B - 3 * 86_400_000), row('c', 'now', 3, 'yesterday', B - 3_600_000), row('d', 'now', 4, 'today', B + 1)]).lines()
    expect(rollPuts(lines, spec, B, B + 5).map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })
  it('fuzz, 3000 states: rolled rows are exactly the old non-blank NOW rows, in order, after every Past row; nothing else is written; re-rolling is a no-op', () => {
    const r = rng(11), bad = []
    for (let n = 0; n < 3000; n++) {
      const rs = []
      for (let i = 0; i < 1 + Math.floor(r() * 12); i++) { const t = B + Math.floor((r() - 0.6) * 4e8); rs.push(row(`r${i}`, ZONES[Math.floor(r() * 3)], 1 + Math.floor(r() * 9) + i / 100, r() < 0.25 ? '' : 'w', t, r() < 0.3 ? { updated_at: iso(t + Math.floor((r() - 0.3) * 4e8)) } : {})) }
      const doc = mem(rs), before = doc.lines(), puts = rollPuts(before, spec, B, B + 1)
      const want = before.filter((x) => x.zone === 'now' && x.body && Math.max(Date.parse(x.created_at), Date.parse(x.updated_at)) < B).map((x) => x.id)
      if (puts.map((p) => p.id).join() !== want.join()) bad.push(`ids ${n}`)
      const tail = Math.max(0, ...before.filter((x) => x.zone === 'past').map((x) => x.ord))
      if (puts.some((p, k) => p.set.zone !== 'past' || p.set.ord !== tail + 1 + k || Object.keys(p.set).length !== 2)) bad.push(`set ${n}`)
      doc.put(puts)
      if (rollPuts(doc.lines(), spec, B, B + 2).length) bad.push(`again ${n}`)
    }
    expect(bad).toEqual([])
  })
})

describe('two replicas converge', () => {
  // a replica is rows by id; a "write" is a put merged per field in the order it arrives (what rows.js does by stamp: here the
  // roll's puts are the same bytes on both sides, so every arrival order gives one result)
  it('both devices roll the same state at different times, in any arrival order: one result; an edit made by one after the roll still wins on both', () => {
    const r = rng(5), bad = []
    for (let n = 0; n < 1000; n++) {
      const rs = []
      for (let i = 0; i < 1 + Math.floor(r() * 8); i++) rs.push(row(`r${i}`, r() < 0.2 ? 'past' : 'now', i + 1, r() < 0.2 ? '' : 'w', B + Math.floor((r() - 0.7) * 3e8)))
      const A = mem(rs), Bm = mem(rs), pa = rollPuts(A.lines(), spec, B, B + 10), pb = rollPuts(Bm.lines(), spec, B, B + 7_000)
      if (JSON.stringify(pa) !== JSON.stringify(pb)) bad.push(`puts ${n}`)
      A.put(pa); A.put(pb); Bm.put(pb); Bm.put(pa)
      const edit = [{ id: 'r0', set: { body: 'later', updated_at: iso(B + 9e6) } }]; A.put(edit); Bm.put(edit)
      if (JSON.stringify(A.lines()) !== JSON.stringify(Bm.lines())) bad.push(`state ${n}`)
      if (rollPuts(A.lines(), spec, B, B + 1e7).length !== 0 && A.lines().some((x) => x.id !== 'r0' && x.zone === 'now' && x.body && Date.parse(x.updated_at) < B)) bad.push(`left ${n}`)
    }
    expect(bad).toEqual([])
  })
  it('planted: a roll that ignores the boundary (moves rows edited after it) is red', async () => {
    const mod = await planted('lib/editor/rollover.js', ' && touched(r) < boundary', '')
    const lines = mem([row('x', 'now', 1, 'edited at 5', B - 9e9, { updated_at: iso(B + 1000) })]).lines()
    expect(rollPuts(lines, spec, B, B + 5)).toEqual([]); expect(mod.rollPuts(lines, spec, B, B + 5).map((p) => p.id)).toEqual(['x'])
  })
  it('planted: a roll that does not leave rows already in Past alone (no zone filter) is red', async () => {
    const mod = await planted('lib/editor/rollover.js', 'spec.zoneOf(r) === spec.from && !blank(r)', '!blank(r)')
    const lines = mem([row('p', 'past', 1, 'old', B - 9e9), row('q', 'now', 2, 'night', B - 1e6)]).lines()
    expect(rollPuts(lines, spec, B, B + 5).map((p) => p.id)).toEqual(['q']); expect(mod.rollPuts(lines, spec, B, B + 5).map((p) => p.id)).toEqual(['p', 'q'])
  })
})

describe('through the kit reducer, undo and the declaration gate', () => {
  const hist = []
  const app = { keys: [], textOf: (r) => r.body ?? '', estimate: () => 20, items: (d) => d.lines().map((r) => ({ ...r, key: r.id, addr: r.id })), render: (it) => ({ tag: 'div', addr: it.id, children: it.body ? [it.body] : [{ tag: 'br' }] }),
    init: () => ({ hist: [] }),
    recorded(state, puts, ctx) { state.ext.hist.push({ puts, inverse: puts.map((p) => ({ id: p.id, set: Object.fromEntries(Object.keys(p.set).map((k) => [k, ctx.get(p.id)[k]])) })) }); hist.push(state.ext.hist.at(-1)) },
    reduce(state, a, ctx) { if (a.type === 'key' && state.sel) { const r = ctx.get(state.sel.f.id); return r ? { puts: [{ id: r.id, set: { body: `  ${r.body}` } }] } : null } return null } }
  const base = () => [row('p1', 'past', 1, 'old', B - 9e9), row('night', 'now', 1, 'ten forty-seven pm', B - 4_000_000), row('today', 'now', 2, 'new', B + 5), row('tail', 'now', 3, '', B - 4_000_000)]
  it('day.roll through step: the lines move, the caret leaves the moved line for what is left of NOW, the inverse restores the rows', () => {
    hist.length = 0
    const doc = mem(base()), state = initState(app)
    state.sel = { a: { id: 'night', off: 3 }, f: { id: 'night', off: 3 } }
    step(app, doc, state, { type: 'day.roll', boundary: B, id: 'd1', at: B + 100 }, { rollover: spec })
    expect(doc.lines().map((r) => `${r.zone}:${r.id}`)).toEqual(['past:p1', 'past:night', 'now:today', 'now:tail'])
    expect(state.sel.f).toEqual({ id: 'tail', off: 0 })
    step(app, doc, state, { type: 'day.roll', boundary: B, id: 'd2', at: B + 200 }, { rollover: spec }); expect(hist.length).toBe(1) // idempotent: the second is not even recorded
    doc.put(hist[0].inverse)
    expect(doc.lines().map((r) => `${r.zone}:${r.id}:${r.ord}`)).toEqual(['past:p1:1', 'now:night:1', 'now:today:2', 'now:tail:3'])
  })
  it('a read-only editor, a contract with no rollover and a future boundary do nothing', () => {
    const doc = mem(base()), state = initState(app), snap = JSON.stringify(doc.lines())
    step(app, doc, state, { type: 'day.roll', boundary: B, id: 'x', at: B + 1 }, { rollover: spec, readOnly: true })
    step(app, doc, state, { type: 'day.roll', boundary: B, id: 'y', at: B + 1 }, {})
    step(app, doc, state, { type: 'day.roll', boundary: B + 9e9, id: 'z', at: B + 1 }, { rollover: spec })
    expect(JSON.stringify(doc.lines())).toBe(snap)
  })
  it('modelRun replays the logged action to the same rows', () => {
    const log = [{ type: 'day.roll', boundary: B, id: 'd1', at: B + 100 }]
    const a = modelRun(app, base(), log, { sortKey, rollover: spec }), b = modelRun(app, base(), log, { sortKey, rollover: spec })
    expect(a.doc.lines()).toEqual(b.doc.lines())
  })
  it('validate runs every law over the declared action (idempotent, no loss, replay) with coverage', async () => {
    const contract = { name: 'rollover-laws', actions: [], rollover: spec, sortKey, sample: [row('p1', 'past', 1, 'old', Date.parse('2026-11-09T00:00:00Z')), row('a', 'now', 1, 'first line', Date.parse('2026-11-09T00:00:00Z')), row('b', 'now', 2, 'second line here', Date.parse('2026-11-12T00:00:00Z')), row('n', 'next', 1, 'last', Date.parse('2026-11-09T00:00:00Z'))] }
    const d = declareEditor(contract, app)
    const r = await validate({ decls: [d.view, d.edits], ui: true, timing: false })
    expect(r.failures.map((f) => `${f.name}: ${f.law}: ${f.detail}`).join('\n')).toBe('')
    const v = r.decls.find((x) => x.name === 'editor:rollover-laws')
    expect(v.coverage['day.roll']).toBeGreaterThan(0); expect(v.uncovered).toEqual([])
  }, 60000)
})

describe('the clock tick', () => {
  const mount = (rows, clockRef) => {
    document.body.innerHTML = '<div><div id="d" contenteditable="true"></div></div>'
    const doc = mem(rows)
    const ed = createEditor({ root: document.getElementById('d'), app: { ...app0, recorded() {} }, doc, contract: { name: `roll-ed-${Math.random()}`, actions: [], rollover: spec, sortKey }, clock: () => clockRef.t })
    return { ed, doc }
  }
  const app0 = { keys: ['Tab'], textOf: (r) => r.body ?? '', estimate: () => 20, items: (d) => d.lines().map((r) => ({ ...r, key: r.id, addr: r.id })), render: (it) => ({ tag: 'div', addr: it.id, children: it.body ? [it.body] : [{ tag: 'br' }] }), reduce: () => null }
  it('open at 10:47 am the next morning: the 10:47 pm line is archived at once; a tick before 4 am does nothing; the app closed for three days catches up in one roll', async () => {
    const clock = { t: Date.parse('2026-11-12T06:50:00Z') } // 10:50 pm
    const { ed, doc } = mount([row('p1', 'past', 1, 'old', B - 9e9), row('night', 'now', 1, 'ten forty-seven pm', Date.parse('2026-11-12T06:47:00Z')), row('older', 'now', 2, 'two days ago', B - 2 * 86_400_000)], clock)
    let zone = LA, ready = true
    const stop = startDayClock({ editor: ed, spec, tz: () => zone, ready: () => ready, clock: () => clock.t, every, win: { addEventListener() {}, removeEventListener() {} } })
    await new Promise((r) => setTimeout(r, 0))
    expect(doc.lines().filter((r) => r.zone === 'now').map((r) => r.id)).toEqual(['night']) // the 3 days older line goes; last night's stays until its day is over
    expect(ed.log.filter((a) => a.type === 'day.roll').length).toBe(1)
    clock.t = Date.parse('2026-11-12T11:59:00Z'); ed.dispatch({ type: 'remote' })
    expect(ed.rollPending(dayStart(clock.t, zone))).toBe(0)
    clock.t = Date.parse('2026-11-15T20:00:00Z') // opened three days later
    expect(ed.rollPending(dayStart(clock.t, zone))).toBe(1)
    stop()
    const stop2 = startDayClock({ editor: ed, spec, tz: () => zone, ready: () => ready, clock: () => clock.t, every, win: { addEventListener() {}, removeEventListener() {} } })
    await new Promise((r) => setTimeout(r, 0))
    expect(doc.lines().filter((r) => r.zone === 'now').length).toBe(0)
    expect(doc.lines().filter((r) => r.zone === 'past').map((r) => r.id)).toEqual(['p1', 'older', 'night'])
    ready = false; stop2(); ed.dispose()
  })
  it('not ready (rows not in yet) it does not roll', async () => {
    const clock = { t: B + 3_600_000 }
    const { ed, doc } = mount([row('night', 'now', 1, 'x', B - 1e6)], clock)
    const stop = startDayClock({ editor: ed, spec, tz: () => LA, ready: () => false, clock: () => clock.t, every, win: { addEventListener() {}, removeEventListener() {} } })
    await new Promise((r) => setTimeout(r, 0)); expect(doc.lines()[0].zone).toBe('now'); stop(); ed.dispose()
  })
})
