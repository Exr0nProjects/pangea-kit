// lib/testing/convergence.js and convergence-sync.js: the multi-device convergence fuzz (moved up from zai2,
// zai-pangea 2b0e0b2), run on the kit's line document (lib/testing/example/lines.model.js), plus the rows.js stamp-floor
// regressions it found (bug 1: clock skew or a same-millisecond reopen dropped edits).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { runConvergenceFuzz, fuzzSeed, replay, formatFailure } from '../lib/testing/convergence.js'
import { syncActions, runSync, shrinkSync, showActions } from '../lib/testing/convergence-sync.js'
import { casStep, inverse } from '../lib/history.js'
import { openRows } from '../lib/engine/rows.js'
import { createMemoryStreamServer } from '../lib/stream-fake.js'
import model from '../lib/testing/example/lines.model.js'
import * as D from '../lib/testing/example/lines.js'

globalThis.IDBKeyRange ??= IDBKeyRange
const SEEDS = Number(process.env.FUZZ_SEEDS || 1000)
const SYNC_SEEDS = Number(process.env.SYNC_SEEDS || 200)

describe(`convergence fuzz, ${SEEDS} seeds per mode`, () => {
  for (const mode of ['concurrent', 'causal', 'undoAll']) {
    it(`${mode}: holds on the kit history`, () => {
      const r = runConvergenceFuzz(model, { seeds: SEEDS, modes: [mode] })
      if (!r.ok) expect.fail(r.failures.map(formatFailure).join('\n\n'))
      expect(r.ops).toBe(SEEDS * (mode === 'undoAll' ? 30 : 40))
    }, 300_000)
  }
  it('a seed replays exactly: the same verdict and the same tape twice', () => {
    for (const mode of ['concurrent', 'causal']) for (const s of [3, 12, 42]) expect(fuzzSeed(model, mode, s)).toEqual(fuzzSeed(model, mode, s))
  })
})

// The harness finds each bug when it is planted back, and shrinks the failing run to a few steps.
const unguarded = (now) => { const undos = [], redos = []; let seq = 0; const fresh = (p) => casStep(p, [], null, { now }).puts
  return { record(inv, puts) { undos.push({ op: `h${++seq}`, back: inv, forward: puts }); redos.length = 0; return `h${seq}` },
    undo() { const e = undos.pop(); if (!e) return null; redos.push(e); return { op: e.op, puts: fresh(e.back) } },
    redo() { const e = redos.pop(); if (!e) return null; undos.push(e); return { op: e.op, puts: fresh(e.forward) } } } }
const firstFailure = (m, mode, max = 3000) => { for (let s = 1; s <= max; s++) if (fuzzSeed(m, mode, s, { shrink: false })) return fuzzSeed(m, mode, s); return null }
describe('the harness catches the planted bugs and shrinks them', () => {
  it('an action-log undo with no compare-and-set: revives a remote delete (concurrent) and duplicates text (causal)', () => {
    const m = { ...model, history: unguarded, inverse: (b, p, now) => inverse(b, p, { ...D.CAS, carry: [], now }) }
    const c = firstFailure(m, 'concurrent'); expect(c?.error).toMatch(/revived|duplicated/)
    expect(c.minimal.steps).toBeLessThan(c.minimal.of); expect(c.minimal.error).toBeTruthy()
    expect(replay(m, 'concurrent', c.seed, c.minimal.tape)).toBeTruthy()
    expect(replay(model, 'concurrent', c.seed, c.minimal.tape)).toBe(null) // the same minimal run passes on the fix
    const k = firstFailure(m, 'causal'); expect(k?.error).toMatch(/duplicated/)
  })
  it('removal inverses without the line words: duplicates text', () => {
    const m = { ...model, inverse: (b, p, now) => inverse(b, p, { ...D.CAS, carry: [], now }) }
    const f = firstFailure(m, 'concurrent', 3000); expect(f?.error).toMatch(/duplicated/); console.log(`no carry: seed ${f.seed} fails, shrunk to ${f.minimal.steps} of ${f.minimal.of} steps`)
  }, 120_000)
})

describe(`sync fuzz through openRows, ${SYNC_SEEDS} seeds, seeded virtual clock`, () => {
  const env = { IDBFactory, timers: { install: (now) => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now }), advance: (ms) => vi.advanceTimersByTimeAsync(ms), uninstall: () => { vi.clearAllTimers(); vi.useRealTimers() } } }
  it('a seed replays exactly', async () => {
    for (const seed of [3, 12, 42]) expect(await runSync(model, syncActions(seed), env)).toBe(await runSync(model, syncActions(seed), env))
  })
  it('converges with outages, lost acks and killed tabs', async () => {
    for (let seed = 1; seed <= SYNC_SEEDS; seed++) {
      const input = syncActions(seed), bad = await runSync(model, input, env)
      if (bad) { const min = await shrinkSync(model, input, env); expect.fail(`seed ${seed}: ${bad}\nminimal (${min.actions.length} actions): ${showActions(min)}\n${await runSync(model, min, env)}`) }
    }
  }, 600_000)
})

// bug 1, verified in rows.js (stamp floor + per-field pending coalescing): the shrinker's minimal sequence
describe('rows.js: a local write always beats the value it overwrites', () => {
  const NAME = 'qk-test-stamp-floor'
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: new Date('2026-11-08T12:00:00Z') }))
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
  it('a reopened tab editing in the same millisecond wins, locally and on every replica', async () => {
    const server = createMemoryStreamServer(), idb = new IDBFactory()
    const open = (i) => openRows({ name: NAME, indexedDB: i, transport: server, sortKey: D.sortKey, live: D.isLive, Broadcast: null })
    for (let attempt = 0; attempt < 20; attempt++) { // writer ids are random: repeat so both tie-break orders occur
      const a = await open(idb); await a.load({ from: null })
      const line = D.append(a.view.rows(), 'timeline', `old ${attempt}`); a.put([line]); await a.flushed(); await a.close()
      const b = await open(idb); await b.load({ from: null })
      b.put(D.typed(b.view.get(line.id), `new ${attempt}`).puts)
      expect(b.view.get(line.id).body).toBe(`new ${attempt}`)
      await b.sync()
      const c = await open(new IDBFactory()); await c.sync(); await c.load({ from: null })
      expect(c.view.get(line.id).body).toBe(`new ${attempt}`)
      await b.close(); await c.close()
    }
  })
  it('a device whose clock runs behind still overwrites a value from a device whose clock runs ahead', async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const server = createMemoryStreamServer()
      const ahead = await openRows({ name: NAME, indexedDB: new IDBFactory(), transport: server, sortKey: D.sortKey, live: D.isLive, Broadcast: null, now: () => Date.now() + 60_000 })
      const behind = await openRows({ name: NAME, indexedDB: new IDBFactory(), transport: server, sortKey: D.sortKey, live: D.isLive, Broadcast: null })
      await ahead.load({ from: null }); await behind.load({ from: null })
      const line = D.append([], 'timeline', 'from the future'); ahead.put([line]); await ahead.sync(); await behind.sync()
      for (let k = 0; k < 3; k++) { behind.put(D.typed(behind.view.get(line.id), `edit ${k}`).puts); expect(behind.view.get(line.id).body).toBe(`edit ${k}`) }
      await behind.sync(); await ahead.sync()
      expect(ahead.view.get(line.id).body).toBe('edit 2')
      await ahead.close(); await behind.close()
    }
  })
})
