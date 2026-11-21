// @vitest-environment jsdom
// The kit editor's generic parts: kill ring and transpose (as intents in step), select-all and find over every row, folds,
// key -> kit action maps, copy from state, line structure (lib/editor/lines.js), decoration (lib/editor/decorate.js) and
// push-then-pull (lib/engine/push.js). Each is app-independent; zai2 (zai-pangea) consumes them.
import { describe, expect, it } from 'vitest'
import { createEditor, memoryLines, modelRun, snapshot, intentOf, textBetween } from '../lib/editor/editor.js'
import { subtreeEnd, foldView, moveLines, duplicateLines, indentLines, selectAll, findAll, ordBetween } from '../lib/editor/lines.js'
import { inline, scan, memo } from '../lib/editor/decorate.js'
import { pushPull } from '../lib/engine/push.js'

// a plain line editor: rows of text; inserts, deletes inside a line and joins at a line end
const app = {
  textOf: (r) => r.body,
  estimate: () => 20,
  keyActions: { 'mod+a': { type: 'select-all' }, 'mod+f': { type: 'find', open: true }, 'mod+/': { type: 'fold' } },
  items: (doc) => doc.lines().map((r) => ({ ...r, key: r.id, addr: r.id })),
  render: (it) => ({ tag: 'div', addr: it.id, children: it.body ? [it.body] : [{ tag: 'br' }] }),
  reduce(state, a, ctx) {
    if (a.type !== 'input' || !a.sel) return null
    const r = ctx.get(a.sel.a.id), s = r.body
    const lo = Math.min(a.sel.a.off, a.sel.f.off), hi = Math.max(a.sel.a.off, a.sel.f.off)
    if (a.sel.a.id !== a.sel.f.id) return null
    if (a.inputType.startsWith('insert')) return { puts: [{ id: r.id, set: { body: s.slice(0, lo) + a.text + s.slice(hi) } }], sel: { a: { id: r.id, off: lo + a.text.length }, f: { id: r.id, off: lo + a.text.length } } }
    if (a.inputType === 'deleteHardLineForward') {
      if (lo === hi && lo === s.length) { const i = ctx.index(r.id), nx = ctx.lines[i + 1]; if (!nx) return null; return { puts: [{ id: r.id, set: { body: s + nx.body } }, { id: nx.id, set: { deleted: true } }], sel: { a: { id: r.id, off: lo }, f: { id: r.id, off: lo } } } }
      const to = lo === hi ? s.length : hi
      return { puts: [{ id: r.id, set: { body: s.slice(0, lo) + s.slice(to) } }], sel: { a: { id: r.id, off: lo }, f: { id: r.id, off: lo } } }
    }
    return null
  },
}
const contract = { name: 'parts-editor', actions: [] }
const opts = { live: (r) => !r.deleted }
const rows = () => [{ id: 'a', body: 'hello world', ord: 1 }, { id: 'b', body: 'second line', ord: 2 }, { id: 'c', body: 'third', ord: 3 }]
const at = (id, off) => ({ a: { id, off }, f: { id, off } })
function mount(rs = rows()) {
  document.body.innerHTML = '<div><div id="d" contenteditable="true"></div></div>'
  const doc = memoryLines(rs, opts); let t = 1e12
  return { doc, ed: createEditor({ root: document.getElementById('d'), app, doc, contract, dev: true, clock: () => (t += 100) }) }
}
const input = (inputType, sel, text = '') => ({ type: 'input', inputType, sel, text })

