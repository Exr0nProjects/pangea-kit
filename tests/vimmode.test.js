// Vim mode over rows (lib/editor/vimmode.js; the engine is ./vim.js, tests/vim.engine.test.js): the key notation, the buffer around the caret, the row edits a new
// text means (untouched rows keep their ids, a changed line is one write, extra rows are soft-deleted, new lines are keyed new rows with ords between neighbours),
// the projection that keeps the cursor out of a marker, and the editor wiring (`vim` action, `vimkey` edit, declared only for an app with `vim`).
import { describe, expect, it } from 'vitest'
import { vimNotation, vimBuffer, atOffset, bufferView, rowsDiff, vimDrawn, vimLabel, syncVim } from '../lib/editor/vimmode.js'
import { createVim, vimKey } from '../lib/editor/vim.js'
import { ordBetween } from '../lib/editor/lines.js'
import { createEditor, memoryLines, initState, step } from '../lib/editor/editor.js'
import { declareEditor } from '../lib/editor/declare.js'
import { validate } from '../lib/validate.js'

const row = (id, ord, body, extra = {}) => ({ id, ord, body, deleted_at: null, ...extra })
const key = (o) => ({ key: '', metaKey: false, altKey: false, ctrlKey: false, ...o })

describe('vimNotation', () => {
  it('plain keys, Escape, Enter, Backspace, Tab, ⌃R, ⌃C and ⌃[; ⌘ and ⌥ chords and arrows are not vim\'s', () => {
    expect(vimNotation(key({ key: 'x' }))).toBe('x'); expect(vimNotation(key({ key: 'Escape' }))).toBe('<Esc>'); expect(vimNotation(key({ key: 'Enter' }))).toBe('<CR>')
    expect(vimNotation(key({ key: 'Backspace' }))).toBe('<BS>'); expect(vimNotation(key({ key: 'Tab' }))).toBe('<Tab>')
    expect(vimNotation(key({ key: 'r', ctrlKey: true }))).toBe('<C-r>'); expect(vimNotation(key({ key: 'c', ctrlKey: true }))).toBe('<Esc>'); expect(vimNotation(key({ key: '[', ctrlKey: true }))).toBe('<Esc>')
    for (const o of [{ key: 'z', metaKey: true }, { key: 'a', altKey: true }, { key: 'ArrowDown' }, { key: 'k', ctrlKey: true }, { key: 'F5' }]) expect(vimNotation(key(o))).toBeNull()
  })
})

describe('the buffer around the caret', () => {
  const ROWS = [row('a', 1, 'a1'), row('b', 2, 'a2'), row('c', 3, ''), row('d', 4, ''), row('e', 5, 'b1'), row('f', 6, 'b2')]
  it('two blank rows end it; one blank row stays inside; another group is out; text and starts', () => {
    const b = vimBuffer(ROWS, 0); expect([b.from, b.to, b.text]).toEqual([0, 2, 'a1\na2']); expect(b.starts).toEqual([0, 3])
    const c = vimBuffer(ROWS, 5); expect([c.from, c.to, c.text]).toEqual([4, 6, 'b1\nb2'])
    const one = [row('a', 1, 'x'), row('b', 2, ''), row('c', 3, 'y')]; expect(vimBuffer(one, 0).text).toBe('x\n\ny')
    const g = vimBuffer(ROWS, 0, { group: (r) => (r.id < 'b' ? 0 : 1) }); expect(g.to).toBe(1)
    expect(vimBuffer(ROWS, 0, { edge: (r) => r.id === 'b' }).to).toBe(1)
    expect(vimBuffer(Array.from({ length: 50 }, (_, i) => row(`r${i}`, i, 'x')), 25, { cap: 5 }).to - vimBuffer(Array.from({ length: 50 }, (_, i) => row(`r${i}`, i, 'x')), 25, { cap: 5 }).from).toBeLessThanOrEqual(11)
  })
  it('atOffset and the view keep the cursor out of a marker', () => {
    const rows = [row('a', 1, '- [ ] go'), row('b', 2, 'plain')], b = vimBuffer(rows, 0)
    expect(atOffset(b, 10)).toEqual({ index: 1, col: 1 }); expect(atOffset(b, 0)).toEqual({ index: 0, col: 0 })
    const view = bufferView(b, rows, (r) => (r.body.startsWith('- [ ] ') ? 6 : 0))
    expect(view.project(2)).toBe(6); expect(view.project(8)).toBe(8); expect(view.words(2)).toEqual({ start: 6, end: 8 })
    const st = createVim(b.text, 2); expect(vimDrawn(st, view)).toEqual({ start: 6, end: 7 }) // the block cursor sits on the first word's first letter
  })
})

