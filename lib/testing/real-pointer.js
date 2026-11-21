// Real-pointer probes for a Playwright page (The owner 2026-11-12 18:51 PST, zai3: "clicking it doesn't do anything ... how did that manage to
// happen if u were using kit"). The deploy gate used to prove a control by dispatching an event or calling the reducer; a button that is
// drawn but wired to nothing (or drawn when it should be hidden) passed. These helpers drive the page the way a hand does: the mouse moves
// to the CENTRE of the element's drawn box, presses and releases there (Input.dispatchMouseEvent through Playwright's page.mouse: the
// browser hit-tests the point, so a covered, zero-sized, off-screen or pointer-events:none control is a miss, exactly as for a person).
// Pure helpers over `page`; no app knowledge. Tests: tests/real-pointer.browser.test.js (each probe against a planted bug).

/** The centre of the first element matching `sel` in viewport px, or throws when it has no drawn box. */
export async function centreOf(page, sel) {
  const b = await page.locator(sel).first().boundingBox();
  if (!b || b.width <= 0 || b.height <= 0) throw new Error(`real-pointer: ${sel} has no drawn box (hidden, zero-sized or detached)`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
}

/** Move to the element's centre, assert the browser would deliver the press to it (elementFromPoint is the element or inside it), press, release. */
export async function realClick(page, sel, { hoverMs = 0 } = {}) {
  const c = await centreOf(page, sel);
  const hit = await page.evaluate(([sel, x, y]) => { const el = document.querySelector(sel), at = document.elementFromPoint(x, y); return { ok: Boolean(el && at && (el === at || el.contains(at))), at: at ? `${at.tagName.toLowerCase()}${at.id ? '#' + at.id : ''}${at.className && typeof at.className === 'string' ? '.' + at.className.split(' ')[0] : ''}` : null }; }, [sel, c.x, c.y]);
  if (!hit.ok) throw new Error(`real-pointer: the point at the centre of ${sel} is ${hit.at}, not the control (covered or pointer-events none)`);
  await page.mouse.move(c.x, c.y); if (hoverMs) await page.waitForTimeout(hoverMs);
  await page.mouse.down(); await page.mouse.up();
  return c;
}

/** Select the words `text` inside the first element matching `rowSel` by a real drag from its first to its last character. */
export async function dragSelectText(page, rowSel, text) {
  const p = await page.evaluate(([rowSel, text]) => {
    const row = document.querySelector(rowSel); if (!row) return null;
    const w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let n, tn = null, at = -1;
    while ((n = w.nextNode())) { const i = n.textContent.indexOf(text); if (i >= 0 && n.parentElement.getClientRects().length) { tn = n; at = i; break; } }
    if (!tn) return null;
    const box = (o) => { const r = document.createRange(); r.setStart(tn, o); r.setEnd(tn, o + 1); return r.getBoundingClientRect(); };
    const a = box(at), z = box(at + text.length - 1);
    return { ax: a.left + 0.5, ay: a.top + a.height / 2, zx: z.right - 0.5, zy: z.top + z.height / 2 };
  }, [rowSel, text]);
  if (!p) throw new Error(`real-pointer: no drawn "${text}" in ${rowSel}`);
  await page.mouse.move(p.ax, p.ay); await page.mouse.down(); await page.mouse.move(p.zx, p.zy, { steps: 6 }); await page.mouse.up();
  return p;
}

/** Click inside the drawn text `text` of a row (the middle of its n-th character): puts the caret there by a real click. */
export async function clickInText(page, rowSel, text, nth = 1) {
  const p = await page.evaluate(([rowSel, text, nth]) => {
    const row = document.querySelector(rowSel); if (!row) return null;
    const w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) { const i = n.textContent.indexOf(text); if (i >= 0 && n.parentElement.getClientRects().length) { const r = document.createRange(); r.setStart(n, i + nth); r.setEnd(n, i + nth + 1); const b = r.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2 }; } }
    return null;
  }, [rowSel, text, nth]);
  if (!p) throw new Error(`real-pointer: no drawn "${text}" in ${rowSel}`);
  await page.mouse.click(p.x, p.y);
  return p;
}

/** Every element carrying the `hidden` attribute that is nevertheless drawn (an author `display` rule beat the attribute): [{ sel, display }]. */
export const hiddenLeaks = (page) => page.evaluate(() => [...document.querySelectorAll('[hidden]')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => ({ sel: `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : ''}`, display: getComputedStyle(e).display })));

/** The distinct colours an icon paints with (text colour of the element and of every descendant, background of each box, SVG fill and stroke),
 *  transparent ones dropped: a monochrome icon has exactly one, and it is the element's own text colour. */
export const iconColours = (page, sel) => page.evaluate((sel) => {
  const root = document.querySelector(sel), out = new Set(); if (!root) return null;
  const clear = (c) => !c || c === 'none' || /^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)$/.test(c) || c === 'transparent';
  for (const e of [root, ...root.querySelectorAll('*')]) {
    const cs = getComputedStyle(e), own = e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own && !clear(cs.color)) out.add(cs.color);
    if (e !== root && !clear(cs.backgroundColor)) out.add(cs.backgroundColor);
    if (e instanceof SVGElement) { for (const k of ['fill', 'stroke']) if (!clear(cs[k])) out.add(cs[k]); }
  }
  return { colours: [...out], own: getComputedStyle(root).color };
}, sel);

/** The text a line shows: its innerText with the app's own non-text furniture (given selectors) removed. Hidden (display:none) syntax is not in innerText. */
export const drawnLineText = (page, rowSel, furniture = '') => page.evaluate(([rowSel, furniture]) => {
  const row = document.querySelector(rowSel); if (!row || !row.getClientRects().length) return null;
  let t = row.innerText; if (furniture) for (const e of row.querySelectorAll(furniture)) t = t.replace(e.innerText, '');
  return t;
}, [rowSel, furniture]);

/** Sample `sel`'s computed opacity and visibility every animation frame for `ms` while `during()` runs (a real click, say); { min, samples }. */
export async function sampleOpacity(page, sel, during, { ms = 600 } = {}) {
  await page.evaluate(([sel, ms]) => { window.__rpSamples = []; const t0 = performance.now(); const f = () => { const e = document.querySelector(sel); const cs = e && getComputedStyle(e); window.__rpSamples.push({ t: Math.round(performance.now() - t0), o: e ? Number(cs.opacity) : -1, v: e ? cs.visibility : 'none', n: e ? 1 : 0 }); if (performance.now() - t0 < ms) requestAnimationFrame(f); }; requestAnimationFrame(f); }, [sel, ms]);
  await during();
  await page.waitForTimeout(ms + 100);
  const samples = await page.evaluate(() => window.__rpSamples);
  return { samples, min: Math.min(...samples.map((s) => s.o)), max: Math.max(...samples.map((s) => s.o)) };
}
