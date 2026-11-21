// Cursor-stamped snapshots (PANGEA3-DESIGN A2 "everything else derived and rebuildable"; DESIGN-CONFORMANCE section E
// step 2d; census class 2 "cached/persisted projection out of step with state": E1, E2, E28, E33-E36).
// A snapshot is a projection of some source state cached for speed (a first-paint copy of chat headers, a derived index,
// a tab's copy of the engine state). It carries the cursor of the source it was derived at, and it is only ever read
// through a check against the source's cursor now: a stale snapshot is rejected and rebuilt, never shown as current.
//
//   const headers = createSnapshot({ key: 'chat-headers', storage: localStorage, source: replica,   // replica.version
//                                    derive: (state) => state.chats.map(headerOf) })
//   headers.read()        // the cached value when its cursor equals source.version, else derive + write through
//   headers.peek()        // { value, cursor, stale } without rebuilding (first paint may show it marked stale)
//
// `source` is anything with a `version` (model.js replicas: entries folded or accepted changes; engine/rows.js: committed
// write transactions) and optionally `get()` (the state derive reads). A cursor is compared for equality only: a snapshot
// from the future (another tab ahead of us) is as stale as one from the past.

export const SNAPSHOT_FORMAT = 1;

/** Stamp a value with the cursor it was derived at. */
export const stampSnapshot = (value, cursor) => ({ format: SNAPSHOT_FORMAT, cursor, value });

/** The value of a stamped snapshot if it was derived at `cursor`, else undefined (stale, unstamped or unreadable). */
export function readSnapshot(snap, cursor) {
  if (!snap || typeof snap !== 'object' || snap.format !== SNAPSHOT_FORMAT || !('cursor' in snap)) return undefined;
  return sameCursor(snap.cursor, cursor) ? snap.value : undefined;
}

export const sameCursor = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A snapshot of `derive(source.get())` cached in `storage` under `key` (memory only without storage). */
export function createSnapshot({ key, storage = null, source, derive, cursor = () => source.version }) {
  if (!key || typeof derive !== 'function' || !source) throw new Error('createSnapshot: key, source and derive are required');
  const k = `qk-snap:${key}`;
  let mem = null;
  const load = () => { if (mem) return mem; try { const raw = storage?.getItem(k); mem = raw ? JSON.parse(raw) : null; } catch { mem = null; } return mem; };
  const stats = { hits: 0, rebuilds: 0, rejected: 0 };
  function write(value, at) {
    mem = stampSnapshot(value, at);
    try { storage?.setItem(k, JSON.stringify(mem)); } catch { /* quota: memory still holds it */ }
    return value;
  }
  return {
    /** The snapshot's value, rebuilt from the source when its cursor is not the source's cursor now. */
    read() {
      const at = cursor(), snap = load();
      const v = readSnapshot(snap, at);
      if (v !== undefined) { stats.hits += 1; return v; }
      if (snap) stats.rejected += 1;
      stats.rebuilds += 1;
      return write(derive(source.get ? source.get() : source), at);
    },
    /** What is cached, its cursor, and whether it is stale against the source now (no rebuild). */
    peek() { const snap = load(); return snap ? { value: snap.value, cursor: snap.cursor, stale: !sameCursor(snap.cursor, cursor()) } : null; },
    /** Write the snapshot for the source's state now (call after a change, or let read() do it lazily). */
    refresh() { stats.rebuilds += 1; return write(derive(source.get ? source.get() : source), cursor()); },
    clear() { mem = null; try { storage?.removeItem(k); } catch { /* gone */ } },
    stats: () => ({ ...stats }),
  };
}
