// Edit history and named versions of a document of rows (The owner 2026-11-12 11:00 PST: "edit history view with name-able
// versions"; "restore creates a new op, never rewrites history"). Pure and DOM-free (A4); the app pulls the stream and draws.
//
// What a version IS. A row store is per-field last-writer-wins over HLC stamps (rows.js, A8): every write is an entry in the
// append-only stream carrying the stamp of each field it set, and the stream is never rewritten (A2: the log is canonical).
// So the document "as of" a stamp H is a pure fold of the log: for every field, the value of the latest write whose stamp is
// at most H (`foldAt`). A version is therefore just a horizon stamp, an event time in the one logical order every device
// folds; nothing is copied, nothing can drift from the log, and a version can be named, renamed or forgotten without touching
// the document. A write that reaches the stream late but carries a stamp at or before H (an offline device) belongs to that
// version once it arrives: the version is "everything stamped up to H", which is how the live document merges too.
//
//   foldAt(entries, H)          rows as of H: Map id -> row (fields and their stamps)
//   sessionsOf(entries, opts)   the history list: edit sessions, newest first, grouped by writer and a quiet gap
//   diffRows(before, after)     which rows were added, changed or removed between two folds (the "highlight changes" view)
//   restorePuts(current, snap)  the puts that make the live document equal a snapshot: NEW absolute writes, stamped now by
//                               the store, that win by being later. Restore is an edit like any other (undoable, synced,
//                               merged), never a rewind: a device that was offline keeps its own later writes where they
//                               do not conflict, and the pre-restore state is itself a version in the log.
//   versionRow / versionsOf     named versions are rows of the document (kind 'version', no zone, so no editor sees them):
//                               id `ver:<id>`, `body` the name, `vat` the horizon stamp; a rename is an absolute write of
//                               `body`, a delete a tombstone. They merge and sync with the document and work offline.
import { mergeRow, stampTime, stampWriter } from './engine/rows.js';

export const VERSION_ROW = 'ver:';
export const VERSION_ID = /^[a-z0-9][a-z0-9_-]{5,39}$/;
export const NAME_MAX = 120;
const rowsOfEntry = (e) => (e?.payload?.type === 'rows' && Array.isArray(e.payload.payload?.rows) ? e.payload.payload.rows : []);
const stamps = (p) => Object.values(p?.at || {}).filter((s) => typeof s === 'string');

/** The rows as of horizon stamp H (inclusive): every patch field with a stamp above H is left out. `H` null: everything. */
export function foldAt(entries, H = null) {
  const map = new Map();
  for (const e of entries || []) {
    for (const p of rowsOfEntry(e)) {
      if (!p || typeof p.id !== 'string') continue;
      let patch = p;
      if (H !== null) {
        const set = {}, at = {};
        for (const [f, v] of Object.entries(p.set || {})) { const s = p.at?.[f]; if (typeof s === 'string' && s <= H) { set[f] = v; at[f] = s; } }
        if (!Object.keys(set).length) continue;
        patch = { id: p.id, set, at };
      }
      const old = map.get(p.id), next = mergeRow(old, patch);
      if (next !== old) map.set(p.id, next);
    }
  }
  return map;
}

/** The newest stamp in the log (the horizon of "the current version"), or null. */
export function lastStamp(entries) {
  let m = null;
  for (const e of entries || []) for (const p of rowsOfEntry(e)) for (const s of stamps(p)) if (m === null || s > m) m = s;
  return m;
}

/** Edit sessions, newest first. Each entry of the log has the stamps of the fields it wrote; consecutive entries by one writer
 *  (a device; stamps name `<device>-<tab>`) whose stamps are within `gapMs` of each other make one session
 *  { key, writer, from, to (stamps), startedAt, endedAt (ms), rows (distinct row ids), entries }. `key` is `to` (a stamp is unique, so
 *  a session's name never changes while it grows at its end; it is the horizon its preview is folded at). */
export function sessionsOf(entries, { gapMs = 10 * 60_000, split = (w) => String(w).split('-')[0] } = {}) {
  const items = [];
  for (const e of entries || []) {
    const ss = []; const ids = new Set();
    for (const p of rowsOfEntry(e)) { for (const s of stamps(p)) ss.push(s); if (p?.id) ids.add(p.id); }
    if (!ss.length) continue;
    ss.sort();
    items.push({ writer: split(stampWriter(ss[ss.length - 1])), from: ss[0], to: ss[ss.length - 1], at: stampTime(ss[ss.length - 1]), ids });
  }
  items.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.writer === it.writer && it.at - last.endedAt <= gapMs) {
      last.to = it.to > last.to ? it.to : last.to; last.key = last.to; last.endedAt = Math.max(last.endedAt, it.at); last.entries += 1; for (const id of it.ids) last._ids.add(id); last.rows = last._ids.size;
    } else out.push({ key: it.to, writer: it.writer, from: it.from, to: it.to, startedAt: stampTime(it.from), endedAt: it.at, entries: 1, rows: it.ids.size, _ids: new Set(it.ids) });
  }
  for (const s of out) delete s._ids;
  return out.reverse();
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** The fields that make a row's content (what a restore writes, what a diff compares). */
export const CONTENT_FIELDS = Object.freeze(['kind', 'body', 'mvseen', 'ord', 'indent', 'zone', 'tab', 'deleted_at']);

