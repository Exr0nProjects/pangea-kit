// Pointer aimed at lines: hover (which row the pointer rests on) and the line drag (grip or hold), for kit editors over ordered rows.
// Ported from old zai's notes-drag.js and hoverChord (webchat/src/lib/client/notes-drag.js, NotesEditor.svelte hoverRow/hoverChord), made
// kit-owned (PANGEA3-DESIGN §15 laws 1 and 3): nothing here holds state the editor does not.
//
//   createLinePointer({ holdMs, slop, edge, maxSpeed }) -> manager; pass it to createEditor({ linePointer }); createEditor calls
//   manager.attach(editor) once and manager.paint() inside every commit.
//
// What the kit state holds (lib/editor/editor.js step):
//   state.hover  the row id under the pointer, or null (action `hover { row }`; the app's chords read it: aimed at that row when it is
//                not the caret's own line). Set from pointermove, cleared when the pointer leaves the editor or a drag starts.
//   state.drag   { id, to } while a line is carried (`drag { op: 'start' | 'over' | 'cancel' | 'drop', row, to: { id, after } }`): `id`
//                the grabbed row (its subtree travels), `to` the place it would land. The app draws everything from it (the carried lines
//                greyed, the drop line, the compact view); the one document write is `drop`, an absolute move (lines.js dropLines).
// What the adapter holds is only the pointer gesture itself (which pointer, where it went down, the hold timer, the edge-scroll frame),
// as embed.js does for its resize grip; the state it paints is state.drag.
//
// A grip is any element carrying `data-qk-grip` inside a line (the app draws it, inert): it carries the line as soon as it moves 3 px;
// a press on it that does not move is a click, nothing else. A hold (the pointer still, `holdMs`) on a line's text picks the line up; a
// move beyond `slop` first is a selection or a scroll and cancels the hold. While carrying: the pointer at the top or bottom edge of the
// scroller keeps scrolling (a frame loop, since a pointer held still fires no events), Escape cancels, so does anything that ends a
// gesture (pointercancel, lost capture, blur, the page hiding). The grabbed row is the scroll anchor from the press, so the compact view
// the app draws does not move it. The root carries `data-qk-dragging` while a line is carried (CSS: cursor, no text selection).

const EDGE_PX = 72, MAX_SPEED = 26;

