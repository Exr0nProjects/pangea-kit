// declare() as a closed, executing declaration (PANGEA3-DESIGN A10; conformance rows #10, #23, #26, #28, #34, #35, #38).
// Every check here has a planted violation that must turn it red.
import { describe, it, expect, beforeEach } from 'vitest'
import { declare, createReplica, step } from '../lib/model.js'
import { DECLARE_KEYS, NOT_EXECUTED, declarations, clearDeclarations } from '../lib/declare-keys.js'
import { UNDO_ACTION } from '../lib/undo.js'
import { defineView, clearViews, readView, findCycles } from '../lib/views.js'
import { validate, genericGen } from '../lib/validate.js'
import { field, set, on } from '../lib/schema.js'
import { memStorage } from '../lib/laws-ui/trace.js'

const base = () => ({ name: 'd', scope: 'local', initial: { a: 1 }, actions: { 'a.set': (s, { a } = {}) => (typeof a === 'number' && a !== s.a ? { ...s, a } : s) } })
const sync = (f) => f()

describe('closed key set (class 8: a declared capability with nothing executing it)', () => {
  it('accepts every key in the table', () => { expect(() => declare({ ...base(), version: 1, migrations: {}, normalize: (s) => s, firstPaint: true, owner: ['a.set'], budget: { 'a.set': { p95_ms: 50 } } })).not.toThrow() })
  it('refuses an unknown key (planted typo)', () => { expect(() => declare({ ...base(), scoep: 'local' })).toThrow(/unknown key "scoep"/) })
  for (const k of Object.keys(NOT_EXECUTED)) {
    it(`refuses the unexecuted axis ${k}`, () => { expect(() => declare({ ...base(), [k]: 'x' })).toThrow(new RegExp(`"${k}" is not`)) })
  }
  it('the accepted keys and the refused axes do not overlap', () => { for (const k of Object.keys(NOT_EXECUTED)) expect(DECLARE_KEYS).not.toHaveProperty(k) })
  it('lifecycle keys without states are refused', () => { expect(() => declare({ ...base(), terminal: ['x'] })).toThrow(/need states/) })
  it('declaring a declaration returns it', () => { const d = declare(base()); expect(declare(d)).toBe(d) })
})

describe('the UI contract is refused at declare time (GUIDE 3e)', () => {
  const life = () => ({ name: 'w', scope: 'ephemeral', initial: { state: 'idle' }, states: ['idle', 'sending', 'failed'], transitions: { idle: ['sending'], sending: ['idle'], failed: ['idle'] }, actions: { go: (s, { to } = {}) => (typeof to === 'string' && to !== s.state ? { state: to } : s) } })
  it('a wait without a declared exit edge', () => { expect(() => declare({ ...life(), waits: { sending: { to: 'failed' } } })).toThrow(/not a declared transition/) })
  it('a wait on an undeclared state', () => { expect(() => declare({ ...life(), waits: { nope: { to: 'idle' } } })).toThrow(/not a declared state/) })
  it('a wait with an exit edge is accepted', () => { expect(() => declare({ ...life(), transitions: { idle: ['sending'], sending: ['idle', 'failed'], failed: ['idle'] }, waits: { sending: { to: 'failed', deadline_ms: 15000 } } })).not.toThrow() })
  it('a budget for an action that does not exist', () => { expect(() => declare({ ...base(), budget: { typo: { p95_ms: 30 } } })).toThrow(/not an action/) })
  it('an owner action that is not declared', () => { expect(() => declare({ ...base(), owner: ['nope'] })).toThrow(/owner action "nope"/) })
})

describe('conflict: executed or refused, never silently accepted (row #23)', () => {
  it('crdt is refused until a CRDT merge exists', () => { expect(() => declare({ ...base(), conflict: 'crdt' })).toThrow(/conflict "crdt" is not executed/) })
  it('a value outside the set is refused', () => { expect(() => declare({ ...base(), conflict: 'lwww' })).toThrow(/conflict must be lww or log/) })
  it('log turns the noLoss law on and lww does not', async () => {
    const { uiContract } = await import('../lib/laws-ui/contract.js')
    expect(uiContract(declare({ ...base(), name: 'c-log', conflict: 'log' })).laws.noLoss).toBe(true)
    expect(uiContract(declare({ ...base(), name: 'c-lww' })).laws.noLoss).toBe(false)
  })
})

