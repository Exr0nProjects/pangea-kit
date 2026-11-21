// The kit's text editor core: state, one reducer, the render map, and the input adapter. The owner 2026-11-08 23:29-23:33 PST:
// "keystroke is an action should go thru the exact reducer, should be no way for styling to change what keys dose";
// "every interaction < 100ms visible response"; "all state needs to be owned by the kit , including scroll state";
// "make generalizable rules"; keep our own editor (no CodeMirror/ProseMirror); 23:34: keep structured rows (one record per
// line), the adapter maps a text selection over the rows.
//
// The five rules, by construction here (lint and the deploy gate check the rest, lib/editor/gate.mjs):
//  1. the kit owns all state: the rows (doc), caret/selection, scroll anchor (item key + pixel offset), focus, folds,
//     pending writes, composition, plus an `ext` subtree the app's reducer owns (its undo history)
//  2. the view is a projection: every rendered element carries data-addr (a row id) or data-inert; point -> address goes
//     through the event target / caretPositionFromPoint + data-addr, address -> coordinates through the same map
//  3. every change is an id-keyed idempotent action through dispatch(): beforeinput is always cancelled and mapped from its
//     inputType and the STATE selection (never from layout); IME composition is the one exception (the browser edits the
//     composing line, read back once at compositionend); one delegated listener on the root
//  4. every action commits synchronously and paints in the next frame; event -> next frame is recorded per action
//  5. dev mode: a MutationObserver throws on any DOM change outside a kit commit; checks() exposes the projection diff
//
// app = {
//   init() -> ext                         the app's own state subtree (undo history ...), kept in the kit state
//   items(doc, state) -> [item]           what to render, in order; an item is { key, addr? } (addr: the row id it edits)
//   render(item, state) -> vnode          pure: { tag, cls, addr | inert, editable, attrs, text, children: [string | vnode] }
//   estimate(item) -> px                  height guess before measuring
//   textOf(row) -> string                 the row's text (caret offsets index into it)
//   folded?(text) -> [[from, to], ...]    runs of the text that are never drawn, even on the caret's line (fold.js foldRuns over the
//                                         app's marks; decorate.js `fold`): an arrow key steps over one and a drawn character
//   reduce(state, action, ctx) -> { puts?, sel?, reveal? } | null       pure apart from state.ext; ctx = { lines, index, get, now }
//   keys: ['mod+z', 'Tab', ...]           keydown chords the app maps (the kit cancels them and dispatches { type: 'key', name })
// }
// doc = { lines() -> ordered live rows, get(id), put(puts), loadOlder?(n), atStart?() | reachedStart? }  (lib/engine/rows.js
//   through rowsDoc(), or memoryLines()). A paged doc (loadOlder, not at its start) gets ⌘A and ⌘F over the whole document:
//   the kit reads the remaining pages and re-resolves the op (state.find.complete, state.wide).
// Scroll, landing and paging: lib/editor/scroll.js (anchor + follow as kit state, intent from user input only, settle).
import { heightIndex, windowFor } from '../components.js';
import { parseSpec, matches } from '../keys.js';
import { ulid } from '../engine/ulid.js';
import { selectAll, findAll, dropLines } from './lines.js';
import { vimNotation } from './vimmode.js';
import { mapPoint } from '../engine/structure.js';
import { scrollStep, intentTracker, atEnd } from './scroll.js';
import { UI_DEFAULTS } from '../laws-ui/contract.js';
import { declareEditor } from './declare.js';
import { refillPuts, emptyZones, checkRefill } from './refill.js';
import { rollPuts, rollRows, checkRollover } from './rollover.js';
import { applyPresence } from '../presence.js';
import { every } from '../timers.js';
import { clampH, inEmbedBody } from './embed.js';
import { stepCaret } from './fold.js';

export const ADDR = 'data-addr', INERT = 'data-inert';
let instances = 0; // a counter for timer owner names only (every() allows one timer per owner); never UI state
// actions that cannot change which zones hold rows: they never trigger a refill
const NO_REFILL = new Set(['select', 'scroll', 'focus', 'fold', 'pending', 'find', 'select-all', 'move', 'gesture', 'compose-start', 'refill', 'embed', 'presence', 'hover', 'gutter', 'vmod', 'vim']);
export const KIT_ACTIONS = ['input', 'key', 'move', 'select', 'compose-start', 'compose-end', 'scroll', 'focus', 'fold', 'pending', 'remote', 'page', 'pointer', 'select-all', 'find', 'gesture', 'refill', 'day.roll', 'embed', 'presence', 'hover', 'drag', 'gutter', 'vmod', 'vim', 'vimkey'];

