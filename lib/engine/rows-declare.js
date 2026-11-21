// Keyed rows (lib/engine/rows.js) as a declaration (PANGEA3-DESIGN §16, conformance row #38): openRows registers it by
// construction, and an app declares it at module level (declareRows({ name, fields, together })) so the deploy gate, which
// never opens IndexedDB, loads it; validate() then runs every law over the row merge.
//
// What is declared: the rows (by id, each field with the HLC stamp of its value, `_s`), the intents applied (rows.js keeps
// the last 2,048 per browser on disk; here a sorted set, so it does not depend on the fold order) and the conflict policy: per-field last-writer-wins on the stamp (mergeRow, the one merge
// rule every replica and the MCP Worker share), conflict 'lww' because a patch carries absolute values and their stamps,
// so re-applying one changes nothing (idempotent by value) in any order. Two actions:
//   put     { intent, rows: [{ id, set, at }] }  a local write as rows.put stamps it; a repeated intent is a no-op; a patch
//           that splits a `together` group or writes an undeclared field is refused at dispatch (guards, as rows.put
//           throws) and skipped in replay (the reducer is total)
//   ingest  { rows: [{ id, set, at }] }          remote entries (another device, the MCP Worker)
// owner: put (his words): noLoss checks a crash after any put. Scope 'cloud' (rows sync on the Stream): tabsConverge and
// idempotentRetry run two devices over a lossy transport.
// fields: the field names a row may carry (`prefix*` admits a family, e.g. structure.js's 'mv:*' and 'in:*'); omitted,
// any field is accepted and the generator draws from the sample. openRows refuses a put writing an undeclared field.
import { declare } from '../model.js';
import { registerGenerator } from '../declare-keys.js';
import { mergeRow, splitGroup, stampOf } from './rows.js';

const INTENTS = 2048; // rows.js INTENT_RING
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A predicate over field names from a declared list ('body', 'mv:*'); null when no list is declared. */
export function fieldPredicate(fields) {
  if (!fields) return null;
  const exact = new Set(fields.filter((f) => !f.endsWith('*'))), pre = fields.filter((f) => f.endsWith('*')).map((f) => f.slice(0, -1));
  return (f) => exact.has(f) || pre.some((p) => f.startsWith(p));
}
/** Why patch p is refused by the declaration (an undeclared field, a split group), or null. */
export function patchError(p, { fieldOk, together }) {
  if (!p || typeof p.id !== 'string' || !isObj(p.set)) return 'a patch is { id, set }';
  if (fieldOk) for (const f of Object.keys(p.set)) if (f !== 'id' && !f.startsWith('_') && !fieldOk(f)) return `patch ${p.id} writes undeclared field "${f}"`;
  return splitGroup(p, together);
}

const declaredRows = new Map();
/** Declare a row store. Returns { name, fields, together, decl } (decl: the declaration validate() checks). Idempotent
 *  per name and shape; openRows calls it, so the running store and a module-level declaration are one. */