export function createLinePointer({ holdMs = 500, slop = 6, edge = EDGE_PX, maxSpeed = MAX_SPEED } = {}) {
  let ed = null, press = null, disposed = false;
  const offs = [];

  const lineEl = (t) => { const l = t?.closest?.('[data-addr]'); return l && ed.root.contains(l) && !l.closest('[data-qk-embed-body]') ? l : null; };

  function attach(editor) {
    ed = editor;
    const root = ed.root, W = root.ownerDocument.defaultView;
    const on = (t, type, f, o) => { t.addEventListener(type, f, o); offs.push(() => t.removeEventListener(type, f, o)); };
    on(root, 'pointermove', onHover, { passive: true });
    on(root, 'pointerleave', () => { if (ed.state.hover !== null && !ed.state.drag) ed.dispatch({ type: 'hover', row: null }); }, { passive: true });
    on(root, 'pointerdown', onDown, { capture: true });
    on(W, 'blur', () => end(false));
    on(root.ownerDocument, 'visibilitychange', () => { if (root.ownerDocument.visibilityState === 'hidden') end(false); });
  }

  function onHover(e) {
    if (e.pointerType === 'touch' || press?.active) return; // no hover on touch; a carried line has its own aim
    const l = lineEl(e.target), row = l ? l.getAttribute('data-addr') : null;
    if (row !== ed.state.hover) ed.dispatch({ type: 'hover', row }, { ts: e.timeStamp });
  }

  function onDown(e) {
    if (press) return;
    const root = ed.root;
    if (e.button !== 0 || e.isPrimary === false) return;
    if (e.target.closest?.('[data-qk-embed-body]')) return;
    // touch has no hover: a tap on a line's gutter (an inert `data-qk-gutter` the app draws in the margin) brings up that row's grip and chevron (state.gutter);
    // the tap puts no caret in the text and folds nothing; a press anywhere else puts them away. The owner 2026-10-24 12:49 PDT: "mobile , needs to have a better
    // solution bc its currently drag handle and carrat spam maybe if u tap that area then it shows up?"
    const gz = e.target.closest?.('[data-qk-gutter]');
    if (gz && root.contains(gz) && e.pointerType !== 'mouse') {
      const l = lineEl(gz); if (!l) return;
      e.preventDefault(); e.stopPropagation();
      const row = l.getAttribute('data-addr');
      if (ed.state.gutter !== row) ed.dispatch({ type: 'gutter', row }, { ts: e.timeStamp });
      return;
    }
    if (ed.state.gutter && !e.target.closest?.('[data-qk-grip], [data-action=fold]')) ed.dispatch({ type: 'gutter', row: null }, { ts: e.timeStamp });
    const grip = e.target.closest?.('[data-qk-grip]');
    if (grip && root.contains(grip)) {
      const l = lineEl(grip); if (!l) return;
      e.preventDefault(); e.stopPropagation(); // the editor must not take this press (no selection gesture, no focus move)
      if (ed.readOnly) return;
      press = { pid: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, row: l.getAttribute('data-addr'), grip: true, active: false, timer: 0, frame: 0, touch: e.pointerType === 'touch' };
      listen(e);
      return;
    }
    if (ed.readOnly || e.target.closest?.('[data-action], a, button, input, textarea')) return;
    const l = lineEl(e.target); if (!l) return;
    press = { pid: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, row: l.getAttribute('data-addr'), grip: false, active: false, timer: 0, frame: 0, touch: e.pointerType === 'touch' };
    press.timer = root.ownerDocument.defaultView.setTimeout(() => { press.timer = 0; activate(); }, holdMs);
    listen(e);
  }

  function listen() {
    const W = ed.root.ownerDocument.defaultView, p = press;
    const mv = (e) => {
      if (e.pointerId !== p.pid) return;
      p.x = e.clientX; p.y = e.clientY;
      if (!p.active) {
        const moved = Math.hypot(p.x - p.x0, p.y - p.y0);
        if (p.grip && moved > 3) activate();
        else if (!p.grip && moved > slop) end(false); // a selection or a scroll, not a pick-up
        if (!p.active) return;
      }
      e.preventDefault?.();
      place();
    };
    const up = (e) => { if (e.pointerId === p.pid) end(true); };
    const cancel = (e) => { if (e.pointerId === p.pid) end(false); };
    const key = (e) => { if (p.active && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); } };
    const touch = (e) => { if (p.active && e.cancelable) e.preventDefault(); }; // the held finger carries, it does not scroll the page
    const ctx = (e) => { if (p.active) e.preventDefault(); };
    W.addEventListener('pointermove', mv, { capture: true });
    W.addEventListener('pointerup', up, { capture: true });
    W.addEventListener('pointercancel', cancel, { capture: true });
    W.addEventListener('keydown', key, { capture: true });
    W.addEventListener('touchmove', touch, { passive: false, capture: true });
    W.addEventListener('contextmenu', ctx, { capture: true });
    p.off = () => {
      W.removeEventListener('pointermove', mv, { capture: true }); W.removeEventListener('pointerup', up, { capture: true });
      W.removeEventListener('pointercancel', cancel, { capture: true }); W.removeEventListener('keydown', key, { capture: true });
      W.removeEventListener('touchmove', touch, { capture: true }); W.removeEventListener('contextmenu', ctx, { capture: true });
    };
  }

  function activate() {
    const p = press; if (!p || p.active || disposed) return;
    const W = ed.root.ownerDocument.defaultView, el = ed.elOf(p.row);
    if (!el) { end(false); return; }
    // the grabbed row is the anchor from now on, at the px it is drawn at: the app's compact view removes rows around it, and the kit's anchor keeps it still
    const sr = ed.scroller.getBoundingClientRect();
    ed.dispatch({ type: 'scroll', anchor: { id: p.row, px: Math.round((el.getBoundingClientRect().top - sr.top - ed.scroller.clientTop) * 10) / 10 }, follow: 'free' });
    ed.dispatch({ type: 'hover', row: null });
    ed.dispatch({ type: 'drag', op: 'start', row: p.row });
    if (!ed.state.drag) { end(false); return; }
    p.active = true;
    try { ed.root.setPointerCapture(p.pid); } catch { /* a synthetic pointer has no active capture */ }
    const tick = () => { if (!press || press !== p || !p.active) return; roll(); p.frame = W.requestAnimationFrame(tick); };
    p.frame = W.requestAnimationFrame(tick);
    place();
  }

  /** Where the pointer is now, as a place in the document: the line under it and the half it is in. One absolute `over` per change. */
  function place() {
    const p = press; if (!p?.active) return;
    const D = ed.root.ownerDocument, l = lineEl(D.elementFromPoint(p.x, p.y));
    let to = null;
    if (l) { const r = l.getBoundingClientRect(); to = { id: l.getAttribute('data-addr'), after: p.y > r.top + r.height / 2 }; }
    const cur = ed.state.drag?.to;
    if ((cur?.id ?? null) === (to?.id ?? null) && (cur?.after ?? null) === (to?.after ?? null)) return;
    ed.dispatch({ type: 'drag', op: 'over', row: p.row, to });
  }

  /** The edge pull: a pointer held still near the top or bottom of the scroller keeps scrolling the document. */
  function roll() {
    const p = press; if (!p?.active) return;
    const W = ed.root.ownerDocument.defaultView, b = ed.scroller.getBoundingClientRect(), vv = W.visualViewport;
    const floor = vv ? Math.min(b.bottom, vv.offsetTop + vv.height) : b.bottom, ceil = b.top;
    const speed = (into) => Math.min(maxSpeed, 3 + Math.max(0, into) / 3);
    let step = 0;
    if (p.y < ceil + edge) step = -speed(ceil + edge - p.y); else if (p.y > floor - edge) step = speed(p.y - (floor - edge));
    if (!step) return;
    ed.scrollBy(step);
    place();
  }

  /** The gesture ends: a drop where the pointer was (commit and a place under it), else a cancel. Always leaves nothing stuck. */
  function end(commit) {
    const p = press; if (!p) return;
    press = null;
    const W = ed.root.ownerDocument.defaultView;
    if (p.timer) W.clearTimeout(p.timer);
    if (p.frame) W.cancelAnimationFrame(p.frame);
    p.off?.();
    try { ed.root.releasePointerCapture?.(p.pid); } catch { /* already released */ }
    if (disposed || !ed.state.drag) return;
    const to = ed.state.drag.to;
    if (commit && to) ed.dispatch({ type: 'drag', op: 'drop', row: p.row, to });
    else ed.dispatch({ type: 'drag', op: 'cancel' });
  }

  /** Output only, inside the editor's commit: the root says a line is carried (CSS: grabbing cursor, no text selection). */
  function paint() { if (!ed) return; const on = Boolean(ed.state.drag); if (ed.root.hasAttribute('data-qk-dragging') !== on) ed.root.toggleAttribute('data-qk-dragging', on); }

  function dispose() { disposed = true; end(false); for (const f of offs.splice(0)) f(); }

  return { attach, paint, dispose, get active() { return Boolean(press?.active); } };
}
