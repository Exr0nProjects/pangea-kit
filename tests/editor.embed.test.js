// Embeds (lib/editor/embed.js; PANGEA3-DESIGN §15 "Embeds: live transclusion", the owner 2026-11-11 21:57 PST: "a thin rectangle
// aronud the text, but the text should still appear and i want to be able to edit it within zai direclty"; 21:58: "the header
// should have the doc name, a collapse button, expand which opens it as a modal ..., and then a open-link button"). A host
// editor draws an inert slot item after the row that holds the chip; the slot's body is a SECOND editor over the embedded
// doc. Here, in jsdom: the pure helpers; the absolute embed actions; and a mounted host with a mounted embedded editor:
// the two render maps never mix, events inside the body are the inner editor's, the body survives a re-render (adopt),
// collapse unmounts it, expand opens the SAME doc in a modal, Esc closes it, a read-only host refuses a resize.
import { describe, expect, it } from 'vitest'
import { createEditor, memoryLines, initState, step, modelRun, READ_ONLY, lineOf } from '../lib/editor/editor.js'
import { createEmbeds, embedSlot, embedPlan, clampH, parseEmbedLabel, withHeight, withMode, inEmbedBody, MIN_H, MAX_H, MAX_DEPTH } from '../lib/editor/embed.js'

describe('embed helpers (pure)', () => {
  it('a height is whole px in [MIN_H, MAX_H]; junk is null', () => {
    expect(clampH(10)).toBe(MIN_H); expect(clampH(99999)).toBe(MAX_H); expect(clampH(200.4)).toBe(200); expect(clampH('x')).toBeNull(); expect(clampH(NaN)).toBeNull()
  })
  it('the chip label carries the height after a bar: parse, set, remove, and a bar in a title is kept', () => {
    expect(parseEmbedLabel('trip plan|h=240')).toEqual({ title: 'trip plan', h: 240, fit: false, mode: 'window' })
    expect(parseEmbedLabel('trip plan')).toEqual({ title: 'trip plan', h: null, fit: false, mode: 'full' })
    expect(parseEmbedLabel('a|b|h=100')).toEqual({ title: 'a|b', h: 100, fit: false, mode: 'window' })
    expect(parseEmbedLabel('x|h=5')).toEqual({ title: 'x|h=5', h: null, fit: false, mode: 'full' })   // under two digits is not a height
    expect(withHeight('trip plan', 300)).toBe('trip plan|h=300'); expect(withHeight('trip plan|h=300', 500)).toBe('trip plan|h=500'); expect(withHeight('t|h=300', null)).toBe('t')
  })
  it('the mode is the chip\'s text: a height alone is a window, none (the default) is full, |fit is full that keeps the height behind it', () => {
    expect(parseEmbedLabel('trip plan|h=240|fit')).toEqual({ title: 'trip plan', h: 240, fit: true, mode: 'full' })
    expect(parseEmbedLabel('trip plan|fit')).toEqual({ title: 'trip plan', h: null, fit: true, mode: 'full' })
    expect(parseEmbedLabel('a|fit|b')).toEqual({ title: 'a|fit|b', h: null, fit: false, mode: 'full' })   // only a trailing flag counts
    expect(withMode('trip plan|h=240', 'full')).toBe('trip plan|h=240|fit'); expect(withMode('trip plan', 'full')).toBe('trip plan')
    expect(withMode('trip plan|h=240|fit', 'window')).toBe('trip plan|h=240'); expect(withMode('t', 'window', 300)).toBe('t|h=300'); expect(withMode('t', 'window')).toBe('t|h=240'); expect(withMode('t', 'window', 5)).toBe('t|h=72')
    expect(withMode('t|h=100', 'window', 500)).toBe('t|h=100'); expect(withMode('t|h=100', 'nope')).toBe('t|h=100')
    expect(withHeight('trip plan|h=240|fit', 300)).toBe('trip plan|h=300|fit'); expect(withHeight('t|fit', 120)).toBe('t|h=120|fit')
  })
  it('a doc may not sit inside itself, inside a cycle, or deeper than three levels', () => {
    expect(embedPlan([], 'a')).toEqual({ ok: true })
    expect(embedPlan(['a'], 'a')).toEqual({ ok: false, placeholder: 'cycle' })
    expect(embedPlan(['a', 'b'], 'a')).toEqual({ ok: false, placeholder: 'cycle' })     // A embeds B embeds A
    expect(embedPlan(['a', 'b'], 'c')).toEqual({ ok: true })
    expect(embedPlan(Array.from({ length: MAX_DEPTH }, (_, i) => `d${i}`), 'z')).toEqual({ ok: false, placeholder: 'deep' })
    expect(embedPlan(['a', 'b'], 'c', 2)).toEqual({ ok: false, placeholder: 'deep' })
    expect(embedPlan(['page', 'a', 'b'], 'c', MAX_DEPTH, 2)).toEqual({ ok: true })           // the host document is in the chain (cycles) but is not a level
    expect(embedPlan(['page', 'a', 'b', 'c'], 'd', MAX_DEPTH, 3)).toEqual({ ok: false, placeholder: 'deep' })
  })
  it('the slot vnode: an outset root holding the box (title row: the fold caret just inside the box first, then the title, the tools on the right; the body; the grip row in window mode)', () => {
    const v = embedSlot('emb:r1', { id: 'd1', title: 'trip plan', h: 240, mode: 'window', href: '/doc/d1' })
    expect(v.inert).toBe(true); expect(v.adopt).toBe('.qk-embed-body'); expect(v.attrs.style).toBe('height:240px'); expect(v.attrs['data-qk-embed']).toBe('emb:r1'); expect(v.attrs['data-embed-mode']).toBe('window')
    expect(v.stable).toBe(true)                                                                 // a change is patched in place (editor.js patchStable), never a new toolbar
    expect(v.children).toHaveLength(1); const [box] = v.children
    const [head, body, grip] = box.children
    expect(head.children[0].attrs['data-action']).toBe('embed:collapse')                          // the fold caret is the title row's first child, inside the box (The owner 2026-11-12 18:54 PST)
    expect(box.cls).toBe('qk-embed-box'); expect(head.children[1].text).toBe('trip plan')
    expect(head.children[2].children.map((b) => b.attrs['data-action'])).toEqual(['embed:window', 'embed:full', 'embed:fullscreen', 'open:/doc/d1'])
    expect(head.children[2].children.map((b) => b.attrs['aria-pressed'])).toEqual(['true', 'false', undefined, undefined])
    expect(body.attrs['data-qk-embed-body']).toBe(''); expect(body.children).toBeUndefined()
    expect(grip.cls).toBe('qk-embed-grip'); expect(grip.attrs).toHaveProperty('data-qk-embed-grip'); expect(box.children.length).toBe(3)
    const c = embedSlot('emb:r1', { id: 'd1', title: 't', h: 240, mode: 'window', collapsed: true }); expect(c.attrs.style).toBe(''); expect(c.children[0].children.length).toBe(2)   // no grip, no height while collapsed
    const f = embedSlot('emb:r1', { id: 'd1', title: 't' }); expect(f.attrs.style).toBe(''); expect(f.cls).toContain('mode-full'); expect(f.children[0].children.length).toBe(2)   // the default is full: no height, no grip
    expect(f.children[0].children[0].children[2].children.map((b) => b.attrs['aria-pressed'])).toEqual(['false', 'true', undefined])
    expect(embedSlot('emb:r1', { id: 'd1', title: 't', h: 240, href: null }).children[0].children[0].children[2].children.length).toBe(3)
  })
})

