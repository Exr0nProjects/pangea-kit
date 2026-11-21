// Spelling and grammar (lib/editor/lint.js, lintdom.js, lintworker.js; PANGEA3-DESIGN §15 "Spelling and grammar"). The pure part: what of a line is
// prose and how a finding maps back to the line's own offsets (across marks, code, URLs, math, links, chips, format-span tags, the app's skips); the
// findings that earn an underline; results keyed by line and text hash; every action absolute, total and idempotent (validate runs the laws over the
// declarations); the dictionary's op log. The DOM part runs over a fake editor: what is checked and when, the hover finding, the highlight, never a
// write into the editor. The real-browser proof is zai3's test/lint.browser.test.js.
import { describe, expect, it } from 'vitest'
import { proseOf, toSource, lintHash, itemKey, cleanItem, itemsFrom, earnsUnderline, shownItems, lintAt, fresh, fixAction, matchCase, lintPrefsDecl, lintViewDecl, dictDecl, dictCacheDecl, dictWords, cleanWord, dictSink, classOf } from '../lib/editor/lint.js'
import { mountLint } from '../lib/editor/lintdom.js'
import { workerCheck } from '../lib/editor/lintworker.js'
import { validate } from '../lib/validate.js'
import { createReplica } from '../lib/model.js'

