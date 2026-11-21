// Markdown decoration for kit editor lines: a line's text becomes render children (vnodes) whose text nodes are exactly
// the text, in order, so caret offsets index into the text with no remapping. Away from the caret (active false) the
// syntax is kept in the DOM but hidden (class qk-hide, the app's CSS hides it) and what it means is drawn: marks styled,
// `code`, [links](u), $math$ and $$display math$$ drawn by the app's tex hook as inert decoration whose click puts the
// caret into the source (data-action caret:N). On the caret's line (active) everything is source, the syntax faint
// (qk-mk), except folded markers (below), hidden always. Classes: qk-mk qk-hide qk-fold qk-code qk-a qk-tex qk-tex-src qk-tex-err qk-go qk-chip qk-chip-<kind> qk-chip-block qk-chip-name qk-chip-kind qk-chip-ext qk-chip-src, plus the app's
// mark classes and an overlay class (a find hit).
//
// Chips (2026-11-11, zai3 transclusion): `[[kind:key|label]]` is a reference to another object (kind lowercase letters,
// key [A-Za-z0-9_.-], label any text without `]` or a newline). The app's `chip(kind, key, label)` hook says what it opens:
// it returns { href, ext?, embed? } (the chip opens href; ext, optional, adds a second target that opens that page; embed: true draws no card, the app's slot item after the row is the chip's view) or null (the span stays plain text: an unknown kind is never a dead chip). Off the
// caret's line the source is hidden (qk-chip-src) and an inert pill with the label stands in, its click the action
// open:<href> (the app opens it, as it does for a link's arrow); on the caret's line the source is shown, so a chip is
// edited and deleted as text and the addressed text is always exactly the line.
//
// inline(text, { marks, active, tex, overlay })
//   marks(text) -> [{ text, cls: [..], marker: bool, fold?: bool }]   the app's inline marks over a plain run (bold, highlight ...).
//     A marker is syntax: faint on the caret's line, hidden elsewhere. A FOLDED marker (fold: true; zai3's character-format
//     `<span data-f ...>` tags, 2026-11-12, the owner: "formatted text should look formatted, no visible tags") is hidden on
//     the caret's line too, the way a link's url is folded off it: styled text never turns into source. The chars stay in the DOM
//     (class qk-hide qk-fold) so the text nodes are still exactly the text; fold.js says where the caret may rest and what a
//     delete skips, so a folded run is never half-edited.
//   tex(src, display) -> html string (throws on a parse error)
//   chip(kind, key, label, { sole }) -> { href, ext?, embed? } | null   what a [[kind:key|label]] chip opens (null: plain text); sole: it is the line's only content
//   overlay: { from, to, cls } a range to wrap in a class

/** A bounded memo for a pure decoration renderer (math is re-rendered on every commit): memo(fn) -> fn'. */
export function memo(fn, max = 4000) {
  const m = new Map();
  return (...args) => { const k = JSON.stringify(args); if (m.has(k)) return m.get(k); const v = fn(...args); if (m.size >= max) m.clear(); m.set(k, v); return v; };
}

const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/y;
const CHIP_RE = /\[\[([a-z]{2,12}):([A-Za-z0-9_.-]{1,64})\|([^\]\n]{0,120})\]\]/y;

/** The chip at text[i] ([[kind:key|label]]) as a scan span, or null. */
function chipAt(text, i) {
  CHIP_RE.lastIndex = i;
  const r = CHIP_RE.exec(text);
  return r ? { kind: 'chip', from: i, to: i + r[0].length, ref: r[1], key: r[2], label: [i + 2 + r[1].length + 1 + r[2].length + 1, i + r[0].length - 2] } : null;
}