const hostApp = (opts = {}) => ({
  textOf: (r) => r.body, estimate: (it) => (it.embed ? 200 : 20),
  items: (doc, state) => doc.lines().flatMap((r) => { const m = /^\[\[doc:([a-z0-9]+)\|(.*)\]\]$/.exec(r.body); const base = { ...r, key: r.id, addr: r.id }; return m ? [base, { key: `emb:${r.id}`, embed: { id: m[1], title: parseEmbedLabel(m[2]).title, h: parseEmbedLabel(m[2]).h, mode: parseEmbedLabel(m[2]).mode, collapsed: Boolean(state.embeds[`emb:${r.id}`]?.collapsed), href: `/doc/${m[1]}` } }] : [base] }),
  render: (it) => (it.embed ? embedSlot(it.key, it.embed) : { tag: 'div', addr: it.id, children: it.body ? [it.body] : [{ tag: 'br' }] }),
  embedPuts: opts.noResize ? undefined : (row, patch) => { const m = /^\[\[doc:([a-z0-9]+)\|(.*)\]\]$/.exec(row.body); return m ? [{ id: row.id, set: { body: `[[doc:${m[1]}|${patch.mode ? withMode(m[2], patch.mode, patch.h) : withHeight(m[2], patch.h)}]]` } }] : null },
  reduce(state, a, ctx) { if (a.type !== 'input' || !a.sel) return null; const r = ctx.get(a.sel.a.id), off = a.sel.a.off; return a.inputType === 'insertText' ? { puts: [{ id: r.id, set: { body: r.body.slice(0, off) + a.text + r.body.slice(off) } }], sel: { a: { id: r.id, off: off + a.text.length }, f: { id: r.id, off: off + a.text.length } } } : null },
})
const innerApp = { ...hostApp(), items: (doc) => doc.lines().map((r) => ({ ...r, key: r.id, addr: r.id })), render: (it) => ({ tag: 'div', addr: it.id, children: it.body ? [it.body] : [{ tag: 'br' }] }) }
const at = (id, off) => ({ a: { id, off }, f: { id, off } })
const rows = () => [{ id: 'r0', body: 'above', ord: 1 }, { id: 'r1', body: '[[doc:d1|trip plan|h=200]]', ord: 2 }, { id: 'r2', body: 'below', ord: 3 }]

