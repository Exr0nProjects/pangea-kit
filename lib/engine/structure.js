// Line structure with identity for row stores (lib/engine/rows.js): a split, a join, or a paste that carries a line's tail
// into another row is ONE op with an id, recorded on every row it touches, so a merge can tell it from a rewrite.
// Census A29 (zai2 sync fuzz, 2026-11-09 00:05): with rows as per-field last-writer-wins and a split encoded as two
// independent row writes (the old row keeps the head, a new row takes the tail), a device that rewrote the old row before
// it saw the split wrote the whole line back, so the tail's words sat in both rows: 515 of 10,000 concurrent seeds ended
// with a duplicated word, and undo brought them back in 19 more. PANGEA3-DESIGN §19 "structural edits (split/join) as
// single ops with identity"; DESIGN-CONFORMANCE §B (rows.js), §E step 2(c).
//
// The rule. Text that moves between rows is a MOVE: { op, from row, the source text it was cut from (base), the region
// [start, end) of that text, to row, where it landed }. A move is stored as two add-only fields, one name per op so two
// moves never overwrite each other under per-field LWW:
//   `mv:<op>` on the source row:      JSON { to, base, start, end, seen }   (seen: the source's moves the op knew)
//   `in:<op>` on the destination row: JSON { from, base, pos, result, at, len }   (base: its text before, pos: where the
//                                     moved text went in base, result: its text after, [at, at + len): the moved text)
// Every write of a row's text carries `mvseen`: the ids of the moves on that row its writer had applied (written in the
// same put, so the text and its mvseen share one stamp and always win together). The text a row SHOWS is a pure function
// of the merged rows (every replica folds to the same rows, so every replica shows the same text):
//   1. a move into the row its text never saw (a stale rewrite won) is replayed: its text is inserted again;
//   2. a move out of the row its text never saw is applied: its region, mapped through a character diff from the base
//      the op cut onto the text now, is removed (only characters of the region and insertions strictly inside it);
//   3. two moves out of one source that neither saw (a concurrent split and join, two splits) and that overlap: the
//      overlap stays with the move whose op id is larger and is removed from the other move's destination.
// So a word is in one row: never in the source and a destination, never in two destinations. What concurrency still
// costs (as per-field LWW always did): a rewrite that lost its row's text race is lost, and an edit made inside the moved
// region by a device that had not seen the move is dropped with the region (not duplicated).
//
// Undo: the inverse of a move nulls its `mv:`/`in:` fields (they were created by the op), so lib/history.js casStep
// undoes and redoes a split or join as one all-or-nothing step. Fields are strings, so its by-value compare holds after
// a structured clone (IndexedDB) or a JSON round trip.
//
// API:
//   identify(op, { get, text, moves })  -> op with every text put carrying mvseen, and the moves' records added
//        op: { puts: [{ id, set }], ... }; get(id): the row AS SHOWN (viewRow) or undefined; text: the text field (default
//        'body'); moves: [{ op, from, start, end, to, pos?, at? }] (start/end in the source's shown text, pos in the
//        destination's shown text before, at in its text after; both default to the end of the destination's head)
//   viewRow(row, peek, { text })        -> the row as shown (text derived, mvseen the full set); the same object when
//        nothing is unseen. peek(id): any stored row, tombstoned ones included (rows.peek), for rule 3.
//   viewDoc(doc, { text })              -> an editor doc (lib/editor/editor.js memoryLines/rowsDoc shape) whose lines()
//        and get() show viewRow; peek and put stay raw.
//   checkIdentified(puts, { text })     -> null, or why a put breaks the rule (a text write without mvseen).

export const MV = 'mv:', IN = 'in:', SEEN = 'mvseen';

const parse = (v) => { if (typeof v !== 'string') return null; try { const r = JSON.parse(v); return r && typeof r === 'object' ? r : null; } catch { return null; } };
const seenSet = (row) => new Set(typeof row?.[SEEN] === 'string' && row[SEEN] ? row[SEEN].split(' ') : []);
const joinSeen = (set) => [...set].sort().join(' ');
/** What a write on top of `row` (as shown) has seen: the token of every record on it now, plus the tokens its stored
 *  text had seen of moves whose records have not arrived here yet (entries arrive in any order: a later op's write can
 *  land before the op it was made on top of, zai2 concurrent seeds 9416, 9667). */
