// A control mounted by a part must receive clicks. #qk-ui is pointer-events:none (empty space orbits the camera), and
// pointer-events inherits, so a part element that did not opt back in left every plain button and slider dead (nmr applet
// 2026-11-21, and several times before). Two layers: partContext opts in (unit), and the boot gate flags any control that
// still falls through to the canvas (real Chrome).
import { describe, expect, it } from 'vitest'
import { partContext } from '../host/kit.svelte.js'

describe('partContext', () => {
  it('the part element opts back in to pointer events, and has no box of its own', () => {
    const root = document.createElement('div'); root.style.pointerEvents = 'none'; document.body.append(root)
    const ctx = partContext({ parts: new Map() }, 'x', root, { rank: 1 })
    expect(ctx.el.style.pointerEvents).toBe('auto')
    expect(ctx.el.style.display).toBe('contents') // no box: empty UI space still passes clicks to the canvas
  })
})

