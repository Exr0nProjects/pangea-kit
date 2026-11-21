// Multi-device convergence fuzz for row-store apps (kit lib/engine/rows.js stamps and mergeRow, lib/history.js undo).
// Moved up from zai2 (zai-pangea 2b0e0b2: test/fuzz.test.js and test/fuzz-sync.test.js), where it found three sync bugs
// (same-millisecond stamp ties, undo overwriting newer remote edits or reviving remote deletes, undo duplicating text).
//
// The app supplies a MODEL; the harness supplies devices, network, clock, ids, history, invariants and the shrinker.
//   model = {
//     name,
//     sortKey(row) -> [number|string, ...]   document order of live rows
//     live(row) -> bool                     a live (not tombstoned) row
//     seedRows() -> [{ id, set }]           the document every device starts from (one shared import)
//     edit(ctx) -> step | null              the op generator: one user action on device ctx.device (see ctx below);
//                                           step = { kind, target?, op?: { puts }, typing? } or { kind: 'undo'|'redo' }
//     region?(row, k) -> bool               rows device k owns in the disjoint mode (zai2: its zone)
//     shape?(row) -> any                    what "the region is back exactly" compares (default row.body)
//     text?(row) -> string                  where duplicated tokens are looked for (default row.body)
//     check?(liveRows) -> string | null     structural invariant (null: holds)
//     reset?(seed)                          per-run reset (zai2: its id counter)
//     cas?                                  lib/history.js options (tombstone, stamp, derived, carry)
//     history?(now) / inverse?(before, puts) overrides of the kit's createCasHistory / inverse (tests plant bugs here)
//   }
//   ctx (to edit) = { device, rows (live, ordered; only the device's region when disjoint), all (live, ordered),
//                     get(id), now(), rnd(), int(n), pick(array), token(), disjoint }
//   Every inserted text must carry ctx.token() (one unique CJK character): text that appears twice is a duplicate.
//
// Modes (each seed runs each; the seed derivations are zai2's, so its seed numbers replay):
//   concurrent  2-3 devices, 40 steps; each step one device acts, then messages due by now are delivered. Every op's
//               patches travel as one message (op-atomic, as one rows.put is one Stream entry), delayed 0-4 s, 15%
//               duplicated, reordered by delay; one device in three runs a clock skewed up to +-30 s. Checks: replicas
//               converge byte for byte (values and stamps), no created row is lost, undo/redo never revives a row another
//               device deleted, never makes a token appear twice except the counted per-row-merge limit (a concurrent
//               split's new row the device never saw), and model.check holds.
//   causal      one device acts at a time and everything is delivered between steps: no token ever appears twice.
//   undoAll     disjoint regions with remote noise elsewhere: undoing everything gives device 0's region back exactly and
//               redoing everything replays it.
// Deterministic: a seeded xorshift drives every choice, a virtual clock every stamp, and crypto.getRandomValues is
// seeded for the run (model ids). Each step's random draws are taped, so a failing run shrinks (ddmin over steps,
// each keeping its own draws) to a minimal step list that still fails, printed with the failure.
import { mergeRow, stampOf, stampHlc, stampWriter } from '../engine/rows.js';
import { createHlc } from '../engine/hlc.js';
import { createCasHistory, inverse as casInverse } from '../history.js';
import { viewRow, together } from '../engine/structure.js';
import { splitGroup } from '../engine/rows.js';

export const xorshift = (seed) => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };
const TOKEN = /[\u4e00-\u9fff]/gu;
export const MODES = ['concurrent', 'causal', 'undoAll'];
const SIM_SEED = { concurrent: (s) => s, causal: (s) => s * 31 + 7, undoAll: (s) => s * 7919 };
const STEPS = { concurrent: 40, causal: 40, undoAll: 30 };

/** Seed crypto.getRandomValues for the duration of fn (ids minted by the model replay with the seed). */
function withSeededCrypto(r, fn) {
  const c = globalThis.crypto, had = Object.prototype.hasOwnProperty.call(c, 'getRandomValues'), old = c.getRandomValues;
  Object.defineProperty(c, 'getRandomValues', { configurable: true, writable: true, value: (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(r() * 256); return a; } });
  try { return fn(); } finally { if (had) c.getRandomValues = old; else delete c.getRandomValues; }
}