function seenNow(row) {
  const out = new Map();
  for (const t of seenSet(row)) out.set(t.replace(/~$/, ''), t);
  for (const r of recordsOf(row)) out.set(r.op, r.undone ? `${r.op}~` : r.op);
  return new Set(out.values());
}

/** The live (non-null) move records on a row: [{ kind: 'mv'|'in', op, ...record }], sorted by op id. */
export function recordsOf(row) {
  const out = [];
  if (!row) return out;
  for (const k of Object.keys(row)) {
    const kind = k.startsWith(MV) ? 'mv' : k.startsWith(IN) ? 'in' : null;
    if (!kind) continue;
    const r = parse(row[k]); if (r) out.push({ ...r, kind, op: k.slice(kind.length + 1) });
  }
  return out.sort((a, b) => (a.op < b.op ? -1 : a.op > b.op ? 1 : a.kind < b.kind ? -1 : 1));
}

// ------------------------------------------------------------------ character diff (LCS on the middle after trimming)
const MAX_CELLS = 4_000_000; // beyond this the middle is treated as replaced wholesale (no characters matched)
/** For each character of a, the index of its match in b, or -1. */
export function matchMap(a, b) {
  const m = new Int32Array(a.length).fill(-1);
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) { m[p] = p; p++; }
  let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) { m[a.length - 1 - s] = b.length - 1 - s; s++; }
  const A = a.slice(p, a.length - s), B = b.slice(p, b.length - s), n = A.length, k = B.length;
  if (!n || !k || n * k > MAX_CELLS) return m;
  const L = new Uint32Array((n + 1) * (k + 1)), W = k + 1; // L[i][j] = LCS of A[i:], B[j:]
  for (let i = n - 1; i >= 0; i--) for (let j = k - 1; j >= 0; j--) L[i * W + j] = A[i] === B[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
  for (let i = 0, j = 0; i < n && j < k;) {
    if (A[i] === B[j]) { m[p + i] = p + j; i++; j++; } else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++; else j++;
  }
  return m;
}
/** The characters of b that region [s, e) of a became: those matched to a character of the region, and insertions
 *  strictly between two of them. Returns [from, to) in b (the hull; b's characters in it that are not the region's
 *  are kept by removeRegion). */
function regionMask(a, b, s, e) {
  const m = matchMap(a, b), inB = new Uint8Array(b.length), aOf = new Int32Array(b.length).fill(-1);
  for (let i = 0; i < a.length; i++) if (m[i] >= 0) aOf[m[i]] = i;
  const prev = new Int32Array(b.length), next = new Int32Array(b.length);
  let last = -1; for (let j = 0; j < b.length; j++) { if (aOf[j] >= 0) last = aOf[j]; prev[j] = aOf[j] >= 0 ? aOf[j] : last; }
  let nx = a.length; for (let j = b.length - 1; j >= 0; j--) { if (aOf[j] >= 0) nx = aOf[j]; next[j] = aOf[j] >= 0 ? aOf[j] : nx; }
  for (let j = 0; j < b.length; j++) {
    if (aOf[j] >= 0) inB[j] = aOf[j] >= s && aOf[j] < e ? 1 : 0;
    else inB[j] = prev[j] >= s && prev[j] < e && next[j] >= s && next[j] < e ? 1 : 0;
  }
  return inB;
}
/** Position in b of point p of a: just after the last character before p that survived. */
export function mapPoint(a, b, p) {
  const m = matchMap(a, b); let at = 0;
  for (let i = 0; i < Math.min(p, a.length); i++) if (m[i] >= 0) at = m[i] + 1;
  return at;
}
/** Region [s, e) of a as it is in b: [from, to) over b plus the mask of b's characters that belong to it. */
export function mapRegion(a, b, s, e) {
  const mask = regionMask(a, b, s, e);
  let from = -1, to = -1; for (let j = 0; j < b.length; j++) if (mask[j]) { if (from < 0) from = j; to = j + 1; }
  return { from: from < 0 ? mapPoint(a, b, s) : from, to: to < 0 ? mapPoint(a, b, s) : to, mask };
}

