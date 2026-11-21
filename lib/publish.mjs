// Staging, publishing and pushing for the pangea-kit CLI. Every write is temp + rename inside the
// destination directory, from a single writer (this process), so a page and the server never see half a file.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { KIT, buildPart } from './build.mjs'
import { metaFor } from './meta.js'
import { gate } from './editor/gate.mjs'
import { bootGate, formatBootGate, readAppBootConfig } from './bootgate.mjs'
import { undefReport } from './no-undef.mjs'
import { LOCAL_ROOT, LOCAL_BASE, ensureLocalViewer } from './local-viewer.mjs'
import { assertClean, gitState, exportTree, linkNodeModules, sha256File, buildId, ProvenanceRefused } from './deploy/provenance.mjs'
import { loadRegistry, claims, REGISTRY_PATH } from './deploy/registry.mjs'

// Publish target. Hosted: a private publisher script puts the page in the viewer's artifact store. Local: the standalone
// viewer (lib/local-viewer.mjs, loopback, no dependencies). Local is chosen by `--local` (PANGEA_KIT_LOCAL=1) or whenever no
// hosted publisher is configured (PANGEA_KIT_PUBLISHER, or the default path below), so a fresh clone publishes locally.
export const PUBLISHER = () => process.env.PANGEA_KIT_PUBLISHER || path.join(os.homedir(), 'none')
export const isLocal = () => process.env.PANGEA_KIT_LOCAL === '1' || !fs.existsSync(PUBLISHER())
export const QUICKLOOK_ROOT = () => path.resolve(process.env.PANGEA_KIT_QUICKLOOK_ROOT || (isLocal() ? LOCAL_ROOT() : path.join(os.homedir(), '.local/share/host-app/quicklook')))
export const HOSTED_BASE = () => process.env.PANGEA_KIT_VIEW_BASE || 'https://viewer.example.invalid'
export const viewBase = () => (isLocal() ? LOCAL_BASE() : HOSTED_BASE())
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const newUlid = (now = Date.now()) => { let t = '', n = now; for (let i = 0; i < 10; i++) { t = ULID_ALPHABET[n % 32] + t; n = Math.floor(n / 32) } const b = crypto.randomBytes(16); let r = ''; for (let i = 0; i < 16; i++) r += ULID_ALPHABET[b[i] % 32]; return t + r }
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/u
const RESERVED = new Set(['state.json', 'view.json', 'SOURCE.json'])

const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')
const atomicCopy = (src, dest) => {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = path.join(path.dirname(dest), `.qk.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`)
  fs.copyFileSync(src, tmp, fs.constants.COPYFILE_FICLONE) // APFS clone: instant, no second copy of a 50 MB file
  fs.renameSync(tmp, dest)
}
export const atomicWrite = (dest, text) => {
  const tmp = path.join(path.dirname(dest), `.qk.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`)
  fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, dest)
}
function walk(dir, rel = '') {
  const out = []
  for (const name of fs.readdirSync(path.join(dir, rel))) {
    if (name.startsWith('.')) continue
    const r = rel ? `${rel}/${name}` : name
    const st = fs.statSync(path.join(dir, r))
    if (st.isDirectory()) out.push(...walk(dir, r)); else out.push(r)
  }
  return out
}

/**
 * The host (index.html) of the kit at `kit` (default the live checkout), rebuilt only when that kit's sources are newer
 * than its last build. A commit publish passes the kit's `git archive` export, so the host is built from the commit.
 */
export async function ensureHost({ force = false, kit = KIT } = {}) {
  const out = path.join(kit, 'dist', 'index.html')
  const newest = ['host', 'lib', 'ui'].flatMap((d) => walk(path.join(kit, d)).map((f) => fs.statSync(path.join(kit, d, f)).mtimeMs))
    .concat(['vite.host.config.js', 'package.json'].map((f) => fs.statSync(path.join(kit, f)).mtimeMs)).reduce((a, b) => Math.max(a, b), 0)
  if (!force && fs.existsSync(out) && fs.statSync(out).mtimeMs >= newest) return out
  const { build } = await import('vite')
  await build({ configFile: path.join(kit, 'vite.host.config.js'), root: path.join(kit, 'host'), logLevel: 'warn' })
  return out
}

