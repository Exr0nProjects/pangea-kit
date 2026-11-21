// Model-check laws over action traces. Two kinds:
//  1. Kit-level: run against any declaration with the kit's real replica (createReplica), a memory Storage and the
//     in-memory Stream server. An app gets them by declaring state; the generator is the same `gen(rng, state)` the
//     component laws (lib/laws.js) and the fuzzer use.
//       reloadRestores  a fresh replica on the same storage shows the persisted projection of the old one
//       firstPaint      that fresh replica's first subscribed value is its final value: nothing changes without input
//       noLoss          owner actions survive a crash at any point (durable: without a flush; else after pagehide flush)
//       idempotentRetry a push whose ack was lost and is retried, and a pull page delivered twice, change nothing
//       tabsConverge    two devices, any interleaving of dispatch/sync/offline, end equal after both sync
//  2. App-level trace checks, for engines the kit does not own (webchat's session, outbox, replica):
//       checkNoLossTrace, checkLiveness, checkBoundedWork
// Each returns [] or a list of { law, seed?, steps?, detail }.
import { canonical } from '../canonical.js';
import { createReplica } from '../model.js';
import { createMemoryStreamServer } from '../stream-fake.js';
import { mulberry } from './budget.js';

export function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; }, _m: m };
}
// Numbers compare at 12 significant digits: a layout fraction renormalized on load (0.5925925925925927 vs ...926) is the
// same pixel; a real drift (a width halving per reload) is not hidden by that.
const round = (v) => (typeof v === 'number' ? Number(v.toPrecision(12)) : Array.isArray(v) ? v.map(round) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v);
const project = (decl, s) => canonical(round(decl.persist ? decl.persist(s) : s));
const sync = (f) => f();
const open = (decl, storage, device = 'd1', transport = null, now) => createReplica(decl, { storage, device, schedule: sync, transport, ...(now ? { now } : {}) });

function walk(decl, gen, seeds, length, body) {
  const bad = [];
  for (let seed = 1; seed <= seeds && bad.length < 3; seed++) {
    const r = mulberry(seed); const steps = [];
    // A reducer that throws is a total-law failure of this seed (with the steps that reach it), not an exception that
    // aborts every other UI law for the declaration with no seed to replay.
    let fail;
    try { fail = body(r, steps); } catch (e) { fail = { law: 'total', detail: `step ${steps.length} (${steps.at(-1)?.[0]}) threw: ${e?.message || e}` }; }
    if (fail) bad.push({ ...fail, seed, steps: steps.slice() });
  }
  return bad;
}

export function checkReloadRestores(decl, gen, { seeds = 60, length = 30 } = {}) {
  if (decl.scope === 'ephemeral') return [];
  return walk(decl, gen, seeds, length, (r, steps) => {
    const st = memStorage(); let A = open(decl, st);
    for (let i = 0; i < length; i++) {
      const [t, p] = gen(r, A.get()); steps.push([t, p]); A.dispatch(t, p);
      if (r.chance(0.25)) {
        A.flush(); const B = open(decl, st);
        if (project(decl, B.get()) !== project(decl, A.get())) return { law: 'reloadRestores', detail: `after ${steps.length} steps the reload shows ${project(decl, B.get()).slice(0, 160)}, before ${project(decl, A.get()).slice(0, 160)}` };
        A = B;
      }
    }
    return null;
  });
}

export function checkFirstPaint(decl, gen, { seeds = 40, length = 20 } = {}) {
  if (decl.scope === 'ephemeral') return [];
  return walk(decl, gen, seeds, length, (r, steps) => {
    const st = memStorage(); const A = open(decl, st);
    for (let i = 0; i < length; i++) { const [t, p] = gen(r, A.get()); steps.push([t, p]); A.dispatch(t, p); }
    A.flush();
    const B = open(decl, st); const seen = [];
    B.subscribe((v) => seen.push(canonical(v)));
    B.flush(); // anything the boot would do later (adopt, repair, legacy import) happens now, before any input
    const after = canonical(B.get());
    if (seen.length !== 1 || seen[0] !== after) return { law: 'firstPaint', detail: `first value ${seen[0]?.slice(0, 120)} then ${after.slice(0, 120)} with no input` };
    return null;
  });
}

export function checkNoLoss(decl, gen, { seeds = 60, length = 30, owner = decl.owner || Object.keys(decl.actions) } = {}) {
  if (decl.scope === 'ephemeral') return [];
  return walk(decl, gen, seeds, length, (r, steps) => {
    const st = memStorage(); let A = open(decl, st);
    for (let i = 0; i < length; i++) {
      const [t, p] = gen(r, A.get()); steps.push([t, p]); A.dispatch(t, p);
      if (owner.includes(t) && r.chance(0.3)) {
        const want = project(decl, A.get());
        if (!decl.durable) A.flush(); // pagehide: the kit flushes; a durable state must not need it
        A = open(decl, st);
        if (project(decl, A.get()) !== want) return { law: 'noLoss', detail: `crash after owner action ${t} lost state` };
      }
    }
    return null;
  });
}

