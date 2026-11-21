// Spelling and grammar, as the kit's state and its pure functions (The owner 2026-11-14 22:56 PST: "can we add spell check and grammar check
// to zai ? it should show a little red underline dotted / squiggle *on hover* if something is wrong"). Pure and DOM-free (A4): the same
// functions run in the page, in a Worker and in the tests; the DOM end is lib/editor/lintdom.js and the checker itself is injected (zai3:
// Harper, Automattic's Rust grammar checker compiled to WASM, in a Web Worker: src/lint.worker.js), so the kit knows no checker.
//
// WHAT IS CHECKED: the words the person reads, not the markup. `proseOf(text, opts)` takes a line's text as the editor counts it (the same
// offsets as `sel`, `rangeOf` and `rectOf`, hidden syntax included) and returns the prose and a map from each prose character back to its
// offset in the text. Dropped from the prose (never checked, never underlined): the characters of a mark's delimiters (`**`, `<b>`, the format
// spans' `<span data-f ...>` tags: kit `markRanges`), code spans, math, URLs, a link's `[` `](url)` (its label is prose), [[doc:...]] chips, and
// whatever the app names through `skip(text)` (zai: a heading's `# `, a quote's `> `, the await pill, @mentions and #tags). A gap collapses a
// doubled blank, so "see `x` now" is "see now". A finding whose characters are not contiguous in the text (it spans a dropped run) is dropped,
// never mapped to a wrong place, so a finding always underlines exactly the words it names.
//
// STATE (all kit state, none only in the DOM; scope ephemeral for what is derived, local for what the person chose):
//   lintPrefsDecl(name)  local: `on` (spelling and grammar checking), `ignored` (keys of findings the person ignored, kept across reloads)
//   lintViewDecl(name)   ephemeral: `results` { lineId: { h, items } } keyed by line id AND the hash of the text that was checked (a result for text
//                        that has since changed is never shown: `fresh`), `hover` (the finding the pointer is over, { id, from, to, cls } or null),
//                        `status` (idle | loading | ready | error)
//   dictDecl(name)       cloud: the personal dictionary as an op log of `dict.add` / `dict.remove` (last in the total order wins per word),
//                        delivered to the app's server by `dictSink`; dictCacheDecl(name) is the server's words for the offline paint (scope local);
//                        `dictWords(cache, pending)` is the view (the server's words plus what is not acknowledged yet).
// Every action is absolute, total (junk is a no-op) and idempotent; a toggle is a gesture the app resolves against what the person saw (A6).
import { declare, fromStreamEntry } from '../model.js';
import { postOps, isOffline } from '../comments-transport.js';
import { field, scratch, on, set } from '../schema.js';
import { registerGenerator } from '../declare-keys.js';
import { scan, markRanges } from './decorate.js';

/** The checker's kinds (Harper's `lint_kind`) the kit shows. Spelling is a word that is not one; grammar is a phrase that reads wrong.
 *  Not shown: Capitalization, Style, Readability, Formatting, Redundancy, WordChoice, Enhancement, Regionalism: notes are written
 *  fast and lowercase, and a checker that underlines every habit is switched off. */
export const SPELLING_KINDS = Object.freeze(['Spelling', 'Typo']);
export const GRAMMAR_KINDS = Object.freeze(['Grammar', 'Agreement', 'Repetition', 'Eggcorn', 'Malapropism', 'BoundaryError', 'Nonstandard', 'Usage', 'Miscellaneous', 'Punctuation']);
export const SHOWN_KINDS = Object.freeze([...SPELLING_KINDS, ...GRAMMAR_KINDS]);
/** 'spelling' | 'grammar' | null for a checker kind. */
export const classOf = (kind) => (SPELLING_KINDS.includes(kind) ? 'spelling' : GRAMMAR_KINDS.includes(kind) ? 'grammar' : null);

export const MAX_SUGGESTIONS = 5;
export const MAX_LINT_TEXT = 4000; // a line longer than this is not checked (a pasted blob; the checker's time is the typist's)
const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v, n = 400) => (typeof v === 'string' ? v.slice(0, n) : '');
const int = (v) => (Number.isInteger(v) ? v : Math.floor(Number(v)));