// ------------------------------------------------------------------ docs
/** An in-memory doc of rows (tests, the model run, the textarea oracle): put() merges sets, lines() is the live order. */
export function memoryLines(rows = [], { sortKey = (r) => [r.ord ?? 0, r.id], live = (r) => !r.deleted_at } = {}) {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  const cmp = (a, b) => { const x = sortKey(a), y = sortKey(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
  let cache = null;
  return {
    lines() { if (!cache) cache = [...byId.values()].filter(live).sort(cmp); return cache; },
    get: (id) => byId.get(id) || null,
    peek: (id) => byId.get(id) || null,
    put(puts) { for (const p of puts) byId.set(p.id, { ...(byId.get(p.id) || { id: p.id }), ...p.set }); cache = null; },
  };
}
/** lib/engine/rows.js as an editor doc. */
export const rowsDoc = (rows) => ({ lines: () => rows.view.rows(), get: (id) => rows.view.get(id), peek: (id) => rows.peek?.(id) ?? rows.view.get(id), put: (p, o) => rows.put(p, o), loadOlder: (n) => rows.loadOlder(n), atStart: () => rows.reachedStart !== false });
/** Whether the doc holds every row (an unpaged doc always does). */
export const docComplete = (doc) => (typeof doc.atStart === 'function' ? doc.atStart() : doc.reachedStart !== false);
// actions that leave a pending document-wide op (state.wide) standing; any other action cancels it
const KEEPS_WIDE = new Set(['page', 'remote', 'scroll', 'focus', 'pending', 'select-all', 'find', 'embed', 'presence', 'hover', 'drag', 'gutter', 'vmod', 'vim']);
/** The kit actions that edit the document (text, keys the app maps, a composition's result): idempotent by their intent id
 *  (A7: the action id is the rows.put intent), not by value, so lib/editor/declare.js declares them under conflict 'log'.
 *  An app adds its own text edits with contract.edits; every other action is absolute (conflict 'lww'). */
export const EDIT_ACTIONS = Object.freeze(['input', 'key', 'compose-end', 'pointer', 'vimkey']);
/** Edits refused while a select-all is still reading pages (row 55): the selection does not cover the document yet, so a
 *  delete or replacement would act on the loaded rows only. Refused in the reducer (the doc is untouched, the wide op
 *  stands) with state.notice = { code: WIDE_PENDING, type, id }: the visible feedback, cleared once the selection covers
 *  the document (or by any action that cancels the select-all). pointer actions do not act on the selection. */
export const WIDE_PENDING = 'select-all-loading';
const REFUSED_WHILE_WIDE = new Set(['input', 'key', 'compose-end', 'vimkey']);
/** A read-only editor (createEditor({ readOnly: true }): a commenter, a viewer that may select): every action still runs
 *  (select, scroll, find, folds, ⌘A, copy) but no action writes the doc. A text edit, an app key, a pointer action or a
 *  composition whose reducer answer has rows to put is refused in the reducer, never reaching doc.put, with
 *  state.notice = { code: READ_ONLY, type, id }: the visible feedback. The refill sentinel writes nothing either. The
 *  server is still the authority (a reader's write is refused there); this is the client side of the same rule. */
export const READ_ONLY = 'read-only';
// a selection payload: { a: { id, off }, f: { id, off } } (anything else is junk: the action is a no-op, A4 totality)
const isPt = (p) => p && typeof p === 'object' && typeof p.id === 'string' && Number.isFinite(p.off);
export const isSel = (s) => Boolean(s && typeof s === 'object' && isPt(s.a) && isPt(s.f));

// ------------------------------------------------------------------ pure state
export function initState(app) {
  // kill: the kill ring, kit state like the caret. ⌃K (deleteHardLineForward) kills; consecutive ⌃K presses append;
  // any other action ends the append; ⌃Y (insertFromYank) inserts the ring
  // anchor { id, px } + follow 'free' | 'pinned' | 'bottom': the scroll state (lib/editor/scroll.js); wide: a document-wide
  // op waiting for unloaded pages ({ op: 'select-all' })
  // landing: the lifecycle of a landing the app asked for (lib/editor/scroll.js): { id, status: 'pending' | 'landed' |
  // 'failed', since }; notice: a refusal the user must see ({ code: WIDE_PENDING, type, id })
  return { sel: null, goal: null, gesture: null, anchor: null, follow: 'free', landing: null, wide: null, notice: null, focus: false, folds: [], pending: 0, composing: null, rev: 0, reveal: false, kill: { text: '', open: false }, find: null, peers: {}, embeds: {}, modal: null, embedFocus: null, embedDrag: null, embedTitleEdit: null, hover: null, drag: null, gutter: null, vmod: { held: false, latched: false }, vim: { on: false }, ext: app.init ? app.init() : {} };
}
const before = (a, b, idx) => { const i = idx(a.id), j = idx(b.id); return i < j || (i === j && a.off <= b.off); };
export const ordered = (sel, idx) => (before(sel.a, sel.f, idx) ? sel : { a: sel.f, f: sel.a });
export const collapsed = (sel) => sel.a.id === sel.f.id && sel.a.off === sel.f.off;

// ------------------------------------------------------------------ emacs text bindings (macOS), as intents
/** ⌃key -> the inputType Chromium names it (the adapter dispatches these itself on macOS). */
export const EMACS = { k: 'deleteHardLineForward', d: 'deleteContentForward', h: 'deleteContentBackward', t: 'insertTranspose', y: 'insertFromYank', o: 'insertOpenLine' };
/** ⌃O (macOS insertNewlineIgnoringFieldEditor / openLine): a line break after the caret, the caret stays. Headless Chromium
 *  emits nothing for it, so the kit maps it from state like the other chords. */
export const OPEN_LINE = 'insertOpenLine';
/** The one kill: ⌃K. */
export const KILL = 'deleteHardLineForward';
/** The flat text of a selection over the rows (lines joined by \n). */
export function textBetween(sel, lines, textOf) {
  const idx = (id) => lines.findIndex((r) => r.id === id);
  let i = idx(sel.a.id), j = idx(sel.f.id), ao = sel.a.off, fo = sel.f.off;
  if (i < 0 || j < 0) return '';
  if (i > j || (i === j && ao > fo)) [i, j, ao, fo] = [j, i, fo, ao];
  if (i === j) return textOf(lines[i]).slice(ao, fo);
  const out = [textOf(lines[i]).slice(ao)];
  for (let k = i + 1; k < j; k++) out.push(textOf(lines[k]));
  out.push(textOf(lines[j]).slice(0, fo));
  return out.join('\n');
}
/** An input action as the app reduces it: a yank carries the kill ring's text, a transpose becomes the replacement of the
 *  two characters it swaps (textarea rules: mid-line swaps around the caret and steps past; at the line end swaps the
 *  last two; at the line start, on a line under two characters or over a selection it does nothing). Returns null for a
 *  no-op. Pure over (state, lines): the model run replays it from the log. */
export function intentOf(a, state, lines, textOf) {
  if (a.type !== 'input') return a;
  if (a.inputType === 'insertFromYank') return state.kill.text ? { ...a, text: state.kill.text } : null;
  if (a.inputType === OPEN_LINE) return { ...a, inputType: 'insertParagraph' };
  if (a.inputType === 'insertTranspose') {
    const s0 = a.sel; if (!s0 || !collapsed(s0)) return null;
    const row = lines.find((r) => r.id === s0.f.id); if (!row) return null;
    const t = textOf(row), off = s0.f.off;
    if (off === 0 || t.length < 2) return null;
    const r0 = off >= t.length ? t.length - 2 : off - 1, r1 = r0 + 2;
    return { ...a, inputType: 'insertReplacementText', text: t[r0 + 1] + t[r0], sel: { a: { id: row.id, off: r0 }, f: { id: row.id, off: r1 } } };
  }
  return a;
}

/** The embed view ops (absolute): collapse { key, on }, modal { key | null }, focus { key | null }, title { key, title | null } (the live title), title-edit { key | null } (the name being edited), drag { key, h } | { key: null } (the
 *  resize grip's live preview). `resize` and `mode` are document writes (the chip's text), handled below with the app. A junk key is a no-op. */
function embedStep(state, a) {
  const key = typeof a.key === 'string' && a.key.length < 200 ? a.key : null;
  if (a.op === 'collapse') { if (!key || typeof a.on !== 'boolean') return; const cur = Boolean(state.embeds[key]?.collapsed); if (cur === a.on) return; state.embeds = { ...state.embeds, [key]: { ...state.embeds[key], collapsed: a.on } }; if (a.on && state.embedFocus === key) state.embedFocus = null; }
  else if (a.op === 'modal') { if (a.key !== null && !key) return; state.modal = key; }
  else if (a.op === 'focus') { if (a.key !== null && !key) return; state.embedFocus = key; }
  else if (a.op === 'title-edit') { if (a.key !== null && !key) return; if (state.embedTitleEdit !== key) state.embedTitleEdit = key; }
  else if (a.op === 'title') {   // the doc's title as the header shows it (a live value: the rename, or a push); null clears it back to the chip's label
    if (!key) return; const t = a.title === null ? null : typeof a.title === 'string' ? a.title.replace(/\s+/g, ' ').trim().slice(0, 120) : undefined;
    if (t === undefined || t === '') return; if ((state.embeds[key]?.title ?? null) === t) return;
    state.embeds = { ...state.embeds, [key]: { ...state.embeds[key], title: t } };
  }
  else if (a.op === 'drag') {
    if (a.key === null) { if (state.embedDrag) state.embedDrag = null; return; }
    const h = clampH(a.h); if (!key || h == null) return;
    if (state.embedDrag?.key === key && state.embedDrag.h === h) return;
    state.embedDrag = { key, h };
  }
}

/** One reducer step: mutates `state` (the kit's store object) and the doc; no DOM, no clock (a.at carries the time).
 *  opts.edits: the app's own text-edit action types (contract.edits), refused like the kit's while a select-all loads.
 *  opts.refill: the contract's refill declaration (lib/editor/refill.js): the sentinel { type: 'refill', zone }.
 *  opts.rollover: the contract's rollover declaration (lib/editor/rollover.js): { type: 'day.roll', boundary }. */
export function step(app, doc, state, a, { edits = null, refill = null, rollover = null, readOnly = false } = {}) {
  const lines = doc.lines();
  const at = new Map(lines.map((r, i) => [r.id, i]));
  const index = (id) => at.get(id) ?? -1;
  const len = (id) => { const r = doc.get(id); return r ? app.textOf(r).length : 0; };
  const clamp = (p) => (p && index(p.id) >= 0 ? { id: p.id, off: Math.max(0, Math.min(p.off, len(p.id))) } : null);
  state.rev += 1;
  // presence and the embed view ops touch only their own state: they never end a kill-ring append, a vertical-move goal or a
  // pending select-all (a remote caret arrives up to 20 times a second and must not disturb the local editor's gestures)
  if (a.type === 'presence') { state.peers = applyPresence(state.peers, a); return state; }
  // hover: the row the pointer rests on (`row`, a row id; null clears): the aim of the app's line chords. View state only, like presence: it
  // never ends a kill-ring append, a vertical-move goal or a pending select-all
  if (a.type === 'hover') { const row = typeof a.row === 'string' && index(a.row) >= 0 ? a.row : null; if (state.hover !== row) state.hover = row; return state; }
  if (a.type === 'embed' && a.op !== 'resize' && a.op !== 'mode') { embedStep(state, a); return state; }
  // a select-all still reading pages: an edit would act on the loaded rows only; refused with a visible notice (row 55)
  if (state.wide?.op === 'select-all' && (REFUSED_WHILE_WIDE.has(a.type) || edits?.has(a.type))) {
    state.notice = { code: WIDE_PENDING, type: a.type, id: typeof a.id === 'string' ? a.id : null };
    return state;
  }
  if (!(a.type === 'input' && a.inputType === KILL)) state.kill = { text: state.kill.text, open: false };
  if (!KEEPS_WIDE.has(a.type)) { state.wide = null; state.notice = null; }
  // goal: the x a run of vertical moves aims at (layout resolved by the adapter, carried by the select action that made
  // the move); any other action ends the run
  state.goal = a.type === 'select' && Number.isFinite(a.goal) ? a.goal : null;
  switch (a.type) {
    case 'select': if (a.sel !== null && !isSel(a.sel)) break; state.sel = a.sel; if (a.reveal === true) state.reveal = true; break;
    case 'scroll': scrollStep(state, a); break;
    case 'focus': if (typeof a.focus === 'boolean') state.focus = a.focus; break;
    // a pointer gesture in progress (a selection drag): absolute on/off; its exit edges are GESTURE_EXITS (the adapter)
    // held: the selection when the press began (kept while the gesture lasts); revealSel(state) is what a view reveals source
    // around, so the line under the pointer is never redrawn mid-press (a redraw detaches the nodes the browser's own drag
    // selection is anchored in, and revealing hidden syntax moves the text under the pointer)
    case 'gesture': state.gesture = a.on === true ? { kind: a.kind ?? 'select', pointer: a.pointer ?? null, held: state.gesture ? state.gesture.held ?? null : state.sel } : null; break;
    // fold is absolute (A6): { addr, on } sets that line folded or not, so a replayed or redelivered fold is idempotent;
    // the toggle a key or a click means is a gesture resolved by dispatch() against the state the user saw (resolveGesture)
    // a line drag (lib/editor/linepointer.js; the app declares `outline`): `row` is the carried line (with its subtree), `to` = { id, after } the
    // place it would land. start / over / cancel are view state (the app draws the grabbed lines, the drop line and the compact view from
    // state.drag); drop is one absolute move: the carried rows' ords between the neighbours the drop leaves (lines.js dropLines), a no-op
    // when they already sit there, so a redelivered drop writes nothing twice
    case 'drag': {
      const row = typeof a.row === 'string' && index(a.row) >= 0 ? a.row : null;
      const to = a.to && typeof a.to.id === 'string' && index(a.to.id) >= 0 ? { id: a.to.id, after: a.to.after === true } : null;
      if (a.op === 'start') { if (readOnly || !row || !app.outline) break; state.drag = { id: row, to: null }; state.gesture = null; }
      else if (a.op === 'over') { if (state.drag) state.drag = { id: state.drag.id, to }; }
      else if (a.op === 'cancel') state.drag = null;
      else if (a.op === 'drop') {
        state.drag = null;
        if (!row || !to || !app.outline) break;
        if (readOnly) { state.notice = { code: READ_ONLY, type: a.type, id: typeof a.id === 'string' ? a.id : null }; break; }
        if (state.wide?.op === 'select-all') { state.notice = { code: WIDE_PENDING, type: a.type, id: typeof a.id === 'string' ? a.id : null }; break; }
        const puts = dropLines(lines, index(row), index(to.id), to.after, { ...app.outline, folds: state.folds, at: a.at });
        // app.dropped(state, puts, { get, at }): the app records the move in its own history before it is written (zai: the undo step), so ⌘Z puts the lines back
        if (puts?.length) { app.dropped?.(state, puts, { get: (id) => doc.get(id), at: a.at }); doc.put(puts, { intent: a.id }); }
      }
      break;
    }
    // touch: `gutter` is the row whose gutter was tapped (its grip and fold chevron are shown; null puts them away); `vmod` is the virtual modifier of a
    // touch bar: held (a thumb on the cmd segment) or latched (one tap: the next key), both absolute; the adapter reads it as the platform's chord modifier
    // vim mode (lib/editor/vimmode.js): `vim { on }` switches it (absolute); while on, the keydown adapter spends keys as `vimkey { key }` (an edit: the app's
    // reducer runs the engine over the buffer around the caret, `app.vim`)
    case 'vim': { const on = a.on === true; if (state.vim.on !== on) state.vim = { on }; break; }
    case 'gutter': { const row = typeof a.row === 'string' && index(a.row) >= 0 ? a.row : null; if (state.gutter !== row) state.gutter = row; break; }
    case 'vmod': {
      const v = state.vmod, on = a.on === true;
      if (a.op === 'hold' && v.held !== on) state.vmod = { held: on, latched: on ? false : v.latched };
      else if (a.op === 'latch' && v.latched !== on) state.vmod = { held: v.held, latched: on };
      break;
    }
    case 'fold': { if (a.addr == null || typeof a.on !== 'boolean') break; const has = state.folds.includes(a.addr); if (a.on && !has) state.folds = [...state.folds, a.addr]; else if (!a.on && has) state.folds = state.folds.filter((x) => x !== a.addr); break; }
    // ⌘A and ⌘F act on the document (every row), never on what happens to be drawn
    // over a paged doc the loaded rows are selected now (the visible response) and state.wide asks the kit for the rest
    case 'select-all': state.sel = selectAll(lines, app.textOf); state.wide = docComplete(doc) ? null : { op: 'select-all' }; if (!state.wide) state.notice = null; break;
    case 'find': {
      if (a.open) { state.find = { q: state.find?.q ?? '', i: -1, n: 0, cur: null, origin: state.find?.origin ?? state.sel }; }
      const f = state.find; if (!f) break;
      if (a.close) { state.sel = a.keep && f.cur ? { a: { id: f.cur.id, off: f.cur.from }, f: { id: f.cur.id, off: f.cur.to } } : f.origin; state.find = null; state.reveal = true; break; }
      if (a.q != null || a.open) {
        if (a.q != null) f.q = a.q;
        const hits = findAll(lines, app.textOf, f.q);
        const o = f.origin ? index(f.origin.f.id) : 0;
        f.n = hits.length; f.i = hits.length ? Math.max(0, hits.findIndex((h) => index(h.id) >= o)) : -1;
        f.cur = hits[f.i] || null;
      } else if (Number.isInteger(a.i)) { // the match to show, absolute: dispatch resolves a step ({ step: 1 | -1 }, Enter / Shift-Enter) into this index against the state the user saw (resolveGesture), so a replay or redelivery sets the same match
        const hits = findAll(lines, app.textOf, f.q);
        f.n = hits.length; f.i = hits.length ? Math.max(0, Math.min(hits.length - 1, a.i)) : -1; f.cur = hits[f.i] || null;
      }
      if (f.cur) { state.sel = { a: { id: f.cur.id, off: f.cur.from }, f: { id: f.cur.id, off: f.cur.to } }; state.reveal = true; }
      state.find = { ...f, complete: docComplete(doc) };
      break;
    }
    // the zone refill sentinel (lib/editor/refill.js): carries no rows; applied to the state it meets, it writes the zone's
    // blank rows only when the zone has no live row at all, so it is idempotent, never stacks and merges by id
    case 'refill': { if (readOnly) break; const puts = refill && typeof a.zone === 'string' ? refillPuts(lines, (id) => (doc.peek ? doc.peek(id) : doc.get(id)), refill, a.zone, a.at, docComplete(doc)) : []; if (puts.length) doc.put(puts, { intent: a.id }); break; }
    // the day rollover (lib/editor/rollover.js): the rows of the `from` zone last touched before `boundary` go to the end of `to`;
    // absolute and idempotent (a moved row is not selected again), the app records the puts for undo before they are written
    case 'day.roll': {
      if (readOnly || !rollover) break;
      const puts = rollPuts(lines, rollover, a.boundary, a.at, docComplete(doc));
      if (!puts.length) break;
      app.recorded?.(state, puts, { get: (id) => doc.get(id), peek: (id) => (doc.peek ? doc.peek(id) : doc.get(id)) });
      doc.put(puts, { intent: a.id });
      const moved = new Set(puts.map((p) => p.id));
      if (state.sel && (moved.has(state.sel.a.id) || moved.has(state.sel.f.id))) { // the caret was in a line that left: it goes to the end of what is left of `from`
        const rest = doc.lines().filter((r) => rollover.zoneOf(r) === rollover.from);
        const end = rest[rest.length - 1], p = end ? { id: end.id, off: app.textOf(end).length } : null;
        state.sel = p ? { a: p, f: p } : state.sel;
      }
      break;
    }
    // an embed resize (the grip's release, lib/editor/embed.js) or mode change (full | window): the height and the `|fit` flag are the chip's own text, so
    // the app rewrites the row (app.embedPuts(row, { h } | { mode, h? }, { at, get }) -> puts); an absolute value write, refused in a read-only editor
    case 'embed': {
      const key = typeof a.key === 'string' ? a.key : null, row = key && key.startsWith('emb:') ? doc.get(key.slice(4)) : null;
      const h = clampH(a.h), patch = a.op === 'mode' ? (a.mode === 'full' || a.mode === 'window' ? { mode: a.mode, h } : null) : h != null ? { h } : null;
      const puts = row && patch && app.embedPuts ? app.embedPuts(row, patch, { at: a.at, get: (id) => doc.get(id) }) : null;
      if (puts?.length) { if (readOnly) state.notice = { code: READ_ONLY, type: a.type, id: typeof a.id === 'string' ? a.id : null }; else doc.put(puts, { intent: a.id }); }
      break;
    }
    case 'pending': if (Number.isInteger(a.count) && a.count >= 0) state.pending = a.count; break;
    // IME: the browser edits the composing line; the kit records the line's text at the start (the composition's base),
    // so a remote edit that lands during the composition is kept: compose-end is rebased onto the line as it is now
    case 'compose-start': { const r = a.addr != null ? doc.get(a.addr) : null; state.composing = { id: a.addr, base: r ? app.textOf(r) : null }; break; }
    // move is a relative gesture: dispatch resolves it to an absolute select (resolveGesture) before it is logged; a
    // 'move' in an old log is replayed through the same resolution
    case 'move': { const r = moveSelect(state, a, lines, app.textOf, app.folded); if (r) { state.sel = r.sel; state.reveal = true; } break; }
    default: {
      // a text edit carries the selection it acts on; a junk one (not a selection) is a no-op (A4)
      if ((a.type === 'input' || a.type === 'compose-end') && a.sel != null && !isSel(a.sel)) break;
      if (a.type === 'compose-end') { a = rebaseComposition(a, state.composing, doc, app); state.composing = null; }
      // the kill ring: what ⌃K removes is read before the app removes it
      const open = a.type === 'input' && a.inputType === OPEN_LINE && a.sel ? ordered(a.sel, index).a : null;
      const b = intentOf(a, state, lines, app.textOf);
      if (a.type === 'input' && a.inputType === KILL && a.sel) {
        const r = collapsed(a.sel) ? deleteRange(KILL, a.sel.f, lines, app.textOf) : a.sel;
        const killed = r ? textBetween(r, lines, app.textOf) : '';
        state.kill = { text: (state.kill.open ? state.kill.text : '') + killed, open: true };
      }
      if (!app.reduce || !b) break;
      const out = app.reduce(state, b, { lines, index, get: (id) => doc.get(id), peek: (id) => (doc.peek ? doc.peek(id) : doc.get(id)), now: a.at, mint: (op) => mintIds(op, a, doc) });
      if (!out) break;
      if (readOnly && out.puts?.length) { state.notice = { code: READ_ONLY, type: a.type, id: typeof a.id === 'string' ? a.id : null }; break; } // nothing is written, the selection stays
      if (out.puts?.length) doc.put(out.puts, { intent: a.id }); // the action's id is the row edit's intent (A7): a redelivered action writes nothing twice
      if (out.folds) state.folds = out.folds;
      // out.scroll: an absolute scroll the app's action asks for ({ anchor } is a landing, as the `scroll` action's): the reducer answers with it so a
      // "back to the present" is one logged action with the caret it puts there (zai: Escape, the NOW button)
      if (out.scroll && typeof out.scroll === 'object') scrollStep(state, { ...out.scroll, at: a.at });
      if (out.sel) state.sel = out.sel;
      if (out.reveal !== false && (out.puts?.length || out.sel)) state.reveal = true;
      if (open && out.puts?.length) state.sel = { a: open, f: open }; // ⌃O: the break goes in after the caret, the caret stays
    }
  }
  if (state.sel) {
    const fresh = doc.lines(); // the reducer may have added or removed rows: clamp against the doc as it is now
    if (fresh !== lines) { at.clear(); fresh.forEach((r, i) => at.set(r.id, i)); }
    const a2 = clamp(state.sel.a), f2 = clamp(state.sel.f); state.sel = a2 && f2 ? { a: a2, f: f2 } : a2 ? { a: a2, f: a2 } : f2 ? { a: f2, f: f2 } : null;
  }
  return state;
}

/** The selection a view reveals source around (the caret's lines, decorate.js `active`): state.sel, except during a pointer
 *  gesture, when it is the selection the press began with. A line that becomes the caret's under a press is redrawn with
 *  its syntax shown only once the press ends: redrawing it mid-press replaced the text nodes the browser's drag selection
 *  was anchored in (the drag lost its anchor) and moved the words under the pointer (zai3, 2026-11-11). Pure. */
export const revealSel = (state) => (state.gesture && state.gesture.held !== undefined ? state.gesture.held : state.sel);

/** The events that end a pointer gesture (state.gesture) and, for blur and visibilitychange, an IME composition. */
export const GESTURE_EXITS = ['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'visibilitychange', 'scroll'];

/** compose-end rebased onto the line as it is now: the composition is the change from the line's text at compose-start
 *  (base) to the text the browser left (a.text). When the line changed meanwhile (a remote edit, a sync), that change is
 *  applied to the current text at the mapped place instead of writing the browser's text over it. Pure. */
export function rebaseComposition(a, composing, doc, app) {
  if (!composing || composing.base == null || a.text == null || a.addr !== composing.id) return a;
  const row = doc.get(composing.id); if (!row) return a;
  const now = app.textOf(row), base = composing.base, t = a.text;
  if (now === base) return a;
  let p = 0; while (p < base.length && p < t.length && base[p] === t[p]) p++;
  let q = 0; while (q < base.length - p && q < t.length - p && base[base.length - 1 - q] === t[t.length - 1 - q]) q++;
  const ins = t.slice(p, t.length - q), s0 = mapPoint(base, now, p), s1 = Math.max(s0, mapPoint(base, now, base.length - q));
  const text = now.slice(0, s0) + ins + now.slice(s1);
  const off = a.off == null ? null : Math.max(0, Math.min(text.length, a.off <= p ? mapPoint(base, now, a.off) : a.off >= t.length - q ? s0 + ins.length + (mapPoint(base, now, a.off - t.length + base.length) - mapPoint(base, now, base.length - q)) : s0 + (a.off - p)));
  return { ...a, text, off, rebased: true };
}

/** The row a line chord is aimed at: the one the pointer rests on (state.hover, lib/editor/linepointer.js) when it is not the caret's own line
 *  (the caret's keys already act there and keep a selection), else null (the caret's line). Not while find is open or a composition runs.
 *  old zai's hoverChord (The owner 2026-10-06 18:01 PDT: "when im moving my mouse in notes, and i command period ... you should send the action
 *  ta that item. hover+keyboard combo"). Pure: an app's reducer reads it from state. */
export const aimed = (state) => (state.hover && !state.find && !state.composing && state.hover !== state.sel?.f.id ? state.hover : null);

/** Gestures resolved against the state the user saw (A6): the action that is logged, replayed and redelivered is absolute.
 *  fold without `on` toggles the line it names, else the line the pointer rests on (aimed), else the caret line: { type: 'fold', addr, on }. */
export function resolveGesture(state, a, ctx = null) {
  if (a.type === 'fold' && typeof a.on !== 'boolean') { const addr = a.addr ?? aimed(state) ?? state.sel?.f.id ?? null; return addr == null ? a : { ...a, addr, on: !state.folds.includes(addr) }; }
  // move { dir, extend } (← → ⌃F ⌃B) is relative to the caret: resolved here against the state the user saw into the
  // absolute select it means, so the log never holds a relative caret move
  if (a.type === 'move' && ctx) { const r = moveSelect(state, a, ctx.lines(), ctx.textOf, ctx.folded); const { dir: _d, extend: _e, ...rest } = a; return r ? { ...rest, type: 'select', sel: r.sel, reveal: true } : { ...rest, type: 'select', sel: state.sel ?? null }; }
  // find { step: 1 | -1 } (Enter, Shift-Enter) is relative to the match shown: resolved here into the absolute match index it means
  if (a.type === 'find' && ctx && Number.isInteger(a.step) && a.step && a.i == null && state.find && !a.open && !a.close && a.q == null) {
    const n = findAll(ctx.lines(), ctx.textOf, state.find.q).length, { step, ...rest } = a;
    return n ? { ...rest, i: (((state.find.i + step) % n) + n) % n } : rest;
  }
  return a;
}

/** The selection a one-character move { dir: -1 | 1, extend } leads to from state.sel over the ordered lines, or null. */
export function moveSelect(state, a, lines, textOf, folded = null) {
  if (!isSel(state.sel) || (a.dir !== -1 && a.dir !== 1)) return null;
  const at = new Map(lines.map((r, i) => [r.id, i]));
  const index = (id) => at.get(id) ?? -1;
  const len = (id) => { const i = index(id); return i < 0 ? 0 : textOf(lines[i]).length; };
  const s = ordered(state.sel, index);
  let p = a.extend ? state.sel.f : collapsed(state.sel) ? state.sel.f : a.dir < 0 ? s.a : s.f;
  if (a.extend || collapsed(state.sel)) {
    const i = index(p.id);
    if (i < 0) return null;
    // folded runs (fold.js) are never drawn: a press steps over one and a drawn character, and the caret never rests inside one
    const runs = folded ? folded(textOf(lines[i])) || [] : [], L = len(p.id);
    if (a.dir < 0) { const o = runs.length ? stepCaret(runs, p.off, -1, L) : p.off > 0 ? p.off - 1 : null; p = o != null ? { id: p.id, off: o } : i > 0 ? { id: lines[i - 1].id, off: len(lines[i - 1].id) } : p; }
    else { const o = runs.length ? stepCaret(runs, p.off, 1, L) : p.off < L ? p.off + 1 : null; p = o != null ? { id: p.id, off: o } : i < lines.length - 1 ? { id: lines[i + 1].id, off: 0 } : p; }
  }
  return { sel: { a: a.extend ? state.sel.a : p, f: p } };
}

/** New row ids come from the action, never from randomness inside the reducer, so every replica (and the model run)
 *  folding the same log makes the same rows. mint(op) renames ids in op.puts that the doc does not know, and op.caret. */
const hash36 = (s) => { let h1 = 0x811c9dc5, h2 = 0x1234567; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822507); } return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)).padStart(8, '0').slice(-8); };
export function mintIds(op, a, doc) {
  if (!op?.puts) return op;
  const ren = new Map(); let k = 0;
  for (const p of op.puts) if (!doc.get(p.id) && !ren.has(p.id)) ren.set(p.id, `${p.id[0] || 'n'}${Math.floor(a.at).toString(36)}${hash36(`${a.id}:${k++}`)}`);
  if (!ren.size && !op.moves?.length) return op;
  const r = (id) => ren.get(id) ?? id;
  // moves (lib/engine/structure.js): their rows follow the renaming, and an op id that names no row is minted here too
  const moves = op.moves?.map((m, k) => ({ ...m, from: r(m.from), to: r(m.to), op: ren.get(m.op) ?? (doc.get(m.op) ? m.op : `m${Math.floor(a.at).toString(36)}${hash36(`${a.id}:mv${k}`)}`) }));
  return { ...op, puts: op.puts.map((p) => ({ ...p, id: r(p.id) })), ...(op.caret ? { caret: { ...op.caret, id: r(op.caret.id) } } : {}), ...(moves ? { moves } : {}) };
}

