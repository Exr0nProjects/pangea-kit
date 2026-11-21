// @vitest-environment jsdom
// Folded syntax (lib/editor/fold.js, decorate.js `fold`): zai3's character-format tags `<span data-f ...>` ... `</span>` are hidden
// on the caret's line too (The owner 2026-11-12: formatted text should look formatted, no visible tags), so the caret, the arrow keys and
// the deletes must treat a run as not there. Laws, all over random lines: (1) a folded token is qk-hide whether the line is active
// or not (a plain marker is qk-mk on the active line); (2) an arrow press moves the caret exactly one DRAWN character and never rests inside a run; (3) a one-character delete
// removes exactly one drawn character and no tag; (4) a range splice removes exactly the drawn characters of the range and keeps every
// tag, so the tags stay in mated pairs; (5) the DOM point of a boundary beside a hidden run is a drawn node and reads back to the same offset.
import { describe, expect, it } from 'vitest'
import * as E from '../lib/editor/editor.js'
import { inline } from '../lib/editor/decorate.js'
import { foldRuns, stepCaret, deleteSpan, spliceKeeping, keptRuns, drawnMap, snapOut } from '../lib/editor/fold.js'
import { dropEmptySpans } from '../lib/editor/format.js'

const OPEN = /<span data-f="[a-z]+" data-s="\d+">/y
// the app's marks, in miniature: one span kind (folded) and `**` bold (a plain marker)
function marks(text) {
  const out = []; let i = 0, plain = ''
  const flush = () => { if (plain) { out.push({ text: plain, cls: [] }); plain = '' } }
  while (i < text.length) {
    OPEN.lastIndex = i; const o = OPEN.exec(text), c = o ? text.indexOf('</span>', i + o[0].length) : -1
    if (o && c >= 0) { flush(); out.push({ text: o[0], cls: ['sp'], marker: true, fold: true }); out.push({ text: text.slice(i + o[0].length, c), cls: ['sp'] }); out.push({ text: '</span>', cls: ['sp'], marker: true, fold: true }); i = c + 7; continue }
    if (text.startsWith('**', i)) { const e = text.indexOf('**', i + 2); if (e > i + 2) { flush(); out.push({ text: '**', cls: ['b'], marker: true }, ...marks(text.slice(i + 2, e)).map((x) => ({ ...x, cls: ['b', ...x.cls] })), { text: '**', cls: ['b'], marker: true }); i = e + 2; continue } }
    plain += text[i]; i++
  }
  flush(); return out
}
const SP = '<span data-f="georgia" data-s="16">', SC = '</span>'
const drawnOf = (t) => { const r = foldRuns(t, marks); return drawnMap(t, r).drawn }

const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const WORDS = ['First', 'paragraph', 'x y', 'é', 'last', 'a']
function line(r) {
  let s = WORDS[Math.floor(r() * WORDS.length)]
  for (let n = 1 + Math.floor(r() * 4); n > 0; n--) { const w = WORDS[Math.floor(r() * WORDS.length)]; const k = r(); s += ' ' + (k < 0.5 ? SP + w + SC : k < 0.65 ? SP + SC : k < 0.8 ? '**' + w + '**' : w) }
  return s
}

describe('folded markers draw hidden on the caret\'s line too', () => {
  const classes = (kids) => kids.filter((k) => typeof k !== 'string').map((k) => k.cls)
  it('a folded span tag is qk-hide qk-fold active or not; a plain marker is qk-mk active and qk-hide off the line', () => {
    const t = `First ${SP}word${SC} and **bold**`
    for (const active of [true, false]) {
      const kids = inline(t, { marks, active })
      expect(kids.map((k) => (typeof k === 'string' ? k : k.text)).join('')).toBe(t) // the text nodes are exactly the text
      const tags = kids.filter((k) => typeof k !== 'string' && (k.text === SP || k.text === SC))
      expect(tags).toHaveLength(2)
      for (const k of tags) { expect(k.cls).toMatch(/\bqk-hide\b/); expect(k.cls).toMatch(/\bqk-fold\b/); expect(k.cls).not.toMatch(/qk-mk/) }
      const star = kids.find((k) => typeof k !== 'string' && k.text === '**')
      expect(star.cls).toMatch(active ? /qk-mk/ : /qk-hide/)
    }
  })
  it('is red on the old behaviour: with fold dropped the tags are faint source on the active line', () => {
    const noFold = (s) => marks(s).map(({ fold: _f, ...t }) => t)
    const kids = inline(`a ${SP}w${SC}`, { marks: noFold, active: true })
    expect(kids.find((k) => typeof k !== 'string' && k.text === SP).cls).toMatch(/qk-mk/)
  })
})