// ------------------------------------------------------------------------------------------------------- prose of a line
const GAP_KINDS = new Set(['code', 'math', 'dmath', 'url', 'chip']);

/** The prose of a line's text and where each of its characters came from: { prose, map } with `map[i]` the offset in `text` of prose[i]
 *  (UTF-16 code units, the offsets the editor counts). opts: `marks(text) -> [{ text, cls, marker, fold }]` (the app's inline marks, as for
 *  `decorate.js inline`: their delimiters are dropped), `skip(text) -> [{ from, to }]` (more runs to drop). Deterministic and total. */
export function proseOf(text, { marks = null, skip = null } = {}) {
  const src = typeof text === 'string' ? text : '';
  const n = src.length, drop = new Uint8Array(n);
  const cut = (a, b) => { for (let i = Math.max(0, a); i < Math.min(n, b); i += 1) drop[i] = 1; };
  const spans = scan(src);
  for (const sp of spans) {
    if (GAP_KINDS.has(sp.kind)) cut(sp.from, sp.to);
    else if (sp.kind === 'link') { cut(sp.from, sp.label[0]); cut(sp.label[1], sp.to); } // `[label](url)`: the label is prose
  }
  if (marks) for (const r of markRanges(src, spans, marks)) if (r.marker) cut(r.from, r.to);
  if (skip) for (const r of skip(src) || []) if (r && Number.isInteger(r.from) && Number.isInteger(r.to)) cut(r.from, r.to);
  let prose = ''; const map = []; let gap = false;
  for (let i = 0; i < n; i += 1) {
    if (drop[i]) { gap = true; continue; }
    if (gap && prose && /\s/u.test(prose[prose.length - 1]) && /\s/u.test(src[i])) { gap = false; continue; } // "see `x` now": one blank
    gap = false; prose += src[i]; map.push(i);
  }
  return { prose, map };
}

/** A span [start, end) of the prose as a span [from, to) of the text, or null when it is not contiguous there (it crosses dropped characters). */
export function toSource(map, start, end) {
  if (!Array.isArray(map) || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > map.length || end <= start) return null;
  const from = map[start], to = map[end - 1] + 1;
  return to - from === end - start ? { from, to } : null;
}

