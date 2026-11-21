// The kit editor's browser checks, driven with Playwright in its own Google Chrome window (launchGateBrowser below; never
// the owner's or the shared cdp Chrome). Real key events go through the page's own listeners. The page is an app harness exposing window.__pangeaHarness
// (see zai-pangea/test/ui/harness.js): reset({kind, dev, autopage}), tick(ms), css(on), caretAfterBlank(), caretAt(flat),
// text(), flatSel(), snapshot(), model(), checks(), roundTrip(), stats(), pageNow(), firstVisible().
//
// Checks (each a named result; any failure fails the gate):
//   projection  after every fuzz step: a fresh render from state equals the live root, every text node is addressed or
//               inert, no DOM mutation outside a kit commit (dev MutationObserver), no page error
//   model       the reducer alone over the run's action log gives the live state
//   css         the same keystrokes with the app's stylesheet disabled give the same state after every step
//   oracle      the same keystrokes (typing, Enter, Backspace, Delete, shift-arrow selections across lines, multi-line
//               paste, range delete) give the same text and selection as a plain <textarea>, compared after every step
//   undo        N undo presses restore the text exactly as it was N edits earlier; every press paints within budget
//   roundtrip   point -> address -> coordinates -> address for every character on screen, at several scroll positions
//   anchor      loading an older page above the viewport moves the first visible row by < 1 px
//   timing      Event Timing p95 and the kit's event -> next frame p95 over the fuzz run are within budget (100 ms)
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// QK_PLAYWRIGHT_FROM: a directory whose node_modules has playwright, set by the deploy's hermetic suites (their HOME is a temp dir)
const CANDIDATES = [process.env.QK_PLAYWRIGHT_FROM, import.meta.dirname, join(homedir(), 'projects/host-app/lib/host-app/webchat'), join(homedir(), 'projects/host-app/webchat')].filter(Boolean);
export async function loadPlaywright() {
  for (const dir of CANDIDATES) {
    try { const req = createRequire(join(dir, 'x.js')); return req('playwright'); } catch { /* next */ }
  }
  throw new Error(`kit browser checks: playwright not found (looked from ${CANDIDATES.join(', ')})`);
}

// The gate's browser: installed Google Chrome in a real window (Playwright channel 'chrome', headless false, its own temp
// profile; never the owner's Chrome or the shared cdp one), driven by CDP only. Measured on the Mac mini 2026-11-11
// (load 8-34), same zai3 harness and keys: the headless shell's event -> next frame p95 was 92-148 ms, new headless
// (--headless=new) 102-155 ms, and even a bare contenteditable page shows a 50-150 ms next-frame floor there; a real
// window paints on the display's 60 Hz frames (bare page p95 33 ms) and gave kit all_p95 30-33 ms and Event Timing p95
// 56-64 ms in 17 of 18 probe and gate runs at load 9-51 (the 18th, at load 107, read 136). The timing check thus
// measures the editor's event -> paint, not the harness. A window that gets no frames (display asleep, session locked)
// fails the launch loudly rather than timing out a check. The throttling flags keep a covered window painting at full rate.
export const GATE_LAUNCH = Object.freeze({ channel: 'chrome', headless: false, args: Object.freeze(['--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows']) });
export async function launchGateBrowser(chromium, { frameTimeoutMs = 5000 } = {}) {
  const browser = await chromium.launch({ ...GATE_LAUNCH, args: [...GATE_LAUNCH.args] });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const frames = await page.evaluate((ms) => new Promise((ok) => { let n = 0; const t = setTimeout(() => ok(n), ms); const f = () => { if (++n >= 10) { clearTimeout(t); ok(n); } else requestAnimationFrame(f); }; requestAnimationFrame(f); }), frameTimeoutMs);
    await ctx.close();
    if (frames < 10) throw new Error(`kit browser checks: the gate's Chrome window painted ${frames} frames in ${frameTimeoutMs} ms (display asleep or session locked?); the timing check needs a window that paints`);
  } catch (e) { await browser.close(); throw e; }
  return browser;
}

const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (rng, xs) => xs[Math.floor(rng() * xs.length)];
const PASTE = 'pasted one\npasted two x\nthree';

// key alphabet: [token, weight]. 'paste' is ControlOrMeta+V with PASTE on the clipboard.
const FUZZ = [['a', 6], ['b', 3], ['Space', 3], ['Enter', 3], ['Backspace', 6], ['Delete', 2], ['ArrowLeft', 3], ['ArrowRight', 3], ['Shift+ArrowLeft', 3], ['Shift+ArrowRight', 3], ['paste', 1], ['Meta+z', 2], ['Meta+Shift+z', 1],
  ['Control+k', 2], ['Control+y', 1], ['Control+t', 1], ['Control+d', 1], ['Alt+Backspace', 1], ['Control+o', 1]];