/** The reducer alone over a list of actions, no DOM: the model the browser run must agree with. */
export function modelRun(app, rows, actions, opts) {
  const doc = memoryLines(rows, opts), state = initState(app);
  for (const a of actions) step(app, doc, state, a, { refill: opts?.refill ?? null, rollover: opts?.rollover ?? null, readOnly: Boolean(opts?.readOnly) });
  return { doc, state };
}

/** A comparable snapshot: the text of every live row in order, and the selection as (line index, offset). Ids are minted
 *  per run, so they are left out. */
export function snapshot(app, doc, state) {
  const lines = doc.lines(), idx = new Map(lines.map((r, i) => [r.id, i]));
  const p = (x) => (x ? [idx.get(x.id), x.off] : null);
  return { text: lines.map((r) => app.textOf(r)), sel: state.sel ? [p(state.sel.a), p(state.sel.f)] : null };
}

// ------------------------------------------------------------------ the intent a beforeinput maps to (no layout)
const prevCp = (s, off) => (off >= 2 && /[\udc00-\udfff]/.test(s[off - 1]) && /[\ud800-\udbff]/.test(s[off - 2]) ? off - 2 : off - 1);
const nextCp = (s, off) => (/[\ud800-\udbff]/.test(s[off] || '') ? off + 2 : off + 1);
const wordBack = (s, off) => { let i = off; while (i > 0 && /\s/.test(s[i - 1])) i--; while (i > 0 && !/\s/.test(s[i - 1])) i--; return i; };
const wordFwd = (s, off) => { let i = off; while (i < s.length && /\s/.test(s[i])) i++; while (i < s.length && !/\s/.test(s[i])) i++; return i; };
/** The rows range a delete removes from a collapsed caret: a character, a word or to the line edge, across one line
 *  boundary at an edge. Logical lines only: what Backspace does never depends on wrapping, heights or CSS. */
export function deleteRange(inputType, caret, lines, textOf) {
  const i = lines.findIndex((r) => r.id === caret.id); if (i < 0) return null;
  const s = textOf(lines[i]), back = /Backward/.test(inputType);
  if (back && caret.off === 0) return i > 0 ? { a: { id: lines[i - 1].id, off: textOf(lines[i - 1]).length }, f: { id: caret.id, off: 0 }, join: true } : null;
  if (!back && caret.off >= s.length) return i < lines.length - 1 ? { a: { id: caret.id, off: s.length }, f: { id: lines[i + 1].id, off: 0 }, join: true } : null;
  const to = /Word/.test(inputType) ? (back ? wordBack(s, caret.off) : wordFwd(s, caret.off)) : /Line/.test(inputType) ? (back ? 0 : s.length) : back ? prevCp(s, caret.off) : nextCp(s, caret.off);
  return back ? { a: { id: caret.id, off: to }, f: { id: caret.id, off: caret.off } } : { a: { id: caret.id, off: caret.off }, f: { id: caret.id, off: Math.min(to, s.length) } };
}

