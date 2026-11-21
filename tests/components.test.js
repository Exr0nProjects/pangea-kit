import { describe, expect, it } from 'vitest'
import { toggle, modes, listSelect, search, searchRows, connection, scrollAnchor, documentCursor, undoHistory, undone, redone, resolve, gesture, inPlace, keymap, declareComponent, pyStrip, registry } from '../lib/components.js'
import { createApp, declare, fold, step } from '../lib/model.js'
import { createStore } from '../lib/store.js'
import { checkLaws } from '../lib/laws.js'
import { gens } from '../conformance/gens.js'

const mem = () => { const m = {}; return { m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v }, removeItem: (k) => { delete m[k] } } }
const run = (comp, steps) => { const d = declare(declareComponent(comp.kind, comp, { scope: 'ephemeral' })); let s = comp.initial; const errs = []; for (const [n, p = {}] of steps) { const r = resolve(comp, s, n, p); if (!r) continue; const o = step(d, s, r[0], r[1]); s = o.state; errs.push(o.error) } return { s, errs } }

describe('toggle', () => {
  it('next resolves to an absolute set of the following option, wrapping', () => {
    const t = toggle(['a', 'b'])
    expect(resolve(t, t.initial, 'next')).toEqual(['set', { value: 'b' }])
    expect(resolve(t, { value: 'b', index: 1 }, 'next')).toEqual(['set', { value: 'a' }])
  })
  it('a rebased next keeps the value the user saw it go to (relative toggle would flip twice)', () => {
    const t = toggle(['a', 'b']); const [op, p] = resolve(t, t.initial, 'next')
    const s1 = t.actions[op](t.initial, p); expect(t.actions[op](s1, p)).toBe(s1)
  })
  it('rejects bad option lists; ignores unknown values', () => {
    expect(() => toggle([])).toThrow(); expect(() => toggle(['a', 'a'])).toThrow()
    const t = toggle(['a']); expect(t.actions.set(t.initial, { value: 'z' })).toBe(t.initial)
  })
})

describe('modes (editor modes, a lifecycle)', () => {
  it('refuses an undeclared edge through the replica and keeps the state', () => {
    const m = modes(['normal', 'insert', 'visual'], { transitions: { normal: ['insert', 'visual'], insert: ['normal'], visual: ['normal'] } })
    const r = createApp({ storage: mem(), device: 'd' }).use(declare(declareComponent('mode', m, { scope: 'ephemeral' })))
    r.dispatch('set', { mode: 'insert' })
    expect(() => r.dispatch('set', { mode: 'visual' })).toThrow(/InvalidTransition/)
    expect(r.get().mode).toBe('insert')
  })
})

describe('listSelect', () => {
  it('deselect remembers; restore clamps; move from nothing restores', () => {
    expect(run(listSelect(), [['select', { index: 4 }], ['deselect'], ['restore', { row_count: 3 }]]).s).toEqual({ cursor: 2, anchor: 2, suspended: false })
    expect(run(listSelect(), [['move', { delta: 3, row_count: 5 }]]).s.cursor).toBe(0)
    expect(run(listSelect(), [['select', { index: 1 }], ['move', { delta: 9, row_count: 3 }]]).s.cursor).toBe(2)
  })
  it('deselect is idempotent (anchor survives a second deselect)', () => {
    const l = listSelect(); const s = run(l, [['select', { index: 2 }], ['deselect']]).s
    expect(l.actions.deselect(s)).toBe(s); expect(s.anchor).toBe(2)
  })
})

describe('search', () => {
  it('strips exactly Python whitespace', () => {
    expect(pyStrip('\u0085\u001c x\ufeff \u3000')).toBe('x\ufeff')
    expect(run(search(), [['update', { value: '  hi ' }], ['commit']]).s).toEqual({ active: false, value: '  hi ', committed: 'hi' })
  })
  it('searchRows filters by the committed query over string and number values', () => {
    expect(searchRows([{ a: 'Foo' }, { a: 3 }, { a: 'bar' }], { committed: 'fo' })).toEqual([{ a: 'Foo' }])
    expect(searchRows([{ a: 1 }], { committed: '' })).toEqual([{ a: 1 }])
  })
})

