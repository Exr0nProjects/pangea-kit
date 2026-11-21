// @vitest-environment node
// Boot gate: a control under the kit's pass-through UI layer that falls through to the canvas is a dead control (see dead-controls.test.js).
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bootGate, findChrome, formatBootGate } from '../lib/bootgate.mjs'

const chrome = findChrome()
// a kit-shaped page: full-screen canvas under a pointer-events:none #qk-ui; the part element mirrors partContext (opt-in or not)
const page = (partStyle, buttonStyle = '') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dcfix-'))
  fs.writeFileSync(path.join(d, 'index.html'), `<!doctype html><html><body style="margin:0"><div id="qk-stage" style="position:absolute;inset:0"><canvas style="width:100%;height:100%"></canvas></div><div id="qk-ui" style="position:absolute;inset:0;pointer-events:none"><div data-part="p" style="display:contents;${partStyle}"><div style="position:absolute;left:20px;top:20px;width:200px;height:60px"><button style="${buttonStyle}">go</button></div></div></div></body></html>`)
  return d
}
describe.skipIf(!chrome)('boot gate: dead controls', () => {
  it('a control under a pass-through layer that did not opt in is reported', async () => {
    const r = await bootGate(page('', ''), { waitMs: 600, minMs: 300, chrome })
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.kind)).toContain('dead-control')
    expect(formatBootGate(r)).toMatch(/button "go".*hit <canvas>/)
  }, 30000)
  it('the same control, opted in the way partContext does, passes', async () => {
    const r = await bootGate(page('pointer-events:auto'), { waitMs: 600, minMs: 300, chrome })
    expect(r.errors, formatBootGate(r)).toEqual([]); expect(r.ok).toBe(true)
  }, 30000)
})
