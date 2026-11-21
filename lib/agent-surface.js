// An app's declared state and actions as an API for agents (PANGEA3-DESIGN A1: "agents use the same dispatch and query as the UI";
// invariant 10, agent parity). Pure and host-free: a Worker, a daemon or a test calls these over rows it holds; nothing here touches
// a network, a DOM or a clock (the caller passes `now`).
//
// What an agent can reach, stated so nothing is faked:
//   - The DOCUMENT (the rows a keyed-rows store holds: lines, tabs, version rows) is state a server can fold from the Stream, so it
//     is readable AND writable: `dispatchEditor` runs the editor's own declared reducer (lib/editor/declare.js declareEditor, the
//     `step` the browser runs) over those rows and returns the row patches the action wrote. Same reducer, same action ids (A7),
//     same intent on every patch, so a retry is a no-op wherever the log is read.
//   - The editor's VIEW state (caret, selection, scroll anchor, focus, folds, find, gestures, kill ring, hover, drag, composition,
//     embeds, modal, vim, presence peers) lives in a browser tab, per device, and is never sent to a server. It cannot be read or
//     dispatched from here: `describeEditor` marks each such action `held: 'device'`, `dispatchEditor` refuses it with
//     `client_only`. A dispatch starts from a fresh view (kit initState); `sel` in the arguments seeds the caret for actions that
//     act on it (key, pointer, compose-end), exactly as the payload of `input` carries its own.
//   - Any other declaration (declare() with scope cloud | local | ephemeral) is described by `describeDecl`: where its state lives
//     (cloud = a Pangea stream, device = this browser, ephemeral = this tab only) and its action names. Whether the host can read
//     or dispatch a cloud one is the host's to say (`held`).
import { declareEditor } from './editor/declare.js';
import { step as declStep } from './model.js';
import { canonical } from './canonical.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPt = (p) => p && typeof p === 'object' && typeof p.id === 'string' && Number.isFinite(p.off);
const isSel = (s) => Boolean(s && typeof s === 'object' && isPt(s.a) && isPt(s.f));

/** Kit editor actions that only change view state: held in a tab, never in the document. (`embed` and `drag` are view state
 *  except `embed {op: 'resize' | 'mode'}`, which writes the chip's row, and `drag {op: 'drop'}`, which moves lines.) */
export const VIEW_ONLY = Object.freeze(['select', 'move', 'scroll', 'focus', 'gesture', 'fold', 'pending', 'select-all', 'find', 'page', 'compose-start', 'presence', 'hover', 'gutter', 'vmod', 'vim']);
/** Not dispatchable by anyone: rows arrive through sync (`remote`) and `move` is resolved to a select before dispatch. */
const INGEST = Object.freeze({ remote: 'rows arrive from the Stream by sync, not by dispatch' });

/** Documented argument shapes of the kit's own actions (the declarations carry no payload schema; this table is the kit's statement of them). */
export const KIT_ARGS = Object.freeze({
  input: { inputType: "'insertText' | 'insertParagraph' | 'insertFromPaste' | 'deleteContentBackward' | 'deleteContentForward' | 'deleteWordBackward' | ... (the DOM beforeinput types)", text: 'string (for inserts)', sel: '{ a: { id: rowId, off: number }, f: { id: rowId, off: number } } (anchor and focus; a = f is a caret)' },
  key: { name: "chord name as the app binds it, e.g. 'Tab', 'mod+b', 'mod+Enter' (see the app's keys)", sel: 'optional caret seed, as input.sel' },
  pointer: { action: "'cycle' | 'caret:<n>' | an app pointer action", addr: 'row id', sel: 'optional caret seed' },
  'compose-end': { addr: 'row id', text: 'string', off: 'number' },
  vimkey: { key: "vim key, e.g. 'x', '<Esc>'", sel: 'optional caret seed' },
  refill: { zone: "the zone whose sentinel rows to fill (contract.refill.zones)" },
  'day.roll': { boundary: 'epoch ms of a day start that has passed' },
  embed: { op: "'resize' (h: px) | 'mode' (key, mode) write the chip row; every other op is view state", key: "'emb:<row id>'" },
  drag: { op: "'drop' (row, to: { id, after }) moves the line and its subtree; start | over | cancel are view state" },
});

/** The class of an action name for a given payload: 'doc' (may write rows) | 'view' (client-only) | 'ingest' (not dispatchable). */
export function classify(type, args = {}) {
  if (Object.hasOwn(INGEST, type)) return 'ingest';
  if (VIEW_ONLY.includes(type)) return 'view';
  if (type === 'embed') return args.op === 'resize' || args.op === 'mode' ? 'doc' : 'view';
  if (type === 'drag') return args.op === 'drop' ? 'doc' : 'view';
  return 'doc';
}

/** Deterministic rng for the example payloads (the same interface lib/laws.js hands the generators). */
function rng(seed = 7) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  return { next, int: (a, b) => a + Math.floor(next() * (b - a + 1)), pick: (xs) => xs[Math.floor(next() * xs.length)], chance: (p) => next() < p };
}

/** Rows as plain data: no stamp bookkeeping (`_s`), nothing the reducer does not read. */
const plainRow = (r) => { const o = {}; for (const [k, v] of Object.entries(r || {})) if (k !== '_s' && !k.startsWith('_')) o[k] = v; return o; };