// ------------------------------------------------------------------ the text a row shows
const concurrent = (x, y) => !(x.seen || []).includes(y.op) && !(y.seen || []).includes(x.op);
/** What a row's text writer knew of record r: 'applied' (its text has the move in effect), 'undone' (its text has the
 *  move undone) or 'none'. */
const knew = (seen, r) => (seen.has(r.op) ? 'applied' : seen.has(`${r.op}~`) ? 'undone' : 'none');
const tokenOf = (r) => (r.undone ? `${r.op}~` : r.op);

/** Which characters of move `me` (out of row `src`; a mask over me.base[me.start, me.end)) belong elsewhere:
 *  - a concurrent move out of src with a larger op id took them too (it keeps them);
 *  - they came into src by a move that was undone after `me` was made on top of it (the undo took them home);
 *  - they came into src by a move whose own text belongs elsewhere (the same question one source back, so a split of a
 *    joined line drops what the join lost to a concurrent paste: zai2 concurrent seed 2292). */
function lostOf(src, me, peek, depth = 0) {
  const lost = new Uint8Array(Math.max(0, me.end - me.start));
  const mark = (mask) => { for (let j = me.start; j < me.end; j++) if (mask[j]) lost[j - me.start] = 1; };
  for (const o of recordsOf(src)) {
    if (o.op === me.op) continue;
    if (o.kind === 'mv' && !o.undone && o.op > me.op && concurrent(me, o) && typeof o.base === 'string') mark(mapRegion(o.base, me.base, o.start, o.end).mask);
    else if (o.kind === 'in' && o.undone && (me.seen || []).includes(o.op) && typeof o.result === 'string') mark(mapRegion(o.result, me.base, o.at, o.at + o.len).mask);
    else if (o.kind === 'in' && !o.undone && depth < 8 && typeof o.result === 'string') {
      const osrc = peek?.(o.from), omv = osrc && parse(osrc[`${MV}${o.op}`]);
      if (!omv || omv.undone || typeof omv.base !== 'string') continue;
      const sub = lostOf(osrc, { ...omv, op: o.op }, peek, depth + 1);
      if (!sub.some(Boolean)) continue;
      const mm = matchMap(o.result, me.base), mask = new Uint8Array(me.base.length);
      for (let i = 0; i < sub.length; i++) { const j = mm[o.at + i]; if (sub[i] && j >= 0) mask[j] = 1; }
      mark(mask);
    }
  }
  return lost;
}

/** The text of `row` as shown (rules 1-3 above, and their undone forms). */
export function viewText(row, peek, { text = 'body' } = {}) {
  const recs = recordsOf(row);
  let t = typeof row?.[text] === 'string' ? row[text] : '';
  if (!recs.length) return t;
  const seen = seenSet(row);
  const regions = []; // moved-in text in t: { rec, s, e }
  // every change to t goes through these two, so the tracked regions follow it
  const insert = (pos, str) => { t = t.slice(0, pos) + str + t.slice(pos); for (const g of regions) { if (g.s >= pos) { g.s += str.length; g.e += str.length; } else if (g.e > pos) g.e += str.length; } };
  const removeMask = (mask) => {
    const keep = []; const shift = new Int32Array(t.length + 1); let k = 0;
    for (let j = 0; j < t.length; j++) { shift[j] = k; if (!mask[j]) { keep.push(t[j]); k++; } }
    shift[t.length] = k; t = keep.join('');
    for (const g of regions) { g.s = shift[g.s]; g.e = shift[g.e]; }
  };
  const ok = (r) => typeof r.base === 'string' && (r.kind === 'mv' || typeof r.result === 'string');
  for (const r of recs) {
    if (!ok(r) || r.kind !== 'in') continue;
    const k = knew(seen, r);
    if (!r.undone && k === 'applied') { const g = mapRegion(r.result, t, r.at, r.at + r.len); regions.push({ rec: r, s: g.from, e: g.to }); }
    else if (!r.undone) { const moved = r.result.slice(r.at, r.at + r.len), pos = mapPoint(r.base, t, r.pos); insert(pos, moved); regions.push({ rec: r, s: pos, e: pos + moved.length }); } // rule 1
    else if (k === 'applied') removeMask(mapRegion(r.result, t, r.at, r.at + r.len).mask); // an undone move in: its text went back
  }
  for (const r of recs) {
    if (!ok(r) || r.kind !== 'mv') continue;
    const k = knew(seen, r);
    if (!r.undone && k !== 'applied') removeMask(mapRegion(r.base, t, r.start, r.end).mask); // rule 2
    else if (r.undone && k === 'applied') insert(mapPoint(r.base, t, r.start), r.base.slice(r.start, r.end)); // an undone move out: its text came back
  }
  // rule 3: moved-in text that belongs elsewhere (lostOf) is removed from this destination
  for (const g of regions) {
    const src = peek?.(g.rec.from); if (!src) continue;
    const mine = parse(src[`${MV}${g.rec.op}`]); if (!mine || mine.undone || typeof mine.base !== 'string') continue;
    const me = { ...mine, op: g.rec.op };
    const lost = lostOf(src, me, peek);
    if (!lost.some(Boolean)) continue;
    const movedNow = t.slice(g.s, g.e), movedThen = me.base.slice(me.start, me.end);
    const mm = matchMap(movedThen, movedNow), mask = new Uint8Array(t.length);
    for (let i = 0; i < movedThen.length; i++) if (lost[i] && mm[i] >= 0) mask[g.s + mm[i]] = 1;
    removeMask(mask);
  }
  return t;
}

