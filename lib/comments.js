// Comments on a document of lines, Google Docs style: select words in a line, comment (the selection pill's button or
// ⌘⌥M), the words stay highlighted and the thread is a card in a rail beside them; replies, resolve. Generic parts of
// what webchat's public documents built (webchat src/lib/core/doc-anchor.js, reader-anchor.js, docs-state.js,
// client/docs-sync.js; the owner 2026-10-22) moved into the kit for zai3 (The owner 2026-11-11 17:58 PST: "for commenting we can
// use the same widget as in the reader/ webchat (but without send to chat)"). The app keeps only its server and its DOM.
//
// The model (PANGEA3 §7 Auth: "comments stream owner-devices only; guests write through the docs server"):
//   commentsDecl(name)   what this device wrote: an op log (scope 'cloud') of three absolute actions, `comment.add` (a comment
//                        id is written once: the first entry in the total order stands), `thread.resolve` (a register
//                        last-writer-wins on its `at`) and `thread.delete` (a tombstone set: once a thread id is in it the
//                        thread is gone on every device, in any order of arrival, and a repeat changes nothing). Delivered by commentSink to the app's server, which checks the role,
//                        sets the author and keeps the first copy of an id, so a replay never doubles a comment.
//   threadCacheDecl      the threads the server last answered (scope 'local'): the offline paint.
//   commentsUiDecl       the rail's own state (scope 'local'): the focused thread, new-thread drafts with their anchor,
//                        the text typed in each card, whether resolved threads are listed. Nothing of it lives in the DOM.
//   overlayThreads       the pure view: the server's threads plus the actions it has not acknowledged yet.
// Anchors (anchorOf / locateThread): a comment is on a span of one line: line id, the quoted words and their offsets in
// the line's text, plus a little context either side. Offsets are a hint, the quote is the anchor: an edited line finds
// the words again, a moved line is searched, a comment whose words are gone is detached (listed, never dropped).
import { declare } from './model.js';
import { field, on, set } from './schema.js';
import { registerGenerator } from './declare-keys.js';
import { parseSpec, matches } from './keys.js';

export const QUOTE_MAX = 600;
export const BODY_MAX = 4000;
export const CONTEXT = 48;
export const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === 'string' ? v : '');
const int0 = (v) => Math.max(0, Math.floor(Number(v) || 0));

// ---------------------------------------------------------------------------------------------------------- anchors
/** The anchor for a selection from `start` to `end` of a line's text: edges trimmed of blanks (a double-click takes the
 *  trailing space), quote capped, context kept. null when there is no line or no words. */
export function anchorOf(lineId, text, start, end) {
  const body = String(text ?? '');
  const from = Math.max(0, Math.min(body.length, int0(start)));
  let to = Math.max(from, Math.min(body.length, int0(end)));
  let a = from;
  while (a < to && /\s/u.test(body[a])) a += 1;
  while (to > a && /\s/u.test(body[to - 1])) to -= 1;
  const quote = body.slice(a, to).slice(0, QUOTE_MAX);
  if (!lineId || !quote) return null;
  return { lineId: String(lineId), quote, start: a, end: a + quote.length, prefix: body.slice(Math.max(0, a - CONTEXT), a), suffix: body.slice(a + quote.length, a + quote.length + CONTEXT) };
}

/** Find an anchor in `text`: { start, end, how } or null when the quote is gone. how: 'offset' (offsets still hold),
 *  'unique' (the quote appears once), 'context' (prefix or suffix decided among several), 'nearest' (closest to the old
 *  offset), 'loose' (whitespace-insensitive). */
export function resolveAnchor(text, anchor) {
  const body = String(text ?? ''), quote = String(anchor?.quote ?? '');
  if (!quote) return null;
  const start = Number.isFinite(anchor?.start) ? anchor.start : 0;
  if (body.slice(start, start + quote.length) === quote) return { start, end: start + quote.length, how: 'offset' };
  const hits = [];
  for (let at = body.indexOf(quote); at !== -1 && hits.length < 200; at = body.indexOf(quote, at + 1)) hits.push(at);
  if (hits.length === 1) return { start: hits[0], end: hits[0] + quote.length, how: 'unique' };
  if (hits.length > 1) {
    const prefix = str(anchor?.prefix), suffix = str(anchor?.suffix);
    const best = hits.map((at) => {
      let score = 0;
      if (prefix && body.slice(Math.max(0, at - prefix.length), at) === prefix) score += 2;
      if (suffix && body.slice(at + quote.length, at + quote.length + suffix.length) === suffix) score += 2;
      return { at, score, distance: Math.abs(at - start) };
    }).sort((x, y) => y.score - x.score || x.distance - y.distance)[0];
    return { start: best.at, end: best.at + quote.length, how: best.score >= 2 ? 'context' : 'nearest' };
  }
  const wanted = quote.replace(/\s+/gu, ' ').trim();
  if (!wanted) return null;
  const map = []; let flat = '', space = false;
  for (let i = 0; i < body.length; i += 1) {
    if (/\s/u.test(body[i])) { space = true; continue; }
    if (space && flat) { flat += ' '; map.push(i); }
    space = false; flat += body[i]; map.push(i);
  }
  const at = flat.indexOf(wanted);
  if (at === -1) return null;
  return { start: map[at], end: map[Math.min(map.length - 1, at + wanted.length - 1)] + 1, how: 'loose' };
}

