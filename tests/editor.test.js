// The kit editor (lib/editor/editor.js) and its deploy gate (lib/editor/gate.mjs), app-independent. The browser checks
// run against an app harness (zai-pangea/test/ui) through the gate; here: construction, projection, idempotence, the
// layout-free delete ranges, the mutation guard, and publish refusing on a failed gate.
import { describe, expect, it } from 'vitest'
import { createEditor, memoryLines, deleteRange, modelRun, snapshot } from '../lib/editor/editor.js'

// a minimal line editor: plain text rows, typing and deletes inside a line, Enter splits
const app = {
  textOf: (r) => r.body,
  estimate: () => 20,
  items: (doc) => doc.lines().map((r) => ({ ...r, key: r.id, addr: r.id })),
  render: (it) => ({ tag: 'div', addr: it.id, children: it.body ? [it.body] : [{ tag: 'br' }] }),
  reduce(state, a, ctx) {
    if (a.type !== 'input' || !a.sel) return null
    const r = ctx.get(a.sel.a.id), off = a.sel.a.off
    if (a.inputType === 'insertText') return { puts: [{ id: r.id, set: { body: r.body.slice(0, off) + a.text + r.body.slice(off) } }], sel: { a: { id: r.id, off: off + a.text.length }, f: { id: r.id, off: off + a.text.length } } }
    if (a.inputType === 'insertParagraph') { const op = ctx.mint({ puts: [{ id: 'new', set: { body: r.body.slice(off), ord: r.ord + 0.5 } }, { id: r.id, set: { body: r.body.slice(0, off) } }] }); return { puts: op.puts, sel: { a: { id: op.puts[0].id, off: 0 }, f: { id: op.puts[0].id, off: 0 } } } }
    return null
  },
}
const contract = { name: 'test-editor', actions: [] }
const rows = () => [{ id: 'a', body: 'hello', ord: 1 }, { id: 'b', body: '', ord: 2 }, { id: 'c', body: 'world', ord: 3 }]
function mount() {
  document.body.innerHTML = '<div><div id="d" contenteditable="true"></div></div>'
  const doc = memoryLines(rows()); let t = 1e12
  return { doc, ed: createEditor({ root: document.getElementById('d'), app, doc, contract, dev: true, clock: () => (t += 100) }) }
}

describe('kit editor', () => {
  it('refuses to construct without a contract, and rejects undeclared actions', () => {
    document.body.innerHTML = '<div><div id="d"></div></div>'
    expect(() => createEditor({ root: document.getElementById('d'), app, doc: memoryLines(rows()) })).toThrow(/contract/)
    const { ed } = mount()
    expect(() => ed.dispatch({ type: 'teleport' })).toThrow(/not in the contract/)
  })
  it('a fresh render equals the live root after each action; every element is addressed; replay gives the same state', () => {
    const { ed } = mount()
    const sel = (id, off) => ({ a: { id, off }, f: { id, off } })
    for (const a of [{ type: 'select', sel: sel('a', 5) }, { type: 'input', inputType: 'insertText', text: '!', sel: sel('a', 5) }, { type: 'input', inputType: 'insertParagraph', sel: sel('a', 2) }, { type: 'move', dir: -1 }]) {
      ed.dispatch(a)
      expect(ed.checks.freshDiff()).toBeNull()
      expect(ed.checks.unaddressed()).toBeNull()
    }
    const m = modelRun(app, rows(), ed.log.map((a) => ({ ...a })))
    expect(snapshot(app, m.doc, m.state)).toEqual(ed.snapshot())
  })
  it('a redelivered action id is a no-op', () => {
    const { ed, doc } = mount()
    const a = { id: 'x1', type: 'input', inputType: 'insertText', text: 'Z', sel: { a: { id: 'a', off: 0 }, f: { id: 'a', off: 0 } } }
    expect(ed.dispatch(a)).toBe(true); expect(ed.dispatch({ ...a })).toBe(false)
    expect(doc.get('a').body).toBe('Zhello')
  })
  it('delete ranges are logical (no layout): a blank line is one Backspace', () => {
    const ls = rows(), t = (r) => r.body
    expect(deleteRange('deleteContentBackward', { id: 'c', off: 0 }, ls, t)).toEqual({ a: { id: 'b', off: 0 }, f: { id: 'c', off: 0 }, join: true })
    expect(deleteRange('deleteWordBackward', { id: 'a', off: 5 }, ls, t)).toEqual({ a: { id: 'a', off: 0 }, f: { id: 'a', off: 5 } })
  })
  it('the dev guard records a DOM write outside a commit', async () => {
    const { ed } = mount()
    const h = (e) => e.preventDefault?.(); window.addEventListener('error', h)
    document.querySelector('[data-addr="a"]').append('x')
    await new Promise((ok) => setTimeout(ok, 0)); window.removeEventListener('error', h)
    expect(ed.checks.mutations()).toHaveLength(1)
  })
})