/** What changed from `before` to `after` (two foldAt results): { added, changed, removed } row ids. A row is live when
 *  `live(row)` (default: has a zone and no tombstone); added = live after and not before, removed = live before and not after,
 *  changed = live in both with another body or place. */
export function diffRows(before, after, { live = (r) => !r.deleted_at && typeof r.zone === 'string', fields = CONTENT_FIELDS } = {}) {
  const added = [], changed = [], removed = [];
  const ids = new Set([...before.keys(), ...after.keys()]);
  for (const id of ids) {
    const a = before.get(id), b = after.get(id), la = a && live(a), lb = b && live(b);
    if (!la && lb) added.push(id);
    else if (la && !lb) removed.push(id);
    else if (la && lb && fields.some((f) => f !== 'deleted_at' && !same(a[f], b[f]))) changed.push(id);
  }
  return { added, changed, removed };
}

/** The puts that make `current` (Map id -> row, the live store) equal `snap` on the content fields: per differing row, absolute
 *  writes of the snapshot's values for the fields that differ (a body travels with its `mvseen`, the group is written together);
 *  a row the snapshot never had gets a tombstone; a row only the snapshot had is written whole (it comes back, under its own
 *  id, so a comment on it finds it again). `skip(row)` keeps rows that are not content (versions, tabs of another meaning) out
 *  of it. `at`: the action's time (the tombstone and updated_at; the store stamps every field with a later HLC). */
export function restorePuts(current, snap, at, { skip = () => false, fields = CONTENT_FIELDS } = {}) {
  const iso = new Date(at).toISOString(), puts = [];
  const ids = new Set([...current.keys(), ...snap.keys()]);
  for (const id of [...ids].sort()) {
    const cur = current.get(id), tgt = snap.get(id);
    if ((cur && skip(cur)) || (tgt && skip(tgt))) continue;
    if (!tgt) { if (cur && !cur.deleted_at) puts.push({ id, set: { deleted_at: iso, updated_at: iso } }); continue; }
    const set = {};
    for (const f of fields) if (!same(cur?.[f], tgt[f]) && (f in tgt || cur?.[f] !== undefined)) set[f] = tgt[f] ?? null;
    if (set.body !== undefined && set.mvseen === undefined) set.mvseen = tgt.mvseen ?? null;
    if (set.mvseen !== undefined && set.body === undefined) set.body = tgt.body ?? '';
    if (!Object.keys(set).length) continue;
    puts.push({ id, set: { ...set, updated_at: iso } });
  }
  return puts;
}

// ---------------------------------------------------------------------------------------------------- named versions
export const isVersionRow = (r) => r?.kind === 'version' && typeof r.id === 'string' && r.id.startsWith(VERSION_ROW);
/** The put that names a version at horizon `vat` (a stamp). The id comes from the action (A7), so a retry is the same row. */
export function nameVersionPuts(id, name, vat, at) {
  const nm = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  if (!VERSION_ID.test(id) || !nm || typeof vat !== 'string' || !vat) return [];
  const iso = new Date(at).toISOString();
  return [{ id: `${VERSION_ROW}${id}`, set: { kind: 'version', body: nm, vat, created_at: iso, updated_at: iso, deleted_at: null } }];
}
/** Rename: an absolute write of the name only (the horizon is the version's identity and never changes). */
export function renameVersionPuts(id, name, at) {
  const nm = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return VERSION_ID.test(id) && nm ? [{ id: `${VERSION_ROW}${id}`, set: { body: nm, updated_at: new Date(at).toISOString() } }] : [];
}
export const forgetVersionPuts = (id, at) => (VERSION_ID.test(id) ? [{ id: `${VERSION_ROW}${id}`, set: { deleted_at: new Date(at).toISOString(), updated_at: new Date(at).toISOString() } }] : []);
/** The named versions in a store's rows, oldest horizon first: [{ id, name, vat, createdAt }]. */
export function versionsOf(rows) {
  const out = [];
  for (const r of rows || []) {
    if (!isVersionRow(r) || r.deleted_at || typeof r.vat !== 'string') continue;
    const id = r.id.slice(VERSION_ROW.length);
    if (VERSION_ID.test(id)) out.push({ id, name: String(r.body ?? '').slice(0, NAME_MAX), vat: r.vat, createdAt: r.created_at || null });
  }
  return out.sort((a, b) => (a.vat < b.vat ? -1 : a.vat > b.vat ? 1 : a.id < b.id ? -1 : 1));
}
