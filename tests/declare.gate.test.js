// @vitest-environment node
// The gate's declaration check (lib/validate-app.mjs via lib/editor/gate.mjs declarationsCheck): every app module that
// declares state is loaded and every law runs over every declaration; each refusal below is a planted violation.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { gate } from '../lib/editor/gate.mjs'

const KIT = resolve(import.meta.dirname, '..')
const appDir = (files) => { const d = mkdtempSync(join(tmpdir(), 'qk-decl-')); for (const [f, t] of Object.entries(files)) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), t) } return d }
const model = `${KIT}/lib/model.js`
const run = async (files) => (await gate(appDir(files), { only: ['declarations'], log: () => {} })).declarations

describe('gate: declarations', () => {
  it('a lawful declaration passes, counted', async () => {
    const r = await run({ 'src/state.js': `import { declare } from '${model}'\nexport const prefs = declare({ name: 'prefs', scope: 'local', initial: { open: false }, actions: { open: (s, { open } = {}) => (typeof open === 'boolean' && open !== s.open ? { open } : s) } })\n` })
    expect(r.failures).toEqual([])
    expect(r.decls).toBe(1)
  }, 30000)
  it('planted: a relative action (a toggle in the log) refuses the deploy', async () => {
    const r = await run({ 'src/state.js': `import { declare } from '${model}'\nexport const t = declare({ name: 't', scope: 'local', initial: { on: false }, actions: { flip: (s) => ({ on: !s.on }) } })\n` })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toMatch(/t: idempotent/)
  }, 30000)
  it('planted: an unexecuted axis refuses the deploy (the module does not load)', async () => {
    const r = await run({ 'src/state.js': `import { declare } from '${model}'\nexport const t = declare({ name: 't', scope: 'local', retention: '30d', initial: { a: 0 }, actions: { a: (s) => s } })\n` })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toMatch(/loadable.*"retention" is not executed/)
  }, 30000)
  it('planted: an action no generated step exercises refuses until the app supplies a generator', async () => {
    const decl = `import { declare } from '${model}'\nexport const v = declare({ name: 'v', scope: 'ephemeral', initial: { open: false }, actions: { unlock: (s, { pass } = {}) => (pass === 'swordfish-42' && !s.open ? { open: true } : s) } })\n`
    expect((await run({ 'src/state.js': decl })).failures.join('\n')).toMatch(/v: coverage/)
    const ok = await run({ 'src/state.js': decl, 'test/gens.js': "export default { v: (r) => ['unlock', { pass: r.chance(0.5) ? 'swordfish-42' : 'x' }] }\n", 'quicklook-ui.config.mjs': "export default { validate: { gens: 'test/gens.js' } }\n" })
    expect(ok.failures).toEqual([])
  }, 30000)
  it('planted: state declared in a .svelte file is refused (the gate cannot load it)', async () => {
    const r = await run({ 'src/Panel.svelte': `<script>import { declare } from '${model}'; const s = declare({ name: 'p', initial: {}, actions: { a: (s) => s } })</script>\n` })
    expect(r.failures.join('\n')).toMatch(/Panel.svelte: loadable/)
  }, 30000)
  it('planted: an app that calls createEditor or openRows with no module-level declaration refuses the deploy (row #38)', async () => {
    const r = await run({ 'src/main.js': `import { createEditor } from '${KIT}/lib/editor/editor.js'\nimport { openRows } from '${KIT}/lib/engine/rows.js'\nexport const boot = () => { createEditor({}); openRows({}) }\n` })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toMatch(/\(editor\): coverage: the app calls createEditor but no editor declaration/)
    expect(r.failures.join('\n')).toMatch(/\(rows\): coverage: the app calls openRows but no row declaration/)
  }, 30000)
  it('an editor app that declares its editor and rows at module level gets every law run over them, counted', async () => {
    const r = await run({
      'src/main.js': `import { createEditor } from '${KIT}/lib/editor/editor.js'\nimport { openRows } from '${KIT}/lib/engine/rows.js'\nexport const boot = () => { createEditor({}); openRows({}) }\n`,
      'src/editor.js': `import { declareEditor } from '${KIT}/lib/editor/declare.js'\nimport { declareRows } from '${KIT}/lib/engine/rows-declare.js'\nexport const app = { keys: ['Tab'], textOf: (r) => r.body ?? '', reduce: (s, a, ctx) => (a.type === 'input' && a.sel ? { puts: [{ id: a.sel.a.id, set: { body: String(a.text ?? '') } }] } : a.type === 'key' || a.type === 'pointer' || a.type === 'compose-end' ? (ctx.lines[0] ? { puts: [{ id: ctx.lines[0].id, set: { body: ctx.lines[0].body + '.' } }] } : null) : null) }\nexport const contract = { name: 'fixture', actions: [] }\nexport const decls = declareEditor(contract, app)\nexport const rows = declareRows({ name: 'fixture-rows', fields: ['body', 'ord'] })\n`,
    })
    expect(r.failures).toEqual([])
    expect(r.decls).toBe(3)
  }, 30000)
  it('an app with no declarations passes with zero', async () => {
    const r = await run({ 'src/main.js': 'export const x = 1\n' })
    expect(r).toMatchObject({ ok: true, decls: 0 })
  }, 30000)
})
