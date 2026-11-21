// @vitest-environment jsdom
// The editor's caret, fold, IME and gesture layer (plan step 3; PANGEA3-DESIGN §15 UI laws 1 and 3, A6). Each rule has a
// planted bug (tests/planted.js) that turns its check red. Layout-dependent moves (Up/Down, visual line edges, pages)
// need real layout: they are covered by the browser checks (lib/editor/browser-check.mjs oracle and fuzz).
import { describe, expect, it } from 'vitest'
import * as E from '../lib/editor/editor.js'
import { planted } from './planted.js'

const app = {
  textOf: (r) => r.body,
  estimate: () => 20,
  keyActions: { 'mod+/': { type: 'fold' } },
  items: (doc) => doc.lines().map((r) => ({ ...r, key: r.id, addr: r.id })),
  render: (it) => ({ tag: 'div', addr: it.id, children: it.body ? [it.body] : [{ tag: 'br' }] }),
  reduce(state, a, ctx) {
    const sel = a.sel, at = a.at
    if (a.type === 'compose-end') { const r = ctx.get(a.addr); if (!r || a.text == null) return null; const off = a.off ?? a.text.length; return { puts: [{ id: r.id, set: { body: a.text } }], sel: { a: { id: r.id, off }, f: { id: r.id, off } } } }
    if (a.type !== 'input' || !sel || sel.a.id !== sel.f.id) return null
    const r = ctx.get(sel.a.id), s = r.body, lo = Math.min(sel.a.off, sel.f.off), hi = Math.max(sel.a.off, sel.f.off)
    if (a.inputType === 'insertParagraph') { const id = `n${at}`; return { puts: [{ id: r.id, set: { body: s.slice(0, lo) } }, { id, set: { body: s.slice(hi), ord: r.ord + 0.5 } }], sel: { a: { id, off: 0 }, f: { id, off: 0 } } } }
    if (a.inputType.startsWith('insert')) return { puts: [{ id: r.id, set: { body: s.slice(0, lo) + a.text + s.slice(hi) } }], sel: { a: { id: r.id, off: lo + a.text.length }, f: { id: r.id, off: lo + a.text.length } } }
    return null
  },
}
const contract = { name: 'caret-editor', actions: [] }
const rows = () => [{ id: 'a', body: 'hello world', ord: 1 }, { id: 'b', body: 'second', ord: 2 }, { id: 'c', body: 'third', ord: 3 }]
const at = (id, off) => ({ a: { id, off }, f: { id, off } })
function mount(M = E, rs = rows()) {
  document.body.innerHTML = '<div id="s"><div id="d" contenteditable="true"></div></div>'
  const doc = M.memoryLines(rs, { sortKey: (r) => [r.ord, r.id] }); let t = 1e12
  const ed = M.createEditor({ root: document.getElementById('d'), app, doc, contract, dev: false, clock: () => (t += 100) })
  return { doc, ed }
}

describe('fold is an absolute action; the toggle is a gesture resolved at dispatch (A6)', () => {
  const check = (M) => {
    const { ed } = mount(M)
    ed.dispatch({ type: 'select', sel: at('b', 1) })
    ed.dispatch({ type: 'fold' }) // the gesture: fold the caret line
    const logged = ed.log[ed.log.length - 1]
    // replaying the logged action again (a redelivery under another id, a second replica) changes nothing
    const { state } = M.modelRun(app, rows(), [...ed.log, { ...logged, id: 'again' }].map((a) => ({ ...a })), { sortKey: (r) => [r.ord, r.id] })
    return { logged, folds: ed.state.folds, replayed: state.folds }
  }
  it('the log holds { addr, on }, and replaying it twice leaves the fold as once', () => {
    const r = check(E)
    expect(r.logged).toMatchObject({ type: 'fold', addr: 'b', on: true })
    expect(r.folds).toEqual(['b']); expect(r.replayed).toEqual(['b'])
  })
  it('a fold with no `on` reaching the reducer is a no-op (a toggle can never be logged)', () => {
    const s = E.initState(app); const doc = E.memoryLines(rows())
    E.step(app, doc, s, { type: 'fold', addr: 'b', id: 'x', at: 1 }); expect(s.folds).toEqual([])
  })
  it('planted: a toggling fold reducer flips on replay (red)', async () => {
    const M = await planted('lib/editor/editor.js', "if (a.on && !has) state.folds = [...state.folds, a.addr]; else if (!a.on && has)", "if (!has) state.folds = [...state.folds, a.addr]; else if (has)")
    expect(check(M).replayed).toEqual([])
  })
})

describe('IME: a remote edit during composition is never overwritten (precondition on the composing row, rebase)', () => {
  const run = (M) => {
    const { doc, ed } = mount(M)
    ed.dispatch({ type: 'select', sel: at('a', 5) })
    ed.dispatch({ type: 'compose-start', addr: 'a' })
    doc.put([{ id: 'a', set: { body: 'REMOTE hello world' } }]) // another device's edit lands mid-composition
    ed.dispatch({ type: 'remote' })
    // the browser's composed line, from the text it had at compose-start: "hello" + "日本" + " world"
    ed.dispatch({ type: 'compose-end', addr: 'a', text: 'hello日本 world', off: 7 })
    return { body: doc.get('a').body, sel: ed.state.sel }
  }
  it('compose-end applies the composition to the line as it is now', () => {
    const r = run(E)
    expect(r.body).toBe('REMOTE hello日本 world')
    expect(r.sel.f).toEqual({ id: 'a', off: 14 })
  })
  it('without a remote edit compose-end is the browser text as before', () => {
    const { doc, ed } = mount()
    ed.dispatch({ type: 'compose-start', addr: 'b' }); ed.dispatch({ type: 'compose-end', addr: 'b', text: 'sec日ond', off: 4 })
    expect(doc.get('b').body).toBe('sec日ond')
  })
  it('planted: compose-end written over the line (no rebase) loses the remote edit (red)', async () => {
    const M = await planted('lib/editor/editor.js', "  if (now === base) return a;\n", "  return a;\n")
    expect(run(M).body).toBe('hello日本 world')
  })
})

