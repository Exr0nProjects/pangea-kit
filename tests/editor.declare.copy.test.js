// The declared editor reducer copies its view state with lib/editor/declare.js json() instead of a JSON round trip (the round
// trip dominated a step: tests/declare.gate.test.js reducerBudget). The copy must be the round trip's result on every shape the
// state can hold, and a step must stay cheap as the view grows its embed and presence keys.
import { describe, expect, it } from 'vitest'
import { json } from '../lib/editor/declare.js'
import { mulberry } from '../lib/laws-ui/budget.js'

const roundTrip = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)))
const val = (r, depth) => {
  const k = r.int(0, depth > 3 ? 7 : 11)
  switch (k) {
    case 0: return null
    case 1: return r.pick([0, -0, 1, -1.5, 1e21, NaN, Infinity, -Infinity, 2 ** 53])
    case 2: return r.pick(['', 'a', 'é', '\u2028', 'x"y'])
    case 3: return r.chance(0.5)
    case 4: return undefined
    case 5: return () => 1
    case 6: return Symbol('s')
    case 7: return r.pick(['__proto__', 'constructor', '0', '1'])
    case 8: case 9: return Array.from({ length: r.int(0, 4) }, () => val(r, depth + 1))
    default: { const o = {}; for (let i = r.int(0, 4); i > 0; i--) o[r.pick(['a', 'b', '2', '1', 'c d', 'id', '__proto__'])] = val(r, depth + 1); return o }
  }
}

describe('declare json() copy', () => {
  it('equals the JSON round trip on 5000 random plain values (undefined, functions, non-finite numbers, key order)', () => {
    const r = mulberry(11)
    for (let i = 0; i < 5000; i++) {
      const v = val(r, 0)
      let want, wantErr = null
      try { want = roundTrip(v) } catch (e) { wantErr = e }
      if (wantErr) { expect(() => json(v)).toThrow(); continue }
      const got = json(v)
      expect(JSON.stringify(got)).toBe(JSON.stringify(want))
      expect(Object.keys(got ?? {})).toEqual(Object.keys(want ?? {}))
    }
  })
  it('a value with toJSON, a Date and a null-prototype object take the round trip', () => {
    expect(json({ d: new Date(0), t: { toJSON: () => 5 } })).toEqual({ d: '1970-01-01T00:00:00.000Z', t: 5 })
    const n = Object.create(null); n.a = 1
    expect(json(n)).toEqual({ a: 1 })
  })
  it('the copy shares nothing with its input', () => {
    const v = { a: [1, { b: 2 }], c: { d: [] } }
    const c = json(v)
    expect(c).toEqual(v); expect(c.a).not.toBe(v.a); expect(c.a[1]).not.toBe(v.a[1]); expect(c.c.d).not.toBe(v.c.d)
  })
})