// the app's marks: **bold** and a format span tag, as zai's md.js marks() reports them (delimiters are markers, folded for the span tags)
const marks = (t) => {
  const out = []; let at = 0; const re = /\*\*|<span data-f[^>]*>|<\/span>/g; let m
  while ((m = re.exec(t))) { if (m.index > at) out.push({ text: t.slice(at, m.index), cls: [] }); out.push({ text: m[0], cls: [], marker: true, fold: m[0][1] === 's' || m[0][1] === '/' }); at = m.index + m[0].length }
  if (at < t.length) out.push({ text: t.slice(at), cls: [] })
  return out
}
const skip = (t) => { const m = /^#{1,4} /.exec(t); return m ? [{ from: 0, to: m[0].length }] : [] }
const slice = (text, p, a, b) => { const at = toSource(p.map, a, b); return at && text.slice(at.from, at.to) }

describe('proseOf: the words a person reads', () => {
  it('plain text is itself, offsets the identity', () => {
    const t = 'a plain line', p = proseOf(t)
    expect(p.prose).toBe(t); expect(p.map).toEqual([...t].map((_, i) => i))
  })
  it('mark delimiters are dropped and the words inside keep their own offsets', () => {
    const t = 'see **bolded speling** now', p = proseOf(t, { marks })
    expect(p.prose).toBe('see bolded speling now')
    const at = p.prose.indexOf('speling'), s = toSource(p.map, at, at + 7)
    expect(t.slice(s.from, s.to)).toBe('speling'); expect(s.from).toBe(t.indexOf('speling'))
  })
  it('format-span tags (folded markers) are never prose', () => {
    const t = 'a <span data-f=\"georgia\" data-s=\"18\">large wrod</span> here', p = proseOf(t, { marks })
    expect(p.prose).toBe('a large wrod here')
    const a = p.prose.indexOf('wrod'); expect(slice(t, p, a, a + 4)).toBe('wrod')
  })
  it('code, math, URLs and chips are gaps, one blank where two met; a link keeps its label only', () => {
    expect(proseOf('see `codeishh` now').prose).toBe('see now')
    expect(proseOf('at https://exmple.test/speeling and more').prose).toBe('at and more')
    expect(proseOf('so $xqzvw$ and $$yyyy$$ end').prose).toBe('so and end')
    expect(proseOf('open [[doc:abcdefghijklmnop1|zzqx plan]] ok').prose).toBe('open ok')
    const t = 'go to [the pagee](https://x.test/a) now', p = proseOf(t)
    expect(p.prose).toBe('go to the pagee now'); expect(slice(t, p, p.prose.indexOf('pagee'), p.prose.indexOf('pagee') + 5)).toBe('pagee')
  })
  it('the app names more to skip: a heading mark, the await pill, @mentions', () => {
    expect(proseOf('## the headin', { skip }).prose).toBe('the headin')
    const t = '## the headin', p = proseOf(t, { skip }); expect(slice(t, p, 4, 10)).toBe('headin')
    expect(proseOf('hi @zzqx and #tagg', { skip: (s) => [...s.matchAll(/[@#]\w+/g)].map((m) => ({ from: m.index, to: m.index + m[0].length })) }).prose).toBe('hi and ')
  })
  it('a span that crosses a dropped run is not mapped (never a wrong place)', () => {
    const t = 'an **apple** here', p = proseOf(t, { marks })
    expect(p.prose).toBe('an apple here')
    expect(toSource(p.map, 0, 2)).toEqual({ from: 0, to: 2 })        // "an": contiguous
    expect(toSource(p.map, 0, 8)).toBeNull()                          // "an apple": spans the ** delimiter
    expect(toSource(p.map, 3, 8)).toEqual({ from: 5, to: 10 })        // "apple" inside the delimiters
  })
  it('is total: junk in, nothing out; a map is as long as the prose; every mapped character is the same character', () => {
    expect(proseOf(null)).toEqual({ prose: '', map: [] }); expect(proseOf(7).prose).toBe('')
    for (const t of ['**', '``', '$$', '[]()', '[[doc:x|y]]', '**a** `b` **c**', '  `x`  `y`  ', '😀 teh **😀** 😀']) {
      const p = proseOf(t, { marks }); expect(p.map.length).toBe(p.prose.length)
      p.map.forEach((src, i) => expect(t[src]).toBe(p.prose[i]))
    }
    expect(toSource([0, 1], 1, 1)).toBeNull(); expect(toSource([0, 1], -1, 1)).toBeNull(); expect(toSource([0, 1], 0, 9)).toBeNull(); expect(toSource(null, 0, 1)).toBeNull()
  })
})

describe('findings', () => {
  const map = [...'this is teh line'].map((_, i) => i)
  it('only the shown kinds, only contiguous ones, in text order, never overlapping', () => {
    const raw = [{ start: 8, end: 11, kind: 'Typo', message: 'the', suggestions: ['the'], text: 'teh' }, { start: 0, end: 4, kind: 'Capitalization', message: 'cap', suggestions: ['This'], text: 'this' },
      { start: 5, end: 7, kind: 'Style', message: 's', suggestions: [], text: 'is' }, { start: 8, end: 16, kind: 'Grammar', message: 'overlaps teh', suggestions: [], text: 'teh line' }, { start: 0, end: 2, kind: 'Grammar', message: 'm', suggestions: ['x'], text: 'th' }]
    const items = itemsFrom(raw, map, 'this is teh line')
    expect(items.map((i) => [i.from, i.to, i.cls])).toEqual([[0, 2, 'grammar'], [8, 11, 'spelling']])
    expect(items[1]).toMatchObject({ word: 'teh', sug: ['the'], key: 's:teh' })
    expect(itemsFrom('x', map, 'a')).toEqual([]); expect(itemsFrom([null, {}, { start: 'a' }], map, 'a')).toEqual([])
  })
  it('a spelling whose only fault is its case, and a Miscellaneous that is not a/an, earn no underline', () => {
    expect(earnsUnderline({ kind: 'Spelling', text: 'alice', suggestions: ['albeit', 'Alice'] })).toBe(false)
    expect(earnsUnderline({ kind: 'Spelling', text: 'speling', suggestions: ['spelling'] })).toBe(true)
    expect(earnsUnderline({ kind: 'Miscellaneous', message: '`gonna` is very informal.' })).toBe(false)
    expect(earnsUnderline({ kind: 'Miscellaneous', message: 'Incorrect indefinite article.' })).toBe(true)
    expect(earnsUnderline({ kind: 'Capitalization' })).toBe(false); expect(earnsUnderline(null)).toBe(false)
    expect(classOf('Typo')).toBe('spelling'); expect(classOf('Agreement')).toBe('grammar'); expect(classOf('Style')).toBeNull()
  })
  it('cleanItem repairs or refuses; keys are by lowercased word (spelling) or message and words (grammar)', () => {
    expect(cleanItem({ from: 3, to: 3, cls: 'spelling' })).toBeNull(); expect(cleanItem({ from: -1, to: 2, cls: 'spelling' })).toBeNull(); expect(cleanItem({ from: 0, to: 2, cls: 'x' })).toBeNull(); expect(cleanItem(null)).toBeNull()
    const it = cleanItem({ from: 0, to: 3, cls: 'spelling', word: 'Teh', sug: ['the', 'Teh', 7, 'x'.repeat(200), 'a', 'b', 'c', 'd', 'e'], msg: 'm' })
    expect(it.sug).toEqual(['the', 'a', 'b', 'c', 'd']); expect(it.key).toBe('s:teh')
    expect(itemKey('grammar', 'an', 'Incorrect article')).toBe('g:incorrect article:an')
  })
  it('shown findings leave out the ignored and the dictionary words; lintAt finds by offset; a result is fresh only for its text', () => {
    const e = { h: lintHash('teh x'), items: [cleanItem({ from: 0, to: 3, cls: 'spelling', word: 'teh', sug: ['the'] }), cleanItem({ from: 4, to: 5, cls: 'grammar', word: 'x', msg: 'm', sug: [] })] }
    expect(shownItems(e).length).toBe(2)
    expect(shownItems(e, { dict: new Set(['teh']) }).map((i) => i.word)).toEqual(['x'])
    expect(shownItems(e, { dict: new Set(['x']) }).length).toBe(2)           // the dictionary is for spelling only
    expect(shownItems(e, { ignored: new Set(['g:m:x']) }).map((i) => i.word)).toEqual(['teh'])
    expect(lintAt(e.items, 0).word).toBe('teh'); expect(lintAt(e.items, 2).word).toBe('teh'); expect(lintAt(e.items, 3)).toBeNull(); expect(lintAt(e.items, 4).word).toBe('x'); expect(lintAt(null, 0)).toBeNull()
    expect(fresh(e, 'teh x')).toBe(true); expect(fresh(e, 'the x')).toBe(false); expect(fresh(null, 'x')).toBe(false)
    expect(lintHash('a')).not.toBe(lintHash('b')); expect(lintHash('ab')).toBe(lintHash('ab'))
  })
  it('a fix is one input over exactly the finding; the case of the word is kept', () => {
    expect(fixAction('r1', { from: 5, to: 8 }, 'the')).toEqual({ type: 'input', inputType: 'insertReplacementText', text: 'the', sel: { a: { id: 'r1', off: 5 }, f: { id: 'r1', off: 8 } } })
    expect(fixAction(7, { from: 0, to: 1 }, 'x')).toBeNull(); expect(fixAction('r', null, 'x')).toBeNull()
    expect(matchCase('Teh', 'the')).toBe('The'); expect(matchCase('TEH', 'the')).toBe('THE'); expect(matchCase('teh', 'the')).toBe('the'); expect(matchCase('Hix', 'Hex')).toBe('Hex'); expect(matchCase('', 'x')).toBe('x')
  })
})

describe('the state', () => {
  it('validate runs every law over the declarations (idempotent, total, reload)', async () => {
    const r = await validate({ decls: [lintPrefsDecl('t-lint-prefs'), lintViewDecl('t-lint-view'), dictDecl('t-dict'), dictCacheDecl('t-dict-cache')], ui: true, timing: false })
    expect(r.ok, JSON.stringify(r).slice(0, 800)).toBe(true)
  }, 60000)
  it('results replace a line whole, repeat as nothing, and are bounded; hover and status are absolute', () => {
    const d = lintViewDecl('t-lint-view-2'), a = d.actions
    let s = d.initial
    const it = { from: 0, to: 3, cls: 'spelling', word: 'teh', sug: ['the'] }
    const s1 = a['lint.result'](s, { id: 'l1', h: 'a.5', items: [it] }); expect(s1.results.l1.items[0].key).toBe('s:teh')
    expect(a['lint.result'](s1, { id: 'l1', h: 'a.5', items: [it] })).toBe(s1)                                  // a repeat changes nothing
    expect(a['lint.result'](s1, { id: 'l1', h: 'b.5', items: [] }).results.l1).toEqual({ h: 'b.5', items: [] }) // the line's result is replaced
    expect(a['lint.result'](s1, { id: 7, h: 'x' })).toBe(s1); expect(a['lint.result'](s1, { id: 'l2' })).toBe(s1)
    let big = s; for (let i = 0; i < 3100; i++) big = a['lint.result'](big, { id: `l${i}`, h: 'h', items: [] })
    expect(Object.keys(big.results).length).toBe(3000)
    const h = a['lint.hover'](s, { id: 'l1', from: 0, to: 3, cls: 'grammar' }); expect(h.hover).toEqual({ id: 'l1', from: 0, to: 3, cls: 'grammar' })
    expect(a['lint.hover'](h, { id: 'l1', from: 0, to: 3, cls: 'grammar' })).toBe(h); expect(a['lint.hover'](h, null).hover).toBeNull(); expect(a['lint.hover'](h, { id: 'l1', from: 3, to: 3 }).hover).toBeNull()
    expect(a['lint.forget'](s1, { ids: ['l1'] }).results).toEqual({}); expect(a['lint.forget'](s1, { keep: [] }).results).toEqual({}); expect(a['lint.forget'](s1, { keep: ['l1'] })).toBe(s1)
    expect(a['lint.status'](s, { status: 'ready' }).status).toBe('ready'); expect(a['lint.status'](s, { status: 'bogus' })).toBe(s)
  })
  it('preferences: on is absolute; ignore adds once and unignore removes; junk is nothing', () => {
    const d = lintPrefsDecl('t-lint-prefs-2'), a = d.actions
    expect(d.initial.on).toBe(true)
    const off = a['lint.on'](d.initial, { on: false }); expect(off.on).toBe(false); expect(a['lint.on'](off, { on: false })).toBe(off); expect(a['lint.on'](off, { on: true }).on).toBe(true)
    const ig = a['lint.ignore'](d.initial, { key: 's:teh' }); expect(ig.ignored).toEqual(['s:teh']); expect(a['lint.ignore'](ig, { key: 's:teh' })).toBe(ig)
    expect(a['lint.ignore'](ig, { key: '' })).toBe(ig); expect(a['lint.unignore'](ig, { key: 's:teh' }).ignored).toEqual([]); expect(a['lint.unignore'](ig, { key: 'nope' })).toBe(ig)
  })
})

describe('the personal dictionary', () => {
  it('words are letters, digits, an apostrophe, hyphen or dot; the later op wins; matching is by lowercase', () => {
    expect(cleanWord(' Hix ')).toBe('Hix'); expect(cleanWord('don’t')).toBe("don't"); for (const bad of ['', 'two words', 'x'.repeat(70), '<b>', 7, '-x']) expect(cleanWord(bad)).toBeNull()
    const d = dictDecl('t-dict-2'), a = d.actions
    let s = d.initial
    s = a['dict.add'](s, { word: 'Hix' }); expect(s.words.hix).toEqual({ word: 'Hix', on: true }); expect(a['dict.add'](s, { word: 'Hix' })).toBe(s)
    s = a['dict.remove'](s, { word: 'hix' }); expect(s.words.hix.on).toBe(false)
    s = a['dict.add'](s, { word: 'HIX' }); expect(s.words.hix).toEqual({ word: 'HIX', on: true })
    expect(a['dict.add'](s, { word: 'two words' })).toBe(s); expect(a['dict.add'](s, null)).toBe(s)
  })
  it('the view is the server words plus the ops not acknowledged yet, in order', () => {
    const w = dictWords(['Hix', 'zai'], [{ type: 'dict.add', payload: { word: 'Nova' } }, { type: 'dict.remove', payload: { word: 'zai' } }, { type: 'dict.add', payload: { word: 'bad word' } }])
    expect([...w].sort()).toEqual(['hix', 'nova']); expect(dictWords(null, null).size).toBe(0)
  })
  it('the op log is delivered in order to the sink, which adopts the server list; offline leaves it pending; a refusal is reported and acknowledged', async () => {
    const mem = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v) }, del: async (k) => { m.delete(k) }, keys: async () => [...m.keys()] } }
    const posted = [], adopted = []; let offline = true, refuse = null
    const post = async (ops) => { if (offline) throw Object.assign(new Error('offline'), { offline: true }); if (refuse) throw new Error(refuse); posted.push(ops); return { words: ['Hix'] } }
    const r = createReplica(dictDecl('t-dict-3'), { storage: mem(), device: 'd1', transport: dictSink({ post, adopt: (w) => adopted.push(w), refuse: (m) => adopted.push(`refused: ${m}`) }) })
    r.dispatch('dict.add', { word: 'Hix' }); r.dispatch('dict.remove', { word: 'old' })
    await expect(r.sync()).rejects.toThrow(); expect(r.pending.length).toBe(2)
    offline = false; await r.sync(); expect(r.pending.length).toBe(0)
    expect(posted).toEqual([[{ type: 'dict.add', payload: { word: 'Hix' } }, { type: 'dict.remove', payload: { word: 'old' } }]]); expect(adopted).toEqual([['Hix']])
    refuse = 'full'; r.dispatch('dict.add', { word: 'More' }); await r.sync(); expect(r.pending.length).toBe(0); expect(adopted.at(-1)).toBe('refused: full')
    expect(() => dictSink({})).toThrow()
  })
})

// ------------------------------------------------------------------------------------------------ the DOM end, over a fake editor
function fakeEditor(lines) {
  const subs = new Set(), state = { composing: null, hover: null }
  const root = { listeners: {}, ownerDocument: null, addEventListener(t, f) { (this.listeners[t] ||= []).push(f) }, removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f) }, closest: () => null }
  const W = { performance: { now: () => Date.now() }, requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: (n) => clearTimeout(n), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (n) => clearTimeout(n), CSS: { highlights: new Map() }, Highlight: class { constructor(...r) { this.r = r; this.size = r.length } } }
  root.ownerDocument = { defaultView: W }
  const ed = {
    root, state, lines, rowText: (id) => lines[id] ?? null,
    get items() { return Object.keys(lines).map((id) => ({ key: id, addr: id })) }, get window() { return { start: 0, end: Object.keys(lines).length } },
    rangeOf: (id, from, to) => ({ id, from, to, getClientRects: () => [{ left: from * 10, right: to * 10, top: 0, bottom: 20 }] }),
    addrAtPoint: (x) => ({ id: Object.keys(lines)[0], off: Math.floor(x / 10) }),
    subscribe: (f) => { subs.add(f); return () => subs.delete(f) }, notify: () => { for (const f of subs) f({}, {}) },
  }
  return { ed, W, root }
}
const stores = () => {
  const mem = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v) }, del: async (k) => { m.delete(k) }, keys: async () => [...m.keys()] } }
  const mk = (decl) => createReplica(decl, { storage: mem(), device: 'd' })
  return { prefs: mk(lintPrefsDecl(`t-p-${Math.random()}`)), view: mk(lintViewDecl(`t-v-${Math.random()}`)) }
}
const tick = (ms = 30) => new Promise((ok) => setTimeout(ok, ms))

