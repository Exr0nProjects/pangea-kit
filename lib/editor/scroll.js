// Scroll, landing and paging as kit state (PANGEA3-DESIGN §15 law 1; conformance rows 36, 46, 55; DESIGN-CONFORMANCE §E
// step 1). The owner 2026-11-08 23:29-23:30 PST: "all state needs to be owned by the kit , including scroll state";
// "every interaction < 100ms visible response"; "kit should have some better picture of rendering and which
// statecomponents get rendered to which areas".
//
// The two bug classes this file exists to make impossible (census 2026-11-09: 18 scroll/landing + 15 paging fix commits):
//   1. scroll intent inferred from self-caused events: Chrome scroll anchoring, a clamp after content shrank, a focus()
//      or scrollIntoView, or the kit's own scrollTop write, read back as the user scrolling (E24 transcript stopped
//      following; E45 follow re-armed off layout growth; B13 an ack re-render moved the view).
//   2. landing on unsettled layout: a landing or an async answer applied against geometry measured before it arrived
//      (B10 anchor captured before the await, 500-600 px off; E25 prepend jump y 62 -> 31539; E46 transcript landed
//      3,151 px short).
//
// The design, by construction:
//   - Kit state (initState in editor.js): anchor = { id, px } (the item key and its top's distance below the viewport
//     top) and follow = 'free' | 'pinned' | 'bottom'. Changed only by the id-keyed 'scroll' action through the reducer.
//       pinned  a landing the app asked for (open, reload, back to NOW): held through every layout change; an anchor
//               whose row has not arrived yet is held, not dropped; released to free by the first user scroll
//       free    where the user scrolled to: also held through every layout change (prepend, answers, resize)
//       bottom  the end of the document stays at the viewport bottom (a transcript following a stream); a user scroll
//               away releases it; only a user scroll that reaches the end re-arms it (followEnd apps)
//   - scrollTop is output only: the kit writes it from (anchor, follow) after measuring, and every scroll event is
//     classified. The kit's own write is an echo (expectScroll). Otherwise it is the user's only inside an intent window
//     opened by user input (wheel, touch, key, pointer held on the scroller, which is also the scrollbar drag); any other
//     scroll (browser anchoring, clamp, focus scroll, a stray script write) is overwritten from the anchor.
//   - The browser's own scroll anchoring is switched off on the scroller (overflow-anchor: none): the kit is the one
//     anchoring writer.
//   - Settle-then-land: a ResizeObserver on every drawn row and on the scroller re-measures and re-resolves scrollTop
//     from the anchor after any layout change (fonts, decoration, an answer re-rendering, a viewport resize), in the same
//     frame, before paint. So a landing is applied against measured geometry however late it settles.
//
// intentTracker() is the classification; installAnchorProbe() is the frame-level recorder the browser checks use.

export const FOLLOW = ['free', 'pinned', 'bottom'];
/** A landing's lifecycle (PANGEA3-DESIGN §8 waits: a wait has a deadline and a declared exit): pending -> landed | failed.
 *  pending  the app asked to land on an item that is not drawn yet; the view is held (pinned) while it waits
 *  landed   the item was drawn: the landing holds as a pinned anchor until the user scrolls
 *  failed   the deadline passed without the item (createEditor landingDeadlineMs): released to free, anchor cleared, so
 *           the view stays where it is and a late row never yanks it; the app can show the failure from state */
export const LANDING = Object.freeze({ states: ['pending', 'landed', 'failed'], transitions: { pending: ['landed', 'failed'], landed: [], failed: [] }, wait: { state: 'pending', to: 'failed' } });

/** The reducer's half: an absolute scroll action. Payload { anchor?: {id, px} | null, follow?: FOLLOW, landing?: { id,
 *  since, status: 'landed' | 'failed' } }. The adapter's user scrolls carry follow 'free' or 'bottom'; an app's { anchor }
 *  alone is a landing (pinned), which starts a pending landing { id, status: 'pending', since: a.at }; a user scroll ends
 *  it (null). A landing outcome applies only to the pending landing it names (id and since), so a late or repeated
 *  outcome is a no-op. Total: nonsense is a no-op. */
export function scrollStep(state, a) {
  const l = a.landing;
  if (l && typeof l === 'object' && (l.status === 'landed' || l.status === 'failed')) {
    const cur = state.landing;
    if (!cur || cur.status !== 'pending' || cur.id !== l.id || cur.since !== (l.since ?? null)) return state;
    state.landing = { ...cur, status: l.status };
    if (l.status === 'failed' && state.follow === 'pinned' && state.anchor?.id === cur.id) { state.follow = 'free'; state.anchor = null; }
    return state;
  }
  const anchor = a.anchor && typeof a.anchor.id === 'string' && Number.isFinite(a.anchor.px) ? { id: a.anchor.id, px: a.anchor.px } : a.anchor === null ? null : undefined;
  const follow = FOLLOW.includes(a.follow) ? a.follow : anchor ? 'pinned' : undefined;
  if (anchor === undefined && follow === undefined) return state;
  if (anchor !== undefined) state.anchor = anchor;
  if (follow !== undefined) state.follow = follow;
  if (follow === 'pinned' && state.anchor) state.landing = { id: state.anchor.id, status: 'pending', since: Number.isFinite(a.at) ? a.at : null };
  else if (follow !== undefined && follow !== 'pinned') state.landing = null;
  return state;
}

/** User scroll intent from user input events only. user() is asked once per scroll event the kit did not write: true
 *  only while a pointer is held on the scroller (a scrollbar drag, a selection autoscroll) or within windowMs of a wheel,
 *  touch or key, and an accepted scroll extends the window by chainMs (momentum and smooth scrolling keep arriving). */
