// Writes conformance/engine/<name>.json from conformance/engine-vectors.js (canonical JSON).
import { mkdirSync, writeFileSync } from 'node:fs'
import { canonical } from '../lib/canonical.js'
import { buildEngineVectors } from './engine-vectors.js'
const dir = new URL('./engine/', import.meta.url)
mkdirSync(dir, { recursive: true })
const vectors = await buildEngineVectors()
for (const [name, v] of Object.entries(vectors)) writeFileSync(new URL(`${name}.json`, dir), canonical(v) + '\n')
console.log(`wrote ${Object.keys(vectors).length} engine vectors`)
