// A read-only editor (createEditor({ readOnly: true }); zai3 commenters, the owner 2026-11-11 17:58 PST: "add specific people ...
// (edit, view, comment)"): selection, find, ⌘A, scroll and folds still run through the one reducer; nothing writes the doc.
// An edit whose reducer answer has rows is refused in the reducer with state.notice { code: READ_ONLY }, and the refill
// sentinel writes nothing. rangeOf(id, from, to) is the render map address -> DOM Range for painting outside the tree
// (CSS Custom Highlights): no DOM write. Planted: without the flag the same log writes the doc (the check is not vacuous).
import { describe, expect, it } from 'vitest'
import { createEditor, memoryLines, modelRun, READ_ONLY, step, initState } from '../lib/editor/editor.js'

const app = {
  textOf: (r) => r.body,
  estimate: () => 20,
  items: (doc) => doc.lines().map((r) => ({ ...r, key: r.id, addr: r.id })),
  render: (it) => ({ tag: 'div', addr: it.id, children: it.body ? [it.body] : [{ tag: 'br' }] }),
  keys: ['mod+d'],
  reduce(state, a, ctx) {
    if (a.type === 'key' && a.name === 'mod+d') { const id = state.sel?.f.id; return id ? { puts: [{ id, set: { deleted_at: 'x' } }] } : null }
    if (a.type === 'pointer') return { puts: [{ id: a.addr, set: { body: `${ctx.get(a.addr).body}!` } }] }
    if (a.type !== 'input' || !a.sel) return null
    const r = ctx.get(a.sel.a.id), off = a.sel.a.off
    if (a.inputType === 'insertText') return { puts: [{ id: r.id, set: { body: r.body.slice(0, off) + a.text + r.body.slice(off) } }], sel: { a: { id: r.id, off: off + a.text.length }, f: { id: r.id, off: off + a.text.length } } }
    return null
  },
}
const contract = { name: 'readonly-editor', actions: [] }
const rows = () => [{ id: 'a', body: 'hello there', ord: 1 }, { id: 'b', body: 'second line', ord: 2 }]
const at = (id, off) => ({ a: { id, off }, f: { id, off } })
const log = [
  { id: 'r1', type: 'select', sel: { a: { id: 'a', off: 0 }, f: { id: 'a', off: 5 } } },
  { id: 'r2', type: 'input', inputType: 'insertText', text: 'X', sel: at('a', 2) },
  { id: 'r3', type: 'key', name: 'mod+d' },
  { id: 'r4', type: 'pointer', addr: 'b' },
  { id: 'r5', type: 'select-all' },
  { id: 'r6', type: 'find', open: true, q: 'second' },
]

describe('read-only editor', () => {
  it('runs selection, ⌘A and find; refuses every write with a notice; the doc is byte for byte the same', () => {
    const { doc, state } = modelRun(app, rows(), log.map((a) => ({ ...a, at: 1 })), { readOnly: true })
    expect(doc.lines().map((r) => r.body)).toEqual(['hello there', 'second line'])
    expect(state.find.n).toBe(1)
    expect(state.sel).toEqual({ a: { id: 'b', off: 0 }, f: { id: 'b', off: 6 } })
  })
  it('the notice names the refused action', () => {
    const doc = memoryLines(rows()), state = initState(app)
    step(app, doc, state, { id: 'x', type: 'input', inputType: 'insertText', text: 'Q', sel: at('a', 0), at: 1 }, { readOnly: true })
    expect(state.notice).toEqual({ code: READ_ONLY, type: 'input', id: 'x' })
    expect(doc.get('a').body).toBe('hello there')
  })
  it('planted: without readOnly the same log writes the doc (the check above is not vacuous)', () => {
    const { doc } = modelRun(app, rows(), log.map((a) => ({ ...a, at: 1 })))
    expect(doc.lines().map((r) => r.body)).not.toEqual(['hello there', 'second line'])
  })
  it('a mounted read-only editor: typing through dispatch writes nothing, the refill sentinel is off, rangeOf maps an address to a DOM range without touching the DOM', () => {
    document.body.innerHTML = '<div><div id="d" contenteditable="true"></div></div>'
    const doc = memoryLines(rows()); let t = 1e12
    const ed = createEditor({ root: document.getElementById('d'), app, doc, contract, dev: true, readOnly: true, clock: () => (t += 100) })
    expect(ed.readOnly).toBe(true)
    ed.dispatch({ type: 'input', inputType: 'insertText', text: 'Z', sel: at('a', 0) })
    expect(doc.get('a').body).toBe('hello there')
    expect(ed.state.notice?.code).toBe(READ_ONLY)
    const before = document.getElementById('d').innerHTML
    const r = ed.rangeOf('a', 6, 11)
    expect(r.toString()).toBe('there')
    expect(ed.rangeOf('nope', 0, 1)).toBeNull()
    expect(document.getElementById('d').innerHTML).toBe(before)
    expect(ed.checks.mutations()).toBeNull()
    ed.dispose()
  })
})