/** Where a thread's words are now. rows: [{ lineId, text }] in document order. { lineId, start, end, how, moved } or null. */
export function locateThread(thread, rows = []) {
  if (!thread?.quote) return null;
  const own = rows.find((r) => r.lineId === thread.lineId);
  if (own) { const hit = resolveAnchor(own.text, thread); if (hit) return { lineId: own.lineId, ...hit, moved: false }; }
  for (const r of rows) {
    if (r === own) continue;
    const at = String(r.text ?? '').indexOf(thread.quote);
    if (at !== -1) return { lineId: r.lineId, start: at, end: at + thread.quote.length, how: 'elsewhere', moved: true };
  }
  return null;
}

/** Google Docs' "insert comment" chord: ⌘⌥M on a Mac, Ctrl+Alt+M elsewhere (lib/keys.js `mod+alt+m`), matched on the physical
 *  key as well as the character (⌥M types µ on a Mac; Dvorak moves the character, not the key). */
export const COMMENT_CHORD = 'mod+alt+m';
export function isCommentChord(e, { mac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '') } = {}) {
  if (!e) return false;
  const key = e.code === 'KeyM' || /^[mµ]$/i.test(String(e.key ?? '')) ? 'm' : String(e.key ?? '');
  return matches({ key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey }, parseSpec(COMMENT_CHORD, mac));
}

// ---------------------------------------------------------------------------------------------------------- the op log
/** A suggestion (docs parity v1.0: a comment that proposes an edit of its anchor), repaired or null: { kind: 'replace' | 'insert' | 'delete',
 *  text (what goes in; empty for delete), where ('before' | 'after': for an insert, which side of the anchored words) }. */
