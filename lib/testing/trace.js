// Normalized-trace recorder and first-divergence comparator (pangea-ui-kit testing, GUIDE section 7).
//
// A DRIVER runs one scenario against one build. It is an object the app writes (or a factory returning
// one per run) with:
//   start()                    -> bring up a fresh instance from fixed fixture state
//   apply(step, rec)           -> perform one step; may return meta; may call rec.fact(name, value) and
//                                 rec.accept(key) to tell invariants what happened (rec.fault is the current
//                                 fault state the driver keeps)
//   settle()                   -> wait for quiescence; returns { settled: boolean, ... }
//   observe(tab?)              -> the visible state, any JSON
//   finale(rec)                -> clear every fault, wait for durability, return { tabs: [obs...], ...facts }
//   stop()
// record() runs the loop and returns the TRACE: { scenario, initial, steps: [{ step, meta, settle, obs }],
// finale, facts, accepted }. A NORMALIZER (defineNormalizer) says what of an observation is compared, which
// minted ids are canonicalized, and the explicit list of tolerated nondeterminism; nothing else is tolerated.

/** A canonicalizer replaces every match of `patterns` by $1, $2... in order of first appearance. */
export function canonicalizer(patterns = []) {
  const seen = new Map();
  const res = patterns.map((p) => new RegExp(p.source ?? p, `gu${String(p.flags ?? '').includes('i') ? 'i' : ''}`));
  const swap = (s) => {
    if (typeof s !== 'string') return s;
    let out = s;
    for (const re of res) out = out.replace(re, (m) => { if (!seen.has(m)) seen.set(m, `$${seen.size + 1}`); return seen.get(m); });
    return out;
  };
  const deep = (v) => (Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : swap(v));
  return deep;
}

/**
 * `project(obs, { loose })` returns the comparable part of an observation; `loose` is true at a step where
 * either side failed to settle, and the projection should drop what `tolerated` lists as unstable then.
 * `ids`: regexps for minted ids. `tolerated`: [{ id, what, how }], published in every result.
 */
export function defineNormalizer({ project = (obs) => obs, ids = [], tolerated = [] } = {}) {
  for (const t of tolerated) if (!t.id || !t.what || !t.how) throw new TypeError('defineNormalizer: each tolerated entry needs id, what, how');
  return Object.freeze({ project, ids, tolerated });
}

export function firstDifference(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const key of keys) {
      const d = firstDifference(a[key], b[key], `${path}${Array.isArray(a) ? `[${key}]` : `.${key}`}`);
      if (d) return d;
    }
  }
  return { path: path || '(root)', a, b };
}

const clip = (v) => { const s = JSON.stringify(v); return s && s.length > 600 ? `${s.slice(0, 600)}…` : v; };

/** The first diverging step between two traces of one scenario, or null. */
export function compareTraces(ta, tb, normalizer = defineNormalizer()) {
  const ca = canonicalizer(normalizer.ids); const cb = canonicalizer(normalizer.ids);
  const pairs = [['initial', ta.initial, tb.initial], ...ta.steps.map((s, i) => [i, s, tb.steps[i]])];
  for (const [index, sa, sb] of pairs) {
    if (!sa || !sb) return { step: index, op: sa?.step?.op ?? sb?.step?.op, field: '(step missing on one side)' };
    const loose = !(sa.settle?.settled && sb.settle?.settled);
    const d = firstDifference(ca(normalizer.project(sa.obs, { loose })), cb(normalizer.project(sb.obs, { loose })));
    if (d) return { step: index, op: index === 'initial' ? 'initial' : sa.step.op, loose, field: d.path, a: clip(d.a), b: clip(d.b) };
  }
  const fa = ca((ta.finale?.tabs || []).map((o) => normalizer.project(o, { loose: true })));
  const fb = cb((tb.finale?.tabs || []).map((o) => normalizer.project(o, { loose: true })));
  const d = firstDifference(fa, fb);
  if (d) return { step: 'finale', op: 'finale', field: d.path, a: clip(d.a), b: clip(d.b) };
  const da = firstDifference(ca(ta.finale?.durable ?? null), cb(tb.finale?.durable ?? null));
  if (da) return { step: 'finale', op: 'durable', field: `durable${da.path === '(root)' ? '' : da.path}`, a: clip(da.a), b: clip(da.b) };
  return null;
}

