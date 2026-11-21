// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkUndef, undefReport } from '../lib/no-undef.mjs'
import { stage, publish, UndefRefused } from '../lib/publish.mjs'

const undef = (src, opts) => checkUndef(src, opts).map((r) => r.name)

describe('checkUndef: real lexical scopes', () => {
  it('the draft bug: const declared inside one function, used in a sibling scope, is reported with line and column', () => {
    const src = [
      'function setup() {',
      '  $effect(() => {',
      '    const draft = read()',
      '    use(draft)',
      '  })',
      '  return () => draft.length', // sibling scope: ReferenceError in the browser
      '}',
      'function $effect(f) { f() } function read() { return [] } function use() {}',
    ].join('\n')
    expect(checkUndef(src)).toEqual([{ name: 'draft', line: 6, col: 15 }])
  })
  it('the clean twin of the bug passes', () => {
    const src = 'function setup() { let draft; $effect(() => { draft = read(); use(draft) }); return () => draft.length }\nfunction $effect(f) { f() } function read() { return [] } function use() {}'
    expect(undef(src)).toEqual([])
  })
  it('var and function hoist; let/const and class are block scoped; catch param, labels, for heads', () => {
    expect(undef('function f() { if (1) { var a = 1 } return a } f()')).toEqual([])
    expect(undef('g(); function g() {} { function h() {} } h()')).toEqual([])
    expect(undef('{ let x = 1 } x')).toEqual(['x'])
    expect(undef('{ const k = 1 } k')).toEqual(['k'])
    expect(undef('{ class C {} } new C()')).toEqual(['C'])
    expect(undef('try { f() } catch (e) { e.x } e; function f() {}')).toEqual(['e'])
    expect(undef('try { f() } catch ({ message, ...rest }) { message; rest } function f() {}')).toEqual([])
    expect(undef('for (let i = 0; i < 3; i++) {} i')).toEqual(['i'])
    expect(undef('for (const [a, { b }] of []) { a; b } for (var v in {}) {} v')).toEqual([])
    expect(undef('outer: for (;;) { for (;;) { break outer } }')).toEqual([])
    expect(undef('switch (1) { case 1: let s = 1; s; break; default: s } s')).toEqual(['s'])
  })
  it('params, destructuring, defaults, rest, arguments, named function and class expressions', () => {
    expect(undef('const f = ({ a, b: [c, d = a], ...r }, e = c, ...more) => [a, c, d, r, e, more]; f()')).toEqual([])
    expect(undef('function f() { return arguments.length } f()')).toEqual([])
    expect(undef('const f = () => arguments')).toEqual([]) // `arguments` is allow-listed: never a false alarm
    expect(undef('const f = function fact(n) { return n ? n * fact(n - 1) : 1 }; f()')).toEqual([])
    expect(undef('const C = class Inner { static make() { return new Inner() } }; C')).toEqual([])
    expect(undef('class A extends B {} ')).toEqual(['B'])
    expect(undef('function f(a = zz) {} f()')).toEqual(['zz'])
  })
  it('keys, member properties, labels and export names are not references; shorthand and computed ARE', () => {
    expect(undef('const o = { foo: 1, bar() {}, get baz() { return 1 }, "q": 2 }; o.nope; o.a.b; o?.c')).toEqual([])
    expect(undef('class K { field = 1; static s = 2; #p = 3; m() { return this.#p } }; new K()')).toEqual([])
    expect(undef('const o = { draft }')).toEqual(['draft'])
    expect(undef('const o = { [key]: 1 }')).toEqual(['key'])
    expect(undef('const o = {}; o[idx]')).toEqual(['idx'])
    expect(undef('const { x: y } = { x: 1 }; y; x')).toEqual(['x'])
    expect(undef('const a = 1; export { a as b }; export const c = 2; export default function d() {}')).toEqual([])
    expect(undef('import { a as b } from "m"; import d, * as ns from "n"; b; d; ns')).toEqual([])
    expect(undef('function F() { return new.target } import.meta.url; F')).toEqual([])
  })
  it('assignment to an undeclared name is a reference (implicit global); assignment patterns resolve their targets', () => {
    expect(undef('oops = 1')).toEqual(['oops'])
    expect(undef('let a, b; [a, b] = [1, 2]; ({ a, b: nope } = {})')).toEqual(['nope'])
    expect(undef('for (z of []) {}')).toEqual(['z'])
  })
  it('browser and ES globals pass; extra globals are accepted; the host global __pangea is allowed', () => {
    expect(undef('window.x = document.body; console.log(navigator, performance.now(), GPUBufferUsage.STORAGE, GPUShaderStage.COMPUTE, GPUMapMode.READ); requestAnimationFrame(() => structuredClone(new URL("a", location)))')).toEqual([])
    expect(undef('new Float32Array(Math.max(1, Number.MAX_SAFE_INTEGER)); JSON.stringify(Symbol.iterator); __pangea.deps.svelte')).toEqual([])
    expect(undef('hostThing()')).toEqual(['hostThing'])
    expect(undef('hostThing()', { globals: ['hostThing'] })).toEqual([])
  })
  it('a built IIFE (what the kit emits) is analysed as a script when module parsing refuses it', () => {
    expect(undef('var __pangeaPart = (function (svelte) { "use strict"; return { svelte }; })(__pangea.deps.svelte);')).toEqual([])
  })
  it('undefReport prints one actionable line per finding, then the source line and a caret', () => {
    const out = undefReport('parts/90-ui.js', 'let a = 1, foo\nfoo(a, draft)')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/^undefined identifier draft at parts\/90-ui\.js:2:7\n    foo\(a, draft\)\n {4}\s{7}\^$/u)
  })
})