const cmpKey = (x, y) => { for (let i = 0; i < Math.max(x.length, y.length); i++) { const a = x[i], b = y[i]; if (a === b) continue; if (typeof a === 'number' && typeof b === 'number') return a - b; return String(a) < String(b) ? -1 : 1; } return 0; };
const canon = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const strip = (m) => JSON.stringify([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canon(v)]));

class Fail extends Error {}

/** A random source that records each segment's draws (tape) or replays them (then falls back to a seeded stream). */
function tapeRng(master, replay) {
  let seg = null, tapes = [], k = 0, fallback = null;
  return {
    begin(i) { k = 0; if (replay) { seg = replay[i] || []; fallback = xorshift(0x9e3779b9 ^ (i + 1)); } else { seg = []; tapes[i] = seg; } },
    r: () => { if (!replay) { const x = master(); seg.push(x); return x; } return k < seg.length ? seg[k++] : fallback(); },
    get tapes() { return tapes; },
  };
}

/**
 * One simulation. `tape` (optional): { prelude, steps: [draws], finale } recorded by an earlier run; with it the run
 * replays those draws (steps may have been removed by the shrinker). Throws Fail on the first broken invariant.
 * Returns { tape, stats }.
 */
function simulate(model, mode, seed, { devices: nDev, steps: nSteps, tape = null, stats = { ops: 0, undoDups: 0, endDups: 0 }, out = {} } = {}) {
  const simSeed = SIM_SEED[mode](seed);
  const tr = tapeRng(xorshift(simSeed), tape && [tape.prelude, ...tape.steps, tape.finale]);
  out.tr = tr;
  const R = tr.r, int = (n) => Math.floor(R() * n), pick = (a) => a[int(a.length)];
  const cas = model.cas || {};
  const tomb = cas.tombstone || 'deleted_at';
  const sortKey = model.sortKey, isLive = model.live, textOf = model.text || ((r) => r.body || ''), shapeOf = model.shape || ((r) => r.body);
  const disjoint = mode === 'undoAll';
  const devices = nDev ?? 2 + (seed % 2);
  const steps = nSteps ?? STEPS[mode];
  const stepCount = tape ? tape.steps.length : steps;
  out.stepCount = stepCount;
  let tok = 0;
  const token = () => String.fromCodePoint(0x4e00 + (tok++ % 20000));
  const log = [], net = [], created = new Set();
  let clock = 1_700_000_000_000;
  model.reset?.(simSeed);
  tr.begin(0);
  const devs = Array.from({ length: devices }, (_, k) => {
    const skew = int(3) === 0 ? (R() - 0.5) * 60_000 : 0;
    const dev = { k, name: `d${k}`, rows: new Map(), skew, entryDups: new Map(), lastStep: null };
    dev.now = () => clock + dev.skew;
    // the kit's one order source (engine/hlc.js), as rows.js uses it; model.clock(now) plants another (tests)
    dev.hlc = (model.clock || ((now) => createHlc({ now })))(dev.now);
    dev.hist = model.history ? model.history(dev.now) : createCasHistory({ ...cas, now: dev.now });
    return dev;
  });
  const inv = model.inverse || ((before, puts, now) => casInverse(before, puts, { ...cas, now }));
  // model.structure ({ text }): the rows show their text through lib/engine/structure.js viewRow (split/join identity)
  const shown = (dev, r) => (model.structure && r ? viewRow(r, (id) => dev.rows.get(id), model.structure) : r);
  const live = (dev) => [...dev.rows.values()].filter(isLive).map((r) => shown(dev, r)).sort((a, b) => cmpKey(sortKey(a), sortKey(b)));
  const dupTokens = (rows) => { const seen = new Set(), dup = new Set(); for (const r of rows) for (const t of textOf(r).match(TOKEN) || []) { if (seen.has(t)) dup.add(t); seen.add(t); } return dup; };
  const ctxText = () => `${model.name || 'model'} ${mode} seed ${seed} (sim ${simSeed})\n${log.slice(-30).join('\n')}`;
  const fail = (msg) => { throw new Fail(`${ctxText()}\n${msg}`); };
  // the rows module's rule: every stamp a device sees is observed by its HLC, so a local stamp is later than the value it
  // overwrites and a local write wins
  const stamp = (dev) => { const t = dev.hlc.tick(); return stampOf(t.ts, dev.name, t.l); };
  const deliver = (dev, patch) => {
    dev.rows.set(patch.id, mergeRow(dev.rows.get(patch.id), patch));
    for (const s of Object.values(patch.at)) dev.hlc.observe(stampHlc(s));
  };
  const put = (dev, puts) => {
    const patches = [];
    // the store refuses a put that splits a field group (rows.js openRows({ together })), on every path: edits, undo, redo
    if (model.structure) for (const p of puts) { const why = splitGroup(p, together(model.structure)); if (why) fail(why); }
    for (const p of puts) {
      const s = stamp(dev), at = Object.fromEntries(Object.keys(p.set).map((f) => [f, s]));
      const patch = { id: p.id, set: p.set, at };
      if (!dev.rows.has(p.id)) created.add(p.id);
      deliver(dev, patch);
      for (const [f, v] of Object.entries(p.set)) if (dev.rows.get(p.id)[f] !== v) fail(`local write lost: ${p.id}.${f}`);
      patches.push(patch);
    }
    for (const o of devs) if (o !== dev) {
      const n = R() < 0.15 ? 2 : 1; // duplication
      for (let c = 0; c < n; c++) net.push({ to: o, at: clock + int(4) * 1000 + int(1000), patches });
    }
  };
  const flush = (upTo = Infinity) => { net.sort((a, b) => a.at - b.at); while (net.length && net[0].at <= upTo) { const m = net.shift(); for (const p of m.patches) deliver(m.to, p); } };
  const apply = (dev, op, typing = false) => {
    if (!op || !op.puts?.length) return;
    const dupsBefore = dupTokens(live(dev));
    const hop = dev.hist.record(inv((id) => { const r = dev.rows.get(id); return r && isLive(r) ? r : undefined; }, op.puts, dev.now), op.puts, { typing });
    put(dev, op.puts);
    const seen = dev.entryDups.get(hop);
    dev.entryDups.set(hop, { before: seen ? seen.before : dupsBefore, after: dupTokens(live(dev)), rows: seen ? seen.rows : new Set(live(dev).map((r) => r.id)), touched: new Set([...(seen ? seen.touched : []), ...op.puts.map((p) => p.id)]) });
  };
  const history = (dev, dir) => {
    const get = (id) => dev.rows.get(id);
    const h = dir < 0 ? dev.hist.undo(get) : dev.hist.redo(get);
    if (!h) return null;
    dev.lastStep = { op: h.op, dir };
    put(dev, h.puts);
    return h;
  };
  for (const p of model.seedRows()) { created.add(p.id); const patch = { id: p.id, set: p.set, at: Object.fromEntries(Object.keys(p.set).map((f) => [f, stampOf(1, 'seed', 1)])) }; for (const d of devs) deliver(d, patch); }

  const edit = (dev) => {
    const all = live(dev);
    const rows = disjoint ? all.filter((r) => model.region(r, dev.k)) : all;
    if (!rows.length) return null;
    const step = model.edit({ device: dev.k, rows, all, get: (id) => shown(dev, dev.rows.get(id)), now: dev.now, rnd: R, int, pick, token, disjoint });
    if (!step) return null;
    log.push(`${dev.name} ${step.kind}${step.target ? ` ${step.target}` : ''}`);
    if (step.kind === 'undo') history(dev, -1);
    else if (step.kind === 'redo') history(dev, 1);
    else apply(dev, step.op, Boolean(step.typing));
    return step.kind;
  };
  const converge = () => {
    const ref = strip(devs[0].rows);
    for (const d of devs) {
      if (strip(d.rows) !== ref) fail(`replica ${d.name} diverged from d0`);
      for (const id of created) if (!d.rows.has(id)) fail(`${d.name} lost ${id}`);
      const bad = model.check?.(live(d)); if (bad) fail(`${d.name}: ${bad}`);
    }
  };

  if (mode === 'concurrent') {
    for (let step = 0; step < stepCount; step++) {
      tr.begin(step + 1);
      const dev = devs[int(devs.length)];
      // a row another device deleted (as dev sees it now) stays deleted after dev's undo or redo
      const deletedByOthers = [...dev.rows.values()].filter((r) => r[tomb] && r._s?.[tomb] && stampWriter(r._s[tomb]) !== dev.name).map((r) => r.id);
      const dupsBefore = dupTokens(live(dev));
      dev.lastStep = null;
      const kind = edit(dev); stats.ops += 1;
      if (kind === 'undo' || kind === 'redo') {
        for (const id of deletedByOthers) if (isLive(dev.rows.get(id))) fail(`${kind} revived ${id}, deleted by another device`);
        if (dev.lastStep) {
          // A step may bring back only a duplicate the document held at the point it returns to (an undo restores the state
          // before its op, a redo the state after it). Anything else is a duplicate the step made, a failure (the old
          // per-row-merge allowance, a concurrent split's words restored beside their copy, is gone with split identity).
          const at = dev.entryDups.get(dev.lastStep.op);
          const allowed = at ? (dev.lastStep.dir < 0 ? at.before : at.after) : new Set();
          for (const t of dupTokens(live(dev))) {
            if (dupsBefore.has(t) || allowed.has(t)) continue;
            const holders = live(dev).filter((r) => textOf(r).includes(t)).map((r) => r.id);
            const others = holders.filter((id) => !at?.touched.has(id));
            if (at && others.length && others.every((id) => !at.rows.has(id))) stats.undoDups += 1;
            fail(`${kind} duplicated ${t} on ${dev.name} (rows ${holders.join(', ')})`);
          }
        }
      }
      clock += int(2500);
      flush(clock);
    }
    tr.begin(stepCount + 1);
    clock += 10_000; flush();
    // no duplicated word at rest, on any replica: split and join are single ops with identity (lib/engine/structure.js),
    // so a concurrent split, join or rewrite of one line cannot leave its words in two rows (census A29; this was a
    // counted known limit, 515 of 10,000 zai2 seeds, before 2026-11-09)
    // the failure names each holder's stored row too (text, mvseen, move records), which is what a split/join case needs
    const stored = (d, r) => { const raw = d.rows.get(r.id) || {}; const recs = Object.keys(raw).filter((k) => /^(mv|in):/.test(k)).map((k) => `${k}=${raw[k]}`); return recs.length ? ` [stored ${JSON.stringify(raw.body)} mvseen=${raw.mvseen ?? ''} ${recs.join(' ')}]` : ''; };
    for (const d of devs) { const dup = dupTokens(live(d)); if (dup.size) { stats.endDups += 1; fail(`${d.name} ends with ${[...dup].join('')} duplicated (rows ${live(d).filter((r) => [...dup].some((t) => textOf(r).includes(t))).map((r) => `${r.id}=${JSON.stringify(textOf(r))}${stored(d, r)}`).join(' ')})`); } }
    converge();
  } else if (mode === 'causal') {
    for (let step = 0; step < stepCount; step++) {
      tr.begin(step + 1);
      const dev = devs[int(devs.length)];
      edit(dev); stats.ops += 1;
      clock += 5000; flush();
      for (const d of devs) { const dup = dupTokens(live(d)); if (dup.size) fail(`duplicated ${[...dup]} on ${d.name}`); }
    }
    tr.begin(stepCount + 1);
    converge();
  } else if (mode === 'undoAll') {
    const target = devs[0];
    const regionOf = () => live(target).filter((r) => model.region(r, 0)).map(shapeOf);
    const start = JSON.stringify(regionOf());
    for (let step = 0; step < stepCount; step++) {
      tr.begin(step + 1);
      const dev = devs[int(devs.length)];
      edit(dev); stats.ops += 1;
      clock += 3000; // past the typing burst window, so every op is its own entry
      flush(clock);
    }
    tr.begin(stepCount + 1);
    const end = JSON.stringify(regionOf());
    let u = 0; while (history(target, -1)) { u += 1; clock += 10; flush(clock); }
    if (JSON.stringify(regionOf()) !== start) fail(`undo-all after ${u} undos: region is ${JSON.stringify(regionOf())}, was ${start}`);
    for (let k = 0; k < u; k++) { if (!history(target, 1)) fail(`redo ${k + 1} of ${u} returned nothing`); clock += 10; flush(clock); }
    if (JSON.stringify(regionOf()) !== end) fail(`redo-all: region is ${JSON.stringify(regionOf())}, was ${end}`);
    clock += 10_000; flush();
    converge();
  } else throw new Error(`convergence: unknown mode ${mode}`);
  const t = tr.tapes;
  return { tape: tape || { prelude: t[0], steps: t.slice(1, stepCount + 1), finale: t[stepCount + 1] || [] }, stats };
}