describe('fold.js over random lines', () => {
  it('stepCaret: every press moves one drawn character, never rests inside a run; right then left returns', () => {
    const r = rng(11); let presses = 0
    for (let n = 0; n < 600; n++) {
      const t = line(r), runs = foldRuns(t, marks), dm = drawnMap(t, runs)
      let o = 0, k = 0
      // walk right from the start: the drawn index grows by exactly one per press until the edge
      for (let guard = 0; guard < 400; guard++) {
        const nx = stepCaret(runs, o, 1, t.length, t)
        if (nx == null) break
        presses++
        expect(snapOut(runs, nx, 0)).toBe(nx) // never inside a run
        expect(dm.drawnIndex(nx)).toBe(dm.drawnIndex(o) + 1)
        o = nx; k++
      }
      expect(dm.drawnIndex(o)).toBe(dm.drawn.length - (runs.some((x) => x[1] === t.length) ? 0 : 0) )
      // and back left
      let back = 0
      for (let guard = 0; guard < 400; guard++) { const pv = stepCaret(runs, o, -1, t.length, t); if (pv == null) break; expect(dm.drawnIndex(pv)).toBe(dm.drawnIndex(o) - 1); o = pv; back++ }
      expect(back).toBe(k)
    }
    expect(presses).toBeGreaterThan(2000)
  })
  it('deleteSpan removes one drawn character and no tag', () => {
    const r = rng(23); let n = 0
    for (let i = 0; i < 800; i++) {
      const t = line(r), runs = foldRuns(t, marks), dm = drawnMap(t, runs)
      const off = Math.floor(r() * (t.length + 1)), back = r() < 0.5, o = snapOut(runs, off, 0)
      const d = deleteSpan(runs, t, o, back)
      if (!d) { const di = dm.drawnIndex(o); expect(back ? di === 0 : di === dm.drawn.length).toBe(true); continue }
      n++
      const after = t.slice(0, d.from) + t.slice(d.to)
      expect(drawnOf(after)).toHaveLength(dm.drawn.length - 1)
      expect((after.match(/<span /g) || []).length).toBe((t.match(/<span /g) || []).length) // no tag touched
      expect((after.match(/<\/span>/g) || []).length).toBe((t.match(/<\/span>/g) || []).length)
    }
    expect(n).toBeGreaterThan(600)
  })
  it('spliceKeeping removes exactly the drawn characters of a range and keeps every tag in order', () => {
    const r = rng(31); let n = 0
    for (let i = 0; i < 800; i++) {
      const t = line(r), runs = foldRuns(t, marks), dm = drawnMap(t, runs)
      let a = snapOut(runs, Math.floor(r() * (t.length + 1)), 0), b = snapOut(runs, Math.floor(r() * (t.length + 1)), 0); if (a > b) [a, b] = [b, a]
      const ins = r() < 0.5 ? '' : 'Q', res = spliceKeeping(t, runs, a, b, ins)
      n++
      const wantDrawn = dm.drawn.slice(0, dm.drawnIndex(a)) + ins + dm.drawn.slice(dm.drawnIndex(b))
      expect(drawnOf(res.text)).toBe(wantDrawn)
      expect((res.text.match(/<span /g) || []).length).toBe((t.match(/<span /g) || []).length)
      expect((res.text.match(/<\/span>/g) || []).length).toBe((t.match(/<\/span>/g) || []).length)
      expect(keptRuns(t, runs, a, b)).toBe(runs.filter((x) => x[0] >= a && x[1] <= b).map((x) => t.slice(x[0], x[1])).join(''))
    }
    expect(n).toBe(800)
  })
  it('the owner\'s line: First <span ...>paragraph</span> with some words. Backspace after "paragraph" deletes the h; the tags stay', () => {
    const t = `First ${SP}paragraph${SC} with some words.`, runs = foldRuns(t, marks)
    const z = t.indexOf(SC) + SC.length, c = t.indexOf(SC)
    expect(deleteSpan(runs, t, z, true)).toEqual({ from: c - 1, to: c }) // from outside, right of the close tag
    expect(deleteSpan(runs, t, c, true)).toEqual({ from: c - 1, to: c })
    const b = t.indexOf(SP) + SP.length
    expect(deleteSpan(runs, t, b, true)).toEqual({ from: b - SP.length - 1, to: b - SP.length }) // after the open tag: the space before it
    expect(deleteSpan(runs, t, b - SP.length, false)).toEqual({ from: b, to: b + 1 }) // Delete before the open tag: the p
  })
  it('dropEmptySpans removes a pair a delete left empty and moves the caret with the text', () => {
    const t = `a ${SP}${SC} b`
    expect(dropEmptySpans(t, t.length)).toEqual({ text: 'a  b', caret: 4 })
    expect(dropEmptySpans(`a ${SP}${SC}`, 2)).toEqual({ text: 'a ', caret: 2 })
    expect(dropEmptySpans('plain', 3)).toEqual({ text: 'plain', caret: 3 })
  })
})