describe('kill ring (kit state)', () => {
  it('⌃K kills to the line end, a second ⌃K appends the newline it joins, ⌃Y yanks the whole kill', () => {
    const { ed, doc } = mount()
    ed.dispatch(input('deleteHardLineForward', at('a', 5)))
    expect(doc.get('a').body).toBe('hello'); expect(ed.state.kill).toEqual({ text: ' world', open: true })
    ed.dispatch(input('deleteHardLineForward', at('a', 5)))
    expect(ed.state.kill.text).toBe(' world\n'); expect(doc.get('a').body).toBe('hellosecond line')
    ed.dispatch(input('insertFromYank', at('c', 5)))
    expect(doc.get('c').body).toBe('third world\n')
  })
  it('any other action between two ⌃K starts a new kill; a yank with an empty ring is a no-op', () => {
    const { ed, doc } = mount()
    ed.dispatch(input('insertFromYank', at('a', 0))); expect(doc.get('a').body).toBe('hello world')
    ed.dispatch(input('deleteHardLineForward', at('a', 5)))
    ed.dispatch({ type: 'move', dir: -1 })
    ed.dispatch(input('deleteHardLineForward', at('b', 6)))
    expect(ed.state.kill.text).toBe(' line')
    ed.dispatch(input('deleteHardLineForward', at('b', 6)))
    expect(ed.state.kill.text).toBe(' line\n')
  })
  it('a ⌃K over a selection kills the selection; the model replays kills and yanks to the same state', () => {
    const { ed } = mount()
    ed.dispatch(input('deleteHardLineForward', { a: { id: 'a', off: 0 }, f: { id: 'a', off: 5 } }))
    expect(ed.state.kill.text).toBe('hello')
    ed.dispatch(input('insertFromYank', at('c', 0)))
    const m = modelRun(app, rows(), ed.log.map((a) => ({ ...a })), opts)
    expect(snapshot(app, m.doc, m.state)).toEqual(ed.snapshot())
    expect(m.state.kill).toEqual(ed.state.kill)
  })
})

describe('transpose (⌃T), as a textarea does it', () => {
  const ls = rows(), t = (r) => r.body, st = { kill: { text: '', open: false } }
  const tr = (id, off) => intentOf(input('insertTranspose', at(id, off), 'xx'), st, ls, t)
  it('mid-line swaps around the caret, at the end swaps the last two, at the start or over a selection does nothing', () => {
    expect(tr('a', 3)).toMatchObject({ inputType: 'insertReplacementText', text: 'll', sel: { a: { off: 2 }, f: { off: 4 } } })
    expect(tr('c', 5)).toMatchObject({ text: 'dr', sel: { a: { off: 3 }, f: { off: 5 } } })
    expect(tr('a', 0)).toBeNull()
    expect(intentOf(input('insertTranspose', { a: { id: 'a', off: 1 }, f: { id: 'a', off: 3 } }), st, ls, t)).toBeNull()
  })
  it('textBetween joins lines with newlines', () => {
    expect(textBetween({ a: { id: 'b', off: 7 }, f: { id: 'a', off: 6 } }, ls, t)).toBe('world\nsecond ')
  })
})