/** Run one seed in one mode: null when every invariant holds, else { seed, mode, error, minimal? } (minimal: the
 *  shrunk step list's size, the error it still raises, and its tape, which replay() runs again). */
export function fuzzSeed(model, mode, seed, { devices, steps, shrink = true, budget = 300 } = {}) {
  const idSeed = (SIM_SEED[mode](seed) ^ 0x5bd1e995) >>> 0;
  const out = {};
  try { withSeededCrypto(xorshift(idSeed), () => simulate(model, mode, seed, { devices, steps, out })); return null; } catch (e) {
    if (!(e instanceof Fail)) throw e;
    const res = { seed, mode, error: e.message };
    if (!shrink) return res;
    // the failing run's tape (a throw ends a segment early; its draws so far are all it used), then ddmin its steps
    const t = out.tr.tapes, n = out.stepCount, recorded = { prelude: t[0] || [], steps: t.slice(1, n + 1).filter(Boolean), finale: t[n + 1] || [] };
    const fails = (list) => replay(model, mode, seed, { ...recorded, steps: list }, { devices, steps });
    let cur = recorded.steps, gran = 2, runs = 0;
    while (cur.length >= 2 && runs < budget) {
      const size = Math.ceil(cur.length / gran); let reduced = false;
      for (let at = 0; at < cur.length && runs < budget; at += size) {
        const cand = [...cur.slice(0, at), ...cur.slice(at + size)]; if (!cand.length) continue;
        runs += 1; if (fails(cand)) { cur = cand; gran = Math.max(gran - 1, 2); reduced = true; break; }
      }
      if (!reduced) { if (gran >= cur.length) break; gran = Math.min(cur.length, gran * 2); }
    }
    res.minimal = { steps: cur.length, of: recorded.steps.length, runs, error: fails(cur), tape: { ...recorded, steps: cur } };
    return res;
  }
}