export function declareRows({ name, fields = null, together = [], sample = null } = {}) {
  if (!name || typeof name !== 'string') throw new Error('declareRows: name is required');
  if (fields !== null && (!Array.isArray(fields) || !fields.length || fields.some((f) => typeof f !== 'string' || !f))) throw new Error(`declareRows ${name}: fields must be a non-empty list of field names`);
  if (!Array.isArray(together) || together.some((g) => !Array.isArray(g) || g.length < 2)) throw new Error(`declareRows ${name}: together must be a list of field groups`);
  const fieldOk = fieldPredicate(fields);
  if (fieldOk) for (const g of together) for (const f of g) if (!fieldOk(f)) throw new Error(`declareRows ${name}: together names "${f}", which is not a declared field`);
  const key = JSON.stringify({ name, fields, together });
  if (declaredRows.has(key)) return declaredRows.get(key);
  const refuse = (p) => patchError(p, { fieldOk, together });
  const merge = (s, rows, intent) => {
    if (!Array.isArray(rows) || !rows.length) return s;
    if (intent !== undefined && (typeof intent !== 'string' || !intent || s.intents.includes(intent))) return s;
    if (rows.some((p) => refuse(p))) return s; // all-or-nothing, as rows.put refuses the whole put
    let next = s.rows;
    for (const p of rows) { if (!isObj(p.at)) continue; const old = next[p.id]; const m = mergeRow(old, p); if (m !== old) { if (next === s.rows) next = { ...s.rows }; next[p.id] = m; } }
    // the applied intents are a set (kept sorted, the smallest dropped past the bound), recorded whether or not a field
    // won: which puts were applied never depends on the order they were folded in, so replicas converge
    if (!intent) return next === s.rows ? s : { ...s, rows: next };
    return { rows: next, intents: [...s.intents, intent].sort().slice(-INTENTS) };
  };
  const guard = (s, { payload }) => { for (const p of Array.isArray(payload?.rows) ? payload.rows : []) { const why = refuse(p); if (why) return { code: 'RowsRefused', message: why }; } return null; };
  const decl = declare({
    name: `rows:${name}`, scope: 'cloud', conflict: 'lww', owner: ['put'],
    initial: { rows: {}, intents: [] },
    actions: {
      put: (s, p) => merge(s, p?.rows, typeof p?.intent === 'string' ? p.intent : null),
      ingest: (s, p) => merge(s, p?.rows),
    },
    guards: { put: [guard], ingest: [guard] },
  });
  registerGenerator(decl.name, rowsGen({ fields, together, sample }));
  const out = Object.freeze({ name, fields, together, decl });
  declaredRows.set(key, out);
  return out;
}

/** The generator validate() runs for a row declaration: puts and ingests over a few ids, declared fields (a group written
 *  together), values from a small pool, unique stamps over a narrow clock (ties on time and reorderings), plus junk. */
export function rowsGen({ fields, together = [], sample = null }) {
  const plain = (fields || Object.keys(sample?.[0] || { body: '', ord: 0 })).filter((f) => !f.endsWith('*') && f !== 'id');
  const families = (fields || []).filter((f) => f.endsWith('*')).map((f) => f.slice(0, -1));
  const VALUES = ['', 'a', 'hello', 0, 1, 2.5, null, true];
  return (r, s, opts = {}) => {
    const type = r.chance(0.6) ? 'put' : 'ingest';
    if (opts.junk && r.chance(0.05)) return [type, r.pick([{}, { rows: 'x' }, { rows: [null] }, { rows: [{ id: 3 }] }, { intent: 5, rows: [] }])];
    const n = r.int(1, 2), rows = [];
    for (let k = 0; k < n; k++) {
      const id = `r${r.int(0, 3)}`, set = {}, at = {};
      // a narrow clock (ties on time, broken by the logical counter and the writer); a stamp is never reused for another
      // value (each write mints its own, A8), so the writer part is unique per generated write
      const stamp = stampOf(1000 + r.int(0, 6), `w${r.int(0, 2)}.${r.int(0, 2 ** 30).toString(36)}`, r.int(0, 2));
      const pick = r.pick(plain.length ? plain : ['body']);
      const group = together.find((g) => g.includes(pick)) || [pick];
      for (const f of group) set[f] = r.pick(VALUES);
      if (families.length && r.chance(0.2)) set[`${r.pick(families)}op${r.int(0, 2)}`] = JSON.stringify({ x: r.int(0, 3) });
      if (opts.junk && r.chance(0.05)) set[`undeclared${r.int(0, 1)}`] = 1;
      for (const f of Object.keys(set)) at[f] = stamp;
      rows.push({ id, set, at });
    }
    return [type, type === 'put' ? { intent: `i${r.int(0, 2 ** 30).toString(36)}`, rows } : { rows }];
  };
}
