// lib/testing: the generic parity harness, proven on a second app (the todo example), not on webchat.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, shrink, coverage, defineVocabulary } from '../lib/testing/scenario.js';
import { record, compareTraces, differential, canonicalizer } from '../lib/testing/trace.js';
import { check, summarize, deadlineBound } from '../lib/testing/invariants.js';
import { decodePng, encodePng, diffImages, writeReport } from '../lib/testing/visualdiff.js';
import { installFrameRecorder, readFrames, jumps, monotone, longFrames, firstFrame, quietFrom } from '../lib/testing/frames.js';
import { vocabulary, driver, normalizer, invariants, render } from '../lib/testing/example/todo.harness.js';

const seeds = (n, from = 1) => Array.from({ length: n }, (_, i) => from + i);

describe('scenario', () => {
  it('is data: the same seed gives the same JSON, every opened fault is closed', () => {
    const a = generate(vocabulary, 7, { length: 30 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(generate(vocabulary, 7, { length: 30 })));
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    const opens = a.steps.filter((s) => s.op === 'offline').length;
    expect(a.steps.filter((s) => s.op === 'online').length).toBeGreaterThanOrEqual(opens);
    expect(new Set(a.steps.filter((s) => s.text).map((s) => s.text)).size).toBe(a.steps.filter((s) => s.text).length);
  });
  it('refuses a closer that is not declared', () => {
    expect(() => defineVocabulary({ ops: { down: { closes: 'up' } } })).toThrow(/unknown op/);
  });
  it('ddmin shrinks to the minimal failing subsequence', async () => {
    const steps = Array.from({ length: 40 }, (_, i) => ({ op: `s${i}` }));
    const fails = async (list) => list.some((s) => s.op === 's7') && list.some((s) => s.op === 's31');
    const { steps: small } = await shrink(steps, fails, { budget: 200 });
    expect(small.map((s) => s.op)).toEqual(['s7', 's31']);
  });
  it('reports coverage of the vocabulary', () => {
    const c = coverage(vocabulary, seeds(20).map((s) => generate(vocabulary, s)));
    expect(c.unexercised).toEqual([]);
  });
});

describe('differential and model check on the todo app', () => {
  it('A vs A: deterministic, no divergence, every invariant holds over 40 seeds', async () => {
    const rows = await differential({ vocabulary, generate, seeds: seeds(40), length: 20, driverA: driver(), driverB: driver(), normalizer, invariants, check, shrinkBudget: 0 });
    expect(rows.filter((r) => r.divergence)).toEqual([]);
    const totals = summarize(rows.map((r) => r.violationsB));
    for (const [name, t] of Object.entries(totals)) expect(t.violations, name).toBe(0);
  });
  it('A vs a broken B: diverges, violates noLoss, and shrinks to a few steps', async () => {
    const rows = await differential({ vocabulary, generate, seeds: seeds(20), length: 20, driverA: driver(), driverB: driver({ bug: 'forget-offline' }), normalizer, invariants, check, shrinkBudget: 30 });
    const caught = rows.filter((r) => r.divergence);
    expect(caught.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.violationsB.noLoss.length)).toBe(true);
    expect(rows.every((r) => Object.values(r.violationsA).every((v) => !v.length))).toBe(true);
    const shrunk = caught.map((r) => r.shrunk.steps.length);
    expect(Math.min(...shrunk)).toBeLessThanOrEqual(5);
    // the shrunk scenario still diverges when replayed as data
    const s = caught.find((r) => r.shrunk.steps.length === Math.min(...shrunk)).shrunk;
    const replayed = JSON.parse(JSON.stringify(s));
    const [a, b] = [await record({ scenario: replayed, driver: driver() }), await record({ scenario: replayed, driver: driver({ bug: 'forget-offline' }) })];
    expect(compareTraces(a, b, normalizer)).not.toBeNull();
  });
  it('canonicalizes minted ids by first appearance', () => {
    const c = canonicalizer([/id-\d+/u]);
    expect(c({ a: 'id-9 then id-3', b: ['id-9'] })).toEqual({ a: '$1 then $2', b: ['$1'] });
  });
  it('deadlineBound: null is a violation, undefined is not measured', () => {
    const inv = deadlineBound({ measure: (s) => s.meta.ms, deadlineMs: 100, what: 'paint' });
    const trace = { steps: [{ meta: { ms: 50 } }, { meta: { ms: 150 } }, { meta: { ms: null } }, { meta: {} }] };
    expect(check(trace, { inv }).inv.map((v) => v.step)).toEqual([1, 2]);
  });
});