export const SUGGESTION_KINDS = Object.freeze(['replace', 'insert', 'delete']);
export function cleanSuggestion(v) {
  const p = plain(v);
  if (!SUGGESTION_KINDS.includes(p.kind)) return null;
  const text = p.kind === 'delete' ? '' : str(p.text).slice(0, BODY_MAX);
  if (p.kind !== 'delete' && !text) return null;
  return { kind: p.kind, text, where: p.where === 'before' ? 'before' : 'after' };
}
/** A comment.add payload repaired, or null (junk is a no-op, A4). The server sets the author; a client's is a hint. */
export function cleanComment(c) {
  const p = plain(c);
  const id = str(p.id), threadId = str(p.threadId), body = str(p.body).trim().slice(0, BODY_MAX);
  if (!ID_RE.test(id) || !ID_RE.test(threadId) || !body) return null;
  return { id, threadId, lineId: str(p.lineId).slice(0, 128), quote: str(p.quote).slice(0, QUOTE_MAX), start: int0(p.start), end: int0(p.end), prefix: str(p.prefix).slice(0, CONTEXT), suffix: str(p.suffix).slice(0, CONTEXT), body, author: str(p.author).slice(0, 64), at: str(p.at).slice(0, 40), ...(cleanSuggestion(p.suggestion) ? { suggestion: cleanSuggestion(p.suggestion) } : {}) };
}
/** A thread.resolve payload repaired, or null. */
export function cleanResolve(r) {
  const p = plain(r);
  return ID_RE.test(str(p.threadId)) ? { threadId: p.threadId, resolved: Boolean(p.resolved), at: str(p.at).slice(0, 40), ...(p.outcome === 'accepted' || p.outcome === 'rejected' ? { outcome: p.outcome } : {}) } : null;
}
/** A thread.delete payload repaired, or null. */
export function cleanDelete(r) {
  const p = plain(r);
  return ID_RE.test(str(p.threadId)) ? { threadId: p.threadId, at: str(p.at).slice(0, 40) } : null;
}
/** One op ({ type, payload }) as the server should take it, or null. */
export function cleanOp(op) {
  const o = plain(op);
  if (o.type === 'comment.add') { const p = cleanComment(o.payload); return p ? { type: o.type, payload: p } : null; }
  if (o.type === 'thread.resolve') { const p = cleanResolve(o.payload); return p ? { type: o.type, payload: p } : null; }
  if (o.type === 'thread.delete') { const p = cleanDelete(o.payload); return p ? { type: o.type, payload: p } : null; }
  return null;
}
// the two merge rules: a comment id is written once; a resolve is last-writer-wins on `at` (ties keep what is there)
export const commentAdd = (comments, payload) => { const c = cleanComment(payload); return !c || comments[c.id] ? comments : { ...comments, [c.id]: c }; };
export const threadResolve = (resolved, payload) => {
  const r = cleanResolve(payload); if (!r) return resolved;
  const have = resolved[r.threadId];
  if (have && (have.at > r.at || (have.at === r.at && have.resolved === r.resolved))) return resolved;
  return { ...resolved, [r.threadId]: { resolved: r.resolved, at: r.at, ...(r.outcome ? { outcome: r.outcome } : {}) } };
};
// a delete is a tombstone: a set keyed by thread id, never undone (an add-wins set would resurrect a thread another device
// still shows; here the delete wins, and the earliest `at` is kept so two devices deleting at once agree on one value)
export const threadDelete = (deleted, payload) => {
  const r = cleanDelete(payload); if (!r) return deleted;
  const have = deleted[r.threadId];
  if (have && have.at <= r.at) return deleted;
  return { ...deleted, [r.threadId]: { at: r.at } };
};
const cleanDeleted = (v) => Object.fromEntries(Object.entries(plain(v)).filter(([k, r]) => ID_RE.test(k) && r && typeof r === 'object').map(([k, r]) => [k, { at: str(r.at) }]));
const cleanComments = (v) => Object.fromEntries(Object.entries(plain(v)).map(([k, c]) => [k, cleanComment(c)]).filter(([k, c]) => c && c.id === k));
const cleanResolved = (v) => Object.fromEntries(Object.entries(plain(v)).filter(([k, r]) => ID_RE.test(k) && r && typeof r === 'object').map(([k, r]) => [k, { resolved: Boolean(r.resolved), at: str(r.at), ...(r.outcome === 'accepted' || r.outcome === 'rejected' ? { outcome: r.outcome } : {}) }]));

// generators for validate() (the gate): valid payloads most of the time, so every action is exercised, junk otherwise
const IDS = ['c000001', 'c000002', 'c000003', 't000001', 't000002'], AT = ['2026-11-11T00:00:00.000Z', '2026-11-11T00:00:01.000Z', ''];
const genComments = (r) => (r.chance(0.6)
  ? ['comment.add', r.chance(0.9) ? { id: r.pick(IDS), threadId: r.pick(IDS), lineId: 'l1', quote: r.pick(['words', 'x']), start: r.int(0, 3), end: r.int(3, 6), body: r.pick(['hi', 'a note', '']), at: r.pick(AT), ...(r.chance(0.3) ? { suggestion: r.pick([{ kind: 'replace', text: 'fox' }, { kind: 'delete' }, { kind: 'insert', text: 'x', where: 'before' }, { kind: 'bogus' }]) } : {}) } : { id: r.pick(['', 'x', null]) }]
  : r.chance(0.7) ? ['thread.resolve', r.chance(0.9) ? { threadId: r.pick(IDS), resolved: r.chance(0.5), at: r.pick(AT), ...(r.chance(0.4) ? { outcome: r.pick(['accepted', 'rejected', 'x']) } : {}) } : { threadId: 7 }]
    : ['thread.delete', r.chance(0.9) ? { threadId: r.pick(IDS), at: r.pick(AT) } : { threadId: 7 }]);
const genUi = (r) => {
  const k = r.int(0, 5), id = r.pick(IDS);
  if (k === 0) return ['focus', { id: r.chance(0.8) ? id : null }];
  if (k === 1) return ['draft.open', { id, lineId: 'l1', quote: r.pick(['w', 'words']), start: r.int(0, 2), end: r.int(2, 5) }];
  if (k === 2) return ['draft.close', { id }];
  if (k === 3) return ['text', { id, text: r.pick(['', 'typing', 'typed']) }];
  if (k === 4) return ['delete.arm', { id: r.chance(0.7) ? id : null }];
  return ['resolved.show', { on: r.chance(0.5) }];
};
const genCache = (r) => ['threads.set', { threads: r.chance(0.8) ? [{ id: r.pick(IDS), comments: [] }] : r.pick([[], null]) }];

