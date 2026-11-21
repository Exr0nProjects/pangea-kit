// Line drag and hover (lib/editor/linepointer.js, lines.js dropLines, editor.js `drag` and `hover` actions; zai3 parity with old zai's
// notes-drag.js and hoverChord, the owner 2026-11-12 19:00 PST "finish the parity"). Laws:
//   dropLines  the carried line and its whole subtree (folded or not) land beside the target keeping order and depth; onto itself or
//              where it already sits it is null (a replayed drop writes nothing); across groups only with groupFields; a folded
//              target's "after" is after its subtree
//   `drag`     start / over / cancel are view state only; drop is one absolute move through the reducer; read-only refuses it
//   `hover`    row under the pointer, view state; a row that is gone is null
//   adapter    a grip press carries the line as soon as it moves; a hold picks up; an early move cancels the hold; Escape cancels; each
//              step is an id-keyed action; nothing is left stuck (the root attribute, the listeners). A planted bug turns the subtree law red.
import { describe, expect, it, vi } from 'vitest'
import { createEditor, memoryLines, initState, step, modelRun, aimed, resolveGesture } from '../lib/editor/editor.js'
import { dropLines } from '../lib/editor/lines.js'
import { createLinePointer } from '../lib/editor/linepointer.js'
import { declareEditor } from '../lib/editor/declare.js'
import { validate } from '../lib/validate.js'

const ZONES = ['a', 'b']
const sortKey = (r) => [ZONES.indexOf(r.zone), r.ord, r.id]
const dep = (r) => (r.body ? Math.floor(/^ */.exec(r.body)[0].length / 2) : null)
const outline = { depth: dep, group: (r) => ZONES.indexOf(r.zone), groupFields: (r) => ({ zone: r.zone }) }
const row = (id, zone, ord, body) => ({ id, zone, ord, body, deleted_at: null })
const mem = (rows) => memoryLines(rows, { sortKey })
const DOC = () => [row('t', 'a', 1, 'Topic'), row('c', 'a', 2, '  child'), row('g', 'a', 3, '    grand'), row('n', 'a', 4, 'Next'), row('l', 'a', 5, 'Last'), row('x', 'b', 1, 'Other')]
const order = (doc) => doc.lines().map((r) => r.id).join('')
const app = { keys: ['Tab'], outline, textOf: (r) => r.body ?? '', estimate: () => 20, items: (d) => d.lines().map((r) => ({ ...r, key: r.id, addr: r.id })), render: (it) => ({ tag: 'div', addr: it.id, children: [{ tag: 'span', cls: 'grip', inert: true, editable: false, attrs: { 'data-qk-grip': '' } }, { tag: 'span', text: it.body }] }) }

describe('dropLines (pure)', () => {
  it('a line with its children lands after a later line, keeping order and depth', () => {
    const doc = mem(DOC())
    doc.put(dropLines(doc.lines(), 0, 3, true, { ...outline, at: 1 }))
    expect(order(doc)).toBe('ntcglx')
    expect(doc.lines().map((r) => r.body).join(',')).toBe('Next,Topic,  child,    grand,Last,Other')
  })
  it('before a target above; a folded target keeps its subtree whole', () => {
    const doc = mem(DOC())
    doc.put(dropLines(doc.lines(), 3, 0, false, { ...outline, at: 1 }))
    expect(order(doc)).toBe('ntcglx')
    const d2 = mem(DOC())
    d2.put(dropLines(d2.lines(), 4, 0, true, { ...outline, folds: ['t'], at: 1 })) // after the folded Topic's whole subtree: before Next
    expect(order(d2)).toBe('tcglnx')
    const d3 = mem(DOC())
    d3.put(dropLines(d3.lines(), 4, 0, true, { ...outline, at: 1 })) // not folded: right below Topic
    expect(order(d3)).toBe('tlcgnx')
  })
  it('onto its own subtree, or to the place it already holds, is null (a replayed drop is a no-op)', () => {
    const rows = mem(DOC()).lines()
    expect(dropLines(rows, 0, 1, true, { ...outline, at: 1 })).toBeNull()
    expect(dropLines(rows, 0, 0, false, { ...outline, at: 1 })).toBeNull()
    expect(dropLines(rows, 3, 2, true, { ...outline, at: 1 })).toBeNull()
    expect(dropLines(rows, 3, 4, false, { ...outline, at: 1 })).toBeNull()
    const doc = mem(DOC()); doc.put(dropLines(doc.lines(), 0, 3, true, { ...outline, at: 1 }))
    expect(dropLines(doc.lines(), 1, 0, true, { ...outline, at: 2 })).toBeNull() // Topic now sits right after Next: dropping it there again is nothing
  })
  it('across groups only with groupFields: the rows take the target group', () => {
    const rows = mem(DOC()).lines()
    expect(dropLines(rows, 0, 5, true, { depth: dep, group: outline.group, at: 1 })).toBeNull()
    const doc = mem(DOC()); doc.put(dropLines(doc.lines(), 0, 5, true, { ...outline, at: 1 }))
    expect(doc.lines().map((r) => `${r.id}${r.zone}`).join(' ')).toBe('na la xb tb cb gb')
  })
})