// layout keys: what they do depends on layout by definition (a page is a height, a visual line a wrap), so they are left
// out of the css differential and run in their own fuzz (projection, model). ⌃O is in FUZZ: headless Chromium emits
// nothing for it in a textarea, so the oracle cannot compare it. ⌃V ⌥V: a page, and the oracle textarea is not the
// editor's height.
const LAYOUT = [...FUZZ, ['Control+v', 2], ['Alt+v', 2], ['ArrowUp', 4], ['ArrowDown', 4], ['Shift+ArrowDown', 2], ['Shift+ArrowUp', 2], ['PageDown', 2], ['PageUp', 2], ['Meta+ArrowLeft', 2], ['Meta+ArrowRight', 2], ['Control+n', 2], ['Control+p', 2]];
// the macOS text bindings, where a <textarea> behaves as the document must: ⌃A ⌃E ⌃F ⌃B ⌃N ⌃P move (the kit resolves
// them from state and the render map into select actions; the textarea moves natively), ⌃D ⌃H ⌃T ⌥⌫ ⌥⌦ ⌘⌫ edit (beforeinput, mapped). Kill and yank (⌃K ⌃Y) are left out: the
// textarea's kill ring is Chromium's process-wide one with its own append rules; they are in FUZZ (model, projection, css).
const ORACLE = [['x', 6], ['y', 2], ['Space', 2], ['Enter', 3], ['Backspace', 6], ['Delete', 3], ['ArrowLeft', 3], ['ArrowRight', 3], ['Shift+ArrowLeft', 4], ['Shift+ArrowRight', 4], ['paste', 2],
  ['Control+a', 2], ['Control+e', 2], ['Control+f', 2], ['Control+b', 2], ['Control+n', 2], ['Control+p', 2], ['Control+d', 2], ['Control+h', 2], ['Control+t', 2], ['Alt+Backspace', 2], ['Alt+Delete', 2], ['Meta+Backspace', 1],
  // the kit resolves these against the render map (never the browser): ↑ ↓ ⇧↑ ⇧↓ and ⌘← ⌘→ (visual line edges)
  ['ArrowUp', 2], ['ArrowDown', 2], ['Shift+ArrowUp', 1], ['Shift+ArrowDown', 1], ['Meta+ArrowLeft', 1], ['Meta+ArrowRight', 1], ['Shift+Meta+ArrowRight', 1]];
const seqOf = (rng, table, n) => { const bag = table.flatMap(([k, w]) => Array(w).fill(k)); return Array.from({ length: n }, () => pick(rng, bag)); };

// a key, then one frame and a task: a native caret move (⌃A, ⌃N ...) reaches the kit as a queued selectionchange, so a
// read straight after the press would see the state before it
// 'paste' puts PASTE on the clipboard right before the press: headless Chrome on macOS shares the system pasteboard, so another
// process copying meanwhile (2026-11-16: a LinkedIn URL copied on the mini during a gate run) made the editor and the textarea
// oracle paste different text and refused a deploy that changed nothing about paste
async function press(page, k) {
  if (k === 'paste') { await page.evaluate((t) => navigator.clipboard.writeText(t), PASTE); await page.keyboard.press('ControlOrMeta+V'); } else await page.keyboard.press(k);
  await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => setTimeout(() => requestAnimationFrame(() => setTimeout(ok, 0)), 0))));
}