/** The source spans of a line: [{ kind: 'text'|'code'|'math'|'dmath'|'link'|'url', from, to, ... }] covering text. */
export function scan(text) {
  const out = []; let i = 0, plain = 0;
  const flush = (to) => { if (to > plain) out.push({ kind: 'text', from: plain, to }); };
  while (i < text.length) {
    const c = text[i];
    let hit = null;
    if (c === '`') { const e = text.indexOf('`', i + 1); if (e > i + 1) hit = { kind: 'code', from: i, to: e + 1, open: 1, close: 1 }; }
    else if (c === '$' && text[i + 1] === '$') { const e = text.indexOf('$$', i + 2); if (e > i + 2) hit = { kind: 'dmath', from: i, to: e + 2, open: 2, close: 2 }; }
    else if (c === '$' && text[i + 1] && !/\s/.test(text[i + 1]) && text[i - 1] !== '\\') {
      // pandoc's rule: no space inside either delimiter, and a closing $ is not followed by a digit ("$5 and $10" is text)
      for (let e = text.indexOf('$', i + 1); e > 0; e = text.indexOf('$', e + 1)) {
        if (text[e - 1] === '\\') continue;
        if (!/\s/.test(text[e - 1]) && !/\d/.test(text[e + 1] || '')) { hit = { kind: 'math', from: i, to: e + 1, open: 1, close: 1 }; break; }
      }
    } else if (c === '[' && text[i + 1] === '[' && chipAt(text, i)) {
      hit = chipAt(text, i);
    } else if (c === '[') {
      const m = /\[([^\]\n]+)\]\(([^)\s]+)\)/y; m.lastIndex = i; const r = m.exec(text);
      if (r) hit = { kind: 'link', from: i, to: i + r[0].length, label: [i + 1, i + 1 + r[1].length], href: r[2] };
    } else if ((c === 'h') && (i === 0 || /[\s(]/.test(text[i - 1]))) {
      URL_RE.lastIndex = i; const r = URL_RE.exec(text);
      if (r) hit = { kind: 'url', from: i, to: i + r[0].length, href: r[0] };
    }
    if (!hit) { i++; continue; }
    flush(hit.from); out.push(hit); i = plain = hit.to;
  }
  flush(text.length);
  return out;
}

/** The inert card that stands in for a chip off the caret's line. Classes: qk-chip, qk-chip-<kind> (the app styles a kind), and
 *  qk-chip-block when the chip is the only content of its line (a full-width card; inline in text otherwise). The card is the
 *  name (qk-chip-name) and the kind (qk-chip-kind, e.g. "doc"); a hook that returns `ext` also gets a second hit target on its
 *  right edge (qk-chip-ext) whose click is open:<ext> (the app's page for the object outside the editor: its own action, so the
 *  main click, which opens `href`, is unchanged). The tooltip is the name, which the card may truncate. */
function chipDeco(sp, text, target) {
  const label = text.slice(sp.label[0], sp.label[1]) || sp.key;
  const sole = !text.slice(0, sp.from).trim() && !text.slice(sp.to).trim();
  const kids = [{ tag: 'span', cls: 'qk-chip-name', text: label }, { tag: 'span', cls: 'qk-chip-kind', text: sp.ref }];
  if (typeof target.ext === 'string') kids.push({ tag: 'span', cls: 'qk-chip-ext', inert: true, editable: false, text: '\u2197', attrs: { 'data-action': `open:${target.ext}`, role: 'link', 'aria-label': `open the ${sp.ref} page outside the editor`, title: `open the ${sp.ref} page` } });
  return { tag: 'span', cls: `qk-chip qk-chip-${sp.ref}${sole ? ' qk-chip-block' : ''}`, inert: true, editable: false, children: kids, attrs: { 'data-action': `open:${target.href}`, role: 'link', title: label } };
}

// Marks span the whole line, not one plain run: `**see [x](u)**`, `**a `c` b**`, `**[[doc:..|t]]**` are bold around a link,
// code, math or a chip. The app's marks run once over the line with every non-plain span masked (each of its characters
// replaced by U+FFFC, so a `*` or `<` inside a URL, code or math is never a delimiter and the lengths are the text's); each
// mark's range then classes every token it covers and hides its markers off the caret's line. Run per plain span, a marker
// whose pair sat across a link was never paired and drew as literal `**` (zai3, the owner 2026-11-11 17:48 PST: "its showing
// the bold tags ?? don't do that !!").
const MASK = '\uFFFC';
export function markRanges(text, spans, marks) {
  let masked = '';
  for (const sp of spans) masked += sp.kind === 'text' ? text.slice(sp.from, sp.to) : MASK.repeat(sp.to - sp.from);
  const out = []; let at = 0;
  for (const t of marks(masked)) { const n = t.text.length; if (n && (t.cls?.length || t.marker)) out.push({ from: at, to: at + n, cls: t.cls || [], marker: !!t.marker, fold: !!(t.marker && t.fold) }); at += n; }
  return at === text.length ? out : []; // a marks() that does not cover its input exactly is ignored rather than mis-applied
}

