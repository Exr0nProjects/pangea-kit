// @vitest-environment jsdom
// zai3, the owner 2026-11-11 17:48 PST: "also its showing the bold tags ?? don't do that !! just fix the click select location
// parsing to actually be correct". Three kit rules, each red before the fix:
//  1. marks span the whole line (decorate.js inline): a `**` pair around a link, code, math or chip is paired and its markers
//     hidden off the caret's line (run per plain span, each half was unpaired and drew as literal "**");
//  2. a press does not redraw the line under it (editor.js revealSel: the selection the press began with, while it lasts);
//  3. the press's own caret is read back from the DOM at pointerup, before the gesture ends (ending it painted the old
//     state.sel over the browser's new caret, so a click left the caret where it was).
// The click-to-offset map over hidden syntax with real layout (snapHidden) is the app's browser check: zai-pangea
// test/shots/caretmap.mjs (every drawn character, both halves, in Chromium).
import { describe, expect, it } from 'vitest'
import * as E from '../lib/editor/editor.js'
import { inline } from '../lib/editor/decorate.js'

// an app's marks: `**x**` is bold, its markers flagged (the app marks contract: tokens that cover the input exactly)
function marks(text) {
  const out = []; let at = 0
  for (const m of text.matchAll(/\*\*(.+?)\*\*/g)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), cls: [] })
    out.push({ text: '**', cls: ['b'], marker: true }, { text: m[1], cls: ['b'] }, { text: '**', cls: ['b'], marker: true })
    at = m.index + m[0].length
  }
  if (at < text.length) out.push({ text: text.slice(at), cls: [] })
  return out
}
// the text a reader sees: every text leaf not hidden and not inside an inert decoration, with its classes
const leaves = (v, inert = false) => typeof v === 'string' ? [{ t: v, c: [] }]
  : v.text != null && !v.children ? [{ t: v.text, c: String(v.cls || '').split(/\s+/), inert: inert || v.inert }]
    : (v.children || []).flatMap((k) => leaves(k, inert || v.inert)).map((l) => ({ ...l, c: [...l.c, ...String(v.cls || '').split(/\s+/)] }))
const drawn = (body, active = false) => leaves({ tag: 'div', children: inline(body, { marks, active }) }).filter((l) => !l.inert && !l.c.includes('qk-hide'))

describe('marks span the whole line: bold around a link, code or math hides its markers off the caret line', () => {
  for (const body of ['**see [x](https://e.com)**', '**a `c` b**', '**a $x$ b**', '**see [x](https://e.com) and `code` here** end'])
    it(JSON.stringify(body), () => {
      const shown = drawn(body)
      expect(shown.map((l) => l.t).join('')).not.toContain('**')
      expect(shown.find((l) => /\w/.test(l.t)).c).toContain('b') // the first drawn word is bold
      // on the caret's line the markers are drawn (faint), and the source is the body, byte for byte
      expect(drawn(body, true).map((l) => l.t).join('')).toContain('**')
      expect(leaves({ tag: 'div', children: inline(body, { marks, active: true }) }).filter((l) => !l.inert).map((l) => l.t).join('')).toBe(body)
    })
  it('a `*` inside a URL or code is never a delimiter', () => {
    expect(drawn('a [x](https://e.com/**y) b `**` c').map((l) => l.c.includes('b')).some(Boolean)).toBe(false)
  })
})

describe('revealSel: a press never redraws the line under the pointer', () => {
  const app = { textOf: (r) => r.body, estimate: () => 20, items: (doc) => doc.lines().map((r) => ({ ...r, key: r.id, addr: r.id })), render: () => ({ tag: 'div' }), reduce: () => null }
  const at = (id, off) => ({ a: { id, off }, f: { id, off } })
  it('during a gesture it is the selection the press began with; after, state.sel', () => {
    const s = E.initState(app), doc = E.memoryLines([{ id: 'a', body: 'x', ord: 1 }, { id: 'b', body: 'y', ord: 2 }])
    E.step(app, doc, s, { type: 'select', sel: at('a', 0), id: '1', at: 1 })
    E.step(app, doc, s, { type: 'gesture', on: true, kind: 'select', id: '2', at: 2 })
    E.step(app, doc, s, { type: 'select', sel: at('b', 1), id: '3', at: 3 })
    expect(s.sel).toEqual(at('b', 1))
    expect(E.revealSel(s)).toEqual(at('a', 0))
    E.step(app, doc, s, { type: 'gesture', on: false, id: '4', at: 4 })
    expect(E.revealSel(s)).toEqual(at('b', 1))
  })
})

describe('a click puts the caret where the browser put it: the DOM selection is read back at pointerup', () => {
  const app = { textOf: (r) => r.body, estimate: () => 20, items: (doc) => doc.lines().map((r) => ({ ...r, key: r.id, addr: r.id })), render: (it) => ({ tag: 'div', addr: it.id, children: [it.body] }), reduce: () => null }
  it('press on line b at 2 with the caret on a: state.sel is b:2 after the gesture ends', () => {
    document.body.innerHTML = '<div id="s"><div id="d" contenteditable="true"></div></div>'
    const doc = E.memoryLines([{ id: 'a', body: 'hello', ord: 1 }, { id: 'b', body: 'second', ord: 2 }], { sortKey: (r) => [r.ord, r.id] }); let t = 1e12
    const root = document.getElementById('d')
    const ed = E.createEditor({ root, app, doc, contract: { name: 'click-editor', actions: [] }, dev: false, clock: () => (t += 100) })
    ed.focus?.(); ed.dispatch({ type: 'select', sel: { a: { id: 'a', off: 1 }, f: { id: 'a', off: 1 } } })
    const down = new Event('pointerdown', { bubbles: true }); down.button = 0; down.pointerId = 1; root.dispatchEvent(down)
    expect(ed.state.gesture).not.toBe(null)
    // the browser places its caret (selectionchange is queued until after pointerup)
    const node = root.querySelector('[data-addr="b"]').firstChild, r = document.createRange(); r.setStart(node, 2); r.collapse(true)
    const ds = window.getSelection(); ds.removeAllRanges(); ds.addRange(r)
    window.dispatchEvent(new Event('pointerup'))
    expect(ed.state.gesture).toBe(null)
    expect(ed.state.sel).toEqual({ a: { id: 'b', off: 2 }, f: { id: 'b', off: 2 } })
  })
})
