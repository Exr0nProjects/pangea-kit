// @vitest-environment node
// quicklook-lint self-test (lint/, docs/LINT.md): every rule red on its seeded violation and green on its clean twin; the
// zero-config CLI fails a fresh app that commits a violation and passes it once fixed; the kind registry guard; declared
// axes are really read; and the kit's own tree holds its ratchet.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { rules, stripComments } from '../lint/rules.js'
import { seeds, selfTest } from '../lint/seeds.js'
import { lintApp, format, writeAllow, loadAllow } from '../lint/run.js'
import { checkKinds } from '../lint/kinds.js'
import { ENFORCED, UNENFORCED_AXES, unenforcedKeys } from '../lint/axes.js'
import { registry } from '../lib/components.js'
import { gens } from '../conformance/gens.js'
import { checkLaws } from '../lib/laws.js'
import { VECTOR_DIR } from '../conformance/generate.mjs'
import { boundedQueue } from '../lib/bounded.js'
import { every, stop, timers } from '../lib/timers.js'

const KIT = join(import.meta.dirname, '..')
const CLI = join(KIT, 'lint/cli.mjs')

describe('rules: seeded violation red, clean twin green', () => {
  it('every rule has a seed, a prevents line and a how line', () => { expect(selfTest(rules, seeds)).toEqual([]) })
  it('every rule has a guide anchor in docs/LINT.md', () => {
    const doc = readFileSync(join(KIT, 'docs/LINT.md'), 'utf8')
    for (const r of rules) expect(doc, r.id).toContain(`<a id="${r.guide || r.id}"></a>`)
  })
  it('comments are not code, URLs are not comments', () => {
    expect(stripComments("// fetch('/x')\n/* setInterval(f) */ const u = 'http://a/b'; x()")).toBe("\n const u = 'http://a/b'; x()")
  })
  it('selfTest catches a rule that misses its seed', () => {
    const blind = { ...rules[0], count: () => 0 }
    expect(selfTest([blind], seeds)[0]).toMatch(/misses its seeded violation/)
  })
})

describe('zero-config CLI on a fresh app', () => {
  it('fails on a committed violation with the kit fix, passes once fixed, ratchets on --init', () => {
    const app = mkdtempSync(join(tmpdir(), 'ql-lint-'))
    try {
      mkdirSync(join(app, 'src/lib'), { recursive: true })
      writeFileSync(join(app, 'src/lib/a.js'), "export const load = () => fetch('/api/x');\nsetInterval(() => 1, 1000);\n")
      let r = spawnSync(process.execPath, [CLI, app], { encoding: 'utf8' })
      expect(r.status).toBe(1)
      expect(r.stdout).toMatch(/fetch-without-deadline 1 > allowed 0/)
      expect(r.stdout).toMatch(/do: createDeadlineFetch\(fetch\)\.fetchWithin/)
      expect(r.stdout).toMatch(/docs\/LINT\.md#interval-without-owner/)
      writeFileSync(join(app, 'src/lib/a.js'), "export const load = () => net.fetchWithin('read', '/api/x');\n")
      r = spawnSync(process.execPath, [CLI, app], { encoding: 'utf8' })
      expect(r.status, r.stdout).toBe(0)
      // adopting on an app with debt: --init freezes it, a new one fails, a fix leaves a stale allowance that fails
      writeFileSync(join(app, 'src/lib/b.js'), 'setInterval(() => 1, 1000);\n')
      expect(spawnSync(process.execPath, [CLI, app, '--init']).status).toBe(0)
      expect(loadAllow(app).rules['interval-without-owner']).toEqual({ 'src/lib/b.js': 1 })
      expect(spawnSync(process.execPath, [CLI, app]).status).toBe(0)
      writeFileSync(join(app, 'src/lib/b.js'), '// fixed\n')
      r = spawnSync(process.execPath, [CLI, app], { encoding: 'utf8' })
      expect(r.status).toBe(1); expect(r.stdout).toMatch(/stale/)
      expect(spawnSync(process.execPath, [CLI, app, '--ratchet']).status).toBe(0)
      expect(spawnSync(process.execPath, [CLI, app]).status).toBe(0)
    } finally { rmSync(app, { recursive: true, force: true }) }
  })
  it('loads app rules from quicklook-lint.rules.mjs with no other config', async () => {
    const app = mkdtempSync(join(tmpdir(), 'ql-lint-'))
    try {
      mkdirSync(join(app, 'src'), { recursive: true })
      writeFileSync(join(app, 'src/x.js'), 'TODO_FORBIDDEN\n')
      writeFileSync(join(app, 'quicklook-lint.rules.mjs'), "export const rules = [{ id: 'app-rule', prevents: 'p', how: 'h', scope: () => true, count: (t) => (t.includes('TODO_FORBIDDEN') ? 1 : 0) }]\n")
      const res = await lintApp({ root: app })
      expect(res.ok).toBe(false)
      expect(format(res)).toMatch(/app-rule 1 > allowed 0/)
    } finally { rmSync(app, { recursive: true, force: true }) }
  })
})

describe('kind registry guard (lint/kinds.js)', () => {
  const vectorKinds = readdirSync(VECTOR_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''))
  it('every registered kind has a law generator, vectors, and keeps every law', () => {
    expect(checkKinds({ registry, gens, vectorKinds, checkLaws })).toEqual([])
  })
  it('names a kind registered without a generator or vectors', () => {
    const p = checkKinds({ registry: { ...registry, draft: () => ({}) }, gens, vectorKinds })
    expect(p).toContain('draft: registered with no law generator in conformance/gens.js')
    expect(p).toContain('draft: registered with no conformance/components/draft.json vectors')
  })
})