describe('connection', () => {
  it('connect gesture carries the absolute attempt, so a redelivery does not double count', () => {
    const c = connection(); const r = createApp({ storage: mem(), device: 'd' }).use(declare(declareComponent('conn', c, { scope: 'ephemeral' })))
    const e = gesture(r, c, 'connect', { url: 'ws://a' })
    expect(e.payload).toEqual({ url: 'ws://a', attempt: 1 })
    expect(r.dispatch('connect', e.payload)).toBeNull()
    expect(r.get().attempt_count).toBe(1)
  })
  it('refuses opened before connect, and connected -> connecting', () => {
    const { errs, s } = run(connection(), [['opened'], ['connect', { url: 'u' }], ['opened'], ['connect', { url: 'v' }]])
    expect(errs).toEqual(['InvalidTransition', null, null, 'InvalidTransition']); expect(s.state).toBe('connected')
  })
  it('a replayed log skips a refused transition on every replica alike', () => {
    const c = connection(); const d = declare(declareComponent('conn', c, { scope: 'ephemeral' }))
    const s = fold(d, c.initial, [{ type: 'opened', payload: {} }, { type: 'connect', payload: { url: 'u', attempt: 1 } }])
    expect(s.state).toBe('connecting')
  })
})

describe('scrollAnchor and documentCursor', () => {
  it('scroll anchor modes', () => {
    expect(run(scrollAnchor(), [['user_scrolled', { top_block_id: 'p', offset: 9 }], ['snap_to_block', { block_id: 'q' }]]).s).toEqual({ mode: 'manual', anchor_id: 'q', offset_px: 0 })
  })
  it('cursor collapse keeps the caret', () => {
    expect(run(documentCursor(), [['set_with_selection', { para_id: 'b', offset: 2, sel_anchor_para: 'a', sel_anchor_offset: 1 }], ['collapse_selection']]).s).toEqual({ para_id: 'b', offset: 2, sel_anchor_para: null, sel_anchor_offset: null })
  })
})

describe('undoHistory', () => {
  const rec = (id, a, cb = null, ca = null) => ['record', { id, actions: [a], cursor_before: cb, cursor_after: ca }]
  it('undo inside an open batch undoes the whole batch and loses nothing', () => {
    const u = undoHistory(); const before = run(u, [rec('a', 1), ['batch', { open: true }], rec('b', 2), rec('c', 3)]).s
    const after = run(u, [rec('a', 1), ['batch', { open: true }], rec('b', 2), rec('c', 3), ['undo']]).s
    expect(after.position).toBe(1); expect(after.entries[1].actions).toEqual([2, 3])
    expect(undone(before, after).map((e) => e.ids)).toEqual([['b', 'c']])
    expect(run(u, [rec('a', 1), ['batch', { open: true }], rec('b', 2), rec('c', 3), ['undo'], ['redo']]).s.position).toBe(2)
  })
  it('a batch keeps the first cursor_before even when it is null', () => {
    const s = run(undoHistory(), [['batch', { open: true }], rec('a', 1, null, 1), rec('b', 2, 1, 2), ['batch', { open: false }]]).s
    expect(s.entries[0]).toEqual({ ids: ['a', 'b'], actions: [1, 2], cursor_before: null, cursor_after: 2 })
  })
  it('opening an open batch and closing an empty one drop nothing', () => {
    expect(run(undoHistory(), [['batch', { open: true }], rec('a', 1), ['batch', { open: true }], ['batch', { open: false }]]).s.entries[0].ids).toEqual(['a'])
    const s = run(undoHistory(), [rec('a', 1), ['undo'], ['batch', { open: true }], ['batch', { open: false }]]).s
    expect(s.entries.length).toBe(1); expect(s.position).toBe(0)
  })
  it('a new edit drops redo; a redelivered record is a no-op; redone lists re-applied entries', () => {
    const u = undoHistory(); const s = run(u, [rec('a', 1), rec('b', 2), ['undo'], rec('c', 3)]).s
    expect(s.entries.map((e) => e.ids[0])).toEqual(['a', 'c'])
    expect(u.actions.record(s, { id: 'c', actions: [3] })).toBe(s)
    const b = run(u, [rec('a', 1), ['undo']]).s; const a = u.actions.seek(b, { position: 1 })
    expect(redone(b, a).map((e) => e.ids)).toEqual([['a']])
  })
  it('two devices that both undo once converge one step back (seek is absolute)', () => {
    const s = run(undoHistory(), [rec('a', 1), rec('b', 2), ['seek', { position: 1 }], ['seek', { position: 1 }]]).s
    expect(s.position).toBe(1)
  })
})

