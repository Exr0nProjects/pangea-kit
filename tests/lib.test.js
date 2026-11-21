import { describe, it, expect, vi } from 'vitest'
import { applyPatch, stripTransient } from '../lib/util.js'
import { hydrate, schedulePersist, flushPersist, RuntimeAbort } from '../lib/persist.js'
import { createStore, replay } from '../lib/store.js'
import { selection } from '../lib/components.js'
import { createKeys, isTyping, parseSpec, matches } from '../lib/keys.js'
import { createData } from '../lib/data.js'
import { planChange } from '../lib/parts.js'
import { createKitStorage } from '../host/storage.js'
import { createReporter, connectLive } from '../lib/live.js'

const fakeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m } }

describe('applyPatch: a push writes only the keys it names', () => {
  it('leaves camera, selection and unnamed controls alone', () => {
    const s = { camera: { p: [1, 2, 3] }, em: { contrast: 1, gamma: 1 }, sel: { ids: [1] } }
    applyPatch(s, { em: { contrast: 2.2 } })
    expect(s).toEqual({ camera: { p: [1, 2, 3] }, em: { contrast: 2.2, gamma: 1 }, sel: { ids: [1] } })
  })
  it('assigns arrays whole and creates missing objects', () => {
    const s = { sel: { ids: [1, 2] } }
    applyPatch(s, { sel: { ids: [9] }, layers: { a: true } })
    expect(s).toEqual({ sel: { ids: [9] }, layers: { a: true } })
  })
  it('stripTransient drops _keys at any depth', () => {
    expect(stripTransient({ a: 1, _x: 2, b: { _y: 1, c: [{ _z: 1, d: 2 }] } })).toEqual({ a: 1, b: { c: [{ d: 2 }] } })
  })
})

describe('persist contract (viewer5) with injected storage', () => {
  it('a null initial value (unset camera) takes the persisted object instead of throwing', () => {
    const storage = fakeStorage()
    storage.setItem('k', JSON.stringify({ version: 1, state: { camera: { p: [1, 2, 3], t: [0, 0, 0] }, a: 2 } }))
    const r = hydrate({ key: 'k', version: 1, initial: { camera: null, a: 1 }, storage })
    expect(r).toEqual({ camera: { p: [1, 2, 3], t: [0, 0, 0] }, a: 2 })
  })
  it('3-tier hydrate, upcasters, abort without clobbering, archive before migrate', () => {
    const storage = fakeStorage()
    storage.setItem('k', JSON.stringify({ version: 1, state: { a: 1 } }))
    const r = hydrate({ key: 'k', version: 3, initial: { a: 0, b: 0, c: 0 }, storage, migrations: { 2: (s) => ({ ...s, b: 5 }), 3: (s) => ({ ...s, c: s.b + 1 }) } })
    expect([r.a, r.b, r.c]).toEqual([1, 5, 6])
    expect([...storage.m.keys()].some((k) => k.startsWith('__archive__k__'))).toBe(true)
    storage.setItem('j', JSON.stringify({ version: 1, state: { a: 1 } }))
    expect(() => hydrate({ key: 'j', version: 2, initial: { a: 0 }, storage, migrations: {} })).toThrow(RuntimeAbort)
    expect(JSON.parse(storage.getItem('j')).version).toBe(1)
  })
  it('persists a $state-like proxy without transient keys, debounced, flushable', () => {
    vi.useFakeTimers()
    const storage = fakeStorage()
    const state = { a: 1, _t: 2, cam: { p: [1, 2] } }
    schedulePersist('p', 1, state, { storage })
    expect(storage.getItem('p')).toBe(null)
    flushPersist('p')
    const rec = JSON.parse(storage.getItem('p'))
    expect(rec.state).toEqual({ a: 1, cam: { p: [1, 2] } })
    expect(rec.savedAt).toBeGreaterThan(0)
    vi.useRealTimers()
  })
})

