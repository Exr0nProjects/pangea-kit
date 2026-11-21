// Frame laws: what the eye sees, checked on a per-frame trace instead of by a person watching. The trace is the shape the
// research/flash investigation recorded by hand (requestAnimationFrame snapshot of named elements, MutationObserver
// timestamps), made a kit format so any app's interaction can be checked:
//   frames = [{ t, els: { key: { x, y, w, h, opacity, visible, text } | null | { present: false } } }]  (t in ms)
// which is lib/testing/frames.js's recorder format (A1) with elements keyed by a name instead of the selector.
// Laws (pure; each returns [] or [{ law, key, at, detail }]):
//   motion       one gesture, one easing: speed profile has one peak; no reversal (bounce/overshoot); no frame gap over
//                stutter_gap_ms; finishes within max_ms; the moving element never vanishes mid-motion; named elements
//                stay hidden while it moves (the envelope flap "flashes thru it")      -> motion-quality, flicker
//   settled      every frame from first paint shows the projection the page settles on (no snap)  -> first-paint-flash
//   layoutStable elements the gesture does not own keep their rects                  -> layout-shift
//   anchorStable the element he is reading keeps its viewport y within eps            -> scroll-anchor-jump
//   flicker      an element's visibility toggles at most `allowed` times             -> flicker
// recordFrames()/measureInteraction() produce traces and samples in a Playwright page, with the kit's one recorder
// (lib/testing/frames.js installFrameRecorder).
import { canonical } from '../canonical.js';
import { UI_DEFAULTS } from './contract.js';
import { installFrameRecorder, readFrames } from '../testing/frames.js';

const shown = (e) => Boolean(e) && e.present !== false && e.visible !== false && (e.opacity ?? 1) > 0.01;
const prop = (e, p) => (e ? e[p] : undefined);

/** The window in which `key`'s property changes: [first frame that differs from frame 0, last frame that differs from its predecessor]. */
export function motionWindow(frames, key, property, eps = 0.5) {
  let start = -1, end = -1;
  for (let i = 1; i < frames.length; i++) {
    const a = prop(frames[i - 1].els[key], property), b = prop(frames[i].els[key], property);
    if (a === undefined || b === undefined || Math.abs(b - a) > eps) { if (start < 0) start = i - 1; end = i; }
  }
  return start < 0 ? null : [start, end];
}

export function checkMotion(frames, key, spec = {}) {
  const s = { property: 'y', eps: 0.5, ...UI_DEFAULTS.motion, ...spec };
  const bad = [];
  const w = motionWindow(frames, key, s.property, s.eps);
  if (!w) return bad;
  const [a, b] = w;
  const span = frames.slice(a, b + 1);
  const dur = span[span.length - 1].t - span[0].t;
  if (dur > s.max_ms) bad.push({ law: 'motion', key, at: span[0].t, detail: `took ${Math.round(dur)} ms, budget ${s.max_ms}` });
  for (let i = 1; i < span.length; i++) {
    const gap = span[i].t - span[i - 1].t;
    if (gap > s.stutter_gap_ms) bad.push({ law: 'motion', key, at: span[i].t, detail: `stutter: ${Math.round(gap)} ms frame gap` });
    if (!shown(span[i].els[key]) && i < span.length - 1 && !s.allowHide) bad.push({ law: 'motion', key, at: span[i].t, detail: 'flash: the moving element vanished mid-motion' });
    for (const h of s.hiddenDuring || []) if (shown(span[i].els[h])) bad.push({ law: 'motion', key: h, at: span[i].t, detail: `flash: ${h} visible while ${key} moves` });
  }
  const vs = span.map((f) => prop(f.els[key], s.property)).filter((v) => v !== undefined);
  const final = vs[vs.length - 1], first = vs[0];
  const dir = Math.sign(final - first);
  if (dir !== 0) {
    for (let i = 1; i < vs.length; i++) {
      if (Math.sign(vs[i] - vs[i - 1]) === -dir && Math.abs(vs[i] - vs[i - 1]) > s.eps) { bad.push({ law: 'motion', key, at: span[i].t, detail: `bounce: reversed by ${Math.abs(vs[i] - vs[i - 1]).toFixed(1)}px` }); break; }
    }
    // speed profile peaks with hysteresis: a peak counts once speed has fallen 30% of the top speed below it; a second
    // rise of 30% after that is a second easing (The owner 2026-11-03: "is there like two separate easings").
    const sp = [];
    for (let i = 1; i < vs.length; i++) { const dt = Math.max(1, span[i].t - span[i - 1].t); sp.push(Math.abs(vs[i] - vs[i - 1]) / dt); }
    const top = Math.max(...sp), h = 0.3 * top;
    let peaks = 0, rising = true, ref = 0;
    for (const v of sp) {
      if (rising) { if (v > ref) ref = v; else if (ref - v >= h) { peaks++; rising = false; ref = v; } }
      else if (v < ref) ref = v; else if (v - ref >= h) { rising = true; ref = v; }
    }
    if (rising && ref >= h) peaks++;
    if (peaks > 1 && !s.allowSteps) bad.push({ law: 'motion', key, at: span[0].t, detail: `${peaks} speed peaks: one gesture must use one easing` });
  }
  return bad;
}

