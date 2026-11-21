// The deploy registry (PANGEA3-DESIGN §17; DESIGN-CONFORMANCE §E 5e; census A4, A10, B4, B7, E41, E42 / ZAI_OWNER_EMAIL).
// ONE file says, for every app on this machine's deploy paths: its hosting kind, worker name, routes (custom domains),
// local ports, plain vars and the secrets it needs BY NAME (values live in the platform, never here). Facts shared by
// several apps (the owner's email) are written once under `facts` and referenced as {"fact": "owner_email"}.
// A managed app's wrangler config gets name/routes/vars only from here (the app's wrangler.jsonc may not carry them);
// unmanaged entries (deployed by other tools) are listed so a collision with them is refused too.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const REGISTRY_PATH = () => process.env.QK_DEPLOY_REGISTRY || join(homedir(), '.config/pangea-kit/deploy-registry.json');
export class RegistryRefused extends Error {}

const expand = (p) => (typeof p === 'string' ? p.replace(/^~(?=\/)/, homedir()) : p);

export function loadRegistry(path = REGISTRY_PATH()) {
  if (!existsSync(path)) throw new RegistryRefused(`deploy refused: no deploy registry at ${path}`);
  const r = JSON.parse(readFileSync(path, 'utf8'));
  if (r.version !== 1) throw new RegistryRefused(`${path}: version must be 1`);
  for (const k of ['facts', 'apps']) if (!r[k] || typeof r[k] !== 'object') throw new RegistryRefused(`${path}: missing "${k}"`);
  r.path = path;
  return r;
}

/** Resolve {"fact": name} references; an unknown fact is a refusal, never an empty value. */
export function resolveVars(reg, vars = {}) {
  const out = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v && typeof v === 'object' && 'fact' in v) {
      if (!(v.fact in reg.facts)) throw new RegistryRefused(`var ${k} names fact ${v.fact}, which the registry does not define`);
      out[k] = reg.facts[v.fact];
    } else out[k] = v;
  }
  return out;
}

/** Claims of one app: hosts (from routes), ports, worker name. */
export function claims(app) {
  // one app may list a host twice (a custom domain and a zone route host/*): that is one claim, not a collision with itself
  const hosts = [...new Set((app.routes || []).map((r) => String(typeof r === 'string' ? r : r.pattern).replace(/\/\*?$/, '').toLowerCase()))];
  return { hosts, ports: app.ports || [], worker: app.worker || null };
}

/** Every collision in the registry: [{kind, key, apps}]. */
export function collisions(reg) {
  const seen = { host: new Map(), port: new Map(), worker: new Map() };
  for (const [name, app] of Object.entries(reg.apps)) {
    const c = claims(app);
    for (const h of c.hosts) seen.host.set(h, [...(seen.host.get(h) || []), name]);
    for (const p of c.ports) seen.port.set(String(p), [...(seen.port.get(String(p)) || []), name]);
    if (c.worker) seen.worker.set(`${app.account || ''}/${c.worker}`, [...(seen.worker.get(`${app.account || ''}/${c.worker}`) || []), name]);
  }
  const out = [];
  for (const [kind, m] of Object.entries(seen)) for (const [key, apps] of m) if (apps.length > 1) out.push({ kind, key, apps });
  return out;
}

/** The deployer of an entry: the kit pipeline unless the entry names another (a script that reads this registry itself). */
export const KIT_PIPELINE = 'kit-pipeline';

/**
 * The managed app `name`, validated: no collision involving it, every required field present, and `deployer` is the one the
 * entry names (default the kit pipeline), so the kit pipeline never deploys an app another script owns, nor the reverse.
 */
export function appEntry(reg, name, { deployer = KIT_PIPELINE } = {}) {
  const app = reg.apps[name];
  if (!app) throw new RegistryRefused(`deploy refused: ${name} is not in the deploy registry (${reg.path}); add its routes, worker and secrets there first`);
  if (!app.managed) throw new RegistryRefused(`deploy refused: ${name} is listed as unmanaged (deployed by another tool)`);
  if ((app.deployer || KIT_PIPELINE) !== deployer) throw new RegistryRefused(`deploy refused: ${name} is deployed by ${app.deployer || KIT_PIPELINE}, not ${deployer} (registry "deployer")`);
  const mine = collisions(reg).filter((c) => c.apps.includes(name));
  if (mine.length) throw new RegistryRefused(`deploy refused: ${name} collides with ${mine.map((c) => `${c.apps.filter((a) => a !== name).join(',')} on ${c.kind} ${c.key}`).join('; ')}`);
  for (const k of ['kind', 'worker', 'routes', 'repo']) if (!app[k]) throw new RegistryRefused(`deploy refused: registry entry ${name} has no "${k}"`);
  return { name, ...app, repo: expand(app.repo), vars: resolveVars(reg, app.vars), secrets: app.secrets || [] };
}

/**
 * The wrangler config to deploy: the app's own wrangler.jsonc (bindings, assets, DOs) plus name/routes/vars from the
 * registry. The app file may not declare name, routes or vars itself (two sources of one fact).
 */
export function wranglerConfig(entry, base) {
  const dup = ['name', 'routes', 'route', 'vars'].filter((k) => k in base);
  if (dup.length) throw new RegistryRefused(`deploy refused: ${entry.name}'s wrangler.jsonc declares ${dup.join(', ')}; those live only in the deploy registry`);
  return { ...base, name: entry.worker, routes: entry.routes, vars: { ...entry.vars }, workers_dev: base.workers_dev ?? false };
}

/** Secrets the app needs that the live worker lacks. `have` is the list of secret names the platform reports. */
export function missingSecrets(entry, have) { const s = new Set(have); return entry.secrets.filter((n) => !s.has(n)); }

/** Bindings the live version has that the new config would drop (live-only config, census B7). */
export function droppedBindings(liveBindings, cfg, secrets) {
  const want = new Set([...Object.keys(cfg.vars || {}), ...secrets, ...(cfg.assets?.binding ? [cfg.assets.binding] : []),
    ...(cfg.services || []).map((s) => s.binding), ...(cfg.kv_namespaces || []).map((k) => k.binding), ...(cfg.durable_objects?.bindings || []).map((d) => d.name),
    ...(cfg.r2_buckets || []).map((b) => b.binding), ...(cfg.d1_databases || []).map((b) => b.binding), ...(cfg.queues?.producers || []).map((q) => q.binding)]);
  return liveBindings.filter((b) => !want.has(b.name)).map((b) => `${b.type} ${b.name}`);
}

/** Strip // and /* *\/ comments and trailing commas from JSONC. */
export function parseJsonc(text) {
  let out = '', i = 0, str = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (str) { out += c; if (c === '\\') { out += n; i += 2; continue; } if (c === '"') str = false; i++; continue; }
    if (c === '"') { str = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i = text.indexOf('*/', i + 2) + 2; continue; }
    out += c; i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
