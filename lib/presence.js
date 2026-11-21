// Presence: who else is in a document and where their caret is (PANGEA3-DESIGN §11 row 53, §15 "Embeds"). The owner 2026-11-11
// 21:57 PST: "i want other peolpes comments, cursors, edits to show up in real time". EPHEMERAL: kit state, never data. A peer
// is never in the op log, on a Stream or on disk; the server (zai3 worker/hub.js) fans it out and stores nothing, and a peer
// nobody has heard from for 10 s is gone (a client rule, applied by the `expire` action; the server holds no truth).
//
// Three parts, all pure or injectable-clock so a test (and the gate) drives them with no timers:
//  1. the model: applyPresence(peers, action) over { [peerId]: { id, name, color, sel, at } }, three absolute actions:
//       { peer: { id, name, color?, sel, at } }   set a peer (last writer wins on `at`; an older `at` is ignored; sel null =
//                                                 in the document, no caret)
//       { drop: id }                              the peer left (blur, unload)
//       { expire: now, ttl? }                     remove every peer whose `at` is older than now - ttl (the clock arrives in
//                                                 the payload: a reducer has none, A4)
//     the editor takes the same action as { type: 'presence', ... } (lib/editor/editor.js step); presenceDecl declares the
//     model on its own for validate() and the gate (row #38/#53 laws: total, pure, noop reference, idempotent by value).
//  2. the client: createPresence({ cid, send }): the local caret goes out at most `hz` times a second (leading edge at once,
//     the latest value trailing), a heartbeat repeats the last one every `heartbeatMs` while the document has focus (so a
//     peer's `at` stays inside the ttl), `away` goes out on blur and on dispose; receive(ev) hands a server event to a
//     callback unless it is this client's own (cid).
//  3. the colours: colorOf(peerId) is a fixed-palette hash, so every client draws a peer in the same colour.
import { declare } from './model.js';
import { registerGenerator } from './declare-keys.js';

export const TTL_MS = 10_000;
export const HEARTBEAT_MS = 4_000;
export const HZ = 20;
export const MAX_PEERS = 64;
/** Readable on the manila and the dark ground alike (the label text is white, the tint is the colour at low alpha). */
export const PALETTE = Object.freeze(['#d9480f', '#1971c2', '#2f9e44', '#9c36b5', '#c2255c', '#0c8599', '#e67700', '#5f3dc4']);
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
export const colorOf = (id) => PALETTE[hash(String(id)) % PALETTE.length];

const isPt = (p) => p && typeof p === 'object' && typeof p.id === 'string' && p.id.length > 0 && p.id.length < 200 && Number.isFinite(p.off) && p.off >= 0;
const cleanSel = (s) => (s && typeof s === 'object' && isPt(s.a) && isPt(s.f) ? { a: { id: s.a.id, off: Math.floor(s.a.off) }, f: { id: s.f.id, off: Math.floor(s.f.off) } } : null);
/** A peer as the model keeps it, or null for junk (no id, no time). The colour is the client's choice by id unless given. */
export function cleanPeer(p) {
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id || p.id.length > 120 || !Number.isFinite(p.at)) return null;
  return { id: p.id, name: String(p.name ?? 'someone').replace(/[\r\n]+/g, ' ').slice(0, 40) || 'someone', color: typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : colorOf(p.id), sel: cleanSel(p.sel), at: p.at };
}
const same = (a, b) => a.name === b.name && a.color === b.color && a.at === b.at && JSON.stringify(a.sel) === JSON.stringify(b.sel);
/** Apply one presence action to the peers map. Pure and total; the same reference when nothing changes. */
export function applyPresence(peers, a) {
  const cur = peers && typeof peers === 'object' ? peers : {};
  if (!a || typeof a !== 'object') return cur;
  if (a.peer !== undefined) {
    const p = cleanPeer(a.peer); if (!p) return cur;
    const have = cur[p.id];
    if (have && (have.at > p.at || same(have, p))) return cur; // last writer wins on `at`; an older or identical one changes nothing
    if (!have && Object.keys(cur).length >= MAX_PEERS) return cur;
    return { ...cur, [p.id]: p };
  }
  if (typeof a.drop === 'string') { if (!(a.drop in cur)) return cur; const { [a.drop]: _gone, ...rest } = cur; return rest; }
  if (Number.isFinite(a.expire)) {
    const ttl = Number.isFinite(a.ttl) && a.ttl > 0 ? a.ttl : TTL_MS, dead = Object.keys(cur).filter((k) => a.expire - cur[k].at > ttl);
    if (!dead.length) return cur;
    const out = { ...cur }; for (const k of dead) delete out[k]; return out;
  }
  return cur;
}