describe('visualdiff', () => {
  const img = (w, h, f) => { const data = new Uint8Array(w * h * 4); for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const [r, g, b] = f(x, y); data.set([r, g, b, 255], (y * w + x) * 4); } return { width: w, height: h, data }; };
  it('round-trips PNG and finds no difference between identical renders', () => {
    const a = render({ items: ['[ ] one', '[x] two'] });
    const png = encodePng(a);
    expect(decodePng(png).data).toEqual(a.data);
    expect(diffImages(png, png).diffPixels).toBe(0);
  });
  it('tolerates a one-pixel shift (antialias), not a real change; masks are skipped', () => {
    const edge = (off) => img(40, 20, (x) => (x < 20 + off ? [0, 0, 0] : [255, 255, 255]));
    expect(diffImages(edge(0), edge(1)).diffPixels).toBe(0);
    expect(diffImages(edge(0), edge(1), { shift: 0 }).diffPixels).toBe(20);
    expect(diffImages(edge(0), edge(8)).diffPixels).toBeGreaterThan(100);
    expect(diffImages(edge(0), edge(8), { masks: [{ x: 0, y: 0, w: 40, h: 20 }] }).diffPixels).toBe(0);
  });
  it('writes a side-by-side report and fails a missing side', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qk-visual-'));
    const a = encodePng(render({ items: ['[ ] a'] })); const b = encodePng(render({ items: ['[x] a'] }));
    const { path, results } = writeReport(dir, [
      { view: 'same', viewport: 'desk', a, b: a, maxRatio: 0 },
      { view: 'changed', viewport: 'desk', a, b, maxRatio: 0.001 },
      { view: 'missing', viewport: 'desk', a, b: null, maxRatio: 1 }
    ]);
    expect(results.map((r) => r.pass)).toEqual([true, false, false]);
    expect(existsSync(join(dir, 'changed-desk-diff.png'))).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('1/3 pass');
  });
});

describe('frames', () => {
  it('installs before the page has a root element (an init script) and records once it appears', async () => {
    const { vi } = await import('vitest');
    const bare = document.implementation.createDocument(null, null, null);
    expect(bare.documentElement).toBeNull();
    let queue = [];
    globalThis.requestAnimationFrame = (f) => queue.push(f);
    vi.stubGlobal('document', bare);
    try {
      expect(() => installFrameRecorder({ track: ['#root'] })).not.toThrow();
      queue.splice(0).forEach((f) => f(performance.now()));
      const root = bare.createElementNS('http://www.w3.org/1999/xhtml', 'html'); root.id = 'root'; bare.appendChild(root);
      await Promise.resolve();
      queue.splice(0).forEach((f) => f(performance.now()));
      const frames = readFrames();
      expect(frames.length).toBe(2);
      expect(frames[0].els['#root'].present).toBe(false);
      expect(frames[1].mutations).toBeGreaterThan(0);
    } finally { vi.unstubAllGlobals(); }
  });
  it('records frames in a page and the analysis finds jumps, reversals, long frames, first paint', async () => {
    document.body.innerHTML = '<div id="box">x</div>';
    let queue = []; let t = 0;
    globalThis.requestAnimationFrame = (f) => queue.push(f);
    installFrameRecorder({ track: ['#box', '#late'] });
    const tick = (ms) => { t += ms; const q = queue; queue = []; q.forEach((f) => f(performance.now() + t)); };
    tick(16); tick(16);
    const late = document.createElement('p'); late.id = 'late'; late.textContent = 'hi'; document.body.append(late);
    await Promise.resolve();
    tick(50); tick(16);
    const frames = readFrames();
    expect(frames.length).toBe(4);
    expect(frames[2].mutations).toBeGreaterThan(0);
    expect(longFrames(frames).map((f) => f.dt)).toEqual(frames.slice(1).filter((f) => f.dt > 34).map((f) => f.dt));
    expect(frames[2].dt).toBeGreaterThanOrEqual(50);
    expect(firstFrame(frames, '#late', (e) => e.present)).toBe(frames[2]);
    const synthetic = [0, 10, 20, 90, 80].map((y, i) => ({ t: i * 16, dt: 16, mutations: i < 3 ? 1 : 0, els: { s: { present: true, y } } }));
    expect(jumps(synthetic, 's', { px: 24 }).map((j) => j.frame)).toEqual([3]);
    expect(monotone(synthetic, 's').monotone).toBe(false);
    expect(quietFrom(synthetic, 2)).toBe(synthetic[3]);
  });
});
