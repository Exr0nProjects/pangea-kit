// The kit editor's state and actions as declarations (PANGEA3-DESIGN §16, conformance row #38): createEditor registers
// them by construction, and an app declares them at module level (declareEditor(contract, app)) so the deploy gate, which
// never runs createEditor, loads them. validate() then runs every law over the editor's reducer (lib/editor/editor.js
// step, the one place an action meets the editor's state) with the generators registered here.
//
// What is declared. The state the kit owns (rule 1): the document rows (as the doc the reducer edits: every row by id
// plus `from`, the sort key of the oldest loaded row, null once the document is complete) and the view state: caret and
// selection (sel, goal), the selection gesture, the scroll anchor and follow, the landing lifecycle, folds, find, the
// pending document-wide op (wide) and its refusal notice, focus, pending writes, the IME composition, the kill ring and
// the reveal flag. Left out, said here rather than silently: `rev` (a render counter, not state) and `ext` (the app's own
// subtree, which may hold closures; the app's history is covered by lib/history.js laws and the app's own tests). Every
// action the editor dispatches is declared in one of two declarations, by how it is idempotent:
//   editor:<name>         conflict 'lww': absolute actions, idempotent BY VALUE (re-applying one changes nothing):
//                         select, scroll, focus, gesture, fold, pending, select-all, find, page, remote, compose-start,
//                         refill (the zone sentinel, lib/editor/refill.js: contract.refill) and every contract action not
//                         listed in contract.edits. A toggle here is red (the idempotent
//                         law): a relative action must be a gesture resolved before dispatch (resolveGesture: fold's
//                         toggle, the ← → caret move).
//   editor:<name>:edits   conflict 'log': text edits, idempotent BY INTENT ID, not by value (typing "a" twice is "aa"):
//                         input, key, compose-end, pointer (lib/editor/editor.js EDIT_ACTIONS) and contract.edits. The
//                         action id is the rows.put intent (A7): the editor drops an id it has seen (createEditor's seen
//                         set, `seen` here) and the row store drops an intent it has applied (rows.js, on disk:
//                         `intents` here). The dedupe law checks that a redelivered edit changes nothing; noLoss
//                         checks the rows survive a crash after any edit.
// Both are scope 'local' with persist keeping the document (and the applied intents): that is what survives a reload
// (rows.js on IndexedDB); the view state is session state (createEditor starts from initState), so reloadRestores and
// firstPaint check the document through every editor action.
//
// Model of the paged doc: 'page' carries the window it opened ({ from: sortKey | null }, absolute) and 'remote' the rows
// that arrived ({ rows: [{ id, set }] }); the declared reducer applies them to the doc, then runs the kit's own step.
//
// Generators (registered for validate by declaration name): payloads drawn from the state (selections over the loaded
// rows, anchors on row ids, fold addresses, the app's key names) plus junk; an app's own actions draw from
// contract.gens[action](rng, { lines, view, sample }) -> payload. contract.sample: rows to start from (default three
// plain rows); contract.sortKey / contract.live: the doc's order and liveness (default memoryLines': [ord, id], not
// deleted_at).
import { declare } from '../model.js';
import { registerGenerator } from '../declare-keys.js';
import { canonical } from '../canonical.js';
import { step, initState, EDIT_ACTIONS, KIT_ACTIONS } from './editor.js';
import { checkRefill } from './refill.js';
import { checkRollover, touchedMs } from './rollover.js';