/** A host with one embed whose doc `inner` is mounted by `resolve`; returns the pieces. */
function mounted({ readOnly = false, noResize = false, bare = false, IO = null } = {}) {
  document.body.innerHTML = '<div id="s" style="height:600px"><div id="d" contenteditable="true"></div></div>'
  const inner = memoryLines([{ id: 'x1', body: 'first inner line', ord: 1 }, { id: 'x2', body: 'second inner line', ord: 2 }])
  const mounts = [], renames = [], titleSubs = new Set(), titleNow = { t: 'trip plan' }, failRename = { on: false }
  const embeds = createEmbeds({ IO, resolve: async (ctx) => ({ mount(body) {
    body.innerHTML = '<div class="inner-s"><div class="inner-r" contenteditable="true"></div></div>'
    const ed = createEditor({ root: body.querySelector('.inner-r'), scroller: body.querySelector('.inner-s'), app: innerApp, doc: inner, contract: { name: `inner-${mounts.length}`, actions: [] }, dev: true, onEdge: ctx.onEdge })
    const h = { ed, ctx, disposed: false, renames: renames, canRename: () => true, title: () => titleNow.t, onTitle: (f) => { titleSubs.add(f); return () => titleSubs.delete(f) }, rename: async (t) => { renames.push(t); if (failRename.on) throw new Error('refused'); titleNow.t = t; return t }, focus: (w) => { ed.focus(); ed.dispatch({ type: 'select', sel: at('x1', w === 'end' ? 0 : 0) }) }, dispose() { h.disposed = true; ed.dispose() } }
    mounts.push(h); return h
  } }) })
  let t = 1e12
  const hostDoc = memoryLines(bare ? rows().map((r) => (r.id === 'r1' ? { ...r, body: '[[doc:d1|trip plan]]' } : r)) : rows())
  const host = createEditor({ root: document.getElementById('d'), scroller: document.getElementById('s'), app: hostApp({ noResize }), doc: hostDoc, contract: { name: 'embed-host', actions: [] }, dev: true, readOnly, embeds, clock: () => (t += 10) })
  host.doc = hostDoc
  return { host, embeds, inner, mounts, renames, titleSubs, titleNow, failRename, root: document.getElementById('d') }
}
const settle = () => new Promise((r) => setTimeout(r, 20))

describe('the embed actions (absolute, through the one reducer)', () => {
  it('collapse, modal and focus are absolute view state; a repeat is the same state; junk is a no-op', () => {
    const app = hostApp(), doc = memoryLines(rows()), st = initState(app)
    step(app, doc, st, { type: 'embed', op: 'collapse', key: 'emb:r1', on: true, at: 1 })
    expect(st.embeds).toEqual({ 'emb:r1': { collapsed: true } })
    const again = st.embeds; step(app, doc, st, { type: 'embed', op: 'collapse', key: 'emb:r1', on: true, at: 1 }); expect(st.embeds).toBe(again)
    step(app, doc, st, { type: 'embed', op: 'modal', key: 'emb:r1', at: 1 }); expect(st.modal).toBe('emb:r1')
    step(app, doc, st, { type: 'embed', op: 'modal', key: null, at: 1 }); expect(st.modal).toBeNull()
    step(app, doc, st, { type: 'embed', op: 'focus', key: 'emb:r1', at: 1 }); expect(st.embedFocus).toBe('emb:r1')
    step(app, doc, st, { type: 'embed', op: 'collapse', key: 'emb:r1', on: false, at: 1 }); expect(st.embeds['emb:r1'].collapsed).toBe(false)
    const snap = JSON.stringify(st)
    for (const j of [{ op: 'collapse', key: 5, on: true }, { op: 'collapse', key: 'k' }, { op: 'modal', key: 7 }, { op: 'focus', key: {} }, { op: 'nope', key: 'k' }, {}]) step(app, doc, st, { type: 'embed', ...j, at: 1 })
    expect(JSON.stringify({ ...st, rev: 0 })).toBe(JSON.stringify({ ...JSON.parse(snap), rev: 0 }))
  })
  it('a collapsing embed that had the focus gives it up', () => {
    const app = hostApp(), doc = memoryLines(rows()), st = initState(app)
    step(app, doc, st, { type: 'embed', op: 'focus', key: 'emb:r1', at: 1 }); step(app, doc, st, { type: 'embed', op: 'collapse', key: 'emb:r1', on: true, at: 1 })
    expect(st.embedFocus).toBeNull()
  })
  it('resize rewrites the chip source through app.embedPuts (an absolute value), idempotent by intent; clamped', () => {
    const { doc, state } = modelRun(hostApp(), rows(), [{ id: 'z1', type: 'embed', op: 'resize', key: 'emb:r1', h: 333.4, at: 1 }, { id: 'z1', type: 'embed', op: 'resize', key: 'emb:r1', h: 333.4, at: 1 }])
    expect(doc.get('r1').body).toBe('[[doc:d1|trip plan|h=333]]'); expect(state.notice).toBeNull()
    expect(modelRun(hostApp(), rows(), [{ id: 'z2', type: 'embed', op: 'resize', key: 'emb:r1', h: 5, at: 1 }]).doc.get('r1').body).toBe(`[[doc:d1|trip plan|h=${MIN_H}]]`)
    expect(modelRun(hostApp(), rows(), [{ id: 'z3', type: 'embed', op: 'resize', key: 'emb:r0', h: 300, at: 1 }]).doc.get('r0').body).toBe('above')   // not a chip row: nothing
    expect(modelRun(hostApp(), rows(), [{ id: 'z4', type: 'embed', op: 'resize', key: 'emb:gone', h: 300, at: 1 }]).doc.get('r1').body).toBe('[[doc:d1|trip plan|h=200]]')
  })
  it('a read-only host refuses a resize with the notice, and the doc is untouched; planted: without readOnly it writes', () => {
    const doc = memoryLines(rows()), st = initState(hostApp())
    step(hostApp(), doc, st, { id: 'z5', type: 'embed', op: 'resize', key: 'emb:r1', h: 400, at: 1 }, { readOnly: true })
    expect(st.notice).toEqual({ code: READ_ONLY, type: 'embed', id: 'z5' }); expect(doc.get('r1').body).toBe('[[doc:d1|trip plan|h=200]]')
    step(hostApp(), doc, st, { id: 'z6', type: 'embed', op: 'resize', key: 'emb:r1', h: 400, at: 2 })
    expect(doc.get('r1').body).toBe('[[doc:d1|trip plan|h=400]]')
  })
})