/**
 * Build an app dir into a stage dir: index.html (host), state.js, parts/*.js, and the data files named in quicklook.json.
 * `codeDir` is where state.js, parts/ and quicklook.json are read (a commit publish passes the app's export); data files
 * are data, not code, and resolve against the real `appDir`. `host` is a prebuilt host file (default: the live kit's).
 */
export async function stage(appDir, { forceHost = false, codeDir = null, host = null, allowUndef = false } = {}) {
  appDir = path.resolve(appDir)
  const src = codeDir ? path.resolve(codeDir) : appDir
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qk-stage-'))
  const cfgPath = path.join(src, 'quicklook.json')
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {}
  // Tab title lives in meta.json, never in index.html: the host stays byte-identical across apps, so a title change never reloads an open view.
  const title = String(cfg.title || path.basename(appDir))
  fs.copyFileSync(host || await ensureHost({ force: forceHost }), path.join(dir, 'index.html'))
  // Same file carries the built-in axes config (host reads it at boot and on change): "axes": false opts out (non-spatial apps only), "units" / "unitScale" set the label unit.
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(metaFor(cfg, title)))
  const built = [], undef = []
  const entries = [['state.js', path.join(src, 'state.js')]]
  const partsDir = path.join(src, 'parts')
  if (fs.existsSync(partsDir)) for (const f of fs.readdirSync(partsDir).sort()) if (/^[A-Za-z0-9][\w.-]*\.js$/u.test(f)) entries.push([`parts/${f}`, path.join(partsDir, f)])
  for (const [rel, src] of entries) {
    if (!fs.existsSync(src)) throw new Error(`${appDir}: missing ${rel.replace(/^parts\//u, 'parts/')}`)
    const code = await buildPart(src)
    if (!allowUndef) for (const r of undefReport(rel, code)) undef.push(r)
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), code); built.push(rel)
  }
  if (undef.length) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw new UndefRefused(`pangea-kit publish: the built app JS references identifiers that are declared nowhere (each throws ReferenceError in the browser); nothing published. Line:col are in the built part (an IIFE, readable, not minified); fix the source so the name is declared in an enclosing scope (a Svelte part: declare it where it is used, not inside a sibling $effect/function/block):\n${undef.join('\n')}\n(escape for a deliberate global: --allow-undef)`)
  }
  for (const f of cfg.data?.files || []) {
    const src = path.resolve(appDir, (cfg.data.dir || '.').replace(/^~/u, os.homedir()), f)
    if (!fs.existsSync(src)) { if (cfg.data.optional?.includes(f)) continue; throw new Error(`data file missing: ${src}`) }
    fs.copyFileSync(src, path.join(dir, f), fs.constants.COPYFILE_FICLONE)
  }
  return dir
}

/** Make `artifact` match `stageDir` with the fewest writes: identical files are not touched, the rest are replaced by rename, index.html last. */
export function syncInto(stageDir, artifact) {
  const want = walk(stageDir)
  const changed = [], same = []
  for (const rel of want.sort((a, b) => (a === 'index.html') - (b === 'index.html'))) {
    const src = path.join(stageDir, rel), dest = path.join(artifact, rel)
    const identical = fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size && sha(dest) === sha(src)
    if (identical) { same.push(rel); continue }
    atomicCopy(src, dest); changed.push(rel)
  }
  const removed = []
  for (const rel of walk(artifact)) if (!want.includes(rel) && !RESERVED.has(rel)) { fs.unlinkSync(path.join(artifact, rel)); removed.push(rel) }
  return { changed, same, removed }
}

/** Thrown when the deploy gate refuses: nothing was staged or published. */
export class GateRefused extends Error {}
/** Thrown when a built part references an undeclared identifier (lib/no-undef.mjs): nothing was published. */
export class UndefRefused extends Error {}