describe('the drag and hover actions through the reducer', () => {
  const run = (rows, actions, o = {}) => { const doc = mem(rows), st = initState(app); for (const a of actions) step(app, doc, st, { at: 5, id: 'i', ...a }, o); return { doc, st } }
  it('start, over and cancel are view state only; drop is one move', () => {
    const a = run(DOC(), [{ type: 'drag', op: 'start', row: 't' }, { type: 'drag', op: 'over', row: 't', to: { id: 'n', after: true } }])
    expect(a.st.drag).toEqual({ id: 't', to: { id: 'n', after: true } }); expect(order(a.doc)).toBe('tcgnlx')
    const b = run(DOC(), [{ type: 'drag', op: 'start', row: 't' }, { type: 'drag', op: 'cancel' }]); expect(b.st.drag).toBeNull()
    const c = run(DOC(), [{ type: 'drag', op: 'start', row: 't' }, { type: 'drag', op: 'drop', row: 't', to: { id: 'n', after: true } }])
    expect(c.st.drag).toBeNull(); expect(order(c.doc)).toBe('ntcglx')
  })
  it('a drop twice is a drop once (idempotent by value); junk is a no-op', () => {
    const d = { type: 'drag', op: 'drop', row: 't', to: { id: 'l', after: true } }
    const once = run(DOC(), [d]), twice = run(DOC(), [d, { ...d, id: 'j' }])
    expect(order(twice.doc)).toBe(order(once.doc))
    expect(twice.doc.lines().map((r) => r.ord)).toEqual(once.doc.lines().map((r) => r.ord))
    const junk = run(DOC(), [{ type: 'drag', op: 'drop', row: 'zz', to: { id: 'n' } }, { type: 'drag', op: 'start', row: 7 }, { type: 'drag', op: 'over', to: 4 }, { type: 'drag' }])
    expect(order(junk.doc)).toBe('tcgnlx'); expect(junk.st.drag).toBeNull()
  })
  it('read only refuses the drop with a notice and the start does not begin', () => {
    const r = run(DOC(), [{ type: 'drag', op: 'start', row: 't' }, { type: 'drag', op: 'drop', row: 't', to: { id: 'n', after: true } }], { readOnly: true })
    expect(order(r.doc)).toBe('tcgnlx'); expect(r.st.drag).toBeNull(); expect(r.st.notice?.code).toBe('read-only')
  })
  it('hover is the row under the pointer; a row that is gone is null; it never disturbs the vertical-move goal', () => {
    const r = run(DOC(), [{ type: 'select', sel: { a: { id: 'n', off: 1 }, f: { id: 'n', off: 1 } }, goal: 40 }, { type: 'hover', row: 'l' }])
    expect(r.st.hover).toBe('l'); expect(r.st.goal).toBe(40)
    expect(run(DOC(), [{ type: 'hover', row: 'l' }, { type: 'hover', row: 'gone' }]).st.hover).toBeNull()
    expect(run(DOC(), [{ type: 'hover', row: 'l' }, { type: 'hover', row: null }]).st.hover).toBeNull()
  })
  it('the model run replays a log with drags to the same document', () => {
    const acts = [{ type: 'drag', op: 'start', row: 't', at: 3 }, { type: 'drag', op: 'drop', row: 't', to: { id: 'l', after: true }, at: 4 }]
    expect(order(modelRun(app, DOC(), acts, { sortKey }).doc)).toBe('nltcgx')
  })
  it('the declared laws hold over random runs (idempotent, total, in the generated alphabet)', async () => {
    const decl = declareEditor({ name: `lp-${Math.random()}`, actions: [], sortKey, sample: DOC() }, app)
    const res = await validate({ decls: [decl.view], ui: true, timing: false })
    expect(res.ok, JSON.stringify(res).slice(0, 600)).toBe(true)
  }, 60000)
})

