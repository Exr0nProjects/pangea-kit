// Frame-level scroll, landing and paging checks (lib/editor/scroll.js is what they hold to). Each scenario records,
// on every frame after layout and after the kit's own ResizeObserver corrections (installAnchorProbe), where the item
// the reader is looking at sits, and fails on any drift of 1 px or more in any frame, or a frame where it is not drawn.
//
// Two suites, both in the deploy gate for every app on createEditor (lib/editor/gate.mjs):
//   scroll   the kit's own harness (lib/editor/scroll-harness: 1,200 rows wrapping 1-6 lines, estimates 18 px, paged):
//            structure  the scroller does not anchor on its own (computed overflow-anchor is none)
//            landing    a landing holds its row at its px from the first painted frame, through late layout (a font or
//                       decoration settling with no kit commit) and async answers re-rendering rows above it
//            reload     a real page reload landing from the URL holds from its first frame
//            prepend    three older pages arrive above the row he reads: 0 px in every frame
//            follow     following the end: 10 appends (one re-rendering late) keep the end at the viewport bottom
//            answer     async answers above, inside and below the window, plus late layout on and off
//            tab        another tab in front, the viewport resized while away, back: the row holds
//            foreign    scrolls no user input made (a script's scrollTop write, scrollIntoView) are written back
//            user       the negative control: a wheel moves the view and the anchor, and frees a landing; with
//                       followEnd, a wheel up frees the follow (an append no longer moves the view) and a wheel back to
//                       the end re-arms it
//   landing  the app's own harness and stylesheet (window.__pangeaHarness, reset({ kind: 'paged', autopage: false }), which
//            lands): landing through late layout, prepend (pageNow) per frame, foreign scroll, tab, and the wheel control.
import { join } from 'node:path';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { loadPlaywright, launchGateBrowser } from './browser-check.mjs';
import { installAnchorProbe, driftOf } from './scroll.js';