// Publish provenance (PANGEA3-DESIGN §17, the same step as lib/deploy/pipeline.mjs): by default a page is built from a
// commit, never a working tree. The app and the kit must each be clean and on main; both are exported from HEAD
// (git archive) into a scratch tree that mirrors their real relative layout; the gate, the host and the parts are built
// from the export, and the page carries BUILD.json {app_sha, kit_sha, build_id, dirty: false}.
// Quicklook pages are also made from non-git scratch dirs by design: that is the explicit `scratch` mode (CLI --scratch),
// which builds from the working tree, logs a line to stderr and to quicklook-scratch-publishes.jsonl beside the quicklook
// root, stamps BUILD.json dirty: true, and is refused for an app inside any deploy-registry repo (a registered app on a
// registered domain is only ever built from a commit) and for an artifact a commit publish made.
export const SCRATCH_LOG = () => path.join(path.dirname(QUICKLOOK_ROOT()), 'quicklook-scratch-publishes.jsonl')

const commonDir = (a, b) => { const x = a.split(path.sep), y = b.split(path.sep); let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++; return x.slice(0, i).join(path.sep) || path.sep }
const isUnder = (p, dir) => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)) }
const expandHome = (p) => String(p).replace(/^~(?=\/)/u, os.homedir())
const dataStamp = (appDir, codeDir) => {
  const cfgPath = path.join(codeDir, 'quicklook.json')
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {}
  return (cfg.data?.files || []).map((f) => { const p = path.resolve(appDir, expandHome(cfg.data.dir || '.'), f); return { file: f, sha256: sha256File(p) } })
}
const readBuild = (artifact) => { try { return JSON.parse(fs.readFileSync(path.join(artifact, 'BUILD.json'), 'utf8')) } catch { return null } }

/** The registry apps whose repo contains `dir` (a registered app is never published from a working tree). */
export function registeredOwners(dir, { registryPath = REGISTRY_PATH() } = {}) {
  if (!fs.existsSync(registryPath)) return [] // a machine with no deploy registry has no registered app
  const reg = loadRegistry(registryPath)
  const real = fs.realpathSync(dir)
  return Object.entries(reg.apps).filter(([, a]) => a.repo && fs.existsSync(expandHome(a.repo)) && isUnder(real, fs.realpathSync(expandHome(a.repo))))
    .map(([n, a]) => ({ app: n, hosts: claims(a).hosts }))
}

/**
 * Prepare what to build. Commit mode: {codeDir, kitDir, build, cleanup} from clean exports. Scratch mode: the working tree.
 * Throws ProvenanceRefused (nothing built).
 */
