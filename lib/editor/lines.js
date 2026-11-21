// Line structure for kit editors over ordered rows: outline (a line's children are the lines after it that sit deeper),
// folds, moving and duplicating lines, depth-capped indent, select-all and find. Pure: rows in, puts (absolute row
// patches) or selections out; no DOM, no clock (the caller passes `at`). An app supplies what is its own: how deep a line
// sits (depth), how to rewrite a line at another depth (setDepth), which group (zone) a row belongs to, and new ids.
//
// rows: the live rows in document order (doc.lines()); a row has { id, ord } and whatever the app keeps.

/** An ord strictly between a and b (either null: the group's start or end). */
export function ordBetween(a, b) {
  if (a == null && b == null) return 1;
  if (a == null) return b - 1;
  if (b == null) return a + 1;
  const m = (a + b) / 2;
  return m > a && m < b ? m : a + (b - a) * 0.5000001;
}

const sameGroup = (group, x, y) => !!x && !!y && group(x) === group(y);

/** The index just past rows[i]'s subtree: the run of following rows (same group) deeper than it. A blank line (depth
 *  null) inside the run belongs to it only if a deeper line follows it. */
export function subtreeEnd(rows, i, { depth, group = () => 0 }) {
  const d = depth(rows[i]);
  if (d == null) return i + 1;
  let end = i + 1, k = i + 1;
  while (k < rows.length && sameGroup(group, rows[i], rows[k])) {
    const dk = depth(rows[k]);
    if (dk == null) { k++; continue; }
    if (dk <= d) break;
    end = ++k;
  }
  return end;
}

/** What a set of folded line ids hides: { hidden: Set(id), count: Map(id -> lines hidden under it), parents: Set(id) of
 *  lines that have children (can fold) }. A folded line inside a folded subtree is hidden with it. */
export function foldView(rows, folds, opts) {
  const hidden = new Set(), count = new Map(), parents = new Set(), shut = new Set(folds || []);
  for (let i = 0; i < rows.length; i++) {
    const end = subtreeEnd(rows, i, opts);
    if (end > i + 1) parents.add(rows[i].id);
    if (shut.has(rows[i].id) && end > i + 1 && !hidden.has(rows[i].id)) {
      count.set(rows[i].id, end - i - 1);
      for (let k = i + 1; k < end; k++) hidden.add(rows[k].id);
    }
  }
  return { hidden, count, parents };
}

/** The ordered index range [i, j] of a selection over rows (null when an end is not in rows). */
export function lineSpan(sel, rows) {
  const at = new Map(rows.map((r, k) => [r.id, k]));
  const i = at.get(sel.a.id), j = at.get(sel.f.id);
  if (i == null || j == null) return null;
  return i <= j ? [i, j] : [j, i];
}

/** Move rows[i..j] (extended to the last line's subtree) one line up (dir -1) or down (+1): it jumps over the neighbouring
 *  line's whole subtree when going down, over the line above when going up. At a group edge it moves into the next group
 *  (its rows get that group's fields from groupFields(target row)) when groupFields is given; without it a move stops at
 *  the group edge. Returns puts or null. */
export function moveLines(rows, i, j, dir, { depth, group = () => 0, groupFields = null, at }) {
  j = Math.max(j, subtreeEnd(rows, j, { depth, group }) - 1);
  const block = rows.slice(i, j + 1);
  const stamp = new Date(at).toISOString();
  let before, after, fields = {};
  if (dir < 0) {
    if (i === 0) return null;
    const up = rows[i - 1];
    if (!sameGroup(group, up, rows[i])) { // into the end of the group above
      if (!groupFields) return null;
      before = up; after = null; fields = groupFields(up);
    } else { before = sameGroup(group, rows[i - 2], up) ? rows[i - 2] : null; after = up; }
  } else {
    if (j >= rows.length - 1) return null;
    const down = rows[j + 1];
    if (!sameGroup(group, down, rows[j])) { if (!groupFields) return null; before = null; after = down; fields = groupFields(down); }
    else {
      const end = subtreeEnd(rows, j + 1, { depth, group });
      before = rows[end - 1]; after = sameGroup(group, rows[end], before) ? rows[end] : null;
    }
  }
  const puts = [];
  let lo = before?.ord ?? null;
  const hi = after?.ord ?? null;
  for (const r of block) { const ord = ordBetween(lo, hi); puts.push({ id: r.id, set: { ord, ...fields, updated_at: stamp } }); lo = ord; }
  return puts;
}