const CONTRACT_KEYS = ['name', 'actions', 'edits', 'budget_p95_ms', 'gens', 'sample', 'sortKey', 'live', 'refill', 'rollover'];
/** The kit's absolute (lww) actions that reach the reducer. 'move' is not one: dispatch resolves it to a select. */
export const VIEW_ACTIONS = Object.freeze(['select', 'scroll', 'focus', 'gesture', 'fold', 'pending', 'select-all', 'find', 'page', 'remote', 'compose-start', 'embed', 'presence', 'hover', 'drag', 'gutter', 'vmod', 'vim']); // plus 'refill' and 'day.roll' when the contract declares them
const VIEW_KEYS = ['sel', 'goal', 'gesture', 'anchor', 'follow', 'landing', 'wide', 'notice', 'focus', 'folds', 'pending', 'composing', 'reveal', 'kill', 'find', 'peers', 'embeds', 'modal', 'embedFocus', 'embedDrag', 'embedTitleEdit', 'hover', 'drag', 'gutter', 'vmod', 'vim'];
const SEEN = 2000; // createEditor's seen-id window
const INTENTS = 2048; // rows.js INTENT_RING
const DEFAULT_SAMPLE = [{ id: 's1', ord: 1, body: 'first line' }, { id: 's2', ord: 2, body: 'second line here' }, { id: 's3', ord: 3, body: '' }, { id: 's4', ord: 4, body: 'last' }];
const INPUT_TYPES = ['insertText', 'insertText', 'insertParagraph', 'insertLineBreak', 'insertFromPaste', 'insertReplacementText', 'insertFromYank', 'insertTranspose', 'insertOpenLine',
  'deleteContentBackward', 'deleteContentBackward', 'deleteContentForward', 'deleteWordBackward', 'deleteWordForward', 'deleteSoftLineBackward', 'deleteHardLineForward', 'deleteByCut', 'historyUndo', 'historyRedo'];
const TEXTS = ['x', 'hello world', '', ' ', 'a\nb', '- [ ] todo\n', '**', 'é'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// A JSON round trip's copy, without the round trip for plain data: the reducer copies the whole view state twice per action
// (about twenty small values), and the stringify/parse pair dominated a step once the view grew its embed and presence keys.
// Same result as JSON.parse(JSON.stringify(v)) for plain data (undefined and function properties dropped, in an array null,
// a non-finite number null); anything else (a Date, a class instance with toJSON, a bigint) takes the round trip itself.
const plain = (v) => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };
function copy(v) {
  if (v === null) return null;
  switch (typeof v) {
    case 'string': case 'boolean': return v;
    case 'number': return Number.isFinite(v) ? (v === 0 ? 0 : v) : null; // -0 is 0 once written as JSON
    case 'object': break;
    default: return undefined; // undefined, function, symbol: dropped by the caller, null in an array
  }
  if (Array.isArray(v)) { const out = new Array(v.length); for (let i = 0; i < v.length; i++) { const c = copy(v[i]); out[i] = c === undefined ? null : c; } return out; }
  if (!plain(v) || typeof v.toJSON === 'function') return JSON.parse(JSON.stringify(v));
  const out = {}; for (const k in v) if (Object.hasOwn(v, k)) { const c = copy(v[k]); if (c !== undefined) { if (k === '__proto__') Object.defineProperty(out, k, { value: c, enumerable: true, writable: true, configurable: true }); else out[k] = c; } } return out;
}
export const json = (v) => { if (v === undefined) return null; if (typeof v === 'bigint') return JSON.parse(JSON.stringify(v)); const c = copy(v); return c === undefined ? JSON.parse(JSON.stringify(v)) : c; };
const cmpKey = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (typeof x !== typeof y) return typeof x === 'number' ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
};

/** The doc the declared reducer edits: rowsDoc's shape (lines = the loaded live rows in order, get = a loaded live row,
 *  peek = any row, put merges sets) over { rows: { id: row }, from }; `intents` (a Set) drops a put whose intent it holds.
 *  Copy on write: the input rows are never touched; changed() lists the rows a put wrote (the new objects). The ordered
 *  lines of an unchanged doc object are computed once (a WeakMap on it), so a step costs what the kit's own step costs. */