describe('store: absolute actions over an op log', () => {
  const mk = (extra = {}) => createStore({ state: { layers: { a: true }, cam: { p: [0, 0, 1] } }, ...extra })
  it('set and patch are absolute and touch only their paths', () => {
    const s = mk()
    s.dispatch('set', { path: 'layers.b', value: false })
    s.dispatch('patch', { cam: { t: [1, 1, 1] } })
    expect(s.state).toEqual({ layers: { a: true, b: false }, cam: { p: [0, 0, 1], t: [1, 1, 1] } })
  })
  it('is idempotent by id (a reload or reconnect never applies a push twice)', () => {
    const s = mk()
    expect(s.apply({ id: 'push:1', op: 'set', payload: { path: 'x', value: 1 } })).not.toBe(null)
    expect(s.apply({ id: 'push:1', op: 'set', payload: { path: 'x', value: 2 } })).toBe(null)
    expect(s.state.x).toBe(1)
    const s2 = mk({ log: s.log })
    expect(s2.apply({ id: 'push:1', op: 'set', payload: { path: 'x', value: 3 } })).toBe(null)
  })
  it('transient (_) paths are written but never logged or persisted-triggering', () => {
    const calls = []
    const s = mk({ onAction: (a) => calls.push(a) })
    s.dispatch('set', { path: '_info.sel', value: 'x' })
    expect(s.state._info.sel).toBe('x'); expect(s.log.length).toBe(0); expect(calls.length).toBe(0)
  })
  it('unknown ops fail loudly', () => { expect(() => mk().dispatch('nope', {})).toThrow(/unknown action/) })
  it('undo is a compensating restore from the captured pre-state, including removal of new keys', () => {
    const s = mk()
    s.dispatch('set', { path: 'layers.a', value: false }, { undoable: true })
    s.dispatch('set', { path: 'layers.new', value: 1 }, { undoable: true })
    expect(s.canUndo).toBe(true)
    s.undo(); expect('new' in s.state.layers).toBe(false)
    s.undo(); expect(s.state.layers.a).toBe(true)
    expect(s.undo()).toBe(null)
  })
  it('coalesces a slider sweep into one log entry that still undoes to the start', () => {
    const s = mk({ now: (() => { let t = 0; return () => (t += 10) })() })
    for (const v of [1, 2, 3, 4]) s.dispatch('set', { path: 'em.contrast', value: v })
    expect(s.log.length).toBe(1)
    expect(s.log[0].prev['em.contrast']).toBe(undefined)
  })
  it('components: selection reducers are namespaced, absolute and undoable', () => {
    const s = mk()
    s.component('sel', selection())
    s.dispatch('sel/set', { ids: [3, 4, 3], picks: [3, 4] }, { undoable: true })
    expect(s.state.sel).toEqual({ ids: [3, 4], picks: [3, 4] })
    s.dispatch('sel/include', { id: 9, on: true })
    s.dispatch('sel/include', { id: 3, on: false })
    expect(s.state.sel.ids).toEqual([4, 9])
    s.dispatch('sel/clear', {}, { undoable: true })
    s.undo()
    expect(s.state.sel.ids).toEqual([4, 9])
  })
  it('replay of the log from the initial state equals the live state (time travel)', () => {
    const init = { layers: { a: true }, cam: { p: [0, 0, 1] } }
    const setup = (st) => st.component('sel', selection())
    const s = createStore({ state: structuredClone(init) })
    setup(s)
    s.dispatch('set', { path: 'layers.a', value: false }, { undoable: true })
    s.dispatch('sel/set', { ids: [1, 2] }, { undoable: true })
    s.dispatch('patch', { cam: { p: [5, 5, 5] } })
    s.undo()
    s.dispatch('sel/include', { id: 7, on: true })
    expect(replay(init, s.log, setup)).toEqual(s.state)
  })
})

