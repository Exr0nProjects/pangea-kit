// Character formatting as per-span attributes carried IN the line's text, Google Docs style: font family, size, text colour,
// highlight colour (The owner 2026-11-12 11:00 PST: "a text icon (the google docs A with underline icon) ... allows u to change
// font, size, color, highlight color, etc. in a secondary popup pill").
//
// Encoding: `<span data-f="georgia" data-s="18" data-t="d93025" data-h="fff2cc">words</span>`, the same kind of inline HTML mark
// zai already writes for highlights (`<mark>`) and underline (`<u>`). The row's text IS the formatting, so it merges, syncs, undoes
// and is found by the same rules as the text (per-field LWW on the row, the history's compare-and-set, the Worker's reads); no
// second store of ranges whose offsets would drift when two devices edit the same line (a range table keyed by offsets is
// the desync the doc design refuses, PANGEA3 §11 "per-character identity" gap). The cost is the one every text mark has: two
// concurrent edits of one line lose by LWW (the line's whole text); a format applied while another device typed in the same
// line is not merged character by character.
//
// A span left empty by a delete is dropped (`dropEmptySpans`). Folded display: the tags are hidden even on the caret's line (decorate.js `fold`, fold.js).
//
// Everything here is pure and total (A4): a junk attribute is dropped, an unmatched tag is literal text, and `applyFormat`
// returns the same body for a no-op. Spans never nest in what this module writes (a hand-written nest is read, and flattened
// the next time a format touches it). Spans never cross another mark's markers (`**`, `<u>` ...): the caller says which
// characters of the plain text are markers (`barriers`), and a span is cut around them so that pairs of the other marks stay
// pairs (`**<span>a</span>**`, never `**a<span>**b</span>`).
//
// The look: classes only (`ff-<font>`, `fs-<px>`, `tc-<hex>`, `hc-<hex>`); the kit's decorate.js draws classes, never styles,
// so the render map and the text nodes stay exactly the text. `createFormatSheet(document)` writes the matching rules into one
// stylesheet (a derived, rebuildable output: a rule per class that appears, nothing else).

export const MIXED = Symbol.for('qk.format.mixed');