describe('inPlace on a quicklook store', () => {
  it('a pure component runs on a store path, and store undo restores it', () => {
    const state = {}; const st = createStore({ state }); st.component('list', inPlace(listSelect()))
    st.dispatch('list/select', { index: 2 }, { undoable: true })
    expect(state.list).toEqual({ cursor: 2, anchor: 2, suspended: false })
    st.undo(); expect(state.list).toEqual({ cursor: null, anchor: 0, suspended: false })
  })
})

describe('keymap', () => {
  const comps = { mode: modes(['normal', 'insert']), list: listSelect(), undo: undoHistory(), dialog: toggle(['closed', 'open']) }
  const states = { mode: { mode: 'normal' }, list: { cursor: 1, anchor: 1, suspended: false }, undo: { entries: [{ ids: ['a'], actions: [], cursor_before: null, cursor_after: null }], position: 1, batch: null }, dialog: { value: 'closed', index: 0 } }
  const km = keymap([
    { when: (c) => c.get('dialog').value === 'open', capture: true, keys: { Escape: ['dialog', 'set', { value: 'closed' }] } },
    { when: (c) => c.get('mode').mode === 'insert', capture: true, keys: { Escape: ['mode', 'set', { mode: 'normal' }] } },
    { keys: { j: (c) => ['list', 'move', { delta: 1, row_count: c.rows }], i: ['mode', 'set', { mode: 'insert' }], u: ['undo', 'undo'] } },
  ])
  const ctx = (over = {}) => { const s = { ...states, ...over }; return { rows: 5, get: (t) => s[t] } }
  it('normal-mode keys resolve gestures to absolute actions', () => {
    expect(km.route('j', ctx(), comps)).toEqual({ target: 'list', op: 'select', payload: { index: 2 } })
    expect(km.route('u', ctx(), comps)).toEqual({ target: 'undo', op: 'seek', payload: { position: 0 } })
    expect(km.route('x', ctx(), comps)).toBeNull()
  })
  it('insert mode captures typing; a modal captures everything first', () => {
    expect(km.route('j', ctx({ mode: { mode: 'insert' } }), comps)).toBe('captured')
    expect(km.route('Escape', ctx({ mode: { mode: 'insert' } }), comps)).toEqual({ target: 'mode', op: 'set', payload: { mode: 'normal' } })
    expect(km.route('Escape', ctx({ mode: { mode: 'insert' }, dialog: { value: 'open', index: 1 } }), comps).target).toBe('dialog')
  })
})

describe('generated laws (lib/laws.js)', () => {
  for (const [kind, { args, gen }] of Object.entries(gens)) {
    it(`${kind} keeps every law over 200 seeded sequences`, () => { expect(checkLaws(registry[kind](...args), gen)).toEqual([]) })
  }
  // the laws must distinguish the contract from plausible broken components
  const t = () => toggle(['a', 'b'])
  const tgen = gens.toggle.gen
  const broken = {
    'returns a fresh equal object on a no-op': () => { const c = t(); return { ...c, actions: { set: (s, { value } = {}) => (['a', 'b'].includes(value) ? { value, index: ['a', 'b'].indexOf(value) } : s) } } },
    'mutates its state': () => { const c = t(); return { ...c, actions: { set: (s, { value } = {}) => { if (value === s.value || !['a', 'b'].includes(value)) return s; s.value = value; return { ...s } } } } },
    'is relative (a toggle op in the log)': () => { const c = t(); return { ...c, actions: { set: (s) => ({ value: s.value === 'a' ? 'b' : 'a', index: s.index ? 0 : 1 }) } } },
    'throws on a junk payload': () => { const c = t(); return { ...c, actions: { set: (s, p) => { if (!['a', 'b'].includes(p.value)) throw new Error('bad'); return s.value === p.value ? s : { value: p.value, index: ['a', 'b'].indexOf(p.value) } } } } },
    'stores a non-JSON value': () => { const c = t(); return { ...c, actions: { set: (s, { value } = {}) => (s.value === value ? s : { value, index: undefined, at: new Date(0) }) } } },
  }
  for (const [what, make] of Object.entries(broken)) {
    it(`catches a component that ${what}`, () => { expect(checkLaws(make(), (r, s, o) => tgen(r, s, o).map((x) => (x?.value === 'mine' ? { value: 'a' } : x)), { seeds: 50 }).length).toBeGreaterThan(0) })
  }
  it('catches a log component that does not dedupe a redelivered record', () => {
    const u = undoHistory(); const bad = { ...u, actions: { ...u.actions, record: (s, p = {}) => (typeof p.id === 'string' && Array.isArray(p.actions) ? { ...s, entries: [...s.entries.slice(0, s.position), { ids: [p.id], actions: p.actions, cursor_before: null, cursor_after: null }], position: s.position + 1 } : s) } }
    expect(checkLaws(bad, gens.undoHistory.gen, { seeds: 50 }).map((f) => f.law)).toContain('dedupe')
  })
})