describe('undo axis (row #26): absolute seek over history.js compare-and-set', () => {
  const doc = (extra = {}) => declare({ name: 'u', scope: 'local', undo: 'compensating', fields: { title: field(''), n: field(0) }, actions: { title: set('title', 'title'), n: set('n', 'n') }, ...extra })
  const open = (d, storage = memStorage()) => createReplica(d, { storage, device: 'd1', schedule: sync })
  it('undo and redo restore by value, logged forward as new actions', () => {
    const r = open(doc())
    r.dispatch('title', { title: 'a' }); r.dispatch('title', { title: 'b' }); r.dispatch('n', { n: 3 })
    expect(r.history).toEqual({ position: 3, length: 3 })
    r.undo(); expect(r.get()).toEqual({ title: 'b', n: 0 })
    r.undo(); expect(r.get()).toEqual({ title: 'a', n: 0 })
    r.redo(); expect(r.get()).toEqual({ title: 'b', n: 0 })
    expect(r.history).toEqual({ position: 2, length: 3 })
  })
  it('seek is absolute: a doubled seek to the position the user saw minus one steps back once (planted: relative undo twice steps twice)', () => {
    const r = open(doc())
    r.dispatch('title', { title: 'a' }); r.dispatch('title', { title: 'b' })
    const seen = r.history.position
    r.seek(seen - 1); r.seek(seen - 1)
    expect(r.get().title).toBe('a')
    const q = open(doc(), memStorage()); q.dispatch('title', { title: 'a' }); q.dispatch('title', { title: 'b' }); q.undo(); q.undo()
    expect(q.get().title).toBe('') // the relative gesture twice really does go two steps: why buttons resolve to seek
  })
  it('a field another writer changed since wins: the step is skipped and dropped', () => {
    const r = open(doc())
    r.dispatch('title', { title: 'a' })
    r.dispatch(UNDO_ACTION, { set: { title: 'remote' } }) // stands in for a remote change of the same field
    const out = r.undo()
    expect(out.conflicts).toBe(1)
    expect(r.get().title).toBe('remote')
    expect(r.history).toEqual({ position: 0, length: 0 })
  })
  it('a declaration without the axis has no undo (planted: the axis is what adds it)', () => {
    const r = open(declare({ name: 'nu', scope: 'local', fields: { t: field('') }, actions: { t: set('t', 't') } }))
    expect(r.undo).toBeUndefined()
  })
  it('refuses stack, a lifecycle with undo, unknown options and the reserved action name', () => {
    expect(() => doc({ undo: 'stack' })).toThrow(/undo "stack" is not executed/)
    expect(() => doc({ undo: { model: 'compensating', depth: 3 } })).toThrow(/undo takes/)
    expect(() => declare({ name: 'ul', scope: 'local', undo: 'compensating', initial: { state: 'a' }, states: ['a', 'b'], transitions: { a: ['b'], b: ['a'] }, actions: { go: (s) => s } })).toThrow(/undo with a lifecycle/)
    expect(() => declare({ ...base(), undo: 'compensating', actions: { ...base().actions, [UNDO_ACTION]: (s) => s } })).toThrow(/reserved/)
  })
  it('the undo action is total and idempotent', () => {
    const d = doc()
    for (const p of [null, 7, 'x', [], { set: 3 }, { set: { nope: 1 } }, { unset: 'title' }]) expect(step(d, d.initial, UNDO_ACTION, p).state).toBe(d.initial)
    const once = step(d, d.initial, UNDO_ACTION, { set: { title: 'z' } }).state
    expect(step(d, once, UNDO_ACTION, { set: { title: 'z' } }).state).toBe(once)
  })
})