describe('select-all, find and folds act on state, never on what is drawn', () => {
  it('select-all spans every row', () => {
    const many = Array.from({ length: 3000 }, (_, k) => ({ id: `r${k}`, body: `line ${k}`, ord: k }))
    const { ed } = mount(many)
    ed.dispatch({ type: 'select-all' })
    expect(ed.state.sel).toEqual({ a: { id: 'r0', off: 0 }, f: { id: 'r2999', off: 9 } })
  })
  it('find counts every match, steps with wraparound, and close returns to where it started (or keeps the match)', () => {
    const { ed } = mount()
    ed.dispatch({ type: 'select', sel: at('b', 0) })
    ed.dispatch({ type: 'find', open: true }); ed.dispatch({ type: 'find', q: 'L' })
    expect(ed.state.find).toMatchObject({ q: 'L', n: 4, i: 3 }) // hel|l|o wor|l|d, second |l|ine: the first at or after line b
    expect(ed.state.sel).toEqual({ a: { id: 'b', off: 7 }, f: { id: 'b', off: 8 } })
    ed.dispatch({ type: 'find', step: 1 }); expect(ed.state.find.i).toBe(0)
    ed.dispatch({ type: 'find', step: -1 }); expect(ed.state.find.i).toBe(3)
    ed.dispatch({ type: 'find', close: true }); expect(ed.state.find).toBeNull(); expect(ed.state.sel).toEqual(at('b', 0))
    ed.dispatch({ type: 'find', open: true }); ed.dispatch({ type: 'find', q: 'third' }); ed.dispatch({ type: 'find', close: true, keep: true })
    expect(ed.state.sel).toEqual({ a: { id: 'c', off: 0 }, f: { id: 'c', off: 5 } })
  })
  it('a find step is resolved before it is logged: the action that reaches the reducer is an absolute match index, so replaying it never moves the match again', () => {
    const { ed } = mount()
    ed.dispatch({ type: 'select', sel: at('b', 0) })
    ed.dispatch({ type: 'find', open: true }); ed.dispatch({ type: 'find', q: 'L' })
    const seen = []; ed.subscribe((_s, a) => { if (a?.type === 'find') seen.push(a) })
    ed.dispatch({ type: 'find', step: 1 })
    expect(seen.at(-1)).toMatchObject({ type: 'find', i: 0 }); expect('step' in seen.at(-1)).toBe(false)
    const before = ed.state.find.i
    ed.dispatch({ ...seen.at(-1), id: undefined }); ed.dispatch({ ...seen.at(-1), id: undefined }) // the same absolute action delivered again
    expect(ed.state.find.i).toBe(before)
    ed.dispatch({ type: 'find', i: 99 }); expect(ed.state.find.i).toBe(3) // clamped to the last match
    ed.dispatch({ type: 'find', q: 'zz' }); ed.dispatch({ type: 'find', step: 1 }); expect(ed.state.find).toMatchObject({ n: 0, i: -1, cur: null })
  })
  it('fold without an address folds the caret line; a fresh render still equals the live root', () => {
    const { ed } = mount()
    ed.dispatch({ type: 'select', sel: at('b', 2) }); ed.dispatch({ type: 'fold' })
    expect(ed.state.folds).toEqual(['b']); ed.dispatch({ type: 'fold', addr: 'b' }); expect(ed.state.folds).toEqual([])
    expect(ed.checks.freshDiff()).toBeNull()
  })
  it('an app chord mapped in keyActions dispatches the kit action', () => {
    const { ed } = mount()
    document.getElementById('d').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: /Mac|iPhone|iPad/.test(navigator.platform), ctrlKey: !/Mac|iPhone|iPad/.test(navigator.platform), bubbles: true, cancelable: true }))
    expect(ed.log.at(-1).type).toBe('select-all')
  })
  it('a shifted punctuation chord reaches the app as one key action: ⌘⇧. is "mod+shift+.", not "mod+."', () => {
    document.body.innerHTML = '<div><div id="d" contenteditable="true"></div></div>'
    const mac = /Mac|iPhone|iPad/.test(navigator.platform), seen = []
    const chords = { ...app, keys: ['mod+.', 'mod+shift+.'], reduce: (state, a) => { if (a.type === 'key') seen.push(a.name); return null } }
    const ed = createEditor({ root: document.getElementById('d'), app: chords, doc: memoryLines(rows(), opts), contract: { name: 'chord-editor', actions: [] }, dev: true, clock: () => 1e12 })
    const press = (o) => document.getElementById('d').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, metaKey: mac, ctrlKey: !mac, ...o }))
    press({ key: '.' }); press({ key: '>', shiftKey: true }); press({ key: '<', shiftKey: true })
    expect(seen).toEqual(['mod+.', 'mod+shift+.'])
    expect(ed.log.filter((a) => a.type === 'key').map((a) => a.name)).toEqual(seen)
  })
  it('an inert html vnode renders; an addressed one is refused', () => {
    document.body.innerHTML = '<div><div id="d" contenteditable="true"></div></div>'
    const deco = { ...app, render: (it) => ({ tag: 'div', addr: it.id, children: [it.body, { tag: 'span', inert: true, html: '<i>x</i>' }] }) }
    const ed = createEditor({ root: document.getElementById('d'), app: deco, doc: memoryLines(rows()), contract, dev: true })
    expect(document.querySelector('[data-addr="a"] i').textContent).toBe('x'); expect(ed.checks.freshDiff()).toBeNull()
    document.body.innerHTML = '<div><div id="d" contenteditable="true"></div></div>'
    const bad = { ...app, render: (it) => ({ tag: 'div', addr: it.id, html: '<i>x</i>' }) }
    expect(() => createEditor({ root: document.getElementById('d'), app: bad, doc: memoryLines(rows()), contract })).toThrow(/inert/)
  })
})