const EPS = 1;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
/** A static server for a built harness (127.0.0.1, ephemeral port). */
export function serveDir(dir) {
  const srv = createServer((req, res) => {
    const p = normalize(join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    const f = p.startsWith(dir) && existsSync(p) && statSync(p).isDirectory() ? join(p, 'index.html') : p;
    if (!f.startsWith(dir) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${srv.address().port}/`, close: () => srv.close() })));
}
const frames = (page, n) => page.evaluate((k) => window.__pangeaProbe.frames(k), n);
const raf = (page, n = 2) => page.evaluate((k) => new Promise((ok) => { let i = 0; const f = () => (++i >= k ? ok() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
const verdict = (name, runs, extra = {}) => {
  const bad = runs.filter((r) => r.drift >= EPS || r.missing > 0 || r.error);
  return { name, ok: bad.length === 0, drift_px: Math.max(0, ...runs.map((r) => r.drift ?? 0)), runs, ...extra };
};

/** The kit suite against a served scroll harness. */
export async function runScrollChecks({ url, only = null, log = () => {} }) {
  const { chromium } = await loadPlaywright();
  const browser = await launchGateBrowser(chromium);
  const results = {};
  const want = (n) => !only || only.includes(n);
  try {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(String(e.message || e)));
    await page.goto(url);
    await page.waitForFunction(() => window.__pangeaReady === true, null, { timeout: 15000 });
    await page.evaluate(installAnchorProbe, { editor: '__pangeaScroll' });
    const S = (fn, arg) => page.evaluate(fn, arg);
    // land on row k at px, let it settle, start watching it: returns the y it must hold
    const landAndWatch = async (opts, settle = 30) => { await S((o) => window.__pangeaScroll.reset(o), opts); await raf(page, settle); return S((k) => window.__pangeaProbe.watch({ key: k }), opts.land ? window_key(opts.land) : null); };
    const window_key = (land) => land.key ?? `r${String(land.k).padStart(5, '0')}`;

    if (want('structure')) {
      const oa = await S(() => getComputedStyle(window.__pangeaScroll.editor.scroller).overflowAnchor);
      results.structure = { name: 'structure', ok: oa === 'none', overflow_anchor: oa };
    }
    if (want('landing')) {
      const runs = [];
      for (const px of [200, 0, 430]) {
        const r = await S(async (p) => {
          const H = window.__pangeaScroll; H.reset({ land: { k: 1000, px: p } });
          window.__pangeaProbe.watch({ key: 'r01000' });
          const fr = window.__pangeaProbe.frames(45);
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => H.late(true))));
          H.answer('r00990', 'a long answer '.repeat(60), 40); H.answer('r00995', 'short', 80);
          return fr;
        }, px);
        runs.push({ px, ...driftOf(r, px) });
      }
      results.landing = verdict('landing', runs);
    }
    if (want('reload')) {
      const runs = [];
      for (const [k, px] of [[1100, 120], [950, 300]]) {
        const key = `r${String(k).padStart(5, '0')}`;
        await page.goto(`${url}#land=${key}:${px}`); await page.reload();
        await page.waitForFunction(() => window.__pangeaReady === true, null, { timeout: 15000 });
        await page.evaluate(installAnchorProbe, { editor: '__pangeaScroll' });
        const r = await S(async (kk) => { window.__pangeaProbe.watch({ key: kk }); const f = window.__pangeaProbe.frames(30); requestAnimationFrame(() => window.__pangeaScroll.late(true)); return f; }, key);
        runs.push({ key, px, ...driftOf(r, px) });
      }
      await page.goto(url); await page.waitForFunction(() => window.__pangeaReady === true); await page.evaluate(installAnchorProbe, { editor: '__pangeaScroll' });
      results.reload = verdict('reload', runs);
    }
    if (want('prepend')) {
      // he scrolled up into history (free, not a landing), then older pages arrive above the row he reads
      await landAndWatch({ land: { k: 960, px: 150 } });
      await page.mouse.move(300, 300); await page.mouse.wheel(0, -300); await page.waitForTimeout(250); await raf(page, 5);
      const fv = await S(() => window.__pangeaScroll.firstDrawn());
      const y0 = await S((k) => window.__pangeaProbe.watch({ key: k }), fv.key);
      const r = await S(async () => { const H = window.__pangeaScroll; for (let i = 0; i < 3; i++) { await H.prepend(300); await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))); } return window.__pangeaProbe.frames(20); });
      const st = await S(() => ({ lines: window.__pangeaScroll.doc.lines().length, follow: window.__pangeaScroll.editor.state.follow }));
      results.prepend = verdict('prepend', [{ key: fv.key, y0, ...st, ...driftOf(r, y0) }]);
    }
    if (want('follow')) {
      await S(() => window.__pangeaScroll.reset({ followEnd: true })); await raf(page, 20);
      const y0 = await S(() => window.__pangeaProbe.watch({ end: true }));
      const r = await S(async () => { const H = window.__pangeaScroll; for (let i = 0; i < 10; i++) { const ids = H.append(1 + (i % 3)); if (i === 4) H.answer(ids[0], 'grows after it arrived '.repeat(30), 30); await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))); } H.late(true); return window.__pangeaProbe.frames(40); });
      results.follow = verdict('follow', [{ y0, ...driftOf(r, 0) }], { follow: r[r.length - 1]?.follow });
      if (results.follow.follow !== 'bottom') results.follow.ok = false;
    }
    if (want('answer')) {
      const y0 = await landAndWatch({ land: { k: 1050, px: 260 } });
      const r = await S(async () => { const H = window.__pangeaScroll; const f = window.__pangeaProbe.frames(50); H.answer('r01049', 'an answer that wraps '.repeat(40), 10); H.answer('r00700', 'far above the window '.repeat(50), 20); H.answer('r01051', 'below '.repeat(80), 30); setTimeout(() => H.late(true), 60); setTimeout(() => H.late(false), 200); return f; });
      results.answer = verdict('answer', [{ y0, ...driftOf(r, y0) }]);
    }
    if (want('tab')) {
      const y0 = await landAndWatch({ land: { k: 1020, px: 180 } });
      const other = await ctx.newPage(); await other.goto('about:blank'); await other.bringToFront();
      await page.setViewportSize({ width: 700, height: 500 }); await page.waitForTimeout(150);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.setViewportSize({ width: 900, height: 800 }); await page.bringToFront(); await other.close();
      const r = await frames(page, 25);
      results.tab = verdict('tab', [{ y0, ...driftOf(r, y0) }]);
    }
    if (want('foreign')) {
      const y0 = await landAndWatch({ land: { k: 1010, px: 220 } });
      await S(() => { window.__pangeaScroll.editor.scroller.scrollTop += 300; });
      await raf(page, 4);
      await S(() => window.__pangeaScroll.editor.elOf('r01030')?.scrollIntoView());
      const r = await frames(page, 25);
      const st = await S(() => ({ anchor: window.__pangeaScroll.editor.state.anchor, follow: window.__pangeaScroll.editor.state.follow, stats: window.__pangeaScroll.editor.scrollStats }));
      results.foreign = verdict('foreign', [{ y0, ...driftOf(r, y0) }], { state: st });
    }
    if (want('user')) {
      const problems = [];
      await landAndWatch({ land: { k: 1000, px: 200 } });
      const before = await S(() => ({ st: window.__pangeaScroll.editor.scroller.scrollTop, anchor: window.__pangeaScroll.editor.state.anchor }));
      await page.mouse.move(300, 300); await page.mouse.wheel(0, -400); await page.waitForTimeout(250); await raf(page, 3);
      const after = await S(() => ({ st: window.__pangeaScroll.editor.scroller.scrollTop, anchor: window.__pangeaScroll.editor.state.anchor, follow: window.__pangeaScroll.editor.state.follow }));
      if (Math.abs(before.st - after.st - 400) > 40) problems.push({ what: 'wheel did not move the view', before, after });
      if (after.follow !== 'free') problems.push({ what: 'a user scroll did not free the landing', follow: after.follow });
      if (after.anchor?.id === before.anchor?.id && Math.abs(after.anchor.px - before.anchor.px) < 1) problems.push({ what: 'a user scroll did not move the anchor', after });
      // followEnd: up frees, an append then leaves the view alone, down to the end re-arms
      await S(() => window.__pangeaScroll.reset({ followEnd: true })); await raf(page, 20);
      await page.mouse.wheel(0, -300); await page.waitForTimeout(250); await raf(page, 3);
      const up = await S(() => window.__pangeaScroll.editor.state.follow);
      if (up !== 'free') problems.push({ what: 'a wheel up did not free the follow', follow: up });
      const fv = await S(() => window.__pangeaScroll.firstDrawn());
      await S(() => window.__pangeaScroll.append(3)); await raf(page, 3);
      const fv2 = await S((k) => { const e = window.__pangeaScroll.editor; const el = e.elOf(k); return el ? el.getBoundingClientRect().top - e.scroller.getBoundingClientRect().top : null; }, fv.key);
      if (fv2 == null || Math.abs(fv2 - fv.y) >= EPS) problems.push({ what: 'an append moved a freed view', before: fv, after: fv2 });
      await page.mouse.wheel(0, 5000); await page.waitForTimeout(300); await raf(page, 3);
      const down = await S(() => window.__pangeaScroll.editor.state.follow);
      if (down !== 'bottom') problems.push({ what: 'a wheel to the end did not re-arm the follow', follow: down });
      // only the user re-arms the follow: freed just above the end, the rows below shrink (the kit's write is clamped to
      // the end), then rows arrive: the view must stay where he left it, not follow
      await page.mouse.wheel(0, -80); await page.waitForTimeout(250); await raf(page, 3);
      const near = await S(() => ({ follow: window.__pangeaScroll.editor.state.follow, items: window.__pangeaScroll.editor.items.slice(-4).map((i) => i.key) }));
      await S(async (ks) => { for (const k of ks) await window.__pangeaScroll.answer(k, 'x', 0); }, near.items); await raf(page, 3);
      await S(() => window.__pangeaScroll.append(4)); await raf(page, 3);
      const after2 = await S(() => window.__pangeaScroll.editor.state.follow);
      if (near.follow !== 'free' || after2 !== 'free') problems.push({ what: 'the follow re-armed without the user (own write at the end)', freed: near.follow, after: after2 });
      results.user = { name: 'user', ok: problems.length === 0, problems };
    }
    const chk = await S(() => window.__pangeaScroll.checks());
    const bad = Object.entries(chk).filter(([, v]) => v);
    if (bad.length || errors.length) results.projection = { name: 'projection', ok: false, problems: Object.fromEntries(bad), errors: errors.slice(0, 3) };
  } finally { await browser.close(); }
  for (const [k, v] of Object.entries(results)) if (!v.ok) log(`FAIL scroll/${k}: ${JSON.stringify(v).slice(0, 500)}`);
  return { ok: Object.values(results).every((r) => r.ok), results };
}

