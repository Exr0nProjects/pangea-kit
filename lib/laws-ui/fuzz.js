// Coverage-guided fuzz driver for reducers, engines and UI controls. A sequence is a list of steps (whatever `exec`
// understands: [action, payload] for a declaration, ['click', control] for a UI driver). The driver keeps a corpus of
// sequences that reached something new and mutates them (append fresh steps, delete a range, duplicate a step as a
// redelivery, swap neighbours, splice two sequences), seeded from past incident reproductions so the search starts
// where bugs were. "Something new" is either:
//   coverage: 'v8'    block ranges with a nonzero count in scripts whose URL matches `filter`, read from V8 precise
//                     coverage through node:inspector (the reducer-branch metric; node only)
//   coverage: 'state' abstract features: the canonical shape of the state (keys and value types) and each
//                     (previous step kind -> step kind) transition (the event-type interleaving metric; runs anywhere)
// A failure is shrunk (drop steps while it still fails) and returned with its sequence.
//   const r = await fuzz({ exec, fresh, seeds: [incidentSteps], runs: 2000, coverage: 'state' })
//   exec(steps) -> { fail: null | string, state, kinds: [...] };  fresh(rng, state) -> one step
import { canonical } from '../canonical.js';
import { mulberry } from './budget.js';

const shape = (v) => (v === null || typeof v !== 'object' ? typeof v : Array.isArray(v) ? `[${v.length ? shape(v[0]) : ''}]` : `{${Object.keys(v).sort().map((k) => `${k}:${shape(v[k])}`).join(',')}}`);

async function v8Probe(filter) {
  let inspector;
  try { inspector = await import('node:inspector'); } catch { return null; }
  const session = new inspector.Session(); session.connect();
  const post = (m, p = {}) => new Promise((ok, no) => session.post(m, p, (e, r) => (e ? no(e) : ok(r))));
  await post('Profiler.enable');
  await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  return {
    async take() {
      const { result } = await post('Profiler.takePreciseCoverage'); // also resets the counters
      const out = new Set();
      for (const s of result) {
        if (!filter.test(s.url)) continue;
        for (const f of s.functions) for (const r of f.ranges) if (r.count > 0) out.add(`${s.url}:${r.startOffset}:${r.endOffset}`);
      }
      return out;
    },
    async close() { try { await post('Profiler.stopPreciseCoverage'); } catch { /* closed */ } session.disconnect(); },
  };
}

function stateFeatures(res) {
  const out = new Set([`shape:${shape(res.state)}`]);
  const k = res.kinds || [];
  for (let i = 0; i < k.length; i++) out.add(`kind:${k[i]}`);
  for (let i = 1; i < k.length; i++) out.add(`pair:${k[i - 1]}>${k[i]}`);
  return out;
}

function mutate(r, corpus, fresh, exec) {
  const base = r.pick(corpus).slice();
  const op = r.int(0, 4);
  if (op === 0 || base.length === 0) { let s = base.length ? exec(base).state : undefined; const n = r.int(1, 4); for (let i = 0; i < n; i++) { const st = fresh(r, s); base.push(st); } return base; }
  if (op === 1) { const i = r.int(0, base.length - 1); base.splice(i, r.int(1, Math.min(3, base.length - i))); return base; }
  if (op === 2) { const i = r.int(0, base.length - 1); base.splice(r.int(i, base.length), 0, base[i]); return base; } // redelivery
  if (op === 3 && base.length > 1) { const i = r.int(0, base.length - 2); [base[i], base[i + 1]] = [base[i + 1], base[i]]; return base; }
  const other = r.pick(corpus); return [...base.slice(0, r.int(0, base.length)), ...other.slice(r.int(0, other.length))];
}

function shrink(steps, exec) {
  let cur = steps;
  for (let chunk = Math.ceil(cur.length / 2); chunk >= 1; chunk = Math.floor(chunk / 2)) {
    for (let i = 0; i < cur.length;) {
      const cand = [...cur.slice(0, i), ...cur.slice(i + chunk)];
      if (cand.length && exec(cand).fail) cur = cand; else i += chunk;
    }
  }
  return cur;
}

export async function fuzz({ exec, fresh, seeds = [[]], runs = 1000, seed = 1, coverage = 'state', filter = /./, maxLen = 60 }) {
  const r = mulberry(seed);
  const probe = coverage === 'v8' ? await v8Probe(filter) : null;
  const features = new Set();
  const corpus = [];
  const failures = [];
  const measure = async (res) => {
    const f = stateFeatures(res);
    if (probe) for (const x of await probe.take()) f.add(x);
    let fresh_ = 0; for (const x of f) if (!features.has(x)) { features.add(x); fresh_++; }
    return fresh_;
  };
  try {
    for (const s of seeds) { if (probe) await probe.take(); const res = exec(s); if (res.fail) failures.push({ steps: shrink(s, exec), detail: res.fail, from: 'seed' }); await measure(res); corpus.push(s); }
    for (let i = 0; i < runs && failures.length < 3; i++) {
      let cand = mutate(r, corpus, fresh, exec);
      if (cand.length > maxLen) cand = cand.slice(0, maxLen);
      if (probe) await probe.take(); // drop counts from the mutation's own replays
      const res = exec(cand);
      if (res.fail) { failures.push({ steps: shrink(cand, exec), detail: res.fail, run: i }); continue; }
      if (await measure(res)) corpus.push(cand);
    }
  } finally { if (probe) await probe.close(); }
  return { features: features.size, corpus: corpus.length, failures };
}

/** exec for a kit declaration: replays steps through step(), checks `law(prev, next, step)` after each one. */
export function declExec(decl, stepFn, law = () => null) {
  return (steps) => {
    let s = decl.initial; const kinds = [];
    for (const st of steps) {
      const [t, p] = st; kinds.push(t);
      let out;
      try { out = stepFn(decl, s, t, p); } catch (e) { return { fail: `throws on ${t}: ${e.message}`, state: s, kinds }; }
      const why = law(s, out.state, st);
      if (why) return { fail: why, state: out.state, kinds };
      s = out.state;
    }
    return { fail: null, state: s, kinds, key: canonical(s) };
  };
}
