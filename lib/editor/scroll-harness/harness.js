// The kit's own scroll harness (lib/editor/scroll-check.mjs drives it): a plain createEditor app over a paged in-memory
// doc whose rows wrap to 1-6 lines while the estimate says 18 px (so every first paint is unsettled), with the
// operations the scroll laws are about: land, prepend a page, append while following, an async answer re-rendering a
// row, a layout change no commit makes (body.late), and a reload that lands from the URL (#land=key:px).
import { createEditor, memoryLines } from '../editor.js';

const root = document.getElementById('doc'), scroller = document.getElementById('scroller');
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'the', 'notes', 'walk', 'call', 'tomorrow', 'measure', 'tank'];
const textOf = (r) => r.text;
const lineText = (k) => { const n = 3 + ((k * 7919) % 61); return Array.from({ length: n }, (_, j) => WORDS[(k + j * 5) % WORDS.length]).join(' ') + ` ${k}`; };
export const keyOf = (k) => `r${String(k).padStart(5, '0')}`;

const app = {
  init: () => ({}),
  items: (doc) => doc.lines().map((r) => ({ key: r.id, addr: r.id, row: r })),
  render: (it) => ({ tag: 'div', cls: it.row.ord % 3 === 0 ? 'ln g' : 'ln', addr: it.key, text: it.row.text }),
  estimate: () => 18,
  textOf,
  reduce: () => null,
};
const contract = { name: 'qk-scroll-harness', actions: [], budget_p95_ms: 100 };

function pagedDoc(rows, loaded, page) {
  const base = memoryLines(rows, { sortKey: (r) => [r.ord, r.id] });
  let from = Math.max(0, rows.length - loaded);
  return {
    lines: () => base.lines().slice(from), get: base.get, peek: base.peek, put: base.put,
    get reachedStart() { return from === 0; },
    loadOlder(n = page) { const before = from; from = Math.max(0, from - n); return Promise.resolve(before - from); },
    all: () => base.lines(),
  };
}

let editor = null, doc = null, nextOrd = 0;
const H = (window.__pangeaScroll = {
  /** { n rows, loaded (the last `loaded` rows are in the window), followEnd, land: { k (row number) | key, px } } */
  reset({ n = 1200, loaded = 300, followEnd = false, land = null } = {}) {
    editor?.dispose();
    document.body.classList.remove('late');
    const rows = Array.from({ length: n }, (_, k) => ({ id: keyOf(k), ord: k, text: lineText(k) }));
    nextOrd = n;
    doc = pagedDoc(rows, loaded, 300);
    editor = createEditor({ root, scroller, app, doc, contract, dev: true, followEnd });
    H.editor = editor; H.doc = doc;
    H.errors = [];
    if (land) editor.dispatch({ type: 'scroll', anchor: { id: land.key ?? keyOf(land.k), px: land.px } });
    return { lines: doc.lines().length, anchor: editor.state.anchor, follow: editor.state.follow };
  },
  /** One older page, applied the way an app applies an async page: data first, then one 'page' action. */
  async prepend(n = 300) { const got = await doc.loadOlder(n); editor.dispatch({ type: 'page' }); return got; },
  /** Rows at the end (a stream arriving). */
  append(count = 1) { const puts = []; for (let i = 0; i < count; i++) { const k = nextOrd++; puts.push({ id: keyOf(k), set: { ord: k, text: lineText(k) } }); } doc.put(puts); editor.dispatch({ type: 'remote' }); return puts.map((p) => p.id); },
  /** An async answer: after `ms`, row `key`'s text is replaced (it re-renders at another height). */
  answer(key, text, ms = 0) { return new Promise((ok) => setTimeout(() => { doc.put([{ id: key, set: { text } }]); editor.dispatch({ type: 'remote' }); ok(true); }, ms)); },
  /** A layout change no kit commit makes. */
  late(on = true) { document.body.classList.toggle('late', on); },
  keyOf,
  firstDrawn() { const top = scroller.getBoundingClientRect().top; const el = [...root.querySelectorAll('[data-addr]')].find((e) => e.getBoundingClientRect().bottom > top + 1); return el ? { key: el.getAttribute('data-addr'), y: el.getBoundingClientRect().top - top } : null; },
  checks() { const c = editor.checks; return { fresh: c.freshDiff(), unaddressed: c.unaddressed(), mutations: c.mutations(), errors: H.errors.length ? H.errors.slice(0, 3) : null }; },
});
window.addEventListener('error', (e) => { (H.errors ||= []).push(String(e.message)); });
const m = /#land=([^:]+):(-?\d+)/.exec(location.hash);
H.reset(m ? { land: { key: m[1], px: +m[2] } } : {});
window.__pangeaReady = true;