describe('moveSelect and the DOM point over a folded run (kit editor)', () => {
  const T = `First ${SP}paragraph${SC} with`
  const app = {
    textOf: (r) => r.body, folded: (t) => foldRuns(t, marks), estimate: () => 20,
    items: (doc, state) => doc.lines().map((r) => ({ ...r, key: r.id, addr: r.id, active: Boolean(state.sel) && state.sel.f.id === r.id })),
    render: (it) => ({ tag: 'div', addr: it.id, children: it.body ? inline(it.body, { marks, active: it.active }) : [{ tag: 'br' }] }),
    reduce: () => null,
  }
  const contract = { name: 'fold-editor', actions: [] }
  it('moveSelect with the hook steps over the open tag and a character; without it the old one-unit step', () => {
    const lines = [{ id: 'a', body: T }]
    const A = T.indexOf(SP), B = A + SP.length
    const at = (off, dir) => E.moveSelect({ sel: { a: { id: 'a', off }, f: { id: 'a', off } } }, { dir }, lines, app.textOf, app.folded).sel.f.off
    expect(at(A, 1)).toBe(B + 1)
    expect(at(B + 1, -1)).toBe(B) // arriving from the right rests inside the span (right of the open tag)
    expect(at(B, -1)).toBe(A - 1)
    expect(E.moveSelect({ sel: { a: { id: 'a', off: A }, f: { id: 'a', off: A } } }, { dir: 1 }, lines, app.textOf).sel.f.off).toBe(A + 1) // no hook: a code unit (planted: the old step rests inside the tag)
  })
  it('paints a boundary after a hidden run on the drawn node, and reads back the same offset', () => {
    document.body.innerHTML = '<div id="s"><div id="d" contenteditable="true"></div></div>'
    const doc = E.memoryLines([{ id: 'a', body: T, ord: 1 }, { id: 'z', body: 'other', ord: 2 }], { sortKey: (x) => [x.ord, x.id] })
    const root = document.getElementById('d'); let t = 1e12
    E.createEditor({ root, app, doc, contract, dev: false, clock: () => (t += 100) })
    const row = root.querySelector('[data-addr="a"]')
    const A = T.indexOf(SP), B = A + SP.length, c = T.indexOf(SC), Z = c + SC.length
    for (const off of [A, B, c, Z]) {
      const [n, o] = E.domOfAddr(row, off)
      expect(E.addrOfPoint(root, n, o)).toEqual({ id: 'a', off })
      if (off === B || off === Z) expect(n.parentElement.closest('.qk-hide')).toBeNull() // a node with a box
    }
  })
})
