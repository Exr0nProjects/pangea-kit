// The kit's state model, taken from Pangea (<private-path>: PANGEA.md A1-A4, the 2026-03-22/23
// notes, case-studies/viewer3):
//   - ONE state tree (`state`, a Svelte $state proxy in the page); every write is an ACTION through
//     dispatch(), executed by a pure-in-spirit reducer that mutates in place, so only the touched
//     leaves invalidate (path-level state components, not whole-store replacement)
//   - actions are ABSOLUTE END STATES (set path=value, sel/set ids=[...]); a UI gesture such as "toggle"
//     or "grow" reads the current state, computes the target and dispatches that
//   - actions land in an append-only OP LOG with an idempotency id, persisted with the state
//     checkpoint (offline first: the local log is the truth, the server's view.json is a sync peer);
//     undo is a compensating `restore` computed from the captured pre-state (`prev`), never a reverse op
//   - an action pushed by the owner's agent is the same thing as one from the UI, with the same id
//     rules: seen ids are ignored, so a reload or a reconnect never applies a push twice
//   - side effects (three.js, DOM) are downstream of state: parts reconcile the scene from the state in
//     effects, so there is no second source of truth that can desync from the sidebar
import { getPath, setPath, plain } from './util.js'

const leafPaths = (o, p = '') => {
  const out = []
  for (const k of Object.keys(o)) {
    const q = p ? `${p}.${k}` : k
    if (plain(o[k]) && Object.keys(o[k]).length) out.push(...leafPaths(o[k], q))
    else out.push(q)
  }
  return out
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const deletePath = (state, path) => {
  const ks = path.split('.'); const last = ks.pop()
  const parent = ks.length ? getPath(state, ks.join('.')) : state
  if (parent && typeof parent === 'object') delete parent[last]
}

export const builtins = {
  // absolute: path = value
  set: Object.assign((s, { path, value }) => { setPath(s, path, clone(value)) }, { touch: ({ path }) => [path] }),
  // absolute: only the leaves the patch names (a push can never reset what it does not name)
  patch: Object.assign((s, patch) => { for (const p of leafPaths(patch)) setPath(s, p, clone(getPath(patch, p))) }, { touch: (patch) => leafPaths(patch) }),
  // compensation for undo: put the captured pre-state back
  restore: Object.assign((s, { prev }) => { for (const [p, v] of Object.entries(prev)) { if (v === undefined) deletePath(s, p); else setPath(s, p, clone(v)) } }, { touch: ({ prev }) => Object.keys(prev) }),
}

export function createStore({ state, reducers = {}, log = [], deviceId = 'dev', maxLog = 300, now = Date.now, onAction = () => {} } = {}) {
  const table = { ...builtins, ...reducers }
  const seen = new Set(log.map((a) => a.id))
  let seq = log.reduce((m, a) => Math.max(m, a.seq ?? 0), 0)
  const entries = [...log]

  function dispatch(op, payload = {}, { actor = 'user', undoable = false, id, ts, quiet = false } = {}) {
    const reducer = table[op]
    if (!reducer) throw new Error(`unknown action "${op}" (register it with store.register)`)
    if (id && seen.has(id)) return null // idempotent replay
    const touch = reducer.touch ? reducer.touch(payload) : []
    const prev = {}
    for (const p of touch) prev[p] = clone(getPath(state, p))
    reducer(state, payload)
    // `_` paths are transient (derived info, hover, load flags): written like any state, never logged or persisted
    if (touch.length && touch.every((p) => p.startsWith('_'))) return { id: 'transient', op, payload, actor, ts: ts ?? now(), prev, transient: true }
    const n = ++seq
    const action = { id: id || `${deviceId}:${n}`, seq: n, op, payload: clone(payload), actor, ts: ts ?? now(), prev, undoable }
    seen.add(action.id)
    // a drag or a slider sweep is one entry: same actor, same single path, within 500 ms
    const last = entries[entries.length - 1]
    if (op === 'set' && last && last.op === 'set' && last.payload.path === payload.path && last.actor === actor && !last.undoable && !undoable && action.ts - last.ts < 500) {
      action.prev = last.prev
      entries[entries.length - 1] = action
    } else entries.push(action)
    if (entries.length > maxLog) entries.splice(0, entries.length - maxLog)
    if (!quiet) onAction(action)
    return action
  }

  return {
    state, dispatch,
    register(more) { Object.assign(table, more) },
    /** A state component: reducers over one path, namespaced `<path>/<name>`; returns its action names. */
    component(path, { initial, actions }) {
      if (getPath(state, path) === undefined) setPath(state, path, clone(initial))
      for (const [name, fn] of Object.entries(actions)) {
        table[`${path}/${name}`] = Object.assign((s, payload) => fn(getPath(s, path), payload, s), { touch: () => [path] })
      }
      return Object.keys(actions).map((n) => `${path}/${n}`)
    },
    get log() { return entries },
    has: (id) => seen.has(id),
    /** Apply an action from elsewhere (the agent's push). Ignored when its id was already applied. */
    apply({ id, op, payload, ts, actor = 'agent' }) { return dispatch(op, payload, { id, ts, actor }) },
    undo() {
      for (let i = entries.length - 1; i >= 0; i--) {
        const a = entries[i]
        if (a.undoable && !a.undone) {
          a.undone = true
          return dispatch('restore', { prev: a.prev }, { actor: 'undo' })
        }
      }
      return null
    },
    get canUndo() { return entries.some((a) => a.undoable && !a.undone) },
  }
}

/** Pure fold: the state after `actions`, from `initial`. `setup(store)` registers the app's components/reducers.
 * A session that began at `initial` equals replay(initial, its log): the log is the truth, the state a cache of it. */
export function replay(initial, actions, setup = () => {}) {
  const state = clone(initial)
  const s = createStore({ state })
  setup(s)
  for (const a of actions) s.dispatch(a.op, a.payload, { id: a.id, ts: a.ts, actor: a.actor, undoable: a.undoable, quiet: true })
  return state
}