describe('rowsDiff', () => {
  const rows = [row('a', 1, 'one'), row('b', 2, 'two'), row('c', 3, 'three'), row('z', 9, 'after')]
  const opts = { stamp: 'T', ordBetween, set: (r, b) => ({ body: b }), make: (b, ord) => ({ body: b, ord }) }
  const apply = (lines) => { const d = rowsDiff(rows, 0, 3, lines, opts); return { ...d, by: Object.fromEntries(d.puts.map((p) => [p.id, p.set])) } }
  it('a changed line is one write; the untouched rows are not mentioned', () => {
    const d = apply(['one', 'TWO', 'three']); expect(d.puts).toEqual([{ id: 'b', set: { body: 'TWO' } }]); expect([...d.idOf].sort((x, y) => x[0] - y[0])).toEqual([[0, 'a'], [1, 'b'], [2, 'c']])
  })
  it('a deleted line soft-deletes its row; a joined line rewrites one and deletes the other', () => {
    const del = apply(['one', 'three']); expect(del.by.b).toEqual({ deleted_at: 'T', updated_at: 'T' }); expect(del.by.c).toBeUndefined(); expect(del.puts).toHaveLength(1) // the tail line 'three' stays on its own row
    const join = apply(['one two three']); expect(join.by.a).toEqual({ body: 'one two three' }); expect(join.by.b.deleted_at).toBe('T'); expect(join.by.c.deleted_at).toBe('T')
  })
  it('new lines become keyed new rows with ords between the kept row and the one after; the others keep their ids', () => {
    const d = apply(['one', 'two', 'three', 'four', 'five']), n = d.puts.filter((p) => /^v/.test(p.id))
    expect(n.map((p) => p.id)).toEqual(['v0', 'v1']); expect(n[0].set.ord).toBeGreaterThan(3); expect(n[1].set.ord).toBeGreaterThan(n[0].set.ord); expect(n[1].set.ord).toBeLessThan(9)
    expect(d.idOf.get(0)).toBe('a'); expect(d.idOf.get(3)).toBe('v0'); expect(d.idOf.get(4)).toBe('v1')
    const mid = apply(['one', 'NEW', 'two', 'three']); expect(mid.puts.some((p) => p.set.body === 'NEW')).toBe(true) // an insert in the middle shifts bodies row by row (ids stay positional)
  })
  it('an ord of another group is no bound', () => {
    const r2 = [row('a', 1, 'x', { g: 0 }), row('b', 2, 'y', { g: 1 })], d = rowsDiff(r2, 0, 1, ['x', 'x2'], { ...opts, group: (r) => r.g })
    expect(d.puts[0].set.ord).toBeGreaterThan(1); expect(d.puts[0].set.ord).toBeLessThan(Infinity)
  })
})

