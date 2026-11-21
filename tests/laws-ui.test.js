import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { declare, step } from '../lib/model.js'
import { assign } from '../lib/fields.js'
import { ui } from '../lib/laws.js'

const vectors = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../conformance/laws-ui/frames.json'), 'utf8'))

// A sidebar-like declaration: what webchat's folders state is, in a dozen lines.
const folders = () => ({
  name: 'folders', scope: 'local',
  initial: { open: {}, order: [] },
  actions: {
    'folder.open': (s, { key, open }) => (Boolean(s.open[key]) === Boolean(open) ? s : assign(s, { open: { ...s.open, [key]: Boolean(open) } })),
    'folder.add': (s, { key }) => (s.order.includes(key) ? s : assign(s, { order: [...s.order, key] })),
  },
  owner: ['folder.add'],
})
const gen = (r) => (r.chance(0.5) ? ['folder.open', { key: r.pick(['a', 'b', 'c']), open: r.chance(0.5) }] : ['folder.add', { key: r.pick(['a', 'b', 'c', 'd']) }])

describe('contract: declaring state turns the laws on, the author writes numbers', () => {
  it('defaults every action to the 100 ms interaction budget and persisted scopes to firstPaint/reloadRestores', () => {
    const c = ui.uiContract(declare(folders()))
    expect(c.budgets['folder.open']).toMatchObject({ kind: 'interaction', p95_ms: 100 })
    expect(c.laws).toMatchObject({ firstPaint: true, reloadRestores: true, noLoss: true, tabsConverge: false })
  })
  it('an override is a number; a budget for something that is neither an action nor a named kind is refused', () => {
    const c = ui.uiContract(declare({ ...folders(), budget: { 'folder.open': { p95_ms: 30 }, switchChat: { kind: 'load', p95_ms: 300 } } }))
    expect(c.budgets['folder.open'].p95_ms).toBe(30)
    expect(c.budgets.switchChat).toMatchObject({ kind: 'load', p95_ms: 300 })
    expect(() => ui.uiContract(declare({ ...folders(), budget: { typo: { p95_ms: 30 } } }))).toThrow(/not an action/)
  })
  it('a wait state needs a declared exit edge (a stuck spinner cannot be declared)', () => {
    const base = { name: 'send', scope: 'ephemeral', initial: { state: 'idle' }, states: ['idle', 'sending', 'failed'], transitions: { idle: ['sending'], sending: ['idle'], failed: ['sending'] },
      actions: { go: (s, { to }) => ({ ...s, state: to }) } }
    expect(() => ui.uiContract(declare({ ...base, waits: { sending: { to: 'failed' } } }))).toThrow(/not a declared transition/)
    const ok = ui.uiContract(declare({ ...base, transitions: { ...base.transitions, sending: ['idle', 'failed'] }, waits: { sending: { to: 'failed' } } }))
    expect(ok.waits.sending.deadline_ms).toBe(15000)
  })
})

describe('frame law vectors (conformance/laws-ui/frames.json)', () => {
  for (const v of vectors) {
    it(`${v.law}: ${v.name}`, () => {
      const got = v.law === 'motion' ? ui.checkMotion(v.frames, v.key, v.spec)
        : v.law === 'settled' ? ui.checkSettled(v.frames, (f) => Object.fromEntries(Object.entries(f.els).map(([k, e]) => [k, e?.text])))
        : v.law === 'layoutStable' ? ui.checkLayoutStable(v.frames, v.keys)
        : ui.checkFlicker(v.frames, v.key)
      if (!v.want.length) expect(got).toEqual([])
      for (const w of v.want) expect(got.map((b) => b.detail).join(' | ')).toContain(w)
    })
  }
})

