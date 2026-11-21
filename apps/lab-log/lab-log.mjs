// lab-log: a second app on the kit engine, to show the engine modules are not chat-shaped.
//
// A bench notebook: entries are written per experiment ("tank-01", "phantom-3"), saved offline-first, delivered to a
// server that assigns positions, read back from a local replica with a two-week window and a byte budget, and searched
// offline. One engine per browser (SharedWorker, or the Web Locks leader, or a worker, or in the tab); tabs render.
// Nothing here knows about chats, conversations, runs or events: the same modules, a different schema.
//
//   const server = makeLabServer({ api })                    // in the worker: workerMain(() => makeLabServer({ api }))
//   const tab = connectEngine({ name: 'lab-log', local: () => server })
//   await tab.call('write', { id: ulid(), experiment: 'tank-01', text: 'degassed 40 min, 22.1 C' })
//   const hits = await tab.call('search', 'degassed')       // from the replica, with coverage

import { createDeadlineFetch } from '../../lib/engine/deadline.js'
import { createSender, memoryOutbox, openOutbox } from '../../lib/engine/outbox.js'
import { createTelemetryLane } from '../../lib/engine/lane.js'
import { memoryReplicaStore, openReplicaStore } from '../../lib/engine/replica-store.js'
import { searchStore } from '../../lib/engine/search.js'
import { serveEngine } from '../../lib/engine/host.js'
import { ulid } from '../../lib/engine/ulid.js'

/**
 * `api` is the server: `post(entry) -> Response-like` and `since(pos) -> { entries: [{ pos, experiment, text, at, id }] }`.
 * A real app passes fetch-backed functions; they are called through the deadline classes either way.
 */
export function makeLabServer({ api, indexedDB = null, policy = { budgetBytes: 50_000_000, windowMs: 14 * 864e5 } } = {}) {
  const net = createDeadlineFetch(undefined, { deadlines: { send: 15_000, pull: 20_000, telemetry: 10_000 } })
  const lane = createTelemetryLane({ maxItems: 200 })
  let view = { entries: {}, pending: {}, status: { synced: 0, refused: [] } }
  const subs = new Set()
  const publish = (next) => { view = next; for (const f of subs) f() }
  const ready = (async () => {
    const store = indexedDB
      ? await openReplicaStore({ indexedDB, name: 'lab-log', key: 'pos', partition: 'experiment', time: 'at', policy })
      : memoryReplicaStore({ key: 'pos', partition: 'experiment', time: 'at', policy })
    const box = indexedDB ? await openOutbox({ indexedDB, name: 'lab-log-outbox' }) : memoryOutbox()
    const sender = createSender({
      outbox: box,
      send: (e) => net.within('send', () => api.post(e.body), { key: `send:${e.id}` }),
      onDelivered: (e) => { const pending = { ...view.pending }; delete pending[e.id]; publish({ ...view, pending }); pull() },
      onRefused: (e, r) => { const pending = { ...view.pending }; delete pending[e.id]; publish({ ...view, pending, status: { ...view.status, refused: [...view.status.refused, { id: e.id, status: r.status }] } }) }
    })
    // what is still owed after a reload is on screen again at once
    const owed = await box.all()
    if (owed.length) publish({ ...view, pending: Object.fromEntries(owed.map((r) => [r.id, r.body])) })
    sender.kick()
    return { store, box, sender }
  })()
  ready.then(() => pull()) // catch up with the server once at start; the replica answers until it does

  async function pull() {
    const { store } = await ready
    try {
      const page = await net.within('pull', () => api.since(store.high()), { key: 'pull' })
      await store.append(page.entries || [])
      const entries = { ...view.entries }
      for (const e of page.entries || []) entries[e.id] = e
      publish({ ...view, entries, status: { ...view.status, synced: view.status.synced + 1 } })
    } catch (cause) { lane.push({ kind: 'pull_failed', error: cause?.name || 'Error' }) }
  }

  const methods = {
    /** Write an entry. Durable (in the outbox) when this resolves; on screen at once; delivered when the server is there. */
    async write({ id = ulid(), experiment, text }) {
      const { sender } = await ready
      const body = { id, experiment, text, at: new Date().toISOString() }
      if (!view.pending[id] && !view.entries[id]) publish({ ...view, pending: { ...view.pending, [id]: body } })
      await sender.enqueue(experiment, body, { id })
      return id
    },
    pull,
    async search(query) {
      const { store } = await ready
      return searchStore(store, query, { textOf: (e) => e.text, partOf: (e) => e.experiment, keyOf: (e) => e.pos, deadlineMs: 500 })
    },
    async experiment(name, limit = 100) { const { store } = await ready; return store.readLatest(name, limit) },
    async health() { const { store, sender } = await ready; return { store: store.usage(), sender: sender.stats(), lane: lane.counts(), net: net.stats() } },
    async retry() { const { sender } = await ready; return sender.kick() }
  }
  return serveEngine({ methods, view: () => view, subscribe: (f) => subs.add(f), diffOptions: { maps: ['entries', 'pending'] } })
}

/** A tiny in-memory lab server for tests and the demo: idempotent by entry id, positions in arrival order. */
export function memoryLabApi() {
  const rows = []
  const byId = new Map()
  const state = { down: false, posts: 0 }
  return {
    state, rows,
    async post(entry) {
      state.posts += 1
      if (state.down) throw new TypeError('Failed to fetch')
      if (!entry.text) return { ok: false, status: 400 }
      if (!byId.has(entry.id)) { const row = { ...entry, pos: rows.length + 1 }; rows.push(row); byId.set(entry.id, row) }
      return { ok: true, status: 200 }
    },
    async since(pos) { if (state.down) throw new TypeError('Failed to fetch'); return { entries: rows.filter((r) => r.pos > pos) } }
  }
}