/** The row as shown: its text derived (viewText) and mvseen the full set of its records. The same object when every
 *  record is seen (nothing to derive). Memoised per row object and the source rows rule 3 read. */
const memo = new WeakMap();
/** Rows derived (not served from the memo) since load: the per-keystroke work bound. */
export const viewStats = { derived: 0 };
export function viewRow(row, peek, { text = 'body' } = {}) {
  if (!row || typeof row !== 'object') return row;
  // memoised per row object, valid while every row the derivation read (sources, and their sources: rule 3 follows a
  // chain of moves) is still the same object: an unchanged row costs one WeakMap lookup, so lines() over 30,000 rows
  // derives nothing on a keystroke that wrote one row (viewStats counts derivations; tests/structure.test.js bounds it)
  const hit = memo.get(row);
  if (hit && hit.text === text && hit.deps.every(([id, obj]) => (peek?.(id) ?? null) === obj)) return hit.out;
  viewStats.derived += 1;
  const recs = recordsOf(row);
  if (!recs.length) { memo.set(row, { text, deps: [], out: row }); return row; }
  const deps = new Map();
  const track = (id) => { const r = peek?.(id) ?? null; deps.set(id, r); return r; };
  const ins = recs.filter((r) => r.kind === 'in');
  const srcs = ins.map((r) => track(r.from));
  const seen = seenSet(row);
  const all = joinSeen(seenNow(row));
  // nothing unseen and no other move out of a source: the stored text is the shown text
  const quiet = recs.every((r) => seen.has(tokenOf(r))) && ins.every((r, i) => { const s = srcs[i]; if (!s || r.undone) return true; return recordsOf(s).every((o) => o.op === r.op || (o.kind === 'mv' && o.op < r.op)); });
  const out = quiet ? (row[SEEN] === all ? row : { ...row, [SEEN]: all }) : { ...row, [text]: viewText(row, track, { text }), [SEEN]: all };
  memo.set(row, { text, deps: [...deps], out });
  return out;
}

/** An editor doc over a doc of stored rows, showing every row through viewRow. */
export function viewDoc(doc, { text = 'body' } = {}) {
  const peek = (id) => (doc.peek ? doc.peek(id) : doc.get(id));
  // every other property (reachedStart, loadOlder, atStart ...) is the wrapped doc's, getters included
  return Object.create(doc, {
    lines: { value: () => doc.lines().map((r) => viewRow(r, peek, { text })) },
    get: { value: (id) => viewRow(doc.get(id), peek, { text }) },
    peek: { value: peek },
    put: { value: (...a) => doc.put(...a) },
    raw: { value: doc },
  });
}

// ------------------------------------------------------------------ writing
/** Decorate an op: add the moves' records, and give every put that writes text (or gains a record) its mvseen and text.
 *  get(id): the row as shown before the op (undefined for a row the op creates). */
