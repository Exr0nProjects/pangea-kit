// Undo / redo for kit apps that keep one flat state tree (host/boot.js apps: state.js + parts). Pure and DOM-free; the
// host (host/kit.svelte.js trackHistory) feeds it the state after every change and applies what undo()/redo() return.
//
// Why a snapshot history and not the store's `undoable` flag: the state is written in two ways, store.dispatch and direct
// assignment (bind:value on a Slider writes the tree without dispatch, parts assign `state.x = ...` during a drag). Only a
// watcher on the tree itself sees both, so the history is built on what the tree is, not on which door a write came in by.
// (lib/undo.js is the other facility: it serves declare()d replicas whose writes are all actions, with compare-and-set
// across devices; it cannot see a bind:value write and this tree has no remote writers beyond the agent's pushes.)
//
// Rules:
//   - a snapshot is the persistable tree: top-level keys, each held as canonical JSON text (cheap to diff and to restore,
//     shares nothing mutable with the live tree). Keys starting with "_" are transient (the kit-wide convention: caches,
//     hover, mode, tab, progress) and keys in `exclude` (camera, axes, title, hardware toggles) are never recorded and
//     never touched by undo.
//   - `passive` keys (a selection) ride along in every snapshot but do not create a step on their own: selecting a layer is
//     not an undo step, yet undoing the draw that created it restores the selection that was current before the draw.
//   - a step is everything that changed between two observations that belong together: all changes while a gesture is open
//     (pointer held down: a slider sweep, a vertex drag), and, outside a gesture, consecutive changes to the same set of keys
//     less than `coalesceMs` apart (arrow keys on a slider). A new step clears the redo stack. The stack is capped at `limit`.
//   - history is in memory only. It is not part of the state, is never persisted and never enters the schema version, so no
//     upcaster is involved; a reload, or `reset()` after a hot-swapped schema is upcast, starts an empty history.
const DEFAULTS = { limit: 100, coalesceMs: 400, exclude: ['camera', 'axes', 'title'], passive: [] }

export const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v) => (v === undefined ? undefined : JSON.stringify(v))

export function createSnapshotHistory(opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  const now = o.now || (() => Date.now())
  const exclude = new Set(o.exclude), passive = new Set(o.passive)
  const tracked = (k) => !k.startsWith('_') && !exclude.has(k)
  const snap = (state) => { const s = {}; for (const k of Object.keys(state || {})) if (tracked(k)) { const t = text(state[k]); if (t !== undefined) s[k] = t } return s }
  const diff = (a, b) => { const ks = []; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) ks.push(k); return ks.sort() }
  const patchOf = (from, to) => { // what to write to go from the live snapshot `from` to `to`
    const set = {}, unset = []
    for (const k of diff(from, to)) if (k in to) set[k] = JSON.parse(to[k]); else unset.push(k)
    return { set, unset }
  }

  let cur = {}, undos = [], redos = [], lastKeys = null, lastAt = 0, gesture = 0, open = false
  const api = {
    /** Start over from `state`: no steps. Called at boot and after a hot-swapped schema was upcast into the tree. */
    reset(state) { cur = snap(state); undos = []; redos = []; lastKeys = null; open = false },
    /** The state changed (or may have): record it. Returns true when it created or extended a step. */
    observe(state) {
      const next = snap(state), keys = diff(cur, next)
      if (!keys.length) return false
      if (keys.every((k) => passive.has(k))) { cur = next; return false } // selection alone is not a step
      const t = now(), sig = keys.filter((k) => !passive.has(k)).join('\n')
      const extend = undos.length && (gesture > 0 && open || (gesture === 0 && lastKeys === sig && t - lastAt < o.coalesceMs))
      if (!extend) { undos.push(cur); if (undos.length > o.limit) undos.shift() }
      redos = []
      cur = next; lastKeys = sig; lastAt = t; open = gesture > 0
      return true
    },
    /** A pointer gesture opens: every change until end() is one step. Nestable. */
    begin() { if (gesture++ === 0) open = false },
    end() { if (gesture > 0 && --gesture === 0) { open = false; lastKeys = null } },
    /** The patch { set, unset } that undoes the newest step, or null. The live snapshot becomes the restored one at once, so
     *  the observe() that follows the write sees no change and records nothing. */
    undo(state) {
      if (!undos.length) return null
      api.observe(state) // fold in anything not yet seen
      const to = undos.pop(); redos.push(cur)
      const p = patchOf(cur, to); cur = to; lastKeys = null; open = false
      return p
    },
    redo(state) {
      if (!redos.length) return null
      api.observe(state)
      if (!redos.length) return null
      const to = redos.pop(); undos.push(cur)
      const p = patchOf(cur, to); cur = to; lastKeys = null; open = false
      return p
    },
    get canUndo() { return undos.length > 0 },
    get canRedo() { return redos.length > 0 },
    get sizes() { return { undo: undos.length, redo: redos.length } },
    get limit() { return o.limit },
  }
  return api
}

/** Apply a patch from undo()/redo() to the live state tree (in place, so a $state proxy invalidates only what changed). */
export function applyHistoryPatch(state, { set, unset }) {
  for (const [k, v] of Object.entries(set)) state[k] = v
  for (const k of unset) delete state[k]
}

const isMacLike = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '')
/** Which history action a keydown asks for: 'undo' (cmd/ctrl-Z), 'redo' (shift-cmd/ctrl-Z, ctrl-Y), or null. Both
 *  modifiers work on every platform (a Mac user with an external PC keyboard, a PC user with a Mac habit); alt never. */
export function historyKey(e) {
  if (!e || e.altKey || e.isComposing || e.defaultPrevented) return null
  const mod = e.metaKey || e.ctrlKey
  if (!mod || (e.metaKey && e.ctrlKey)) return null
  const k = String(e.key || '').toLowerCase()
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo'
  if (k === 'y' && e.ctrlKey && !e.shiftKey) return 'redo'
  return null
}

const TEXT_INPUT_OFF = new Set(['button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset', 'submit'])
/** Focus is in a control with its own native undo (text, number, textarea, contenteditable): the app leaves the key alone.
 *  A range slider, a checkbox, a button and a select have no text undo, so there the app history answers. */
export function hasNativeUndo(el) {
  if (!el || el.nodeType !== 1) return false
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName === 'INPUT') return !TEXT_INPUT_OFF.has((el.type || 'text').toLowerCase())
  return !!el.isContentEditable
}
