// The deploy gate (rule 5: construction, then lint, then a deploy-blocking check; never nightly-only). publish.mjs runs it
// before staging, and an app's own deploy script runs it before building (zai2: scripts/deploy.mjs). Exit is refusal.
//
// gate(appRoot) runs:
//   1. quicklook-lint over the app (lint/run.js, kit rules + the app's ratchet)
//   1b. every module that declares state (declare, keyed, defineView ...): loaded, and every law run over every
//      declaration and view (lib/validate-app.mjs, lib/validate.js); config `validate: { gens, seeds, length }`
//   2. if the app uses the kit editor: its declared checks file quicklook-ui.config.mjs is required, and
//      a. its unit command (jsdom: fresh-render diff after every action, mutation guard)
//      b. the browser checks (lib/editor/browser-check.mjs) against its harness, built with the app's own vite config
//      c. the scroll checks (lib/editor/scroll-check.mjs): the kit scroll harness ('scroll:*', frame-level anchor drift through
//         landing, reload, prepend, follow, async answers, tab switch, foreign scrolls, and the user control) and the
//         app's own harness ('landing'); any drift of 1 px in any frame refuses
//   3. if quicklook-ui.config.mjs declares a sync model (any app, editor or not): the multi-device convergence fuzz
//      (lib/testing/convergence.js) over it, every mode, `seeds` seeds (default 1000). The model module is loaded through
//      the app's own vite config (its aliases resolve), default export as convergence.js documents.
//   default export of quicklook-ui.config.mjs: { harness: 'test/ui', viteConfig: 'vite.config.js', unit: ['npx', 'vitest', 'run', 'test/editor.test.js'], seed, steps,
//     sync?: { model: 'test/sync-model.js', seeds: 1000 } }
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { lintApp, format, walk } from '../../lint/run.js';
import { runBrowserChecks } from './browser-check.mjs';
import { runConvergenceFuzz, formatFailure } from '../testing/convergence.js';
// The one-kit-source check belongs to a private multi-checkout layout; a standalone kit checkout does not ship lib/deploy/kit-source.mjs and skips it.
const kitSource = await import('../deploy/kit-source.mjs').catch(() => null);
import { runSuites, DEFAULT_SUITES } from '../deploy/suites.mjs';

import { validateApp } from '../validate-app.mjs';

/** The kit tree this gate runs from: the one kit every app reference must resolve into (lib/deploy/kit-source.mjs). */
export const KIT_ROOT = join(import.meta.dirname, '..', '..');
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
/** The suites an app declares: `suites`, else the legacy `unit` file list as one vitest suite, else every test file. */
export function suitesOf(cfg) {
  if (cfg?.suites) return cfg.suites;
  if (cfg?.unit) return [{ name: 'unit', vitest: cfg.unit.filter((a) => TEST_FILE.test(a)), min_cases: 1 }];
  return DEFAULT_SUITES;
}