describe('the grip drag and fit are absolute actions', () => {
  it('drag is view state (a preview, never a document write); a repeat is the same state; null ends it; junk is a no-op', () => {
    const app = hostApp(), doc = memoryLines(rows()), st = initState(app)
    step(app, doc, st, { type: 'embed', op: 'drag', key: 'emb:r1', h: 300, at: 1 }); expect(st.embedDrag).toEqual({ key: 'emb:r1', h: 300 })
    const again = st.embedDrag; step(app, doc, st, { type: 'embed', op: 'drag', key: 'emb:r1', h: 300, at: 1 }); expect(st.embedDrag).toBe(again)
    step(app, doc, st, { type: 'embed', op: 'drag', key: 'emb:r1', h: 5, at: 2 }); expect(st.embedDrag).toEqual({ key: 'emb:r1', h: MIN_H })   // clamped like a chip height
    expect(doc.get('r1').body).toBe('[[doc:d1|trip plan|h=200]]')
    step(app, doc, st, { type: 'embed', op: 'drag', key: null, at: 3 }); expect(st.embedDrag).toBeNull()
    for (const j of [{ key: 5, h: 100 }, { key: 'k', h: 'x' }, { key: 'k' }]) step(app, doc, st, { type: 'embed', op: 'drag', ...j, at: 4 })
    expect(st.embedDrag).toBeNull()
  })
  it('mode rewrites the chip through app.embedPuts (an absolute value, idempotent): full keeps the height behind |fit, window restores it or takes the given one; refused read-only; junk is a no-op', () => {
    const r = modelRun(hostApp(), rows(), [{ id: 'f1', type: 'embed', op: 'mode', key: 'emb:r1', mode: 'full', at: 1 }, { id: 'f1', type: 'embed', op: 'mode', key: 'emb:r1', mode: 'full', at: 1 }])
    expect(r.doc.get('r1').body).toBe('[[doc:d1|trip plan|h=200|fit]]')
    const back = modelRun(hostApp(), rows(), [{ id: 'f2', type: 'embed', op: 'mode', key: 'emb:r1', mode: 'full', at: 1 }, { id: 'f3', type: 'embed', op: 'mode', key: 'emb:r1', mode: 'window', at: 2 }])
    expect(back.doc.get('r1').body).toBe('[[doc:d1|trip plan|h=200]]')
    const bare = [{ id: 'r1', body: '[[doc:d1|trip plan]]', ord: 1 }]
    expect(modelRun(hostApp(), bare, [{ id: 'f4', type: 'embed', op: 'mode', key: 'emb:r1', mode: 'window', h: 310, at: 1 }]).doc.get('r1').body).toBe('[[doc:d1|trip plan|h=310]]')
    expect(modelRun(hostApp(), bare, [{ id: 'f5', type: 'embed', op: 'mode', key: 'emb:r1', mode: 'full', at: 1 }]).doc.get('r1').body).toBe('[[doc:d1|trip plan]]')
    for (const j of [{ mode: 'yes' }, { mode: null }, {}]) expect(modelRun(hostApp(), rows(), [{ id: 'f6', type: 'embed', op: 'mode', key: 'emb:r1', ...j, at: 1 }]).doc.get('r1').body).toBe('[[doc:d1|trip plan|h=200]]')
    const doc = memoryLines(rows()), st = initState(hostApp())
    step(hostApp(), doc, st, { id: 'f7', type: 'embed', op: 'mode', key: 'emb:r1', mode: 'full', at: 1 }, { readOnly: true })
    expect(st.notice).toEqual({ code: READ_ONLY, type: 'embed', id: 'f7' }); expect(doc.get('r1').body).toBe('[[doc:d1|trip plan|h=200]]')
  })
})

