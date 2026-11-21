// Vim mode over a kit editor (ported from old zai's webchat/src/lib/client/notes-vim.js, the owner 2026-10-11 11:54 PDT: "actually lets add a vim mode too"): what a
// keydown is in vim's key notation, where the engine's state is drawn, how the engine's state follows the editor when the caret moves or the text changes
// by other hands, and (new for the kit) the buffer vim works on around the caret and the row edits a new text means. The engine itself is ./vim.js, checked
// against a headless Neovim (tests/vim.engine.test.js replays its golden observations).

import { createVim, vimKey, vimMode } from './vim.js';

/** The key in vim notation, or null for a key vim mode leaves to the page (⌘ chords, arrows). */
export function vimNotation(event) {
  if (event.metaKey || event.altKey) return null;
  if (event.ctrlKey) {
    const key = event.key.toLowerCase();
    if (key === 'r') return '<C-r>';
    // Ctrl-C leaves insert and visual mode like Escape (The owner, 2026-10-22: "nor does C-c").
    if (key === '[' || key === 'c') return '<Esc>';
    return null;
  }
  switch (event.key) {
    case 'Escape': return '<Esc>';
    case 'Enter': return '<CR>';
    case 'Backspace': return '<BS>';
    case 'Tab': return '<Tab>';
    default: return event.key.length === 1 ? event.key : null;
  }
}

/** The view of a plain text with no marker heads: every offset is shown as itself. */
function plainView(text) {
  return {
    project: (offset) => offset,
    words: (offset) => {
      const start = text.lastIndexOf('\n', offset - 1) + 1;
      const next = text.indexOf('\n', offset);
      return { start, end: next < 0 ? text.length : next };
    }
  };
}

/**
 * Where the page draws an engine state, as a selection { start, end } in body offsets: the block
 * cursor in normal mode (one selected character, collapsed past the last one), the caret in insert
 * mode, the selection in visual mode when it stays on one line (otherwise the caret at the cursor,
 * the page edits one line at a time). `view.project(offset)` is where the page can show an offset
 * (never inside a line's marker, and canonical for a formatted line's markup), `view.words(offset)`
 * the body offsets of that line's words.
 */
export function vimDrawn(state, view = plainView(state.text)) {
  const at = view.project(state.cursor);
  const line = view.words(state.cursor);
  if (state.mode === 'insert') return { start: at, end: at };
  if ((state.mode === 'visual' || state.mode === 'visual-line') && state.anchor != null) {
    const other = view.words(state.anchor);
    if (other.start === line.start) {
      if (state.mode === 'visual-line') return { start: line.start, end: line.end };
      const from = view.project(state.anchor);
      return { start: Math.min(from, at), end: Math.min(line.end, Math.max(from, at) + 1) };
    }
    return { start: at, end: at };
  }
  if (state.mode === 'visual' || state.mode === 'visual-line') return { start: at, end: at };
  return { start: at, end: at < line.end ? at + 1 : at };
}

/**
 * The engine state to apply the next key to, derived from the editor, which is the one source of
 * truth for the text and the caret. The owner, 2026-10-22: the engine must not keep a copy of cursor,
 * text or mode that can drift from the editor ("vim mode broke and acted as insert when i went
 * over a heading", and a click in insert mode that the next key undid). What vim alone owns
 * (mode, registers, a half-typed command, `.`, its undo history over this exact text) is carried
 * in `state`; text and caret are re-read on every key:
 *
 * - `state` is reused as it is only when the editor shows exactly what it drew for it: the same
 *   block, the same text, and the selection `vimDrawn` says it put there.
 * - The same text with the caret moved by something else (a click, an arrow, a focus change):
 *   what was in progress ends as Neovim ends it when the cursor is moved from outside (insert mode
 *   with its own <Esc>, so its undo step and `.` close; a visual selection or a half-typed command
 *   is dropped), the cursor goes to the caret, and insert mode is entered again there.
 * - Different text (a paste, ⌘Z, a remote edit, another note): the engine starts again on it at
 *   the caret, keeping registers and `.`, and insert mode if it was in insert mode.
 *
 * `at` is the editor's selection { start, end } in body offsets (or one offset); `view` is the
 * page's projection (see vimDrawn); `same` is false when the caret is in another block than the
 * one `state` was made on.
 */
export function syncVim(state, text, at, { view = null, same = true, moved = true } = {}) {
  const sel = typeof at === 'number' ? { start: at, end: at } : at;
  if (!state) return createVim(text, sel.start);
  const sameText = same && state.text === text;
  if (sameText) {
    if (!moved) return state;
    const drawn = vimDrawn(state, view || plainView(text));
    if (drawn.start === sel.start && drawn.end === sel.end) return state;
  }
  const wasInsert = state.mode === 'insert';
  let caret = Math.max(0, Math.min(sel.start, text.length));
  let base;
  if (sameText) {
    base = state;
    for (let i = 0; i < 4 && (base.mode !== 'normal' || base.pending.length); i += 1) base = vimKey(base, '<Esc>');
    if (base.text !== text) {
      // Leaving insert mode took out an autoindent nobody typed after: a caret below that line
      // moves up with the text, one on it stays on it.
      const lineEnd = text.indexOf('\n', state.cursor);
      if (lineEnd >= 0 && caret > lineEnd) caret -= text.length - base.text.length;
      caret = Math.max(0, Math.min(caret, base.text.length));
    }
    const fresh = createVim(base.text, caret);
    base = { ...base, cursor: fresh.cursor, curswant: fresh.curswant, setCurswant: false, vcolCache: fresh.vcolCache };
  } else {
    base = createVim(text, caret, carried(state));
  }
  if (!wasInsert) return base;
  // Back into insert mode at the caret: `i` before the character there, or `a` after the last one
  // when the caret is at the end of a line that has words.
  const lineStart = base.text.lastIndexOf('\n', caret - 1) + 1;
  const atEnd = caret > lineStart && (caret === base.text.length || base.text[caret] === '\n');
  return vimKey(atEnd ? { ...base, cursor: caret - 1 } : base, atEnd ? 'a' : 'i');
}