const linesMemo = new WeakMap();
export function modelDoc(d, { sortKey, live, intents = null }) {
  const base = isObj(d?.rows) ? d.rows : {};
  const from = Array.isArray(d?.from) ? d.from : null;
  const loaded = (r) => from === null || cmpKey(sortKey(r), from) >= 0;
  const cmp = (a, b) => cmpKey(sortKey(a), sortKey(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const written = new Map();
  let cache = null;
  const row = (id) => (written.has(id) ? written.get(id) : Object.hasOwn(base, id) ? base[id] : null);
  const order = () => [...new Set([...Object.keys(base), ...written.keys()])].map(row).filter((r) => r && live(r) && loaded(r)).sort(cmp);
  return {
    lines() {
      if (cache) return cache;
      if (!written.size && isObj(d)) { const m = linesMemo.get(d); if (m && m.sortKey === sortKey) return (cache = m.lines); cache = order(); linesMemo.set(d, { sortKey, lines: cache }); return cache; }
      return (cache = order());
    },
    get: (id) => { const r = row(id); return r && live(r) && loaded(r) ? r : null; },
    peek: (id) => row(id),
    put(puts, { intent = null } = {}) {
      if (intent && intents?.has(intent)) return [];
      for (const p of puts || []) if (p && typeof p.id === 'string' && isObj(p.set)) written.set(p.id, { ...(row(p.id) || { id: p.id }), ...json(p.set), id: p.id });
      if (intent && intents) intents.add(intent);
      cache = null;
      return [];
    },
    atStart: () => from === null,
    /** The rows a put changed by value: [[id, row]]. */
    changed: () => [...written].filter(([id, r]) => !Object.hasOwn(base, id) || canonical(base[id]) !== canonical(r)),
    rows: () => Object.fromEntries([...new Set([...Object.keys(base), ...written.keys()])].map((id) => [id, row(id)])),
  };
}

// canonical() of a view state, remembered on the (never mutated) view object: the view this step returns is the next step's s.view,
// so each step canonicalizes one view, not two.
const canonViews = new WeakMap();
function canonView(v) {
  if (!isObj(v)) return canonical(v);
  let c = canonViews.get(v);
  if (c === undefined) { c = canonical(v); canonViews.set(v, c); }
  return c;
}
const pickView = (st) => Object.fromEntries(VIEW_KEYS.map((k) => [k, json(st[k])]));

/** The declared reducer for one editor action: the kit's own step over a model doc and a copy of the view state. Pure:
 *  the input state is never touched; an action that changes nothing returns the input state itself. */
function reducerFor(app, type, { log, sortKey, live, edits, refill = null, rollover = null }) {
  return (s, payload) => {
    const p = isObj(payload) ? payload : {};
    if (log && (typeof p.id !== 'string' || !p.id)) return s; // a logged edit always carries its intent id; replay skips one without
    if (log && s.seen.includes(p.id)) return s;               // createEditor: a redelivered action id is a no-op
    const a = { ...p, type, at: Number.isFinite(p.at) ? p.at : 0 }; // dispatch stamps every action's time
    let d = s.doc;
    if (type === 'page' && (p.from === null || (Array.isArray(p.from) && p.from.every((x) => typeof x === 'number' || typeof x === 'string'))) && canonical(p.from) !== canonical(d.from)) d = { ...d, from: p.from };
    if (type === 'remote' && Array.isArray(p.rows)) {
      let rows = d.rows;
      for (const r of p.rows) if (r && typeof r.id === 'string' && isObj(r.set)) { const nr = { ...(rows[r.id] || {}), ...json(r.set), id: r.id }; if (canonical(nr) !== canonical(rows[r.id])) { if (rows === d.rows) rows = { ...d.rows }; rows[r.id] = nr; } }
      if (rows !== d.rows) d = { ...d, rows };
    }
    const intents = log ? new Set(s.intents) : null;
    const doc = modelDoc(d, { sortKey, live, intents });
    const st = { ...json(s.view), rev: 0, ext: app.init ? app.init() : {} };
    step(app, doc, st, a, { edits, refill, rollover });
    const changed = doc.changed();
    if (changed.length) d = { ...d, rows: { ...d.rows, ...Object.fromEntries(changed) } };
    const view = pickView(st);
    const sameView = canonView(view) === canonView(s.view);
    const sameIntents = !log || intents.size === s.intents.length;
    if (d === s.doc && sameView && sameIntents) return s;
    const next = { ...s, doc: d === s.doc ? s.doc : { rows: d.rows, from: d.from ?? null }, view: sameView ? s.view : view };
    if (log) { next.intents = sameIntents ? s.intents : [...intents].slice(-INTENTS); next.seen = [...s.seen, p.id].slice(-SEEN); }
    return next;
  };
}

/** The generator validate() runs for an editor declaration: gen(rng, state, { junk }) -> [action, payload]. */
export function editorGen(app, contract, { actions, log, sortKey, live, sample }) {
  const keys = app.keys?.length ? app.keys : ['Tab'];
  return (r, s, opts = {}) => {
    const name = r.pick(actions);
    if (opts.junk && r.chance(0.06)) return [name, r.pick([{}, { sel: 5 }, { sel: { a: 1 } }, { anchor: 'x' }, { id: `j${r.int(0, 9)}`, sel: { a: { id: 3 } }, inputType: 7 }, { addr: null, on: 'yes' }, { count: -1 }, { q: 4 }, { rows: 'x' }, { from: {} }])];
    const doc = modelDoc(s?.doc, { sortKey, live });
    const lines = doc.lines(), all = Object.values(doc.rows()), view = s?.view || {};
    const len = (row) => { try { return app.textOf(row).length; } catch { return 0; } };
    const pt = () => { const row = lines.length ? r.pick(lines) : null; return row ? { id: row.id, off: r.int(0, len(row)) } : { id: 'gone', off: 0 }; };
    const sel = () => { const a = pt(); return r.chance(0.5) ? { a, f: { ...a } } : { a, f: pt() }; };
    const rowId = () => (all.length && r.chance(0.9) ? r.pick(all).id : `n${r.int(0, 3)}`);
    const tag = log ? { id: `e${r.int(0, 2 ** 30).toString(36)}`, at: 1.7e12 + r.int(0, 1e6) } : {};
    switch (name) {
      case 'select': return [name, { sel: r.chance(0.08) ? null : sel(), ...(r.chance(0.3) ? { goal: r.int(0, 400) } : {}), ...(r.chance(0.3) ? { reveal: true } : {}) }];
      case 'scroll': {
        const anchor = { id: r.chance(0.85) ? rowId() : 'h:head', px: r.int(-40, 200) };
        const l = view.landing;
        return [name, r.pick([
          { anchor, at: 1.7e12 + r.int(0, 50) },                                                   // a landing (pinned)
          { anchor, follow: r.pick(['free', 'bottom']) },                                           // a user scroll
          { follow: r.pick(['free', 'pinned', 'bottom']) },
          { landing: { id: l?.id ?? anchor.id, since: l?.since ?? null, status: r.pick(['landed', 'failed']) } }, // the deadline exit
        ])];
      }
      case 'focus': return [name, { focus: r.chance(0.5) }];
      case 'gesture': return [name, { on: r.chance(0.5), kind: 'select', pointer: r.int(0, 2) }];
      case 'fold': return [name, { addr: rowId(), on: r.chance(0.5) }];
      case 'pending': return [name, { count: r.int(0, 3) }];
      case 'select-all': return [name, {}];
      case 'find': return [name, r.pick([{ open: true }, { q: r.pick(['', 'line', 'e', 'zz', 'last']) }, { i: r.int(0, 3) }, { close: true, keep: r.chance(0.5) }])];
      case 'page': return [name, { from: r.chance(0.5) || !all.length ? null : sortKey(r.pick(all)) }];
      case 'remote': {
        const base = r.pick(sample);
        const id = r.chance(0.5) && all.length ? r.pick(all).id : `n${r.int(0, 3)}`;
        const set = json({ ...base, id: undefined });
        if (typeof set.ord === 'number') set.ord = r.int(0, 8) + 0.5;
        return [name, { rows: [{ id, set }] }];
      }
      case 'compose-start': return [name, { addr: rowId() }];
      // embeds (lib/editor/embed.js): collapse / modal / focus are absolute view ops over an embed item key; resize names a height the
      // app's embedPuts may write into the chip's row. presence (lib/presence.js): a peer, a drop, an expiry (the clock is the payload)
      case 'embed': { const key = `emb:${rowId()}`; return [name, r.pick([{ op: 'collapse', key, on: r.chance(0.5) }, { op: 'modal', key: r.chance(0.7) ? key : null }, { op: 'focus', key: r.chance(0.7) ? key : null }, { op: 'resize', key, h: r.int(40, 2400) }, { op: 'collapse', key: 3, on: 'x' }])]; }
      case 'presence': { const id = r.pick(['u1:a', 'u2:b', 'anon:c']); return [name, r.pick([{ peer: { id, name: r.pick(['ana', 'bo']), sel: r.chance(0.7) ? sel() : null, at: 1.7e12 + r.int(0, 30_000) } }, { drop: id }, { expire: 1.7e12 + r.int(0, 40_000) }, { peer: { id: '' } }])]; }
      // the pointer's aim: the row under it (hover), and a line drag's start / over / cancel / drop (lib/editor/linepointer.js)
      case 'vim': return [name, { on: r.chance(0.5) }];
      case 'vimkey': return [name, { ...tag, key: r.pick(['h', 'j', 'k', 'l', 'w', 'x', 'd', 'i', 'a', 'o', 'u', '.', '<Esc>', '<CR>', '<BS>', 'p', 'y', 'v', 'V', 'J', '>', '<', 'G', '0', '$', 'Q', '<C-r>']) }];
      case 'gutter': return [name, { row: r.chance(0.75) ? rowId() : r.pick([null, 7]) }];
      case 'vmod': return [name, r.pick([{ op: 'hold', on: true }, { op: 'hold', on: false }, { op: 'latch', on: true }, { op: 'latch', on: false }, { op: 'bogus', on: 'x' }])];
      case 'hover': return [name, { row: r.chance(0.8) ? rowId() : null }];
      case 'drag': { const row = rowId(); return [name, r.pick([{ op: 'start', row }, { op: 'over', row, to: { id: rowId(), after: r.chance(0.5) } }, { op: 'over', row, to: null }, { op: 'drop', row, to: { id: rowId(), after: r.chance(0.5) } }, { op: 'cancel' }, { op: 'drop', row: 7, to: 'x' }])]; }
      // a day start picked around the rows' own write times (before, at, after them), the action's time just past it; sometimes in the future (a no-op)
      case 'day.roll': { const t = all.length ? touchedMs(r.pick(all)) : 1.7e12; const b = (Number.isFinite(t) ? t : 1.7e12) + r.pick([-1, 0, 1, 1000, 86_400_000]); return [name, { boundary: b, at: b + r.pick([0, 5, -3]) }]; }
      case 'refill': return [name, { zone: contract.refill && r.chance(0.95) ? r.pick(contract.refill.zones) : r.pick(['nowhere', 7, null]) }];
      case 'input': return [name, { ...tag, inputType: r.pick(INPUT_TYPES), text: r.pick(TEXTS), sel: sel() }];
      case 'key': return [name, { ...tag, name: r.pick(keys) }];
      case 'compose-end': { const addr = view.composing?.id ?? rowId(); const text = r.pick(TEXTS.filter((t) => !t.includes('\n'))); return [name, { ...tag, addr, text, off: r.int(0, text.length) }]; }
      case 'pointer': return [name, { ...tag, action: r.pick(['cycle', 'caret:1', 'open:https://example.com', ...(contract.pointers || [])]), addr: rowId() }];
      default: {
        const g = contract.gens?.[name];
        return [name, { ...tag, ...(g ? g(r, { lines, view, sample, rowId, sel }) : {}) }];
      }
    }
  };
}

const declared = new WeakMap();
/** Declare an editor's state and actions (two declarations, see the header) and register their generators. Idempotent
 *  per contract object: createEditor calls it with the app's contract, so a module-level declaration and the running
 *  editor are one. Returns { view, edits } (the declarations). */
export function declareEditor(contract, app) {
  if (isObj(contract) && declared.has(contract)) return declared.get(contract);
  if (!isObj(contract) || typeof contract.name !== 'string' || !Array.isArray(contract.actions)) throw new Error('declareEditor: a contract { name, actions } is required');
  if (!app || typeof app.textOf !== 'function') throw new Error(`declareEditor ${contract.name}: app.textOf is required`);
  for (const k of Object.keys(contract)) if (!CONTRACT_KEYS.includes(k)) throw new Error(`declareEditor ${contract.name}: unknown contract key "${k}" (a contract takes ${CONTRACT_KEYS.join(', ')})`);
  for (const a of contract.actions) if (KIT_ACTIONS.includes(a)) throw new Error(`declareEditor ${contract.name}: "${a}" is a kit action; contract.actions lists the app's own`);
  const editsOwn = contract.edits || [];
  for (const a of editsOwn) if (!contract.actions.includes(a)) throw new Error(`declareEditor ${contract.name}: edits names "${a}", which is not in contract.actions`);
  for (const a of Object.keys(contract.gens || {})) if (!contract.actions.includes(a) || typeof contract.gens[a] !== 'function') throw new Error(`declareEditor ${contract.name}: gens.${a} must be a function for a contract action`);
  const sortKey = contract.sortKey || ((r) => [r.ord ?? 0, r.id]);
  const live = contract.live || ((r) => !r.deleted_at);
  const sample = (contract.sample || DEFAULT_SAMPLE).map(json);
  const refill = checkRefill(contract.refill, `declareEditor ${contract.name}`);
  const rollover = checkRollover(contract.rollover, `declareEditor ${contract.name}`);
  const editSet = new Set(editsOwn);
  const view0 = pickView(initState({}));
  // half the sample loaded: the doc starts paged, so select-all, find and page exercise the document-wide ops
  const ordered = sample.slice().sort((a, b) => cmpKey(sortKey(a), sortKey(b)));
  const from = ordered.length > 1 ? sortKey(ordered[Math.floor(ordered.length / 2)]) : null;
  const doc0 = { rows: Object.fromEntries(sample.map((r) => [r.id, r])), from };
  // the generated runs start with a selection over the first loaded row (the edits declaration has no select action of
  // its own: its keys and marks act on the selection the run starts with and the edits leave)
  const tlen = (row) => { try { return app.textOf(row).length; } catch { return 0; } };
  const loaded0 = modelDoc(doc0, { sortKey, live }).lines(), first = loaded0.find((r) => tlen(r) > 0) || loaded0[0];
  const view0s = first ? { ...view0, sel: { a: { id: first.id, off: 0 }, f: { id: first.id, off: tlen(first) } } } : view0;
  // `drag` needs the app's `outline` (lines.js dropLines): an app without one never starts a drag, so the action is not part of its declared alphabet
  const viewActs = [...VIEW_ACTIONS.filter((t) => t !== 'drag' || app.outline), ...(refill ? ['refill'] : []), ...(rollover ? ['day.roll'] : []), ...contract.actions.filter((a) => !editSet.has(a))];
  const editActs = [...EDIT_ACTIONS.filter((t) => t !== 'vimkey' || app.vim), ...editsOwn];
  const build = (acts, log) => Object.fromEntries(acts.map((t) => [t, reducerFor(app, t, { log, sortKey, live, edits: editSet, refill, rollover })]));
  const budget = Number.isFinite(contract.budget_p95_ms) ? contract.budget_p95_ms : null;
  const budgets = (acts) => (budget ? Object.fromEntries(acts.map((t) => [t, { p95_ms: budget }])) : undefined);
  const view = declare({
    name: `editor:${contract.name}`, scope: 'local', conflict: 'lww',
    initial: { doc: doc0, view: view0s },
    persist: (s) => ({ ...s, view: view0s }),
    actions: build(viewActs, false), ...(budget ? { budget: budgets(viewActs) } : {}),
  });
  const edits = declare({
    name: `editor:${contract.name}:edits`, scope: 'local', conflict: 'log',
    initial: { doc: doc0, view: view0s, seen: [], intents: [] },
    persist: (s) => ({ ...s, view: view0s, seen: [] }),
    actions: build(editActs, true), ...(budget ? { budget: budgets(editActs) } : {}),
  });
  registerGenerator(view.name, editorGen(app, contract, { actions: viewActs, log: false, sortKey, live, sample }));
  registerGenerator(edits.name, editorGen(app, contract, { actions: editActs, log: true, sortKey, live, sample }));
  const out = Object.freeze({ view, edits });
  declared.set(contract, out);
  return out;
}
