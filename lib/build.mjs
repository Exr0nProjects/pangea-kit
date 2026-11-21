// Builds one part (or the state schema) of an app to a single classic script that assigns its default export
// to `__pangeaPart`. Everything shared and stateful is an EXTERNAL taken from the host's globals, so a part
// swapped at runtime joins the same Svelte runtime (reactivity), the same three.js and the same UI components.
// Anything a part imports that is its own (a .svelte file, a helper module) is bundled into it.
import { build } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
import { isExternal, depKey } from './externals.js'
// rollup writes a dotted name into the IIFE call as a property chain; the host fills the same keys (lib/externals.js)
export const globalFor = (id) => `__pangea.deps.${depKey(id)}`

export async function buildPart(entry, { minify = false } = {}) {
  const out = await build({
    configFile: false, logLevel: 'silent', root: path.dirname(entry),
    plugins: [svelte({ compilerOptions: { css: 'injected', runes: true }, emitCss: false })],
    resolve: { conditions: ['browser'] },
    build: {
      write: false, minify, target: 'es2022', sourcemap: false,
      lib: { entry, formats: ['iife'], name: '__pangeaPart', fileName: 'part' },
      rollupOptions: { external: isExternal, output: { globals: globalFor, exports: 'default' } },
    },
  })
  const chunks = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output).filter((c) => c.type === 'chunk')
  if (chunks.length !== 1) throw new Error(`${entry}: expected one chunk, got ${chunks.length}`)
  return chunks[0].code
}