/** The app suite: the app's own harness (window.__pangeaHarness) and stylesheet. */
export async function runAppLandingChecks({ url, log = () => {} }) {
  const { chromium } = await loadPlaywright();
  const browser = await launchGateBrowser(chromium);
  const runs = [], problems = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__pangeaReady === true, null, { timeout: 15000 });
    await page.evaluate(installAnchorProbe, { editor: '__pangeaHarness' });
    const S = (fn, arg) => page.evaluate(fn, arg);
    // landing: the harness lands in reset(); late layout (a stylesheet change no commit makes) three frames in
    const land = await S(async () => {
      document.getElementById('qk-late')?.remove();
      const H = window.__pangeaHarness; H.reset({ kind: 'paged', autopage: false });
      const a = H.editor.state.anchor; if (!a) return { error: 'the harness did not land (no anchor after reset)' };
      window.__pangeaProbe.watch({ key: a.id });
      const f = window.__pangeaProbe.frames(40);
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => { const s = document.createElement('style'); s.id = 'qk-late'; s.textContent = '[data-addr] { padding-bottom: 3px !important; }'; document.head.append(s); })));
      return { anchor: a, samples: await f };
    });
    if (land.error) runs.push({ scenario: 'landing', error: land.error });
    else runs.push({ scenario: 'landing', ...driftOf(land.samples, land.anchor.px) });
    await S(() => document.getElementById('qk-late')?.remove()); await raf(page, 10);
    // prepend: pageNow() loads one older page through the app's own 'page' path
    const hasPage = await S(() => typeof window.__pangeaHarness.pageNow === 'function');
    if (hasPage) {
      await page.mouse.move(400, 400); await page.mouse.wheel(0, -1200); await page.waitForTimeout(250); await raf(page, 5);
      const fv = await S(() => window.__pangeaHarness.firstVisible?.());
      if (fv) {
        const y0 = await S((k) => window.__pangeaProbe.watch({ key: k }), fv.id);
        const r = await S(async () => { for (let i = 0; i < 3; i++) { window.__pangeaHarness.pageNow(); await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))); } return window.__pangeaProbe.frames(15); });
        runs.push({ scenario: 'prepend', ...driftOf(r, y0) });
      }
    }
    // foreign scroll and tab: hold the row he reads
    const fv = await S(() => window.__pangeaHarness.firstVisible?.());
    if (fv) {
      const y0 = await S((k) => window.__pangeaProbe.watch({ key: k }), fv.id);
      await S(() => { window.__pangeaHarness.editor.scroller.scrollTop += 300; }); await raf(page, 4);
      const other = await ctx.newPage(); await other.bringToFront();
      await page.setViewportSize({ width: 800, height: 600 }); await page.waitForTimeout(100);
      await page.setViewportSize({ width: 1000, height: 800 }); await page.bringToFront(); await other.close();
      const r = await frames(page, 20);
      runs.push({ scenario: 'foreign+tab', ...driftOf(r, y0) });
    }
    // negative control: a wheel moves it
    const b = await S(() => window.__pangeaHarness.editor.scroller.scrollTop);
    await page.mouse.move(400, 400); await page.mouse.wheel(0, -300); await page.waitForTimeout(250);
    const a = await S(() => ({ st: window.__pangeaHarness.editor.scroller.scrollTop, follow: window.__pangeaHarness.editor.state.follow }));
    if (Math.abs(b - a.st) < 100 || a.follow !== 'free') problems.push({ what: 'a user wheel did not move the view and free it', before: b, after: a });
  } finally { await browser.close(); }
  const v = verdict('landing', runs, { problems });
  if (problems.length) v.ok = false;
  if (!v.ok) log(`FAIL landing: ${JSON.stringify(v).slice(0, 600)}`);
  return v;
}