describe('publish refuses a built part that references an undeclared identifier', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qk-undef-'))
  const app = (parts) => {
    const d = path.join(tmp(), 'app'); fs.mkdirSync(path.join(d, 'parts'), { recursive: true }); fs.writeFileSync(path.join(d, 'state.js'), 'export default {}')
    for (const [f, t] of Object.entries(parts)) fs.writeFileSync(path.join(d, 'parts', f), t)
    return d
  }
  const BUG = 'export default function setup() {\n  const stop = () => { const draft = [1]; return draft }\n  return () => draft.length + stop().length\n}\n'
  const CLEAN = 'export default function setup() {\n  let draft = [1]\n  return () => draft.length\n}\n'
  it('stage: the bug part fails with the format an editor can act on, nothing is left in a stage dir; the clean part stages', async () => {
    const err = await stage(app({ '10-view.js': BUG })).then(() => null, (e) => e)
    expect(err).toBeInstanceOf(UndefRefused)
    expect(err.message).toMatch(/undefined identifier draft at parts\/10-view\.js:\d+:\d+\n {4}.*draft\.length/u)
    const ok = await stage(app({ '10-view.js': CLEAN })); expect(fs.existsSync(path.join(ok, 'parts/10-view.js'))).toBe(true)
  }, 60000)
  it('stage: allowUndef is the escape', async () => {
    const dir = await stage(app({ '10-view.js': BUG }), { allowUndef: true }); expect(fs.existsSync(path.join(dir, 'parts/10-view.js'))).toBe(true)
  }, 60000)
  it('publish --scratch exits through the same refusal and writes nothing into the artifact', async () => {
    const root = tmp(), ulid = '01MDQ7G8K9ZB2NXVT4R5CWYH3J'; fs.mkdirSync(path.join(root, ulid))
    const old = process.env.PANGEA_KIT_QUICKLOOK_ROOT; process.env.PANGEA_KIT_QUICKLOOK_ROOT = root
    try {
      await expect(publish(app({ '10-view.js': BUG }), { scratch: true, into: ulid, log: () => {}, gateFn: async () => ({ ok: true }) })).rejects.toThrow(/undefined identifier draft at parts\/10-view\.js/)
      expect(fs.readdirSync(path.join(root, ulid))).toEqual([])
    } finally { if (old === undefined) delete process.env.PANGEA_KIT_QUICKLOOK_ROOT; else process.env.PANGEA_KIT_QUICKLOOK_ROOT = old }
  }, 90000)
})