/** The op log of one document's comments, as this device wrote them. */
export const commentsDecl = (name) => {
  const d = declare({
    name, scope: 'cloud',
    fields: { comments: field({}, cleanComments), resolved: field({}, cleanResolved), deleted: field({}, cleanDeleted) },
    actions: { 'comment.add': on('comments', commentAdd), 'thread.resolve': on('resolved', threadResolve), 'thread.delete': on('deleted', threadDelete) },
  });
  registerGenerator(name, genComments);
  return d;
};

/** The threads the server last answered, for the offline paint. */
export const threadCacheDecl = (name) => {
  const d = declare({
    name, scope: 'local',
    fields: { threads: field([], (v) => (Array.isArray(v) ? v.filter((t) => t && ID_RE.test(str(t.id))).slice(0, 2000) : [])) },
    actions: { 'threads.set': set('threads', 'threads') },
  });
  registerGenerator(name, genCache);
  return d;
};

// ---------------------------------------------------------------------------------------------------------- the rail's state
// a draft may be a suggestion in the making (sk: its kind, sw: which side of the words an insert goes), so the card opens as a suggestion
const cleanDraft = (d) => { const p = plain(d); return ID_RE.test(str(p.id)) && str(p.lineId) && str(p.quote) ? { id: p.id, lineId: str(p.lineId), quote: str(p.quote).slice(0, QUOTE_MAX), start: int0(p.start), end: int0(p.end), prefix: str(p.prefix), suffix: str(p.suffix), ...(p.sk === 'replace' || p.sk === 'insert' ? { sk: p.sk, sw: p.sw === 'before' ? 'before' : 'after' } : {}) } : null; };
const cleanDrafts = (v) => (Array.isArray(v) ? v.map(cleanDraft).filter(Boolean).slice(-20) : []);
const cleanTexts = (v) => Object.fromEntries(Object.entries(plain(v)).filter(([k, t]) => ID_RE.test(k) && typeof t === 'string' && t).map(([k, t]) => [k, t.slice(0, BODY_MAX)]).slice(-50));
/** The rail: focus (a thread id or null), armed (the thread whose delete button was pressed once, null: none; the second press
 *  deletes), drafts (new threads not yet written, with their anchor), text (what is typed in
 *  each card, by thread id), showResolved. Every action is absolute (set this, open that), so a replay is idempotent. */
export const commentsUiDecl = (name) => { const d = declare({
  name, scope: 'local',
  fields: { focus: field(null, (v) => (ID_RE.test(str(v)) ? v : null)), drafts: field([], cleanDrafts), text: field({}, cleanTexts), showResolved: field(false, Boolean), armed: field(null, (v) => (ID_RE.test(str(v)) ? v : null)) },
  actions: {
    focus: set('focus', 'id'),
    'delete.arm': set('armed', 'id'),
    'draft.open': on('drafts', (ds, p) => { const d = cleanDraft(p); return !d || ds.some((x) => x.id === d.id) ? ds : [...ds, d]; }),
    'draft.close': on('drafts', (ds, { id } = {}) => (ds.some((x) => x.id === id) ? ds.filter((x) => x.id !== id) : ds)),
    text: on('text', (t, { id, text } = {}) => {
      if (!ID_RE.test(str(id)) || typeof text !== 'string') return t;
      if (!text) { if (!(id in t)) return t; const { [id]: _gone, ...rest } = t; return rest; }
      return t[id] === text ? t : { ...t, [id]: text.slice(0, BODY_MAX) };
    }),
    'resolved.show': set('showResolved', 'on'),
  },
}); registerGenerator(name, genUi); return d; };

// ---------------------------------------------------------------------------------------------------------- views
/** The op log's state as threads (what every device converges to): comments grouped by thread in (at, id) order, the
 *  thread anchored where its first comment was made, a resolve overlaid. */
