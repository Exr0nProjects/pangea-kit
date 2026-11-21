// A line document for the convergence fuzz and the undo regression tests: zai2's document ops (zai-pangea src/doc.js at
// 2b0e0b2, the structural edits only: no marks, no todo cycle), so the kit tests the history and harness against the
// model they were found on. A row is { id, kind: 'text'|'break', body, ord, indent, zone, created_at, updated_at,
// deleted_at, source }; edits return { puts: [{ id, set }], caret }. Not an app: lines.model.js wraps it for the harness.

export const ZONES = [
  { key: 'past', label: 'Past', rank: 0 },
  { key: 'timeline', label: 'NOW', rank: 1 },
  { key: 'future', label: 'NEXT', rank: 2 },
  { key: 'state', label: 'State', rank: 3 },
];
const RANK = { past: 0, timeline: 1, present: 1, future: 2, state: 3 };
export const rankOf = (zone) => RANK[zone] ?? 1;
export const zoneKeyOf = (zone) => ZONES[rankOf(zone)].key;
export const sortKey = (r) => [rankOf(r.zone), Number.isFinite(r.ord) ? r.ord : 0, r.id];
export const isLive = (r) => !r.deleted_at && typeof r.zone === 'string';

const INDENT = '  ';
export const indentOf = (body) => Math.floor((/^ */.exec(body || '')[0].length) / INDENT.length);

let idSeq = 0;
/** Tests: restart the per-tab id counter so a seeded run replays the same ids. */
export const resetIdSeq = () => { idSeq = 0; };
/** A new line id: time-sortable and unique per tab (no coordination needed). */
export function newId(now = Date.now()) {
  const r = new Uint8Array(5); globalThis.crypto.getRandomValues(r);
  idSeq = (idSeq + 1) % 1296;
  return `z${now.toString(36)}${idSeq.toString(36).padStart(2, '0')}${[...r].map((b) => (b % 36).toString(36)).join('')}`;
}

/** An ord strictly between a and b (either may be null: the zone's start or end). */
export function between(a, b) {
  if (a == null && b == null) return 1;
  if (a == null) return b - 1;
  if (b == null) return a + 1;
  const m = (a + b) / 2;
  return m > a && m < b ? m : a + (b - a) * 0.5000001; // float exhaustion is reported by the caller's tests, not hit at 2k lines
}

/** The next and previous live line in the same zone (rows: the ordered live rows; i: an index into them). */
export const nextInZone = (rows, i) => (rows[i + 1] && rankOf(rows[i + 1].zone) === rankOf(rows[i].zone) ? rows[i + 1] : null);
export const prevInZone = (rows, i) => (rows[i - 1] && rankOf(rows[i - 1].zone) === rankOf(rows[i].zone) ? rows[i - 1] : null);

const stampNow = (now) => new Date(now).toISOString();
const line = (zone, ord, body, now, extra = {}) => ({ id: newId(now), set: { kind: 'text', body, ord, indent: indentOf(body), zone, created_at: stampNow(now), updated_at: stampNow(now), deleted_at: null, source: 'type', mvseen: '', ...extra } });
const edit = (id, set, now) => ({ id, set: { ...set, ...('body' in set ? { indent: indentOf(set.body) } : {}), updated_at: stampNow(now) } });
const remove = (id, now) => ({ id, set: { deleted_at: stampNow(now), updated_at: stampNow(now) } });

/** Enter at `offset` of rows[i]: always exactly one new line below, holding the text after the caret. A list or todo
 *  item with text continues its marker; an empty item gets a plain new line (so Enter twice leaves the list). */
export function enter(rows, i, offset, now = Date.now()) {
  const cur = rows[i];
  if (cur.kind === 'break') {
    const n = line(cur.zone, between(cur.ord, nextInZone(rows, i)?.ord ?? null), '', now);
    return { puts: [n], caret: { id: n.id, offset: 0 } };
  }
  const body = cur.body || '';
  const before = body.slice(0, offset), after = body.slice(offset);
  const m = /^(\s*)([-*] \[[ xX]\] |[-*] |\d+\. )/.exec(before);
  let carry = '';
  if (m && offset >= m[0].length && before.length > m[0].length) carry = m[1] + m[2].replace(/\[[xX]\]/, '[ ]').replace(/^(\d+)\./, (_, d) => `${Number(d) + 1}.`);
  const n = line(cur.zone, between(cur.ord, nextInZone(rows, i)?.ord ?? null), carry + after, now);
  const puts = before === body ? [n] : [edit(cur.id, { body: before }, now), n];
  // the tail moves to the new line: one op with identity (lib/engine/structure.js; census A29)
  return { puts, caret: { id: n.id, offset: carry.length }, moves: after ? [{ op: n.id, from: cur.id, start: offset, end: body.length, to: n.id, pos: 0, at: carry.length }] : [] };
}

/** Backspace at the very start of rows[i]: removes exactly one line. An empty line is deleted; a page rule above is
 *  deleted; otherwise this line's text joins the end of the line above. Never across zones. */