export const UI_CONFIG = 'quicklook-ui.config.mjs';
const USES_EDITOR = /from\s+['"][^'"]*editor\/editor\.js['"]|\bcreateEditor\s*\(/;

export function usesEditor(appRoot) {
  const src = join(appRoot, 'src');
  const dir = existsSync(src) ? src : appRoot;
  return walk(dir).some((f) => /\.(m?js|svelte)$/.test(f) && USES_EDITOR.test(readFileSync(f, 'utf8')));
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
function serve(dir) {
  const srv = createServer((req, res) => {
    const p = normalize(join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    const f = p.startsWith(dir) && existsSync(p) && statSync(p).isDirectory() ? join(p, 'index.html') : p;
    if (!f.startsWith(dir) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${srv.address().port}/`, close: () => srv.close() })));
}

/** Build the harness and run the browser checks. */
export async function browserChecks(appRoot, cfg, { only = null, log = () => {} } = {}) {
  const req = createRequire(join(appRoot, 'package.json'));
  const { build } = await import(pathToFileURL(req.resolve('vite')).href);
  const out = mkdtempSync(join(tmpdir(), 'qk-ui-harness-'));
  try {
    await build({ configFile: join(appRoot, cfg.viteConfig || 'vite.config.js'), root: join(appRoot, cfg.harness || 'test/ui'), base: './', logLevel: 'error', build: { outDir: out, emptyOutDir: true, target: 'es2022' } });
    const s = await serve(out);
    try { return await runBrowserChecks({ url: s.url, seed: cfg.seed ?? 7, steps: cfg.steps ?? 120, only, log }); } finally { s.close(); }
  } finally { rmSync(out, { recursive: true, force: true }); }
}

/** Load the app's sync model through its vite config and run the convergence fuzz over it. */
export async function syncFuzz(appRoot, cfg, { seeds = cfg.sync?.seeds ?? 1000 } = {}) {
  const req = createRequire(join(appRoot, 'package.json'));
  const { createServer: viteServer } = await import(pathToFileURL(req.resolve('vite')).href);
  const vs = await viteServer({ configFile: join(appRoot, cfg.viteConfig || 'vite.config.js'), root: appRoot, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const mod = await vs.ssrLoadModule(join(appRoot, cfg.sync.model));
    const model = mod.default || mod.model;
    if (!model) throw new Error(`${cfg.sync.model} has no default export (the sync model)`);
    return runConvergenceFuzz(model, { seeds });
  } finally { await vs.close(); }
}

/** Every declared state and view of the app keeps every law (lib/validate-app.mjs); a failure refuses the deploy. */
export async function declarationsCheck(appRoot, cfgPath, report, log) {
  const cfg = existsSync(cfgPath) ? (await import(`${pathToFileURL(cfgPath).href}?t=${Date.now()}`)).default || {} : {};
  const r = await validateApp(appRoot, cfg, { log });
  report.declarations = { ok: r.ok, decls: r.decls.length, views: r.views, failures: r.failures.map((f) => `${f.name}: ${f.law}: ${f.detail ?? ''}`) };
  if (!r.ok) { report.ok = false; log(report.declarations.failures.join('\n')); }
}

export async function gate(appRoot, { only = null, log = (m) => process.stderr.write(`${m}\n`), skipUnit = false, kitRoot = KIT_ROOT } = {}) {
  const report = { ok: true, lint: null, kitSource: null, unit: null, sync: null, browser: null };
  // one kit source: every reference to the kit in the app (client, Worker, scripts, tests) resolves into this kit
  if (kitSource && (!only || only.includes('kit-source'))) {
    const { checkKitSource, formatKitSource } = kitSource;
    const k = checkKitSource(appRoot, { kitRoot });
    report.kitSource = { ok: k.ok, violations: k.violations };
    if (!k.ok) { report.ok = false; log(`gate: kit imported from another tree (one kit source: ${kitRoot})\n${formatKitSource(k)}`); }
  }
  if (!only || only.includes('lint')) {
    const l = await lintApp({ root: appRoot });
    report.lint = { ok: l.ok, text: format(l) };
    if (!l.ok) { report.ok = false; log(`gate: lint failed\n${report.lint.text}`); }
  }
  const cfgPath = join(appRoot, UI_CONFIG);
  if (!only || only.includes('declarations')) await declarationsCheck(appRoot, cfgPath, report, log);
  if (existsSync(cfgPath) && (!only || only.includes('sync'))) {
    const c = (await import(`${pathToFileURL(cfgPath).href}?t=${Date.now()}`)).default;
    if (c?.sync?.model) {
      const r = await syncFuzz(appRoot, c);
      report.sync = { ok: r.ok, seeds: r.seeds, ops: r.ops, ms: r.ms, failures: r.failures.map(formatFailure) };
      log(`gate: sync fuzz ${r.ok ? 'ok' : 'FAILED'}: ${r.seeds} seeds x ${r.modes.length} modes, ${r.ops} ops, ${r.ms} ms`);
      if (!r.ok) { report.ok = false; log(report.sync.failures.join('\n\n')); }
    }
  }
  // every declared suite, counted (0 cases, skipped, .only, a test file outside every suite: red), runner proven red first
  const cfg0 = existsSync(cfgPath) ? (await import(`${pathToFileURL(cfgPath).href}?t=${Date.now()}`)).default : null;
  const hasTests = existsSync(join(appRoot, 'node_modules', '.bin', 'vitest')) && walk(appRoot).some((f) => TEST_FILE.test(f));
  if ((cfg0?.suites || cfg0?.unit || hasTests) && !skipUnit && (!only || only.includes('unit'))) {
    const r = runSuites(appRoot, suitesOf(cfg0), { log });
    report.unit = { ok: r.ok, suites: r.suites.map(({ name, ok, total, passed, skipped, files, ms, why }) => ({ name, ok, total, passed, skipped, files: files.length, ms, why })), self: r.self, focus: r.focus, uncovered: r.uncovered };
    if (!r.ok) report.ok = false;
  }
  if (!usesEditor(appRoot)) return report;
  if (!existsSync(cfgPath)) { report.ok = false; log(`gate: ${appRoot} uses the kit editor but declares no ${UI_CONFIG} (its checks); refusing`); return report; }
  const cfg = (await import(`${pathToFileURL(cfgPath).href}?t=${Date.now()}`)).default;
  const browserNames = ['projection', 'model', 'css', 'oracle', 'undo', 'roundtrip', 'anchor', 'timing'];
  const bOnly = only ? only.filter((n) => browserNames.includes(n)) : null;
  if (!only || bOnly.length) {
    report.browser = await browserChecks(appRoot, cfg, { only: bOnly, log });
    if (!report.browser.ok) report.ok = false;
  }
  // scroll, landing and paging (lib/editor/scroll-check.mjs): frame-level drift checks on the kit harness and the app's
  if (!only || only.includes('scroll') || only.includes('landing')) {
    const { scrollGate } = await import('./scroll-check.mjs');
    const s = await scrollGate(appRoot, cfg, { only, log });
    report.browser ??= { ok: true, results: {}, measurements: {} };
    Object.assign(report.browser.results, s.results); Object.assign(report.browser.measurements, s.measurements);
    if (!s.ok) { report.browser.ok = false; report.ok = false; }
  }
  return report;
}

// CLI: node gate.mjs <appRoot> [--only a,b] [--json]
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const root = resolve(args.find((a, k) => !a.startsWith('--') && args[k - 1] !== '--only') || process.cwd());
  const oi = args.indexOf('--only');
  const r = await gate(root, { only: oi >= 0 ? args[oi + 1].split(',') : null });
  console.log(JSON.stringify({ ok: r.ok, lint: r.lint?.ok, declarations: r.declarations && (r.declarations.ok ? `ok (${r.declarations.decls} declarations, ${r.declarations.views} views)` : r.declarations.failures), unit: r.unit?.ok, sync: r.sync && (r.sync.ok ? `ok (${r.sync.seeds} seeds, ${r.sync.ops} ops)` : r.sync.failures), browser: r.browser && Object.fromEntries(Object.entries(r.browser.results).map(([k, v]) => [k, v.ok ? 'ok' : v.detail])), measurements: r.browser?.measurements }, null, 1));
  process.exit(r.ok ? 0 : 1);
}