/** The fonts (key, label, CSS stack). `null` key = the document's own font. System stacks only: no font is fetched. */
export const FONTS = Object.freeze([
  { key: 'sans', label: 'Sans', stack: 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif' },
  { key: 'serif', label: 'Serif', stack: 'ui-serif, Georgia, "Times New Roman", serif' },
  { key: 'mono', label: 'Mono', stack: 'ui-monospace, Menlo, "Courier New", monospace' },
  { key: 'arial', label: 'Arial', stack: 'Arial, Helvetica, sans-serif' },
  { key: 'georgia', label: 'Georgia', stack: 'Georgia, "Times New Roman", serif' },
  { key: 'times', label: 'Times New Roman', stack: '"Times New Roman", Times, serif' },
  { key: 'palatino', label: 'Palatino', stack: 'Palatino, "Palatino Linotype", "Book Antiqua", serif' },
  { key: 'garamond', label: 'Garamond', stack: 'Garamond, "EB Garamond", "Times New Roman", serif' },
  { key: 'verdana', label: 'Verdana', stack: 'Verdana, Geneva, sans-serif' },
  { key: 'trebuchet', label: 'Trebuchet MS', stack: '"Trebuchet MS", Helvetica, sans-serif' },
  { key: 'courier', label: 'Courier New', stack: '"Courier New", Courier, monospace' },
  { key: 'comic', label: 'Comic Sans MS', stack: '"Comic Sans MS", "Comic Sans", cursive' },
  { key: 'impact', label: 'Impact', stack: 'Impact, "Arial Narrow Bold", sans-serif' },
]);
const FONT_KEYS = new Set(FONTS.map((f) => f.key));

/** The size steps (px). The stepper walks these (Google's list, in px: 6-96). */
export const SIZES = Object.freeze([10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72, 96]);
export const SIZE_MIN = 6, SIZE_MAX = 200;

/** Google Docs' colour grid, 10 columns by 8 rows (read off docs.google.com's palette, 2026-11-12): greys, the ten
 *  hues, then light 3-2-1 and dark 1-2-3 rows. Hex without the hash. */
export const PALETTE = Object.freeze([
  '000000', '434343', '666666', '999999', 'b7b7b7', 'cccccc', 'd9d9d9', 'efefef', 'f3f3f3', 'ffffff',
  '980000', 'ff0000', 'ff9900', 'ffff00', '00ff00', '00ffff', '4a86e8', '0000ff', '9900ff', 'ff00ff',
  'e6b8af', 'f4cccc', 'fce5cd', 'fff2cc', 'd9ead3', 'd0e0e3', 'c9daf8', 'cfe2f3', 'd9d2e9', 'ead1dc',
  'dd7e6b', 'ea9999', 'f9cb9c', 'ffe599', 'b6d7a8', 'a2c4c9', 'a4c2f4', '9fc5e8', 'b4a7d6', 'd5a6bd',
  'cc4125', 'e06666', 'f6b26b', 'ffd966', '93c47d', '76a5af', '6d9eeb', '6fa8dc', '8e7cc3', 'c27ba0',
  'a61c00', 'cc0000', 'e69138', 'f1c232', '6aa84f', '45818e', '3c78d8', '3d85c6', '674ea7', 'a64d79',
  '85200c', '990000', 'b45f06', 'bf9000', '38761d', '134f5c', '1155cc', '0b5394', '351c75', '741b47',
  '5b0f00', '660000', '783f04', '7f6000', '274e13', '0c343d', '1c4587', '073763', '20124d', '4c1130',
]);

const HEX = /^[0-9a-f]{6}$/;
const KEYS = ['font', 'size', 'color', 'bg'];
const ATTR = { font: 'f', size: 's', color: 't', bg: 'h' };
const FROM_ATTR = { f: 'font', s: 'size', t: 'color', h: 'bg' };

/** One attribute value repaired, or undefined (junk is dropped). */
export function cleanAttr(key, v) {
  if (v === null || v === undefined || v === '') return undefined;
  if (key === 'font') return typeof v === 'string' && FONT_KEYS.has(v) ? v : undefined;
  if (key === 'size') { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= SIZE_MIN && n <= SIZE_MAX ? n : undefined; }
  if (key === 'color' || key === 'bg') { const h = String(v).replace(/^#/, '').toLowerCase(); return HEX.test(h) ? h : undefined; }
  return undefined;
}
/** A whole attribute set repaired: only the four keys, only valid values. */
export const cleanAttrs = (a) => { const out = {}; for (const k of KEYS) { const v = cleanAttr(k, a?.[k]); if (v !== undefined) out[k] = v; } return out; };
const sameAttrs = (a, b) => KEYS.every((k) => a[k] === b[k]);
const empty = (a) => KEYS.every((k) => a[k] === undefined);

/** The open tag of a span, `<span data-f=".." ...>`: attributes in a fixed order, so the same format is the same text. */
export const openTag = (attrs) => `<span ${KEYS.filter((k) => attrs[k] !== undefined).map((k) => `data-${ATTR[k]}="${attrs[k]}"`).join(' ')}>`;
export const CLOSE = '</span>';
/** An open tag at the start of `s`: matches `<span data-x="..">` with at least one valid attribute. */
export const SPAN_OPEN = /^<span((?: data-[fsth]="[A-Za-z0-9]{1,24}")+)>/;
/** { len, attrs } of the span tag at the start of s, or null (junk values make it literal text). */
export function parseOpen(s) {
  const m = SPAN_OPEN.exec(s); if (!m) return null;
  const attrs = {};
  for (const [, k, v] of m[1].matchAll(/ data-([fsth])="([^"]*)"/g)) { const c = cleanAttr(FROM_ATTR[k], v); if (c !== undefined) attrs[FROM_ATTR[k]] = c; }
  return empty(attrs) ? null : { len: m[0].length, attrs };
}

/** The classes that draw a set of attributes. */
export const spanClasses = (attrs) => {
  const a = cleanAttrs(attrs), out = [];
  if (a.font) out.push(`ff-${a.font}`);
  if (a.size) out.push(`fs-${a.size}`);
  if (a.color) out.push(`tc-${a.color}`);
  if (a.bg) out.push(`hc-${a.bg}`);
  return out;
};

/** Read the body as plain characters plus their attributes: { plain, attrs[], at[] (original index of each plain char),
 *  pos(i) (the plain index of original offset i) }. A span tag is not a character. A close tag with no open is literal. */
export function readSpans(body) {
  body = String(body ?? '');
  const plain = [], attrs = [], at = [], map = new Array(body.length + 1);
  const stack = [];
  let cur = {};
  let i = 0;
  while (i < body.length) {
    map[i] = plain.length;
    if (body[i] === '<') {
      const o = parseOpen(body.slice(i, i + 160));
      if (o && body.indexOf(CLOSE, i + o.len) >= 0) {
        for (let k = 0; k < o.len; k++) map[i + k] = plain.length;
        stack.push(cur); cur = { ...cur, ...o.attrs }; i += o.len; continue;
      }
      if (stack.length && body.startsWith(CLOSE, i)) {
        for (let k = 0; k < CLOSE.length; k++) map[i + k] = plain.length;
        cur = stack.pop(); i += CLOSE.length; continue;
      }
    }
    plain.push(body[i]); attrs.push(cur); at.push(i); i += 1;
  }
  map[body.length] = plain.length;
  return { plain: plain.join(''), attrs, at, pos: (off) => map[Math.max(0, Math.min(body.length, off))] };
}

/** The text of a body with its span tags removed (what the reader sees, whatever the formatting). */
export const stripSpans = (body) => readSpans(body).plain;

/** The formatting of body[start, end): { font, size, color, bg }, each a value, null (none anywhere) or MIXED (varies). Characters
 *  that are markers (barriers) do not vote. */
export function formatAt(body, start, end, { barriers = null } = {}) {
  const r = readSpans(body);
  const a = r.pos(Math.min(start, end)), b = r.pos(Math.max(start, end));
  const bar = barrierSet(r.plain, barriers);
  const out = {};
  for (const k of KEYS) {
    let seen, any = false;
    for (let p = a; p < b; p++) { if (bar.has(p)) continue; const v = r.attrs[p][k] ?? null; if (!any) { seen = v; any = true; } else if (v !== seen) { seen = MIXED; break; } }
    out[k] = any ? seen : null;
  }
  return out;
}
/** The formatting over several lines' covered text: segments [{ body, from, to }] (body without any list marker). Each segment votes its
 *  own formatAt; a value, null (none anywhere) or MIXED (the segments differ, an unformatted one differing from a formatted one). A
 *  segment that covers no text is skipped, so dashes, tags and empty lines never make a selection Mixed. */
export function formatOver(segments, { barriers = null } = {}) {
  const out = {};
  for (const sg of segments) {
    if (!(sg.to > sg.from) || !(sg.body || '').length) continue;
    const f = formatAt(sg.body, sg.from, sg.to, { barriers });
    for (const k of KEYS) out[k] = k in out ? (out[k] === f[k] ? out[k] : MIXED) : f[k];
  }
  for (const k of KEYS) if (!(k in out)) out[k] = null;
  return out;
}
const barrierSet = (plain, barriers) => {
  const s = new Set();
  if (typeof barriers === 'function') for (const [f, t] of barriers(plain) || []) for (let p = Math.max(0, f); p < Math.min(plain.length, t); p++) s.add(p);
  return s;
};

/** Merge a patch into attributes: a key set to null or '' clears it, a valid value sets it, anything else leaves it. */
function merge(attrs, patch) {
  const out = { ...attrs };
  for (const k of KEYS) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === null || v === '') { delete out[k]; continue; }
    const c = cleanAttr(k, v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/** Write the formatting of a body: plain characters with attributes, span tags around each maximal run of one non-empty
 *  attribute set, cut at barrier characters. Returns { body, out(p) }: out maps a plain index to its index in the new body. */
function write(plain, attrs, bar) {
  let s = '';
  const out = new Array(plain.length + 1);
  let p = 0;
  while (p < plain.length) {
    if (bar.has(p) || empty(attrs[p])) { out[p] = s.length; s += plain[p]; p += 1; continue; }
    let q = p; while (q < plain.length && !bar.has(q) && sameAttrs(attrs[q], attrs[p])) q += 1;
    s += openTag(attrs[p]);
    for (let k = p; k < q; k++) { out[k] = s.length; s += plain[k]; }
    s += CLOSE; p = q;
  }
  out[plain.length] = s.length;
  return { body: s, out };
}

/** Apply a format patch ({ font?, size?, color?, bg?, clear? }) to body[start, end). A value sets it, null clears it, `clear: true`
 *  clears all four. Returns { body, start, end } with the selection on the same text, or the body unchanged. Pure, total. */
export function applyFormat(body, start, end, patch, { barriers = null } = {}) {
  body = String(body ?? '');
  if (start > end) [start, end] = [end, start];
  const r = readSpans(body);
  const a = r.pos(start), b = r.pos(end);
  if (a === b || !patch || typeof patch !== 'object') return { body, start, end };
  const bar = barrierSet(r.plain, barriers);
  const next = r.attrs.map((x, p) => (p >= a && p < b && !bar.has(p) ? (patch.clear ? {} : merge(x, patch)) : x));
  const w = write(r.plain, next, bar);
  // keep the selection on the same text: from the first selected character to just after the last one
  let first = a; while (first < b && bar.has(first)) first += 1;
  let last = b; while (last > first && bar.has(last - 1)) last -= 1;
  if (w.body === body) return { body, start, end };
  return { body: w.body, start: first < b ? w.out[first] : w.out[a], end: last > first ? w.out[last - 1] + 1 : w.out[b] };
}

/** A text with every EMPTY span (`<span data-f="..."></span>`, what deleting the last drawn character of a formatted run leaves) dropped,
 *  and the caret (an offset into the text, optional) moved to the same place: { text, caret }. A text without one is returned as is. */
export function dropEmptySpans(text, caret = 0) {
  const re = /<span(?: data-[fsth]="[A-Za-z0-9]{1,24}")+><\/span>/g;
  let out = '', last = 0, c = caret;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out += text.slice(last, m.index); last = m.index + m[0].length;
    if (caret >= last) c -= m[0].length; else if (caret > m.index) c -= caret - m.index;
  }
  return last === 0 ? { text, caret } : { text: out + text.slice(last), caret: c };
}

/** The next size in SIZES above (dir 1) or below (dir -1) `current` (a number, or null for the document's size `base`); clamps at the
 *  ends. The stepper is a gesture: it reads what the user saw and dispatches the absolute size this returns. */
export function stepSize(current, dir, base = 16) {
  const cur = Number.isFinite(current) ? current : base;
  if (dir > 0) return SIZES.find((n) => n > cur) ?? SIZES[SIZES.length - 1];
  const below = SIZES.filter((n) => n < cur);
  return below.length ? below[below.length - 1] : SIZES[0];
}

/** The rules for the classes `spanClasses` yields, in one stylesheet of `document` (created once). `ensure(attrs)` adds the rules
 *  for the colours a span uses (any hex, not only the palette); fonts and sizes are fixed rules written up front. A rule is
 *  derived from the text (rebuildable by reading it), so this is output, not state. */
export function createFormatSheet(doc = globalThis.document) {
  const style = doc.createElement('style'); style.setAttribute('data-qk-format', '');
  doc.head.appendChild(style);
  const sheet = style.sheet, have = new Set();
  const add = (sel, css) => { if (have.has(sel)) return; have.add(sel); try { sheet.insertRule(`${sel}{${css}}`, sheet.cssRules.length); } catch { /* an invalid rule is never drawn */ } };
  for (const f of FONTS) add(`.ff-${f.key}`, `font-family:${f.stack}`);
  for (const n of SIZES) add(`.fs-${n}`, `font-size:${n}px`);
  const ensure = (attrs) => {
    const a = cleanAttrs(attrs);
    if (a.size) add(`.fs-${a.size}`, `font-size:${a.size}px`);
    if (a.color) add(`.tc-${a.color}`, `color:#${a.color}`);
    if (a.bg) add(`.hc-${a.bg}`, `background-color:#${a.bg}`);
  };
  for (const c of PALETTE) ensure({ color: c, bg: c });
  return { ensure, rules: () => sheet.cssRules.length };
}
