// The engine's conformance vectors (conformance/engine/*.json) must be what a fresh build produces, byte for byte.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonical } from '../lib/canonical.js'
import { buildEngineVectors } from '../conformance/engine-vectors.js'

describe('engine conformance vectors', () => {
  it('a fresh build matches every stored vector', async () => {
    const dir = join(process.cwd(), 'conformance', 'engine')
    const fresh = await buildEngineVectors()
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    expect(files.map((f) => f.replace('.json', '')).sort()).toEqual(Object.keys(fresh).sort())
    for (const f of files) expect(canonical(fresh[f.replace('.json', '')]) + '\n', f).toBe(readFileSync(join(dir, f), 'utf8'))
  })
  it('the sender vector shows one id per intent and the verdict classes', async () => {
    const { sender } = await buildEngineVectors()
    // A is the head of s1, so B waits behind it until A is delivered; C (s2) runs beside A. Every retry of A is "A".
    expect(sender.attempts).toEqual(['A:1', 'A:2', 'C:1', 'A:3', 'C:2', 'B:1'])
    expect(sender.left).toEqual([])
  })
})
