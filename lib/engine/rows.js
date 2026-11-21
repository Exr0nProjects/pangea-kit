// Keyed rows: the kit's state for a big document (tens of thousands of rows) that the whole-state replica
// (lib/model.js) cannot hold. Built for zai2 (The owner 2026-11-08 20:40 PST: "lets build it as a native pangea app
// (pangea cloud backed , local reducers, use the kit, etc). lets see how pagination plays with the kit").
//
// Why a second state shape: model.js keeps the whole state as one JSON record in localStorage, stringifies it on
// every save and on every ingest, and folds a 200-entry tail. A 30,000-line notes document is about 8 MB of JSON:
// over the localStorage quota, and a full stringify per keystroke. Rows fix all three:
//   - one IndexedDB record per row; a write touches one row and one pending record, in one transaction;
//   - the merge is per field last-writer-wins on a stamp carried in the payload, which is commutative, associative
//     and idempotent, so entries apply in any order with no tail, no refold and no horizon (model.js's "an entry
//     older than the 200-entry tail is applied in arrival order" limit does not exist here);
//   - only the live rows from a sort key onwards are in memory (pagination): `load({ from })` then `loadOlder(n)`
//     walk an IndexedDB index on the row's sort key, so the newest part of a document paints before the rest is read.
//
//   const doc = await openRows({ name: 'notes-lines', transport, sortKey: (r) => [rank[r.zone], r.ord, r.id],
//                                live: (r) => !r.deleted_at })
//   await doc.load({ from: [1] })                 // rows whose sort key >= [1], in order (doc.view is a kit sortedView-like list)
//   doc.put([{ id, set: { body: 'hi' } }])        // memory now, IndexedDB in one transaction, a pending patch for the cloud
//   await doc.loadOlder(200)                      // the previous page of rows (by sort key), prepended
//   doc.subscribe((change) => ...)                // { ids, reason: 'local' | 'remote' | 'page' | 'tab' }
//   await doc.sync()                              // push pending as one Stream entry, pull everyone's entries
//
// Wire (one-to-one with the kit transport, lib/stream-worker.js or lib/stream-fake.js): stream = name; one entry per
// push: { device_id, device_seq, event_time, payload: { type: 'rows', payload: { rows: [{ id, set, at }] } } } where
// `at[field]` is the stamp of that field's value. Pending patches coalesce per row and field (typing 60 characters
// is one field in one entry, not 60 entries); an entry is written to IndexedDB as `outgoing` before it is pushed, so
// a crash or a lost ack re-sends the identical entry (same device_seq, same bytes: the Worker's idempotent duplicate).
// Stamps are hybrid logical clock times (lib/engine/hlc.js, PANGEA3-DESIGN A8): `<ts base36, 9>:<l base36, 6>:<writer>`,
// compared as strings: later ts wins, then the logical counter, then the writer. The tab's clock observes every stamp it
// reads (a row loaded, ingested, re-read from another tab, or about to be overwritten) and its last time is on disk, so a
// local write is strictly later than every value it can overwrite: by construction, not by a per-field floor (census A26).
// A stamp written by an older build (`<ts>.<writer>.<counter>`) sorts below every new stamp of the same millisecond.
// Intents: every put carries an intent id (a ULID minted once at the gesture, A7); a put whose intent this browser already
// applied is a no-op, and the intent rides with the row patch to the Stream (provenance, server receipts).
//
// Tabs: every tab writes rows to the same IndexedDB; only the tab holding the Web Lock `qk-rows:<name>` pushes and
// pulls (one device_seq sequence per browser, the fix for the two-tab 409 the GUIDE lists for model.js); writes are
// announced on BroadcastChannel and other tabs re-read those rows.

import { done, req, walk } from './idb.js';
import { createHlc, L_PAD } from './hlc.js';
import { ulid } from './ulid.js';
import { ConcurrencyConflictError } from '../errors.js';
import { declareRows, fieldPredicate } from './rows-declare.js';
import { asEntries, laterCursor } from './checkpoint.js';