describe('mountLint over a fake editor', () => {
  it('checks each line once, again only when its text changed, and stores the result under the line and the hash of the text', async () => {
    const { ed } = fakeEditor({ l1: 'this is teh line', l2: 'fine words', l3: '' }), s = stores(), asked = []
    const check = async (text) => { asked.push(text); return text.includes('teh') ? [{ start: 8, end: 11, kind: 'Typo', message: 'x', suggestions: ['the'], text: 'teh' }] : [] }
    const m = mountLint({ editor: ed, ...s, check, prose: (t) => proseOf(t), debounceMs: 20, firstMs: 0 })
    await tick(80)
    expect(asked.sort()).toEqual(['fine words', 'this is teh line'])                       // the blank line is never sent
    expect(s.view.get().results.l1).toMatchObject({ h: lintHash('this is teh line') }); expect(s.view.get().results.l1.items[0]).toMatchObject({ from: 8, to: 11, cls: 'spelling' })
    ed.notify(); await tick(80); expect(asked.length).toBe(2)                              // nothing changed: nothing sent
    ed.lines.l2 = 'fine wrods'; ed.notify(); await tick(100)
    expect(asked.filter((t) => t === 'fine wrods').length).toBe(1)
    expect(m.shown('l1').map((i) => i.word)).toEqual(['teh'])
    ed.lines.l1 = 'this is the line'; expect(m.shown('l1')).toEqual([])                    // the text changed: the old result is never shown for it
    m.dispose()
  })
  it('a result for text that changed while the checker ran is dropped; a checker that throws is not asked again for that text', async () => {
    const { ed } = fakeEditor({ l1: 'first text' }), s = stores(); let calls = 0, release
    const gate = new Promise((ok) => { release = ok })
    const check = async () => { calls += 1; await gate; return [] }
    const m = mountLint({ editor: ed, ...s, check, prose: (t) => proseOf(t), firstMs: 0, debounceMs: 5 })
    await tick(30); ed.lines.l1 = 'second text'; release(); await tick(60)
    expect(s.view.get().results.l1?.h).not.toBe(lintHash('first text'))
    m.dispose()
    const e2 = fakeEditor({ l1: 'boom text' }), s2 = stores(); let n = 0
    const m2 = mountLint({ editor: e2.ed, ...s2, check: async () => { n += 1; throw new Error('x') }, prose: (t) => proseOf(t), firstMs: 0 })
    await tick(60); e2.ed.notify(); await tick(60)
    expect(n).toBe(1); expect(s2.view.get().status).toBe('error')            // not hammered: one ask, then a backoff
    m2.dispose()
    // a failure is not final: after its backoff the same text is asked again, and the first success clears the error
    const e3 = fakeEditor({ l1: 'retry text' }), s3 = stores(); let k = 0
    const m3 = mountLint({ editor: e3.ed, ...s3, check: async () => { k += 1; if (k < 3) throw new Error('binary not loaded'); return [] }, prose: (t) => proseOf(t), firstMs: 0, retryMs: 30, retryMaxMs: 200 })
    await tick(500)
    expect(k).toBe(3); expect(s3.view.get().results.l1).toMatchObject({ h: lintHash('retry text'), items: [] }); expect(s3.view.get().status).toBe('ready'); m3.dispose()
  })
  it('hover: the finding under the pointer is state and a highlight over editor.rangeOf; away clears both; the dictionary and Ignore remove it; nothing at rest', async () => {
    const { ed, W, root } = fakeEditor({ l1: 'this is teh line' }), s = stores()
    const check = async () => [{ start: 8, end: 11, kind: 'Typo', message: 'x', suggestions: ['the'], text: 'teh' }]
    let words = new Set()
    const m = mountLint({ editor: ed, ...s, check, prose: (t) => proseOf(t), dict: () => words, firstMs: 0 })
    await tick(40)
    expect(W.CSS.highlights.size).toBe(0); expect(s.view.get().hover).toBeNull()                          // at rest nothing is drawn
    const move = (x) => root.listeners.pointermove[0]({ clientX: x, clientY: 10, target: root })
    move(95); await tick(30)                                                                              // x 95 is off 9, not in teh (80..110: yes it is)
    expect(s.view.get().hover).toEqual({ id: 'l1', from: 8, to: 11, cls: 'spelling' })
    expect(W.CSS.highlights.get('zai-lint').r[0]).toMatchObject({ id: 'l1', from: 8, to: 11 })
    move(20); await tick(30); expect(s.view.get().hover).toBeNull(); expect(W.CSS.highlights.size).toBe(0)
    move(95); await tick(30); expect(W.CSS.highlights.size).toBe(1)
    root.listeners.pointerleave[0](); await tick(30); expect(W.CSS.highlights.size).toBe(0)
    move(95); await tick(30); s.prefs.dispatch('lint.ignore', { key: 's:teh' }); await tick(30)
    expect(W.CSS.highlights.size).toBe(0); expect(s.view.get().hover).toBeNull()                          // ignored: gone at once
    s.prefs.dispatch('lint.unignore', { key: 's:teh' }); words = new Set(['teh']); expect(m.shown('l1')).toEqual([])
    words = new Set(); s.prefs.dispatch('lint.on', { on: false }); move(95); await tick(30); expect(W.CSS.highlights.size).toBe(0)
    m.dispose()
  })
  it('a pinned hover (a menu is open) survives the pointer leaving', async () => {
    const { ed, W, root } = fakeEditor({ l1: 'this is teh line' }), s = stores()
    let pinned = false
    const m = mountLint({ editor: ed, ...s, check: async () => [{ start: 8, end: 11, kind: 'Typo', message: 'x', suggestions: [], text: 'teh' }], prose: (t) => proseOf(t), firstMs: 0, pinned: () => pinned })
    await tick(40); root.listeners.pointermove[0]({ clientX: 95, clientY: 10, target: root }); await tick(30)
    pinned = true; root.listeners.pointerleave[0](); root.listeners.pointermove[0]({ clientX: 20, clientY: 10, target: root }); await tick(30)
    expect(W.CSS.highlights.size).toBe(1); expect(s.view.get().hover).not.toBeNull()
    m.dispose(); expect(W.CSS.highlights.size).toBe(0)
  })
})