/** A transport that loses acks (the push landed, the client saw an error) and redelivers pull pages. */
export function flakyTransport(server, r, { lostAck = 0.3, redeliver = 0.3 } = {}) {
  const last = new Map();
  return {
    async push(stream, rows) { await server.push(stream, rows); if (r.chance(lostAck)) throw new Error('ack lost'); },
    async pull(stream, cursor) {
      if (last.has(stream) && r.chance(redeliver)) { const page = last.get(stream); last.delete(stream); return { ...page, cursor }; }
      const page = await server.pull(stream, cursor); last.set(stream, page); return page;
    },
  };
}

// "after both sync": rounds until two quiet rounds in a row. A round is quiet when every replica started it with nothing
// pending, every sync succeeded, no replica's log grew and the server stored nothing new. A fixed four rounds was a false
// divergence: a lost ack throws before the pull (four in a row: 0.3^4 per seed), a push moves pending into the log without
// growing it, and a redelivered pull page (flakyTransport) carries its old `more`, so a successful sync can stop short. A
// transport never redelivers twice in a row, so two quiet rounds hold a real pull per replica after the last write landed.
// Bounded at 64 rounds; replicas that still differ then are reported as the divergence they are.
async function settle(reps, stored = () => 0) {
  let quiet = 0;
  for (let k = 0; k < 64 && quiet < 2; k++) {
    let ok = 0;
    const before = reps.map((x) => x.log.length), idle = reps.every((x) => !x.pending.length), n0 = stored();
    for (const x of reps) { try { await x.sync(); ok += 1; } catch { /* retried next round */ } }
    quiet = idle && ok === reps.length && n0 === stored() && reps.every((x, i) => x.log.length === before[i]) ? quiet + 1 : 0;
  }
}

export async function checkIdempotentRetryAndConverge(decl, gen, { seeds = 40, length = 24, devices = 2 } = {}) {
  if (decl.scope !== 'cloud') return [];
  const bad = [];
  for (let seed = 1; seed <= seeds && bad.length < 3; seed++) {
    const r = mulberry(seed); const server = createMemoryStreamServer({ pageSize: 3 }); const steps = [];
    let clock = 1000;
    const reps = Array.from({ length: devices }, (_, i) => open(decl, memStorage(), `d${i + 1}`, flakyTransport(server, r), () => (clock += r.int(0, 3))));
    for (let i = 0; i < length; i++) {
      const k = r.int(0, devices - 1);
      if (r.chance(0.7)) { const [t, p] = gen(r, reps[k].get()); steps.push([k, t, p]); reps[k].dispatch(t, p); }
      else { steps.push([k, 'sync']); try { await reps[k].sync(); } catch { /* the transport failed; retried */ } }
    }
    await settle(reps, () => server.streams.get(decl.name)?.rows?.length ?? 0);
    const views = reps.map((x) => canonical(x.get()));
    if (new Set(views).size !== 1) { bad.push({ law: 'tabsConverge', seed, steps, detail: `devices disagree: ${views.map((v) => v.slice(0, 80)).join(' | ')}` }); continue; }
    const rows = server.streams.get(decl.name)?.rows || [];
    const ids = rows.map((x) => x.entry_id);
    if (new Set(ids).size !== ids.length) bad.push({ law: 'idempotentRetry', seed, steps, detail: 'an entry was stored twice' });
  }
  return bad;
}

// ---- app-level trace checks ----

/** dispatched: ids of owner actions the app accepted; survived: ids visible anywhere after the trace (confirmed rows, the
 *  outbox, a visible rejection with its text). Every dispatched id must survive. */
export function checkNoLossTrace(dispatched, survived) {
  const s = new Set(survived);
  const lost = [...dispatched].filter((id) => !s.has(id));
  return lost.length ? [{ law: 'noLoss', detail: `lost ${lost.length}: ${lost.slice(0, 5).join(', ')}` }] : [];
}

/** samples: [{ t, pending, armed, inflight: [{ since }] }] over time. Whenever work is pending, either a retry is armed
 *  or a request younger than its deadline is in flight. A hung request with nothing armed is a stuck tab. */
export function checkLiveness(samples, { deadline_ms = 15000 } = {}) {
  for (const x of samples) {
    if (!x.pending) continue;
    const live = (x.inflight || []).some((f) => x.t - f.since <= deadline_ms);
    if (!x.armed && !live) return [{ law: 'liveness', detail: `at t=${x.t} ${x.pending} pending, nothing armed, oldest request ${x.inflight?.length ? x.t - Math.min(...x.inflight.map((f) => f.since)) : 'none'} ms old` }];
  }
  return [];
}

/** work: [{ event, units }]: background work units (scans, full reads, re-renders) started per input event. */
export function checkBoundedWork(work, { perEvent = 1, total = Infinity } = {}) {
  const sum = work.reduce((a, w) => a + w.units, 0);
  const worst = work.reduce((a, w) => Math.max(a, w.units), 0);
  const bad = [];
  if (worst > perEvent) bad.push({ law: 'boundedWork', detail: `${worst} units for one event, bound ${perEvent}` });
  if (sum > total) bad.push({ law: 'boundedWork', detail: `${sum} units for ${work.length} events, bound ${total}` });
  return bad;
}
