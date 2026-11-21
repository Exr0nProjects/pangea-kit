// Counted, hermetic test suites for the deploy gate (PANGEA3-DESIGN §16-17; DESIGN-CONFORMANCE §E 5c; census A8, A24, A25,
// A30, B26, C35). "A test that cannot fail is a defect": a suite is red unless it ran at least `min_cases` cases, none
// skipped, todo or focused; every test file the runner can collect belongs to some suite; and the runner itself is proven
// to go red on a planted failing case before its green is believed.
//
// A suite: { name, vitest?: [file filters...] (default every file), min_cases?: 1, budget_ms?: 300000, cwd?: appRoot }.
// Runs `node_modules/.bin/vitest run --reporter=json` with HOME, XDG dirs and TMPDIR in a fresh temp dir and TZ=UTC, so a
// test can neither read nor write the machine's real config or state.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { walk } from '../../lint/run.js';

export const DEFAULT_SUITES = [{ name: 'unit', vitest: [], min_cases: 1 }];
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const FOCUS = /\b(?:it|test|describe|suite)\s*\.\s*(only|skip|todo)\s*\(|\b(?:xit|xdescribe|fit|fdescribe)\s*\(/g;

function vitestBin(cwd) {
  const b = join(cwd, 'node_modules', '.bin', 'vitest');
  if (!existsSync(b)) throw new Error(`no vitest at ${b}`);
  return b;
}

export function hermeticEnv(home) {
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), TMPDIR: home, TZ: 'UTC', CI: '1', NODE_ENV: 'test', LANG: 'C.UTF-8' };
  // Playwright's browsers live under the real user cache; pointing at them reads no config or state
  env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || join(process.env.HOME || '', 'Library/Caches/ms-playwright');
  // and the playwright package itself is found from the real webchat checkout (a tool, like the browsers; no state)
  env.QK_PLAYWRIGHT_FROM = process.env.QK_PLAYWRIGHT_FROM || join(process.env.HOME || '', 'projects/host-app/lib/host-app/webchat');
  return env;
}

/** Test files in `root` that use .only / .skip / .todo (or x/f variants): [{file, line, what}]. */
export function focusMarks(root) {
  const out = [];
  for (const f of walk(root)) {
    if (!TEST_FILE.test(f)) continue;
    // code only: comments and string literals (fixtures that contain the words) are blanked, keeping line numbers
    const t = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, ' '));
    for (const m of t.matchAll(FOCUS)) out.push({ file: relative(root, f).split(sep).join('/'), line: t.slice(0, m.index).split('\n').length, what: m[0].trim() });
  }
  return out;
}