/** Drop rows[i] and its subtree (the run of deeper lines after it, folded or not) beside rows[t]: just before it (`after` false) or
 *  just after it (`after` true; after its whole subtree when it is folded, `folds` listing the folded ids, since its children are not
 *  drawn). The carried rows keep their relative order and depth and take ords between the neighbours the drop leaves them. A drop into
 *  another group gives the rows that group's fields (groupFields(target row)); without groupFields a drop stays in its own group. Returns
 *  puts, or null when it would change nothing (onto its own subtree, or to the place it already holds), so a replayed drop is a no-op. */
export function dropLines(rows, i, t, after, { depth, group = () => 0, groupFields = null, folds = [], at }) {
  if (!rows[i] || !rows[t]) return null;
  const e = subtreeEnd(rows, i, { depth, group });
  if (t >= i && t < e) return null;
  const same = sameGroup(group, rows[t], rows[i]);
  if (!same && !groupFields) return null;
  let p = after ? t + 1 : t;
  if (after && folds.includes(rows[t].id)) p = subtreeEnd(rows, t, { depth, group });
  if (p === i || p === e) return null;
  const prev = rows[p - 1], next = rows[p];
  const lo = prev && sameGroup(group, prev, rows[t]) ? prev.ord : null, hi = next && sameGroup(group, next, rows[t]) ? next.ord : null;
  const fields = same ? {} : groupFields(rows[t]), stamp = new Date(at).toISOString(), puts = [];
  let cur = lo;
  for (let k = i; k < e; k++) { const ord = ordBetween(cur, hi); cur = ord; puts.push({ id: rows[k].id, set: { ord, ...fields, updated_at: stamp } }); }
  return puts;
}

/** Copies of rows[i..j] right below rows[j] (dir +1) or right above rows[i] (dir -1); newId(k) names copy k. The caret
 *  stays on the original text; the copies take the other side. */
export function duplicateLines(rows, i, j, dir, { group = () => 0, newId, at, copy = (r) => ({ ...r }) }) {
  const stamp = new Date(at).toISOString();
  const lo = dir > 0 ? rows[j].ord : (sameGroup(group, rows[i - 1], rows[i]) ? rows[i - 1].ord : null);
  const hi = dir > 0 ? (sameGroup(group, rows[j + 1], rows[j]) ? rows[j + 1].ord : null) : rows[i].ord;
  const puts = []; let prev = lo;
  rows.slice(i, j + 1).forEach((r, k) => {
    const ord = ordBetween(prev, hi); prev = ord;
    const { id: _id, ...rest } = copy(r);
    puts.push({ id: newId(k), set: { ...rest, ord, created_at: stamp, updated_at: stamp, deleted_at: null } });
  });
  return puts;
}

/** Indent (dir +1) or outdent (-1) the lines i..j that have a depth, as a run: going deeper is allowed only if the first
 *  such line may sit one deeper than the line above it allows (maxDepth: one below the nearest line above with a depth,
 *  0 when a non-blank line without depth comes first; blank(row) says which lines are skipped); outdent stops each at 0. setDepth(row, d) -> the row's new set. */
export function indentLines(rows, i, j, dir, { depth, setDepth, group = () => 0, cap = true, blank = () => false }) {
  const run = [];
  for (let k = i; k <= j; k++) { const d = depth(rows[k]); if (d != null) run.push([k, d]); }
  if (!run.length) return null;
  if (dir > 0 && cap) {
    const [k0, d0] = run[0];
    let max = 0;
    for (let k = k0 - 1; k >= 0 && sameGroup(group, rows[k], rows[k0]); k--) { const d = depth(rows[k]); if (d != null) { max = d + 1; break; } if (!blank(rows[k])) break; }
    if (d0 + 1 > max) return null;
  }
  const puts = [];
  for (const [k, d] of run) { const n = Math.max(0, d + dir); if (n !== d) puts.push({ id: rows[k].id, set: setDepth(rows[k], n) }); }
  return puts.length ? puts : null;
}

/** The selection over the whole document (every row, not only the drawn ones). */
export function selectAll(rows, textOf) {
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  return { a: { id: rows[0].id, off: 0 }, f: { id: last.id, off: textOf(last).length } };
}

/** Every case-insensitive match of q over the rows' text, in document order: [{ id, from, to }]. */
export function findAll(rows, textOf, q, { limit = 5000 } = {}) {
  const out = [];
  if (!q) return out;
  const needle = q.toLowerCase();
  for (const r of rows) {
    const t = textOf(r).toLowerCase();
    for (let k = t.indexOf(needle); k >= 0 && out.length < limit; k = t.indexOf(needle, k + Math.max(1, needle.length))) out.push({ id: r.id, from: k, to: k + needle.length });
  }
  return out;
}