export function threadsOf(state) {
  const byId = new Map();
  const list = Object.values(plain(state?.comments)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  const gone = plain(state?.deleted);
  for (const c of list) {
    if (gone[c.threadId]) continue;
    if (!byId.has(c.threadId)) byId.set(c.threadId, { id: c.threadId, lineId: c.lineId, quote: c.quote, start: c.start, end: c.end, prefix: c.prefix, suffix: c.suffix, comments: [], resolvedAt: null, ...(c.suggestion ? { suggestion: c.suggestion } : {}) });
    byId.get(c.threadId).comments.push({ id: c.id, body: c.body, author: c.author, createdAt: c.at });
  }
  for (const [id, r] of Object.entries(plain(state?.resolved))) if (byId.has(id)) { byId.get(id).resolvedAt = r.resolved ? r.at || 'resolved' : null; byId.get(id).outcome = r.resolved ? r.outcome || null : null; }
  return [...byId.values()];
}

/** The threads as shown: the server's, plus the entries it has not acknowledged (replica.pending, {type, payload}). An
 *  undelivered delete removes its thread at once (and any undelivered comment on it); an undelivered resolve flips its thread; an undelivered comment joins its thread (or makes it), marked pending. */
export function overlayThreads(threads, pending = [], { me = '' } = {}) {
  const byId = new Map((threads || []).map((t) => [t.id, { ...t, comments: [...(t.comments || [])] }]));
  const gone = new Set(pending.filter((e) => e.type === 'thread.delete').map((e) => e.payload?.threadId));
  for (const id of gone) byId.delete(id);
  for (const { type, payload } of pending) {
    if (type === 'thread.delete') continue;
    if (type === 'thread.resolve') { const t = byId.get(payload?.threadId); if (t) { t.resolvedAt = payload.resolved ? payload.at || 'pending' : null; t.outcome = payload.resolved ? payload.outcome || null : null; } continue; }
    if (type !== 'comment.add') continue;
    const c = cleanComment(payload); if (!c || gone.has(c.threadId)) continue;
    let t = byId.get(c.threadId);
    if (!t) { t = { id: c.threadId, lineId: c.lineId, quote: c.quote, start: c.start, end: c.end, prefix: c.prefix, suffix: c.suffix, comments: [], resolvedAt: null, pending: true, ...(c.suggestion ? { suggestion: c.suggestion } : {}) }; byId.set(t.id, t); }
    if (!t.comments.some((x) => x.id === c.id)) t.comments.push({ id: c.id, body: c.body, author: c.author || me, createdAt: c.at, pending: true });
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------------------------------------- hit testing
/** A Range that can no longer be hit: gone, collapsed (the editor redrew its row and the text nodes it held were replaced; the
 *  range collapses until the next paint re-places it) or on detached nodes. */
export const rangeIsStale = (r) => !r || r.collapsed === true || r.startContainer?.isConnected === false;
/** The thread whose highlight is under the viewport point (x, y): `ranges` is a Map of thread id -> Range (or any object with
 *  getClientRects). A Range's rects are live, so this is the geometry now, never a cached copy; `pad` px of slack each side;
 *  `skip(id)` leaves a thread out (a resolved one). First in map order wins. null when none. */
export function threadAtPoint(ranges, x, y, { pad = 1, skip = () => false } = {}) {
  for (const [id, r] of ranges || []) {
    if (skip(id) || rangeIsStale(r)) continue;
    for (const b of r.getClientRects?.() || []) if (x >= b.left - pad && x <= b.right + pad && y >= b.top - pad && y <= b.bottom + pad) return id;
  }
  return null;
}

/** Rail layout: cards [{ id, want (the top its span asks for, px), h (height, px) }] placed in `want` order without
 *  overlap, `gap` px apart. The focused card sits at its want; the cards after it are pushed down, the cards before it
 *  up. Pure: { id -> top }. */
export function stackCards(cards, { gap = 8, focus = null } = {}) {
  const list = [...cards].filter((c) => Number.isFinite(c.want)).sort((a, b) => a.want - b.want || (a.id < b.id ? -1 : 1));
  const out = {};
  let k = list.findIndex((c) => c.id === focus);
  if (k < 0) k = 0;
  if (!list.length) return out;
  out[list[k].id] = list[k].want;
  for (let i = k + 1, floor = list[k].want + (list[k].h || 0) + gap; i < list.length; i++) { const top = Math.max(list[i].want, floor); out[list[i].id] = top; floor = top + (list[i].h || 0) + gap; }
  for (let i = k - 1, ceil = list[k].want - gap; i >= 0; i--) { const top = Math.min(list[i].want, ceil - (list[i].h || 0)); out[list[i].id] = top; ceil = top - gap; }
  return out;
}

// ---------------------------------------------------------------------------------------------------------- the sink
// The op log's transport (an HTTP sink to the app's server) lives in comments-transport.js: the one place that sends.
export { commentSink, postOps, isOffline } from './comments-transport.js';