/** Run one scenario through one driver; returns the trace. */
export async function record({ scenario, driver, log = () => {} }) {
  const d = typeof driver === 'function' ? await driver(scenario) : driver;
  const trace = { scenario, initial: null, steps: [], finale: null, facts: {}, accepted: [], errors: [] };
  const rec = {
    fault: {},
    step: -1,
    fact(name, value) { (trace.facts[name] ||= []).push({ step: rec.step, value }); },
    accept(key, extra = {}) { trace.accepted.push({ key, step: rec.step, fault: { ...rec.fault }, ...extra }); },
    error(message) { trace.errors.push({ step: rec.step, message: String(message).slice(0, 300) }); }
  };
  await d.start(rec);
  try {
    trace.initial = { settle: await d.settle(rec), obs: await d.observe(rec) };
    for (const [i, step] of scenario.steps.entries()) {
      rec.step = i;
      const t0 = Date.now();
      let meta;
      try { meta = (await d.apply(step, rec)) || {}; } catch (error) { meta = { threw: String(error?.message || error).slice(0, 200) }; rec.error(`apply ${step.op}: ${meta.threw}`); }
      meta.fault = { ...rec.fault };
      const settle = await d.settle(rec);
      const obs = await d.observe(rec);
      trace.steps.push({ step, meta, settle, obs, tab: rec.tab ?? 0, ms: Date.now() - t0 });
      log(`  ${i + 1}/${scenario.steps.length} ${step.op}${meta.skipped ? ` (skipped: ${meta.skipped})` : ''} ${Date.now() - t0}ms${settle?.settled === false ? ' unsettled' : ''}`);
    }
    rec.step = 'finale';
    trace.finale = await d.finale(rec);
  } finally {
    await d.stop(rec);
  }
  return trace;
}

/**
 * The whole differential: for every seed, generate, record on A and on B, compare, check invariants on
 * both (B gates, A is the baseline), and shrink a divergence or a B violation to a minimal scenario.
 * `driverA` / `driverB`: driver factories (a fresh instance per run). Returns one row per seed.
 */
export async function differential({ vocabulary, generate, seeds, length = 16, driverA, driverB, normalizer, invariants = {}, check, shrinkBudget = 24, log = () => {}, onSeed = () => {} }) {
  const rows = [];
  for (const seed of seeds) {
    const scenario = generate(vocabulary, seed, { length });
    const t0 = Date.now();
    log(`seed ${seed}: A`);
    const ta = await record({ scenario, driver: driverA, log });
    log(`seed ${seed}: B`);
    const tb = await record({ scenario, driver: driverB, log });
    const divergence = compareTraces(ta, tb, normalizer);
    const violationsA = check(ta, invariants);
    const violationsB = check(tb, invariants);
    const row = { seed, steps: scenario.steps.length, ms: Date.now() - t0, divergence, violationsA, violationsB, scenario };
    if (divergence && shrinkBudget > 0) {
      log(`seed ${seed}: diverged at step ${divergence.step} (${divergence.field}); shrinking`);
      const { shrink } = await import('./scenario.js');
      const fails = async (steps) => {
        const s = { ...scenario, steps };
        const [a, b] = [await record({ scenario: s, driver: driverA }), await record({ scenario: s, driver: driverB })];
        return Boolean(compareTraces(a, b, normalizer));
      };
      const shrunk = await shrink(scenario.steps, fails, { budget: shrinkBudget });
      row.shrunk = { ...scenario, steps: shrunk.steps, shrinkRuns: shrunk.runs };
    }
    const failingB = Object.entries(violationsB).filter(([, v]) => v.length).map(([name]) => name);
    if (failingB.length && shrinkBudget > 0 && !row.shrunk) {
      const { shrink } = await import('./scenario.js');
      const fails = async (steps) => {
        const t = await record({ scenario: { ...scenario, steps }, driver: driverB });
        const v = check(t, invariants);
        return failingB.some((name) => v[name]?.length);
      };
      const shrunk = await shrink(scenario.steps, fails, { budget: shrinkBudget });
      row.shrunkViolation = { ...scenario, steps: shrunk.steps, shrinkRuns: shrunk.runs, invariants: failingB };
    }
    rows.push(row);
    onSeed(row, ta, tb);
  }
  return rows;
}
