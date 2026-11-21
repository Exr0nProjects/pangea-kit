// The DOM end of spelling and grammar checking (state and pure functions: lib/editor/lint.js; PANGEA3-DESIGN §15 "Spelling and grammar").
// Three jobs, none of which writes into the editor's DOM (law 1, law 5: the dev mutation observer stays silent):
//   RUN    every line the editor draws is checked once for the text it has, and again only when that line's text changes: a result is stored
//          under (line id, hash of the text checked) in kit state, a line whose hash already has a result is never sent, a changed line waits
//          `debounceMs` after its last change (a line never checked goes at once), one check runs at a time and never on the typing thread
//          (the app's `check` is a Web Worker). A result for text that has since changed is dropped, not shown. A check that FAILS (the checker's
//          binary did not load yet, the network dropped, a timeout) is not final: the line is asked again after a backoff (5 s, doubling to 5 min,
//          reset by the first success), never marked as failed until its text changes.
//   HOVER  the finding under the pointer is kit state (`lint.hover`, view state like `state.hover`): set from the render map (point -> address
//          -> a finding whose characters' boxes contain the pointer), cleared when the pointer leaves it. Nothing is drawn at rest.
//   PAINT  the hovered finding's characters get the CSS Custom Highlight `zai-lint` (spelling) or `zai-lint-g` (grammar) over `editor.rangeOf`,
//          a Range outside the tree, so the editor's DOM is untouched; the app's stylesheet draws it (a dotted or wavy red underline).
// `check(prose) -> Promise<[{ start, end, kind, message, suggestions, text }]>` is injected (zai3: Harper in a Web Worker).
import { lintHash, shownItems, lintAt, itemsFrom, MAX_LINT_TEXT } from './lint.js';

const NAMES = { spelling: 'zai-lint', grammar: 'zai-lint-g' };

/** Mount checking, hover and painting over one kit editor. prefs: the lintPrefsDecl store; view: the lintViewDecl store; dict(): the Set of
 *  lowercased dictionary words; prose(text) -> { prose, map } (the app's `proseOf` with its marks and skips); pinned(): true while a menu
 *  holds the hovered finding (the underline stays under the pointer that left). Returns { sweep, at, shown, refresh, dispose }. */
