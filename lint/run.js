// quicklook-lint runner: walk an app, count each rule per file, compare against the ratchet file.
//
// Zero config: lintApp({ root }) scans root/src if it exists (else root), reads root/quicklook-lint.allow.json if present
// (absent = every allowance is 0), and loads root/quicklook-lint.rules.mjs if present (app-specific rules, same shape).
//
// Ratchet file format (quicklook-lint.allow.json):
//   { "version": 1,
//     "rules": { "<rule id>": { "<path relative to root>": <count> } },     // frozen counts; may only go down
//     "off":   { "<rule id>": "<why, and which check owns it instead>" } }   // a reasoned opt-out, printed on every run
// A count above its allowance is a new violation; a count below it is a stale allowance (lower it: `--ratchet` does).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rules as kitRules, stripComments, USES_EDITOR, EDITOR_OWNER, classes } from './rules.js';

export const ALLOW_FILE = 'quicklook-lint.allow.json';
export const RULES_FILE = 'quicklook-lint.rules.mjs';
export const GUIDE = 'tools/pangea-kit/docs/LINT.md';
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', 'coverage', '.svelte-kit', '.stryker-tmp', 'test-results', 'playwright-report']);

export function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.') || /^build[.-]/.test(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

export function loadAllow(root) {
  const p = join(root, ALLOW_FILE);
  if (!existsSync(p)) return { version: 1, rules: {}, off: {} };
  const a = JSON.parse(readFileSync(p, 'utf8'));
  if (a.version !== 1) throw new Error(`${p}: version must be 1`);
  return { version: 1, rules: a.rules || {}, off: a.off || {} };
}

/** Count every rule over `files` (absolute paths) with paths relative to `root`. Pure apart from reading the files. */
export function measure(list, files, root, ctx = {}) {
  const out = Object.fromEntries(list.map((r) => [r.id, {}]));
  const texts = new Map();
  for (const p of files) {
    const rel = relative(root, p).split(sep).join('/');
    for (const r of list) {
      if (!r.scope(rel, ctx)) continue;
      if (!texts.has(p)) texts.set(p, stripComments(readFileSync(p, 'utf8')));
      const n = r.count(texts.get(p), rel, ctx);
      if (n) out[r.id][rel] = n;
    }
  }
  return out;
}

/** Compare counts with allowances: { over: [{rule, file, n, allowed}], stale: [...] }. */
export function compare(list, counts, allow) {
  const over = [], stale = [];
  for (const r of list) {
    if (allow.off[r.id]) continue;
    const a = allow.rules[r.id] || {}, got = counts[r.id] || {};
    for (const [file, n] of Object.entries(got)) if (n > (a[file] ?? 0)) over.push({ rule: r, file, n, allowed: a[file] ?? 0 });
    for (const [file, n] of Object.entries(a)) if ((got[file] ?? 0) < n) stale.push({ rule: r, file, n: got[file] ?? 0, allowed: n });
  }
  return { over, stale };
}

/** The app's own rules file, if any: { rules, scan } (scan: extra paths relative to root, default ['src']). */
export async function loadAppRules(root) {
  const p = join(root, RULES_FILE);
  if (!existsSync(p)) return { rules: [], scan: null };
  const m = await import(pathToFileURL(p).href);
  return { rules: m.rules || [], scan: m.scan || null };
}

/** Lint an app. Returns { rules, counts, over, stale, off, ok }. */
export async function lintApp({ root, scan, extraRules, ctx = {}, allow } = {}) {
  root ??= process.cwd();
  const app = extraRules ? { rules: extraRules, scan: null } : await loadAppRules(root);
  const list = [...kitRules, ...app.rules];
  scan ??= app.scan?.map((p) => join(root, p));
  const ids = new Set();
  for (const r of list) { if (ids.has(r.id)) throw new Error(`quicklook-lint: duplicate rule id ${r.id}`); ids.add(r.id); }
  const dirs = scan ?? [existsSync(join(root, 'src')) ? join(root, 'src') : root];
  const files = dirs.flatMap((d) => (statSync(d).isDirectory() ? walk(d) : [d]));
  if (ctx.editorApp === undefined) ctx = { ...ctx, editorApp: files.some((f) => { const rel = relative(root, f).split(sep).join('/'); return classes.client(rel) && !EDITOR_OWNER.test(rel) && USES_EDITOR.test(readFileSync(f, 'utf8')); }) };
  const counts = measure(list, files, root, ctx);
  allow ??= loadAllow(root);
  const { over, stale } = compare(list, counts, allow);
  return { rules: list, counts, over, stale, off: allow.off, ok: !over.length && !stale.length };
}

/** One line per finding, each with the kit way to do it right and its guide anchor. */
export function format({ over, stale, off }) {
  const lines = [];
  for (const { rule, file, n, allowed } of over) lines.push(`${file}: ${rule.id} ${n} > allowed ${allowed}. ${rule.prevents}.\n  do: ${rule.how}  (${GUIDE}#${rule.guide || rule.id})`);
  for (const { rule, file, n, allowed } of stale) lines.push(`${file}: ${rule.id} allowance ${allowed} is stale (now ${n}); lower it (quicklook-lint --ratchet).`);
  for (const [id, why] of Object.entries(off || {})) lines.push(`off: ${id} (${why})`);
  return lines.join('\n');
}

/** Write the ratchet file: --init freezes today's counts; --ratchet only lowers existing allowances. */
export function writeAllow(root, counts, { mode }) {
  const cur = loadAllow(root);
  const next = { version: 1, rules: {}, off: cur.off };
  for (const [id, files] of Object.entries(counts)) {
    if (cur.off[id]) continue;
    const base = mode === 'init' ? files : Object.fromEntries(Object.entries(cur.rules[id] || {}).map(([f, n]) => [f, Math.min(n, files[f] ?? 0)]).filter(([, n]) => n > 0));
    if (Object.keys(base).length) next.rules[id] = Object.fromEntries(Object.entries(base).sort());
  }
  writeFileSync(join(root, ALLOW_FILE), JSON.stringify(next, null, 1) + '\n');
  return next;
}
