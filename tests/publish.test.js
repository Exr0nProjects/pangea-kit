// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncInto, push, stage as stageApp } from '../lib/publish.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qk-test-'))
const ULID = '01MDQ7G8K9ZB2NXVT4R5CWYH3F'

describe('syncInto: only changed files are replaced, by rename', () => {
  it('leaves identical files untouched (same inode), replaces changed ones, removes stale ones, keeps the channel files', () => {
    const stage = tmp(), art = tmp()
    fs.mkdirSync(path.join(stage, 'parts')); fs.mkdirSync(path.join(art, 'parts'))
    fs.writeFileSync(path.join(stage, 'index.html'), 'host'); fs.writeFileSync(path.join(stage, 'big.json'), '{"a":1}'); fs.writeFileSync(path.join(stage, 'parts/a.js'), 'new')
    fs.writeFileSync(path.join(art, 'index.html'), 'host'); fs.writeFileSync(path.join(art, 'big.json'), '{"a":1}'); fs.writeFileSync(path.join(art, 'parts/a.js'), 'old'); fs.writeFileSync(path.join(art, 'parts/gone.js'), 'x')
    fs.writeFileSync(path.join(art, 'state.json'), '{}'); fs.writeFileSync(path.join(art, 'view.json'), '{}'); fs.writeFileSync(path.join(art, 'SOURCE.json'), '{}')
    const before = fs.statSync(path.join(art, 'big.json')).ino
    const r = syncInto(stage, art)
    expect(r.changed).toEqual(['parts/a.js']); expect(r.same.sort()).toEqual(['big.json', 'index.html']); expect(r.removed).toEqual(['parts/gone.js'])
    expect(fs.statSync(path.join(art, 'big.json')).ino).toBe(before)
    expect(fs.readFileSync(path.join(art, 'parts/a.js'), 'utf8')).toBe('new')
    for (const f of ['state.json', 'view.json', 'SOURCE.json']) expect(fs.existsSync(path.join(art, f))).toBe(true)
    expect(fs.readdirSync(path.join(art, 'parts')).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
  it('puts index.html last, so a page never sees the new host before its parts', () => {
    const stage = tmp(), art = tmp()
    for (const f of ['index.html', 'a.js', 'b.js']) fs.writeFileSync(path.join(stage, f), f)
    expect(syncInto(stage, art).changed.at(-1)).toBe('index.html')
  })
})

describe('push', () => {
  const withRoot = (fn) => { const root = tmp(); fs.mkdirSync(path.join(root, ULID)); const old = process.env.PANGEA_KIT_QUICKLOOK_ROOT; process.env.PANGEA_KIT_QUICKLOOK_ROOT = root; try { return fn(root) } finally { process.env.PANGEA_KIT_QUICKLOOK_ROOT = old ?? ''; if (!old) delete process.env.PANGEA_KIT_QUICKLOOK_ROOT } }
  it('wraps a bare object as a patch, passes an action through, keeps the last 20, writes atomically', () => withRoot((root) => {
    const a = push(ULID, '{"em":{"contrast":2}}')
    expect(a).toMatchObject({ op: 'patch', payload: { em: { contrast: 2 } }, actor: 'agent' })
    expect(push(ULID, '{"op":"set","payload":{"path":"x","value":1}}')).toMatchObject({ op: 'set', payload: { path: 'x', value: 1 } })
    for (let i = 0; i < 25; i++) push(ULID, { n: i })
    const file = path.join(root, ULID, 'state.json')
    const acts = JSON.parse(fs.readFileSync(file, 'utf8')).actions
    expect(acts.length).toBe(20); expect(new Set(acts.map((x) => x.id)).size).toBe(20)
    expect(fs.readdirSync(path.join(root, ULID)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  }))
  it('refuses a non-ULID', () => { expect(() => push('../x', '{}')).toThrow(/ULID/) })
})

describe('tab title', () => {
  const app = (cfg) => { const d = path.join(tmp(), 'my-app'); fs.mkdirSync(path.join(d, 'parts'), { recursive: true }); fs.writeFileSync(path.join(d, 'state.js'), 'export default {}'); if (cfg) fs.writeFileSync(path.join(d, 'quicklook.json'), JSON.stringify(cfg)); return d }
  it('writes the title to meta.json (host index.html unchanged), defaulting to the app dir name', async () => {
    const a = await stageApp(app({ title: 'Cool <viewer>' })), b = await stageApp(app())
    expect(JSON.parse(fs.readFileSync(path.join(a, 'meta.json'), 'utf8')).title).toBe('Cool <viewer>')
    expect(JSON.parse(fs.readFileSync(path.join(b, 'meta.json'), 'utf8')).title).toBe('my-app')
    expect(fs.readFileSync(path.join(a, 'index.html'))).toEqual(fs.readFileSync(path.join(b, 'index.html')))
  }, 60000)
})

describe('publish provenance: a page is built from a clean commit on main; --scratch is explicit, logged and stamped dirty', async () => {
  const { execFileSync } = await import('node:child_process')
  const { preparePublish, publish } = await import('../lib/publish.mjs')
  const { ProvenanceRefused } = await import('../lib/deploy/provenance.mjs')
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env }).trim()
  const repo = (files) => {
    const d = fs.realpathSync(tmp())
    for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t) }
    git(d, 'init', '-q', '-b', 'main'); git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'init'); return d
  }
  // a stand-in kit: committed sources, node_modules installed but ignored (as in the real kit)
  const fakeKit = () => { const k = repo({ '.gitignore': 'node_modules/\n', 'lib/k.js': 'export const k = 1\n' }); fs.mkdirSync(path.join(k, 'node_modules')); return k }
  const app = () => repo({ 'app/state.js': 'export default { v: "committed" }\n', 'app/quicklook.json': '{"title":"t"}' })
  const registry = (apps) => { const f = path.join(tmp(), 'reg.json'); fs.writeFileSync(f, JSON.stringify({ version: 1, facts: {}, apps })); return f }
  const quiet = () => {}
  const withRoot = async (fn) => { const root = tmp(); const old = process.env.PANGEA_KIT_QUICKLOOK_ROOT; process.env.PANGEA_KIT_QUICKLOOK_ROOT = root; try { return await fn(root) } finally { if (old === undefined) delete process.env.PANGEA_KIT_QUICKLOOK_ROOT; else process.env.PANGEA_KIT_QUICKLOOK_ROOT = old } }

  it('a clean commit is exported (HEAD bytes, not the working tree) and stamped with both shas, dirty: false', async () => {
    const k = fakeKit(), a = app()
    const p = await preparePublish(path.join(a, 'app'), { kit: k, log: quiet })
    try {
      expect(fs.readFileSync(path.join(p.codeDir, 'state.js'), 'utf8')).toContain('committed')
      expect(p.codeDir).not.toBe(path.join(a, 'app')); expect(fs.existsSync(path.join(p.kitDir, 'lib/k.js'))).toBe(true)
      expect(p.build).toMatchObject({ mode: 'commit', dirty: false, app_sha: git(a, 'rev-parse', 'HEAD'), kit_sha: git(k, 'rev-parse', 'HEAD') })
      expect(p.build.build_id).toMatch(/^[0-9a-f]{12}\.[0-9a-f]{12}$/)
    } finally { p.cleanup() }
    expect(fs.existsSync(p.codeDir)).toBe(false)
  })
  it('planted: an uncommitted edit in the app is refused before the gate runs (nothing built, nothing published)', async () => {
    const k = fakeKit(), a = app()
    fs.writeFileSync(path.join(a, 'app/state.js'), 'export default { v: "dirty" }\n')
    let gated = false
    await expect(publish(path.join(a, 'app'), { kit: k, log: quiet, gateFn: async () => { gated = true; return { ok: true } } })).rejects.toThrow(/publish refused: app .* uncommitted change.*--scratch/)
    expect(gated).toBe(false)
  })
  it('planted: an untracked file in the app, a dirty kit and a branch other than main are each refused', async () => {
    const k = fakeKit(), a = app()
    fs.writeFileSync(path.join(a, 'app/parts.js'), 'x')
    await expect(preparePublish(path.join(a, 'app'), { kit: k, log: quiet })).rejects.toThrow(ProvenanceRefused)
    const k2 = fakeKit(), a2 = app(); fs.writeFileSync(path.join(k2, 'lib/k.js'), 'changed')
    await expect(preparePublish(path.join(a2, 'app'), { kit: k2, log: quiet })).rejects.toThrow(/kit .* uncommitted/)
    const a3 = app(); git(a3, 'checkout', '-q', '-b', 'feature')
    await expect(preparePublish(path.join(a3, 'app'), { kit: fakeKit(), log: quiet })).rejects.toThrow(/branch feature/)
  })
  it('planted: a non-git app dir without --scratch is refused', async () => {
    const d = fs.realpathSync(tmp()); fs.writeFileSync(path.join(d, 'state.js'), 'export default {}')
    await expect(preparePublish(d, { kit: fakeKit(), log: quiet })).rejects.toThrow(/not in a git repository.*--scratch/)
  })
  it('--scratch builds a non-git dir from its working tree, says so, logs it and stamps dirty: true', () => withRoot(async (root) => {
    const ulid = '01MDQ7G8K9ZB2NXVT4R5CWYH3G'; fs.mkdirSync(path.join(root, ulid))
    const d = path.join(fs.realpathSync(tmp()), 'scratch-page'); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'state.js'), 'export default { v: "wip" }')
    const lines = []
    const r = await publish(d, { scratch: true, into: ulid, registryPath: registry({}), log: (m) => lines.push(m), gateFn: async () => ({ ok: true }) })
    const stamp = JSON.parse(fs.readFileSync(path.join(root, ulid, 'BUILD.json'), 'utf8'))
    expect(stamp).toMatchObject({ mode: 'scratch', dirty: true, app_sha: null, app_dir: fs.realpathSync(d) })
    expect(r.build.dirty).toBe(true)
    expect(lines.join('\n')).toMatch(/SCRATCH build of .*scratch-page.*dirty: true/)
    const log = fs.readFileSync(path.join(path.dirname(root), 'quicklook-scratch-publishes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(log.some((e) => e.app_dir === fs.realpathSync(d) && e.into === ulid && e.dirty === true)).toBe(true)
  }), 90000)
  it('planted: --scratch on an app inside a deploy-registry repo (a registered domain) is refused', async () => {
    const a = app()
    const reg = registry({ zai2: { managed: true, repo: a, routes: [{ pattern: 'zai2.example', custom_domain: true }] } })
    await expect(preparePublish(path.join(a, 'app'), { scratch: true, registryPath: reg, log: quiet })).rejects.toThrow(/registered app zai2 \(zai2\.example\).*only from a clean commit/)
  })
  it('planted: --scratch into a page a commit publish made is refused', () => withRoot(async (root) => {
    const ulid = '01MDQ7G8K9ZB2NXVT4R5CWYH3H'; fs.mkdirSync(path.join(root, ulid))
    fs.writeFileSync(path.join(root, ulid, 'BUILD.json'), JSON.stringify({ dirty: false, app_sha: 'abcdef1234567890' }))
    const d = fs.realpathSync(tmp()); fs.writeFileSync(path.join(d, 'state.js'), 'export default {}')
    await expect(preparePublish(d, { scratch: true, into: ulid, registryPath: registry({}), log: quiet })).rejects.toThrow(/never replaces a commit build/)
  }))
})