describe('the live title and its inline editor (state.embeds[key].title, state.embedTitleEdit)', () => {
  it('title is absolute view state shown by the header; null clears it; junk and an empty title are no-ops; title-edit names the one embed being edited', () => {
    const app = hostApp(), doc = memoryLines(rows()), st = initState(app)
    step(app, doc, st, { type: 'embed', op: 'title', key: 'emb:r1', title: '  new   name ', at: 1 }); expect(st.embeds['emb:r1'].title).toBe('new name')
    const same = st.embeds; step(app, doc, st, { type: 'embed', op: 'title', key: 'emb:r1', title: 'new name', at: 2 }); expect(st.embeds).toBe(same)
    step(app, doc, st, { type: 'embed', op: 'collapse', key: 'emb:r1', on: true, at: 3 }); expect(st.embeds['emb:r1']).toEqual({ title: 'new name', collapsed: true })   // independent keys
    for (const j of [{ title: '' }, { title: 5 }, { title: undefined }, { key: 7, title: 'x' }]) step(app, doc, st, { type: 'embed', op: 'title', key: 'emb:r1', ...j, at: 4 })
    expect(st.embeds['emb:r1'].title).toBe('new name')
    step(app, doc, st, { type: 'embed', op: 'title', key: 'emb:r1', title: null, at: 5 }); expect(st.embeds['emb:r1'].title).toBeNull()
    step(app, doc, st, { type: 'embed', op: 'title-edit', key: 'emb:r1', at: 6 }); expect(st.embedTitleEdit).toBe('emb:r1')
    step(app, doc, st, { type: 'embed', op: 'title-edit', key: null, at: 7 }); expect(st.embedTitleEdit).toBeNull()
    step(app, doc, st, { type: 'embed', op: 'title-edit', key: 9, at: 8 }); expect(st.embedTitleEdit).toBeNull()
    expect(doc.get('r1').body).toBe('[[doc:d1|trip plan|h=200]]')                       // a title is never a document write
  })
  it('a press on the name opens the editor over it; Enter renames through the mounted doc and the header shows it at once; Esc cancels; an unchanged title renames nothing', async () => {
    const { host, root, renames, mounts } = mounted(); await settle()
    const press = () => root.querySelector('.qk-embed-name').dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), { button: 0 }))
    press(); expect(host.state.embedTitleEdit).toBe('emb:r1')
    let input = document.querySelector('[data-qk-title-input]'); expect(input).toBeTruthy(); expect(document.querySelector('[data-qk-title-overlay]').parentElement).toBe(document.body)
    expect(root.querySelector('.qk-embed-name').querySelector('input')).toBeNull()      // the host's DOM is untouched: the editor floats outside it
    input.value = 'a better name'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await settle()
    expect(renames).toEqual(['a better name']); expect(host.state.embeds['emb:r1'].title).toBe('a better name'); expect(host.state.embedTitleEdit).toBeNull()
    expect(root.querySelector('.qk-embed-name').textContent).toBe('a better name'); expect(document.querySelector('[data-qk-title-input]')).toBeNull()
    expect(host.doc.get('r1').body).toBe('[[doc:d1|trip plan|h=200]]'); expect(host.checks.mutations()).toBeNull()
    press(); input = document.querySelector('[data-qk-title-input]'); input.value = 'discard me'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await settle()
    expect(renames.length).toBe(1); expect(root.querySelector('.qk-embed-name').textContent).toBe('a better name')
    press(); input = document.querySelector('[data-qk-title-input]'); input.dispatchEvent(new Event('blur')); await settle()   // blur saves, and the value is unchanged: nothing is sent
    expect(renames.length).toBe(1); expect(host.state.embedTitleEdit).toBeNull(); expect(mounts.length).toBe(1)
    host.dispose()
  })
  it('a refused rename puts the previous title back; a title pushed by the doc\'s session is shown; a doc that cannot be renamed opens no editor', async () => {
    const m = mounted(); await settle()
    m.failRename.on = true
    m.root.querySelector('.qk-embed-name').dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), { button: 0 }))
    const input = document.querySelector('[data-qk-title-input]'); input.value = 'nope'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await settle()
    expect(m.host.state.embeds['emb:r1'].title).toBe('trip plan'); expect(m.root.querySelector('.qk-embed-name').textContent).toBe('trip plan')
    for (const f of m.titleSubs) f('renamed elsewhere'); await settle()                  // the doc's session heard a rename (push)
    expect(m.host.state.embeds['emb:r1'].title).toBe('renamed elsewhere'); expect(m.root.querySelector('.qk-embed-name').textContent).toBe('renamed elsewhere')
    m.mounts[0].canRename = () => false
    m.root.querySelector('.qk-embed-name').dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), { button: 0 }))
    expect(m.host.state.embedTitleEdit).toBeNull(); expect(document.querySelector('[data-qk-title-input]')).toBeNull()
    m.host.dispose()
  })
})