describe('keys', () => {
  const ev = (o) => ({ key: 'g', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...o })
  const mkEvent = (o, target) => { const e = new KeyboardEvent('keydown', { cancelable: true, ...ev(o) }); Object.defineProperty(e, 'target', { value: target }); return e }
  it('matches mod+alt+digit by physical key (macOS Option rewrites the character)', () => {
    const sp = parseSpec('mod+alt+1', true)
    expect(matches(ev({ key: '¡', code: 'Digit1', metaKey: true, altKey: true }), sp)).toBe(true)
    expect(matches(ev({ key: '¡', code: 'Digit2', metaKey: true, altKey: true }), sp)).toBe(false)
    expect(matches(ev({ key: '1', code: 'Digit1', metaKey: true }), sp)).toBe(false)
  })
  it('falls back to the physical key when the character is unreliable', () => {
    const m = (o, spec) => matches(ev(o), parseSpec(spec, true))
    expect(m({ key: '!', code: 'Digit1', metaKey: true, shiftKey: true }, 'mod+1')).toBe(true)
    expect(m({ key: '≥', code: 'Period', metaKey: true, altKey: true, shiftKey: true }, 'mod+alt+shift+.')).toBe(true)
    expect(m({ key: 'Dead', code: 'KeyE', metaKey: true, altKey: true }, 'mod+alt+e')).toBe(true)
    // Dvorak: the printed character decides for letters and punctuation
    expect(m({ key: 'j', code: 'KeyC', metaKey: true }, 'mod+j')).toBe(true)
    expect(m({ key: 'j', code: 'KeyC', metaKey: true }, 'mod+c')).toBe(false)
    expect(m({ key: '.', code: 'KeyE', metaKey: true }, 'mod+.')).toBe(true)
  })
  it('matches letters strictly on shift and requires named modifiers', () => {
    expect(matches(ev({}), parseSpec('g'))).toBe(true)
    expect(matches(ev({ key: 'G', shiftKey: true }), parseSpec('g'))).toBe(false)
    expect(matches(ev({ key: 'G', shiftKey: true }), parseSpec('shift+g'))).toBe(true)
    expect(matches(ev({ ctrlKey: true }), parseSpec('g'))).toBe(false)
    expect(matches(ev({ metaKey: true, key: 'z' }), parseSpec('mod+z', true))).toBe(true)
    expect(matches(ev({ key: '?', shiftKey: true }), parseSpec('?'))).toBe(true)
  })
  it('a shifted punctuation chord arrives as the shifted character: "mod+shift+." matches key ">" and stays apart from "mod+."', () => {
    const rev = parseSpec('mod+shift+.', true), fwd = parseSpec('mod+.', true)
    expect(matches(ev({ metaKey: true, shiftKey: true, key: '>' }), rev)).toBe(true)
    expect(matches(ev({ metaKey: true, shiftKey: true, key: '.' }), rev)).toBe(true)
    expect(matches(ev({ metaKey: true, key: '.' }), rev)).toBe(false)
    expect(matches(ev({ metaKey: true, shiftKey: true, key: '>' }), fwd)).toBe(false)
    expect(matches(ev({ metaKey: true, key: '.' }), fwd)).toBe(true)
    expect(matches(ev({ metaKey: true, shiftKey: true, key: '<' }), rev)).toBe(false)
    expect(matches(ev({ metaKey: true, shiftKey: true, key: '?' }), parseSpec('mod+shift+/', true))).toBe(true)
    expect(matches(ev({ metaKey: true, shiftKey: true, key: 'B' }), parseSpec('mod+shift+b', true))).toBe(true)
    expect(matches(ev({ metaKey: true, key: 'b' }), parseSpec('mod+shift+b', true))).toBe(false)
  })
  it('never fires in text fields and never touches emacs chords', () => {
    const w = new EventTarget(); w.document = document
    const k = createKeys(w, { mac: true })
    const calls = []
    k.bind({ g: () => calls.push('g'), a: () => calls.push('a'), p: () => calls.push('p') })
    const input = document.createElement('input'); input.type = 'text'; document.body.append(input)
    const fire = (o, target) => { const e = mkEvent(o, target); w.dispatchEvent(e); e.__p = e.defaultPrevented || undefined; return e }
    const inText = fire({ key: 'g' }, input); expect(calls).toEqual([]); expect(inText.__p).toBeUndefined()
    const ctrlA = fire({ key: 'a', ctrlKey: true }, document.body); expect(calls).toEqual([]); expect(ctrlA.__p).toBeUndefined()
    const ctrlP = fire({ key: 'p', ctrlKey: true }, document.body); expect(calls).toEqual([]); expect(ctrlP.__p).toBeUndefined()
    const plain = fire({ key: 'g' }, document.body); expect(calls).toEqual(['g']); expect(plain.__p).toBe(true)
    fire({ key: 'g', repeat: true }, document.body); expect(calls).toEqual(['g'])
    const range = document.createElement('input'); range.type = 'range'
    fire({ key: 'p' }, range); expect(calls).toEqual(['g', 'p'])
    expect(isTyping(document.createElement('textarea'))).toBe(true)
  })
  it('unbind removes only that binding; the newest binding of a key wins', () => {
    const w = new EventTarget(); w.document = document
    const k = createKeys(w, { mac: true }); const calls = []
    const off1 = k.bind({ g: () => calls.push(1) }); const off2 = k.bind({ g: () => calls.push(2) })
    const fire = () => w.dispatchEvent(mkEvent({}, document.body))
    fire(); off2(); fire(); off1(); fire()
    expect(calls).toEqual([2, 1])
  })
})

