// Planted-bug proofs: a copy of a kit module with one edit (the bug), written beside the original so its relative
// imports resolve, imported, and removed. A check that stays green with its bug planted proves nothing (CEN A25, A34).
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..')
let n = 0

/** Import `rel` (a kit path such as 'lib/editor/editor.js') with `find` replaced by `repl`; throws when find is absent. */
export async function planted(rel, find, repl) {
  const src = join(KIT, rel), text = readFileSync(src, 'utf8')
  if (!text.includes(find)) throw new Error(`planted: anchor not found in ${rel}: ${find.slice(0, 80)}`)
  const out = join(dirname(src), `.planted-${process.pid}-${++n}-${basename(src)}`)
  writeFileSync(out, text.replace(find, repl))
  try { return await import(pathToFileURL(out).href) } finally { rmSync(out, { force: true }) }
}
