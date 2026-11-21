// @vitest-environment jsdom
// The owner, 2026-11-10 15:17 and 15:48 PST, old zai: "<b>Steerable LLMs something something </b>" and a heavy "Other, lil
// projects", the words mouse-selected and deleted, took characters of the hidden "<b>" with them ("LLng </b>", "r, lil
// projects</b>"): its selection counted drawn characters and its body counted the markers. "fuzz ts against rich editor"
// and "fix upstream in the pangea kit component too". The kit editor keeps hidden syntax IN the DOM (decorate.js, class
// qk-hide) so a DOM point maps to an offset into the text with the markers counted and a selection cannot be shifted by
// them. This fuzz holds the kit to that: a random line of marks, a random drawn selection read the way a browser reads it
// (points inside the VISIBLE text nodes), select then delete or type over through the editor, and the line must be its
// old text with exactly those drawn characters replaced, every marker kept. Seeded: HIDDEN_FUZZ_RUNS.
import { describe, expect, it } from 'vitest'
import * as E from '../lib/editor/editor.js'
import { inline } from '../lib/editor/decorate.js'

const PAIRS = [['<b>', '</b>', 'm'], ['**', '**', 'b'], ['<u>', '</u>', 'u'], ['~~', '~~', 's']]
// one run of one mark per match, the markers hidden when the line is not the caret's (decorate.js inline)
function tokens(text) {
  const out = []; let at = 0
  const re = /<b>(.+?)<\/b>|\*\*(.+?)\*\*|<u>(.+?)<\/u>|~~(.+?)~~/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const k = [1, 2, 3, 4].find((i) => m[i] !== undefined), [open, close, cls] = PAIRS[k - 1]
    if (m.index > at) out.push({ text: text.slice(at, m.index), cls: [] })
    out.push({ text: open, cls: [cls], marker: true }, { text: m[k], cls: [cls] }, { text: close, cls: [cls], marker: true })
    at = m.index + m[0].length
  }
  if (at < text.length) out.push({ text: text.slice(at), cls: [] })
  return out
}
const drawnOf = (text) => tokens(text).filter((t) => !t.marker).map((t) => t.text).join('')
const app = {
  textOf: (r) => r.body,
  estimate: () => 20,
  items: (doc, state) => doc.lines().map((r) => ({ ...r, key: r.id, addr: r.id, active: Boolean(state.sel) && (state.sel.a.id === r.id || state.sel.f.id === r.id) })),
  render: (it) => ({ tag: 'div', addr: it.id, children: it.body ? inline(it.body, { marks: tokens, active: it.active }) : [{ tag: 'br' }] }),
  reduce(state, a) {
    // the plainest reducer there is: the selected text of one line replaced (the kit reads the selection; the app only splices)
    if (a.type !== 'input' || !a.sel || a.sel.a.id !== a.sel.f.id) return null
    const lo = Math.min(a.sel.a.off, a.sel.f.off), hi = Math.max(a.sel.a.off, a.sel.f.off)
    const text = a.inputType.startsWith('delete') ? '' : String(a.text ?? '')
    const row = a.__row(a.sel.a.id)
    return { puts: [{ id: row.id, set: { body: row.body.slice(0, lo) + text + row.body.slice(hi) } }], sel: { a: { id: row.id, off: lo + text.length }, f: { id: row.id, off: lo + text.length } } }
  },
}
const contract = { name: 'hidden-syntax-editor', actions: [] }

const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const pick = (r, l) => l[Math.floor(r() * l.length)]
const WORDS = ['Other,', 'lil', 'projects', 'Steerable', 'LLMs', 'x y', 'é', '3']
function line(r) {
  let out = pick(r, WORDS)
  for (let n = 1 + Math.floor(r() * 4); n > 0; n--) { const [o, c] = pick(r, PAIRS); out += ' ' + (r() < 0.6 ? o + pick(r, WORDS) + ' ' + pick(r, WORDS) + c : pick(r, WORDS)) + ' ' + pick(r, WORDS) }
  return out
}

/** The DOM point of drawn character boundary k, the way a browser puts one: inside a visible (not qk-hide) text node. */
function pointOf(root, id, k, edge) {
  const row = root.querySelector(`[data-addr="${id}"]`)
  const nodes = []; const w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  for (let n = w.nextNode(); n; n = w.nextNode()) if (!n.parentElement.closest('.qk-hide')) nodes.push(n)
  let left = k
  for (const n of nodes) {
    // the end of a selection sits at the end of the node holding its last character, the start at the start of the one holding its first
    if (edge === 'start' ? left < n.length : left <= n.length) return [n, left]
    left -= n.length
  }
  const last = nodes[nodes.length - 1]
  return [last, last.length]
}