export function identify(op, { get, text = 'body', moves = [] } = {}) {
  if (!op?.puts?.length) return op;
  const puts = op.puts.map((p) => ({ id: p.id, set: { ...p.set } }));
  const putOf = (id) => { let p = puts.find((x) => x.id === id); if (!p) { p = { id, set: {} }; puts.push(p); } return p; };
  const added = new Map(); // row id -> op ids this op records on it
  const add = (id, opId) => { if (!added.has(id)) added.set(id, new Set()); added.get(id).add(opId); };
  for (const mv of moves) {
    const src = get(mv.from), dst = get(mv.to);
    const base = src?.[text] ?? '';
    if (!(mv.end > mv.start)) continue; // nothing moved: no identity needed (Enter at a line's end)
    const sp = putOf(mv.from), dp = putOf(mv.to);
    // a source the op does not rewrite (a join deletes it) is written without the moved text: its text and mvseen must
    // agree (mvseen says the move is in effect), so a later revival (an undo of a concurrent delete) shows no copy
    if (!(text in sp.set)) sp.set[text] = base.slice(0, mv.start) + base.slice(mv.end);
    const before = dst ? (dst[text] ?? '') : '';
    const result = typeof dp.set[text] === 'string' ? dp.set[text] : before;
    const moved = base.slice(mv.start, mv.end);
    const at = mv.at ?? (result.endsWith(moved) ? result.length - moved.length : Math.max(0, result.indexOf(moved)));
    sp.set[`${MV}${mv.op}`] = JSON.stringify({ to: mv.to, base, start: mv.start, end: mv.end, seen: [...seenNow(src)].filter((t) => !t.endsWith('~')).sort() });
    dp.set[`${IN}${mv.op}`] = JSON.stringify({ from: mv.from, base: before, pos: mv.pos ?? before.length, result, at, len: moved.length });
    add(mv.from, mv.op); add(mv.to, mv.op);
  }
  for (const p of puts) {
    const touchesText = text in p.set || added.has(p.id);
    if (!touchesText) continue;
    const cur = get(p.id);
    if (!(text in p.set)) p.set[text] = cur?.[text] ?? '';
    const s = new Set([...seenNow(cur)].filter((t) => !added.get(p.id)?.has(t.replace(/~$/, ''))));
    for (const op of added.get(p.id) || []) s.add(op);
    p.set[SEEN] = joinSeen(s);
  }
  return { ...op, puts };
}

/** Wrap an inverse (lib/history.js inverse, or an app's wrapper of it): the undo of a move leaves its records in place,
 *  marked undone, instead of null (on a row the op had) or the forward value (on a row the op created and the undo
 *  deletes). A row whose text was written on top of the move can then tell the move was taken back (its text went home)
 *  and show that. history.js is unchanged: its compare-and-set compares these strings by value like any field.
 *  It also gives a restored text its mvseen from before the op (a removal's inverse carries the words, not mvseen).
 *    const inv = undoMoves((before, puts) => inverse(before, puts, CAS)) */
export function undoMoves(inv, { text = 'body' } = {}) {
  return (before, puts, ...rest) => {
    const back = inv(before, puts, ...rest);
    return back.map((q, k) => {
      const p = puts[k]; if (!p || p.id !== q.id) return q;
      let set = null;
      // a text the inverse restores without its mvseen (a removal's inverse carries the row's words): the row's mvseen
      // before the op comes with it, so the text and its mvseen win together (zai2 concurrent seed 1976)
      if (text in q.set && !(SEEN in q.set)) { const old = before(q.id); if (old) { set = { ...q.set }; set[SEEN] = old[SEEN] ?? null; } } // null, not '': casStep compares it by value
      for (const f of Object.keys(p.set)) {
        if (!(f.startsWith(MV) || f.startsWith(IN))) continue;
        const r = parse(p.set[f]); if (!r) continue;
        set ??= { ...q.set }; set[f] = JSON.stringify({ ...r, undone: true });
      }
      return set ? { ...q, set } : q;
    });
  };
}

/** The field group a row store must write together (openRows({ together: together() }); the convergence harness checks
 *  the same): a text and its mvseen, so they always win together under per-field LWW. */
export const together = ({ text = 'body' } = {}) => [[text, SEEN]];

/** null, or why a put breaks the identity rule (a text write that does not carry mvseen). */
export function checkIdentified(puts, { text = 'body' } = {}) {
  for (const p of puts || []) if (p?.set && text in p.set && !(SEEN in p.set)) return `put ${p.id} writes ${text} without ${SEEN} (lib/engine/structure.js identify)`;
  return null;
}