const PAD_TS = 9;
const INTENT_RING = 2048; // intents remembered per browser (on disk), so a retried put stays a no-op across reloads
const MAX_ENTRY_BYTES = 700_000; // the Worker takes 1 MiB per payload; the envelope adds base64 (4/3)
const enc = (s) => (typeof TextEncoder === 'undefined' ? s.length : new TextEncoder().encode(s).length);

/** A field stamp for HLC time (ts, l) minted by `writer`. */
export const stampOf = (ts, writer, l = 0) => `${Math.max(0, Math.floor(ts)).toString(36).padStart(PAD_TS, '0')}:${Math.max(0, Math.floor(l)).toString(36).padStart(L_PAD, '0')}:${writer}`;
export const stampTime = (stamp) => parseInt(String(stamp).slice(0, PAD_TS), 36);
/** The HLC time of a stamp ({ ts, l }); an old-format stamp reads as l = 0 (every new stamp of its millisecond is later). */
export const stampHlc = (stamp) => { const s = String(stamp); const ts = parseInt(s.slice(0, PAD_TS), 36); return { ts: Number.isFinite(ts) ? ts : 0, l: s[PAD_TS] === ':' ? (parseInt(s.slice(PAD_TS + 1, PAD_TS + 1 + L_PAD), 36) || 0) : 0 }; };
/** Who minted a stamp (the writer id; old-format stamps too). */
export const stampWriter = (stamp) => { const s = String(stamp); return s[PAD_TS] === ':' ? s.slice(PAD_TS + 2 + L_PAD) : s.split('.')[1] ?? ''; };
/** A row's version for optimistic concurrency (put's assertVersion): its largest field stamp, or null for no row. */
export const rowVersion = (row) => { let v = null; for (const s of Object.values(row?._s || {})) if (typeof s === 'string' && (v === null || s > v)) v = s; return v; };

/** Apply one row patch to a stored row (or nothing): per field, the larger stamp wins. Returns the new row or the
 *  same object when nothing changed. Pure; the one merge rule every replica and the MCP Worker share. */
export function mergeRow(row, patch) {
  if (!patch || typeof patch.id !== 'string' || !patch.set || typeof patch.set !== 'object') return row;
  let next = row;
  for (const [f, v] of Object.entries(patch.set)) {
    if (f === 'id' || f.startsWith('_')) continue;
    const s = patch.at?.[f];
    if (typeof s !== 'string') continue;
    const cur = next?._s?.[f];
    if (cur !== undefined && cur >= s) continue;
    if (next === row) next = { ...(row || { id: patch.id }), _s: { ...(row?._s || {}) } };
    next[f] = v; next._s[f] = s;
  }
  return next;
}

/** Why patch p writes part of a field group and not the rest (null when it does not): openRows({ together }). */
export function splitGroup(p, groups) {
  for (const g of groups || []) { const has = g.filter((f) => p?.set && f in p.set); if (has.length && has.length !== g.length) return `patch ${p.id} writes ${has.join(', ')} without ${g.filter((f) => !has.includes(f)).join(', ')} (written together)`; }
  return null;
}

/** Fold Stream entries into a Map of rows (the MCP Worker and tests use this; openRows does the same per row). */
export function foldRows(map, entries) {
  const changed = new Set();
  for (const e of entries) {
    const rows = e?.payload?.type === 'rows' ? e.payload.payload?.rows : null;
    if (!Array.isArray(rows)) continue;
    for (const p of rows) { const old = map.get(p?.id); const next = mergeRow(old, p); if (next !== old) { map.set(p.id, next); changed.add(p.id); } }
  }
  return changed;
}

const cmpKey = (a, b) => { // IndexedDB key order for arrays of numbers and strings (numbers sort before strings)
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    const tx = typeof x, ty = typeof y;
    if (tx !== ty) return tx === 'number' ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
};