// the adapter, in jsdom: no layout, so elementFromPoint is stubbed to the row under a fake y; events are MouseEvents named as pointer events
describe('aimed: the row a line chord acts on', () => {
  const st = (o) => ({ ...initState(app), ...o })
  const at = (id) => ({ a: { id, off: 0 }, f: { id, off: 0 } })
  it('the hovered row when it is not the caret line; else null (the caret keeps its own chord)', () => {
    expect(aimed(st({ hover: 'l', sel: at('n') }))).toBe('l')
    expect(aimed(st({ hover: 'l', sel: at('l') }))).toBeNull()
    expect(aimed(st({ hover: 'l', sel: null }))).toBe('l')
    expect(aimed(st({ hover: null, sel: at('n') }))).toBeNull()
  })
  it('not while find is open or a composition runs', () => {
    expect(aimed(st({ hover: 'l', sel: at('n'), find: { q: 'x' } }))).toBeNull()
    expect(aimed(st({ hover: 'l', sel: at('n'), composing: { id: 'n' } }))).toBeNull()
  })
  it('a fold gesture takes the aim: the hovered row is folded, absolute { addr, on }; a named addr and the caret line still work', () => {
    expect(resolveGesture(st({ hover: 't', sel: at('n') }), { type: 'fold' })).toMatchObject({ addr: 't', on: true })
    expect(resolveGesture(st({ hover: 't', sel: at('n'), folds: ['t'] }), { type: 'fold' })).toMatchObject({ addr: 't', on: false })
    expect(resolveGesture(st({ hover: 't', sel: at('n') }), { type: 'fold', addr: 'l' })).toMatchObject({ addr: 'l', on: true })
    expect(resolveGesture(st({ hover: 'n', sel: at('n') }), { type: 'fold' })).toMatchObject({ addr: 'n', on: true })
    expect(resolveGesture(st({ hover: null, sel: at('l') }), { type: 'fold' })).toMatchObject({ addr: 'l', on: true })
  })
  it('planted: ignoring the caret-line rule would steal a chord the caret already owns (red)', () => {
    const bad = (s) => (s.hover && !s.find ? s.hover : null)
    expect(bad(st({ hover: 'l', sel: at('l') }))).not.toBeNull() // aimed() is null here, which is the law
    expect(aimed(st({ hover: 'l', sel: at('l') }))).toBeNull()
  })
})