export function backspaceAtStart(rows, i, now = Date.now()) {
  const cur = rows[i], prev = prevInZone(rows, i);
  if (!prev) {
    if (cur.kind === 'break') { const nx = nextInZone(rows, i) || null; return { puts: [remove(cur.id, now)], caret: nx ? { id: nx.id, offset: 0 } : null }; }
    return null; // first line of a zone: nothing above it in this zone
  }
  if (prev.kind === 'break') return { puts: [remove(prev.id, now)], caret: { id: cur.id, offset: 0 } };
  if (cur.kind === 'break') return { puts: [remove(cur.id, now)], caret: { id: prev.id, offset: (prev.body || '').length } };
  const pb = prev.body || '', cb = cur.body || '';
  if (cb === '') return { puts: [remove(cur.id, now)], caret: { id: prev.id, offset: pb.length } };
  if (pb === '') return { puts: [remove(prev.id, now)], caret: { id: cur.id, offset: 0 } };
  // this line's words move to the end of the line above: one op with identity (lib/engine/structure.js)
  return { puts: [edit(prev.id, { body: pb + cb }, now), remove(cur.id, now)], caret: { id: prev.id, offset: pb.length }, moves: [{ op: newId(now), from: cur.id, start: 0, end: cb.length, to: prev.id, pos: pb.length, at: pb.length }] };
}

/** Delete at the very end of rows[i]: the next line joins this one (one line removed). */
export function deleteAtEnd(rows, i, now = Date.now()) {
  const nx = nextInZone(rows, i);
  if (!nx) return null;
  return backspaceAtStart(rows, i + 1, now);
}

/** Replace the range (rows[a] at offset ao) .. (rows[b] at offset bo) with `text` (may hold newlines). Lines wholly inside
 *  the range are soft-deleted; a range crossing zones keeps each zone's boundary lines. */
export function replaceRange(rows, a, ao, b, bo, text, now = Date.now()) {
  if (a > b || (a === b && ao > bo)) [a, ao, b, bo] = [b, bo, a, ao];
  const first = rows[a], last = rows[b];
  const head = (first.body || '').slice(0, ao), tail = (last.body || '').slice(bo);
  const parts = String(text).replace(/\r\n?/g, '\n').split('\n');
  const puts = [];
  if (rankOf(first.zone) !== rankOf(last.zone)) {
    // across zones: trim each end, delete everything between, and insert into the first zone only
    for (let i = a + 1; i < b; i++) puts.push(remove(rows[i].id, now));
    puts.push(edit(last.id, { body: tail }, now));
    return withInsert(rows, a, head, '', parts, puts, now);
  }
  for (let i = a + 1; i <= b; i++) puts.push(remove(rows[i].id, now));
  // the line after b in the zone is what new lines go before
  const op = withInsert(rows, a, head, tail, parts, puts, now, b);
  // the tail of the last line moves (to the first line, or to the last new line): one op with identity
  if (tail && (b > a || parts.length > 1)) {
    const to = parts.length > 1 ? op.puts[op.puts.length - 1] : op.puts[0];
    op.moves = [{ op: parts.length > 1 ? to.id : newId(now), from: last.id, start: bo, end: (last.body || '').length, to: to.id, pos: parts.length > 1 ? 0 : head.length, at: to.set.body.length - tail.length }];
  }
  return op;
}

function withInsert(rows, a, head, tail, parts, puts, now, b = a) {
  const first = rows[a];
  const nextOrd = nextInZone(rows, b)?.ord ?? null;
  puts.unshift(edit(first.id, { body: head + parts[0] + (parts.length === 1 ? tail : '') }, now));
  let prevOrd = first.ord, caret = { id: first.id, offset: head.length + parts[0].length };
  for (let k = 1; k < parts.length; k++) {
    const body = parts[k] + (k === parts.length - 1 ? tail : '');
    const ord = between(prevOrd, nextOrd);
    const n = line(first.zone, ord, body, now, { source: 'paste' });
    puts.push(n); prevOrd = ord;
    caret = { id: n.id, offset: parts[k].length };
  }
  return { puts, caret };
}

/** Tab / Shift-Tab: two spaces more or fewer at the start of each line a..b. */
export function indent(rows, a, b, delta, now = Date.now()) {
  const puts = [];
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
    const r = rows[i]; if (r.kind === 'break') continue;
    const body = r.body || '';
    const next = delta > 0 ? INDENT + body : body.replace(/^ {1,2}/, '');
    if (next !== body) puts.push(edit(r.id, { body: next }, now));
  }
  return { puts, shift: delta > 0 ? INDENT.length : -INDENT.length };
}

/** A todo line flips between [ ] and [x]; any other line becomes a todo. */
export function toggleTodo(row, now = Date.now()) {
  const body = row.body || '';
  const m = /^(\s*[-*] )\[([ xX])\] /.exec(body);
  const next = m ? `${m[1]}[${m[2] === ' ' ? 'x' : ' '}] ${body.slice(m[0].length)}` : body.replace(/^(\s*)(?:[-*] )?/, '$1- [ ] ');
  return { puts: [edit(row.id, { body: next }, now)], delta: next.length - body.length };
}

/** A body edit from typing (the browser changed one line's text). */
export const typed = (row, body, now = Date.now()) => ({ puts: [edit(row.id, { body }, now)] });

/** A line appended at the end of a zone. */
export function append(rows, zone, body, now = Date.now(), source = 'type') {
  const inZone = rows.filter((r) => rankOf(r.zone) === rankOf(zone));
  const last = inZone[inZone.length - 1];
  return line(zone, between(last?.ord ?? null, null), body, now, { source });
}

// undo: the kit's compare-and-set history with this document's fields (indent is derived from body; a removal carries
// the line's words)
import { inverse as casInverse, createCasHistory } from '../../history.js';
import { undoMoves } from '../../engine/structure.js';
export const CAS = { tombstone: 'deleted_at', stamp: 'updated_at', derived: ['indent'], carry: ['body'] };
// the undo of a split or join leaves its records marked undone (lib/engine/structure.js undoMoves)
export const inverse = undoMoves((before, puts, now) => casInverse(before, puts, now ? { ...CAS, now } : CAS));
export const createHistory = ({ limit = 500, now = () => Date.now() } = {}) => createCasHistory({ limit, now, ...CAS });