export async function runBrowserChecks({ url, seed = 7, steps = 120, only = null, log = () => {} }) {
  const { chromium } = await loadPlaywright();
  const browser = await launchGateBrowser(chromium);
  const results = {}, measurements = {};
  const want = (n) => !only || only.includes(n);
  const fail = (name, detail) => { results[name] = { ok: false, detail }; log(`FAIL ${name}: ${JSON.stringify(detail).slice(0, 600)}`); };
  const pass = (name, detail) => { results[name] ??= { ok: true, detail }; };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
    await page.goto(url);
    await page.waitForFunction(() => window.__pangeaReady === true, null, { timeout: 15000 });
    await page.evaluate((t) => navigator.clipboard.writeText(t), PASTE);
    const H = (fn, arg) => page.evaluate(fn, arg);

    // ---------------------------------------------------------------- fuzz: projection, model, css, timing
    const rng = mulberry(seed);
    const seq = ['Backspace', 'Backspace', ...seqOf(rng, FUZZ, steps)]; // starts with Backspace at a line under a blank line
    const runFuzz = async (css, seq_ = seq) => { const seq = seq_;
      await H((c) => { window.__pangeaHarness.reset({ kind: 'mixed' }); window.__pangeaHarness.css(c); return window.__pangeaHarness.caretAfterBlank(); }, css);
      const snaps = [];
      for (let i = 0; i < seq.length; i++) {
        await H(() => window.__pangeaHarness.tick(300));
        await press(page, seq[i]);
        const r = await H(() => ({ snap: window.__pangeaHarness.snapshot(), checks: window.__pangeaHarness.checks() }));
        snaps.push(r.snap);
        const bad = Object.entries(r.checks).filter(([, v]) => v);
        if (bad.length && want('projection') && !results.projection) fail('projection', { css, step: i, key: seq[i], keys: seq.slice(0, i + 1).join(' '), problems: Object.fromEntries(bad) });
      }
      return snaps;
    };
    if (['projection', 'model', 'css', 'timing'].some(want)) {
      const withCss = await runFuzz(true);
      const stats = await H(() => window.__pangeaHarness.stats());
      measurements.fuzz = stats;
      if (want('model')) { const m = await H(() => window.__pangeaHarness.model()); const live = withCss[withCss.length - 1]; if (JSON.stringify(m) !== JSON.stringify(live)) fail('model', { model: m.text.slice(0, 5), live: live.text.slice(0, 5), sel: [m.sel, live.sel] }); else pass('model', { actions: stats.actions }); }
      if (want('timing')) {
        const et = stats.event_timing_p95, kit = stats.all_p95;
        if (et > 100 || kit > 100) fail('timing', stats); else pass('timing', stats);
      }
      if (want('css')) {
        const noCss = await runFuzz(false);
        const k = withCss.findIndex((s, i) => JSON.stringify(s) !== JSON.stringify(noCss[i]));
        if (k >= 0) fail('css', { step: k, key: seq[k], keys: seq.slice(0, k + 1).join(' '), withCss: withCss[k].text.slice(0, 12), noCss: noCss[k].text.slice(0, 12), sel: [withCss[k].sel, noCss[k].sel] }); else pass('css', { steps: seq.length });
        await H(() => window.__pangeaHarness.css(true));
      }
      // the layout fuzz: kit-resolved caret moves (↑ ↓ pages, visual line edges) through the same projection and model checks
      const lseq = ['Backspace', ...seqOf(mulberry(seed + 7), LAYOUT, steps)];
      await runFuzz(true, lseq);
      if (want('model')) { const m = await H(() => window.__pangeaHarness.model()); const live = await H(() => window.__pangeaHarness.snapshot()); if (JSON.stringify(m) !== JSON.stringify(live)) fail('model', { layout: true, model: m.text.slice(0, 5), live: live.text.slice(0, 5), sel: [m.sel, live.sel] }); }
      pass('projection', { steps: seq.length * (want('css') ? 2 : 1) + lseq.length });
    }

    // ---------------------------------------------------------------- textarea oracle (text and selection after every step)
    if (want('oracle')) {
      const orng = mulberry(seed + 1);
      let bad = null; const runs = 3, per = 50;
      for (let r = 0; r < runs && !bad; r++) {
        const keys = seqOf(orng, ORACLE, per);
        const start = await H((s) => { const h = window.__pangeaHarness; h.reset({ kind: 'plain' }); const t = h.text(); const c = Math.floor(s * t.length); const ta = document.getElementById('oracle'); ta.value = t; h.caretAt(c); return c; }, orng());
        // the textarea wraps where the editor's lines wrap: same text column width, font and wrapping rules (visual line
        // keys, ⌘← ⌘→ ↑ ↓, compare the same geometry)
        await H(() => { const ta = document.getElementById('oracle'), ln = document.querySelector('#doc [data-addr]'); if (!ln) return; const cs = getComputedStyle(ln), w = ln.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          Object.assign(ta.style, { width: `${w}px`, height: '600px', padding: '0', border: '0', boxSizing: 'content-box', font: cs.font, letterSpacing: cs.letterSpacing, wordSpacing: cs.wordSpacing, whiteSpace: cs.whiteSpace, overflowWrap: cs.overflowWrap, wordBreak: cs.wordBreak, tabSize: cs.tabSize }); });
        await H((c) => { const ta = document.getElementById('oracle'); ta.focus(); ta.setSelectionRange(c, c); }, start);
        for (let i = 0; i < keys.length && !bad; i++) {
          // a plain vertical move over a non-empty selection: Chromium's textarea answer differs by caret affinity (seen 2026-11-09:
          // ↑ over [100,101] left the textarea at 101), so the oracle collapses the selection first (→) on both sides and compares
          // the move from a caret; the kit's own rule (up from the selection's start, down from its end) is a unit test
          if (/^(ArrowUp|ArrowDown|Control\+[np]|PageUp|PageDown)$/.test(keys[i])) { const s = await H(() => window.__pangeaHarness.flatSel()); if (s && s[0] !== s[1]) keys.splice(i, 0, 'ArrowRight'); }
          await H(() => { window.__pangeaHarness.tick(300); window.__pangeaHarness.editor.focus(); });
          await press(page, keys[i]);
          await H(() => { const ta = document.getElementById('oracle'); const s = ta.selectionStart, e = ta.selectionEnd, d = ta.selectionDirection; ta.focus(); ta.setSelectionRange(s, e, d); });
          await press(page, keys[i]);
          const got = await H(() => { const h = window.__pangeaHarness, ta = document.getElementById('oracle'); return { zai: h.text(), ta: ta.value, zsel: h.flatSel(), tsel: [ta.selectionStart, ta.selectionEnd] }; });
          if (got.zai !== got.ta || JSON.stringify(got.zsel) !== JSON.stringify(got.tsel)) bad = { run: r, step: i, key: keys[i], keys: keys.slice(0, i + 1).join(' '), start, zai: got.zai, textarea: got.ta, zsel: got.zsel, tsel: got.tsel };
        }
      }
      await H(() => document.getElementById('oracle').removeAttribute('style')); // the page's own geometry again for the checks after
      if (bad) fail('oracle', bad); else pass('oracle', { runs, steps: runs * per });
    }

    // ---------------------------------------------------------------- undo: N presses restore N edits back, each in budget
    if (want('undo')) {
      await H(() => { window.__pangeaHarness.reset({ kind: 'mixed' }); window.__pangeaHarness.caretAfterBlank(); });
      const edits = ['a', 'Enter', 'b', 'Backspace', 'paste', 'Backspace', 'Space', 'Enter'];
      const texts = [await H(() => window.__pangeaHarness.text())];
      for (const k of edits) { await H(() => window.__pangeaHarness.tick(2000)); await press(page, k); texts.push(await H(() => window.__pangeaHarness.text())); }
      let bad = null;
      const changed = texts.map((t, i) => i === 0 || t !== texts[i - 1]);
      const n = changed.filter(Boolean).length - 1;
      const n0 = await H(() => window.__pangeaHarness.editor.latency.length);
      let k = texts.length - 1;
      for (let u = 1; u <= n && !bad; u++) {
        await H(() => window.__pangeaHarness.tick(50)); // a fast double press: 50 ms apart
        await page.keyboard.press('Meta+z');
        while (k > 0 && !changed[k]) k--;
        k -= 1;
        const got = await H(() => window.__pangeaHarness.text());
        if (got !== texts[k]) bad = { press: u, want: texts[k].split('\n').slice(0, 6), got: got.split('\n').slice(0, 6) };
      }
      await page.waitForTimeout(100);
      const lat = await H((from) => window.__pangeaHarness.editor.latency.slice(from).filter((l) => l.name === 'mod+z').map((l) => Math.round(l.ms)), n0);
      measurements.undo = { presses: n, ms: lat };
      if (!bad && (lat.length !== n || lat.some((m) => m > 100))) bad = { presses: n, painted: lat };
      if (bad) fail('undo', bad); else pass('undo', measurements.undo);
    }

    // ---------------------------------------------------------------- round trip at several scroll positions
    if (want('roundtrip')) {
      await H(() => window.__pangeaHarness.reset({ kind: 'mixed' }));
      let bad = null; let lines = 0;
      for (const dy of [0, -400, -900, -1500]) {
        if (dy) { await page.mouse.move(400, 400); await page.mouse.wheel(0, dy); await page.waitForTimeout(150); }
        const r = await H(() => window.__pangeaHarness.roundTrip());
        lines++;
        if (r && !bad) bad = { scroll: dy, fails: r };
      }
      if (bad) fail('roundtrip', bad); else pass('roundtrip', { positions: lines });
    }

    // ---------------------------------------------------------------- anchor through paging
    if (want('anchor')) {
      await H(() => window.__pangeaHarness.reset({ kind: 'paged', autopage: false }));
      const drifts = [];
      for (const dy of [-1200, -100000, -100000, -100000]) {
        await page.mouse.move(400, 400); await page.mouse.wheel(0, dy); await page.waitForTimeout(200);
        const d = await H(() => window.__pangeaHarness.pageNow());
        drifts.push({ ...d, drift: d.after == null ? null : Math.round((d.after - d.before) * 10) / 10 });
      }
      measurements.anchor = drifts.map((d) => d.drift);
      const bad = drifts.find((d) => d.drift === null || Math.abs(d.drift) >= 1);
      if (bad) fail('anchor', drifts); else pass('anchor', { drifts: measurements.anchor });
    }
    if (pageErrors.length && !results.projection?.ok === false) fail('projection', { pageErrors: pageErrors.slice(0, 3) });
  } finally { await browser.close(); }
  const ok = Object.values(results).every((r) => r.ok);
  return { ok, results, measurements };
}