// ---- the declaration (validate() and the gate; the editor holds the same peers in its own state)
const cleanPeers = (v) => Object.fromEntries(Object.entries(v && typeof v === 'object' && !Array.isArray(v) ? v : {}).map(([k, p]) => [k, cleanPeer(p)]).filter(([k, p]) => p && p.id === k).slice(0, MAX_PEERS));
const NAMES = ['ana', 'bo', 'cy'], IDS = ['u1:a', 'u2:b', 'anon:c'];
const genPeers = (r, state) => {
  const k = r.int(0, 3);
  if (k === 0) return ['drop', r.pick(IDS)];
  if (k === 1) return ['expire', { expire: 1.7e12 + r.int(0, 40_000), ttl: r.pick([undefined, 5000, TTL_MS]) }];
  const id = r.pick(IDS);
  return ['peer', { peer: r.chance(0.9) ? { id, name: r.pick(NAMES), sel: r.chance(0.7) ? { a: { id: 'l1', off: r.int(0, 5) }, f: { id: 'l1', off: r.int(0, 5) } } : null, at: 1.7e12 + r.int(0, 30_000) } : r.pick([{ id: '' }, { id, at: 'x' }, null]) }];
};
export const presenceDecl = (name = 'presence') => {
  const d = declare({
    name, scope: 'ephemeral', conflict: 'lww',
    initial: { peers: {} },
    normalize: (s) => { const peers = cleanPeers(s?.peers); return s && JSON.stringify(peers) === JSON.stringify(s.peers) ? s : { peers }; }, // the same object when already clean (the noop-reference law)
    actions: {
      peer: (s, p) => { const peers = applyPresence(s.peers, { peer: p?.peer }); return peers === s.peers ? s : { peers }; },
      drop: (s, id) => { const peers = applyPresence(s.peers, { drop: id }); return peers === s.peers ? s : { peers }; },
      expire: (s, p) => { const peers = applyPresence(s.peers, { expire: p?.expire, ttl: p?.ttl }); return peers === s.peers ? s : { peers }; },
    },
  });
  registerGenerator(name, genPeers);
  return d;
};

// ---- the client
/** createPresence({ cid, send, hz, heartbeatMs, now, setTimer, clearTimer }) -> { local(sel, { focused }), away(), receive(ev, onPeer), flush(), dispose() }
 *  send(payload) posts { cid, sel, away? } to the server (any rejection is the caller's, presence is best effort);
 *  cid: this client's id (one per tab); an event carrying it is our own echo and is dropped. */
export function createPresence({ cid, send, hz = HZ, heartbeatMs = HEARTBEAT_MS, now = () => Date.now(), setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t) }) {
  const gap = 1000 / hz;
  let last = null, lastAt = -Infinity, trailing = null, beat = null, focused = false, off = false, sent = 0;
  const post = (payload) => { sent += 1; try { const r = send({ cid, ...payload }); r?.catch?.(() => {}); } catch { /* best effort */ } };
  const arm = () => { if (beat) clearTimer(beat); beat = null; if (!focused || off) return; beat = setTimer(() => { beat = null; if (focused && !off && last) { lastAt = now(); post({ sel: last }); } arm(); }, heartbeatMs); };
  function go() { trailing = null; lastAt = now(); post({ sel: last }); arm(); }
  return {
    /** The local caret changed (or focus did): sel is { a: {id, off}, f: {id, off} } or null. */
    local(sel, { focused: f = true } = {}) {
      if (off) return;
      const s = cleanSel(sel); const fo = Boolean(f);
      const moved = JSON.stringify(s) !== JSON.stringify(last) || fo !== focused;
      focused = fo; last = s;
      if (!fo) { this.away(); return; }
      if (!moved) return;
      const wait = lastAt + gap - now();
      if (wait <= 0) { if (trailing) { clearTimer(trailing); trailing = null; } go(); }
      else if (!trailing) trailing = setTimer(go, wait);
    },
    away() { if (trailing) { clearTimer(trailing); trailing = null; } if (beat) { clearTimer(beat); beat = null; } focused = false; if (!off) post({ sel: null, away: true }); },
    /** A server event { peer, name, sel, at, away? } -> onPeer({ peer } | { drop }); our own echo (peer ends with :cid) is dropped. */
    receive(ev, onPeer) {
      if (!ev || typeof ev.peer !== 'string' || ev.peer.endsWith(`:${cid}`) || ev.peer === cid) return false;
      if (ev.away) { onPeer({ drop: ev.peer }); return true; }
      const p = cleanPeer({ id: ev.peer, name: ev.name, sel: ev.sel, at: now() }); // stamped on arrival: the server's clock is not ours
      if (!p) return false;
      onPeer({ peer: p }); return true;
    },
    flush() { if (trailing) { clearTimer(trailing); go(); } },
    get sent() { return sent; },
    dispose() { if (!off) { this.away(); off = true; } if (trailing) clearTimer(trailing); if (beat) clearTimer(beat); },
  };
}