/** Describe an editor's declared actions: [{ name, class, held, edit, args, example? }]. `contract`/`app` are what createEditor takes. */
export function describeEditor(contract, app, { rows = [] } = {}) {
  const decls = declareEditor(contract, app);
  const edits = new Set(Object.keys(decls.edits.actions)); // the kit's edit actions the app takes, plus contract.edits: the log-conflict declaration
  const own = new Set(contract.actions);
  const names = [...new Set([...Object.keys(decls.view.actions), ...Object.keys(decls.edits.actions)])].sort();
  const lines = rows.filter((r) => r && !r.deleted_at).slice(0, 3).map(plainRow);
  return names.map((name) => {
    const cls = classify(name);
    const out = { name, class: cls === 'doc' ? 'document' : cls === 'view' ? 'view' : 'ingest', held: cls === 'doc' ? 'cloud' : 'device', edit: edits.has(name), kit: !own.has(name), dispatchable: cls === 'doc', args: KIT_ARGS[name] || null };
    if (name === 'embed' || name === 'drag') { out.dispatchable = true; out.note = 'only the ops named in args write rows; the rest are refused client_only'; }
    if (!out.kit && typeof contract.gens?.[name] === 'function') {
      try {
        const rowId = () => lines[0]?.id ?? 'n1';
        const sel = () => ({ a: { id: rowId(), off: 0 }, f: { id: rowId(), off: 0 } });
        out.example = JSON.parse(JSON.stringify(contract.gens[name](rng(), { lines, view: { ...decls.view.initial.view, sel: null }, sample: contract.sample || [], rowId, sel })));
      } catch { /* an example is a courtesy: an action whose generator needs more than rows has none */ }
    }
    return out;
  });
}

/** Describe any declaration: where its state lives and its action names. `held` says whether THIS host reads it ('cloud' | 'device' | 'ephemeral'). */
export function describeDecl(decl, { readable = false, dispatchable = false } = {}) {
  const where = decl.scope === 'cloud' ? 'cloud' : decl.scope === 'local' ? 'device' : 'ephemeral';
  return { name: decl.name, scope: decl.scope, conflict: decl.conflict, held: where, readable: readable && where === 'cloud', dispatchable: dispatchable && where === 'cloud',
    actions: Object.keys(decl.actions).sort().map((name) => ({ name, ...(decl.actions[name]?.payloadKey ? { payloadKey: decl.actions[name].payloadKey } : {}) })) };
}

// Fields a patch may carry: everything a row holds except its identity. A deleted field is set null (rows are LWW per field).
const fieldsOf = (before, after) => {
  const set = {};
  for (const k of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (k === 'id' || k.startsWith('_')) continue;
    const a = before?.[k], b = after?.[k];
    if (canonical(a === undefined ? null : a) !== canonical(b === undefined ? null : b)) set[k] = b === undefined ? null : b;
  }
  return set;
};

/** Dispatch one editor action over rows through the editor's own declared reducer.
 *    rows     every row the store holds (live and deleted), plain objects with `id`
 *    action   { type, id, ...args }; `id` is the intent, minted once by the caller and reused on a retry (A7)
 *    now      the action's time in epoch ms (the reducer has no clock; dispatch stamps it)
 *  Returns { ok: true, applied, patches: [{ id, set, intent }], view } or { ok: false, code, why }. Pure: nothing is written; the host
 *  stamps the patches and appends them (and drops an `id` it has already logged before calling this). */
export function dispatchEditor({ contract, app, rows, action, now, readOnly = false }) {
  if (!isObj(action) || typeof action.type !== 'string') return { ok: false, code: 'bad_action', why: 'action: { type, id, ...args } is required' };
  if (typeof action.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(action.id)) return { ok: false, code: 'bad_id', why: 'id: the idempotency key, [A-Za-z0-9_.:-]{1,80}, minted once and reused on every retry' };
  const decls = declareEditor(contract, app);
  const inEdits = Object.hasOwn(decls.edits.actions, action.type), inView = Object.hasOwn(decls.view.actions, action.type);
  if (!inEdits && !inView) return { ok: false, code: 'unknown_action', why: `${action.type} is not a declared action of ${contract.name}`, actions: [...new Set([...Object.keys(decls.view.actions), ...Object.keys(decls.edits.actions)])].sort() };
  const cls = classify(action.type, action);
  if (cls === 'ingest') return { ok: false, code: 'not_dispatchable', why: INGEST[action.type] };
  if (cls === 'view') return { ok: false, code: 'client_only', why: `${action.type} changes view state (caret, scroll, focus, folds, find ...), which lives in a browser tab per device and is not held by the server` };
  if (readOnly) return { ok: false, code: 'read_only', why: 'this role may not write the document' };
  const decl = inEdits ? decls.edits : decls.view;
  const base = Object.fromEntries(rows.filter((r) => r && typeof r.id === 'string').map((r) => [r.id, plainRow(r)]));
  // a fresh view: the declaration's own initial view without its generated starting selection (that one is for the laws' runs, not a caret anyone has)
  const view = { ...decl.initial.view, sel: null };
  if (isSel(action.sel)) view.sel = action.sel;
  const state0 = { ...decl.initial, doc: { rows: base, from: null }, view, ...(inEdits ? { seen: [], intents: [] } : {}) };
  const payload = { ...action, at: Number.isFinite(now) ? now : 0 };
  let next;
  try {
    const r = declStep(decl, state0, action.type, payload);
    if (r.error) return { ok: false, code: 'refused', why: String(r.error) };
    next = r.state;
  } catch (e) { return { ok: false, code: 'reducer_error', why: String(e?.message || e) }; }
  const patches = [];
  if (next !== state0) {
    for (const [id, row] of Object.entries(next.doc.rows)) {
      if (row === base[id]) continue;
      const set = fieldsOf(base[id], row);
      if (Object.keys(set).length) patches.push({ id, set, intent: action.id });
    }
  }
  patches.sort((a, b) => (a.id < b.id ? -1 : 1));
  const refusal = next?.view?.notice || null;
  return { ok: true, applied: patches.length > 0, patches, ...(refusal ? { notice: refusal } : {}), view: { sel: next?.view?.sel ?? null } };
}
