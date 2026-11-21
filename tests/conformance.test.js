// Component conformance: the committed vectors (conformance/components/*.json) replay byte for byte, they equal a fresh
// build (so a behaviour change is a visible vector diff), and three execution paths agree over seeded random sequences:
// the pure step fold, a replica's dispatch (gestures resolved against what it shows), and the in-place quicklook store.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { registry, declareComponent, resolve, inPlace } from '../lib/components.js'
import { createApp, declare, step } from '../lib/model.js'
import { createStore } from '../lib/store.js'
import { canonical } from '../lib/canonical.js'
import { buildVectors, fileText, VECTOR_DIR } from '../conformance/generate.mjs'
import { gens, rng } from '../conformance/gens.js'

const files = readdirSync(VECTOR_DIR).filter((f) => f.endsWith('.json')).sort()
const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v }, removeItem: (k) => { delete m[k] } } }

describe('component vectors', () => {
  it('cover every registered component', () => { expect(files.map((f) => f.replace('.json', ''))).toEqual(Object.keys(registry).sort()) })
  const fresh = buildVectors()
  for (const f of files) {
    const text = readFileSync(join(VECTOR_DIR, f), 'utf8'); const v = JSON.parse(text)
    it(`${f}: committed file is canonical and equals a fresh build`, () => { expect(text).toBe(fileText(v)); expect(text).toBe(fileText(fresh[v.kind])) })
    it(`${f}: every step replays byte for byte`, () => {
      const comp = registry[v.kind](...v.args); const d = declare(declareComponent(v.kind, comp, { scope: 'ephemeral' }))
      let n = 0
      for (const c of v.cases) {
        let s = comp.initial
        for (const st of c.steps) {
          let op = st.op, p = st.payload
          if (st.gesture) { const r = resolve(comp, s, st.gesture, st.payload); expect(canonical(r), `${c.name} resolve`).toBe(canonical(st.resolved)); if (!r) { expect(canonical(s)).toBe(canonical(st.state)); n++; continue } [op, p] = r }
          const o = step(d, s, op, p); s = o.state
          expect(canonical(s), `${c.name} step ${n}`).toBe(canonical(st.state)); expect(o.error).toBe(st.error); n++
        }
      }
      expect(n).toBeGreaterThan(300)
    })
  }
})

describe('differential: step fold vs replica dispatch vs quicklook store', () => {
  for (const [kind, { args, gen }] of Object.entries(gens)) {
    it(`${kind}: 300 seeded sequences agree on every step`, () => {
      for (let seed = 1; seed <= 300; seed++) {
        const r = rng(seed * 31 + 7); const comp = registry[kind](...args); const d = declare(declareComponent(kind, comp, { scope: 'ephemeral' }))
        const rep = createApp({ storage: mem(), device: 'd' }).use(declare(declareComponent(kind, comp, { scope: 'local' })))
        const state = {}; const st = createStore({ state }); st.component('c', inPlace(comp))
        let s = comp.initial; const seq = []
        for (let i = 0; i < 30; i++) {
          const g = gen(r, s, { junk: true }); seq.push(g)
          const res = resolve(comp, s, g[0], g[1])
          if (!res) continue
          const o = step(d, s, res[0], res[1]); s = o.state
          try { rep.dispatch(res[0], res[1]) } catch (e) { expect(e.code, JSON.stringify(seq)).toBe(o.error) }
          if (!o.error) st.dispatch(`c/${res[0]}`, res[1])
          expect(canonical(rep.get()), `${kind} seed ${seed} ${JSON.stringify(seq)}`).toBe(canonical(s))
          expect(canonical(state.c), `${kind} seed ${seed} store ${JSON.stringify(seq)}`).toBe(canonical(s))
        }
      }
    })
  }
})
