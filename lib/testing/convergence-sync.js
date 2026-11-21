// Sync-level convergence fuzz: the same app model as convergence.js, but every device is the real rows module
// (lib/engine/rows.js openRows over IndexedDB) talking to the in-memory Pangea stream (lib/stream-fake.js), with syncs,
// outages (503, network gone), lost acks and killed tabs. Moved up from zai2 (zai-pangea 2b0e0b2 test/fuzz-sync.test.js),
// which found the same-millisecond stamp tie (a reopened tab's edit lost to the old tab's value; fixed in rows.js).
//
// Deterministic replay: a seed expands to an explicit action list (faults and clock ticks are actions too; each edit
// carries the draws its model.edit uses), and the run is a pure function of that list given fake timers (`timers`:
// { install(nowMs), advance(ms) -> Promise, uninstall() }; vitest: vi.useFakeTimers / vi.advanceTimersByTimeAsync) and
// the seeded crypto.getRandomValues the harness installs. A failing list shrinks (ddmin) to a minimal one.
//   const input = syncActions(seed)                 { devices, actions }
//   const err = await runSync(model, input, env)    null, or the first broken invariant
//   const min = await shrinkSync(model, input, env)
// env = { IDBFactory (fake-indexeddb), timers, name? }. Invariants: pending drains on every device, every device and a
// fresh reader hold the same live document, every created row exists everywhere, the stream holds each (device, seq) once.
// model.refill (lib/editor/refill.js, the zone refill sentinel): after every step of a device, and after every sync, the
// editor's rule runs on that device (one sentinel per zone with no live row, which writes its blank rows or nothing); the
// recovery rounds run it too. Extra invariants: after convergence no zone is empty on any device, a pad is never written
// over a row this device had seen (no resurrection, no overwrite), every application finds its zone empty and writes exactly
// the declared count (never stacks), and the blank pads a zone holds never exceed what its applications wrote (undo of a
// delete may bring older pads back, so the pads at rest are bounded by applications, not by devices).
import { openRows } from '../engine/rows.js';
import { createMemoryStreamServer } from '../stream-fake.js';
import { createCasHistory, inverse as casInverse } from '../history.js';
import { xorshift } from './convergence.js';
import { emptyZones, refillPuts, isPadRow } from '../editor/refill.js';

const KINDS = ['edit', 'edit', 'edit', 'edit', 'edit', 'undo', 'redo', 'sync', 'sync', 'kill', 'tick', 'tick', 'fault'];
const FAULTS = ['push-503', 'push-lost-ack', 'pull-503', 'gone'];
const TAPE = 12; // draws an edit may use (more fall back to a per-action stream)

/** A seed's action list. Every random choice is made here, none at run time. */
export function syncActions(seed, n = 25, { extra = [] } = {}) {
  const R = xorshift(seed), int = (k) => Math.floor(R() * k), pick = (a) => a[int(a.length)];
  const kinds = [...KINDS, ...extra]; // extra: action kinds a model opts into ('wipe': model.wipe empties a zone); none leaves every seed's draws as they were
  const devices = 2 + (seed % 2), actions = [];
  for (let k = 0; k < n; k++) actions.push({ d: int(devices), a: pick(kinds), ms: pick([0, 50, 400, 600, 1200, 5000]), f: pick(FAULTS), u: Array.from({ length: TAPE }, R) });
  return { devices, actions };
}

const cmpKey = (x, y) => { for (let i = 0; i < Math.max(x.length, y.length); i++) { const a = x[i], b = y[i]; if (a === b) continue; if (typeof a === 'number' && typeof b === 'number') return a - b; return String(a) < String(b) ? -1 : 1; } return 0; };

