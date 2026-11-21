// Laws of the engine modules, checked over seeded random schedules (the engine's counterpart of lib/laws.js):
//   outbox:   no loss, one id per intent across retries, exactly-once at an idempotent server;
//   deadline: a newer call of the same key supersedes an unsettled older one; every call settles;
//   lane:     bounded, keeps the newest, and never touches the outbox however hard it is flooded;
//   jobs:     never two runs of one key at once, and no trigger is lost (each is followed by a run that started after it).
import { describe, expect, it } from 'vitest'
import { createSender, memoryOutbox } from '../lib/engine/outbox.js'
import { createDeadlineFetch } from '../lib/engine/deadline.js'
import { createTelemetryLane } from '../lib/engine/lane.js'
import { createJobs } from '../lib/engine/jobs.js'
import { ulidFactory } from '../lib/engine/ulid.js'

function rng(seed) { let s = seed | 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const flushMicro = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve() }
const SEEDS = 60

describe('outbox law: no loss, one id per intent, exactly once at an idempotent server', () => {
  it(`holds over ${SEEDS} random failure schedules`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed)
      const box = memoryOutbox({ limits: { maxItems: 1000 } })
      const applied = new Map() // id -> times applied (server dedupes, so must stay 1)
      const attemptsById = new Map()
      const send = async (e) => {
        attemptsById.set(e.id, (attemptsById.get(e.id) || 0) + 1)
        const roll = r()
        if (roll < 0.3) throw new Error('network')
        if (roll < 0.4) return { ok: false, status: 503 }
        if (roll < 0.5) { applied.set(e.id, applied.get(e.id) || 1); throw new Error('lost reply after apply') }
        if (!applied.has(e.id)) applied.set(e.id, 1)
        return { ok: true, status: 200 }
      }
      const timers = []
      const sender = createSender({ outbox: box, send, mintId: ulidFactory({ now: () => seed * 1000 }), retryMs: [1], setTimer: (fn) => { timers.push(fn); return timers.length }, clearTimer: () => {} })
      const enqueued = []
      for (let i = 0; i < 1 + Math.floor(r() * 12); i++) enqueued.push(await sender.enqueue(`s${Math.floor(r() * 3)}`, { i }))
      for (let round = 0; round < 400 && box.size().items; round++) { await flushMicro(); const t = timers.shift(); if (t) t(); else await sender.kick() }
      expect(box.size().items, `seed ${seed}`).toBe(0)
      expect([...applied.keys()].sort(), `seed ${seed}`).toEqual([...enqueued].sort())
      expect([...applied.values()].every((n) => n === 1)).toBe(true)
      for (const id of enqueued) expect(attemptsById.get(id)).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('deadline law: latest-wins per key, every call settles', () => {
  it(`holds over ${SEEDS} random call orders`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed)
      const pendingTimers = []
      const net = createDeadlineFetch(async () => { await new Promise((res) => pendingTimers.push(res)); return 'ok' }, { deadlines: { read: 1000 }, setTimer: () => 0, clearTimer: () => {} })
      const calls = []
      for (let i = 0; i < 10; i++) {
        const key = `k${Math.floor(r() * 2)}`
        const p = net.fetchWithin('read', '/x', {}, { key })
        const rec = { key, i, out: null }
        p.then(() => { rec.out = 'ok' }, (e) => { rec.out = e.name })
        calls.push(rec)
        if (r() < 0.3) { pendingTimers.shift()?.(); await flushMicro() }
      }
      while (pendingTimers.length) pendingTimers.shift()()
      await flushMicro(40)
      expect(calls.every((c) => c.out), `seed ${seed}`).toBe(true)
      for (const key of ['k0', 'k1']) {
        const mine = calls.filter((c) => c.key === key)
        // the last call of a key is never superseded; a superseded call always has a later call of its key
        if (mine.length) expect(mine[mine.length - 1].out).not.toBe('SupersededError')
        for (const c of mine.filter((x) => x.out === 'SupersededError')) expect(mine.some((x) => x.i > c.i)).toBe(true)
      }
    }
  })
})

describe('lane law: bounded, newest kept, outbox untouched', () => {
  it(`holds over ${SEEDS} floods`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed)
      const max = 1 + Math.floor(r() * 20)
      const lane = createTelemetryLane({ maxItems: max, setTimer: () => 0 })
      const box = memoryOutbox()
      let enq = 0, pushed = 0
      for (let i = 0; i < 300; i++) {
        if (r() < 0.05) { await box.put([{ id: `a${i}`, body: { i } }]); enq++ } else { lane.push({ n: pushed++ }) }
        expect(lane.depth()).toBeLessThanOrEqual(max)
      }
      expect(box.size().items).toBe(enq)
      expect(lane.counts().dropped).toBe(Math.max(0, pushed - max))
    }
  })
})

describe('jobs law: one run at a time per key, no lost trigger', () => {
  it(`holds over ${SEEDS} trigger schedules`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed)
      const jobs = createJobs({ yieldNow: () => Promise.resolve() })
      let running = 0, maxRunning = 0, runStarts = 0
      const gates = []
      const work = async () => { running++; maxRunning = Math.max(maxRunning, running); runStarts++; await new Promise((res) => gates.push(res)); running-- }
      const triggers = []
      for (let i = 0; i < 30; i++) {
        triggers.push({ at: runStarts, done: jobs.run('k', work).then(() => runStarts) })
        if (r() < 0.4) { gates.shift()?.(); await flushMicro() }
      }
      while (gates.length || jobs.running('k')) { gates.shift()?.(); await flushMicro() }
      expect(maxRunning, `seed ${seed}`).toBe(1)
      for (const t of triggers) expect(await t.done).toBeGreaterThan(t.at) // a run started after the trigger
    }
  })
})
