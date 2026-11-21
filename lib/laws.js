// Generated tests for a state component (Pangea's platform.generate_tests, kit form): the contract every component in
// lib/components.js (and any an app writes in that shape) must keep, checked over seeded random gesture sequences.
//   checkLaws(comp, gen, { seeds, length }) -> [] when every law holds, else [{ law, seed, steps, detail }] with the
//   shortest failing prefix. gen(rng, state, { junk: true }) -> [gestureOrAction, payload] (conformance/gens.js shape).
// Laws:
//   total       an action never throws, on any payload (a replayed log from another build cannot wedge a replica)
//   pure        an action never mutates its state or payload (both are deep-frozen)
//   noop-ref    a result equal to the input IS the input (so nothing is logged, saved or pushed)
//   idempotent  conflict 'lww': applying the same action again returns the same reference
//   dedupe      conflict 'log': redelivering the same action again returns the same reference
//   json        the state survives a JSON round trip unchanged (it is persisted and synced as JSON)
//   lifecycle   with states: the state field is always declared, every change follows a declared edge, terminal is final
//   gestures    a gesture resolves to null or to a declared action
import { canonical } from './canonical.js';
import { declareComponent, resolve } from './components.js';
import { declare, step } from './model.js';

const freeze = (v) => { if (v && typeof v === 'object') { Object.freeze(v); for (const k of Object.keys(v)) freeze(v[k]); } return v; };
const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function rng(seed) { let a = seed >>> 0; const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), pick: (xs) => xs[Math.floor(next() * xs.length)], chance: (p) => next() < p }; }

function run(comp, decl, steps) {
  let s = freeze(copy(comp.initial));
  for (let i = 0; i < steps.length; i++) {
    const [name, payload] = steps[i];
    const fail = (law, detail) => ({ law, at: i, detail });
    let r;
    try { r = resolve(comp, s, name, payload); } catch (e) { return fail('gestures', e.message); }
    if (!r) continue;
    if (!comp.actions[r[0]]) return fail('gestures', `${name} resolved to undeclared ${r[0]}`);
    const p = freeze(copy(r[1]));
    let out;
    try { out = step(decl, s, r[0], p); } catch (e) { return fail(/frozen|read only|not extensible|Cannot (assign|add|delete)/.test(e.message) ? 'pure' : 'total', e.message); }
    const next = out.state;
    if (next !== s && canonical(next) === canonical(s)) return fail('noop-ref', `${r[0]} returned an equal copy`);
    if (canonical(copy(next)) !== canonical(next) || JSON.stringify(copy(next)) !== JSON.stringify(next)) return fail('json', 'state does not survive JSON');
    if (decl.states) {
      const f = decl.stateField;
      if (!decl.states.includes(next[f])) return fail('lifecycle', `undeclared state ${next[f]}`);
      if (next[f] !== s[f] && ((decl.terminal || []).includes(s[f]) || !decl.transitions[s[f]].includes(next[f]))) return fail('lifecycle', `${s[f]} -> ${next[f]}`);
    }
    if (!out.error) {
      const again = step(decl, freeze(next), r[0], freeze(copy(r[1]))).state;
      if (again !== next) return fail(comp.conflict === 'log' ? 'dedupe' : 'idempotent', `${r[0]} ${canonical(r[1])} changed the state again`);
    }
    s = freeze(next);
  }
  return null;
}

export function checkLaws(comp, gen, { seeds = 200, length = 40 } = {}) {
  const decl = declare(declareComponent(`$laws:${comp.kind || 'c'}`, comp, { scope: 'ephemeral' }));
  return lawsOver(comp, decl, gen, { seeds, length });
}

/** The same laws over a declaration (validate() runs this for every declare()): the declaration's own step, normalize
 *  and lifecycle. Returns { failures, coverage }: coverage[action] counts steps of that action that changed the state
 *  without a refusal (an action that never changed anything was never exercised, however many seeds ran). */
export function checkDeclLaws(decl, gen, { seeds = 60, length = 30 } = {}) {
  const comp = { kind: decl.name, initial: decl.initial, actions: decl.actions, conflict: decl.conflict };
  const coverage = Object.fromEntries(Object.keys(decl.actions).map((a) => [a, 0]));
  const failures = lawsOver(comp, decl, gen, { seeds, length, coverage });
  return { failures, coverage, cases: seeds * length };
}

function lawsOver(comp, decl, gen, { seeds, length, coverage = null }) {
  const bad = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const r = rng(seed);
    let s = comp.initial;
    const steps = [];
    for (let i = 0; i < length; i++) {
      const st = gen(r, s, { junk: true });
      steps.push(st);
      try {
        const res = resolve(comp, s, st[0], st[1]);
        if (res) { const out = step(decl, s, res[0], res[1]); if (coverage && !out.error && out.state !== s) coverage[res[0]] = (coverage[res[0]] || 0) + 1; s = out.state; }
      } catch { break; }
    }
    const f = run(comp, decl, steps);
    if (f) { bad.push({ ...f, seed, steps: steps.slice(0, f.at + 1) }); if (bad.length >= 3) break; }
  }
  return bad;
}
export * as ui from './laws-ui/index.js'; // UI laws (GUIDE 3e): budgets, first paint, motion, no loss, convergence, fuzz