describe('syncVim and the label', () => {
  it('the same text and the drawn selection keep the engine; other text starts again keeping registers', () => {
    let s = createVim('hello world', 0); s = vimKey(vimKey(s, 'y'), 'w')
    const same = syncVim(s, 'hello world', { start: 0, end: 1 }); expect(same).toBe(s)
    const other = syncVim(s, 'hi there', { start: 0, end: 0 }); expect(other.text).toBe('hi there'); expect(vimKey(other, 'p').text).toBe('hhello i there')
    expect(vimLabel(null)).toBe('NORMAL'); expect(vimLabel(vimKey(createVim('a', 0), 'i'))).toBe('INSERT'); expect(vimLabel(vimKey(createVim('a', 0), 'V'))).toBe('V-LINE')
  })
})

describe('the editor wiring', () => {
  const sortKey = (r) => [r.ord, r.id]
  const app = { vim: true, keys: [], textOf: (r) => r.body ?? '', estimate: () => 20, items: (d) => d.lines().map((r) => ({ ...r, key: r.id, addr: r.id })), render: (it) => ({ tag: 'div', addr: it.id, text: it.body }),
    reduce: (state, a) => (a.type === 'vimkey' ? { puts: [{ id: 'a', set: { body: `${a.key}!` } }] } : null) }
  const mount = () => { document.body.innerHTML = '<div><div id="d" contenteditable="true"></div></div>'; const doc = memoryLines([row('a', 1, 'abc')], { sortKey }); const ed = createEditor({ root: document.getElementById('d'), app, doc, contract: { name: `v-${Math.random()}`, actions: [] }, dev: true }); return { ed, doc } }
  it('`vim {on}` is absolute; while on, a vim key is one vimkey action carrying the notation and the default is prevented; off, nothing is spent', () => {
    const { ed, doc } = mount()
    ed.dispatch({ type: 'select', sel: { a: { id: 'a', off: 0 }, f: { id: 'a', off: 0 } } })
    const off = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }); ed.root.dispatchEvent(off); expect(off.defaultPrevented).toBe(false)
    ed.dispatch({ type: 'vim', on: true }); ed.dispatch({ type: 'vim', on: true }); expect(ed.state.vim).toEqual({ on: true })
    const on = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }); ed.root.dispatchEvent(on)
    expect(on.defaultPrevented).toBe(true); expect(doc.get('a').body).toBe('x!'); expect(ed.log.filter((a) => a.type === 'vimkey').map((a) => a.key)).toEqual(['x']); expect(ed.log.at(-1).id).toBeTruthy()
    const mod = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }); ed.root.dispatchEvent(mod); expect(ed.log.filter((a) => a.type === 'vimkey')).toHaveLength(1)
    ed.dispatch({ type: 'vim', on: 'yes' }); expect(ed.state.vim.on).toBe(false)
    ed.dispose()
  })
  it('a redelivered vimkey (same id) is spent once; while a select-all is loading it is refused with the notice', () => {
    const doc = memoryLines([row('a', 1, 'abc')], { sortKey }), st = initState(app)
    step(app, doc, st, { type: 'vimkey', key: 'x', id: 'k1', at: 1 }); expect(doc.get('a').body).toBe('x!')
    st.wide = { op: 'select-all' }; step(app, doc, st, { type: 'vimkey', key: 'q', id: 'k2', at: 2 }); expect(doc.get('a').body).toBe('x!'); expect(st.notice?.code).toBe('select-all-loading')
  })
  it('declared laws: vim and vimkey are in the alphabet for an app with vim, vimkey is not for one without', async () => {
    const d = declareEditor({ name: `lv-${Math.random()}`, actions: [], sortKey, sample: [row('a', 1, 'abc'), row('b', 2, 'def')] }, app)
    expect(Object.keys(d.view.actions)).toContain('vim'); expect(Object.keys(d.edits.actions)).toContain('vimkey')
    const plain = declareEditor({ name: `lp-${Math.random()}`, actions: [] }, { ...app, vim: undefined })
    expect(Object.keys(plain.edits.actions)).not.toContain('vimkey')
    const r = await validate({ decls: [d.view, d.edits], ui: true, timing: false })
    expect(r.ok, JSON.stringify(r).slice(0, 700)).toBe(true)
  }, 60000)
})