describe('gesture exit edges: a selection drag ends on every exit; an IME composition ends on blur and hide', () => {
  const fire = (ed, why) => {
    const W = window, D = document
    if (why === 'visibilitychange') { Object.defineProperty(D, 'visibilityState', { configurable: true, get: () => 'hidden' }); D.dispatchEvent(new Event('visibilitychange')); delete D.visibilityState }
    else if (why === 'scroll') document.getElementById('s').dispatchEvent(new Event('scroll'))
    else if (why === 'lostpointercapture') document.getElementById('d').dispatchEvent(new Event('lostpointercapture'))
    else W.dispatchEvent(new Event(why))
  }
  const down = () => { const e = new Event('pointerdown', { bubbles: true }); e.button = 0; e.pointerId = 1; document.getElementById('d').dispatchEvent(e) }
  const stuck = (M) => M.GESTURE_EXITS.filter((why) => { const { ed } = mount(M); down(); const on = !!ed.state.gesture; fire(ed, why); return !on || ed.state.gesture !== null })
  it('pointerdown starts the gesture; each of pointerup, pointercancel, lostpointercapture, blur, hide, scroll ends it', () => {
    expect(E.GESTURE_EXITS).toEqual(['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'visibilitychange', 'scroll'])
    expect(stuck(E)).toEqual([])
  })
  it('a composition the browser never ends (blur, hide) is read back and closed', () => {
    for (const why of ['blur', 'visibilitychange']) { const { ed } = mount(); ed.dispatch({ type: 'compose-start', addr: 'b' }); fire(ed, why); expect(ed.state.composing, why).toBe(null) }
  })
  it('planted: an exit edge left out (pointercancel) leaves the gesture stuck (red)', async () => {
    const M = await planted('lib/editor/editor.js', "const exits = GESTURE_EXITS.map(", "const exits = GESTURE_EXITS.filter((w) => w !== 'pointercancel').map(")
    expect(stuck(M)).toEqual(['pointercancel'])
  })
})

describe('⌃O opens a line: a break after the caret, the caret stays (mapped from state; headless Chromium emits nothing)', () => {
  it('modelRun: insertOpenLine splits at the caret and keeps it', () => {
    const { doc, state } = E.modelRun(app, rows(), [{ type: 'select', sel: at('a', 5), id: '1', at: 1 }, { type: 'input', inputType: E.OPEN_LINE, text: '', sel: at('a', 5), id: '2', at: 2 }], { sortKey: (r) => [r.ord, r.id] })
    expect(doc.lines().map((r) => r.body)).toEqual(['hello', ' world', 'second', 'third'])
    expect(state.sel).toEqual(at('a', 5))
  })
})

describe('a vertical move run keeps its goal x in kit state; any other action ends it', () => {
  it('select { goal } sets it, the next non-select clears it', () => {
    const s = E.initState(app), doc = E.memoryLines(rows())
    E.step(app, doc, s, { type: 'select', sel: at('b', 2), goal: 41.5, reveal: true, id: '1', at: 1 }); expect(s.goal).toBe(41.5); expect(s.reveal).toBe(true)
    E.step(app, doc, s, { type: 'focus', focus: true, id: '2', at: 2 }); expect(s.goal).toBe(null)
  })
})

describe('layout-dependent caret moves are kit actions, never the browser\'s (resolved against the render map)', () => {
  // jsdom has no layout: a Range has no client rects, so every line is one visual line (the move goes to the next row)
  globalThis.Range && (Range.prototype.getClientRects ??= () => [])
  const press = (M, key, opts = {}) => {
    const { ed } = mount(M, rows())
    ed.dispatch({ type: 'focus', focus: true }); ed.dispatch({ type: 'select', sel: at('a', 3) })
    const n = ed.log.length
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts })
    document.getElementById('d').dispatchEvent(e)
    return { prevented: e.defaultPrevented, acts: ed.log.slice(n), sel: ed.state.sel }
  }
  it('↓ is cancelled and becomes one select action through the reducer (caret on the next line)', () => {
    const r = press(E, 'ArrowDown')
    expect(r.prevented).toBe(true)
    expect(r.acts.map((a) => a.type)).toEqual(['select'])
    expect(r.sel.f.id).toBe('b')
  })
  it('a plain ↓ over a selection moves from its end (a textarea\'s rule; the oracle compares from a caret)', () => {
    const { ed } = mount(E, rows())
    ed.dispatch({ type: 'focus', focus: true }); ed.dispatch({ type: 'select', sel: { a: { id: 'a', off: 3 }, f: { id: 'b', off: 2 } } })
    document.getElementById('d').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(ed.state.sel.f.id).toBe('c'); expect(ed.state.sel.a).toEqual(ed.state.sel.f)
  })
  it('planted: ↓ left to the browser (the 11-08 behaviour) is not cancelled and logs nothing (red)', async () => {
    const M = await planted('lib/editor/editor.js', "caretMove(e, 'v', e.key === 'ArrowUp' || k === 'p' ? -1 : 1); return;", 'return;')
    const r = press(M, 'ArrowDown')
    expect(r.prevented).toBe(false); expect(r.acts).toEqual([])
  })
})
