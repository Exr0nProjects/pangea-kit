// Scenario generator core (pangea-ui-kit testing, GUIDE section 7).
//
// A scenario is data: { seed, steps: [{ op, ...args }] }. It is generated from a seed by a fixed PRNG out of
// a VOCABULARY the app declares, serialized as JSON, and replayed identically against any number of builds.
// A vocabulary is one map of ops; each op has a weight, an optional `args(g)` that draws its arguments from
// the generator `g`, an optional `closes` naming the op that ends it (a fault opened by `serverDown` is
// closed by `serverUp` a few steps later), and a `family` (user | server | fault | any word) for coverage.
//
// Shrinking is ddmin over the step list. The runner (trace.js) always appends the app's own finale (every
// fault cleared, quiescence), so ANY subsequence of a scenario is itself a valid scenario: shrinking only
// deletes steps and needs no repair pass.

/** mulberry32: 32-bit state, same sequence on every engine. */
export function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Declare a vocabulary. `ops`: { name: { weight = 1, args?(g) -> object, closes?: 'opName', family? } }.
 * Ops named only as closers (never drawn) are declared with weight 0.
 */
export function defineVocabulary({ name = 'app', ops }) {
  if (!ops || typeof ops !== 'object') throw new TypeError('defineVocabulary: ops is required');
  for (const [op, spec] of Object.entries(ops)) {
    if (spec.closes && !(spec.closes in ops)) throw new TypeError(`defineVocabulary: ${op} closes unknown op ${spec.closes}`);
    if (spec.weight !== undefined && !(spec.weight >= 0)) throw new TypeError(`defineVocabulary: ${op} weight must be >= 0`);
  }
  return Object.freeze({ name, ops });
}

/**
 * Generate one scenario. `g` handed to every `args`: { r() in [0,1), pick(n), choice(list), marker() } where
 * marker() is unique within the scenario and carries the seed (`s<seed>m<n>`), so the facts a step leaves
 * (a sent message, a created row) can be found again in any store.
 */
export function generate(vocabulary, seed, { length = 16, only = null } = {}) {
  const r = rng(seed);
  const g = {
    r,
    pick: (n) => Math.floor(r() * n),
    choice: (list) => list[Math.floor(r() * list.length)],
    marker: (() => { let n = 0; return () => `s${seed}m${n += 1}`; })()
  };
  const names = Object.keys(vocabulary.ops).filter((op) => !only || only.includes(op));
  const table = names.flatMap((op) => Array(Math.round(vocabulary.ops[op].weight ?? 1)).fill(op));
  if (!table.length) throw new Error('generate: every op has weight 0');
  const steps = [];
  const due = [];
  while (steps.length < length) {
    for (let k = due.length - 1; k >= 0; k -= 1) if (due[k].at <= steps.length) { steps.push({ op: due[k].op }); due.splice(k, 1); }
    const op = table[g.pick(table.length)];
    const spec = vocabulary.ops[op];
    // One open instance of each fault at a time: a second `serverDown` inside the first would be a no-op.
    if (spec.closes && due.some((d) => d.op === spec.closes)) continue;
    steps.push({ op, ...(spec.args ? spec.args(g) : {}) });
    if (spec.closes) due.push({ at: steps.length + 1 + g.pick(3), op: spec.closes });
  }
  for (const d of due) steps.push({ op: d.op });
  return { vocabulary: vocabulary.name, seed, length, steps };
}

/**
 * ddmin. `fails(steps) -> Promise<boolean>` runs a candidate and says whether the property still fails.
 * Returns the smallest failing step list found within `budget` candidate runs.
 */
export async function shrink(steps, fails, { budget = 40 } = {}) {
  let current = steps.slice();
  let granularity = 2;
  let runs = 0;
  while (current.length >= 2 && runs < budget) {
    const size = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let start = 0; start < current.length && runs < budget; start += size) {
      const complement = [...current.slice(0, start), ...current.slice(start + size)];
      if (!complement.length) continue;
      runs += 1;
      if (await fails(complement)) { current = complement; granularity = Math.max(granularity - 1, 2); reduced = true; break; }
    }
    if (!reduced) {
      if (granularity >= current.length) break;
      granularity = Math.min(current.length, granularity * 2);
    }
  }
  return { steps: current, runs };
}

/** Which ops (and families) a set of scenarios exercised: coverage of the vocabulary. */
export function coverage(vocabulary, scenarios) {
  const seen = new Map(Object.keys(vocabulary.ops).map((op) => [op, 0]));
  for (const s of scenarios) for (const step of s.steps) seen.set(step.op, (seen.get(step.op) || 0) + 1);
  const unexercised = [...seen].filter(([, n]) => !n).map(([op]) => op);
  return { counts: Object.fromEntries(seen), unexercised };
}