/** Render children for one line's text. */
export function inline(text, { marks = (t) => [{ text: t, cls: [] }], active = false, tex = null, chip = null, overlay = null } = {}) {
  const toks = []; // { text, cls: [], deco?: vnode (inert, after this token), plain?: a plain-text token (marks apply) }
  const src = (s, cls) => ({ text: s, cls: active ? [...cls, 'qk-mk'] : [...cls, 'qk-hide'] });
  const spans = scan(text);
  for (const sp of spans) {
    const s = text.slice(sp.from, sp.to);
    if (sp.kind === 'text') { toks.push({ text: s, cls: [], plain: true }); continue; }
    if (sp.kind === 'chip') {
      const target = chip ? chip(sp.ref, sp.key, text.slice(sp.label[0], sp.label[1]), { sole: !text.slice(0, sp.from).trim() && !text.slice(sp.to).trim() }) : null; // sole: the chip is the line's only content (an embed's row)
      if (!target || typeof target.href !== 'string') { toks.push({ text: s, cls: [], plain: true }); continue; }
      toks.push({ text: s, cls: active ? ['qk-chip-src', 'qk-mk'] : ['qk-chip-src', 'qk-hide'], deco: active || target.embed === true ? null : chipDeco(sp, text, target) }); // embed: true (an embedded doc): the app draws a slot item after the row, so no card stands in here
      continue;
    }
    if (sp.kind === 'code') { toks.push(src(s.slice(0, 1), ['qk-code'])); toks.push({ text: s.slice(1, -1), cls: ['qk-code'] }); toks.push(src(s.slice(-1), ['qk-code'])); continue; }
    if (sp.kind === 'link') {
      const [l0, l1] = sp.label;
      toks.push(src('[', [])); toks.push({ text: text.slice(l0, l1), cls: ['qk-a'] });
      toks.push({ ...src(text.slice(l1, sp.to), []), deco: active ? null : { tag: 'span', cls: 'qk-go', inert: true, editable: false, text: '↗', attrs: { 'data-action': `open:${sp.href}`, title: sp.href } } });
      continue;
    }
    if (sp.kind === 'url') { toks.push({ text: s, cls: ['qk-a'], deco: active ? null : { tag: 'span', cls: 'qk-go', inert: true, editable: false, text: '↗', attrs: { 'data-action': `open:${sp.href}`, title: sp.href } } }); continue; }
    // math
    const display = sp.kind === 'dmath', body = s.slice(sp.open, s.length - sp.close);
    let html = null;
    if (!active && tex) { try { html = tex(body, display); } catch { html = null; } }
    if (html == null) {
      toks.push({ text: s.slice(0, sp.open), cls: ['qk-tex-src', 'qk-mk'] });
      toks.push({ text: body, cls: ['qk-tex-src', ...(active || !tex ? [] : ['qk-tex-err'])] });
      toks.push({ text: s.slice(s.length - sp.close), cls: ['qk-tex-src', 'qk-mk'] });
      continue;
    }
    toks.push({ text: s, cls: ['qk-tex-src', 'qk-hide'], deco: { tag: 'span', cls: display ? 'qk-tex qk-tex-display' : 'qk-tex', inert: true, editable: false, html, attrs: { 'data-action': `caret:${sp.from + sp.open}` } } });
  }
  // the marks: split tokens at each mark range's ends; inside a range add its classes, and a marker range (plain text
  // only: masked spans are never delimiters) is syntax, faint on the caret's line and hidden elsewhere
  const ranges = markRanges(text, spans, marks);
  if (ranges.length) {
    const cuts = new Set(); for (const r of ranges) { cuts.add(r.from); cuts.add(r.to); }
    const split = []; let at = 0;
    for (const t of toks) {
      const a = at, b = at + t.text.length; at = b;
      const inner = [...cuts].filter((c) => c > a && c < b).sort((x, y) => x - y), pts = [a, ...inner, b];
      for (let k = 0; k + 1 < pts.length; k++) {
        const from = pts[k], to = pts[k + 1], cls = [...t.cls];
        for (const r of ranges) {
          if (r.from > from || r.to < to) continue;
          cls.push(...r.cls);
          if (r.marker && t.plain) { if (r.fold) cls.push('qk-hide', 'qk-fold'); else cls.push(active ? 'qk-mk' : 'qk-hide'); }
        }
        split.push({ text: t.text.slice(from - a, to - a), cls: [...new Set(cls)], deco: to === b ? t.deco : null });
      }
    }
    toks.length = 0; toks.push(...split);
  }
  // the overlay (a find hit): split tokens at its ends and add its class inside
  let out = toks;
  if (overlay && overlay.to > overlay.from) {
    out = []; let at = 0;
    for (const t of toks) {
      const a = at, b = at + t.text.length; at = b;
      const cuts = [a, Math.min(Math.max(overlay.from, a), b), Math.min(Math.max(overlay.to, a), b), b];
      for (let k = 0; k < 3; k++) {
        if (cuts[k + 1] <= cuts[k]) continue;
        const inside = cuts[k] >= overlay.from && cuts[k + 1] <= overlay.to;
        out.push({ text: t.text.slice(cuts[k] - a, cuts[k + 1] - a), cls: inside ? [...t.cls, overlay.cls] : t.cls, deco: cuts[k + 1] === b ? t.deco : null });
      }
    }
  }
  const kids = [];
  for (const t of out) {
    if (t.text) kids.push(t.cls.length ? { tag: 'span', cls: t.cls.join(' '), text: t.text } : t.text);
    if (t.deco) kids.push(t.deco);
  }
  return kids;
}