/** Run an action list; returns null when every invariant holds, else a description of the first that broke. */
export async function runSync(model, { devices, actions }, { IDBFactory, timers, name = `qk-sync-fuzz-${model.name || 'model'}` } = {}) {
  if (!IDBFactory || !timers) throw new Error('runSync: env.IDBFactory and env.timers are required');
  const cas = model.cas || {};
  const shape = model.shape || ((r) => r.body);
  const text = (rows) => rows.filter(model.live).sort((a, b) => cmpKey(model.sortKey(a), model.sortKey(b))).map(shape);
  let rs = xorshift(12345);
  const c = globalThis.crypto, had = Object.prototype.hasOwnProperty.call(c, 'getRandomValues'), oldRv = c.getRandomValues;
  Object.defineProperty(c, 'getRandomValues', { configurable: true, writable: true, value: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(rs() * 256); return arr; } });
  timers.install(Date.UTC(2026, 10, 8, 12));
  model.reset?.(0);
  const server = createMemoryStreamServer();
  const transportFor = () => {
    const t = { dead: false, faults: [],
      async push(st, rows) { if (t.dead) throw new Error('dead'); const f = t.faults.shift(); if (f === 'push-503') throw Object.assign(new Error('503'), { status: 503 }); if (f === 'gone') throw new TypeError('Failed to fetch'); await server.push(st, rows); if (f === 'push-lost-ack') throw Object.assign(new Error('lost ack'), { status: 502 }); },
      async pull(st, cur) { if (t.dead) throw new Error('dead'); if (t.faults[0] === 'pull-503') { t.faults.shift(); throw Object.assign(new Error('503'), { status: 503 }); } return server.pull(st, cur); } };
    return t;
  };
  const open = (idb, transport) => openRows({ name, indexedDB: idb, transport, sortKey: model.sortKey, live: model.live, Broadcast: null, onError: () => {} });
  const mk = async (idb) => { const t = transportFor(); const doc = await open(idb, t); await doc.load({ from: null }); return { idb, t, doc, hist: createCasHistory({ ...cas, now: () => Date.now() }) }; };
  const devs = [];
  let tok = 0;
  const spec = model.refill || null;
  let refilled = 0, created; const wrote = new Map(); // zone -> rows its applications wrote
  // the editor's trigger on one device: the sentinel for each zone with no live row, applied to the state it meets
  // (like the app: a device that has never completed a sync and holds no rows does not refill yet: its zones are empty only
  // because the cloud's rows have not arrived)
  const refill = (d) => {
    if (!spec || !d.ready) return;
    const lines = d.doc.view.rows();
    for (const zone of emptyZones(lines, spec, true)) {
      const puts = refillPuts(lines, d.doc.peek, spec, zone, Date.now());
      if (puts.length !== (spec.count ?? 2)) throw new Error(`a refill of the empty zone ${zone} wrote ${puts.length} rows`);
      for (const p of puts) { if (d.doc.peek(p.id)) throw new Error(`refill rewrote a row this device had seen: ${p.id}`); created.add(p.id); }
      d.doc.put(puts); refilled += 1; wrote.set(zone, (wrote.get(zone) ?? 0) + puts.length);
    }
  };
  const token = () => String.fromCodePoint(0x4e00 + (tok++ % 20000));
  try {
    for (let k = 0; k < devices; k++) devs.push(await mk(new IDBFactory()));
    devs[0].doc.put(model.seedRows()); devs[0].ready = true;
    if (spec) await devs[0].doc.sync(); // a refilling app's document already lives in the cloud when a second device opens it (see `refill` above)
    created = new Set(model.seedRows().map((p) => p.id));
    for (const act of actions) {
      const k = act.d % devs.length, d = devs[k];
      if (act.a === 'tick') { await timers.advance(act.ms); continue; }
      if (act.a === 'fault') { d.t.faults.push(act.f); continue; }
      if (act.a === 'sync') { const ok = await d.doc.sync().then(() => true, () => false); if (ok) d.ready = true; refill(d); continue; }
      // a kill: the transport dies at once, what the tab committed to IndexedDB stays, the tab runs nothing more
      if (act.a === 'kill') { d.t.dead = true; await d.doc.close().catch(() => {}); devs[k] = await mk(d.idb); devs[k].ready = d.ready; refill(devs[k]); continue; }
      const step = (dir) => { const h = dir < 0 ? d.hist.undo(d.doc.peek) : d.hist.redo(d.doc.peek); if (h?.puts.length) d.doc.put(h.puts); };
      if (act.a === 'undo') { step(-1); refill(d); continue; }
      if (act.a === 'redo') { step(1); refill(d); continue; }
      const rows = d.doc.view.rows();
      if (!rows.length) continue;
      if (act.a === 'wipe' && !model.wipe) continue;
      let i = 0; const fb = xorshift(Math.floor(act.u[0] * 4294967296) ^ 0x2545f491);
      const R = () => (i < act.u.length ? act.u[i++] : fb()), int = (n) => Math.floor(R() * n), pick = (a) => a[int(a.length)];
      const e = (act.a === 'wipe' ? model.wipe : model.edit)({ device: k, rows, all: rows, get: (id) => d.doc.view.get(id), now: () => Date.now(), rnd: R, int, pick, token, disjoint: false });
      if (!e) continue;
      if (e.kind === 'undo' || e.kind === 'redo') { step(e.kind === 'undo' ? -1 : 1); refill(d); continue; }
      const op = e.op; if (!op?.puts?.length) continue;
      for (const p of op.puts) if (!d.doc.view.get(p.id) && !d.doc.peek(p.id)) created.add(p.id);
      d.hist.record(casInverse((id) => d.doc.view.get(id), op.puts, { ...cas, now: () => Date.now() }), op.puts, { typing: Boolean(e.typing) });
      d.doc.put(op.puts);
      refill(d);
    }
    // recovery: faults cleared, every device syncs until its pending is empty, then everyone pulls once more
    for (const d of devs) d.t.faults.length = 0;
    for (let round = 0; round < 4; round++) for (const d of devs) { for (let n = 0; n < 5; n++) { const ok = await d.doc.sync().then(() => true, () => false); if (ok) d.ready = true; if (!(await d.doc.pending()).length) break; } refill(d); }
    for (const d of devs) { for (let n = 0; n < 5; n++) { await d.doc.sync().catch(() => {}); if (!(await d.doc.pending()).length) break; } }
    for (const d of devs) await d.doc.sync().catch(() => {});
    const want = JSON.stringify(text(await devs[0].doc.all()));
    for (const [k, d] of devs.entries()) {
      if ((await d.doc.pending()).length) return `device ${k}: pending did not drain`;
      const got = JSON.stringify(text(await d.doc.all()));
      if (got !== want) return `device ${k} diverged: ${got} vs device 0 ${want}`;
      const ids = new Set((await d.doc.all()).map((r) => r.id)); for (const id of created) if (!ids.has(id)) return `device ${k} lost row ${id}`;
    }
    if (spec) for (const [k, d] of devs.entries()) {
      const live = (await d.doc.all()).filter(model.live);
      for (const zone of spec.zones) {
        const mine = live.filter((r) => spec.zoneOf(r) === zone);
        if (!mine.length) return `device ${k}: zone ${zone} is empty after convergence`;
        const blank = mine.filter((r) => isPadRow(r) && r.id.startsWith(`pad:${zone}:`) && !(r.body || '').trim()).length; // its own pads (an archived pad of another zone is an ordinary blank line here)
        if (blank > (wrote.get(zone) ?? 0)) return `device ${k}: zone ${zone} holds ${blank} blank pads, its refills wrote ${wrote.get(zone) ?? 0}`;
      }
    }
    const seen = new Set(); for (const e of server.streams.get(name)?.rows || []) { const key = `${e.device_id}:${e.device_seq}`; if (seen.has(key)) return `stream holds ${key} twice`; seen.add(key); }
    const fresh = await open(new IDBFactory(), server);
    await fresh.sync(); const f = JSON.stringify(text(await fresh.all())); await fresh.close();
    if (f !== want) return `fresh reader diverged: ${f} vs ${want}`;
    return null;
  } finally {
    for (const d of devs) { d.t.dead = true; await d.doc.close().catch(() => {}); }
    timers.uninstall();
    if (had) c.getRandomValues = oldRv; else delete c.getRandomValues;
  }
}

/** Delta-debug an action list down to a minimal one that still fails. */
export async function shrinkSync(model, input, env) {
  let acts = input.actions;
  for (let chunk = Math.ceil(acts.length / 2); chunk >= 1; chunk = chunk === 1 ? 0 : Math.ceil(chunk / 2)) {
    for (let at = 0; at < acts.length;) {
      const tryActs = [...acts.slice(0, at), ...acts.slice(at + chunk)];
      if (await runSync(model, { devices: input.devices, actions: tryActs }, env)) acts = tryActs; else at += chunk;
    }
  }
  return { devices: input.devices, actions: acts };
}
export const showActions = (s) => s.actions.map((a) => `${a.d}:${a.a}${a.a === 'tick' ? a.ms : a.a === 'fault' ? `(${a.f})` : ''}`).join(' ');