describe('the pointer gesture', () => {
  const mount = (opts = {}) => {
    document.body.innerHTML = '<div id="sc"><div id="d" contenteditable="true"></div></div>'
    const doc = mem(DOC()), root = document.getElementById('d'), scroller = document.getElementById('sc'), lp = createLinePointer({ holdMs: 50, ...opts })
    const ed = createEditor({ root, scroller, app, doc, contract: { name: `lp-ed-${Math.random()}`, actions: [] }, linePointer: lp })
    const rows = () => [...root.querySelectorAll('[data-addr]')]
    document.elementFromPoint = (x, y) => rows()[Math.max(0, Math.min(rows().length - 1, Math.floor(y / 20)))] ?? null
    for (const [k, el] of rows().entries()) el.getBoundingClientRect = () => ({ left: 0, right: 100, top: k * 20, bottom: k * 20 + 20, width: 100, height: 20, x: 0, y: k * 20 })
    const ev = (type, target, o = {}) => { const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 5, clientY: 0, button: 0, ...o }); Object.defineProperty(e, 'pointerId', { value: 1 }); Object.defineProperty(e, 'isPrimary', { value: true }); target.dispatchEvent(e); return e }
    return { doc, root, ed, lp, rows, ev }
  }
  it('a grip carries its line once it moves, the drop is one action, and nothing stays stuck', () => {
    const { doc, root, ed, rows, ev } = mount()
    const grip = rows()[0].querySelector('[data-qk-grip]')
    const down = ev('pointerdown', grip, { clientY: 10 })
    expect(down.defaultPrevented).toBe(true) // the editor takes no selection gesture from it
    expect(ed.state.gesture).toBeNull()
    expect(ed.state.drag).toBeNull()
    ev('pointermove', window, { clientY: 11 }); expect(ed.state.drag).toBeNull() // a press that has not moved is a click
    ev('pointermove', window, { clientY: 74 })
    expect(ed.state.drag).toEqual({ id: 't', to: { id: 'n', after: true } }); expect(root.hasAttribute('data-qk-dragging')).toBe(true)
    const before = ed.log.length
    ev('pointerup', window, { clientY: 74 })
    expect(order(doc)).toBe('ntcglx'); expect(ed.state.drag).toBeNull(); expect(root.hasAttribute('data-qk-dragging')).toBe(false)
    expect(ed.log.slice(before).map((a) => `${a.type}:${a.op}`)).toEqual(['drag:drop']); expect(ed.log.at(-1).id).toBeTruthy()
    ed.dispose()
  })
  it('Escape cancels and leaves the document alone; a later release does nothing', () => {
    const { doc, root, ed, rows, ev } = mount()
    ev('pointerdown', rows()[0].querySelector('[data-qk-grip]'), { clientY: 10 }); ev('pointermove', window, { clientY: 74 }); expect(ed.state.drag).toBeTruthy()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(ed.state.drag).toBeNull(); expect(order(doc)).toBe('tcgnlx'); expect(root.hasAttribute('data-qk-dragging')).toBe(false)
    ev('pointerup', window); expect(order(doc)).toBe('tcgnlx')
    ed.dispose()
  })
  it('holding on a line picks it up; an early move is a selection, not a pick-up', () => {
    vi.useFakeTimers()
    try {
      const { doc, ed, rows, ev } = mount()
      const text = rows()[3].querySelector('span:not(.grip)')
      ev('pointerdown', text, { clientY: 70 }); vi.advanceTimersByTime(60)
      expect(ed.state.drag?.id).toBe('n')
      ev('pointermove', window, { clientY: 5 }); expect(ed.state.drag.to).toEqual({ id: 't', after: false })
      ev('pointerup', window, { clientY: 5 }); expect(order(doc)).toBe('ntcglx')
      ed.dispose()
      const b = mount(); const t2 = b.rows()[3].querySelector('span:not(.grip)')
      b.ev('pointerdown', t2, { clientY: 70 }); b.ev('pointermove', window, { clientY: 70, clientX: 40 }); vi.advanceTimersByTime(80)
      expect(b.ed.state.drag).toBeNull()
      b.ev('pointerup', window)
      b.ed.dispose()
    } finally { vi.useRealTimers() }
  })
  it('hover follows the pointer from the row under it and clears on leave', () => {
    const { ed, rows, root, ev } = mount()
    ev('pointermove', rows()[4].firstChild, { clientY: 90 }); expect(ed.state.hover).toBe('l')
    const n = ed.log.length; ev('pointermove', rows()[4].firstChild, { clientY: 95 }); expect(ed.log.length).toBe(n) // the same row is no new action
    root.dispatchEvent(new MouseEvent('pointerleave')); expect(ed.state.hover).toBeNull()
    ed.dispose()
  })
  it('planted: a drop that ignores the subtree leaves the children behind (red)', () => {
    const doc = mem(DOC()); doc.put(dropLines(doc.lines(), 0, 3, true, { ...outline, depth: () => 0, at: 1 }))
    expect(order(doc)).not.toBe('ntcglx') // only Topic moved: the first law above would fail on this
  })
})