function one(seed, adapter = E.addrOfPoint) {
  const r = rng(seed), body = line(r), drawn = drawnOf(body)
  let a = Math.floor(r() * drawn.length), b = a + 1 + Math.floor(r() * (drawn.length - a))
  const typed = pick(r, ['', 'Q']), backwards = r() < 0.3
  document.body.innerHTML = '<div id="s"><div id="d" contenteditable="true"></div></div>'
  const doc = E.memoryLines([{ id: 'a', body, ord: 1 }, { id: 'z', body: 'other line', ord: 2 }], { sortKey: (x) => [x.ord, x.id] }); let t = 1e12
  const root = document.getElementById('d')
  const wrapped = { ...app, reduce: (s, act, ctx) => app.reduce(s, { ...act, __row: (id) => ctx.get(id) }, ctx) }
  const ed = E.createEditor({ root, app: wrapped, doc, contract, dev: false, clock: () => (t += 100) })
  const [an, ao] = pointOf(root, 'a', a, 'start'), [fn, fo] = pointOf(root, 'a', b, 'end')
  const pa = adapter(root, an, ao), pf = adapter(root, fn, fo)
  const sel = backwards ? { a: pf, f: pa } : { a: pa, f: pf }
  ed.dispatch({ type: 'select', sel })
  ed.dispatch({ type: 'input', inputType: typed ? 'insertText' : 'deleteContentBackward', text: typed, sel })
  const after = doc.get('a').body
  return { body, drawn, a, b, typed, after, sel }
}

// the raw offsets of drawn boundaries: a drawn char k starts at the raw index of the k-th non-marker character
function rawStarts(body) { const out = []; let at = 0; for (const t of tokens(body)) { for (let i = 0; i < t.text.length; i++) if (!t.marker) out.push(at + i); at += t.text.length } return out }

// the planted bug, the old zai's: offsets that count the DRAWN characters only, used as offsets into a body that has the markers
const drawnOnly = (root, node, off) => { const p = E.addrOfPoint(root, node, off); const row = root.querySelector(`[data-addr="${p.id}"]`); let n = 0; const w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); for (let t = w.nextNode(); t && t !== node; t = w.nextNode()) if (!t.parentElement.closest('.qk-hide')) n += t.length; return { id: p.id, off: n + off } }
const RUNS = Number(process.env.HIDDEN_FUZZ_RUNS || 800)
describe('a DOM selection of drawn characters over hidden syntax (kit editor adapter)', () => {
  it('the owner\'s case: "Other," of a heavy "Other, lil projects" is raw [3, 9)', () => {
    const s = (() => {
      document.body.innerHTML = '<div id="s"><div id="d" contenteditable="true"></div></div>'
      const doc = E.memoryLines([{ id: 'a', body: '<b>Other, lil projects</b>', ord: 1 }], { sortKey: (x) => [x.ord, x.id] }); const root = document.getElementById('d')
      E.createEditor({ root, app, doc, contract, dev: false, clock: () => 1e12 })
      const [an, ao] = pointOf(root, 'a', 0, 'start'), [fn, fo] = pointOf(root, 'a', 6, 'end')
      return [E.addrOfPoint(root, an, ao), E.addrOfPoint(root, fn, fo), root.querySelector('.qk-hide')?.textContent]
    })()
    expect(s).toEqual([{ id: 'a', off: 3 }, { id: 'a', off: 9 }, '<b>'])
  })
  it(`${RUNS} seeds: select then delete or type over removes exactly the drawn characters, markers untouched`, () => {
    const bad = []
    for (let seed = 1; seed <= RUNS; seed++) {
      const x = one(seed), starts = rawStarts(x.body)
      const lo = starts[x.a], hi = starts[x.b - 1] + 1
      const want = x.body.slice(0, lo) + x.typed + x.body.slice(hi)
      if (x.after !== want) bad.push({ seed, body: x.body, a: x.a, b: x.b, got: x.after, want })
    }
    expect(bad.slice(0, 3)).toEqual([])
  })
  it('is red on an adapter that counts drawn characters only (the check can fail)', () => {
    let bad = 0
    for (let seed = 1; seed <= 300; seed++) { const x = one(seed, drawnOnly), starts = rawStarts(x.body); if (x.after !== x.body.slice(0, starts[x.a]) + x.typed + x.body.slice(starts[x.b - 1] + 1)) bad++ }
    expect(bad).toBeGreaterThan(100)
  })
})