/** A short stable hash of a line's text (FNV-1a over UTF-16 units, plus the length): the key a result is stored under with the line id. */
export function lintHash(text) {
  const s = String(text ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${h.toString(36)}.${s.length}`;
}

// -------------------------------------------------------------------------------------------------------------- findings
/** The key an ignore and a dictionary word go by: a spelling is its lowercased word, a grammar finding its message and words. */
export const itemKey = (cls, word, msg = '') => (cls === 'spelling' ? `s:${String(word).toLowerCase()}` : `g:${String(msg).toLowerCase()}:${String(word).toLowerCase()}`).slice(0, 160);

/** One finding repaired, or null. Offsets are the text's. `sug` are the replacements the checker offered, in its order. */
export function cleanItem(v) {
  const p = plain(v), from = int(p.from), to = int(p.to), cls = p.cls === 'grammar' ? 'grammar' : p.cls === 'spelling' ? 'spelling' : null;
  if (!cls || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > MAX_LINT_TEXT * 2) return null;
  const word = str(p.word, 80), msg = str(p.msg, 200), sug = (Array.isArray(p.sug) ? p.sug : []).filter((s) => typeof s === 'string' && s.length <= 80 && s !== word).slice(0, MAX_SUGGESTIONS);
  return { from, to, cls, kind: str(p.kind, 24), word, msg, sug, key: itemKey(cls, word, msg) };
}

/** Does a raw checker finding earn an underline? Spelling: not when the only thing wrong is the case ("alice" for "Alice": notes are written in lowercase, and a
 *  name is not a misspelling). Miscellaneous (a grab bag in Harper: informal words, initialisms, hyphenation): only the wrong a/an, the one grammar slip in it
 *  worth a red line. */
export function earnsUnderline(r) {
  const cls = classOf(r?.kind); if (!cls) return false;
  if (r.kind === 'Miscellaneous' && !/indefinite article/i.test(String(r.message ?? ''))) return false;
  if (cls === 'spelling') { const w = String(r.text ?? '').toLowerCase(); if (w && (r.suggestions || []).some((s) => typeof s === 'string' && s.toLowerCase() === w)) return false; }
  return true;
}

/** Raw checker findings over `prose` ([{ start, end, kind, message, suggestions, text }], offsets in the prose) as findings over the line's text:
 *  only the shown kinds, only the ones that map to contiguous text, in text order, no two overlapping (the first stands). */
export function itemsFrom(raw, map, text) {
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!earnsUnderline(r)) continue;
    const cls = classOf(r.kind);
    const at = toSource(map, r.start, r.end); if (!at) continue;
    const item = cleanItem({ ...at, cls, kind: r.kind, word: r.text ?? String(text ?? '').slice(at.from, at.to), msg: r.message, sug: r.suggestions });
    if (item) out.push(item);
  }
  out.sort((a, b) => a.from - b.from || a.to - b.to); // the earlier, then the narrower, stands: a word beats the phrase around it
  const kept = [];
  for (const it of out) if (!kept.length || it.from >= kept[kept.length - 1].to) kept.push(it);
  return kept;
}

/** The findings of a stored result that are shown: not ignored, and a spelling is not in the personal dictionary. `ignored`: a Set of keys;
 *  `dict`: a Set of lowercased words. */
export function shownItems(entry, { ignored = null, dict = null } = {}) {
  if (!entry?.items?.length) return [];
  return entry.items.filter((it) => !(ignored && ignored.has(it.key)) && !(it.cls === 'spelling' && dict && dict.has(it.word.toLowerCase())));
}

/** The finding that covers text offset `off` (from <= off < to), or null. */
export function lintAt(items, off) { for (const it of items || []) if (it.from <= off && off < it.to) return it; return null; }

/** A stored result is current for a line's text only if it was made for exactly that text. */
export const fresh = (entry, text) => Boolean(entry) && entry.h === lintHash(text);

/** The editor `input` action that applies a suggestion: one replacement of the finding's characters (a text edit through the one reducer,
 *  undoable with ⌘Z like typing; the kit editor maps insertReplacementText to a splice). null when it cannot apply. */
export function fixAction(rowId, item, replacement) {
  if (typeof rowId !== 'string' || !item || typeof replacement !== 'string') return null;
  return { type: 'input', inputType: 'insertReplacementText', text: replacement, sel: { a: { id: rowId, off: item.from }, f: { id: rowId, off: item.to } } };
}

/** The suggestion in the case of the word it replaces: "Teh" -> "The", "TEH" -> "THE" (the checker's own spelling is kept otherwise). */
export function matchCase(word, replacement) {
  if (!word || !replacement) return replacement;
  if (word.length > 1 && word === word.toUpperCase() && word !== word.toLowerCase()) return replacement.toUpperCase();
  if (word[0] !== word[0].toLowerCase() && word.slice(1) === word.slice(1).toLowerCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

// ------------------------------------------------------------------------------------------------------------------ state
const cleanIgnored = (v) => [...new Set((Array.isArray(v) ? v : []).filter((k) => typeof k === 'string' && k.length > 2 && k.length <= 160))].slice(-400);
const cleanResults = (v) => {
  const out = {};
  for (const [id, e] of Object.entries(plain(v)).slice(-4000)) { const p = plain(e); if (typeof p.h === 'string') out[id] = { h: p.h.slice(0, 40), items: (Array.isArray(p.items) ? p.items : []).map(cleanItem).filter(Boolean).slice(0, 200) }; }
  return out;
};
const cleanHover = (v) => { const p = plain(v), from = int(p.from), to = int(p.to); return typeof p.id === 'string' && p.id && Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to > from ? { id: p.id.slice(0, 128), from, to, cls: p.cls === 'grammar' ? 'grammar' : 'spelling' } : null; };
export const LINT_STATUSES = Object.freeze(['idle', 'loading', 'ready', 'error']);
const MAX_RESULT_LINES = 3000;

/** What the person chose about checking, kept across reloads. `lint.on` is absolute (the menu's toggle is a gesture resolved to it). */
export const lintPrefsDecl = (name) => {
  const d = declare({
    name, scope: 'local',
    fields: { on: field(true, (v) => v !== false), ignored: field([], cleanIgnored) },
    actions: {
      'lint.on': set('on', 'on'),
      'lint.ignore': on('ignored', (list, { key } = {}) => (typeof key === 'string' && key.length > 2 && key.length <= 160 && !list.includes(key) ? cleanIgnored([...list, key]) : list)),
      'lint.unignore': on('ignored', (list, { key } = {}) => (list.includes(key) ? list.filter((k) => k !== key) : list)),
    },
  });
  registerGenerator(name, (r) => {
    const k = r.int(0, 2), key = r.pick(['s:teh', 's:speling', 'g:incorrect article:an', 'x', '']);
    if (k === 0) return ['lint.on', { on: r.pick([true, false, 'x']) }];
    return [k === 1 ? 'lint.ignore' : 'lint.unignore', { key }];
  });
  return d;
};

/** The checker's findings per line and what the pointer is over: derived, in memory only. */
export const lintViewDecl = (name) => {
  const d = declare({
    name, scope: 'ephemeral',
    fields: { results: scratch({}), hover: scratch(null), status: scratch('idle') },
    actions: {
      // a result for a line: absolute (the line's whole result replaces the last), idempotent by value
      'lint.result': on('results', (res, { id, h, items } = {}) => {
        if (typeof id !== 'string' || !id || typeof h !== 'string' || !h) return res;
        const entry = { h: h.slice(0, 40), items: (Array.isArray(items) ? items : []).map(cleanItem).filter(Boolean).slice(0, 200) };
        const have = res[id];
        if (have && have.h === entry.h && JSON.stringify(have.items) === JSON.stringify(entry.items)) return res;
        const next = { ...res, [id]: entry }, ids = Object.keys(next);
        if (ids.length > MAX_RESULT_LINES) for (const old of ids.slice(0, ids.length - MAX_RESULT_LINES)) if (old !== id) delete next[old];
        return next;
      }),
      // lines that are gone (deleted, or far outside the window): their results are dropped; the lines named are the ones to keep when `keep` is given
      'lint.forget': on('results', (res, { ids, keep } = {}) => {
        const drop = Array.isArray(ids) ? ids.filter((i) => typeof i === 'string' && res[i]) : Array.isArray(keep) ? Object.keys(res).filter((i) => !keep.includes(i)) : [];
        if (!drop.length) return res;
        const next = { ...res }; for (const i of drop) delete next[i];
        return next;
      }),
      'lint.hover': on('hover', (_, p) => cleanHover(p)),
      'lint.status': on('status', (_, { status } = {}) => (LINT_STATUSES.includes(status) ? status : 'idle')),
    },
  });
  registerGenerator(name, (r) => {
    const k = r.int(0, 4), id = r.pick(['l1', 'l2', 'l3']), item = () => ({ from: r.int(0, 4), to: r.int(3, 9), cls: r.pick(['spelling', 'grammar', 'x']), kind: 'Spelling', word: 'teh', msg: 'm', sug: ['the'] });
    if (k === 0) return ['lint.result', { id, h: r.pick(['a.3', 'b.4']), items: r.chance(0.7) ? [item(), item()] : r.pick([[], null, 'x']) }];
    if (k === 1) return ['lint.forget', r.chance(0.5) ? { ids: [id] } : { keep: [id] }];
    if (k === 2) return ['lint.hover', r.chance(0.7) ? { id, from: r.int(0, 3), to: r.int(2, 8), cls: r.pick(['spelling', 'grammar']) } : null];
    if (k === 3) return ['lint.status', { status: r.pick([...LINT_STATUSES, 'bogus']) }];
    return ['lint.result', { id: 7, h: 3 }];
  });
  return d;
};

// ----------------------------------------------------------------------------------------------- the personal dictionary
export const WORD_RE = /^[\p{L}\p{M}\d][\p{L}\p{M}\d'’.-]{0,62}$/u;
/** A dictionary word repaired (trimmed, apostrophes straight), or null. Case is kept as typed; matching is by lowercase. */
export const cleanWord = (w) => { const s = typeof w === 'string' ? w.trim().replace(/’/g, "'") : ''; return WORD_RE.test(s) ? s : null; };
const wordKey = (w) => w.toLowerCase();

/** The device's dictionary ops: an op log (scope cloud) of add and remove, delivered to the app's server (`dictSink`). `words` maps a
 *  lowercased word to { word, on } and the later op in the total order wins, so adding then removing then adding is on and a replay is a no-op. */
export const dictDecl = (name) => {
  const d = declare({
    name, scope: 'cloud',
    fields: { words: field({}, (v) => Object.fromEntries(Object.entries(plain(v)).map(([k, e]) => [k, cleanEntry(e)]).filter(([k, e]) => e && wordKey(e.word) === k).slice(-2000))) },
    actions: { 'dict.add': on('words', (w, p) => put(w, p, true)), 'dict.remove': on('words', (w, p) => put(w, p, false)) },
  });
  registerGenerator(name, (r) => [r.pick(['dict.add', 'dict.remove']), r.chance(0.9) ? { word: r.pick(['Hix', 'zai', 'nova', 'x y', '']) } : { word: 7 }]);
  return d;
};
function cleanEntry(e) { const p = plain(e), word = cleanWord(p.word); return word ? { word, on: p.on !== false } : null; }
function put(words, payload, onOff) {
  const word = cleanWord(plain(payload).word); if (!word) return words;
  const have = words[wordKey(word)];
  return have && have.on === onOff && have.word === word ? words : { ...words, [wordKey(word)]: { word, on: onOff } };
}
/** The server's words, for the offline paint (scope local). */
export const dictCacheDecl = (name) => {
  const d = declare({
    name, scope: 'local',
    fields: { words: field([], (v) => [...new Set((Array.isArray(v) ? v : []).map(cleanWord).filter(Boolean))].slice(0, 2000)) },
    actions: { 'words.set': set('words', 'words') },
  });
  registerGenerator(name, (r) => ['words.set', { words: r.chance(0.8) ? r.pick([['Hix'], ['zai', 'nova'], []]) : r.pick([null, 'x']) }]);
  return d;
};
/** The dictionary as a Set of lowercased words: the server's words (`cache`: array), then the ops not acknowledged yet (`pending`: log entries
 *  { type, payload }) in order. */
export function dictWords(cache = [], pending = []) {
  const words = new Set((cache || []).map(cleanWord).filter(Boolean).map(wordKey));
  for (const e of pending || []) {
    const w = cleanWord(e?.payload?.word); if (!w) continue;
    if (e.type === 'dict.add') words.add(wordKey(w)); else if (e.type === 'dict.remove') words.delete(wordKey(w));
  }
  return words;
}

/** The dictionary op log's transport (the app's server is the sink: a person's words belong to the person, not to a document). push sends the
 *  entries in log order as one batch through `post(ops)` (default postOps(url): { ops } as JSON), whose answer carries the server's words
 *  (`words`), which `adopt` takes; offline leaves the entries pending for the next sync, a refusal for good is reported and acknowledged. */
export function dictSink({ url = null, post = url ? postOps(url) : null, adopt = () => {}, refuse = () => {} }) {
  if (typeof post !== 'function') throw new Error('dictSink: give url or post');
  return {
    async push(_stream, entries) {
      const ops = entries.map(fromStreamEntry).map(({ type, payload }) => ({ type, payload }));
      if (!ops.length) return;
      try { const answer = await post(ops); if (Array.isArray(answer?.words)) adopt(answer.words); }
      catch (e) { if (isOffline(e)) throw e; refuse(String(e?.message || e)); }
    },
    async pull(_stream, cursor) { return { entries: [], cursor: cursor ?? null, more: false }; },
  };
}