describe('line structure (lib/editor/lines.js)', () => {
  const depth = (r) => (r.body.trim() ? /^ */.exec(r.body)[0].length / 2 : null)
  const L = () => [
    { id: 'p', body: 'parent', ord: 1, z: 1 }, { id: 'c1', body: '  child', ord: 2, z: 1 }, { id: 'b', body: '', ord: 3, z: 1 },
    { id: 'c2', body: '  child 2', ord: 4, z: 1 }, { id: 'n', body: 'next', ord: 5, z: 1 }, { id: 'o', body: 'other zone', ord: 1, z: 2 }]
  const o = { depth, group: (r) => r.z }
  it('a subtree runs over blank lines to the last deeper line; folds hide it and count it', () => {
    expect(subtreeEnd(L(), 0, o)).toBe(4)
    const fv = foldView(L(), ['p'], o)
    expect([...fv.hidden]).toEqual(['c1', 'b', 'c2']); expect(fv.count.get('p')).toBe(3); expect(fv.parents.has('p')).toBe(true)
  })
  it('moving a line takes its subtree; down jumps the next line, at a group edge it crosses into the next group', () => {
    const put = moveLines(L(), 0, 0, 1, { ...o, at: 0 })
    expect(put.map((p) => p.id)).toEqual(['p', 'c1', 'b', 'c2'])
    expect(put.every((p) => p.set.ord > 5)).toBe(true)
    const cross = moveLines(L(), 4, 4, 1, { ...o, groupFields: (t) => ({ z: t.z }), at: 0 })
    expect(cross[0].set).toMatchObject({ z: 2 }); expect(cross[0].set.ord).toBeLessThan(1)
    expect(moveLines(L(), 0, 0, -1, { ...o, at: 0 })).toBeNull()
  })
  it('duplicate makes copies with new ids beside the originals', () => {
    const put = duplicateLines(L(), 4, 4, 1, { group: o.group, at: 0, newId: (k) => `copy${k}` })
    expect(put).toHaveLength(1); expect(put[0]).toMatchObject({ id: 'copy0', set: { body: 'next' } }); expect(put[0].set.ord).toBeGreaterThan(5)
  })
  it('indent is capped one below the line above; outdent stops at 0', () => {
    const setDepth = (r, d) => ({ body: '  '.repeat(d) + r.body.trim() })
    expect(indentLines(L(), 1, 1, 1, { ...o, setDepth })).toBeNull() // child already one below parent
    expect(indentLines(L(), 4, 4, 1, { ...o, setDepth, blank: (r) => !r.body.trim() })).toEqual([{ id: 'n', set: { body: '  next' } }])
    expect(indentLines(L(), 0, 0, -1, { ...o, setDepth })).toBeNull()
  })
  it('select-all, find and ordBetween', () => {
    expect(selectAll(L(), (r) => r.body)).toEqual({ a: { id: 'p', off: 0 }, f: { id: 'o', off: 10 } })
    expect(findAll(L(), (r) => r.body, 'CHILD')).toEqual([{ id: 'c1', from: 2, to: 7 }, { id: 'c2', from: 2, to: 7 }])
    expect(ordBetween(1, 2)).toBe(1.5); expect(ordBetween(null, 1)).toBe(0); expect(ordBetween(3, null)).toBe(4)
  })
})