/** A sorted list of loaded live rows by sort key: binary-search upsert/remove, O(window) slices. */
function orderedList(sortKey) {
  let list = []; // { row, k }
  const byId = new Map();
  const lower = (k, id) => { let lo = 0, hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; const c = cmpKey(list[m].k, k) || (list[m].row.id < id ? -1 : list[m].row.id > id ? 1 : 0); if (c < 0) lo = m + 1; else hi = m; } return lo; };
  const view = {
    get size() { return list.length; },
    at: (i) => list[i]?.row,
    rows: () => list.map((e) => e.row),
    slice: (a, b) => list.slice(a, b).map((e) => e.row),
    has: (id) => byId.has(id),
    get: (id) => byId.get(id)?.row,
    indexOf(id) { const e = byId.get(id); if (!e) return -1; const i = lower(e.k, id); return list[i] === e ? i : -1; },
    upsert(row) {
      const old = byId.get(row.id), k = sortKey(row);
      if (old) { const i = lower(old.k, row.id); if (cmpKey(old.k, k) === 0) { const e = { row, k }; list[i] = e; byId.set(row.id, e); return i; } list.splice(i, 1); }
      const e = { row, k }; byId.set(row.id, e);
      const at = lower(k, row.id); list.splice(at, 0, e); return at;
    },
    remove(id) { const e = byId.get(id); if (!e) return false; list.splice(lower(e.k, id), 1); byId.delete(id); return true; },
    /** Many rows at once (a page): one sort instead of n splices. */
    addMany(rows) { for (const r of rows) { if (byId.has(r.id)) view.remove(r.id); const e = { row: r, k: sortKey(r) }; byId.set(r.id, e); list.push(e); } list.sort((a, b) => cmpKey(a.k, b.k) || (a.row.id < b.row.id ? -1 : 1)); },
  };
  return view;
}

const randomId = () => { const b = new Uint8Array(6); globalThis.crypto.getRandomValues(b); return [...b].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, 10); };