describe('workerCheck', () => {
  const fakeWorker = (answer) => { const w = { posted: [], onmessage: null, terminated: false, postMessage(m) { this.posted.push(m); Promise.resolve().then(() => answer?.(m, this)) }, terminate() { this.terminated = true } }; return w }
  it('makes the worker on the first check (after idle), matches answers by id, rejects an error and a timeout, remakes a crashed worker', async () => {
    let made = 0, idled = 0, w
    const check = workerCheck({ loadTimeoutMs: 400, spawn: () => { made += 1; w = fakeWorker((m, self) => { if (m.text === 'bad') self.onmessage({ data: { id: m.id, error: 'boom' } }); else if (m.text !== 'never') self.onmessage({ data: { id: m.id, items: [{ start: 0, end: 1, kind: 'Typo' }] } }) }); return w }, idle: async () => { idled += 1 }, timeoutMs: 40 })
    expect(made).toBe(0)
    const [a, b] = await Promise.all([check('x'), check('y')]); expect(a.length).toBe(1); expect(b.length).toBe(1); expect(made).toBe(1); expect(idled).toBe(1)
    await expect(check('bad')).rejects.toThrow('boom')
    const t0 = Date.now(); await expect(check('never')).rejects.toThrow('timed out'); expect(Date.now() - t0, 'before ready: the long load bound').toBeGreaterThanOrEqual(350)
    w.onmessage({ data: { ready: true } });
    const t1 = Date.now(); await expect(check('never')).rejects.toThrow('timed out'); expect(Date.now() - t1, 'after ready: the request bound').toBeLessThan(300); w.onmessage({ data: { id: 999, items: [] } })                       // stray messages are ignored
    const pending = check('never'); w.onerror(); await expect(pending).rejects.toThrow('crashed'); expect(w.terminated).toBe(true)
    expect((await check('z')).length).toBe(1); expect(made).toBe(2)
    check.dispose()
  })
})