describe('decoration (lib/editor/decorate.js)', () => {
  const flat = (kids) => kids.map((k) => (typeof k === 'string' ? k : k.inert ? '' : k.text)).join('')
  const marks = (s) => { const m = /^(.*?)\*\*(.+?)\*\*(.*)$/.exec(s); return m ? [{ text: m[1], cls: [] }, { text: '**', cls: ['b'], marker: true }, { text: m[2], cls: ['b'] }, { text: '**', cls: ['b'], marker: true }, { text: m[3], cls: [] }].filter((t) => t.text) : [{ text: s, cls: [] }] }
  const tex = (s, d) => `<span class="k${d ? 'd' : ''}">${s}</span>`
  const line = 'a **b** `c` $x^2$ $5 and $10 [t](https://e.x/y) https://u.v/w.'
  it('the addressed text of every rendering is exactly the line (offsets never remap)', () => {
    for (const active of [true, false]) expect(flat(inline(line, { marks, tex, active }))).toBe(line)
  })
  it('scan: code, math by pandoc rules (money is text), links, bare urls without trailing punctuation', () => {
    expect(scan(line).filter((s) => s.kind !== 'text').map((s) => [s.kind, line.slice(s.from, s.to)])).toEqual([['code', '`c`'], ['math', '$x^2$'], ['link', '[t](https://e.x/y)'], ['url', 'https://u.v/w']])
    expect(scan('$$\\int x$$')[0].kind).toBe('dmath')
  })
  it('off the caret line syntax is hidden and math is inert html that puts the caret into its source; on it, source is faint', () => {
    const off = inline('see $x$', { tex })
    const deco = off.find((k) => k.inert && k.html)
    expect(deco).toMatchObject({ html: '<span class="k">x</span>', attrs: { 'data-action': 'caret:5' } })
    expect(off.find((k) => k.text === '$x$').cls).toContain('qk-hide')
    const on = inline('see $x$', { tex, active: true })
    expect(on.some((k) => k.inert)).toBe(false)
    expect(inline('a **b**', { marks }).filter((k) => k.cls?.includes('qk-hide')).map((k) => k.text)).toEqual(['**', '**'])
    expect(inline('$\\bad$', { tex: () => { throw new Error('parse') } }).some((k) => k.cls?.includes('qk-tex-err'))).toBe(true)
  })
  it('chips: [[kind:key|label]] is hidden source plus an inert pill that opens what the app says; plain text when the app does not know the kind', () => {
    const line = 'see [[doc:d123abc|my notes]] and [[nope:x|y]] [t](https://e.x)'
    expect(scan(line).filter((s) => s.kind === 'chip').map((s) => [line.slice(s.from, s.to), s.ref, s.key, line.slice(s.label[0], s.label[1])])).toEqual([['[[doc:d123abc|my notes]]', 'doc', 'd123abc', 'my notes'], ['[[nope:x|y]]', 'nope', 'x', 'y']])
    expect(scan(line).filter((s) => s.kind === 'link')).toHaveLength(1)
    const chip = (k, key) => (k === 'doc' ? { href: `/doc/${key}` } : null)
    for (const active of [true, false]) for (const hook of [chip, null]) expect(flat(inline(line, { active, chip: hook }))).toBe(line)
    const off = inline(line, { chip })
    const pill = off.filter((k) => /^qk-chip qk-chip-doc/.test(k.cls || ''))
    expect(pill).toHaveLength(1)
    expect(pill[0]).toMatchObject({ cls: 'qk-chip qk-chip-doc', inert: true, attrs: { 'data-action': 'open:/doc/d123abc', role: 'link', title: 'my notes' } })
    expect(pill[0].children.map((c) => [c.cls, c.text])).toEqual([['qk-chip-name', 'my notes'], ['qk-chip-kind', 'doc']]) // no ext from the hook: one target
    expect(off.find((k) => k.text === '[[doc:d123abc|my notes]]').cls).toContain('qk-hide')
    expect(off.filter((k) => typeof k === 'string').join('')).toContain('[[nope:x|y]]') // unknown kind: plain text, not a dead chip
    expect(inline(line, { chip, active: true }).some((k) => /qk-chip /.test(k.cls || ''))).toBe(false) // on the caret's line the source is shown
    expect(inline(line).some((k) => /qk-chip /.test(k.cls || ''))).toBe(false) // no hook: nothing is drawn as a chip
    expect(scan('[[doc:a|b\nc]] [[Doc:a|b]] [[doc:|b]]').some((s) => s.kind === 'chip')).toBe(false)
  })
  it('chips: a chip alone on its line is a block card (qk-chip-block), inline in text it is not; a kind class; an optional ext target is a second action', () => {
    const chip = (k, key) => (k === 'doc' ? { href: `/doc/${key}`, ext: `/share/${key}/open` } : k === 'pin' ? { href: `/pin/${key}` } : null)
    const card = (t) => inline(t, { chip }).find((k) => /qk-chip /.test(k.cls || ''))
    expect(card('[[doc:abc|solo]]').cls).toBe('qk-chip qk-chip-doc qk-chip-block')
    expect(card('  [[doc:abc|solo]]  ').cls).toContain('qk-chip-block') // only whitespace around it
    expect(card('see [[doc:abc|inline]] here').cls).toBe('qk-chip qk-chip-doc')
    expect(card('[[doc:abc|a]] [[doc:abd|b]]').cls).toBe('qk-chip qk-chip-doc') // two chips: neither is alone
    expect(card('[[pin:abc|p]]').cls).toBe('qk-chip qk-chip-pin qk-chip-block') // the kind is the class; the kit styles nothing
    const ext = card('[[doc:abc|solo]]').children.find((c) => c.cls === 'qk-chip-ext')
    expect(ext).toMatchObject({ inert: true, editable: false, attrs: { 'data-action': 'open:/share/abc/open', role: 'link' } }) // its own action, apart from the card's open:/doc/abc
    expect(card('[[pin:abc|p]]').children.some((c) => c.cls === 'qk-chip-ext')).toBe(false)
    expect(flat(inline('x [[doc:abc|solo]] y', { chip }))).toBe('x [[doc:abc|solo]] y') // the addressed text is still exactly the line
  })
  it('an overlay wraps exactly its range', () => {
    const kids = inline('find me here', { overlay: { from: 5, to: 7, cls: 'hit' } })
    expect(kids.filter((k) => k.cls === 'hit').map((k) => k.text)).toEqual(['me'])
  })
  it('memo calls the renderer once per input', () => {
    let n = 0; const f = memo((a) => { n++; return a + 1 })
    f(1); f(1); f(2); expect(n).toBe(2)
  })
})

