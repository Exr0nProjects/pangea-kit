// Frame recorder (pangea-ui-kit testing, GUIDE section 7): what the page showed on every animation frame.
//
// `installFrameRecorder` runs IN the page (pass it to Playwright's page.evaluate, or call it directly in
// jsdom/a browser test). On every requestAnimationFrame it records the frame time, the DOM mutations since
// the previous frame, and for each tracked selector its box, opacity, visibility and a hash of its text.
// `readFrames` stops it and returns the frames. The analysis helpers are pure functions over that array, so
// motion and first-paint laws (frame budget, no jump, monotone motion, first frame with content) are
// written once here and used by any app. Both page functions are self-contained (no module closures), as
// page.evaluate requires.

export function installFrameRecorder({ track = [], maxFrames = 600, key = '__pangeaFrames' } = {}) {
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
  const state = { frames: [], mutations: 0, running: true, start: performance.now() };
  const observer = typeof MutationObserver === 'function' ? new MutationObserver((list) => { state.mutations += list.length; }) : null;
  // Observe the Document node, not documentElement: installed as an init script (before the page loads) there is no
  // root element yet, and observing `document` with subtree covers the root once it is inserted, with no wrapper.
  observer?.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  let last = state.start;
  const sample = (sel) => {
    let el = null;
    try { el = document.querySelector(sel); } catch { el = null; }
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { present: true, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), opacity: Number(cs.opacity), visible: cs.visibility !== 'hidden' && cs.display !== 'none', text: hash(el.textContent || '') };
  };
  const frame = (now) => {
    if (!state.running) return;
    const t = typeof now === 'number' ? now : performance.now();
    state.frames.push({ t: Math.round(t - state.start), dt: Math.round(t - last), mutations: state.mutations, els: Object.fromEntries(track.map((sel) => [sel, sample(sel)])) });
    state.mutations = 0;
    last = t;
    if (state.frames.length >= maxFrames) { state.running = false; observer?.disconnect(); return; }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  window[key] = { state, stop() { state.running = false; observer?.disconnect(); return state.frames; } };
  return true;
}

export function readFrames({ key = '__pangeaFrames' } = {}) {
  const rec = window[key];
  return rec ? rec.stop() : [];
}

/** Frames whose interval exceeded `budgetMs` (34 ms is two 60 Hz frames). */
export const longFrames = (frames, budgetMs = 34) => frames.filter((f, i) => i > 0 && f.dt > budgetMs);

/** The first frame on which `pred(el)` holds for `sel` (default: present and visible with a non-zero box). */
export function firstFrame(frames, sel, pred = (e) => e.present && e.visible && e.w > 0 && e.h > 0) {
  return frames.find((f) => f.els[sel] && pred(f.els[sel])) || null;
}

/** Discontinuities: frames where `sel` moved more than `px` on `axis` in one frame (a jump, not motion). */
export function jumps(frames, sel, { px = 24, axis = 'y' } = {}) {
  const out = [];
  for (let i = 1; i < frames.length; i += 1) {
    const a = frames[i - 1].els[sel]; const b = frames[i].els[sel];
    if (a?.present && b?.present && Math.abs(b[axis] - a[axis]) > px) out.push({ frame: i, t: frames[i].t, from: a[axis], to: b[axis] });
  }
  return out;
}

/** Whether `prop` of `sel` only moves one way across the frames it is present on (no bounce). */
export function monotone(frames, sel, prop = 'y') {
  const values = frames.map((f) => f.els[sel]).filter((e) => e?.present).map((e) => e[prop]);
  let dir = 0;
  for (let i = 1; i < values.length; i += 1) {
    const d = Math.sign(values[i] - values[i - 1]);
    if (!d) continue;
    if (dir && d !== dir) return { monotone: false, reversedAt: i };
    dir = d;
  }
  return { monotone: true };
}

/** The first frame after which nothing mutated for `quietFrames` frames, or null. */
export function quietFrom(frames, quietFrames = 10) {
  let run = 0;
  for (let i = 0; i < frames.length; i += 1) {
    run = frames[i].mutations ? 0 : run + 1;
    if (run >= quietFrames) return frames[i - quietFrames + 1];
  }
  return null;
}