export async function preparePublish(appDir, { scratch = false, into = null, registryPath, log = (m) => process.stderr.write(`${m}\n`), kit = KIT } = {}) {
  appDir = fs.realpathSync(path.resolve(appDir))
  const name = path.basename(appDir)
  if (scratch) {
    const owners = registeredOwners(appDir, { registryPath })
    if (owners.length) throw new ProvenanceRefused(`publish refused: --scratch on ${appDir}, which belongs to registered app ${owners.map((o) => `${o.app} (${o.hosts.join(', ') || 'no hosts'})`).join('; ')}; a registered app is published only from a clean commit`)
    if (into) { const b = readBuild(path.join(QUICKLOOK_ROOT(), into)); if (b && b.dirty === false) throw new ProvenanceRefused(`publish refused: --scratch into ${into}, a page built from commit ${String(b.app_sha).slice(0, 12)}; a scratch build never replaces a commit build (publish without --into for a new page)`) }
    const g = (dir) => { try { return gitState(dir) } catch { return null } }
    const ag = g(appDir), kg = g(kit)
    const at = new Date().toISOString()
    const build = { app: name, app_dir: appDir, mode: 'scratch', dirty: true, build_id: `scratch-${at.replace(/[-:.]/gu, '')}`,
      app_sha: ag?.sha ?? null, app_uncommitted: ag ? ag.dirty.length : null, kit_sha: kg?.sha ?? null, kit_uncommitted: kg ? kg.dirty.length : null,
      data: dataStamp(appDir, appDir), built_at: at }
    log(`pangea-kit publish: SCRATCH build of ${appDir} from its working tree (dirty: true, ${ag ? `git ${ag.sha.slice(0, 12)} + ${ag.dirty.length} uncommitted` : 'not a git checkout'}); logged to ${SCRATCH_LOG()}`)
    fs.mkdirSync(path.dirname(SCRATCH_LOG()), { recursive: true })
    fs.appendFileSync(SCRATCH_LOG(), `${JSON.stringify({ ...build, into, pid: process.pid })}\n`)
    return { codeDir: appDir, kitDir: kit, build, host: null, cleanup: () => {} }
  }
  const gitOf = (dir, label) => { try { return gitState(dir) } catch { throw new ProvenanceRefused(`publish refused: ${label} ${dir} is not in a git repository; commit it, or publish with --scratch (stamped dirty, never on a registered domain)`) } }
  gitOf(appDir, 'app'); gitOf(kit, 'kit')
  let appGit, kitGit
  try { appGit = assertClean(appDir, { label: `app (${appDir})` }); kitGit = assertClean(kit, { label: `kit (${kit})` }) } catch (e) {
    if (e instanceof ProvenanceRefused) e.message = `${e.message.replace(/^deploy refused/u, 'publish refused')} (a non-git or throwaway page: --scratch)`
    throw e
  }
  const scratchDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qk-publish-')))
  const cleanup = () => fs.rmSync(scratchDir, { recursive: true, force: true })
  try {
    const root = commonDir(appDir, fs.realpathSync(kit))
    const mirror = (p) => path.join(scratchDir, path.relative(root, p))
    const kitDir = mirror(fs.realpathSync(kit)), codeDir = mirror(appDir)
    exportTree(kitGit.top, kitGit.sha, kitGit.sub, kitDir)
    exportTree(appGit.top, appGit.sha, appGit.sub, codeDir) // same repo as the kit (apps/<x>): the same bytes again
    linkNodeModules(kit, kitDir, { label: 'kit' })
    if (fs.existsSync(path.join(appDir, 'node_modules')) && !fs.existsSync(path.join(codeDir, 'node_modules'))) linkNodeModules(appDir, codeDir, { label: `app ${name}` })
    const build = { app: name, app_dir: appDir, mode: 'commit', dirty: false, build_id: buildId(appGit.sha, kitGit.sha), app_sha: appGit.sha, kit_sha: kitGit.sha,
      kit_lock_sha256: sha256File(path.join(kitDir, 'package-lock.json')), data: dataStamp(appDir, codeDir), built_at: new Date().toISOString() }
    log(`pangea-kit publish: ${name} ${build.build_id} from app ${appGit.sha.slice(0, 12)} + kit ${kitGit.sha.slice(0, 12)} (clean exports)`)
    return { codeDir, kitDir, build, host: null, cleanup }
  } catch (e) { cleanup(); throw e }
}

/** The host built from the kit export at `kitDir` (commit `kitSha`), cached per commit under the live kit's dist/hosts/. */
async function commitHost(kitDir, kitSha) {
  const cached = path.join(KIT, 'dist', 'hosts', `${kitSha}.html`)
  if (fs.existsSync(cached)) return cached
  const built = await ensureHost({ force: true, kit: kitDir })
  fs.mkdirSync(path.dirname(cached), { recursive: true })
  atomicCopy(built, cached)
  return cached
}