describe('touch: the gutter tap and the virtual modifier', () => {
  const app2 = { ...app, keyActions: { 'mod+a': { type: 'select-all' } }, render: (it) => ({ tag: 'div', addr: it.id, children: [{ tag: 'span', cls: 'gz', inert: true, editable: false, attrs: { 'data-qk-gutter': '' } }, { tag: 'span', text: it.body }] }) }
  const mount2 = () => {
    document.body.innerHTML = '<div id="sc"><div id="d" contenteditable="true"></div></div>'
    const doc = mem(DOC()), root = document.getElementById('d')
    const ed = createEditor({ root, scroller: document.getElementById('sc'), app: app2, doc, contract: { name: `t-${Math.random()}`, actions: [] }, linePointer: createLinePointer(), mac: true })
    const rows = () => [...root.querySelectorAll('[data-addr]')]
    const ev = (type, target, o = {}) => { const e = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...o }); Object.defineProperty(e, 'pointerId', { value: 1 }); Object.defineProperty(e, 'isPrimary', { value: true }); Object.defineProperty(e, 'pointerType', { value: o.pointerType ?? 'touch' }); target.dispatchEvent(e); return e }
    const key = (k, o = {}) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }); root.dispatchEvent(e); return e }
    return { doc, root, ed, rows, ev, key }
  }
  it('gutter is the row whose gutter was tapped; junk and a gone row are null; absolute', () => {
    const r1 = initState(app2), doc = mem(DOC())
    step(app2, doc, r1, { type: 'gutter', row: 'n', at: 1, id: 'a' }); expect(r1.gutter).toBe('n')
    step(app2, doc, r1, { type: 'gutter', row: 'n', at: 1, id: 'b' }); expect(r1.gutter).toBe('n')
    step(app2, doc, r1, { type: 'gutter', row: 'gone', at: 1, id: 'c' }); expect(r1.gutter).toBeNull()
    step(app2, doc, r1, { type: 'gutter', row: 7, at: 1, id: 'd' }); expect(r1.gutter).toBeNull()
  })
  it('a touch tap on a gutter reveals that row only, puts no caret in the text; a press elsewhere puts it away; a mouse press there is the line\'s', () => {
    const { ed, rows, ev } = mount2()
    const before = ed.state.sel
    const g = rows()[1].querySelector('[data-qk-gutter]')
    const down = ev('pointerdown', g); expect(down.defaultPrevented).toBe(true)
    expect(ed.state.gutter).toBe('c'); expect(ed.state.sel).toEqual(before); expect(ed.state.gesture).toBeNull()
    ev('pointerdown', rows()[3].querySelector('[data-qk-gutter]')); expect(ed.state.gutter).toBe('n') // another row's gutter moves it over
    ev('pointerdown', rows()[4].children[1]); expect(ed.state.gutter).toBeNull()               // a press on a line's text puts it away
    ev('pointerdown', rows()[1].querySelector('[data-qk-gutter]'), { pointerType: 'mouse' }); expect(ed.state.gutter).toBeNull() // a mouse has hover
    ed.dispose()
  })
  it('vmod: hold and latch are absolute; hold clears a latch; junk is a no-op', () => {
    const st = initState(app2), doc = mem(DOC()), s = (a) => step(app2, doc, st, { at: 1, id: Math.random().toString(36), ...a })
    s({ type: 'vmod', op: 'latch', on: true }); expect(st.vmod).toEqual({ held: false, latched: true })
    s({ type: 'vmod', op: 'latch', on: true }); expect(st.vmod).toEqual({ held: false, latched: true })
    s({ type: 'vmod', op: 'hold', on: true }); expect(st.vmod).toEqual({ held: true, latched: false })
    s({ type: 'vmod', op: 'hold', on: false }); expect(st.vmod).toEqual({ held: false, latched: false })
    s({ type: 'vmod', op: 'bogus', on: true }); s({ type: 'vmod' }); expect(st.vmod).toEqual({ held: false, latched: false })
  })
  it('a key pressed while the virtual cmd is held is the chord and not a letter; a latch is one key; without it the letter is the browser\'s', () => {
    const { ed, key } = mount2()
    ed.focus(); ed.dispatch({ type: 'select', sel: { a: { id: 'n', off: 1 }, f: { id: 'n', off: 1 } } })
    const plain = key('a'); expect(plain.defaultPrevented).toBe(false); expect(ed.state.sel.a.id).toBe('n')
    ed.dispatch({ type: 'vmod', op: 'hold', on: true })
    const chord = key('a'); expect(chord.defaultPrevented).toBe(true)
    expect(ed.state.sel.a.id, 'select all: from the first row').toBe('t'); expect(ed.state.sel.f.id).toBe('x')
    ed.dispatch({ type: 'select', sel: { a: { id: 'n', off: 1 }, f: { id: 'n', off: 1 } } })
    const letter = key('q'); expect(letter.defaultPrevented, 'a letter that is no chord never reaches the line').toBe(true)
    ed.dispatch({ type: 'vmod', op: 'hold', on: false })
    ed.dispatch({ type: 'vmod', op: 'latch', on: true })
    key('a'); expect(ed.state.sel.a.id).toBe('t'); expect(ed.state.vmod.latched, 'one key, one latch').toBe(false)
    ed.dispatch({ type: 'select', sel: { a: { id: 'n', off: 1 }, f: { id: 'n', off: 1 } } })
    expect(key('a').defaultPrevented, 'the next a is an a again').toBe(false); expect(ed.state.sel.a.id).toBe('n')
    ed.dispose()
  })
})
