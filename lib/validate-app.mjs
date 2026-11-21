// The deploy gate's declaration check (lib/editor/gate.mjs calls validateApp; conformance row #38, plan step 9):
// every app module that declares state is loaded through the app's own vite config (its aliases resolve, so the
// declarations land in the same kit registry this check reads), then lib/validate.js runs every law over every
// declaration and view. Refused:
//   - any law failure, including an action no generated step ever exercised (coverage);
//   - state declared in a .svelte file (the gate cannot load it; declare in a module);
//   - a module that declares state and does not load;
//   - modules that declare state but no declaration reached the kit's registry (the app imports another kit copy);
//   - an app that calls createEditor or openRows with no editor:/rows: declaration registered (row #38: the editor and the
//     row store register what they hold by construction, but the gate never runs them, so the app declares them at
//     module level: declareEditor(contract, app), declareRows({ name, fields, together })).
// Config (optional), quicklook-ui.config.mjs: { validate: { gens: 'test/gens.js', seeds: 40, length: 24 } } where the
// gens module's default export is { [declarationName]: gen(rng, state) -> [action, payload] }.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { walk } from '../lint/run.js';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DECLARES = /\b(?:declare|declareComponent|declareEditor|declareRows|defineView|keyed|marker|onceId)\s*\(/;
const USES_EDITOR = /\bcreateEditor\s*\(/, USES_ROWS = /\bopenRows\s*\(/;
const SKIP = /(?:^|\/)(?:node_modules|dist|build|\.svelte-kit|test|tests|__tests__|__oracle__)\/|\.(?:test|spec)\.m?js$/;

/** App source files that declare state (static scan): { modules, svelte, editor, rows } (editor/rows: some file calls
 *  createEditor / openRows). */
export function declaringFiles(appRoot) {
  const src = join(appRoot, 'src');
  const dir = existsSync(src) ? src : appRoot;
  const modules = [], svelte = [];
  let editor = false, rows = false;
  for (const f of walk(dir)) {
    const rel = relative(appRoot, f);
    if (SKIP.test(rel) || f.startsWith(join(KIT, 'lib'))) continue;
    if (!/\.(m?js|svelte)$/.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    if (USES_EDITOR.test(text)) editor = true;
    if (USES_ROWS.test(text)) rows = true;
    if (!DECLARES.test(text) || !/['"][^'"]*\/(?:model|components|recipes|views|declare|rows-declare)\.js['"]/.test(text)) continue;
    (f.endsWith('.svelte') ? svelte : modules).push(f);
  }
  return { modules, svelte, editor, rows };
}

async function viteFor(appRoot) {
  for (const base of [appRoot, KIT]) {
    try { return await import(pathToFileURL(createRequire(join(base, 'package.json')).resolve('vite')).href); } catch { /* next */ }
  }
  throw new Error('validateApp: vite is not installed for the app or the kit');
}

/** Load every declaring module and validate. Returns { ok, decls, views, failures, files } (failures as validate.js). */
export async function validateApp(appRoot, cfg = {}, { log = () => {} } = {}) {
  const { modules, svelte, editor, rows } = declaringFiles(appRoot);
  const failures = svelte.map((f) => ({ name: relative(appRoot, f), law: 'loadable', detail: 'state declared in a .svelte file: declare it in a module the gate can load' }));
  const { createServer } = await viteFor(appRoot);
  const configFile = existsSync(join(appRoot, cfg.viteConfig || 'vite.config.js')) ? join(appRoot, cfg.viteConfig || 'vite.config.js') : false;
  const vs = await createServer({ configFile, root: appRoot, logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const v = await vs.ssrLoadModule(join(KIT, 'lib/validate.js'));
    for (const f of modules) {
      try { await vs.ssrLoadModule(f); } catch (e) { failures.push({ name: relative(appRoot, f), law: 'loadable', detail: `does not load in the gate: ${e.message.split('\n')[0]}` }); }
    }
    const opts = cfg.validate || {};
    const gens = opts.gens ? ((await vs.ssrLoadModule(join(appRoot, opts.gens))).default || {}) : {};
    const r = await v.validate({ gens, seeds: opts.seeds ?? 40, length: opts.length ?? 24 });
    if (modules.length && !r.decls.length && !failures.length) failures.push({ name: '(registry)', law: 'coverage', detail: `${modules.length} modules declare state but no declaration reached the kit registry at ${KIT} (does the app import another kit copy?)` });
    if (editor && !r.decls.some((d) => d.name.startsWith('editor:'))) failures.push({ name: '(editor)', law: 'coverage', detail: 'the app calls createEditor but no editor declaration reached the gate: declare it at module level, declareEditor(contract, app) (kit lib/editor/declare.js)' });
    if (rows && !r.decls.some((d) => d.name.startsWith('rows:'))) failures.push({ name: '(rows)', law: 'coverage', detail: 'the app calls openRows but no row declaration reached the gate: declare it at module level, declareRows({ name, fields, together }) (kit lib/engine/rows-declare.js), and pass it to openRows({ declaration })' });
    const all = [...failures, ...r.failures];
    log(`gate: declarations ${all.length ? 'FAILED' : 'ok'}: ${r.decls.length} declarations (${r.decls.reduce((n, d) => n + d.cases, 0)} law steps), ${r.views} views, from ${modules.length} modules`);
    return { ok: all.length === 0, decls: r.decls, views: r.views, failures: all, files: modules.map((f) => relative(appRoot, f)) };
  } finally { await vs.close(); }
}
