// Stacked selection pills (lib/editor/pills.js): placement laws over random anchors, sizes and views, and the 2026-11-12 case.
import { describe, expect, it } from 'vitest'
import { stackPills } from '../lib/editor/pills.js'

const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

describe('stackPills', () => {
  it('the zai3 case: selection pill nearest the words, the format pill above it, an 8 px gap each, both in view', () => {
    const anchor = { left: 600, right: 700, top: 100, bottom: 120 }, sizes = [{ w: 345, h: 32 }, { w: 306, h: 34 }], view = { w: 1280, h: 860 }
    const r = stackPills({ anchor, sizes, view })
    expect(r.side).toBe('above')
    const [a, b] = r.items
    expect(a.top + sizes[0].h + 8).toBe(anchor.top) // 8 px between the selection pill and the words
    expect(b.top + sizes[1].h + 8).toBe(a.top) // and between the two pills
    expect(a.left).toBeGreaterThanOrEqual(8)
  })
  it('goes below the words when the top has no room (words near the top), the order away from the words kept', () => {
    const anchor = { left: 300, right: 400, top: 40, bottom: 60 }, sizes = [{ w: 345, h: 32 }, { w: 306, h: 34 }], view = { w: 1280, h: 860 }
    const r = stackPills({ anchor, sizes, view })
    expect(r.side).toBe('below')
    expect(r.items[0].top).toBe(68)
    expect(r.items[1].top).toBe(68 + 32 + 8)
  })
  it('clamps horizontally into the view at both edges', () => {
    const sizes = [{ w: 345, h: 32 }, { w: 306, h: 34 }], view = { w: 400, h: 800 }
    for (const mid of [0, 10, 200, 390, 400]) {
      const r = stackPills({ anchor: { left: mid - 5, right: mid + 5, top: 300, bottom: 320 }, sizes, view })
      r.items.forEach((p, k) => { expect(p.left).toBeGreaterThanOrEqual(8); expect(p.left + sizes[k].w).toBeLessThanOrEqual(392) })
    }
  })
  it('property: 3,000 random cases: never overlap each other, always in the view, the gap is exact when the side has room', () => {
    const r = rng(77); let roomy = 0
    for (let n = 0; n < 3000; n++) {
      const view = { w: 300 + Math.floor(r() * 1400), h: 400 + Math.floor(r() * 700) }
      const top = Math.floor(r() * view.h), anchor = { left: Math.floor(r() * view.w), right: 0, top, bottom: top + 14 + Math.floor(r() * 60) }
      anchor.right = anchor.left + Math.floor(r() * 300)
      const sizes = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({ w: 100 + Math.floor(r() * 260), h: 24 + Math.floor(r() * 120) }))
      const res = stackPills({ anchor, sizes, view })
      const bs = res.items.map((p, k) => ({ l: p.left, t: p.top, r: p.left + sizes[k].w, b: p.top + sizes[k].h }))
      const total = sizes.reduce((s, z) => s + z.h, 0) + 8 * (sizes.length - 1)
      for (const [k, b] of bs.entries()) { expect(b.l).toBeGreaterThanOrEqual(8 - 1e-9); if (sizes[k].w <= view.w - 16) expect(b.r).toBeLessThanOrEqual(view.w - 8 + 1e-9); if (total <= view.h - 16) { expect(b.t).toBeGreaterThanOrEqual(8 - 1e-9); expect(b.b).toBeLessThanOrEqual(view.h - 8 + 1e-9) } }
      for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) expect(bs[i].b <= bs[j].t + 1e-9 || bs[j].b <= bs[i].t + 1e-9).toBe(true)
      const fitsAbove = total <= anchor.top - 8 - 8, fitsBelow = total <= view.h - 8 - (anchor.bottom + 8)
      if (fitsAbove || fitsBelow) { roomy++; const near = res.side === 'above' ? bs[0].b + 8 === anchor.top : bs[0].t === anchor.bottom + 8; expect(near).toBe(true) }
    }
    expect(roomy).toBeGreaterThan(1000) // the property ran over the roomy cases, not vacuously
  })
  it('is red on a stack that places each pill from its own rect (the check can fail): two pills at one top overlap', () => {
    const anchor = { left: 0, right: 10, top: 200, bottom: 220 }, sizes = [{ w: 100, h: 30 }, { w: 100, h: 30 }]
    const bad = sizes.map(() => ({ t: anchor.top - 6 - 30, b: anchor.top - 6 })) // the old placement: each 6 px over the SAME rect
    expect(bad[0].b <= bad[1].t).toBe(false)
    const ok = stackPills({ anchor, sizes, view: { w: 800, h: 600 } })
    expect(ok.items[1].top + 30 + 8).toBe(ok.items[0].top)
  })
})