describe('data layer: independent versions, memo survives, one file swaps one layer', () => {
  const mkFetch = () => { const calls = []; const f = async (u) => { calls.push(u); return { ok: true, json: async () => ({ u }), arrayBuffer: async () => new ArrayBuffer(4) } }; return { f, calls } }
  it('fetches each (file, hash) once and keys the URL by hash', async () => {
    const { f, calls } = mkFetch(); const d = createData({ fetchImpl: f })
    d.setManifest({ 'a.json': 'h1', 'b.json': 'h2' })
    await Promise.all([d.json('a.json'), d.json('a.json'), d.json('b.json')])
    await d.json('a.json')
    expect(calls).toEqual(['a.json?v=h1', 'b.json?v=h2'])
  })
  it('a change to b refetches only b, notifies only b watchers, and keeps a memo that depends on a', async () => {
    const { f, calls } = mkFetch(); const d = createData({ fetchImpl: f })
    d.setManifest({ 'a.json': 'h1', 'b.json': 'h2' })
    await d.json('a.json'); await d.json('b.json')
    const built = []
    const mA = () => d.memo('geoA', ['a.json'], () => { built.push('A'); return {} })
    const mB = () => d.memo('geoB', ['b.json'], () => { built.push('B'); return {} })
    const a1 = mA(); mB()
    const seen = []; d.watch('b.json', (n, v) => seen.push([n, v])); d.watch('a.json', () => seen.push('A!'))
    const r = d.setManifest({ 'a.json': 'h1', 'b.json': 'h3' })
    expect(r.changed).toEqual(['b.json']); expect(seen).toEqual([['b.json', 'h3']])
    expect(mA()).toBe(a1); mB()
    await d.json('a.json'); await d.json('b.json')
    expect(built).toEqual(['A', 'B', 'B'])
    expect(calls).toEqual(['a.json?v=h1', 'b.json?v=h2', 'b.json?v=h3'])
  })
  it('a newly added file notifies its watcher (a cells layer appears live)', () => {
    const d = createData({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }); d.setManifest({ 'a.json': '1' })
    const seen = []; d.watch('cells.json', (n) => seen.push(n))
    d.setManifest({ 'a.json': '1', 'cells.json': '9' })
    expect(seen).toEqual(['cells.json'])
  })
  it('a memo that rejected is dropped so the next caller retries', async () => {
    const d = createData({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }); d.setManifest({ 'a.json': '1' })
    let n = 0
    const get = () => d.memo('k', ['a.json'], () => (++n === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('fine')))
    await expect(get()).rejects.toThrow('boom')
    await new Promise((r) => setTimeout(r, 0))
    expect(await get()).toBe('fine')
  })
  it('a failed fetch is retried, not cached', async () => {
    let n = 0; const d = createData({ fetchImpl: async () => (++n === 1 ? { ok: false, status: 500 } : { ok: true, json: async () => ({ ok: 1 }) }) })
    d.setManifest({ 'a.json': '1' })
    await expect(d.json('a.json')).rejects.toThrow(/500/)
    expect(await d.json('a.json')).toEqual({ ok: 1 })
  })
})

describe('planChange: what a changed manifest means', () => {
  it('maps files to the smallest action', () => {
    const prev = { 'index.html': 'i', 'state.js': 's', 'parts/em.js': 'e1', 'parts/panel.js': 'p1', 'vessels.json': 'v', 'cells.json': 'c1' }
    const next = { 'index.html': 'i', 'state.js': 's', 'parts/em.js': 'e2', 'parts/panel.js': 'p1', 'vessels.json': 'v', 'cells.json': 'c2', 'parts/new.js': 'n' }
    expect(planChange(prev, next)).toEqual({ reload: false, schema: false, parts: ['parts/em.js', 'parts/new.js'], removedParts: [], data: ['cells.json'] })
    expect(planChange(prev, { ...prev, 'index.html': 'x', 'state.js': 't' })).toMatchObject({ reload: true, schema: true, parts: [] })
    const { 'parts/em.js': _, ...rest } = prev
    expect(planChange(prev, rest).removedParts).toEqual(['parts/em.js'])
  })
})