/** Run one vitest suite and count it. Returns {name, ok, total, passed, failed, skipped, files, ms, why[]}. */
export function runVitestSuite(root, suite, { log = () => {} } = {}) {
  const cwd = realpathSync(suite.cwd || root);
  const home = mkdtempSync(join(tmpdir(), 'qk-suite-home-'));
  const out = join(home, 'vitest.json');
  const t0 = Date.now();
  try {
    const r = spawnSync(vitestBin(cwd), ['run', ...(suite.vitest || []), '--reporter=json', `--outputFile=${out}`], { cwd, env: hermeticEnv(home), encoding: 'utf8', timeout: suite.budget_ms ?? 300000, maxBuffer: 1 << 26 });
    const res = { name: suite.name, ok: false, total: 0, passed: 0, failed: 0, skipped: 0, files: [], ms: Date.now() - t0, why: [] };
    if (r.error?.code === 'ETIMEDOUT' || r.signal) { res.why.push(`over its ${suite.budget_ms ?? 300000} ms budget (killed ${r.signal || 'timeout'})`); return res; }
    if (!existsSync(out)) { res.why.push(`no JSON report (exit ${r.status}): ${`${r.stdout}${r.stderr}`.split('\n').slice(-15).join('\n')}`); return res; }
    const j = JSON.parse(readFileSync(out, 'utf8'));
    res.total = j.numTotalTests; res.passed = j.numPassedTests; res.failed = j.numFailedTests + (j.numFailedTestSuites || 0);
    res.skipped = (j.numPendingTests || 0) + (j.numTodoTests || 0);
    res.files = j.testResults.map((t) => relative(cwd, t.name).split(sep).join('/'));
    const min = suite.min_cases ?? 1;
    if (res.failed) res.why.push(`${res.failed} failed: ${j.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === 'failed').map((a) => a.fullName)).concat(j.testResults.filter((t) => t.status === 'failed' && !t.assertionResults.length).map((t) => `${t.name}: ${(t.message || '').slice(0, 200)}`)).slice(0, 8).join('; ')}`);
    if (res.total === 0) res.why.push('ran 0 test cases');
    else if (res.passed < min) res.why.push(`ran ${res.passed} passing cases, fewer than its min_cases ${min}`);
    if (res.skipped) res.why.push(`${res.skipped} case(s) skipped or todo (a skipped case proves nothing)`);
    if (r.status !== 0 && !res.why.length) res.why.push(`vitest exited ${r.status}`);
    res.ok = res.why.length === 0;
    log(`gate: suite ${suite.name} ${res.ok ? 'ok' : 'FAILED'}: ${res.passed}/${res.total} passed, ${res.skipped} skipped, ${res.files.length} files, ${res.ms} ms${res.ok ? '' : `\n  ${res.why.join('\n  ')}`}`);
    return res;
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Every test file vitest would collect in `root` (vitest list --json --filesOnly). */
export function collectable(root) {
  root = realpathSync(root);
  const home = mkdtempSync(join(tmpdir(), 'qk-suite-home-'));
  try {
    const r = spawnSync(vitestBin(root), ['list', '--filesOnly', '--json'], { cwd: root, env: hermeticEnv(home), encoding: 'utf8', timeout: 120000, maxBuffer: 1 << 26 });
    const j = JSON.parse((r.stdout || '').slice((r.stdout || '').indexOf('[')) || '[]');
    return [...new Set(j.map((x) => relative(root, x.file || x).split(sep).join('/')))].sort();
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/**
 * Self-check: prove the suite runner goes red. A planted failing case in a scratch copy of the vitest setup must be
 * collected (vitest list) and counted as a failure; a planted .skip must be reported. Returns {ok, why[]}.
 */
export function selfCheck(root, { log = () => {} } = {}) {
  root = realpathSync(root);
  const why = [];
  const name = `__pangea_gate_canary_${process.pid}.test.js`;
  // place it beside an existing collected test file, so the app's include globs pick it up exactly as a new test would
  const files = collectable(root);
  if (!files.length) return { ok: false, why: ['vitest collects no test files at all'] };
  const dir = join(root, files[0], '..');
  const canary = join(dir, name);
  writeFileSync(canary, "import { it, expect } from 'vitest'\nit('qk gate canary: must fail', () => { expect(1).toBe(2) })\nit.skip('qk gate canary: skipped', () => {})\n");
  try {
    const rel = relative(root, canary).split(sep).join('/');
    if (!collectable(root).includes(rel)) why.push(`a new test file (${rel}) is not collected by the suite`);
    const r = runVitestSuite(root, { name: 'canary', vitest: [name], min_cases: 1 });
    if (r.ok) why.push('the planted failing case left the suite green');
    if (!r.failed) why.push('the planted failing case was not counted as failed');
    if (!r.skipped) why.push('the planted skipped case was not counted');
    if (!focusMarks(root).some((m) => m.file === rel)) why.push('the planted .skip was not found by the focus scan');
  } finally { rmSync(canary, { force: true }); }
  log(`gate: suite self-check ${why.length ? 'FAILED' : 'ok'} (planted failing + skipped case went red)${why.length ? `: ${why.join('; ')}` : ''}`);
  return { ok: why.length === 0, why };
}

/** Run `suites` in `root`: focus scan, self-check, every suite counted, coverage of every collectable file. */
export function runSuites(root, suites = DEFAULT_SUITES, { log = () => {}, self = true } = {}) {
  root = realpathSync(root);
  const report = { ok: true, focus: focusMarks(root), self: null, suites: [], uncovered: [] };
  if (report.focus.length) { report.ok = false; log(`gate: focused/skipped tests refused: ${report.focus.map((m) => `${m.file}:${m.line} ${m.what}`).join(', ')}`); }
  if (self) { report.self = selfCheck(root, { log }); if (!report.self.ok) report.ok = false; }
  const ran = new Set();
  for (const s of suites) {
    const r = runVitestSuite(root, s, { log });
    report.suites.push(r);
    if (!r.ok) report.ok = false;
    for (const f of r.files) ran.add(f);
  }
  report.uncovered = collectable(root).filter((f) => !ran.has(f));
  if (report.uncovered.length) { report.ok = false; log(`gate: test files outside every suite (they would never block a deploy): ${report.uncovered.join(', ')}`); }
  return report;
}
