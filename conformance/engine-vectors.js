// Conformance vectors for the engine modules: deterministic scenarios whose outputs any other implementation (a
// Python or Worker port) must reproduce byte for byte in canonical JSON. `node conformance/engine-generate.mjs`
// writes them to conformance/engine/; tests/engine.conformance.test.js fails if a fresh build differs.
import { createTelemetryLane } from '../lib/engine/lane.js'
import { ledger } from '../lib/engine/jobs.js'
import { createSender, memoryOutbox, refusedForGood, BackpressureError } from '../lib/engine/outbox.js'
import { diff, apply } from '../lib/engine/patch.js'
import { ulidFactory } from '../lib/engine/ulid.js'
import { createDeadlineFetch } from '../lib/engine/deadline.js'

const micro = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve() }

export async function buildEngineVectors() {
  const out = {}

  // lane: drop-oldest under items and bytes bounds
  {
    const steps = []
    const lane = createTelemetryLane({ maxItems: 3, maxBytes: 60, setTimer: () => 0, sizeOf: (r) => r.size })
    for (const [n, size] of [[1, 10], [2, 10], [3, 10], [4, 10], [5, 35], [6, 70], [7, 5]]) {
      const accepted = lane.push({ n, size })
      steps.push({ push: { n, size }, accepted, counts: lane.counts() })
    }
    out.lane = { limits: { maxItems: 3, maxBytes: 60 }, steps }
  }

  // outbox admission: refuse when the next item would pass a bound; nothing already held changes
  {
    const box = memoryOutbox({ limits: { maxItems: 3, maxBytes: 1_000_000 } })
    const steps = []
    for (const id of ['a', 'b', 'a', 'c', 'd']) {
      let outcome
      try { box.admit(1); outcome = (await box.put([{ id, body: { id } }])) ? 'stored' : 'duplicate' } catch (e) { outcome = e instanceof BackpressureError ? 'backpressure' : 'error' }
      steps.push({ id, outcome, held: (await box.all()).map((r) => r.id) })
    }
    out.outbox_admit = { limits: { maxItems: 3 }, steps }
  }

  // sender: per-stream FIFO, same id on every retry, verdict classes
  {
    const box = memoryOutbox()
    const script = { 'A:1': 'throw', 'A:2': 503, 'A:3': 200, 'B:1': 400, 'C:1': 429, 'C:2': 200 }
    const attempts = []
    const ids = { A: 'A', B: 'B', C: 'C' }
    const timers = []
    const sender = createSender({ outbox: box, retryMs: [1], setTimer: (fn) => { timers.push(fn); return 1 }, clearTimer: () => {},
      send: async (e) => { const k = `${e.id}:${e.attempt}`; attempts.push(k); const v = script[k]; if (v === 'throw') throw new Error('net'); return { ok: v >= 200 && v < 300, status: v } } })
    await sender.enqueue('s1', { t: 'a' }, { id: ids.A })
    await sender.enqueue('s1', { t: 'b' }, { id: ids.B })
    await sender.enqueue('s2', { t: 'c' }, { id: ids.C })
    for (let i = 0; i < 10 && box.size().items; i++) { await micro(); const t = timers.shift(); if (t) t(); else await sender.kick() }
    await micro()
    out.sender = { script, attempts, left: (await box.all()).map((r) => r.id), stats: sender.stats(), refusedForGood: Object.fromEntries([200, 400, 401, 404, 408, 409, 429, 500, 503].map((c) => [c, refusedForGood(c)])) }
  }

  // ledger eviction order: outside the window first, then oldest; ties by id
  {
    const b = ledger()
    for (const [id, bytes, last] of [['x', 5, '2026-10-01'], ['y', 5, '2026-11-07'], ['z', 5, '2026-09-01'], ['w', 5, '2026-11-05'], ['v', 5, '2026-09-01']]) b.add(id, bytes, 1, last)
    out.ledger = { order: b.evictionOrder({ keepAfter: '2026-11-01' }).map((p) => [p.id, p.inWindow]), total: b.total() }
  }

  // patches: diff then apply reproduces next
  {
    const prev = { rev: 1, a: 1, maps: { x: { v: 1 }, y: { v: 2 } }, list: { l: [{ i: 0 }, { i: 1 }, { i: 2 }] } }
    const keepX = prev.maps.x
    const l = prev.list.l
    const next = { rev: 2, a: 1, maps: { x: keepX, z: { v: 3 } }, list: { l: [l[0], { i: 'mid' }, l[2], { i: 3 }] } }
    const p = diff(prev, next, { maps: ['maps', 'list'] })
    out.patch = { prev, next, patch: p, applied: apply(JSON.parse(JSON.stringify(prev)), p) }
  }

  // ulid: fixed time and randomness, monotonic within one millisecond
  {
    const u = ulidFactory({ now: () => 1_762_600_000_000, random: (n) => new Uint8Array(n).fill(7) })
    out.ulid = { ids: [u(), u(), u()] }
  }

  // deadline: supersede by key, deadline by class
  {
    let fire = null
    const net = createDeadlineFetch(() => new Promise(() => {}), { deadlines: { read: 5 }, setTimer: (fn) => { fire = fn; return 1 }, clearTimer: () => {} })
    const results = []
    const a = net.fetchWithin('read', '/a', {}, { key: 'k' }).catch((e) => results.push(['a', e.name]))
    const b = net.fetchWithin('read', '/b', {}, { key: 'k' }).catch((e) => results.push(['b', e.name]))
    await micro(); fire(); await a; await b
    out.deadline = { results, stats: net.stats() }
  }
  return out
}