export async function publish(appDir, { into = null, forceHost = false, gateFn = null, scratch = false, registryPath, log, kit = KIT, allowUndef = false, noGate = false, bootGateFn = null } = {}) {
  if (into && !ULID_RE.test(into)) throw new Error(`not a ULID: ${into}`)
  const prep = await preparePublish(appDir, { scratch, into, registryPath, log, kit })
  let dir = null
  try {
    // Rule 5 (The owner 2026-11-08 23:30 PST): lint, then the editor checks, block the deploy; never nightly-only. A commit
    // publish runs the exported kit's gate on the exported app, so the gated code is the published code.
    const runGate = gateFn || (scratch ? gate : (await import(pathToFileURL(path.join(prep.kitDir, 'lib/editor/gate.mjs')).href)).gate)
    const g = await runGate(prep.codeDir, { kitRoot: prep.kitDir })
    if (!g.ok) throw new GateRefused(`pangea-kit publish: the gate refused ${appDir} (lint ${g.lint?.ok ?? 'n/a'}, unit ${g.unit?.ok ?? 'n/a'}, browser ${g.browser ? JSON.stringify(Object.fromEntries(Object.entries(g.browser.results).filter(([, v]) => !v.ok).map(([k]) => [k, 'failed']))) : 'n/a'}); nothing published`)
    const host = scratch ? null : await commitHost(prep.kitDir, prep.build.kit_sha)
    dir = await stage(appDir, { forceHost, codeDir: prep.codeDir, host, allowUndef })
    fs.writeFileSync(path.join(dir, 'BUILD.json'), JSON.stringify(prep.build, null, 1))
    // Boot smoke gate (2026-11-18, after a live stack overflow no unit test could see): load the built page in headless Chrome, reload it, refuse on any error. Before anything is written to the live artifact. Not for --scratch (a throwaway page is how you debug); a test that injects gateFn skips it unless it also injects bootGateFn.
    if (!scratch && !noGate && process.env.PANGEA_NO_GATE !== '1' && (bootGateFn || !gateFn)) {
      const cfg = readAppBootConfig(prep.codeDir), r = await (bootGateFn || bootGate)(dir, { waitMs: cfg.waitMs || 8000, extraChecks: cfg.extraChecks || [], view: cfg.view || (into ? (() => { try { return fs.readFileSync(path.join(QUICKLOOK_ROOT(), into, 'view.json'), 'utf8') } catch { return null } })() : null) })
      if (!r.ok) throw new GateRefused(`pangea-kit publish: the boot smoke gate refused ${appDir}; nothing published (the old build stays; --no-gate or PANGEA_NO_GATE=1 skips it)\n${formatBootGate(r)}`)
      if (r.warnings?.length) (log || ((m) => process.stderr.write(`${m}\n`)))(`boot gate warnings: ${r.warnings.slice(0, 5).map((w) => w.message).join('; ')}`)
    }
    if (into) {
      const artifact = path.join(QUICKLOOK_ROOT(), into)
      if (!fs.statSync(artifact, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`no such artifact: ${artifact}`)
      return { ulid: into, build: prep.build, ...syncInto(dir, artifact) }
    }
    if (isLocal()) { // standalone viewer: a new page directory under the local root, the viewer started if it is not up
      const ulid = newUlid(), artifact = path.join(QUICKLOOK_ROOT(), ulid)
      fs.mkdirSync(artifact, { recursive: true }); const r = syncInto(dir, artifact)
      await ensureLocalViewer({ root: QUICKLOOK_ROOT() })
      return { ulid, url: `${viewBase()}/view/${ulid}/`, build: prep.build, changed: r.changed, same: [], removed: [] }
    }
    const url = execFileSync(process.execPath, [PUBLISHER(), dir], { encoding: 'utf8' }).trim().split('\n').pop()
    const ulid = url.match(/[0-9A-HJKMNP-TV-Z]{26}/u)[0]
    return { ulid, url, build: prep.build, changed: walk(dir), same: [], removed: [] }
  } finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }); prep.cleanup() }
}

/** Append an action to <artifact>/state.json (the last 20 are kept); the live channel delivers it to every open page. */
export function push(ulid, json, { now = Date.now } = {}) {
  if (!ULID_RE.test(ulid)) throw new Error(`not a ULID: ${ulid}`)
  const artifact = path.join(QUICKLOOK_ROOT(), ulid)
  const parsed = typeof json === 'string' ? JSON.parse(json) : json
  const action = typeof parsed?.op === 'string'
    ? { op: parsed.op, payload: parsed.payload ?? {} }
    : { op: 'patch', payload: parsed } // a bare object is a patch: it writes only the keys it names
  const entry = { id: `push-${now()}-${crypto.randomBytes(2).toString('hex')}`, ts: now(), actor: 'agent', ...action }
  const file = path.join(artifact, 'state.json')
  let prev = []
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')).actions || [] } catch {}
  atomicWrite(file, JSON.stringify({ actions: [...prev, entry].slice(-20) }))
  return entry
}