export function intentTracker(scroller, W, { windowMs = 300, chainMs = 150, flingMs = 1200, flingChainMs = 500 } = {}) {
  let until = -Infinity, held = false, moved = false, fling = false;
  const now = () => W.performance.now();
  const arm = (ms) => { until = Math.max(until, now() + ms); };
  const onInput = () => arm(windowMs);
  const onDown = () => { held = true; fling = false; arm(windowMs); };
  const onMove = () => { moved = true; arm(windowMs); };
  // A finger that dragged and lifted hands the page to the platform's momentum (a fling): its scroll events keep coming for
  // a second or more, with gaps a busy frame or a throttled event stream can stretch past chainMs. Those are the user's, so
  // after a touch drag the window is flingMs and each accepted scroll chains flingChainMs; a tap (no touchmove) does not
  // extend it, so a focus or keyboard scroll right after a tap is still overwritten from the anchor.
  const onTouchEnd = () => { held = false; if (moved) { fling = true; arm(flingMs); } moved = false; };
  const onUp = () => { if (held) { held = false; arm(chainMs); } };
  const opts = { passive: true, capture: true };
  const on = [[scroller, 'wheel', onInput], [scroller, 'touchstart', onDown], [scroller, 'touchmove', onMove], [scroller, 'pointerdown', onDown],
    [W, 'touchend', onTouchEnd], [W, 'touchcancel', onTouchEnd], [W, 'pointerup', onUp], [W, 'pointercancel', onUp], [W, 'blur', onUp], [W, 'keydown', onInput]];
  for (const [t, n, f] of on) t.addEventListener(n, f, opts);
  return {
    user() { if (held || now() <= until) { arm(fling ? flingChainMs : chainMs); return true; } fling = false; return false; },
    get held() { return held; },
    dispose() { for (const [t, n, f] of on) t.removeEventListener(n, f, opts); },
  };
}

/** True when the scroller sits at its end (within 1 px). */
export const atEnd = (scroller) => scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1;

// ---------------------------------------------------------------------------------------------------------------------
/** Frame-level anchor recorder, run IN the page (self-contained for page.evaluate). Every frame, after layout and after
 *  the kit's own ResizeObserver corrections (its observer is created after the editor's, so it is called after it in the
 *  same broadcast), it records where the watched item sits: its top's distance below the scroller's top, or for
 *  { end: true } the scroller's distance from its end. What it records is what the frame paints.
 *  Use: installAnchorProbe({ editor: 'window.__pangeaScroll.editor' }) then window.__pangeaProbe.watch({ key } | { end: true }),
 *  window.__pangeaProbe.frames(n) -> Promise<samples> after n frames, window.__pangeaProbe.stop(). */
export function installAnchorProbe({ editor = '__pangeaScroll', global = '__pangeaProbe' } = {}) {
  window[global]?.stop?.();
  const ed = () => window[editor]?.editor;
  const st = { watch: null, samples: [], n: 0, running: true, waiters: [], ro: null, owner: null, sentinel: null };
  const posOf = (e, w) => {
    const sc = e.scroller;
    if (w.end) return sc.scrollHeight - sc.clientHeight - sc.scrollTop;
    const el = e.elOf(w.key);
    return el && el.isConnected ? el.getBoundingClientRect().top - sc.getBoundingClientRect().top : null;
  };
  const sample = () => {
    const e = ed(); if (!e || !st.watch) return;
    st.samples.push({ f: st.n, t: Math.round(performance.now()), y: posOf(e, st.watch), scrollTop: e.scroller.scrollTop, anchor: e.state.anchor && { ...e.state.anchor }, follow: e.state.follow });
    st.waiters = st.waiters.filter((w) => { if (st.samples.length >= w.n) { w.ok(st.samples.slice()); return false; } return true; });
  };
  // the observer is (re)made after each editor is made, so the browser calls it after the editor's own in a broadcast
  const own = () => {
    const e = ed();
    if (!document.body || !e || st.owner === e) return;
    st.ro?.disconnect();
    if (!st.sentinel) { st.sentinel = document.createElement('div'); st.sentinel.style.cssText = 'position:fixed;left:-20px;top:0;width:1px;height:1px;pointer-events:none;'; document.body.append(st.sentinel); }
    st.ro = new ResizeObserver(() => { if (st.running) sample(); });
    st.ro.observe(st.sentinel);
    st.owner = e;
  };
  const tick = () => { if (!st.running) return; own(); st.n += 1; if (st.sentinel) st.sentinel.style.width = `${1 + (st.n % 2)}px`; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window[global] = {
    /** Start a new recording of w ({ key } or { end: true }); returns the item's position now (before any frame). */
    watch(w) { own(); st.watch = w; st.samples = []; const e = ed(); return e ? posOf(e, w) : null; },
    frames(n) { return new Promise((ok) => { if (st.samples.length >= n) ok(st.samples.slice()); else st.waiters.push({ n, ok }); }); },
    samples: () => st.samples.slice(),
    stop() { st.running = false; st.ro?.disconnect(); st.sentinel?.remove(); },
  };
  return true;
}

/** The worst frame of a recording against the position the item must hold: { drift (max |y - want| px), frame, missing
 *  (frames where the item was not drawn) }. */
export function driftOf(samples, want) {
  let worst = 0, at = -1, missing = 0;
  for (const s of samples) {
    if (s.y == null) { missing += 1; continue; }
    const d = Math.abs(s.y - want);
    if (d > worst) { worst = d; at = s.f; }
  }
  return { drift: Math.round(worst * 10) / 10, frame: at, missing, frames: samples.length };
}