describe('a host with a live embedded editor', () => {
  it('draws the rectangle, mounts the embedded editor in its body; the two render maps never mix', async () => {
    const { host, root, mounts } = mounted(); await settle()
    const slot = root.querySelector('[data-qk-embed="emb:r1"]'); expect(slot).toBeTruthy()
    expect(slot.querySelector('.qk-embed-name').textContent).toBe('trip plan')
    expect(mounts.length).toBe(1)
    const line = root.querySelector('[data-qk-embed-body] [data-addr="x1"]'); expect(line.textContent).toBe('first inner line')
    expect(lineOf(root, line)).toBeNull()                             // the host does not own the embedded line
    expect(lineOf(mounts[0].ed.root, line)).toBe(line)                // the embedded editor does
    expect(host.addrAtPoint).toBeTypeOf('function')
    expect(host.checks.freshDiff()).toBeNull(); expect(host.checks.unaddressed()).toBeNull(); expect(host.checks.mutations()).toBeNull()
    expect(inEmbedBody(root, line)).toBe(true); expect(inEmbedBody(root, root.querySelector('[data-addr="r0"]'))).toBe(false)
    host.dispose()
  })
  it('keys and input inside the body are the embedded editor\'s: the host log and doc do not change; the embedded doc does', async () => {
    const { host, root, mounts, inner } = mounted(); await settle()
    host.dispatch({ type: 'select', sel: at('r0', 2) })              // the host has a caret: an event that wrongly reached it would write there
    const n = host.log.length, ed = mounts[0].ed
    const line = root.querySelector('[data-qk-embed-body] [data-addr="x1"]')
    line.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    const bi = new InputEvent('beforeinput', { inputType: 'insertText', data: 'Z', bubbles: true, cancelable: true }); line.firstChild.dispatchEvent(bi)
    expect(host.log.length).toBe(n); expect(host.state.focus).toBe(false); expect(host.state.sel.f).toEqual({ id: 'r0', off: 2 })
    expect(root.querySelector('[data-addr="r0"]').textContent).toBe('above')
    ed.dispatch({ type: 'select', sel: at('x1', 5) }); ed.dispatch({ type: 'input', inputType: 'insertText', text: '!', sel: at('x1', 5) })
    expect(inner.get('x1').body).toBe('first! inner line')
    expect(host.log.length).toBe(n)
    expect(host.checks.freshDiff()).toBeNull(); expect(host.checks.mutations()).toBeNull()
    host.dispose()
  })
  it('the slot is patched in place for a new height or mode (stable): the same slot, toolbar and body nodes, the same editor; a vnode that is not stable is still replaced with its body adopted', async () => {
    const { host, root, mounts } = mounted(); await settle()
    const body = root.querySelector('[data-qk-embed-body]'), slot = root.querySelector('[data-qk-embed]'), tools = root.querySelector('.qk-embed-btns'), head = root.querySelector('.qk-embed-head')
    host.dispatch({ type: 'embed', op: 'resize', key: 'emb:r1', h: 260 })
    const slot2 = root.querySelector('[data-qk-embed]')
    expect(slot2).toBe(slot); expect(root.querySelector('.qk-embed-btns')).toBe(tools); expect(root.querySelector('.qk-embed-head')).toBe(head); expect(slot2.style.height).toBe('260px')
    expect(root.querySelector('[data-qk-embed-body]')).toBe(body); expect(mounts.length).toBe(1); expect(mounts[0].disposed).toBe(false)
    expect(host.checks.freshDiff()).toBeNull()
    host.dispose()
  })
  it('a mode change patches the toolbar in place: the same caret, title and tool nodes, aria-pressed and the grip follow the mode (The owner 2026-11-12 18:53 PST: the menu bar flashed)', async () => {
    const { host, root } = mounted(); await settle()
    const nodes = () => ['.qk-embed-collapse', '.qk-embed-name', '.qk-embed-btns', '.qk-embed-window', '.qk-embed-full', '.qk-embed-box'].map((q) => root.querySelector(q))
    const before = nodes(), pressed = () => [root.querySelector('.qk-embed-window'), root.querySelector('.qk-embed-full')].map((b) => b.getAttribute('aria-pressed'))
    const mode0 = root.querySelector('[data-qk-embed]').getAttribute('data-embed-mode')
    host.dispatch({ type: 'embed', op: 'mode', key: 'emb:r1', mode: mode0 === 'window' ? 'full' : 'window', h: 240 })
    expect(root.querySelector('[data-qk-embed]').getAttribute('data-embed-mode')).not.toBe(mode0)
    nodes().forEach((n, i) => expect(n, `node ${i} was rebuilt`).toBe(before[i]))
    expect(pressed()).toEqual(mode0 === 'window' ? ['false', 'true'] : ['true', 'false']); expect(!!root.querySelector('.qk-embed-grip')).toBe(mode0 !== 'window')
    expect(host.checks.freshDiff()).toBeNull()
    host.dispose()
  })
  it('collapse (the header button) is one absolute action: the body is unmounted, the header stays; expanding mounts it again', async () => {
    const { host, root, mounts } = mounted(); await settle()
    const btn = root.querySelector('.qk-embed-collapse')
    btn.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    expect(host.state.embeds['emb:r1'].collapsed).toBe(true)
    expect(root.querySelector('[data-qk-embed].collapsed')).toBeTruthy(); expect(root.querySelector('.qk-embed-head')).toBeTruthy()
    expect(mounts[0].disposed).toBe(true); expect(root.querySelector('[data-qk-embed-body]').children.length).toBe(0)
    root.querySelector('.qk-embed-collapse').dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true })); await settle()
    expect(host.state.embeds['emb:r1'].collapsed).toBe(false); expect(mounts.length).toBe(2); expect(root.querySelector('[data-qk-embed-body] [data-addr="x1"]')).toBeTruthy()
    host.dispose()
  })
  it('with an IntersectionObserver (a real browser) expanding a collapsed embed mounts its editor again: the slot element is patched in place now, so the observer never fires a second time', async () => {
    const watchers = []
    class FakeIO { constructor(cb) { this.cb = cb; watchers.push(this) } observe(el) { this.el = el; this.cb([{ isIntersecting: true, target: el }]) } disconnect() {} }
    const { host, root, mounts } = mounted({ IO: FakeIO }); await settle()
    expect(mounts.length).toBe(1)
    const slot = root.querySelector('[data-qk-embed]')
    root.querySelector('.qk-embed-collapse').dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true })); await settle()
    expect(mounts[0].disposed).toBe(true)
    root.querySelector('.qk-embed-collapse').dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true })); await settle()
    expect(root.querySelector('[data-qk-embed]')).toBe(slot)                                       // patched, not replaced: the observer has nothing new to say
    expect(mounts.length).toBe(2); expect(root.querySelector('[data-qk-embed-body] [data-addr="x1"]')).toBeTruthy()
    host.dispose()
  })
  it('fullscreen opens the same doc as a full-page lightbox (the overlay is the editor\'s scroller; state.modal, its own editor over the same rows); an edit there shows inline; Esc closes it', async () => {
    const { host, root, mounts, inner } = mounted(); await settle()
    root.querySelector('.qk-embed-fullscreen').dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true })); await settle()
    expect(host.state.modal).toBe('emb:r1')
    const modal = document.querySelector('.qk-embed-modal'); expect(modal).toBeTruthy(); expect(modal.querySelector('.qk-embed-name').textContent).toBe('trip plan')
    expect(modal.querySelector('.qk-embed-modal-card')).toBeNull(); expect(mounts[1].ctx.modal).toBe(true); expect(mounts[1].ctx.scroller).toBe(modal)   // no card: the overlay itself scrolls
    expect(mounts.length).toBe(2)
    const big = mounts[1].ed; big.dispatch({ type: 'select', sel: at('x2', 0) }); big.dispatch({ type: 'input', inputType: 'insertText', text: 'NEW ', sel: at('x2', 0) })
    expect(inner.get('x2').body).toBe('NEW second inner line')
    mounts[0].ed.dispatch({ type: 'remote' }); await settle()
    expect(root.querySelector('[data-qk-embed-body] [data-addr="x2"]').textContent).toBe('NEW second inner line')   // the same doc, live, not a copy
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(host.state.modal).toBeNull(); expect(document.querySelector('.qk-embed-modal')).toBeNull(); expect(mounts[1].disposed).toBe(true)
    host.dispose()
  })
  it('the mode buttons are absolute actions resolved against the chip: full adds |fit (no height, no grip, same live editor); window restores the stored height and the grip; a chip with no height starts a window at the drawn height', async () => {
    const { host, root } = mounted(); await settle()
    const press = (sel) => root.querySelector(sel).dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    press('.qk-embed-full')
    expect(host.doc.get('r1').body).toBe('[[doc:d1|trip plan|h=200|fit]]')
    let slot = root.querySelector('[data-qk-embed]'); expect(slot.classList.contains('mode-full')).toBe(true); expect(slot.style.height).toBe(''); expect(slot.querySelector('[data-qk-embed-grip]')).toBeNull()
    expect(root.querySelector('[data-qk-embed-body] [data-addr="x1"]')).toBeTruthy()      // the same live editor, not remounted
    press('.qk-embed-full'); expect(host.doc.get('r1').body).toBe('[[doc:d1|trip plan|h=200|fit]]')   // absolute: a repeat is the same state
    press('.qk-embed-window')
    expect(host.doc.get('r1').body).toBe('[[doc:d1|trip plan|h=200]]'); slot = root.querySelector('[data-qk-embed]'); expect(slot.style.height).toBe('200px'); expect(slot.querySelector('[data-qk-embed-grip]')).toBeTruthy()
    expect(host.checks.freshDiff()).toBeNull(); expect(host.checks.mutations()).toBeNull()
    host.dispose()
    const bare = mounted({ bare: true }); await settle()
    const s2 = bare.root.querySelector('[data-qk-embed]'); expect(s2.classList.contains('mode-full')).toBe(true); s2.getBoundingClientRect = () => ({ height: 410 })
    bare.root.querySelector('.qk-embed-window').dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    expect(bare.host.doc.get('r1').body).toBe('[[doc:d1|trip plan|h=320]]')                 // the drawn height, at most 320
    bare.host.dispose()
  })
  it('a FULL embed that scrolls out of view keeps the height it had (a spacer on its own body) and gives it back to the real one once remounted', async () => {
    const { host, root, embeds } = mounted({ bare: true }); await settle()
    const slot = root.querySelector('[data-qk-embed]'), body = slot.querySelector('[data-qk-embed-body]')
    body.getBoundingClientRect = () => ({ height: 333 })
    embeds.unmountSlot('emb:r1')
    expect(body.style.minHeight).toBe('333px')
    host.dispose()
  })
  const ptr = (type, y, extra = {}) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { button: 0, clientY: y, pointerId: 7, ...extra })
  it('dragging the grip previews the height as state (embedDrag), writes the chip ONCE on release, and the host editor never sees the press', async () => {
    const { host, root, mounts } = mounted(); await settle()
    const slot = root.querySelector('[data-qk-embed]'), grip = slot.querySelector('[data-qk-embed-grip]'); slot.getBoundingClientRect = () => ({ height: 200, width: 500, top: 0, left: 0, right: 500, bottom: 200 })
    host.dispatch({ type: 'select', sel: at('r0', 2) }); const n = host.log.length
    const down = ptr('pointerdown', 500); grip.dispatchEvent(down); expect(down.defaultPrevented).toBe(true)
    expect(host.state.gesture).toBeNull(); expect(host.state.sel.f).toEqual({ id: 'r0', off: 2 })            // the host took no selection gesture
    grip.dispatchEvent(ptr('pointermove', 560)); expect(host.state.embedDrag).toEqual({ key: 'emb:r1', h: 260 })
    expect(root.querySelector('[data-qk-embed]').style.height).toBe('260px')                                  // painted from state in the commit
    expect(host.doc.get('r1').body).toBe('[[doc:d1|trip plan|h=200]]')                                         // a preview writes nothing
    grip.dispatchEvent(ptr('pointermove', 600)); expect(root.querySelector('[data-qk-embed]').style.height).toBe('300px')
    grip.dispatchEvent(ptr('pointerup', 600))
    expect(host.doc.get('r1').body).toBe('[[doc:d1|trip plan|h=300]]'); expect(host.state.embedDrag).toBeNull()
    expect(root.querySelector('[data-qk-embed]').style.height).toBe('300px'); expect(mounts.length).toBe(1)
    expect(host.log.filter((a) => a.type === 'embed' && a.op === 'resize').length).toBe(1)                     // ONE resize however many moves
    expect(host.log.length - n).toBeGreaterThan(1)
    expect(host.checks.mutations()).toBeNull(); expect(host.checks.freshDiff()).toBeNull()
    host.dispose()
  })
  it('a cancelled drag (pointercancel) restores the height and writes nothing; a click without a move writes nothing; a read-only host starts no drag', async () => {
    const { host, root } = mounted(); await settle()
    let slot = root.querySelector('[data-qk-embed]'), grip = slot.querySelector('[data-qk-embed-grip]'); slot.getBoundingClientRect = () => ({ height: 200 })
    grip.dispatchEvent(ptr('pointerdown', 500)); grip.dispatchEvent(ptr('pointermove', 580)); expect(root.querySelector('[data-qk-embed]').style.height).toBe('280px')
    grip.dispatchEvent(ptr('pointercancel', 580))
    expect(host.state.embedDrag).toBeNull(); expect(root.querySelector('[data-qk-embed]').style.height).toBe('200px'); expect(host.doc.get('r1').body).toBe('[[doc:d1|trip plan|h=200]]')
    grip.dispatchEvent(ptr('pointerdown', 500)); grip.dispatchEvent(ptr('pointerup', 500)); expect(host.doc.get('r1').body).toBe('[[doc:d1|trip plan|h=200]]')
    host.dispose()
    const ro = mounted({ readOnly: true }); await settle()
    slot = ro.root.querySelector('[data-qk-embed]'); grip = slot.querySelector('[data-qk-embed-grip]'); slot.getBoundingClientRect = () => ({ height: 200 })
    grip.dispatchEvent(ptr('pointerdown', 500)); grip.dispatchEvent(ptr('pointermove', 580)); grip.dispatchEvent(ptr('pointerup', 580))
    expect(ro.host.state.embedDrag).toBeNull(); expect(ro.host.doc.get('r1').body).toBe('[[doc:d1|trip plan|h=200]]'); expect(ro.host.state.notice).toBeNull()
    ro.host.dispose()
  })
  it('a nested embed\'s grip is handled by the manager of the editor it is drawn in, never by the outer one', async () => {
    const { host, root } = mounted(); await settle()
    const body = root.querySelector('[data-qk-embed-body]')
    const fake = body.ownerDocument.createElement('div'); fake.setAttribute('data-qk-embed', 'emb:x1'); fake.innerHTML = '<div class="qk-embed-grip" data-qk-embed-grip=""></div>'
    body.append(fake)                                                           // a slot as an inner editor would draw it: inside an embed body, its parent is not the host root
    fake.querySelector('[data-qk-embed-grip]').dispatchEvent(ptr('pointerdown', 10)); fake.querySelector('[data-qk-embed-grip]').dispatchEvent(ptr('pointermove', 50))
    expect(host.log.filter((a) => a.type === 'embed' && a.op === 'drag')).toEqual([]); expect(host.state.embedDrag).toBeNull()
    fake.remove(); host.dispose()
  })
  it('leaving: the embedded editor\'s edge exit puts the host caret on the next row and clears the embed focus; Escape goes to the chip row', async () => {
    const { host, mounts, embeds } = mounted(); await settle()
    host.dispatch({ type: 'embed', op: 'focus', key: 'emb:r1', where: 'start' }); expect(host.state.embedFocus).toBe('emb:r1')
    mounts[0].ctx.onEdge(1)
    expect(host.state.embedFocus).toBeNull(); expect(host.state.sel.f).toEqual({ id: 'r2', off: 0 })
    mounts[0].ctx.onEdge(-1)
    expect(host.state.sel.f).toEqual({ id: 'r1', off: '[[doc:d1|trip plan|h=200]]'.length })
    expect(embeds.canEnter('emb:r1')).toBe(true); expect(embeds.enter('emb:r1', 'start')).toBe(true)
    host.dispose()
  })
  it('the chip row is still one addressed line whose text is the source (edited and deleted as text)', async () => {
    const { host, root } = mounted(); await settle()
    expect(root.querySelector('[data-addr="r1"]').textContent).toBe('[[doc:d1|trip plan|h=200]]')
    expect(host.items.map((i) => i.key)).toEqual(['r0', 'r1', 'emb:r1', 'r2'])
    host.dispose()
  })
  it('disposing the host disposes every embedded editor and removes the modal', async () => {
    const { host, mounts } = mounted(); await settle()
    host.dispatch({ type: 'embed', op: 'modal', key: 'emb:r1' }); await settle()
    host.dispose()
    expect(mounts.every((m) => m.disposed)).toBe(true); expect(document.querySelector('.qk-embed-modal')).toBeNull()
  })
})