/** Replay a tape (from fuzzSeed's minimal): the error message it raises, or null when every invariant holds. */
export function replay(model, mode, seed, tape, { devices, steps } = {}) {
  const idSeed = (SIM_SEED[mode](seed) ^ 0x5bd1e995) >>> 0;
  try { withSeededCrypto(xorshift(idSeed), () => simulate(model, mode, seed, { devices, steps, tape })); return null; } catch (x) { if (x instanceof Fail) return x.message; throw x; }
}

/** Run every seed in every mode. Returns { ok, seeds, ops, undoDups, endDups, failures, ms }; stops after maxFailures. */
export function runConvergenceFuzz(model, { seeds = 1000, from = 1, modes = MODES, devices, steps, shrink = true, maxFailures = 3 } = {}) {
  const t0 = Date.now(), failures = [], stats = { ops: 0, undoDups: 0, endDups: 0 };
  for (const mode of modes) for (let seed = from; seed < from + seeds && failures.length < maxFailures; seed++) {
    const idSeed = (SIM_SEED[mode](seed) ^ 0x5bd1e995) >>> 0;
    try { withSeededCrypto(xorshift(idSeed), () => simulate(model, mode, seed, { devices, steps, stats })); } catch (e) {
      if (!(e instanceof Fail)) throw e;
      failures.push(fuzzSeed(model, mode, seed, { devices, steps, shrink }));
    }
  }
  return { ok: !failures.length, seeds, modes, ...stats, failures, ms: Date.now() - t0 };
}

/** A failure as text: the error and, when shrunk, the minimal step count. */
export const formatFailure = (f) => `${f.error}${f.minimal ? `\nshrunk to ${f.minimal.steps} of ${f.minimal.of} steps (${f.minimal.runs} runs): ${f.minimal.error?.split('\n').pop()}` : ''}`;
