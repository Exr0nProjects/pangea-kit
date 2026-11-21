// Latency budget law. Two measurements, one verdict shape:
//   * checkBudgets(contract, samples): samples measured in a real browser ({ name, ms } per interaction, ms is
//     input-to-next-paint; see frames.js measureInteraction) or read from a field log (client-lag.jsonl) against the
//     declared budgets. Covers interaction-latency, load-latency.
//   * reducerBudget(decl, gen, opts): the part of every interaction the kit owns, step() on a large state, timed per
//     action. Cheap (milliseconds, per commit) and catches O(n) work per keystroke before a browser ever runs.
// Verdict: [] when every budget holds, else [{ law: 'budget', name, p95, p95_ms, n }].
import { step } from '../model.js';
import { uiContract, UI_DEFAULTS } from './contract.js';

export function percentile(xs, p) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export function checkBudgets(contract, samples, { minSamples = 5 } = {}) {
  const by = new Map();
  for (const { name, ms } of samples) { if (!by.has(name)) by.set(name, []); by.get(name).push(ms); }
  const bad = [];
  for (const [name, xs] of by) {
    const b = contract.budgets[name];
    if (!b) { bad.push({ law: 'budget', name, detail: 'measured an interaction with no declared budget (declare it, or it is unbudgeted)' }); continue; }
    if (xs.length < minSamples) continue;
    const p95 = percentile(xs, 95), p99 = percentile(xs, 99);
    if (p95 > b.p95_ms) bad.push({ law: 'budget', name, p95, p95_ms: b.p95_ms, n: xs.length });
    else if (b.p99_ms && xs.length >= 20 && p99 > b.p99_ms) bad.push({ law: 'budget', name, p99, p99_ms: b.p99_ms, n: xs.length });
  }
  return bad;
}

const now = () => (globalThis.performance?.now ? performance.now() : Date.now());

/** Time step() per action on states grown to `grow` actions by `gen` (the same generator laws.js and the fuzzer use).
 *  The reducer's budget is UI_DEFAULTS.reducer unless decl.budget[action].reducer_ms says otherwise. */
export function reducerBudget(decl, gen, { grow = 2000, growGen = gen, probes = 200, seed = 7, rng, rounds = 3 } = {}) {
  const r = rng || mulberry(seed);
  let s = decl.initial;
  // A throwing step is reported as the total law (the budget cannot be timed past it), never thrown out of the check.
  const threw = (t, p, e) => [{ law: 'total', name: t, detail: `reducerBudget: ${t} ${JSON.stringify(p)?.slice(0, 120)} threw: ${e?.message || e}` }];
  for (let i = 0; i < grow; i++) { const [t, p] = growGen(r, s); try { s = step(decl, s, t, p).state; } catch (e) { return threw(t, p, e); } }
  // Scheduling noise (a busy machine, a parallel test suite) only ever adds time; a real O(n) step costs the same in every
  // round. So the action is measured in up to `rounds` rounds and refused only when its p95 is over budget in every one
  // (the verdict reports the best round): a regression is still caught, contention no longer refuses a deploy.
  let bad = null;
  for (let round = 0; round < rounds; round++) {
    const times = new Map();
    for (let i = 0; i < probes; i++) {
      const [t, p] = gen(r, s);
      let out; const t0 = now();
      try { out = step(decl, s, t, p); } catch (e) { return threw(t, p, e); }
      const dt = now() - t0;
      if (!times.has(t)) times.set(t, []); times.get(t).push(dt);
      s = out.state;
    }
    const over = new Map();
    for (const [t, xs] of times) {
      const limit = decl.budget?.[t]?.reducer_ms ?? UI_DEFAULTS.reducer.p95_ms;
      const p95 = percentile(xs, 95);
      if (xs.length >= 5 && p95 > limit) over.set(t, { law: 'reducerBudget', name: t, p95, p95_ms: limit, n: xs.length });
    }
    if (!bad) bad = over;
    else for (const [t, v] of bad) { const w = over.get(t); if (!w) bad.delete(t); else if (w.p95 < v.p95) bad.set(t, w); }
    if (!bad.size) break;
  }
  return [...bad.values()];
}

export function mulberry(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), pick: (xs) => xs[Math.floor(next() * xs.length)], chance: (p) => next() < p };
}

export { uiContract };