/** What vim owns and keeps when it starts again on other text: registers (the unnamed one too) and `.`. */
function carried(state) {
  const registers = { ...state._regs };
  if (state.registers?.['"']) registers['"'] = state.registers['"'];
  return { registers, lastChange: state.lastChange };
}

/** What the mode indicator says. */
export function vimLabel(state) {
  if (!state) return 'NORMAL';
  const mode = vimMode(state);
  if (mode === 'insert' || mode === 'insert-pending') return 'INSERT';
  if (mode === 'visual') return 'VISUAL';
  if (mode === 'visual-line') return 'V-LINE';
  const pending = (state.pending || []).join('');
  return pending ? `NORMAL ${pending}` : 'NORMAL';
}

// ---------------------------------------------------------------------------------------------------------------- over rows (kit editors)

/** The buffer vim works on: the rows around row index `ci` that make one run of text, as { from, to (exclusive), text (the rows' bodies joined by \n),
 *  starts (the offset in text where each row begins) }. A run ends at a row `edge(row)` calls an edge (a page break), at another group (a zone), after
 *  `cap` rows each way, and where two blank rows meet (old zai's "two blank lines end a block"; a single blank row is inside the buffer). */
export function vimBuffer(rows, ci, { body = (r) => r.body || '', blank = (r) => !body(r).trim(), edge = () => false, group = () => 0, cap = 300 } = {}) {
  const g = group(rows[ci]);
  let from = ci, to = ci + 1;
  while (from > 0 && ci - from < cap && !edge(rows[from - 1]) && group(rows[from - 1]) === g && !(blank(rows[from - 1]) && from - 2 >= 0 && blank(rows[from - 2]) && group(rows[from - 2]) === g)) from--;
  while (to < rows.length && to - ci <= cap && !edge(rows[to]) && group(rows[to]) === g && !(blank(rows[to]) && to + 1 < rows.length && blank(rows[to + 1]) && group(rows[to + 1]) === g)) to++;
  const starts = []; let at = 0;
  for (let k = from; k < to; k++) { starts.push(at); at += body(rows[k]).length + 1; }
  return { from, to, text: rows.slice(from, to).map(body).join('\n'), starts };
}

/** A buffer offset as { index (into the buffer's rows), col (the offset in that row's body) }. */
export function atOffset(buf, offset) {
  let i = buf.starts.length - 1;
  while (i > 0 && buf.starts[i] > offset) i--;
  return { index: i, col: Math.max(0, offset - buf.starts[i]) };
}

/** The projection vimDrawn needs over a buffer: never inside a row's marker (`head(row)` body characters before its words), and the words' span of a row. */
export function bufferView(buf, rows, head) {
  const lens = buf.text.split('\n');
  const at = (off) => { const { index, col } = atOffset(buf, off); return { index, col, start: buf.starts[index] }; };
  return {
    project: (off) => { const { index, col, start } = at(off); return start + Math.min(Math.max(col, head(rows[buf.from + index])), lens[index].length); },
    words: (off) => { const { index, start } = at(off); const h = Math.min(head(rows[buf.from + index]), lens[index].length); return { start: start + h, end: start + lens[index].length }; },
  };
}

/** The row edits that turn rows[from, to) into `lines` (strings, one per row): the lines the two sides share at the head and the tail are untouched, the lines
 *  between are matched row for row (a changed body is one `set(row, body)`), rows left over are deleted (deleted_at = stamp), and lines left over become new
 *  rows (`make(body, ord)`, keyed 'v0', 'v1' ... for the caller's mint to rename) with ords between the last kept row and the row after the range.
 *  Returns { puts, idOf (new line index -> row id or the new row's key) }. Pure. */
export function rowsDiff(rows, from, to, lines, { body = (r) => r.body || '', group = () => 0, set, make, stamp, ordBetween }) {
  const old = rows.slice(from, to).map(body);
  let a = 0; while (a < old.length && a < lines.length && old[a] === lines[a]) a++;
  let z = 0; while (z < old.length - a && z < lines.length - a && old[old.length - 1 - z] === lines[lines.length - 1 - z]) z++;
  const oldMid = rows.slice(from + a, to - z), newMid = lines.slice(a, lines.length - z), m = Math.min(oldMid.length, newMid.length);
  const puts = [], idOf = new Map();
  for (let k = 0; k < a; k++) idOf.set(k, rows[from + k].id);
  for (let k = 0; k < z; k++) idOf.set(lines.length - 1 - k, rows[to - 1 - k].id);
  for (let k = 0; k < m; k++) { idOf.set(a + k, oldMid[k].id); if (body(oldMid[k]) !== newMid[k]) puts.push({ id: oldMid[k].id, set: set(oldMid[k], newMid[k]) }); }
  for (let k = m; k < oldMid.length; k++) puts.push({ id: oldMid[k].id, set: { deleted_at: stamp, updated_at: stamp } });
  const g = group(rows[from]), mine = (r) => (r && group(r) === g ? r.ord : null); // an ord of another group (a zone) is no bound
  let lo = mine(m ? oldMid[m - 1] : rows[from + a - 1]);
  const hi = mine(rows[to - z]);
  for (let k = m; k < newMid.length; k++) { const ord = ordBetween(lo, hi), key = `v${k - m}`; lo = ord; idOf.set(a + k, key); puts.push({ id: key, set: make(newMid[k], ord) }); }
  return { puts, idOf };
}
