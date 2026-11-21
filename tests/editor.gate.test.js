// @vitest-environment node
// The editor deploy gate (lib/editor/gate.mjs) and publish's hook: an editor app without declared checks is refused, and
// publish refuses on a failed gate before anything is staged.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gate } from '../lib/editor/gate.mjs'
import { publish, GateRefused } from '../lib/publish.mjs'

describe('deploy gate', () => {
  const appDir = (files) => { const d = mkdtempSync(join(tmpdir(), 'qk-gate-')); for (const [f, t] of Object.entries(files)) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), t) } return d }
  it('an editor app with no declared checks is refused', async () => {
    const d = appDir({ 'src/main.js': "import { createEditor } from 'kit/editor/editor.js';\ncreateEditor({ root, app, doc, contract });\n" })
    expect((await gate(d, { log: () => {} })).ok).toBe(false)
  })
  it('publish refuses on a lint failure and publishes nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qk-root-')); process.env.PANGEA_KIT_QUICKLOOK_ROOT = root
    const d = appDir({ 'state.js': "setInterval(() => {}, 1000)\nexport default {}\n" })
    const registryPath = join(mkdtempSync(join(tmpdir(), 'qk-reg-')), 'reg.json'); writeFileSync(registryPath, '{"version":1,"facts":{},"apps":{}}')
    // a non-git dir publishes only as --scratch (a commit publish refuses it before the gate, tests/publish.test.js)
    await expect(publish(d, { scratch: true, registryPath, log: () => {}, gateFn: (p) => gate(p, { log: () => {} }) })).rejects.toBeInstanceOf(GateRefused)
    expect(readdirSync(root)).toEqual([])
  })
})