describe('push-then-pull (lib/engine/push.js)', () => {
  function fakeEs() { const all = []; return { all, Impl: class { constructor(u) { this.url = u; all.push(this) } close() { this.closed = true } } } }
  function clock() { const ts = []; return { ts, set: (f, ms) => { const t = { f, ms }; ts.push(t); return t }, clear: (t) => { t.dead = true }, fire() { const t = ts.filter((x) => !x.dead).at(-1); t.dead = true; t.f() } } }
  it('a push pulls; pushes during a pull coalesce into one more; the poll is fast while down and slow while up', async () => {
    const es = fakeEs(), c = clock(); let pulls = 0, release
    const pp = pushPull({ url: '/ev', pull: () => { pulls++; return new Promise((ok) => { release = ok }) }, EventSourceImpl: es.Impl, setTimer: c.set, clearTimer: c.clear, fallbackMs: 5, liveMs: 60 })
    expect(c.ts.at(-1).ms).toBe(5)
    es.all[0].onopen(); expect(c.ts.filter((t) => !t.dead).at(-1).ms).toBe(60); expect(pulls).toBe(1)
    es.all[0].onmessage({}); es.all[0].onmessage({}); expect(pulls).toBe(1)
    release(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(pulls).toBe(2); release(); await Promise.resolve(); await Promise.resolve()
    es.all[0].onerror(); expect(c.ts.filter((t) => !t.dead).at(-1).ms).toBe(5)
    c.fire(); expect(pulls).toBe(3)
    pp.stop(); expect(es.all[0].closed).toBe(true)
  })
  it('without EventSource it polls', async () => {
    const c = clock(); let pulls = 0
    pushPull({ url: '/ev', pull: () => { pulls++ }, EventSourceImpl: null, setTimer: c.set, clearTimer: c.clear, fallbackMs: 7 })
    c.fire(); await Promise.resolve(); await Promise.resolve(); c.fire(); await Promise.resolve(); expect(pulls).toBe(2); expect(c.ts.at(-1).ms).toBe(7)
  })
})