describe('keymap from DOM events (lib/keys.js specs)', () => {
  it('routes mod+z to undo and respects layers', () => {
    const comps = { undo: undoHistory(), mode: modes(['normal', 'insert']) }
    const s = { undo: { entries: [{ ids: ['a'], actions: [], cursor_before: null, cursor_after: null }], position: 1, batch: null }, mode: { mode: 'normal' } }
    const km = keymap([{ when: (c) => c.get('mode').mode === 'insert', capture: true, keys: {} }, { keys: { 'mod+z': ['undo', 'undo'], 'mod+shift+z': ['undo', 'redo'] } }])
    const ev = (o) => ({ key: 'z', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o })
    expect(km.routeEvent(ev({ metaKey: true }), { get: (t) => s[t] }, comps, true)).toEqual({ target: 'undo', op: 'seek', payload: { position: 0 } })
    expect(km.routeEvent(ev({}), { get: (t) => s[t] }, comps, true)).toBeNull()
    expect(km.routeEvent(ev({ metaKey: true }), { get: (t) => (t === 'mode' ? { mode: 'insert' } : s[t]) }, comps, true)).toBe('captured')
  })
})

describe('declare: lifecycle and conflict axes', () => {
  const base = { name: 'x', initial: { state: 'a' }, actions: { go: (s, { to }) => (s.state === to ? s : { state: to }) } }
  it('validates the declaration', () => {
    expect(declare(base).conflict).toBe('lww')
    expect(() => declare({ ...base, conflict: 'merge' })).toThrow(/conflict/)
    expect(() => declare({ ...base, states: ['a', 'b'], transitions: { a: ['b'] } })).toThrow(/transitions must list/)
    expect(() => declare({ ...base, states: ['a'], transitions: { a: ['z'] } })).toThrow(/unknown state/)
    expect(() => declare({ ...base, states: ['b'], transitions: { b: [] } })).toThrow(/initial.state/)
    expect(() => declare({ ...base, states: ['a'], transitions: { a: [] }, terminal: ['q'] })).toThrow(/terminal/)
  })
  it('a terminal state is final, in dispatch and in a replayed fold', () => {
    const d = declare({ ...base, scope: 'ephemeral', states: ['a', 'b', 'c'], transitions: { a: ['b'], b: ['a', 'c'], c: ['a'] }, terminal: ['c'] })
    expect(step(d, { state: 'b' }, 'go', { to: 'c' }).error).toBeNull()
    expect(step(d, { state: 'c' }, 'go', { to: 'a' }).error).toBe('TerminalState')
    expect(step(d, { state: 'a' }, 'go', { to: 'c' }).error).toBe('InvalidTransition')
    expect(fold(d, { state: 'a' }, [{ type: 'go', payload: { to: 'b' } }, { type: 'go', payload: { to: 'c' } }, { type: 'go', payload: { to: 'a' } }])).toEqual({ state: 'c' })
    const r = createApp({ storage: mem(), device: 'd' }).use(d)
    r.dispatch('go', { to: 'b' }); r.dispatch('go', { to: 'c' })
    expect(() => r.dispatch('go', { to: 'a' })).toThrow(/TerminalState/)
  })
})
