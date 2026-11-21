// @vitest-environment node
// The boot smoke gate (lib/bootgate.mjs) on two tiny fixture pages: a clean one passes, one with a promise that blows the
// stack fails with the overflow text. Skipped without a Chrome on the machine.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bootGate, findChrome, formatBootGate } from '../lib/bootgate.mjs'

const chrome = findChrome()
const page = (script) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bgfix-')); fs.writeFileSync(path.join(d, 'index.html'), `<!doctype html><html><body><div id=x>hi</div><script>${script}</script></body></html>`); return d }

describe.skipIf(!chrome)('boot smoke gate', () => {
  it('a clean page passes both loads (ResizeObserver noise is allowed)', async () => {
    const d = page(`document.getElementById('x').textContent='ok'; console.error('ResizeObserver loop completed with undelivered notifications.')`)
    const r = await bootGate(d, { waitMs: 800, chrome })
    expect(r.errors, formatBootGate(r)).toEqual([]); expect(r.ok).toBe(true); expect(r.loads.length).toBe(2)
  }, 30000)
  it('a stack overflow inside a promise fails the gate with the overflow text', async () => {
    const d = page(`function f(){f()}; Promise.resolve().then(f)`)
    const r = await bootGate(d, { waitMs: 800, chrome })
    expect(r.ok).toBe(false); expect(formatBootGate(r)).toMatch(/Maximum call stack/); expect(r.errors.some((e) => /stack overflow/.test(e.kind))).toBe(true)
  }, 30000)
  it('a console.error or a falsy app check fails', async () => {
    const r = await bootGate(page(`console.error('boom')`), { waitMs: 500, chrome }); expect(r.ok).toBe(false); expect(r.errors[0].kind).toBe('console.error')
    const r2 = await bootGate(page(`window.ready = false`), { waitMs: 500, chrome, extraChecks: ['window.ready'] }); expect(r2.ok).toBe(false); expect(r2.errors[0].kind).toBe('extraCheck')
  }, 40000)
})