// ------------------------------------------------------------------ DOM: render map
// A `stable` vnode (the embed slot) is PATCHED when it changes: the same elements keep their place, their hover, their running CSS transitions and
// whatever another editor mounted inside; only attributes, classes, text and the children that differ are written. Returns false when the new vnode
// does not have the old one's shape (a different tag at the root), and the caller replaces the element as for any vnode. A vnode with no
// `children`, `html` or `text` leaves its element's content alone (the embed body holds a live editor).
function patchStable(el, old, v, doc_) {
  if ((old.tag || 'div') !== (v.tag || 'div')) return false;
  patchEl(el, old, v, doc_);
  return true;
}
function patchEl(el, old, v, doc_) {
  const cls = v.cls || ''; if (el.className !== cls) el.className = cls;
  const was = old.attrs || {}, now = v.attrs || {};
  for (const k of Object.keys(was)) if (!(k in now)) el.removeAttribute(k);
  for (const [k, val] of Object.entries(now)) if (was[k] !== val || el.getAttribute(k) !== String(val)) el.setAttribute(k, val);
  if (v.html != null) { if (old.html !== v.html || el.innerHTML !== v.html) el.innerHTML = v.html; return; }
  if (v.text != null && !v.children) { if (el.textContent !== v.text) el.textContent = v.text; return; }
  if (!v.children) return;
  const oc = old.children || [], kids = [...el.children];
  v.children.forEach((c, i) => {
    const cur = kids[i];
    if (cur && typeof c !== 'string' && oc[i] && typeof oc[i] !== 'string' && (oc[i].tag || 'div') === (c.tag || 'div') && (cur.tagName.toLowerCase() === (c.tag || 'div'))) patchEl(cur, oc[i], c, doc_);
    else { const n = build(c, doc_); if (cur) cur.replaceWith(n); else el.append(n); }
  });
  for (let i = kids.length - 1; i >= v.children.length; i--) kids[i].remove();
}
function build(v, doc_) {
  if (typeof v === 'string') return doc_.createTextNode(v);
  const el = doc_.createElement(v.tag || 'div');
  if (v.cls) el.className = v.cls;
  if (v.addr != null) el.setAttribute(ADDR, v.addr);
  if (v.inert) el.setAttribute(INERT, '');
  if (v.editable === false) el.setAttribute('contenteditable', 'false');
  for (const [k, val] of Object.entries(v.attrs || {})) el.setAttribute(k, val);
  if (v.html != null) { if (!v.inert) throw new Error('editor: an html vnode must be inert (decoration has no addresses)'); el.innerHTML = v.html; }
  if (v.text) el.append(doc_.createTextNode(v.text));
  for (const c of v.children || []) el.append(build(c, doc_));
  return el;
}
const inertIn = (line, node) => { for (let n = node.nodeType === 1 ? node : node.parentElement; n && n !== line; n = n.parentElement) if (n.hasAttribute?.(INERT)) return true; return false; };
function textNodes(line) {
  const out = [], w = line.ownerDocument.createTreeWalker(line, 4);
  for (let t = w.nextNode(); t; t = w.nextNode()) if (!inertIn(line, t)) out.push(t);
  return out;
}
/** The addressed line holding a DOM node, inside root. */
export function lineOf(root, node) {
  const el = node && (node.nodeType === 1 ? node : node.parentElement)?.closest?.(`[${ADDR}]`);
  return el && root.contains(el) && !inEmbedBody(root, el) ? el : null; // an embedded editor's lines are its own map (lib/editor/embed.js)
}
/** DOM point -> { id, off }, or null when the point is outside every addressed line or inside an inert element. */
export function addrOfPoint(root, node, off) {
  const line = lineOf(root, node);
  if (!line || inertIn(line, node)) return null;
  const ts = textNodes(line);
  let n = 0;
  if (node.nodeType === 3) { for (const t of ts) { if (t === node) return { id: line.getAttribute(ADDR), off: n + off }; n += t.length; } return null; }
  // an element point: the text of the children before child `off`
  const stop = node.childNodes[off] || null;
  for (const t of ts) { if (stop && (stop === t || stop.contains(t) || (stop.compareDocumentPosition(t) & 2) === 0)) break; if (!node.contains(t) && (node.compareDocumentPosition(t) & 4)) break; n += t.length; }
  if (node === line && !stop) n = ts.reduce((s, t) => s + t.length, 0);
  return { id: line.getAttribute(ADDR), off: n };
}
/** Line text as the DOM holds it (inert content excluded). */
export const domText = (line) => textNodes(line).map((t) => t.data).join('');
/** { id, off } -> DOM point. */
export function domOfAddr(lineEl, off) {
  let rest = off, last = null;
  const ts = textNodes(lineEl), hidden = (t) => Boolean(t.parentElement?.closest('.qk-hide'));
  for (let k = 0; k < ts.length; k++) {
    const t = ts[k];
    // at the end of a hidden run (a folded tag, no box) the point is drawn where the next DRAWN character starts: the DOM caret sits
    // on a node that has a box. The reading back (addrOfPoint) gives the same offset, so painting never moves the state.
    if (rest === t.length && t.length > 0 && hidden(t)) { const n = ts.findIndex((u, j) => j > k && !hidden(u)); if (n > 0 && ts.slice(k + 1, n).every((u) => hidden(u))) { return [ts[n], 0]; } }
    if (rest <= t.length) return [t, rest];
    rest -= t.length; last = t;
  }
  if (last) return [last, last.length];
  // no text: before the first child that is not decoration (a line led by an inert glyph keeps its caret after it)
  const kids = [...lineEl.childNodes], k = kids.findIndex((n) => !(n.nodeType === 1 && n.hasAttribute(INERT)));
  return [lineEl, k < 0 ? kids.length : k];
}

// ------------------------------------------------------------------ the editor
/**
 * createEditor({ root, scroller, app, doc, contract, dev, overscan, onWindow, clock })
 *   root      the contenteditable element (the kit renders its children; the app never writes them)
 *   scroller  the scrolling element around it (default root.parentElement)
 *   contract  required: { name, actions: [action types the app dispatches beyond the kit's], edits?: [those of them that
 *             are text edits (idempotent by intent id, not by value)], budget_p95_ms, gens?, sample?, sortKey?, live? }
 *             The editor registers its declarations from it (lib/editor/declare.js declareEditor): validate() and the deploy
 *             gate run every law over the kit's state and every action it dispatches. Declare it at module level too
 *             (declareEditor(contract, app)) so the gate, which never runs createEditor, finds it.
 *   landingDeadlineMs  how long a landing (a pinned anchor) waits for its row before it is released to free and marked
 *             failed (default UI_DEFAULTS.wait.deadline_ms, the kit's one wait deadline)
 */
