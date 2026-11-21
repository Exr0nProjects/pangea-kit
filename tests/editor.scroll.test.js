// Scroll, landing and paging as kit state (lib/editor/scroll.js) and document-wide ops over unloaded pages; the
// frame-level browser suite is tests/editor.scroll.browser.test.js.
import { describe, expect, it } from 'vitest'
import { createEditor, memoryLines, modelRun, initState } from '../lib/editor/editor.js'
import { scrollStep, driftOf, intentTracker } from '../lib/editor/scroll.js'

const app = {
  textOf: (r) => r.body,
  estimate: () => 20,
  items: (doc) => doc.lines().map((r) => ({ ...r, key: r.id, addr: r.id })),
  render: (it) => ({ tag: 'div', addr: it.id, children: it.body ? [it.body] : [{ tag: 'br' }] }),
  reduce: () => null,
}
const contract = { name: 'scroll-test', actions: [] }
// a paged doc: the last `loaded` rows are in the window; loadOlder reads `page` more (async, as rows.js does)
function pagedDoc(n, loaded, page = 50) {
  const rows = Array.from({ length: n }, (_, k) => ({ id: `r${String(k).padStart(4, '0')}`, body: k === 3 ? 'the needle row' : k === 7 ? 'second needle' : `line ${k}`, ord: k }))
  const base = memoryLines(rows)
  let from = n - loaded, calls = 0
  return {
    lines: () => base.lines().slice(from), get: base.get, peek: base.peek, put: base.put,
    atStart: () => from === 0,
    async loadOlder(k = page) { calls += 1; await Promise.resolve(); const b = from; from = Math.max(0, from - Math.min(k, page)); return b - from },
    get calls() { return calls },
  }
}
const mount = (doc) => { document.body.innerHTML = '<div><div id="d" contenteditable="true"></div></div>'; let t = 1e12; return createEditor({ root: document.getElementById('d'), app, doc, contract, dev: true, clock: () => (t += 10) }) }

describe('scroll state', () => {
  it('an app anchor is a landing (pinned); user scrolls carry free or bottom; nonsense is a no-op', () => {
    const s = initState(app)
    expect(s.follow).toBe('free')
    scrollStep(s, { anchor: { id: 'x', px: 75 } })
    expect(s).toMatchObject({ anchor: { id: 'x', px: 75 }, follow: 'pinned' })
    scrollStep(s, { anchor: { id: 'y', px: -3 }, follow: 'free' })
    expect(s).toMatchObject({ anchor: { id: 'y', px: -3 }, follow: 'free' })
    scrollStep(s, { follow: 'bottom' })
    expect(s).toMatchObject({ anchor: { id: 'y', px: -3 }, follow: 'bottom' })
    for (const junk of [{}, { anchor: 7 }, { anchor: { id: 3, px: 1 } }, { follow: 'sideways' }, { anchor: { id: 'z', px: NaN } }]) {
      const before = JSON.stringify(s); scrollStep(s, junk); expect(JSON.stringify(s)).toBe(before)
    }
  })
  it('scroll actions replay in the model (no DOM): the anchor and follow are reducer state', () => {
    const { state } = modelRun(app, [{ id: 'a', body: 'x', ord: 1 }], [{ type: 'scroll', anchor: { id: 'a', px: 10 } }, { type: 'scroll', anchor: { id: 'a', px: 4 }, follow: 'free' }])
    expect(state).toMatchObject({ anchor: { id: 'a', px: 4 }, follow: 'free' })
  })
  it('a followEnd editor starts following the end', () => {
    document.body.innerHTML = '<div><div id="d" contenteditable="true"></div></div>'
    const ed = createEditor({ root: document.getElementById('d'), app, doc: memoryLines([{ id: 'a', body: 'x', ord: 1 }]), contract, followEnd: true })
    expect(ed.state.follow).toBe('bottom')
    expect(ed.scroller.style.overflowAnchor).toBe('none')
  })
  it('driftOf reports the worst frame and frames where the row was not drawn', () => {
    expect(driftOf([{ f: 1, y: 10 }, { f: 2, y: 12.34 }, { f: 3, y: null }], 10)).toEqual({ drift: 2.3, frame: 2, missing: 1, frames: 3 })
  })
})