export function mountLint({ editor, prefs, view, dict = () => new Set(), check, prose, debounceMs = 450, firstMs = 40, retryMs = 5000, retryMaxMs = 300_000, pinned = () => false, names = NAMES }) {
  const root = editor.root, W = root.ownerDocument.defaultView;
  const pending = new Map();       // line id -> { h, due }: lines waiting for a check (adapter bookkeeping; the results are kit state)
  const failed = new Map();        // line id -> { h, until }: the text whose check threw and when it may be asked again (a backoff, never forever)
  let strikes = 0, retryTimer = null;
  let busy = false, timer = null, frame = 0, paintFrame = 0, moveFrame = 0, disposed = false, last = null;
  const on = () => prefs.get().on;
  const ignoredSet = () => new Set(prefs.get().ignored);
  const textOf = (id) => editor.rowText(id);

  /** The shown findings of a line (fresh result, not ignored, not in the dictionary), or []. */
  function shown(id) {
    const text = textOf(id); if (typeof text !== 'string') return [];
    const e = view.get().results[id];
    return e && e.h === lintHash(text) ? shownItems(e, { ignored: ignoredSet(), dict: dict() }) : [];
  }

  // ------------------------------------------------------------------------------------------------------------ run
  function sweep() {
    frame = 0; if (disposed || !on() || editor.state.composing) return;
    const items = editor.items, w = editor.window, results = view.get().results, now = W.performance.now();
    let wake = Infinity;
    for (let i = Math.max(0, w.start - 4); i < Math.min(items.length, w.end + 4); i += 1) {
      const id = items[i]?.addr; if (id == null || items[i].embed) continue;
      const text = textOf(id);
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_LINT_TEXT) continue;
      const h = lintHash(text), have = results[id];
      if (have?.h === h) { pending.delete(id); continue; }
      const f = failed.get(id);
      if (f && f.h === h && now < f.until) { pending.delete(id); wake = Math.min(wake, f.until); continue; } // asked again once its backoff is over
      const p = pending.get(id);
      if (p?.h === h) continue;                     // already waiting for exactly this text
      pending.set(id, { h, due: now + (have ? debounceMs : firstMs) }); // a line changed since its result waits for the typing to pause
    }
    arm();
    if (retryTimer) { W.clearTimeout(retryTimer); retryTimer = null; }
    if (wake < Infinity) retryTimer = W.setTimeout(() => { retryTimer = null; askSweep(); }, Math.max(50, wake - W.performance.now()) + 20);
  }
  const askSweep = () => { if (!frame && !disposed) frame = W.requestAnimationFrame(sweep); };
  function arm() {
    if (timer) { W.clearTimeout(timer); timer = null; }
    if (disposed || busy || !pending.size) return;
    const next = Math.min(...[...pending.values()].map((p) => p.due));
    timer = W.setTimeout(pump, Math.max(0, next - W.performance.now()));
  }
  async function pump() {
    timer = null; if (disposed || busy) return;
    busy = true;
    try {
      for (;;) {
        const now = W.performance.now();
        const due = [...pending].filter(([, p]) => p.due <= now).sort((a, b) => a[1].due - b[1].due)[0];
        if (!due || disposed || !on()) break;
        const [id, p] = due; pending.delete(id);
        const text = textOf(id);
        if (typeof text !== 'string' || lintHash(text) !== p.h) continue;       // changed since it was queued: the sweep queues the new text
        const { prose: words, map } = prose(text);
        let items = [];
        if (words.trim()) {
          if (view.get().status !== 'ready') view.dispatch('lint.status', { status: 'loading' });
          try { items = itemsFrom(await check(words), map, text); }
          catch { strikes += 1; failed.set(id, { h: p.h, until: W.performance.now() + Math.min(retryMaxMs, retryMs * 2 ** (strikes - 1)) }); view.dispatch('lint.status', { status: 'error' }); askSweep(); continue; }
        }
        if (disposed) break;
        if (typeof textOf(id) !== 'string' || lintHash(textOf(id)) !== p.h) continue; // changed while the checker ran
        strikes = 0; failed.delete(id);
        view.dispatch('lint.result', { id, h: p.h, items });
        if (view.get().status !== 'ready') view.dispatch('lint.status', { status: 'ready' });
      }
    } finally { busy = false; }
    arm();
    askPaint();
  }

  // ---------------------------------------------------------------------------------------------------------- hover
  /** The finding under a viewport point: { id, off, item } (item null: a line with no finding there) or null off the text. The pointer must be
   *  inside the boxes of the finding's characters (a point to the right of a line's end is on no word). */
  function at(x, y) {
    const a = editor.addrAtPoint(x, y); if (!a) return null;
    const items = shown(a.id);
    const it = lintAt(items, a.off) || lintAt(items, a.off - 1);
    if (!it) return { id: a.id, off: a.off, item: null };
    const r = editor.rangeOf(a.id, it.from, it.to); if (!r) return { id: a.id, off: a.off, item: null };
    for (const b of r.getClientRects()) if (x >= b.left - 1 && x <= b.right + 1 && y >= b.top - 2 && y <= b.bottom + 2) return { id: a.id, off: a.off, item: it };
    return { id: a.id, off: a.off, item: null };
  }
  const inNested = (el) => { const b = el?.closest?.('[data-qk-embed-body]'); return Boolean(b) && b !== root && root.contains(b); }; // an embedded editor's text is its own editor's
  /** Set the hover to what is under `pt` ({ clientX, clientY, target }) now, or to nothing when there is no point or no finding there. */
  function settle(pt) {
    const doc = root.ownerDocument, el = pt && (doc.elementFromPoint ? doc.elementFromPoint(pt.clientX, pt.clientY) : pt.target); // what is on top at that point: a menu over the text is not the text
    const t = pt && on() && el && (root.contains ? root.contains(el) : true) && !inNested(el) ? at(pt.clientX, pt.clientY) : null;
    const next = t?.item ? { id: t.id, from: t.item.from, to: t.item.to, cls: t.item.cls } : null, cur = view.get().hover;
    if ((next?.id ?? null) !== (cur?.id ?? null) || next?.from !== cur?.from || next?.to !== cur?.to) view.dispatch('lint.hover', next);
  }
  function move() {
    moveFrame = 0; if (disposed || !last) return;
    const e = last; last = null;
    if (pinned()) return;
    settle(e);
  }
  // the last place the pointer was, kept even while a menu holds the hover (the pointer moving over the menu is not over the text): when the menu closes the hover
  // is what is under that place now, never what the menu was opened on
  let seen = null;
  const onMove = (e) => { last = e; if (!moveFrame) moveFrame = W.requestAnimationFrame(move); };
  const onSeen = (e) => { seen = { clientX: e.clientX, clientY: e.clientY, target: e.target }; }; // the document's pointermove: also over a menu, which is not over the root
  root.ownerDocument.addEventListener?.('pointermove', onSeen, { passive: true, capture: true });
  const onLeave = () => { last = null; if (!pinned() && view.get().hover) view.dispatch('lint.hover', null); };
  /** The hover is what is under the pointer now (after a menu closed or opened elsewhere); nothing while a menu still holds it. */
  const refresh = () => { if (!disposed && !pinned()) settle(seen); };
  root.addEventListener('pointermove', onMove, { passive: true });
  root.addEventListener('pointerleave', onLeave, { passive: true });

  // ---------------------------------------------------------------------------------------------------------- paint
  const mine = new Map();                                                       // highlight name -> the Highlight this mount set
  const clearPaint = () => { for (const [n, hl] of mine) { if (W.CSS?.highlights?.get(n) === hl) W.CSS.highlights.delete(n); } mine.clear(); };
  function paint() {
    paintFrame = 0; if (disposed) return;
    const H = view.get().hover, can = W.CSS && 'highlights' in W.CSS && typeof W.Highlight === 'function';
    if (!can) return;
    if (!H || !on()) { clearPaint(); return; }
    const it = shown(H.id).find((x) => x.from === H.from && x.to === H.to);
    if (!it) { clearPaint(); if (view.get().hover) view.dispatch('lint.hover', null); return; } // the text changed, or the finding was ignored: no underline
    const r = editor.rangeOf(H.id, H.from, H.to); if (!r) { clearPaint(); return; }
    const name = names[H.cls] ?? names.spelling;
    clearPaint();
    const hl = new W.Highlight(r); W.CSS.highlights.set(name, hl); mine.set(name, hl);
  }
  const askPaint = () => { if (!paintFrame && !disposed) paintFrame = W.requestAnimationFrame(paint); };

  const offs = [
    editor.subscribe(() => { askSweep(); if (view.get().hover) askPaint(); }),
    view.subscribe(askPaint),
    prefs.subscribe(() => { askSweep(); askPaint(); }),
  ];
  askSweep();
  return {
    sweep: askSweep, at, shown, refresh,
    dispose() {
      disposed = true; for (const f of offs) f?.();
      root.ownerDocument.removeEventListener?.('pointermove', onSeen, { capture: true }); root.removeEventListener('pointermove', onMove); root.removeEventListener('pointerleave', onLeave);
      if (timer) W.clearTimeout(timer); if (retryTimer) W.clearTimeout(retryTimer); if (frame) W.cancelAnimationFrame(frame); if (paintFrame) W.cancelAnimationFrame(paintFrame); if (moveFrame) W.cancelAnimationFrame(moveFrame);
      clearPaint(); pending.clear();
    },
  };
}