describe('registry, views and validate() (rows #34, #35, #38)', () => {
  beforeEach(() => { clearDeclarations(); clearViews() })
  it('every declare() is recorded by name', () => {
    declare(base()); declare({ ...base(), name: 'e' })
    expect(declarations().decls.map((d) => d.name)).toEqual(['d', 'e'])
  })
  it('a lawful declaration passes with every action covered', async () => {
    declare({ name: 'prefs', scope: 'local', fields: { width: field(300, (v) => (typeof v === 'number' && v > 0 ? v : 300)), open: field(false, Boolean) }, actions: { width: set('width', 'px'), open: set('open', 'open') } })
    const r = await validate({ timing: false })
    expect(r.failures).toEqual([])
    expect(r.decls[0].coverage.width).toBeGreaterThan(0)
  })
  it('planted: a relative (toggle) action fails idempotent', async () => {
    declare({ name: 't', scope: 'ephemeral', initial: { on: false }, actions: { flip: (s) => ({ on: !s.on }) } })
    const r = await validate({ timing: false })
    expect(r.failures.map((f) => f.law)).toContain('idempotent')
  })
  it('planted: an action that throws on a junk payload fails total', async () => {
    declare({ name: 'th', scope: 'ephemeral', initial: { a: 0 }, actions: { a: (s, p) => { if (typeof p.a !== 'number') throw new Error('bad'); return p.a === s.a ? s : { a: p.a } } } })
    const r = await validate({ timing: false })
    expect(r.failures.map((f) => f.law)).toContain('total')
  })
  it('planted: a persisted declaration whose reducer throws reports total from the UI laws too, with a seed, never a bare exception', async () => {
    declare({ name: 'thl', scope: 'local', initial: { a: 0 }, actions: { a: (s, p) => { if (typeof p.a !== 'number') throw new Error('bad'); return p.a === s.a ? s : { a: p.a } } } })
    const r = await validate()
    expect(r.failures.map((f) => f.law)).not.toContain('ui')
    expect(r.failures.some((f) => f.law === 'total' && f.seed && /threw: bad/.test(f.detail))).toBe(true)
    expect(r.failures.some((f) => f.law === 'total' && /reducerBudget/.test(f.detail))).toBe(true)
  })
  it('a set(field, key) action is reached by the generic generator through its declared payload key', async () => {
    const d = declare({ name: 'sk', scope: 'local', fields: { folded: field(false, Boolean) }, actions: { fold: set('folded', 'shut') } })
    expect(d.actions.fold.payloadKey).toBe('shut')
    const r = await validate({ timing: false })
    expect(r.failures).toEqual([])
    expect(r.decls[0].coverage.fold).toBeGreaterThan(0)
  })
  it('planted: an action the generator never exercises fails coverage, and a supplied generator fixes it', async () => {
    const d = declare({ name: 'cv', scope: 'ephemeral', initial: { secret: '' }, actions: { unlock: (s, { pass } = {}) => (pass === 'swordfish-42' && !s.secret ? { secret: 'open' } : s) } })
    expect((await validate({ timing: false })).failures.map((f) => f.law)).toContain('coverage')
    const gens = { cv: (r) => ['unlock', { pass: r.chance(0.5) ? 'swordfish-42' : 'no' }] }
    expect((await validate({ decls: [d], gens, timing: false })).failures).toEqual([])
  })
  it('planted: a state that changes on every hydrate (non-idempotent normalize) fails reloadRestores', async () => {
    declare({ name: 'lost', scope: 'local', initial: { a: 0, loads: 0 }, normalize: (s) => ({ ...s, loads: s.loads + 1 }), actions: { a: (s, { a } = {}) => (typeof a === 'number' && a !== s.a ? { ...s, a } : s) } })
    expect((await validate({ timing: false })).failures.map((f) => f.law)).toContain('reloadRestores')
  })
  it('planted: a view cycle fails the DAG check', async () => {
    declare(base())
    defineView({ name: 'v1', from: ['v2'], fn: (x) => x })
    defineView({ name: 'v2', from: ['v1'], fn: (x) => x })
    const r = await validate({ timing: false })
    expect(r.failures.map((f) => f.law)).toContain('cycle')
  })
  it('planted: a view that mutates its input fails pure; one reading an undeclared name fails reference', async () => {
    declare(base())
    defineView({ name: 'mut', from: ['d'], fn: (s) => { s.a = 2; return s } })
    defineView({ name: 'dangling', from: ['nowhere'], fn: (x) => x })
    const laws = (await validate({ timing: false })).failures.map((f) => f.law)
    expect(laws).toContain('reference')
    clearViews(); defineView({ name: 'mut', from: ['d'], fn: (s) => { s.a = 2; return s } })
    expect((await validate({ timing: false })).failures.map((f) => f.law)).toContain('pure')
  })
  it('planted: a view reading the clock is refused at define time', () => {
    expect(() => defineView({ name: 'clock', from: ['d'], fn: (s) => ({ ...s, at: Date.now() }) })).toThrow(/impure view/)
  })
  it('a pure view computes and memoizes on input references', () => {
    let calls = 0
    const v = defineView({ name: 'double', from: ['d'], fn: (s) => { calls++; return { a2: s.a * 2 } } })
    const st = { a: 3 }
    expect(readView(v, () => st)).toEqual({ a2: 6 }); readView(v, () => st)
    expect(calls).toBe(1)
  })
  it('findCycles finds a self loop and a long cycle and nothing in a DAG', () => {
    expect(findCycles(new Map([['a', ['a']]]))).toEqual([['a']])
    expect(findCycles(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]])).length).toBe(1)
    expect(findCycles(new Map([['a', ['b']], ['b', []]]))).toEqual([])
  })
  it('the generic generator only emits declared actions and object payloads', () => {
    const d = declare(base()), g = genericGen(d)
    const r = { int: (lo) => lo + 1, pick: (xs) => xs[0], chance: () => true, next: () => 0.5 }
    const [a, p] = g(r, d.initial)
    expect(Object.keys(d.actions)).toContain(a); expect(typeof p).toBe('object')
  })
})