describe('kit storage (no localStorage in the sandbox)', () => {
  it('survives a reload through window.name and prefers the newer of window.name and the server record', () => {
    const win = { name: '' }; const posted = []
    const a = createKitStorage({ win, key: 'k', post: (k, v) => posted.push([k, v]) })
    a.setItem('k', JSON.stringify({ savedAt: 5, state: { x: 1 } }))
    expect(posted.length).toBe(1)
    const b = createKitStorage({ win, key: 'k', serverRecord: { savedAt: 3, state: { x: 0 } } })
    expect(JSON.parse(b.getItem('k')).state.x).toBe(1)
    const c = createKitStorage({ win: { name: '' }, key: 'k', serverRecord: { savedAt: 3, state: { x: 0 } } })
    expect(JSON.parse(c.getItem('k')).state.x).toBe(0)
  })
  it('never overwrites a window.name it does not own; archives keep the last three', () => {
    const win = { name: 'someone-elses' }
    const s = createKitStorage({ win, key: 'k' }); s.setItem('k', '{}')
    expect(win.name).toBe('someone-elses')
    const w2 = { name: '' }; const t = createKitStorage({ win: w2, key: 'k' })
    for (let i = 0; i < 5; i++) t.setItem(`__archive__k__${i}`, String(i))
    expect(t.archives.map((a) => a.v)).toEqual(['2', '3', '4'])
  })
})

describe('live client', () => {
  it('reporter coalesces: one in flight, the newest wins', async () => {
    vi.useFakeTimers(); const sent = []; let release
    const r = createReporter({ fetchImpl: (u, o) => { sent.push(o.body); return new Promise((res) => { release = res }) }, delay: 10 })
    r.report('1'); r.report('2'); await vi.advanceTimersByTimeAsync(20)
    r.report('3'); r.report('4'); await vi.advanceTimersByTimeAsync(20)
    expect(sent).toEqual(['2'])
    release(); await vi.advanceTimersByTimeAsync(1); release?.(); await vi.advanceTimersByTimeAsync(1)
    expect(sent).toEqual(['2', '4'])
    vi.useRealTimers()
  })
  it('routes hello/code to onFiles and state to onState', () => {
    const handlers = {}
    class ES { constructor(u) { this.u = u } addEventListener(n, f) { handlers[n] = f } close() {} }
    const files = [], states = []
    connectLive({ onFiles: (f, k) => files.push([f, k]), onState: (s) => states.push(s), EventSourceImpl: ES })
    handlers.hello({ data: '{"files":{"a":"1"}}' }); handlers.code({ data: '{"files":{"a":"2"}}' }); handlers.state({ data: '{"actions":[]}' }); handlers.state({ data: 'garbage' })
    expect(files).toEqual([[{ a: '1' }, 'hello'], [{ a: '2' }, 'code']]); expect(states).toEqual([{ actions: [] }])
  })
})

describe('formatOver', () => {
  it('votes by covered text per line; unformatted differs from formatted', async () => {
    const { formatOver, MIXED } = await import('../lib/editor/format.js')
    const seg = (body, from = 0, to = body.length) => ({ body, from, to })
    expect(formatOver([seg('abc'), seg('def')]).font).toBe(null)
    expect(formatOver([seg('abc'), seg(''), seg('x', 0, 0)]).font).toBe(null)
    expect(formatOver([seg('abc'), seg('def')], { barriers: () => [[0, 1]] }).font).toBe(null)
  })
  it('mixed only when formatted text differs', async () => {
    const { formatOver, MIXED } = await import('../lib/editor/format.js')
    const g = '<span data-f="georgia">abc</span>'
    const seg = (body) => ({ body, from: 0, to: body.length })
    expect(formatOver([seg(g), seg(g)]).font).toBe('georgia')
    expect(formatOver([seg(g), seg('plain')]).font).toBe(MIXED)
  })
})