describe('model-level laws on a real declaration', () => {
  it('a well-formed declaration passes every law it turns on', async () => {
    const { failures } = await ui.checkUiLaws(folders(), gen, { timing: false })
    expect(failures).toEqual([])
  })
  it('a normalize that is not idempotent fails reloadRestores and firstPaint (state that drifts on every boot)', async () => {
    const drift = { ...folders(), name: 'drift', normalize: (s) => ({ ...s, boots: (s.boots || 0) + 1 }) }
    const { failures } = await ui.checkUiLaws(drift, gen, { timing: false, seeds: 10 })
    const laws = new Set(failures.map((f) => f.law))
    expect(laws.has('reloadRestores') || laws.has('firstPaint')).toBe(true)
  })
  it('cloud state converges across two devices with lost acks and redelivered pages', async () => {
    const cloud = { ...folders(), name: 'cloudfolders', scope: 'cloud' }
    expect(await ui.checkIdempotentRetryAndConverge(declare(cloud), gen, { seeds: 15 })).toEqual([])
  })
  it('settle syncs until two quiet rounds: a replica that loses acks in a row is not reported as diverged; planted: a reducer reading hidden per-process state is red', async () => {
    // a per-key last-writer-wins map: converges in any order; 200 seeds hit runs of lost acks and redelivered short pages
    const lww = declare({ name: 'lwwmap', scope: 'cloud', initial: { m: {} }, actions: { set: (s, { k, v, t } = {}) => (typeof k !== 'string' || !Number.isFinite(t) || (s.m[k] && (s.m[k].t > t || (s.m[k].t === t && s.m[k].v >= v))) ? s : { m: { ...s.m, [k]: { v, t } } }) } })
    const g = (r) => ['set', { k: `k${r.int(0, 2)}`, v: `v${r.int(0, 2 ** 20)}`, t: r.int(0, 50) }]
    expect(await ui.checkIdempotentRetryAndConverge(lww, g, { seeds: 200 })).toEqual([])
    // planted: a reducer that reads hidden per-process state (how many times it ran): replicas fold one order but run the
    // reducer a different number of times (refolds), so they disagree
    let calls = 0
    const hidden = declare({ name: 'hidden', scope: 'cloud', initial: { m: {} }, actions: { set: (s, { k } = {}) => (typeof k !== 'string' ? s : { m: { ...s.m, [k]: (calls += 1) } }) } })
    const bad = await ui.checkIdempotentRetryAndConverge(hidden, (r) => ['set', { k: `k${r.int(0, 1)}` }], { seeds: 10 })
    expect(bad.map((f) => f.law)).toContain('tabsConverge')
  }, 60000)
  it('reducerBudget flags an action that is O(n) per keystroke on a large state', () => {
    const slow = declare({ name: 'slow', scope: 'ephemeral', initial: { rows: [] },
      actions: { add: (s, { v }) => ({ rows: [...s.rows, v] }), touch: (s) => ({ rows: JSON.parse(JSON.stringify(s.rows)) }) } })
    const grow = (r) => ['add', { v: { id: String(r.next()), text: 'x'.repeat(40) } }]
    const probe = (r) => (r.chance(0.5) ? grow(r) : ['touch', {}])
    const bad = ui.reducerBudget(slow, probe, { grow: 20000, growGen: grow, probes: 40 })
    expect(bad.map((b) => b.name)).toEqual(['touch'])
  })
  it('reducerBudget ignores a noisy round (contention) but still flags a step slow in every round', () => {
    const decl = declare({ name: 'noisy', scope: 'ephemeral', initial: { n: 0 }, actions: { tick: (s) => ({ n: s.n + 1 }) } })
    const gen = () => ['tick', {}]
    const real = globalThis.performance.now.bind(globalThis.performance)
    const clock = (slowRounds) => { let calls = 0, t = 0; return () => { calls += 1; const probe = Math.floor((calls - 1) / 2); const round = Math.floor(probe / 20); t += calls % 2 === 0 ? (slowRounds(round) ? 10 : 0.01) : 0; return t } }
    const run = (slowRounds) => { globalThis.performance.now = clock(slowRounds); try { return ui.reducerBudget(decl, gen, { grow: 0, probes: 20, rounds: 3 }) } finally { globalThis.performance.now = real } }
    expect(run((round) => round === 0)).toEqual([])
    expect(run(() => true).map((b) => b.name)).toEqual(['tick'])
  })
})

describe('trace checks for engines the kit does not own', () => {
  it('checkLiveness: a hung request past its deadline with nothing armed is stuck', () => {
    expect(ui.checkLiveness([{ t: 0, pending: 1, armed: false, inflight: [{ since: 0 }] }, { t: 16000, pending: 1, armed: false, inflight: [{ since: 0 }] }])).toHaveLength(1)
    expect(ui.checkLiveness([{ t: 16000, pending: 1, armed: true, inflight: [{ since: 0 }] }])).toEqual([])
  })
  it('checkNoLossTrace and checkBoundedWork', () => {
    expect(ui.checkNoLossTrace(['a', 'b'], ['a'])).toHaveLength(1)
    expect(ui.checkBoundedWork([{ event: 'append', units: 1 }, { event: 'append', units: 3 }], { perEvent: 1 })).toHaveLength(1)
  })
  it('checkBudgets reads p95 against the declared budget and refuses unbudgeted interactions', () => {
    const c = ui.uiContract(declare(folders()))
    const samples = Array.from({ length: 20 }, (_, i) => ({ name: 'folder.open', ms: i < 19 ? 20 : 150 }))
    expect(ui.checkBudgets(c, samples)).toEqual([])
    expect(ui.checkBudgets(c, samples.map((s) => ({ ...s, ms: s.ms * 6 })))[0]).toMatchObject({ law: 'budget', name: 'folder.open' })
    expect(ui.checkBudgets(c, [{ name: 'mystery', ms: 1 }])[0].detail).toMatch(/no declared budget/)
  })
})

describe('coverage-guided fuzz', () => {
  // a planted bug only a three-step interleaving reaches: open a, add d, then close a loses d
  const buggy = declare({ ...folders(), name: 'buggy', actions: { ...folders().actions,
    'folder.open': (s, { key, open }) => (key === 'a' && !open && s.order.includes('d') && s.open.a ? assign(s, { order: s.order.filter((k) => k !== 'd'), open: { ...s.open, a: false } }) : folders().actions['folder.open'](s, { key, open })) } })
  const law = (prev, next) => (prev.order.some((k) => !next.order.includes(k)) ? 'an added folder vanished' : null)
  it('finds and shrinks it with state/interleaving coverage', async () => {
    const r = await ui.fuzz({ exec: ui.declExec(buggy, step, law), fresh: gen, runs: 3000, coverage: 'state' })
    expect(r.failures.length).toBeGreaterThan(0)
    expect(r.failures[0].steps.length).toBeLessThanOrEqual(3)
  })
  it('runs with V8 branch coverage as the feedback signal', async () => {
    const r = await ui.fuzz({ exec: ui.declExec(buggy, step, law), fresh: gen, runs: 400, coverage: 'v8', filter: /laws-ui\.test|model\.js/ })
    expect(r.features).toBeGreaterThan(5)
  })
})