describe('declared means enforced (lint/axes.js)', () => {
  // every lib/ module, recursively, except the key table itself (a key cannot prove itself read by being listed)
  const files = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : /\.m?js$/.test(e.name) && e.name !== 'declare-keys.js' ? [join(d, e.name)] : []))
  const lib = files(join(KIT, 'lib')).map((f) => readFileSync(f, 'utf8')).join('\n')
  for (const k of ENFORCED) it(`${k} is read by the engine`, () => { expect(lib).toMatch(new RegExp(`\\.${k}\\b|\\b${k}\\s*[,}=]|\\[['"]${k}['"]\\]`)) })
  it('an unenforced axis in a declaration is flagged', () => {
    expect(unenforcedKeys({ name: 'n', durability: 'persistent', initial: {}, actions: {} })).toEqual(['durability'])
    for (const a of UNENFORCED_AXES) expect(ENFORCED).not.toContain(a)
  })
})

describe('kit primitives the rules point at', () => {
  it('boundedQueue refuses construction without caps and policy, and refuses or drops when full', () => {
    expect(() => boundedQueue({ name: 'q' })).toThrow(/maxItems/)
    expect(() => boundedQueue({ name: 'q', maxItems: 2, maxBytes: 100 })).toThrow(/policy/)
    const r = boundedQueue({ name: 'r', maxItems: 2, maxBytes: 1000, policy: 'refuse' })
    expect([r.push(1), r.push(2), r.push(3)]).toEqual([true, true, false]); expect(r.stats().refused).toBe(1)
    const d = boundedQueue({ name: 'd', maxItems: 2, maxBytes: 1000, policy: 'drop-oldest' })
    d.push(1); d.push(2); d.push(3); expect([d.shift(), d.shift(), d.stats().dropped]).toEqual([2, 3, 1])
  })
  it('every() needs an owner and a budget, is listed, and stops', () => {
    expect(() => every('x', 10, () => {})).toThrow(/budgetMs/)
    every('lint-test', 1000, () => {}, { budgetMs: 5 }); expect(timers().map((t) => t.owner)).toContain('lint-test')
    expect(() => every('lint-test', 1000, () => {}, { budgetMs: 5 })).toThrow(/already running/)
    stop('lint-test'); expect(timers().map((t) => t.owner)).not.toContain('lint-test')
  })
})

describe("the kit's own tree holds its ratchet", () => {
  it('quicklook-lint over tools/pangea-kit', async () => {
    const res = await lintApp({ root: KIT })
    expect(format(res) || 'clean', res.ok ? '' : format(res)).toBeTruthy(); expect(res.ok, format(res)).toBe(true)
  })
})
void writeAllow