// declaration: a declareRows() result (lib/engine/rows-declare.js) giving the fields and together groups; without one,
// openRows declares its own from `fields` and `together`, so every open row store is a declaration validate() checks
// (row #38). A put writing a field the declaration does not list is refused, like a split group.
export async function openRows({ name, scope = null, indexedDB: idb = globalThis.indexedDB, transport = null, sortKey, live = () => true, together: together0 = null, fields: fields0 = null, declaration = null,
  now = () => Date.now(), clock = createHlc, locks = globalThis.navigator?.locks, Broadcast = globalThis.BroadcastChannel, onError = () => {}, rewriteSet = null }) {
  if (!name || typeof sortKey !== 'function') throw new Error('openRows: name and sortKey are required');
  const decl = declaration || declareRows({ name, fields: fields0, together: together0 || [] });
  if (!decl || !Array.isArray(decl.together)) throw new Error('openRows: declaration must be a declareRows() result');
  const together = together0 || decl.together, fieldOk = fieldPredicate(decl.fields);
  if (!idb) throw new Error('openRows: IndexedDB is required');
  // `name` is the stream (what the transport pushes and pulls); `scope` (an account id, say) only separates the on-device copy, so two
  // accounts signed in on one browser never share rows, outbox or lock while both talk to their own stream of the same name
  const local = scope ? `${name}@${scope}` : name;
  const open = idb.open(`qk-rows:${local}`, 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    db.createObjectStore('rows', { keyPath: 'id' }).createIndex('k', '_k'); // _k only on live rows: the index skips the rest
    db.createObjectStore('pending', { keyPath: 'id' });
    db.createObjectStore('meta');
  };
  const db = await req(open);
  const getMeta = async () => { const tx = db.transaction('meta'); const s = tx.objectStore('meta'); const [m, out] = [await req(s.get('m')), await req(s.get('outgoing'))]; return { m, out }; };
  let { m: meta } = await getMeta();
  if (!meta) { meta = { device: randomId(), seq: 0, cursor: null }; const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put(meta, 'm'); await done(tx); }
  const device = meta.device;
  // Stamps are minted per tab (device + tab id + counter), so two tabs never mint the same stamp; the Stream sequence
  // (meta.seq) and cursor live on disk and only the lock holder advances them, re-reading them under the lock.
  const writer = `${device}-${randomId().slice(0, 4)}`;
  // The one order source (hlc.js), restored from the browser's last time on disk ('w'.clock, written with every put), so a
  // reopened tab is later than everything any tab of this browser wrote before (the same-millisecond reopen, census A26).
  let w = (await req(db.transaction('meta').objectStore('meta').get('w'))) || { clock: null, version: 0, intents: [] };
  const hlc = clock({ now, last: w.clock }); // `clock`: the HLC factory (tests plant a broken one to prove the order laws)
  const seenIntents = new Set(w.intents || []);
  let version = w.version || 0;
  const observeRow = (row) => { for (const s of Object.values(row?._s || {})) if (typeof s === 'string') hlc.observe(stampHlc(s)); };

  const view = orderedList(sortKey);
  let from = null;           // the sort key of the oldest loaded row (null: nothing loaded yet; [] after the start)
  let reachedStart = false;
  const subs = new Set();
  const emit = (change) => { for (const f of [...subs]) { try { f(change); } catch (e) { onError(e); } } };
  const stats = { puts: 0, pushed: 0, pulled: 0, entriesPushed: 0, loads: 0, rowsRead: 0 };
  let writes = Promise.resolve();
  let bc = null;
  try { bc = Broadcast ? new Broadcast(`qk-rows:${local}`) : null; } catch { bc = null; }

  const keyed = (row) => { const r = { ...row }; if (live(r)) r._k = sortKey(r); else delete r._k; return r; };
  const inWindow = (row) => live(row) && from !== null && (reachedStart || cmpKey(sortKey(row), from) >= 0);
  // every row that enters memory is observed by the clock first, so a put of it is stamped later than what it shows
  const place = (row) => { observeRow(row); if (inWindow(row)) view.upsert(row); else view.remove(row.id); };
  // A local write must beat the value it overwrites (zai2 sync fuzz 2026-11-08: a same-millisecond stamp from a reopened tab
  // or a device whose clock ran ahead tie-broke on the writer id and lost). The HLC makes that impossible: the row was
  // observed when it entered memory (and is observed again here), so tick() is strictly later than each of its stamps.
  const stamp = () => { const t = hlc.tick(); return stampOf(t.ts, writer, t.l); };

  /** Local edits: put([{ id, set: { field: value } }], { intent, assertVersion }). Applied to memory now (the caller
   *  re-renders synchronously), then one IndexedDB transaction writes the rows, the coalesced pending patches, the clock
   *  and the intent.
   *  - intent: the id of the gesture (a ULID minted once where the user acted; editor.js passes its action id). A put
   *    whose intent this browser already applied returns [] and changes nothing (a retried or redelivered gesture).
   *    Omitted: minted here (still unique, but a caller that retries must pass the same one).
   *  - assertVersion: { [rowId]: rowVersion(row as the caller saw it) } (null: the row must not exist). Any mismatch
   *    refuses the whole put with ConcurrencyConflictError before anything is applied. */
  function put(patches, { intent = null, assertVersion = null } = {}) {
    const out = [], ids = [];
    const stamped = [];
    if (intent !== null && (typeof intent !== 'string' || !intent)) throw new TypeError('rows.put: intent is a non-empty string');
    if (intent !== null && seenIntents.has(intent)) return out;
    // fields that must always be written together (lib/engine/structure.js: a text and its mvseen win together under
    // per-field LWW only if every write carries both): a put that splits a group is refused before anything applies
    for (const p of patches) { const why = splitGroup(p, together); if (why) throw new TypeError(`rows.put ${name}: ${why}`); }
    if (fieldOk) for (const p of patches) for (const f of Object.keys(p?.set || {})) if (f !== 'id' && !f.startsWith('_') && !fieldOk(f)) throw new TypeError(`rows.put ${name}: patch ${p.id} writes undeclared field "${f}" (declareRows fields)`);
    if (assertVersion) for (const [id, want] of Object.entries(assertVersion)) {
      const have = rowVersion(view.get(id) || cache.get(id));
      if ((want ?? null) !== have) throw new ConcurrencyConflictError({ entity_type: name, entity_id: id, expected_version: want ?? null, actual_version: have });
    }
    const it = intent ?? ulid();
    for (const p of patches) {
      if (!p || typeof p.id !== 'string' || !p.set) continue;
      const cur = view.get(p.id) || cache.get(p.id);
      observeRow(cur);
      // rewriteSet(cur, set) -> set: the app's one place to add fields a write implies (zai: the first text in an empty line stamps created_at)
      const set = rewriteSet ? (rewriteSet(cur, p.set) || p.set) : p.set;
      const s = stamp(), at = Object.fromEntries(Object.keys(set).map((f) => [f, s]));
      stamped.push({ id: p.id, set, at, intent: it });
      const next = mergeRow(cur, { id: p.id, set, at });
      if (next !== cur) { cache.set(p.id, next); place(next); out.push(next); ids.push(p.id); }
    }
    if (!stamped.length) return out;
    seenIntents.add(it);
    stats.puts += stamped.length;
    const clock = hlc.peek();
    writes = writes.then(async () => {
      const tx = db.transaction(['rows', 'pending', 'meta'], 'readwrite');
      const rows = tx.objectStore('rows'), pend = tx.objectStore('pending');
      bumpMeta(tx, clock, it);
      const truth = [];
      // every read is issued at once (one round trip for a 30,000-row paste or import, not 30,000 sequential ones)
      const ids = [...new Set(stamped.map((p) => p.id))];
      const [storedRows, pendRows] = await Promise.all([Promise.all(ids.map((id) => req(rows.get(id)))), Promise.all(ids.map((id) => req(pend.get(id))))]);
      const cur = new Map(ids.map((id, k) => [id, storedRows[k]])), curP = new Map(ids.map((id, k) => [id, pendRows[k]]));
      for (const p of stamped) {
        const stored = cur.get(p.id);
        const merged = mergeRow(stored, p);
        if (merged !== stored) cur.set(p.id, merged);
        // coalesce per field, keeping the larger stamp (a lower one never replaces the value it lost to)
        const old = curP.get(p.id) || { id: p.id, set: {}, at: {} };
        const set = { ...old.set }, at = { ...old.at };
        let latest = old.intent;
        for (const [f, v] of Object.entries(p.set)) if (at[f] === undefined || p.at[f] > at[f]) { set[f] = v; at[f] = p.at[f]; latest = p.intent; }
        curP.set(p.id, latest ? { id: p.id, set, at, intent: latest } : { id: p.id, set, at });
      }
      ids.forEach((id, k) => { const r = cur.get(id); if (r && r !== storedRows[k]) { rows.put(keyed(r)); truth.push(r); } pend.put(curP.get(id)); });
      await done(tx);
      // memory was optimistic; the disk merge is the truth (a row edited while unloaded has fields memory never saw)
      const fixed = [];
      for (const r of truth) { const m = view.get(r.id) || cache.get(r.id); if (JSON.stringify(m) !== JSON.stringify(r)) { cache.set(r.id, r); place(r); fixed.push(r.id); } }
      if (fixed.length) emit({ ids: fixed, reason: 'local' });
      try { bc?.postMessage({ ids }); } catch { /* closed */ }
    }).catch(onError);
    if (ids.length) emit({ ids, reason: 'local' });
    kick();
    return out;
  }
  // The browser's write record ('w' in meta, read-modify-written inside each write transaction so tabs never clobber it):
  // the clock's last time, the change counter (`version`, the cursor a derived snapshot is stamped with) and the bounded
  // ring of applied intents.
  function bumpMeta(tx, clock, intent = null) {
    const store = tx.objectStore('meta');
    const r = store.get('w');
    r.onsuccess = () => {
      const cur = r.result || { clock: null, version: 0, intents: [] };
      const c = cur.clock && (cur.clock.ts > clock.ts || (cur.clock.ts === clock.ts && cur.clock.l > clock.l)) ? cur.clock : clock;
      const intents = intent ? [...(cur.intents || []).filter((x) => x !== intent), intent].slice(-INTENT_RING) : (cur.intents || []);
      const next = { clock: c, version: (cur.version || 0) + 1, intents };
      store.put(next, 'w');
      tx.addEventListener?.('complete', () => { version = Math.max(version, next.version); });
    };
  }
  // rows read from disk but outside the window (a row edited by id that is not loaded): a small cache so a put of an
  // unloaded row merges against what we know; disk merge in the transaction is the authority anyway.
  const cache = new Map();

  async function readRange(range, direction, limit) {
    const tx = db.transaction('rows');
    const out = [];
    await walk(tx.objectStore('rows').index('k').openCursor(range, direction), (c) => { out.push(c.value); return out.length < limit; });
    stats.rowsRead += out.length;
    return out;
  }

  /** Load the live rows whose sort key is >= `from` (all of them when from is null), in one read. */
  async function load({ from: start = null } = {}) {
    await writes;
    const rows = start === null ? await readRange(null, 'next', Infinity) : await readRange(IDBKeyRange.lowerBound(start), 'next', Infinity);
    from = start === null ? [] : start;
    reachedStart = start === null;
    for (const r of rows) observeRow(r);
    view.addMany(rows);
    stats.loads += 1;
    emit({ ids: rows.map((r) => r.id), reason: 'page' });
    return rows.length;
  }
  /** The previous page: up to `n` live rows before the oldest loaded one. Returns how many arrived (0 at the start). */
  async function loadOlder(n = 200) {
    if (reachedStart || from === null) return 0;
    await writes;
    const upper = view.size ? sortKey(view.at(0)) : from;
    const rows = await readRange(IDBKeyRange.upperBound(upper, true), 'prev', n);
    if (rows.length < n) reachedStart = true;
    for (const r of rows) observeRow(r);
    if (rows.length) { from = rows[rows.length - 1]._k; view.addMany(rows); }
    stats.loads += 1;
    emit({ ids: rows.map((r) => r.id), reason: 'page' });
    return rows.length;
  }

  async function readRow(id) { const tx = db.transaction('rows'); return req(tx.objectStore('rows').get(id)); }

  /** Remote entries (another device, the MCP Worker, an import): merged per row on disk, then into the window. */
  async function ingest(entries) {
    const patches = [];
    for (const e of entries) { const rows = e?.payload?.type === 'rows' ? e.payload.payload?.rows : null; if (Array.isArray(rows)) patches.push(...rows); }
    if (!patches.length) return [];
    let changed = [];
    await (writes = writes.then(async () => {
      const tx = db.transaction(['rows', 'meta'], 'readwrite');
      const store = tx.objectStore('rows');
      const touched = new Map();
      const ids = [...new Set(patches.filter((p) => p && typeof p.id === 'string').map((p) => p.id))];
      const got = await Promise.all(ids.map((id) => req(store.get(id))));
      const disk = new Map(ids.map((id, k) => [id, got[k]]));
      for (const p of patches) {
        if (!p || typeof p.id !== 'string') continue;
        const cur = touched.has(p.id) ? touched.get(p.id) : disk.get(p.id);
        const next = mergeRow(cur, p);
        if (next !== cur) touched.set(p.id, next);
        for (const s of Object.values(p.at || {})) if (typeof s === 'string') hlc.observe(stampHlc(s)); // advance on ingest
      }
      for (const r of touched.values()) store.put(keyed(r));
      if (touched.size) bumpMeta(tx, hlc.peek());
      await done(tx);
      changed = [...touched.values()];
    }).catch((e) => { onError(e); }));
    for (const r of changed) { if (inWindow(r)) cache.delete(r.id); else cache.set(r.id, r); place(r); } // tombstones stay peekable
    if (changed.length) { emit({ ids: changed.map((r) => r.id), reason: 'remote' }); try { bc?.postMessage({ ids: changed.map((r) => r.id) }); } catch { /* closed */ } }
    return changed;
  }

  // another tab wrote rows: re-read them
  if (bc) bc.onmessage = async (e) => {
    const ids = e.data?.ids || [];
    const rows = (await Promise.all(ids.map(readRow))).filter(Boolean);
    try { const ww = await req(db.transaction('meta').objectStore('meta').get('w')); if (ww) { version = Math.max(version, ww.version || 0); hlc.observe(ww.clock); } } catch { /* closing */ }
    for (const r of rows) { if (inWindow(r)) cache.delete(r.id); else cache.set(r.id, r); place(r); }
    if (rows.length) emit({ ids: rows.map((r) => r.id), reason: 'tab' });
  };

  // ---- sync: one flight at a time, only in the tab holding the lock ----
  let flight = null, again = false, timer = null, attempts = 0, lastError = null, blocked = null;
  const RETRY = [500, 1000, 2000, 5000, 15000, 30000];
  const withLock = (fn) => (locks?.request ? locks.request(`qk-rows:${local}`, { ifAvailable: true }, (lock) => (lock ? fn() : { skipped: true })) : fn());

  async function pushOnce() {
    let out; ({ m: meta, out } = await getMeta()); // another tab may have pushed: the disk is the authority
    if (!out) {
      const tx = db.transaction(['pending'], 'readonly');
      const pend = await req(tx.objectStore('pending').getAll());
      if (!pend.length) return false;
      const rows = []; let bytes = 0;
      for (const p of pend) { const b = enc(JSON.stringify(p)); if (rows.length && bytes + b > MAX_ENTRY_BYTES) break; rows.push(p); bytes += b; }
      out = { seq: meta.seq + 1, ts: now(), rows };
      const tw = db.transaction('meta', 'readwrite'), ms = tw.objectStore('meta');
      meta = { ...(await req(ms.get('m'))), seq: out.seq }; // read-modify-write in one transaction: a pull's cursor or a seed written meanwhile stays
      ms.put({ ...meta }, 'm'); ms.put(out, 'outgoing');
      await done(tw);
    }
    await transport.push(name, [{ entry_id: `${device}:${out.seq}`, device_id: device, device_seq: out.seq, event_time: new Date(out.ts).toISOString(), payload: { type: 'rows', payload: { rows: out.rows } } }]);
    const tx = db.transaction(['pending', 'meta'], 'readwrite');
    const pend = tx.objectStore('pending');
    for (const sent of out.rows) {
      const cur = await req(pend.get(sent.id));
      if (!cur) continue;
      const set = {}, at = {};
      for (const [f, s] of Object.entries(cur.at)) if (s !== sent.at[f]) { set[f] = cur.set[f]; at[f] = s; }
      if (Object.keys(at).length) pend.put({ id: sent.id, set, at }); else pend.delete(sent.id);
    }
    tx.objectStore('meta').delete('outgoing');
    await done(tx);
    stats.entriesPushed += 1; stats.pushed += out.rows.length;
    return true;
  }

  // While a cold device is seeding from a checkpoint (meta.seed, below) the pull reads only the tail after the checkpoint's
  // cursor and keeps its progress in meta.seed.pulled: meta.cursor claims "every entry up to here is folded on this device"
  // and stays null until every part of a checkpoint is in (seedDone), so a crash midway re-seeds instead of skipping rows.
  async function pullAll() {
    meta = (await getMeta()).m;
    const seeding = (m) => m.cursor == null && m.seed;
    let from = seeding(meta) ? (meta.seed.pulled ?? meta.seed.from ?? null) : meta.cursor;
    const startedAt = from;
    for (;;) {
      const page = await transport.pull(name, from);
      if (page.entries.length) await ingest(page.entries);
      stats.pulled += page.entries.length;
      if (page.cursor !== from) {
        const c = page.cursor;
        meta = await updateMeta((m) => (seeding(m) ? { ...m, seed: { ...m.seed, pulled: c, pulledFrom: m.seed.pulledFrom ?? startedAt } } : { ...m, cursor: laterCursor(m.cursor, c) }));
      }
      from = page.cursor;
      if (!page.more || !page.entries.length) break;
    }
  }

  // ---- cold start from a checkpoint (lib/engine/checkpoint.js; PANGEA3-DESIGN §11, row #43) ----
  // meta 'm' is read and written in ONE transaction here, so a pull's progress and seedDone never overwrite each other
  async function updateMeta(fn) {
    const tx = db.transaction('meta', 'readwrite'), st = tx.objectStore('meta');
    const next = fn(await req(st.get('m')));
    st.put({ ...next }, 'm'); await done(tx);
    return next;
  }
  /** Fold one checkpoint part (row patches with their stamps) into this copy. Only on a device that has never completed a pull
   *  (meta.cursor null): it marks the device as seeding first, so a sync meanwhile pulls only the tail after `cursor`.
   *  Idempotent and order-free like any ingest (per-field LWW). Returns the rows it changed. */
  async function seed(patches, { cursor }) {
    let skip = false;
    meta = await updateMeta((m) => { if (m.cursor != null) { skip = true; return m; } return m.seed ? m : { ...m, seed: { from: String(cursor), pulled: null, pulledFrom: null } }; });
    if (skip) return [];
    return ingest(asEntries(patches));
  }
  /** Every part of the checkpoint at `cursor` is folded: the device now covers the log up to that cursor, and up to what the
   *  tail pull reached when that pull started at or before it (else the tail after `cursor` is read again; folding is idempotent). */
  async function seedDone(cursor) {
    await writes;
    const c = String(cursor);
    meta = await updateMeta((m) => {
      if (m.cursor != null || !m.seed) return m;
      const s = m.seed, { seed: _, ...rest } = m;
      const covered = s.pulled != null && (s.pulledFrom == null ? s.from == null || laterCursor(c, s.from) === c : laterCursor(c, s.pulledFrom) === c) ? laterCursor(c, s.pulled) : c;
      return { ...rest, cursor: covered };
    });
    return meta.cursor;
  }

  function sync() {
    if (!transport) return Promise.resolve({ skipped: true });
    if (flight) { again = true; return flight; }
    flight = (async () => {
      await writes;
      const r = await withLock(async () => { while (await pushOnce()); await pullAll(); return { ok: true }; });
      return r;
    })().then((r) => { attempts = 0; lastError = null; blocked = null; clearTimeout(timer); timer = null; return r; }, (e) => {
      lastError = String(e?.message || e);
      if (e?.status === 409) blocked = { status: 409, message: lastError };
      else { attempts += 1; clearTimeout(timer); timer = setTimeout(() => { timer = null; sync().catch(() => {}); }, RETRY[Math.min(attempts - 1, RETRY.length - 1)]); }
      throw e;
    }).finally(() => { flight = null; if (again) { again = false; sync().catch(() => {}); } });
    return flight;
  }
  let kickTimer = null;
  function kick(ms = 400) { if (!transport) return; clearTimeout(kickTimer); kickTimer = setTimeout(() => sync().catch(() => {}), ms); }

  return {
    name, device, view, stats, declaration: decl,
    put, load, loadOlder, ingest, sync, kick, seed, seedDone,
    /** A cold start from a checkpoint that has not finished (null when none): { from, pulled, pulledFrom }. */
    get seeding() { return meta.cursor == null ? meta.seed ?? null : null; },
    get reachedStart() { return reachedStart; },
    /** Committed write transactions of this browser's copy (as this tab last saw them): the cursor a snapshot derived from
     *  these rows is stamped with (lib/snapshot.js). Await flushed() first for a value that includes this tab's puts. */
    get version() { return version; },
    /** The tab's hybrid logical clock: the latest { ts, l } issued or observed. */
    get clock() { return hlc.peek(); },
    get from() { return from; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    setTransport(t) { transport = t; kick(0); },
    /** Every row on disk (live or not), for export and tests. */
    async all() { await writes; const tx = db.transaction('rows'); return req(tx.objectStore('rows').getAll()); },
    async pending() { await writes; const tx = db.transaction('pending'); return req(tx.objectStore('pending').getAll()); },
    async get(id) { return view.get(id) || (await readRow(id)); },
    /** Read these rows off disk into this tab's memory so peek() sees them (tombstones and rows outside the loaded window
     *  included); returns how many exist. A row already in memory is left as it is. */
    async prime(ids) {
      await writes; let n = 0;
      for (const id of ids) {
        if (view.get(id) || cache.get(id)) { n += 1; continue; }
        const r = await readRow(id);
        if (r) { n += 1; if (!(view.get(id) || cache.get(id))) { cache.set(id, r); place(r); } }
      }
      return n;
    },
    /** The row as this tab knows it right now, live or tombstoned (synchronous; undefined if never seen here). zai2's
     *  undo compares against it so a step never clobbers a newer write from another device. */
    peek: (id) => view.get(id) || cache.get(id),
    flushed: () => writes,
    status: () => ({ device, attempts, lastError, blocked, cursor: meta.cursor, seq: meta.seq }),
    async close() { clearTimeout(timer); clearTimeout(kickTimer); try { bc?.close(); } catch { /* gone */ } await writes; await flight?.catch(() => {}); clearTimeout(timer); clearTimeout(kickTimer); db.close(); },
  };
}
