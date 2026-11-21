// validate(): Pangea's platform.validate() + generate_tests() for the kit (PANGEA3-DESIGN §16, conformance row #38).
// Every declare() is recorded (lib/declare-keys.js registry) and every defineView() too (lib/views.js); validate()
// enumerates them and, for each declaration:
//   - the component laws over its own step (lib/laws.js checkDeclLaws: total, pure, noop-ref, idempotent | dedupe by
//     conflict, json, lifecycle), with per-action coverage: an action that never changed the state in the generated
//     runs is UNCOVERED and fails (give validate a generator for that declaration: `gens[name]`);
//   - the UI laws its shape turns on (lib/laws-ui checkUiLaws: reloadRestores, firstPaint, noLoss for owner/durable/log,
//     idempotentRetry + tabsConverge for cloud, reducerBudget);
// and over the views: every name resolves, the reactive graph is a DAG (Tarjan), each view is pure (lib/views.js).
// The deploy gate (lib/editor/gate.mjs validateDeclarations) loads every app module that declares state and runs this;
// any failure refuses the deploy.
//
// The generic generator (when an app gives none) draws an action and a payload object whose keys come from the state's
// own keys, the keys one level down and common payload names, and whose values come from the state and a small pool;
// junk payloads are objects (a reducer destructuring its payload is fine; one that throws on a wrong shape is not). An
// action that names its payload key (the `set(field, key)` shorthand: `payloadKey` on the reducer) gets that key three
// times in four, so a key no state or common name spells (`set('mainFolded', 'folded')`) is still reached.
import { declarations, generatorFor } from './declare-keys.js';
import { definedViews, checkViews } from './views.js';
import { checkDeclLaws } from './laws.js';
import { checkUiLaws } from './laws-ui/index.js';
import { UNDO_ACTION } from './undo.js';

const COMMON = ['id', 'key', 'value', 'to', 'on', 'open', 'at', 'px', 'text', 'name', 'set', 'index', 'position', 'mode', 'state', 'items', 'ids'];
const POOL = ['', 'a', 'b', 'x y', 0, 1, 2, -1, 0.5, 1000, true, false, null, [], ['a'], {}, { a: 1 }];
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** A generator for any declaration: gen(rng, state) -> [action, payload]. */
export function genericGen(decl) {
  const names = Object.keys(decl.actions).filter((a) => a !== UNDO_ACTION);
  return (r, s) => {
    const keys = new Set(COMMON), vals = [...POOL];
    for (const src of [s, decl.initial]) if (isObj(src)) for (const [k, v] of Object.entries(src)) {
      keys.add(k); vals.push(v);
      if (isObj(v)) for (const [k2, v2] of Object.entries(v)) { keys.add(k2); vals.push(v2); }
    }
    const K = [...keys], payload = {};
    const name = r.pick(names), own = decl.actions[name]?.payloadKey;
    const n = r.int(0, 3);
    for (let i = 0; i < n; i++) payload[r.pick(K)] = r.pick(vals);
    if (own && r.chance(0.75)) payload[own] = r.pick(vals);
    return [name, JSON.parse(JSON.stringify(payload))];
  };
}

/** Run every law over every declaration and view. Returns { ok, decls: [{ name, cases, coverage, uncovered, failures }],
 *  views, failures } where failures is the flat list (each with its declaration or view name). */
export async function validate({ decls = null, views = null, gens = {}, seeds = 40, length = 24, ui = true, timing = true } = {}) {
  const reg = declarations(), vreg = definedViews();
  const D = (decls ?? reg.decls).filter((d) => !d.name.startsWith('$laws:'));
  const V = views ?? vreg.views;
  const failures = [], out = [];
  if (!decls && reg.overflow) failures.push({ law: 'coverage', name: '(registry)', detail: `${reg.overflow} declarations past the registry bound were not checked` });
  if (!views && vreg.overflow) failures.push({ law: 'coverage', name: '(views)', detail: `${vreg.overflow} views past the bound were not checked` });
  for (const d of D) {
    const gen = gens[d.name] || generatorFor(d.name) || genericGen(d); // a kit-registered generator (editor, rows) before the generic one
    const own = [];
    let laws;
    try { laws = checkDeclLaws(d, gen, { seeds, length }); } catch (e) { laws = { failures: [{ law: 'total', detail: e.message }], coverage: {}, cases: 0 }; }
    own.push(...laws.failures);
    const uncovered = Object.entries(laws.coverage).filter(([a, n]) => a !== UNDO_ACTION && !n).map(([a]) => a);
    for (const a of uncovered) own.push({ law: 'coverage', detail: `action "${a}" never changed the state in ${laws.cases} generated steps; give validate a generator for ${d.name} (gens["${d.name}"])` });
    if (ui) {
      try { own.push(...(await checkUiLaws(d, gen, { seeds, length, timing })).failures); } catch (e) { own.push({ law: 'ui', detail: e.message }); }
    }
    // a law naming an action (reducerBudget, budget) keeps it as `action`: the failure names its declaration
    for (const f of own) failures.push({ ...f, name: d.name, ...(f.name && f.name !== d.name ? { action: f.name, detail: f.detail ?? `${f.name}: p95 ${Number(f.p95).toFixed(2)} ms over ${f.p95_ms ?? f.p99_ms} ms (n ${f.n})` } : {}) });
    out.push({ name: d.name, cases: laws.cases, coverage: laws.coverage, uncovered, failures: own });
  }
  for (const f of checkViews(V, D)) failures.push({ name: f.view, ...f });
  return { ok: failures.length === 0, decls: out, views: V.length, failures };
}

/** One line per failure, for a gate log. */
export const formatValidation = (r) => r.failures.map((f) => `${f.name}: ${f.law}${f.seed ? ` (seed ${f.seed})` : ''}: ${f.detail ?? ''}`).join('\n');
