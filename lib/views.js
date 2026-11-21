// Derived views over declared state (PANGEA3-DESIGN §9, conformance rows #34 reactive DAG and #35 pure views).
// A view is a pure function of the states (or other views) it names; it is the kit's only reactive edge, so the graph
// it forms is checked the way Pangea's validate() checks the reactive graph: every name resolves, there is no cycle
// (Tarjan's strongly connected components), and each function is pure (validate() in lib/validate.js runs checkViews).
//
//   const unread = defineView({ name: 'unread', from: ['chats', 'readMarks'], fn: (chats, marks) => ... })
//   readView(unread, (name) => replicas[name].get())     // recomputed only when an input reference changed
//
// Purity, as Python's ImpureViewError checks it: the source names no clock, randomness, storage, network or DOM
// (static), the function never mutates its (deep-frozen) inputs, and two calls on equal inputs give equal results.
import { canonical } from './canonical.js';

const MAX_VIEWS = 2000;
const views = new Map();
let overflow = 0;

export const IMPURE_SOURCE = /\bDate\.now\s*\(|\bnew Date\s*\(\s*\)|\bMath\.random\s*\(|\bperformance\.now\s*\(|\bcrypto\.|\bfetch\s*\(|\b(?:localStorage|sessionStorage|indexedDB|document|window|navigator)\b|\bset(?:Timeout|Interval)\s*\(/;

/** Declare a view: `from` names declarations or other views, `fn(...inputs)` derives from them in that order. */
export function defineView({ name, from, fn, ...rest }) {
  if (!name || typeof name !== 'string') throw new Error('defineView: name is required');
  const extra = Object.keys(rest);
  if (extra.length) throw new Error(`defineView ${name}: unknown key "${extra[0]}" (a view takes name, from, fn)`);
  if (!Array.isArray(from) || !from.length || !from.every((x) => typeof x === 'string')) throw new Error(`defineView ${name}: from must name at least one declaration or view`);
  if (typeof fn !== 'function') throw new Error(`defineView ${name}: fn must be a function`);
  const m = IMPURE_SOURCE.exec(fn.toString());
  if (m) throw new Error(`defineView ${name}: impure view (the source reads ${m[0].trim()}); pass time or ids in through a declared state`);
  const v = Object.freeze({ name, from: Object.freeze([...from]), fn });
  if (!views.has(name) && views.size >= MAX_VIEWS) overflow += 1; else views.set(name, v);
  return v;
}

/** Every view defined so far, and how many the bound turned away. */
export function definedViews() { return { views: [...views.values()], overflow }; }
export function clearViews() { views.clear(); overflow = 0; }

const memo = new WeakMap(); // view -> { inputs, out }
/** The view's value; `read(name)` gives a declaration's current state. Inputs that are views are read through readView. */
export function readView(v, read, byName = new Map([...views].map(([k, x]) => [k, x]))) {
  const inputs = v.from.map((n) => (byName.has(n) ? readView(byName.get(n), read, byName) : read(n)));
  const m = memo.get(v);
  if (m && m.inputs.length === inputs.length && m.inputs.every((x, i) => x === inputs[i])) return m.out;
  const out = v.fn(...inputs);
  memo.set(v, { inputs, out });
  return out;
}

/** Tarjan's strongly connected components over `graph` (name -> names it reads). Returns the cycles (each a list). */
export function findCycles(graph) {
  let index = 0;
  const idx = new Map(), low = new Map(), stack = [], on = new Set(), cycles = [];
  const visit = (v) => {
    idx.set(v, index); low.set(v, index); index += 1; stack.push(v); on.add(v);
    for (const w of graph.get(v) || []) {
      if (!graph.has(w)) continue;
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const scc = []; let w;
      do { w = stack.pop(); on.delete(w); scc.push(w); } while (w !== v);
      if (scc.length > 1 || (graph.get(v) || []).includes(v)) cycles.push(scc.reverse());
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return cycles;
}

const deepFreeze = (x) => { if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); for (const k of Object.keys(x)) deepFreeze(x[k]); } return x; };
const copy = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

/** Pangea validate() for views: references, DAG, purity. `decls`: the declarations the views may read (their initial
 *  states are the probe inputs). Returns failures [{ law: 'reference' | 'cycle' | 'pure', view, detail }]. */
export function checkViews(list, decls) {
  const failures = [];
  const byName = new Map(list.map((v) => [v.name, v]));
  const declByName = new Map(decls.map((d) => [d.name, d]));
  for (const v of list) for (const n of v.from) if (!byName.has(n) && !declByName.has(n)) failures.push({ law: 'reference', view: v.name, detail: `reads "${n}", which is neither a declaration nor a view` });
  const graph = new Map(list.map((v) => [v.name, v.from.filter((n) => byName.has(n))]));
  for (const c of findCycles(graph)) failures.push({ law: 'cycle', view: c[0], detail: `reactive cycle ${[...c, c[0]].join(' -> ')}` });
  if (failures.length) return failures;
  for (const v of list) {
    const m = IMPURE_SOURCE.exec(v.fn.toString());
    if (m) { failures.push({ law: 'pure', view: v.name, detail: `the source reads ${m[0].trim()}` }); continue; }
    const probe = () => v.from.map((n) => deepFreeze(copy(byName.has(n) ? null : declByName.get(n).initial)));
    try {
      const a = readOnce(v, probe(), byName, declByName), b = readOnce(v, probe(), byName, declByName);
      if (canonical(a) !== canonical(b)) failures.push({ law: 'pure', view: v.name, detail: 'two calls on equal inputs gave different results' });
    } catch (e) {
      failures.push({ law: 'pure', view: v.name, detail: /frozen|read only|read-only|not extensible|Cannot (assign|add|delete)/.test(e.message) ? `mutates its input: ${e.message}` : `throws on the initial states: ${e.message}` });
    }
  }
  return failures;
}
function readOnce(v, inputs, byName, declByName) {
  const args = v.from.map((n, i) => (byName.has(n) ? deepFreeze(readOnce(byName.get(n), byName.get(n).from.map((m) => deepFreeze(copy(byName.has(m) ? null : declByName.get(m).initial))), byName, declByName)) : inputs[i]));
  return v.fn(...args);
}