/** Build the kit harness (from `kitLib`, default this kit's lib: a planted copy for mutation proofs) with the vite that
 *  `fromDir` resolves, serve it, run the kit suite. */
export async function kitScrollSuite({ fromDir = import.meta.dirname, kitLib = join(import.meta.dirname, '..'), only = null, log = () => {} } = {}) {
  const req = createRequire(join(fromDir, 'package.json'));
  let vitePath; try { vitePath = req.resolve('vite'); } catch { vitePath = createRequire(join(import.meta.dirname, '../../package.json')).resolve('vite'); }
  const { build } = await import(pathToFileURL(vitePath).href);
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'qk-scroll-harness-')));
  try {
    await build({ configFile: false, root: join(kitLib, 'editor/scroll-harness'), base: './', logLevel: 'error', build: { outDir: out, emptyOutDir: true, target: 'es2022' } });
    const s = await serveDir(out);
    try { return await runScrollChecks({ url: s.url, only, log }); } finally { s.close(); }
  } finally { rmSync(out, { recursive: true, force: true }); }
}

/** Mutation proof: copy the kit's lib, apply `edits` ([[file relative to lib, find, replace]]), run the kit suite on it. */
export async function plantedSuite(edits, opts = {}) {
  const lib = join(import.meta.dirname, '..');
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'qk-plant-'))); // vite refuses a root reached through /var -> /private/var
  try {
    cpSync(lib, join(tmp, 'lib'), { recursive: true });
    for (const [f, find, repl] of edits) {
      const p = join(tmp, 'lib', f), t = readFileSync(p, 'utf8');
      if (!t.includes(find)) throw new Error(`plant: not found in ${f}: ${find.slice(0, 80)}`);
      writeFileSync(p, t.replace(find, repl));
    }
    return await kitScrollSuite({ ...opts, kitLib: join(tmp, 'lib') });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** The planted bugs (scroll/landing classes of the 2026-11-09 census); each must turn the named check red. */
export const PLANTS = [
  { name: 'browser-anchoring', bug: 'the browser anchors on its own again (overflow-anchor left at auto)', expect: ['structure'],
    edits: [['editor/editor.js', "scroller.style.overflowAnchor = 'none';", '']] },
  { name: 'self-scroll-as-intent', bug: 'every scroll event the kit did not write is read as the user scrolling', expect: ['foreign'],
    edits: [['editor/scroll.js', 'user() { if (held || now() <= until)', 'user() { if (true)']] },
  { name: 'land-before-settle', bug: 'no re-resolve after layout changes outside a commit (landing on unsettled layout)', expect: ['landing', 'answer'],
    edits: [['editor/editor.js', 'const ro = W.ResizeObserver ? new W.ResizeObserver(() => settle()) : null;', 'const ro = null;']] },
  { name: 'geometry-before-data', bug: 'once he has scrolled, a page is applied against the scrollTop measured before it arrived instead of re-resolved from the anchor (B10, E25)', expect: ['prepend'],
    edits: [['editor/editor.js', ': state.anchor ? anchorTop(state.anchor) : null);', ": state.anchor && state.follow === 'pinned' ? anchorTop(state.anchor) : null);"]] },
  { name: 'follow-rearmed-by-own-write', bug: 'follow-the-end re-armed whenever the view sits at the end after a kit write, whoever put it there', expect: ['user'],
    edits: [['editor/editor.js', "        const want = scrollTarget();\n        if (want !== null && Math.abs(scroller.scrollTop - want) > 0.5) { scroller.scrollTop = want; expectScroll = scroller.scrollTop; }\n", "        const want = scrollTarget();\n        if (want !== null && Math.abs(scroller.scrollTop - want) > 0.5) { scroller.scrollTop = want; expectScroll = scroller.scrollTop; }\n        if (followEnd && atEnd(scroller)) state.follow = 'bottom';\n"]] },
];

/** The gate's scroll step for an editor app (lib/editor/gate.mjs): the kit suite on the kit the app's vite resolves, and
 *  the app suite on the app's own harness, built with its vite config. Results as gate browser results:
 *  'scroll:<check>' and 'landing'; `only` takes 'scroll' and/or 'landing'. */
export async function scrollGate(appRoot, cfg, { only = null, log = () => {} } = {}) {
  const results = {}, measurements = {};
  if (!only || only.includes('scroll')) {
    const k = await kitScrollSuite({ fromDir: appRoot, log });
    for (const [n, v] of Object.entries(k.results)) results[`scroll:${n}`] = { ok: v.ok, detail: v };
    measurements.scroll = Object.fromEntries(Object.entries(k.results).filter(([, v]) => v.drift_px != null).map(([n, v]) => [n, v.drift_px]));
  }
  if (!only || only.includes('landing')) {
    const req = createRequire(join(appRoot, 'package.json'));
    const { build } = await import(pathToFileURL(req.resolve('vite')).href);
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'qk-landing-harness-')));
    try {
      await build({ configFile: join(appRoot, cfg.viteConfig || 'vite.config.js'), root: join(appRoot, cfg.harness || 'test/ui'), base: './', logLevel: 'error', build: { outDir: out, emptyOutDir: true, target: 'es2022' } });
      const s = await serveDir(out);
      try { const v = await runAppLandingChecks({ url: s.url, log }); results.landing = { ok: v.ok, detail: v }; measurements.landing = v.runs.map((r) => ({ scenario: r.scenario, drift: r.drift, missing: r.missing })); } finally { s.close(); }
    } finally { rmSync(out, { recursive: true, force: true }); }
  }
  return { ok: Object.values(results).every((r) => r.ok), results, measurements };
}