describe('document-wide ops cover unloaded pages (design gap B, row 55)', () => {
  it('⌘F finds a match on a page that was never loaded, and says when it covers the document', async () => {
    const doc = pagedDoc(400, 50)
    const ed = mount(doc)
    ed.dispatch({ type: 'find', open: true })
    ed.dispatch({ type: 'find', q: 'needle' })
    expect(ed.state.find).toMatchObject({ n: 0, complete: false }) // the visible response now: no match in the window, not complete
    await ed.widening()
    await new Promise((ok) => setTimeout(ok, 0))
    expect(doc.atStart()).toBe(true)
    expect(ed.state.find).toMatchObject({ n: 2, complete: true })
    expect(ed.state.find.cur.id).toBe('r0003')
    expect(ed.state.sel).toEqual({ a: { id: 'r0003', off: 4 }, f: { id: 'r0003', off: 10 } })
  })
  it('⌘A selects the loaded rows at once, then the whole document once the rest is read', async () => {
    const doc = pagedDoc(400, 50)
    const ed = mount(doc)
    ed.dispatch({ type: 'select-all' })
    expect(ed.state.sel.a.id).toBe('r0350')
    expect(ed.state.wide).toEqual({ op: 'select-all' })
    await ed.widening()
    await new Promise((ok) => setTimeout(ok, 0))
    expect(ed.state.sel).toEqual({ a: { id: 'r0000', off: 0 }, f: { id: 'r0399', off: 'line 399'.length } })
    expect(ed.state.wide).toBe(null)
  })
  it('another action before the pages arrive cancels a pending select-all (it does not grab the document later)', async () => {
    const doc = pagedDoc(400, 50)
    const ed = mount(doc)
    ed.dispatch({ type: 'select-all' })
    const p = ed.widening()
    ed.dispatch({ type: 'select', sel: { a: { id: 'r0390', off: 1 }, f: { id: 'r0390', off: 1 } } })
    await p; await new Promise((ok) => setTimeout(ok, 0))
    expect(ed.state.sel).toEqual({ a: { id: 'r0390', off: 1 }, f: { id: 'r0390', off: 1 } })
  })
  it('an unpaged doc is complete at once and reads nothing', () => {
    const ed = mount(memoryLines([{ id: 'a', body: 'needle', ord: 1 }]))
    ed.dispatch({ type: 'find', open: true }); ed.dispatch({ type: 'find', q: 'needle' })
    expect(ed.state.find).toMatchObject({ n: 1, complete: true })
    expect(ed.widening()).toBe(null)
  })
})

describe('intent window after a touch fling (zai mobile scroll stuck, 2026-11-13)', () => {
  const rig = () => {
    const mk = () => { const t = new EventTarget(); return t }
    const scroller = mk(), W = mk(); let t = 0; W.performance = { now: () => t }
    const fire = (tg, n) => tg.dispatchEvent(new Event(n))
    return { scroller, W, fire, at: (ms) => { t = ms }, tr: intentTracker(scroller, W) }
  }
  it('a scroll 600 ms after a dragged touch lifts is still the user\'s (momentum gap)', () => {
    const r = rig()
    r.at(0); r.fire(r.scroller, 'touchstart'); r.fire(r.scroller, 'touchmove'); r.at(50); r.fire(r.W, 'touchend')
    r.at(650)
    expect(r.tr.user()).toBe(true)
  })
  it('a fling keeps chaining across gaps up to 500 ms, and ends after a longer silence', () => {
    const r = rig()
    r.at(0); r.fire(r.scroller, 'touchstart'); r.fire(r.scroller, 'touchmove'); r.fire(r.W, 'touchend')
    r.at(1000); expect(r.tr.user()).toBe(true)
    r.at(1450); expect(r.tr.user()).toBe(true)
    r.at(2200); expect(r.tr.user()).toBe(false)
  })
  it('a tap (no touchmove) does not open the long window: a scroll 600 ms later is foreign', () => {
    const r = rig()
    r.at(0); r.fire(r.scroller, 'touchstart'); r.at(50); r.fire(r.W, 'touchend')
    r.at(650)
    expect(r.tr.user()).toBe(false)
  })
})
