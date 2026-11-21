// Folded syntax: marker runs that are hidden even on the caret's line (decorate.js: a mark token with `fold: true`; zai3's
// character-format `<span data-f ...>` ... `</span>` tags, the owner 2026-11-12: formatted text should look formatted, with no
// visible tags). The runs stay in the text and in the DOM (class qk-hide qk-fold), so addresses, text nodes and the render
// map are exactly the text; what changes is that a caret has nowhere to be seen inside one. Everything here is pure over a
// line's text and the runs `foldRuns` reads off the app's own marks, so the reducer (state), not the DOM, decides every move:
//
//   - the caret is only ever AT a run's edges (visually the same x; which edge records which side of the tag a letter typed
//     there lands on: left of an opening tag is outside the span, right of a closing tag likewise). Arrow keys never spend a
//     press inside a run or crossing one without moving a drawn character: from the left edge of a run, one press steps over
//     the run and one drawn character; so the caret reaches the start of a span from the right and its end from the left, and
//     a press always moves the caret on the screen (`stepCaret`).
//   - a one-character delete removes the drawn character beside the run, never a character of a tag (`deleteSpan`), and a
//     range edit removes only drawn characters: the runs inside the range are kept, in order, so a tag never loses its mate
//     (`spliceKeeping`). A pair left with nothing between is dropped by the app's own tidy (format.js `dropEmptySpans`).
//
// Run: [from, to) in the line's text. `foldRuns(text, marks)` merges adjacent runs.
import { scan, markRanges } from './decorate.js';

/** The folded runs of a line: [[from, to], ...] ascending, adjacent runs merged. `marks` is the app's decorate marks function. */
export function foldRuns(text, marks) {
  const out = [];
  for (const r of markRanges(text, scan(text), marks)) {
    if (!r.fold || r.to <= r.from) continue;
    const last = out[out.length - 1];
    if (last && last[1] === r.from) last[1] = r.to; else out.push([r.from, r.to]);
  }
  return out;
}

/** The run with from < off < to (the caret is inside it, where nothing is drawn), or null. */
export const runInside = (runs, off) => runs.find((r) => r[0] < off && off < r[1]) || null;

/** off moved out of any run it is inside: dir > 0 to the run's end, dir < 0 to its start, 0 to the nearer edge. */
export function snapOut(runs, off, dir = 0) {
  const r = runInside(runs, off); if (!r) return off;
  return dir > 0 ? r[1] : dir < 0 ? r[0] : off - r[0] <= r[1] - off ? r[0] : r[1];
}

const prevCp = (s, off) => (off >= 2 && /[\udc00-\udfff]/.test(s[off - 1]) && /[\ud800-\udbff]/.test(s[off - 2]) ? off - 2 : off - 1);
const nextCp = (s, off) => (/[\ud800-\udbff]/.test(s[off] || '') ? off + 2 : off + 1);

/** The caret offset one drawn character from off in direction dir (-1 | 1), or null at the line's edge (the caller crosses to
 *  the neighbouring line). `text` is optional (surrogate pairs); without it a character is one code unit. */
export function stepCaret(runs, off, dir, len, text = null) {
  let o = snapOut(runs, off, dir);
  if (dir > 0) {
    const r = runs.find((x) => x[0] === o);
    if (r) { o = r[1]; if (o >= len) return null; } // a run to the end of the line: its start is already the drawn end
    return o >= len ? null : Math.min(len, text ? nextCp(text, o) : o + 1);
  }
  const r = runs.find((x) => x[1] === o);
  if (r) o = r[0];
  return o <= 0 ? null : Math.max(0, text ? prevCp(text, o) : o - 1);
}

/** The text range one Backspace (back) or Delete removes from a bare caret: the drawn character beside off, never a character
 *  of a run, as { from, to }; null when there is none on this line (the caller joins or stops at the line's edge). */
export function deleteSpan(runs, text, off, back) {
  let o = snapOut(runs, off, back ? -1 : 1);
  if (back) {
    const r = runs.find((x) => x[1] === o); if (r) o = r[0];
    return o <= 0 ? null : { from: prevCp(text, o), to: o };
  }
  const r = runs.find((x) => x[0] === o); if (r) o = r[1];
  return o >= text.length ? null : { from: o, to: Math.min(text.length, nextCp(text, o)) };
}

/** text with the range [from, to) replaced by `insert`, every folded run inside the range kept (after the inserted text, in order),
 *  an edge inside a run moved out of it (from to the run's end, to to its start). Returns { text, caret } (the caret after the
 *  inserted text, before the kept runs). A range of drawn characters only is the plain splice. */
export function spliceKeeping(text, runs, from, to, insert = '') {
  let a = Math.min(from, to), b = Math.max(from, to);
  const ra = runInside(runs, a), rb = runInside(runs, b);
  if (ra) a = ra[1];
  if (rb) b = rb[0];
  if (b < a) b = a;
  const kept = runs.filter((r) => r[0] >= a && r[1] <= b).map((r) => text.slice(r[0], r[1])).join('');
  return { text: text.slice(0, a) + insert + kept + text.slice(b), caret: a + insert.length };
}

/** The text of runs[k] inside [from, to) joined, in order: what a range edit keeps (runs lying wholly inside the range). */
export function keptRuns(text, runs, from, to) {
  const a = snapOut(runs, Math.min(from, to), 1), b = snapOut(runs, Math.max(from, to), -1);
  return runs.filter((r) => r[0] >= a && r[1] <= b).map((r) => text.slice(r[0], r[1])).join('');
}

/** The drawn text of a line (the text without its folded runs) and where each drawn character sits: { drawn, at } with
 *  at[k] the text offset of drawn character k and at[drawn.length] = text.length; `drawnIndex(off)` is the number of drawn
 *  characters before text offset off. Word moves and deletes are measured on the drawn text, so a tag's spaces never end a word. */
export function drawnMap(text, runs) {
  const at = []; let drawn = '', r = 0;
  for (let i = 0; i < text.length; i++) {
    while (r < runs.length && runs[r][1] <= i) r++;
    if (r < runs.length && runs[r][0] <= i && i < runs[r][1]) continue;
    at.push(i); drawn += text[i];
  }
  at.push(text.length);
  return { drawn, at, drawnIndex: (off) => { let n = 0; for (const x of runs) { if (x[1] <= off) n += x[1] - x[0]; else if (x[0] < off) n += off - x[0]; } return off - n; } };
}