export function createEditor({ root, scroller = root.parentElement, app, doc, contract, dev = false, overscan = 1200, onWindow = null, clock = () => Date.now(), followEnd = false, landingDeadlineMs = UI_DEFAULTS.wait.deadline_ms, refillReady = () => true, readOnly = false, embeds = null, linePointer = null, onEdge = null, mac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '') }) {
  if (!contract || typeof contract.name !== 'string' || !Array.isArray(contract.actions)) throw new Error('createEditor: a contract { name, actions } is required (rule 5: every editor declares its contract)');
  declareEditor(contract, app); // by construction: what this editor holds and dispatches is a declaration validate() checks
  const edits = new Set(contract.edits || []);
  const refill = checkRefill(contract.refill, `editor ${contract.name}`);
  const rollover = checkRollover(contract.rollover, `editor ${contract.name}`);
  const allowed = new Set([...KIT_ACTIONS, ...contract.actions]);
  const budget = contract.budget_p95_ms ?? 100;
  const D = root.ownerDocument, W = D.defaultView;
  const state = initState(app);
  const seen = new Set(), seenOrder = [];
  const log = [];                       // the action log (bounded): what every check replays
  const latency = [];                   // { type, ms } event timestamp -> next frame
  const violations = [];
  let seq = 0, inCommit = false, expectScroll = -1, items = [], win = { start: 0, end: 0 }, frameQueued = false, disposed = false;
  // scroll is kit state (lib/editor/scroll.js): the browser never anchors on its own, and a scroll event moves the anchor
  // only inside a user-input intent window
  scroller.style.overflowAnchor = 'none';
  const intent = intentTracker(scroller, W);
  const scrollStats = { user: 0, echo: 0, foreign: 0, settles: 0 };
  if (followEnd) state.follow = 'bottom';
  const els = new Map();                // item key -> { el, sig }
  const keyAt = (i) => items[i]?.key;
  const ix = heightIndex({ estimate: (it) => app.estimate(it) });
  const top = D.createElement('div'), bottom = D.createElement('div');
  for (const s of [top, bottom]) { s.setAttribute(INERT, ''); s.setAttribute('contenteditable', 'false'); s.className = 'qk-spacer'; }
  root.replaceChildren(top, bottom);
  // app.keys: chords the app reduces ({ type: 'key', name }); app.keyActions: chords the app maps to a kit action
  // ({ 'mod+a': { type: 'select-all' } }): the key choice is the app's, the behaviour the kit's
  const keySpecs = [...(app.keys || []), ...Object.keys(app.keyActions || {})].map((k) => ({ name: k, spec: parseSpec(k, mac), action: app.keyActions?.[k] }));
  const listeners = new Set();

  // ---------------------------------------------------------------- dispatch: the one entry point
  let inDispatch = false;
  function dispatch(a, { ts = null } = {}) {
    if (!allowed.has(a.type)) throw new Error(`editor ${contract.name}: action "${a.type}" is not in the contract`);
    a = resolveGesture(state, a, { lines: () => doc.lines(), textOf: app.textOf, folded: app.folded }); // a gesture (fold toggle, caret move) becomes the absolute action it means, before it is logged
    if (a.type === 'compose-end' && a.addr != null && els.get(a.addr)) els.get(a.addr).sig = null; // the browser drew this line: redraw it from state
    a.id ??= ulid(); // one intent id, a ULID minted once where the user acted (A7); never a content hash, never in the reducer
    if (a.type !== 'presence' && a.type !== 'hover') { // presence (up to 20 a second per peer) is absolute by value and never evicts the ids edits are deduped by
      if (seen.has(a.id)) return false;   // idempotent: a redelivered action is a no-op
      seen.add(a.id); seenOrder.push(a.id); if (seenOrder.length > 2000) seen.delete(seenOrder.shift());
    }
    a.at ??= clock();
    // a DOM write made in this task before the commit (an optimistic paint) is taken here, before the commit drains it
    if (mo) { const recs = mo.takeRecords().filter((r) => !inEmbedBody(root, r.target)); if (recs.length && !state.composing && a.type !== 'compose-end') stray(recs, a); }
    step(app, doc, state, a, { edits, refill, rollover, readOnly });
    if (a.type === 'hover') { log.push(a); for (const f of listeners) f(state, a); return true; } // nothing is drawn for it (the app's chords read it): no commit
    if (a.type === 'presence') { paintPresence(); armExpiry(); for (const f of listeners) f(state, a); return true; } // the peers' layer repaints; the rows do not
    log.push(a); if (log.length > 5000) log.shift();
    inDispatch = true; try { commit(); } finally { inDispatch = false; }
    watchLanding();
    // event -> next frame: a rAF callback runs just before the frame paints; the task after it runs once the frame is out
    if (ts != null && W.requestAnimationFrame) W.requestAnimationFrame(() => W.setTimeout(() => { latency.push({ type: a.type, name: a.inputType || a.name || '', ms: W.performance.now() - ts }); if (latency.length > 5000) latency.shift(); }, 0));
    for (const f of listeners) f(state, a);
    embeds?.onAction(a);
    widen();
    if (refill && !NO_REFILL.has(a.type)) refillNow();
    return true;
  }
  // The refill sentinel (lib/editor/refill.js): after any action that can change which zones have rows (an edit, a remote
  // or paged batch, an app action, the first call once the app says its rows are in), one { type: 'refill', zone } per
  // zone with no live row. Never from a render, never inside an IME composition (compose-end triggers it), and an
  // application that finds the zone filled writes nothing.
  function refillNow() {
    if (!refill || readOnly || state.composing || disposed || !refillReady()) return;
    for (const zone of emptyZones(doc.lines(), refill, docComplete(doc))) dispatch({ type: 'refill', zone });
  }

  // ---------------------------------------------------------------- a landing's deadline exit (§8 waits: no stuck spinner)
  // A landing (state.follow 'pinned', state.landing.status 'pending') whose row is drawn is marked landed; one whose row has
  // not arrived arms one timer, and if the row is still absent at the deadline the landing is released to free and marked
  // failed. Both are absolute scroll actions through the reducer ({ landing: { id, status } }), resolved here against the
  // render map (the reducer cannot know whether an item key is drawn).
  let landingTimer = null, landingKey = null, landingQueued = false;
  const landingOf = () => (state.follow === 'pinned' && state.landing?.status === 'pending' && state.anchor && state.landing.id === state.anchor.id ? state.landing : null);
  function watchLanding() {
    const l = landingOf();
    const key = l ? `${l.id}@${l.since}` : null;
    if (key !== landingKey && landingTimer) { W.clearTimeout(landingTimer); landingTimer = null; }
    landingKey = key;
    if (!l || disposed) return;
    if (ix.indexOfId(l.id) >= 0) {
      if (!landingQueued) { landingQueued = true; queueMicrotask(() => { landingQueued = false; const m = landingOf(); if (m && !disposed && ix.indexOfId(m.id) >= 0) dispatch({ type: 'scroll', landing: { id: m.id, since: m.since, status: 'landed' } }); }); }
      return;
    }
    if (!landingTimer) landingTimer = W.setTimeout(() => {
      landingTimer = null;
      const m = landingOf();
      if (!m || disposed || `${m.id}@${m.since}` !== key) return;
      dispatch({ type: 'scroll', landing: { id: m.id, since: m.since, status: ix.indexOfId(m.id) >= 0 ? 'landed' : 'failed' } });
    }, landingDeadlineMs);
  }

  // ---------------------------------------------------------------- document-wide ops over the store (⌘A, ⌘F)
  // the loaded window is not the document: an op over a paged doc reads the remaining pages (single flight), then the op
  // is applied again over every row; state.find.complete / state.wide say whether it covers the document yet
  let widening = null;
  function widen() {
    if (widening || disposed || typeof doc.loadOlder !== 'function' || docComplete(doc)) return;
    if (!((state.find && state.find.complete === false) || state.wide?.op === 'select-all')) return;
    widening = (async () => {
      try {
        while (!docComplete(doc) && !disposed) { const n = await doc.loadOlder(2000); dispatch({ type: 'page' }); if (n === 0) break; }
      } finally { widening = null; }
      if (disposed) return;
      if (state.find && state.find.complete === false) dispatch({ type: 'find', q: state.find.q });
      else if (state.wide?.op === 'select-all') dispatch({ type: 'select-all' });
    })();
  }

  // ---------------------------------------------------------------- commit: state -> DOM (the only writer of root)
  const vnodeFor = (it) => { const v = app.render(it, state); if (v.addr == null && !v.inert) throw new Error(`editor ${contract.name}: item ${it.key} renders neither data-addr nor data-inert`); return v; };
  function placeWindow(target, st) {
    const w = windowFor(ix, { scroll_top: st - origin, viewport_px: scroller.clientHeight || 800, overscan_px: overscan });
    let cursor = target === root ? top.nextSibling : null;
    const fresh = target !== root;
    for (let i = w.start; i < w.end; i++) {
      const it = items[i], v = vnodeFor(it), sig = JSON.stringify(v);
      if (fresh) { target.insertBefore(build(v, D), target.lastChild); continue; }
      let e = els.get(it.key);
      if (state.composing && it.addr === state.composing.id && e) { /* the browser owns the composing line until compositionend */ }
      else if (e && e.sig !== sig && v.stable && e.v?.stable && patchStable(e.el, e.v, v, D)) { e.sig = sig; e.v = v; }
      else if (!e || e.sig !== sig) { const el = build(v, D); if (e && v.adopt) { const old = e.el.querySelector(v.adopt), nu = el.querySelector(v.adopt); if (old && nu) nu.replaceWith(old); } if (e) { if (cursor === e.el) cursor = el; ro?.unobserve(e.el); e.el.replaceWith(el); } e = { el, sig, v }; els.set(it.key, e); ro?.observe(el, { box: 'border-box' }); }
      if (cursor === e.el) cursor = cursor.nextSibling; else root.insertBefore(e.el, cursor);
    }
    if (!fresh) while (cursor && cursor !== bottom) { const next = cursor.nextSibling; for (const [k, e] of els) if (e.el === cursor) els.delete(k); ro?.unobserve(cursor); cursor.remove(); cursor = next; }
    return w;
  }
  function spacers(target, w) {
    const t = target === root ? top : target.firstChild, b = target === root ? bottom : target.lastChild;
    t.style.height = `${ix.offsetOf(w.start)}px`;
    b.style.height = `${Math.max(0, ix.offsetOf(ix.count) - ix.offsetOf(w.end))}px`;
  }
  // the scrollTop the state asks for: the end of the document (follow bottom) or the anchored item at its px offset; null
  // when there is nothing to hold (no anchor yet, or a landing whose row has not arrived: held, not dropped)
  // origin: where the root's first item starts in the scroller's content (the root's padding, anything above it): the
  // anchor's px is on screen, below the viewport top, so the heightIndex offsets are shifted by it (zai2's 14 px #doc
  // padding put a landing asked at 75 px at 88.8)
  let origin = 0;
  const measureOrigin = () => { origin = top.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop + scroller.scrollTop; };
  const anchorTop = (a) => { const i = ix.indexOfId(a.id); return i < 0 ? null : Math.max(0, ix.offsetOf(i) + origin - a.px); };
  const scrollTarget = () => (state.follow === 'bottom' ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : state.anchor ? anchorTop(state.anchor) : null);
  // settle-then-land: a ResizeObserver on every drawn item and on the scroller; after any layout change (fonts,
  // decoration, an answer re-rendered, a viewport resize) the drawn items are measured again and scrollTop is re-resolved
  // from the anchor in the same frame, before paint. New items are never drawn here (that would be a ResizeObserver loop):
  // a window that needs other items is committed on the next frame (the overscan covers the screen until then).
  const ro = W.ResizeObserver ? new W.ResizeObserver(() => settle()) : null;
  ro?.observe(scroller, { box: 'border-box' }); // border-box: padding and borders change the rows' rects too (content-box misses them)
  let settleQueued = false;
  function settle() {
    if (inCommit || disposed) return;
    inCommit = true; scrollStats.settles += 1;
    let want = null;
    try {
      measureOrigin();
      for (let pass = 0; pass < 4; pass++) {
        let moved = false;
        for (let i = win.start; i < win.end; i++) { const e = els.get(items[i].key); const h = e?.el.isConnected ? e.el.getBoundingClientRect().height : 0; if (h && ix.measure(items[i].key, h)) moved = true; }
        if (moved) spacers(root, win);
        want = scrollTarget();
        if (want !== null && Math.abs(scroller.scrollTop - want) > 0.5) { scroller.scrollTop = want; expectScroll = scroller.scrollTop; }
        if (!moved) break;
      }
    } finally { mo?.takeRecords(); inCommit = false; }
    const w = windowFor(ix, { scroll_top: (want ?? scroller.scrollTop) - origin, viewport_px: scroller.clientHeight || 800, overscan_px: overscan });
    if ((w.start !== win.start || w.end !== win.end) && !settleQueued) { settleQueued = true; W.requestAnimationFrame(() => { settleQueued = false; if (!disposed) commit(); }); }
  }
  function commit() {
    inCommit = true;
    try {
      items = app.items(doc, state);
      ix.sync(items, (it) => it.key);
      measureOrigin();
      for (let pass = 0; pass < 8; pass++) {
        const st = scrollTarget() ?? scroller.scrollTop;
        win = placeWindow(root, st);
        bottom.style.height = `${ix.offsetOf(ix.count)}px`; // range first, or the browser clamps scrollTop to the old height
        spacers(root, win);
        let moved = false;
        // fractional heights (a 1.62 leading on 15 px is 24.3 px a line): offsetHeight rounds, and the rounding summed over
        // a page of rows moved the anchored row by 16 px (zai2 2026-11-09)
        for (let i = win.start; i < win.end; i++) { const e = els.get(items[i].key); const h = e?.el.getBoundingClientRect().height; if (h && ix.measure(items[i].key, h)) moved = true; }
        spacers(root, win);
        const want = scrollTarget();
        if (want !== null && Math.abs(scroller.scrollTop - want) > 0.5) { scroller.scrollTop = want; expectScroll = scroller.scrollTop; }
        if (!moved) break;
      }
      if (state.reveal) { state.reveal = false; reveal(); }
      paintSelection();
      embeds?.paint?.();
      linePointer?.paint();
    } finally { mo?.takeRecords(); inCommit = false; }
    paintPresence();
    embeds?.sync();
    onWindow?.({ start: win.start, end: win.end, count: items.length, top_px: scroller.scrollTop, viewport_px: scroller.clientHeight });
    if (!inDispatch) watchLanding();
  }
  function reveal() {
    const id = state.sel?.f.id; if (!id) return;
    const i = ix.indexOfId(id); if (i < 0) return;
    const y = ix.offsetOf(i) + origin, h = ix.heightOf(i), st = scroller.scrollTop, vh = scroller.clientHeight || 800;
    if (y >= st + 10 && y + h <= st + vh - 40) return;
    state.anchor = { id, px: Math.round(vh / 3) }; state.follow = 'free';
    const want = scrollTarget();
    win = placeWindow(root, want); spacers(root, win);
    if (Math.abs(scroller.scrollTop - want) > 0.5) { scroller.scrollTop = want; expectScroll = scroller.scrollTop; }
  }
  let painted = null; // a selection with an end outside the drawn window is painted clipped to it; its read-back is ignored
  function clipped() {
    const s = state.sel, has = (id) => els.has(id);
    if (has(s.a.id) && has(s.f.id)) { painted = null; return s; }
    if (collapsed(s)) return null;
    const pos = new Map(items.map((it, i) => [it.addr ?? it.key, i]));
    const o = ordered(s, (id) => pos.get(id) ?? -1);
    const drawn = []; for (let i = win.start; i < win.end; i++) if (items[i].addr != null && els.has(items[i].key)) drawn.push(items[i]);
    if (!drawn.length) return null;
    const ia = pos.get(o.a.id) ?? -1, ifr = pos.get(o.f.id) ?? -1;
    const first = drawn[0], last = drawn[drawn.length - 1];
    if (ifr < pos.get(first.key) || ia > pos.get(last.key)) return null;
    const a = has(o.a.id) ? o.a : { id: first.addr, off: 0 };
    const f = has(o.f.id) ? o.f : { id: last.addr, off: domText(els.get(last.key).el).length };
    painted = { a, f };
    return painted;
  }
  function paintSelection() {
    if (!state.sel || !state.focus || state.composing || state.gesture) return; // the browser draws a drag's selection; selectionchange reads it
    const x = clipped(); if (!x) return;
    const ea = els.get(x.a.id)?.el, ef = els.get(x.f.id)?.el;
    if (!ea || !ef) return;
    const sel = W.getSelection();
    const [an, ao] = domOfAddr(ea, x.a.off), [fn, fo] = domOfAddr(ef, x.f.off);
    if (sel.anchorNode === an && sel.anchorOffset === ao && sel.focusNode === fn && sel.focusOffset === fo) return;
    sel.setBaseAndExtent(an, ao, fn, fo);
  }

  // ---------------------------------------------------------------- presence: other people's carets (lib/presence.js, §15 Embeds)
  // state.peers is kit state (the `presence` action); what is drawn is a projection in a layer of the scroller, outside the text
  // DOM: a caret bar and a name flag per peer, and a tint over each selected range (rects from the render map). A presence
  // action repaints only this layer; a commit repaints it too (the rows moved). A peer unheard for 10 s is dropped by an
  // `expire` action dispatched here on a 2 s timer that runs only while there are peers.
  let layer = null, expireTimer = null;
  function armExpiry() {
    const any = Object.keys(state.peers).length > 0;
    if (any && !expireTimer && !disposed) expireTimer = every(`qk-presence-expire:${contract.name}:${++instances}`, 2000, () => dispatch({ type: 'presence', expire: clock() }), { budgetMs: 8 });
    else if (!any && expireTimer) { expireTimer(); expireTimer = null; }
  }
  function paintPresence() {
    const peers = Object.values(state.peers);
    if (!peers.length) { if (layer?.firstChild) layer.replaceChildren(); return; }
    if (!layer) {
      layer = D.createElement('div'); layer.className = 'qk-presence'; layer.setAttribute(INERT, ''); layer.setAttribute('aria-hidden', 'true');
      layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:5';
      if (W.getComputedStyle(scroller).position === 'static') scroller.style.position = 'relative';
      scroller.append(layer);
    }
    const sr = scroller.getBoundingClientRect(), ox = sr.left + scroller.clientLeft - scroller.scrollLeft, oy = sr.top + scroller.clientTop - scroller.scrollTop;
    const pos = new Map(items.map((it, i) => [it.addr ?? null, i])); pos.delete(null);
    const box = (cls, r, color, extra = '') => { const d = D.createElement('div'); d.className = cls; d.style.cssText = `position:absolute;left:${(r.left - ox).toFixed(1)}px;top:${(r.top - oy).toFixed(1)}px;width:${r.width.toFixed(1)}px;height:${r.height.toFixed(1)}px;${extra}`; if (color) d.style.setProperty('--c', color); return d; };
    const out = [];
    for (const p of peers) {
      const g = D.createElement('div'); g.className = 'qk-pr'; g.setAttribute('data-peer', p.id); g.style.setProperty('--c', p.color);
      const s = p.sel; let caret = null;
      if (s && pos.has(s.a.id) && pos.has(s.f.id)) {
        const o = ordered(s, (id) => pos.get(id) ?? -1);
        if (!collapsed(s)) for (let i = pos.get(o.a.id); i <= pos.get(o.f.id); i++) {
          const it = items[i]; if (it.addr == null || !els.has(it.key)) continue;
          const len = domText(els.get(it.key).el).length;
          const r = rangeOf(it.addr, it.addr === o.a.id ? o.a.off : 0, it.addr === o.f.id ? o.f.off : len);
          if (r) for (const b of r.getClientRects()) if (b.width > 0) g.append(box('qk-pr-sel', b, p.color, `background:${p.color};opacity:.22;`));
        }
        if (els.has(s.f.id)) caret = rectOf(s.f, false);
      }
      if (caret && caret.height) {
        g.append(box('qk-pr-caret', { left: caret.left - 1, top: caret.top, width: 2, height: caret.height }, p.color, `background:${p.color};`));
        const f = D.createElement('div'); f.className = 'qk-pr-flag'; f.textContent = p.name;
        const flip = caret.top - oy < 18;
        f.style.cssText = `position:absolute;left:${(caret.left - ox - 1).toFixed(1)}px;top:${(flip ? caret.bottom - oy : caret.top - oy - 16).toFixed(1)}px;background:${p.color};color:#fff;font:600 10px/16px system-ui,sans-serif;padding:0 5px;border-radius:2px 2px 2px 0;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis`;
        g.append(f);
      }
      if (g.firstChild) out.push(g);
    }
    layer.replaceChildren(...out);
  }

  // ---------------------------------------------------------------- reading the DOM: the adapter's job, nobody else's
  function domSel() {
    const s = W.getSelection();
    if (!s || !s.rangeCount) return null;
    const a = addrOfPoint(root, s.anchorNode, s.anchorOffset), f = addrOfPoint(root, s.focusNode, s.focusOffset);
    return a && f ? { a, f } : null;
  }
  function addrAtPoint(x, y) {
    if (D.caretPositionFromPoint) { const p = D.caretPositionFromPoint(x, y); return p ? addrOfPoint(root, p.offsetNode, p.offset) : null; }
    if (D.caretRangeFromPoint) { const r = D.caretRangeFromPoint(x, y); return r ? addrOfPoint(root, r.startContainer, r.startOffset) : null; }
    return null;
  }
  /** Where a press in an inert gap lands: the end of the nearest addressed line above it, else the start of the one below. */
  function gapTarget(gap) {
    const addressed = (el) => (el.hasAttribute?.(ADDR) ? el.getAttribute(ADDR) : null);
    for (let n = gap.previousElementSibling; n; n = n.previousElementSibling) { const id = addressed(n); if (id != null && doc.get(id)) return { id, off: app.textOf(doc.get(id)).length }; }
    for (let n = gap.nextElementSibling; n; n = n.nextElementSibling) { const id = addressed(n); if (id != null && doc.get(id)) return { id, off: 0 }; }
    return null;
  }
  // A press on the document's own padding or in the margin beside it (the target is the root or the scroller, not a row):
  // it acts as a press on the row at that height (the nearest one above or below when between rows or past the ends).
  // A zone divider (data-qk-gap) resolves as its own press does; a line takes the caret at its start when the press is left
  // of it and at its end otherwise. Nothing is dead space. The scrollbar is not a margin.
  function marginTarget(x, y) {
    let best = null, bd = Infinity;
    for (const el of root.children) {
      const gap = el.hasAttribute?.('data-qk-gap'), id = el.hasAttribute?.(ADDR) ? el.getAttribute(ADDR) : null;
      if (!gap && (id == null || !doc.get(id))) continue;
      const r = el.getBoundingClientRect(), d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (d < bd) { bd = d; best = { el, r, gap, id }; if (d === 0) break; }
    }
    if (!best) return null;
    if (best.gap) return gapTarget(best.el);
    return { id: best.id, off: x < best.r.left ? 0 : app.textOf(doc.get(best.id)).length };
  }
  function marginPress(e) {
    if (disposed || e.button !== 0 || e.target !== root && e.target !== scroller) return false;
    if (!root.getBoundingClientRect().width) return false; // no layout (a headless document): there is no margin to speak of
    if (e.target === scroller && e.clientX - scroller.getBoundingClientRect().left >= scroller.clientWidth) return false; // the scrollbar
    const to = marginTarget(e.clientX, e.clientY);
    if (!to) return false;
    e.preventDefault();
    dispatch({ type: 'select', sel: { a: to, f: { ...to } }, reveal: false }, { ts: e.timeStamp });
    if (D.activeElement !== root) root.focus({ preventScroll: true });
    return true;
  }
  // A DOM point beside hidden syntax (qk-hide: no box) is ambiguous: both ends of the hidden run draw at one x, and the browser
  // always takes the upstream end (a press on the left half of the "b" of "then **bold" put the caret before the hidden "**",
  // outside the mark, two characters left of the letter pressed once the line shows its source). The press's x decides: at or
  // right of the left edge of the first drawn character after the run, the downstream end; else the upstream end.
  function snapHidden(pt, x) {
    const e = pt && els.get(pt.id)?.el; if (!e || !Number.isFinite(x)) return pt;
    const len = domText(e).length, drawn = (off) => (rectOf({ id: pt.id, off }, true)?.width ?? 0) > 0; // hidden syntax: no box, or (Chromium) an empty one
    let lo = pt.off, hi = pt.off;
    while (lo > 0 && !drawn(lo - 1)) lo -= 1;
    while (hi < len && !drawn(hi)) hi += 1;
    if (lo === hi) return pt;
    const after = hi < len ? rectOf({ id: pt.id, off: hi }, true) : null, before = lo > 0 ? rectOf({ id: pt.id, off: lo - 1 }, true) : null;
    const edge = after ? after.left : before ? before.right : null;
    if (edge == null) return pt;
    return { id: pt.id, off: x >= edge - 0.5 ? (after ? hi : lo) : (before ? lo : hi) };
  }
  function rectOf(addr, wide = true) {
    const e = els.get(addr.id)?.el; if (!e) return null;
    const r = D.createRange(), len = domText(e).length;
    if (wide && addr.off < len) { const [n1, o1] = domOfAddr(e, addr.off); const [n2, o2] = domOfAddr(e, addr.off + 1); r.setStart(n1, o1); r.setEnd(n2, o2); }
    else { const [n, o] = domOfAddr(e, addr.off); r.setStart(n, o); r.collapse(true); }
    const rects = r.getClientRects();
    if (!rects.length && wide && addr.off < len) return null; // a character with no box (hidden syntax) has no coordinates
    if (rects.length) return rects[rects.length > 1 && wide ? rects.length - 1 : 0];
    if (!wide) { // a point inside hidden syntax has no box: it is drawn where the nearest drawn character ends (before it) or starts (after it), not the whole line
      for (let k = addr.off - 1; k >= 0 && addr.off - k <= 400; k--) { const r = rectOf({ id: addr.id, off: k }, true); if (r && r.width > 0) return { left: r.right, right: r.right, top: r.top, bottom: r.bottom, width: 0, height: r.height }; }
      for (let k = addr.off; k < len && k - addr.off <= 400; k++) { const r = rectOf({ id: addr.id, off: k }, true); if (r && r.width > 0) return { left: r.left, right: r.left, top: r.top, bottom: r.bottom, width: 0, height: r.height }; }
    }
    return e.getBoundingClientRect();
  }
  /** The DOM Range over characters [from, to) of row id's text (the render map, address -> DOM), or null when the row is
   *  not drawn. For painting outside the DOM tree (CSS Custom Highlights: comment spans, search hits): nothing is written. */
  function rangeOf(id, from, to) {
    const e = els.get(id)?.el; if (!e) return null;
    const len = domText(e).length, a = Math.max(0, Math.min(len, from | 0)), b = Math.max(a, Math.min(len, to | 0));
    const r = D.createRange(); const [n1, o1] = domOfAddr(e, a); const [n2, o2] = domOfAddr(e, b);
    try { r.setStart(n1, o1); r.setEnd(n2, o2); } catch { return null; }
    return r;
  }
  function anchorFromScroll(st) {
    if (!ix.count) return null;
    let i = ix.indexAt(st - origin);
    while (i < ix.count - 1 && items[i]?.addr == null) i += 1; // inert items (heads, sentinels) never anchor
    return { id: keyAt(i), px: ix.offsetOf(i) + origin - st };
  }

  // ---------------------------------------------------------------- layout-dependent caret moves, resolved by the kit
  // Up/Down (⌃P/⌃N), visual line start/end (⌘←/⌘→ on macOS, Home/End elsewhere) and page moves (PageUp/PageDown, ⌃V/⌥V)
  // depend on wrapping, so the adapter resolves them against the render map (the drawn line's character boxes) into an
  // absolute { type: 'select', sel, goal, reveal } that goes through the reducer like any action. The browser never moves
  // the caret for these: what a key does is read from state and the map, never left to whatever the DOM is.
  /** The drawn visual lines of row `id`: [{ top, bottom, start, end }] over its text offsets (end exclusive). */
  function visualLines(id) {
    const e = els.get(id)?.el; if (!e) return null;
    const len = domText(e).length, out = [];
    for (let off = 0; off < len; off++) {
      const r = rectOf({ id, off }); if (!r || r.width === 0 && r.height === 0) continue;
      const last = out[out.length - 1];
      if (last && r.top < last.bottom - 1 && r.bottom > last.top + 1) { last.end = off + 1; last.top = Math.min(last.top, r.top); last.bottom = Math.max(last.bottom, r.bottom); }
      else { if (last) last.end = off; out.push({ top: r.top, bottom: r.bottom, start: off, end: off + 1 }); }
    }
    if (!out.length) { const r = rectOf({ id, off: 0 }, false) || e.getBoundingClientRect(); return [{ top: r.top, bottom: r.bottom, start: 0, end: 0, last: true }]; }
    out[out.length - 1].end = len; out[out.length - 1].last = true;
    return out;
  }
  /** The x of a caret at offset off of row id (the left edge of the character after it, or the right edge of the one before). */
  function caretX(id, off) {
    const e = els.get(id)?.el; if (!e) return null;
    const len = domText(e).length;
    if (off < len) { const r = rectOf({ id, off }); if (r) return r.left; }
    if (off > 0) { const r = rectOf({ id, off: off - 1 }); if (r) return r.right; }
    const r = rectOf({ id, off }, false); return r ? r.left : null;
  }
  const lineOfOff = (vls, off) => { for (let i = 0; i < vls.length; i++) if (off < vls[i].end || vls[i].last) { if (off >= vls[i].start || i === 0) return i; } return vls.length - 1; };
  /** The offset on visual line vl nearest x (a non-final line does not offer its end: that offset is the next line's start). */
  function nearestOn(id, vl, x) {
    // the browser's own hit test at (x, the line's middle) when that point is on screen: the position a click there gives,
    // which is how a textarea picks the column of a vertical move; else the nearest caret x over the line's offsets
    const view = scroller.getBoundingClientRect(), y = (vl.top + vl.bottom) / 2;
    if (y > view.top && y < view.bottom) { const p = addrAtPoint(x, y); const hi0 = vl.last ? vl.end : Math.max(vl.start, vl.end - 1); if (p && p.id === id && p.off >= vl.start && p.off <= hi0) return p.off; }
    let best = vl.start, bd = Infinity;
    const hi = vl.last ? vl.end : Math.max(vl.start, vl.end - 1);
    for (let off = vl.start; off <= hi; off++) { const cx = caretX(id, off); if (cx == null) continue; const d = Math.abs(cx - x); if (d < bd) { bd = d; best = off; } }
    return best;
  }
  const drawnRows = () => { const out = []; for (let i = win.start; i < win.end; i++) if (items[i]?.addr != null && els.has(items[i].addr)) out.push(items[i].addr); return out; };
  /** One visual line up (dir -1) or down (+1) from the caret: { p, goal } or null when there is nowhere to go. */
  function verticalTarget(dir, f = state.sel.f, goal0 = state.goal) {
    const vls = visualLines(f.id); if (!vls) return null;
    const goal = goal0 ?? caretX(f.id, f.off);
    const li = lineOfOff(vls, f.off);
    if (vls[li + dir]) return { p: { id: f.id, off: nearestOn(f.id, vls[li + dir], goal) }, goal };
    const rows = drawnRows(), k = rows.indexOf(f.id), nid = rows[k + dir];
    if (nid == null) { // the document's first or last line: to its start or end, as a macOS text field does
      const ls = doc.lines(), edge = dir < 0 ? ls[0] : ls[ls.length - 1];
      if (!edge || edge.id !== f.id) return null;
      return { p: { id: f.id, off: dir < 0 ? 0 : app.textOf(edge).length }, goal: null };
    }
    const nv = visualLines(nid); if (!nv) return null;
    return { p: { id: nid, off: nearestOn(nid, dir < 0 ? nv[nv.length - 1] : nv[0], goal) }, goal };
  }
  /** The start (dir -1) or end (+1) of the caret's visual line. */
  function visualEdge(dir, f = state.sel.f) {
    const vls = visualLines(f.id); if (!vls) return null;
    const vl = vls[lineOfOff(vls, f.off)];
    if (dir < 0) return { id: f.id, off: vl.start };
    // a wrapped line's end is the offset before its last character when that character is the space it wrapped at
    const t = domText(els.get(f.id).el);
    return { id: f.id, off: vl.last ? vl.end : (/\s/.test(t[vl.end - 1]) ? vl.end - 1 : vl.end) };
  }
  /** A page (the scroller's height) up or down from the caret, keeping its x: visual lines are walked until the next one
   *  would be a page or more from where the caret was. Reads state, writes nothing (the move is the select action). */
  function pageTarget(dir, f0 = state.sel.f, goal0 = state.goal) {
    const r = rectOf(f0, false); if (!r) return null;
    const goal = goal0 ?? caretX(f0.id, f0.off), h = scroller.clientHeight || 800;
    let cur = f0;
    for (let n = 0; n < 5000; n++) {
      const t = verticalTarget(dir, cur, goal); if (!t || (t.p.id === cur.id && t.p.off === cur.off)) break;
      const rr = rectOf(t.p, false);
      if (rr && Math.abs(rr.top - r.top) > h) break;
      cur = t.p;
    }
    return cur === f0 ? null : { p: cur, goal };
  }
  /** The embed a vertical move from `o` enters, or null: down from the last visual line of the row just above an embed item enters
   *  it at its start; up from the first visual line of the row just below it enters at its end. */
  function embedHop(dir, o) {
    const i = items.findIndex((it) => it.addr === o.id); if (i < 0) return null;
    const nb = items[i + dir]; if (!nb?.embed || state.embeds[nb.key]?.collapsed || !embeds.canEnter(nb.key)) return null;
    const vls = visualLines(o.id); if (!vls) return null;
    const li = lineOfOff(vls, o.off);
    return dir > 0 ? (li === vls.length - 1 ? { key: nb.key, where: 'start' } : null) : (li === 0 ? { key: nb.key, where: 'end' } : null);
  }
  function caretMove(e, kind, dir) {
    if (!state.sel) return false;
    e.preventDefault(); // the key is the kit's whatever the resolution finds (never the browser's)
    // a move that does not extend starts from the selection's edge in its direction (a textarea's rule): up and left from
    // the start, down and right from the end; an extending move from the focus
    const idx = (id) => items.findIndex((it) => it.addr === id);
    const os = ordered(state.sel, idx);
    // line-edge moves that extend do as macOS does: the selection grows from its far edge in the move's direction and keeps
    // the other edge, whichever end the focus was on (a textarea's moveToEndOfLineAndModifySelection)
    const edgeExtend = e.shiftKey && (kind === 'edge' || kind === 'logical') && !collapsed(state.sel);
    const o = edgeExtend ? (dir < 0 ? os.a : os.f) : e.shiftKey || collapsed(state.sel) ? state.sel.f : (dir < 0 ? os.a : os.f);
    const keep = edgeExtend ? (dir < 0 ? os.f : os.a) : state.sel.a;
    const goal0 = e.shiftKey || collapsed(state.sel) ? state.goal : null;
    if (kind === 'v' && embeds && !e.shiftKey && collapsed(state.sel)) { // a caret at the edge of an embed enters it (one absolute embed focus action)
      const hop = embedHop(dir, o);
      if (hop) { dispatch({ type: 'embed', op: 'focus', key: hop.key, where: hop.where }, { ts: e.timeStamp }); return true; }
    }
    const t = kind === 'v' ? verticalTarget(dir, o, goal0) : kind === 'page' ? pageTarget(dir, o, goal0) : kind === 'edge' ? { p: visualEdge(dir, o), goal: null } : kind === 'logical' ? { p: logicalEdge(dir, o), goal: null } : null;
    // an embedded editor: ArrowUp on its first line at offset 0, ArrowDown on its last at its end, leaves to the host
    if (onEdge && kind === 'v' && !e.shiftKey && collapsed(state.sel) && (!t?.p || (t.p.id === o.id && t.p.off === o.off))) { onEdge(dir); return true; }
    if (!t?.p) return true; // nowhere to go: the key is still ours
    dispatch({ type: 'select', sel: { a: e.shiftKey ? keep : t.p, f: t.p }, goal: t.goal ?? undefined, reveal: true }, { ts: e.timeStamp });
    return true;
  }
  /** The logical line's start or end (⌃A / ⌃E): from state, no layout. */
  function logicalEdge(dir, f = state.sel.f) { const row = doc.get(f.id); return row ? { id: f.id, off: dir < 0 ? 0 : app.textOf(row).length } : null; }

  // ---------------------------------------------------------------- input adapter: one delegated listener
  let composingText = null;
  let pressX = NaN; // the x of the press that began the gesture: an input coordinate for snapHidden at its end, never state
  let interactions = 0;
  function on(e) {
    // an event from inside an embedded editor is that editor's (it bubbles through this root): not an input of this one
    if (e.type !== 'scroll' && e.type !== 'selectionchange' && e.target?.nodeType && inEmbedBody(root, e.target)) return;
    if (e.type === 'keydown' || e.type === 'pointerdown') interactions += 1;
    switch (e.type) {
      case 'beforeinput': {
        if (e.isComposing || state.composing || e.inputType === 'insertCompositionText') return; // IME: the browser edits; read back at compositionend
        e.preventDefault();
        const sel = state.sel || domSel(); if (!sel) return;
        let text = e.data ?? '';
        if (e.dataTransfer) text = e.dataTransfer.getData('text/plain') ?? text;
        let range = null;
        if (e.inputType === 'insertReplacementText' && e.getTargetRanges) { const r = e.getTargetRanges()[0]; if (r) { const a = addrOfPoint(root, r.startContainer, r.startOffset), f = addrOfPoint(root, r.endContainer, r.endOffset); if (a && f) range = { a, f }; } }
        dispatch({ type: 'input', inputType: e.inputType, text, sel: range || sel }, { ts: e.timeStamp });
        return;
      }
      case 'keydown': {
        if (e.isComposing || state.composing) return;
        // the macOS editing chords, mapped here from state: whether Chromium emits their beforeinput depends on the DOM
        // (⌃T over styled text did nothing with the stylesheet on and swapped with it off), and styling must never
        // change what a key does. The caret chords (⌃A ⌃E ⌃F ⌃B ⌃N ⌃P ⌃V ⌥V) are resolved by the kit below.
        if (mac && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && EMACS[e.key.toLowerCase()] && state.sel) {
          e.preventDefault();
          dispatch({ type: 'input', inputType: EMACS[e.key.toLowerCase()], text: '', sel: state.sel }, { ts: e.timeStamp });
          return;
        }
        // a touch bar's virtual modifier (state.vmod, held or latched) is the platform's chord modifier on this key, and the key is spent as a chord: a latch is
        // one key, and a letter that matches no chord never reaches the line
        // vim mode: every key vim owns (a plain key, Escape, Enter, Backspace, Tab, ⌃R, ⌃C, ⌃[) is one `vimkey` action in vim's notation; ⌘ and ⌥ chords, arrows and
        // anything else stay the editor's (⌘Z, ⌘F ...), so the app's own keys still work
        if (state.vim.on && app.vim && !state.composing) {
          const vk = vimNotation(e);
          if (vk) { e.preventDefault(); dispatch({ type: 'vimkey', key: vk }, { ts: e.timeStamp }); return; }
        }
        const vm = state.vmod.held || state.vmod.latched;
        const ke = vm ? { key: e.key, code: e.code, repeat: e.repeat, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: mac ? e.ctrlKey : true, metaKey: mac ? true : e.metaKey } : e;
        for (const k of keySpecs) if (matches(ke, k.spec)) { e.preventDefault(); if (state.vmod.latched) dispatch({ type: 'vmod', op: 'latch', on: false }, { ts: e.timeStamp }); dispatch(k.action ? { ...k.action } : { type: 'key', name: k.name }, { ts: e.timeStamp }); return; }
        if (vm && e.key.length === 1) { e.preventDefault(); if (state.vmod.latched) dispatch({ type: 'vmod', op: 'latch', on: false }, { ts: e.timeStamp }); return; }
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); dispatch({ type: 'move', dir: e.key === 'ArrowLeft' ? -1 : 1, extend: e.shiftKey }, { ts: e.timeStamp }); return; }
        const k = e.key.toLowerCase(), plain = !e.metaKey && !e.altKey && !e.ctrlKey, ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey;
        // ⌃F ⌃B: a character, from state (the same action as → ←)
        if (mac && ctrlOnly && (k === 'f' || k === 'b')) { e.preventDefault(); dispatch({ type: 'move', dir: k === 'b' ? -1 : 1, extend: e.shiftKey }, { ts: e.timeStamp }); return; }
        if (mac && ctrlOnly && (k === 'a' || k === 'e')) { caretMove(e, 'logical', k === 'a' ? -1 : 1); return; }
        if ((plain && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) || (mac && ctrlOnly && (k === 'p' || k === 'n'))) { caretMove(e, 'v', e.key === 'ArrowUp' || k === 'p' ? -1 : 1); return; }
        if (mac && e.metaKey && !e.altKey && !e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { caretMove(e, 'edge', e.key === 'ArrowLeft' ? -1 : 1); return; }
        if (!mac && plain && (e.key === 'Home' || e.key === 'End')) { caretMove(e, 'edge', e.key === 'Home' ? -1 : 1); return; }
        if ((plain && (e.key === 'PageUp' || e.key === 'PageDown')) || (mac && ctrlOnly && k === 'v') || (mac && e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyV')) { caretMove(e, 'page', e.key === 'PageUp' || e.altKey ? -1 : 1); return; }
        return; // anything else (word jumps, document start/end) the browser does on the selection; selectionchange reads it
      }
      case 'compositionstart': { const s = domSel(); dispatch({ type: 'compose-start', addr: s?.f.id ?? state.sel?.f.id ?? null }, { ts: e.timeStamp }); composingText = s; return; }
      case 'compositionend': {
        const id = state.composing?.id, el = id && els.get(id)?.el;
        const s = domSel();
        dispatch({ type: 'compose-end', addr: id, text: el ? domText(el).replace(/\u00a0/g, ' ') : null, off: s?.f.id === id ? s.f.off : null }, { ts: e.timeStamp });
        composingText = null; return;
      }
      case 'pointerdown': {
        if (marginPress(e)) return;
        // a press in an inert gap that declares data-qk-gap (a zone divider's padding): the caret goes to the end of the
        // line above it (or the start of the line below when nothing is above), one absolute select through the reducer
        const gap = e.target.closest?.('[data-qk-gap]');
        if (gap && root.contains(gap) && e.button === 0) {
          e.preventDefault();
          const to = gapTarget(gap);
          if (to) { dispatch({ type: 'select', sel: { a: to, f: { ...to } }, reveal: false }, { ts: e.timeStamp }); if (D.activeElement !== root) root.focus({ preventScroll: true }); }
          return;
        }
        const act = e.target.closest?.('[data-action]');
        if (act && root.contains(act)) {
          e.preventDefault();
          const before = state.sel, name = act.getAttribute('data-action'), addr = lineOf(root, act)?.getAttribute(ADDR) ?? null;
          // kit pointer actions: 'fold' (the line's fold), 'caret:N' (the caret into the line's text at N: a decoration
          // such as rendered math hands the click to its source); anything else is the app's
          const c = /^caret:(\d+)$/.exec(name);
          if (name === 'fold' && addr) dispatch({ type: 'fold', addr }, { ts: e.timeStamp });
          else if (name.startsWith('embed:')) { // a header button: a gesture resolved here against the state the user saw into the absolute embed action
            const key = act.closest('[data-qk-embed]')?.getAttribute('data-qk-embed') ?? null;
            if (key && name === 'embed:collapse') dispatch({ type: 'embed', op: 'collapse', key, on: !state.embeds[key]?.collapsed }, { ts: e.timeStamp });
            else if (key && name === 'embed:title') dispatch({ type: 'embed', op: 'title-edit', key }, { ts: e.timeStamp });
            else if (key && name === 'embed:full') dispatch({ type: 'embed', op: 'mode', key, mode: 'full' }, { ts: e.timeStamp });
            else if (key && name === 'embed:window') { // a window from a full embed with no stored height starts at what it is drawn at now (at most 320 px), so nothing jumps
              const sp = items.find((it) => it.key === key)?.embed, now = act.closest('[data-qk-embed]')?.getBoundingClientRect().height ?? 0;
              dispatch({ type: 'embed', op: 'mode', key, mode: 'window', h: sp?.h != null ? undefined : Math.min(320, Math.round(now)) }, { ts: e.timeStamp });
            }
            else if (key && name === 'embed:fullscreen') dispatch({ type: 'embed', op: 'modal', key }, { ts: e.timeStamp });
          }
          else if (c && addr) dispatch({ type: 'select', sel: { a: { id: addr, off: +c[1] }, f: { id: addr, off: +c[1] } } }, { ts: e.timeStamp });
          else dispatch({ type: 'pointer', action: name, addr }, { ts: e.timeStamp });
          if (state.sel !== before && D.activeElement !== root) root.focus({ preventScroll: true });
        }
        // a plain press starts a selection gesture (ended by any of GESTURE_EXITS); the native caret it places is read back
        if (e.button === 0 && !state.gesture) { pressX = e.clientX; dispatch({ type: 'gesture', on: true, kind: 'select', pointer: e.pointerId ?? null }, { ts: e.timeStamp }); }
        return;
      }
      case 'copy': case 'cut': {
        if (!state.sel || collapsed(state.sel) || !e.clipboardData) return;
        e.preventDefault();
        const lines = doc.lines();
        e.clipboardData.setData('text/plain', app.clipText ? app.clipText(state.sel, lines) : textBetween(state.sel, lines, app.textOf));
        if (e.type === 'cut') dispatch({ type: 'input', inputType: 'deleteByCut', text: '', sel: state.sel }, { ts: e.timeStamp });
        return;
      }
      case 'focusin': if (!state.focus) dispatch({ type: 'focus', focus: true }, { ts: e.timeStamp }); return;
      case 'focusout': if (state.focus) dispatch({ type: 'focus', focus: false }, { ts: e.timeStamp }); return;
      case 'scroll': {
        const st = scroller.scrollTop;
        if (Math.abs(st - expectScroll) < 1) { scrollStats.echo += 1; return; } // the kit's own write
        expectScroll = -1;
        // a scroll no user input asked for (browser anchoring, a clamp, a focus or scrollIntoView, a stray script): the
        // anchor wins and scrollTop is written back from it; never read as the user scrolling
        if (!intent.user()) { scrollStats.foreign += 1; commit(); return; }
        scrollStats.user += 1;
        const anchor = anchorFromScroll(st);
        const follow = followEnd && atEnd(scroller) ? 'bottom' : 'free';
        if (anchor && (follow !== state.follow || !state.anchor || anchor.id !== state.anchor.id || Math.abs(anchor.px - state.anchor.px) > 0.5)) dispatch({ type: 'scroll', anchor, follow }, { ts: e.timeStamp });
        return;
      }
      case 'selectionchange': {
        if (inCommit || state.composing) return;
        const s = domSel(); if (!s) return;
        const cur = state.sel;
        const eq = (x, y) => x && y && ((x.a.id === y.a.id && x.a.off === y.a.off && x.f.id === y.f.id && x.f.off === y.f.off) || (x.a.id === y.f.id && x.a.off === y.f.off && x.f.id === y.a.id && x.f.off === y.a.off));
        if (painted && eq(s, painted)) return;
        if (cur && cur.a.id === s.a.id && cur.a.off === s.a.off && cur.f.id === s.f.id && cur.f.off === s.f.off) return;
        dispatch({ type: 'select', sel: s }, { ts: e.timeStamp });
      }
    }
  }
  const TYPES = ['beforeinput', 'keydown', 'compositionstart', 'compositionend', 'pointerdown', 'focusin', 'focusout', 'copy', 'cut'];
  for (const t of TYPES) root.addEventListener(t, on);
  scroller.addEventListener('pointerdown', (e) => { if (e.target === scroller) marginPress(e); }); // the margin beside the document (the root's own padding comes through `on`)
  scroller.addEventListener('scroll', on, { passive: true }); // scroll does not bubble: the scroller is the root's one scroll source
  D.addEventListener('selectionchange', on);                  // fires on the document only
  const onResize = () => commit(); // layout changed, state did not: re-measure and hold the anchor
  W.addEventListener('resize', onResize);
  // back to the tab: layout may have changed while hidden (ResizeObserver and frames paused); re-resolve from the anchor
  const onVisible = () => { if (D.visibilityState === 'visible' && !disposed) commit(); };
  D.addEventListener('visibilitychange', onVisible);

  // ---------------------------------------------------------------- gesture exits: nothing the user started stays stuck
  // A selection drag ends on release, cancel, lost capture, window blur, the page hiding, or a scroll the kit did not
  // make; an IME composition ends (its text read back as at compositionend) on blur or the page hiding, since the browser
  // may never send compositionend then (census E53: gestures not ended on every exit path froze the caret).
  const exitOn = (why) => (e) => {
    if (disposed) return;
    if (why === 'visibilitychange' && D.visibilityState !== 'hidden') return;
    if (why === 'scroll' && Math.abs(scroller.scrollTop - expectScroll) < 1) return; // the kit's own write
    const ts = e?.timeStamp ?? null;
    if (state.composing && (why === 'blur' || why === 'visibilitychange')) {
      const id = state.composing.id, el = id != null && els.get(id)?.el, s = domSel();
      dispatch({ type: 'compose-end', addr: id, text: el ? domText(el).replace(/\u00a0/g, ' ') : null, off: s?.f.id === id ? s.f.off : null, why }, { ts });
    }
    if (state.gesture) {
      // the native selection the press made is read back before the gesture ends: selectionchange is queued and arrives
      // after pointerup, and ending the gesture commits and paints state.sel, which wrote the selection from before the
      // press over the browser's new caret (a click left the caret where it was; zai3, 2026-11-11)
      if (why !== 'blur' && why !== 'visibilitychange') {
        let s = domSel(); const cur = state.sel;
        // each end beside hidden syntax goes to the side the pointer was on: the anchor where the press began, the focus where it ended
        if (s && why === 'pointerup') { const same = s.a.id === s.f.id && s.a.off === s.f.off; const f = snapHidden(s.f, e.clientX); s = { a: same ? { ...f } : snapHidden(s.a, pressX), f }; }
        if (s && !(cur && cur.a.id === s.a.id && cur.a.off === s.a.off && cur.f.id === s.f.id && cur.f.off === s.f.off)) dispatch({ type: 'select', sel: s }, { ts });
      }
      dispatch({ type: 'gesture', on: false, why }, { ts });
    }
  };
  const exits = GESTURE_EXITS.map((why) => [why === 'lostpointercapture' ? root : why === 'scroll' ? scroller : why === 'visibilitychange' ? D : W, why, exitOn(why)]);
  for (const [t, why, f] of exits) t.addEventListener(why, f, { passive: true, capture: true });

  // ---------------------------------------------------------------- dev: nothing writes root outside a commit
  let mo = null;
  function stray(recs, a) {
    const r = recs[0];
    const v = { type: r.type, target: r.target.nodeName, at: log.length, before: a?.type ?? null };
    violations.push(v);
    const err = new Error(`editor ${contract.name}: DOM mutated outside a kit commit (${v.type} on ${v.target}${a ? `, before ${a.type}` : ''}); render from state instead`);
    if (a) W.setTimeout(() => { throw err; }, 0); else throw err;
  }
  if (dev && W.MutationObserver) {
    mo = new W.MutationObserver((recs) => { const own = recs.filter((r) => !inEmbedBody(root, r.target)); if (own.length && !state.composing) stray(own, null); }); // an embedded editor's DOM is written by its own editor
    mo.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  }
  let perfObs = null; const eventTiming = [];
  if (dev && W.PerformanceObserver?.supportedEntryTypes?.includes('event')) {
    perfObs = new W.PerformanceObserver((l) => { for (const en of l.getEntries()) if (en.interactionId) eventTiming.push({ name: en.name, duration: en.duration, interactionId: en.interactionId, start: en.startTime }); });
    perfObs.observe({ type: 'event', durationThreshold: 16, buffered: true });
  }

  commit();

  // ---------------------------------------------------------------- checks (rule 5): each returns null when clean
  const checks = {
    /** Check 1: render the state from scratch into a fresh root and compare with the live root (structure, text, classes,
     *  addresses, spacer heights) and the DOM selection with the state selection. */
    freshDiff() {
      if (state.composing) return null;
      const fresh = D.createElement(root.tagName);
      const t = top.cloneNode(false), b = bottom.cloneNode(false); fresh.append(t, b);
      const st = scrollTarget() ?? scroller.scrollTop;
      const w = placeWindow(fresh, st); spacers(fresh, w);
      let live = root.innerHTML; const want = fresh.innerHTML;
      if (root.querySelector('[data-qk-embed-body]')) { const c = root.cloneNode(true); for (const b of c.querySelectorAll('[data-qk-embed-body]')) { b.replaceChildren(); for (const at of [...b.attributes]) if (at.name.startsWith('data-embed-')) b.removeAttribute(at.name); } live = c.innerHTML; } // the embedding code's own markers on the body (data-embed-*) are its, not the host's // an embed body is its own editor's
      if (live !== want) { let i = 0; while (live[i] === want[i]) i++; return { what: 'dom', at: i, live: live.slice(Math.max(0, i - 80), i + 80), fresh: want.slice(Math.max(0, i - 80), i + 80) }; }
      if (state.focus && state.sel && D.activeElement === root) {
        const s = domSel(), x = state.sel;
        if (s && els.get(x.a.id) && els.get(x.f.id) && (s.a.id !== x.a.id || s.a.off !== x.a.off || s.f.id !== x.f.id || s.f.off !== x.f.off)) return { what: 'selection', dom: s, state: x };
      }
      const want2 = scrollTarget();
      if (want2 !== null && scroller.clientHeight && Math.abs(scroller.scrollTop - Math.min(want2, scroller.scrollHeight - scroller.clientHeight)) > 1) return { what: 'scroll', scrollTop: scroller.scrollTop, want: want2, anchor: state.anchor };
      return null;
    },
    /** Check 1b: every text node in the root is inside an addressed line or an inert element. */
    unaddressed() {
      const out = [], w = D.createTreeWalker(root, 4);
      for (let t = w.nextNode(); t; t = w.nextNode()) { const el = t.parentElement; if (!el.closest(`[${ADDR}]`) && !el.closest(`[${INERT}]`)) out.push(t.data.slice(0, 40)); }
      return out.length ? out : null;
    },
    /** Check 2: point -> address -> coordinates -> address, for every character of the rendered lines on screen. */
    roundTrip({ maxLines = 40 } = {}) {
      const fails = [], view = scroller.getBoundingClientRect();
      let lines = 0;
      for (let i = win.start; i < win.end && lines < maxLines; i++) {
        const it = items[i]; if (it.addr == null) continue;
        const e = els.get(it.key)?.el; if (!e) continue;
        const r0 = e.getBoundingClientRect(); if (r0.bottom < view.top || r0.top > view.bottom) continue;
        lines++;
        const len = domText(e).length;
        for (let off = 0; off < len; off++) {
          const r = rectOf({ id: it.addr, off });
          if (!r || r.width < 1) continue;
          const x = r.left + Math.min(2, r.width / 3), y = r.top + r.height / 2;
          if (y < view.top || y > view.bottom || !root.contains(D.elementFromPoint(x, y))) continue; // covered by UI outside the editor (a button, a toolbar): not the editor's map
          const back = addrAtPoint(x, y);
          if (!back || back.id !== it.addr || back.off !== off) fails.push({ id: it.addr, off, got: back });
        }
      }
      return fails.length ? fails.slice(0, 10).concat(fails.length > 10 ? [{ more: fails.length - 10 }] : []) : null;
    },
    mutations: () => (violations.length ? violations.slice() : null),
  };
  // Event Timing reports only entries >= 16 ms (the API floor), so the p95 is over every interaction the adapter saw, the
  // unreported ones counted at 16 ms: the slowest entry per interaction id, padded to the interaction count.
  const eventP95 = () => { const per = new Map(); for (const x of eventTiming) per.set(x.interactionId, Math.max(per.get(x.interactionId) || 0, x.duration)); const xs = [...per.values()]; while (xs.length < interactions) xs.push(16); return p95(xs); };
  const p95 = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; };

  const api = {
    state, dispatch, refillNow, commit, checks, log, latency, eventTiming, violations, budget,
    addrAtPoint, rectOf, domSel, rangeOf, readOnly, root, embeds,
    /** The text of row `id` as the editor counts offsets, or null (the app's textOf over the doc). */
    rowText: (id) => { const r = doc.get(id); return r ? app.textOf(r) : null; },
    get items() { return items; }, get window() { return win; }, index: ix, scroller, scrollStats,
    /** The element drawn for an item key (null when it is outside the window): for checks and probes, never app logic. */
    elOf: (key) => els.get(key)?.el ?? null,
    /** A promise for the pending document-wide read (⌘A/⌘F over unloaded pages), or null. */
    widening: () => widening,
    /** The kit's projection of a selection for UI outside the editor (a toolbar): the client rect of the selection. */
    selectionRect() { if (!state.sel) return null; const a = rectOf(state.sel.a, false), f = rectOf(state.sel.f, false); if (!a || !f) return null; const l = Math.min(a.left, f.left), r = Math.max(a.right, f.right), t = Math.min(a.top, f.top), b = Math.max(a.bottom, f.bottom); return { left: l, right: r, top: t, bottom: b, width: r - l, height: b - t }; },
    /** How many rows { type: 'day.roll', boundary } would move now (0 without a contract.rollover): the day clock's cheap check. */
    rollPending: (boundary) => (rollover ? rollRows(doc.lines(), rollover, boundary, clock()).length : 0),
    viewport() { return { top_px: scroller.scrollTop, viewport_px: scroller.clientHeight }; },
    subscribe(f) { listeners.add(f); return () => listeners.delete(f); },
    focus() { root.focus({ preventScroll: true }); },
    /** Scroll by `px` through the kit's own anchor (one absolute `scroll` action): for the line drag's edge pull and other app scrolling. */
    scrollBy(px) { const st = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + px)); const anchor = anchorFromScroll(st); if (anchor && Math.abs(st - scroller.scrollTop) >= 0.5) dispatch({ type: 'scroll', anchor, follow: 'free' }); },
    snapshot: () => snapshot(app, doc, state),
    stats() { const by = {}; for (const l of latency) (by[l.type === 'input' || l.type === 'key' ? (l.name || l.type) : l.type] ||= []).push(l.ms); return { actions: log.length, p95: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, Math.round(p95(v))])), all_p95: Math.round(p95(latency.map((l) => l.ms))), event_timing_p95: eventP95(), event_timing_slow: eventTiming.length, interactions }; },
    dispose() { disposed = true; if (landingTimer) W.clearTimeout(landingTimer); if (expireTimer) { expireTimer(); expireTimer = null; } layer?.remove(); embeds?.dispose(); linePointer?.dispose(); for (const [t, why, f] of exits) t.removeEventListener(why, f, { capture: true }); for (const t of TYPES) root.removeEventListener(t, on); scroller.removeEventListener('scroll', on); D.removeEventListener('selectionchange', on); W.removeEventListener('resize', onResize); D.removeEventListener('visibilitychange', onVisible); intent.dispose(); ro?.disconnect(); mo?.disconnect(); perfObs?.disconnect(); },
  };
  if (embeds) { embeds.attach(api); embeds.sync(); }
  if (linePointer) linePointer.attach(api);
  return api;
}
export const p95 = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; };