/** Settled law (first paint = saved state): every frame from the first one where `ready(frame)` holds must project to the
 *  same value as the final frame. project(frame) -> JSON (e.g. which folders are open, the row ids in order). */
export function checkSettled(frames, project, { ready = (f) => Object.values(f.els).some(Boolean), key = 'page' } = {}) {
  const i0 = frames.findIndex(ready);
  if (i0 < 0) return [{ law: 'settled', key, at: null, detail: 'never painted' }];
  const want = canonical(project(frames[frames.length - 1]));
  for (let i = i0; i < frames.length; i++) {
    const got = canonical(project(frames[i]));
    if (got !== want) return [{ law: 'settled', key, at: frames[i].t, detail: `frame ${i} painted ${got.slice(0, 160)}, settled ${want.slice(0, 160)}` }];
  }
  return [];
}

export function checkLayoutStable(frames, keys, { eps = 0.5, from = 0 } = {}) {
  const bad = [];
  for (const k of keys) {
    let base = null;
    for (let i = from; i < frames.length; i++) {
      const e = frames[i].els[k];
      if (!e) continue;
      if (!base) { base = e; continue; }
      for (const p of ['x', 'y', 'w', 'h']) if (Math.abs((e[p] ?? 0) - (base[p] ?? 0)) > eps) { bad.push({ law: 'layoutStable', key: k, at: frames[i].t, detail: `${p} ${base[p]} -> ${e[p]}` }); break; }
      if (bad.length && bad[bad.length - 1].key === k) break;
    }
  }
  return bad;
}

export function checkAnchorStable(frames, key, { eps = 2 } = {}) { return checkLayoutStable(frames, [key], { eps }).map((b) => ({ ...b, law: 'anchorStable' })); }

export function checkFlicker(frames, key, { allowed = 1 } = {}) {
  let toggles = 0, prev = null;
  for (const f of frames) { const v = shown(f.els[key]); if (prev !== null && v !== prev) toggles++; prev = v; }
  return toggles > allowed ? [{ law: 'flicker', key, at: null, detail: `${toggles} visibility toggles, allowed ${allowed}` }] : [];
}

// ---- recording in a real page (Playwright), no dependency on Playwright here: `page` is duck-typed ----

/** Record frames while `run()` drives the page, with lib/testing/frames.js's recorder. targets: { name: cssSelector };
 *  the returned frames key elements by name. With { fromLoad: true } the recorder is an init script, so the very first
 *  paint after a navigation or reload is in the trace (the settled law needs that frame). */
export async function recordFrames(page, targets, run, { settleMs = 600, fromLoad = false, maxFrames = 900 } = {}) {
  const track = Object.values(targets);
  const opts = { track, maxFrames };
  // At document start there is no documentElement yet and installFrameRecorder observes it, so wait for the root node
  // (nothing can paint before it exists). Reported to lib/testing's owner in webchat/tests/corrections/INTEGRATION.md.
  if (fromLoad) await page.addInitScript(`(() => { const go = () => (${installFrameRecorder})(${JSON.stringify(opts)});
    if (document.documentElement) go(); else new MutationObserver((m, o) => { if (document.documentElement) { o.disconnect(); go(); } }).observe(document, { childList: true }); })()`);
  else await page.evaluate(installFrameRecorder, opts);
  await run();
  await page.waitForTimeout(settleMs);
  const raw = await page.evaluate(readFrames);
  const names = Object.entries(targets);
  return raw.map((f) => ({ ...f, els: Object.fromEntries(names.map(([k, sel]) => [k, f.els[sel] ?? null])) }));
}

/** Input-to-next-paint for one interaction: `act()` performs it (a click, a key), `ready` is a page predicate (source of
 *  an expression, evaluated by Playwright's own CSP-exempt waitForFunction with requestAnimationFrame polling) that is
 *  true once the result is in the DOM. The clock starts at the input event's own timeStamp (the first pointerdown,
 *  keydown, wheel or input after arming, so the driver's round trip is not counted) and stops at the animation frame
 *  after `ready` first holds. Upper bound by at most one frame (the poll that saw it). */
export async function measureInteraction(page, act, ready, { timeoutMs = 5000 } = {}) {
  await page.evaluate(() => {
    window.__pangeaT0 = null;
    const start = (e) => { if (window.__pangeaT0 === null) window.__pangeaT0 = e.timeStamp; };
    for (const k of ['pointerdown', 'keydown', 'wheel', 'input']) addEventListener(k, start, { capture: true, once: true });
  });
  await act();
  await page.waitForFunction(ready, null, { timeout: timeoutMs, polling: 'raf' });
  return page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => ok(window.__pangeaT0 === null ? NaN : performance.now() - window.__pangeaT0))));
}
