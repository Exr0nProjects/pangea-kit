// The host (index.html): kit runtime + three.js + svelte runtime + UI components, one self-contained file.
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { viteSingleFile } from 'vite-plugin-singlefile'
export default defineConfig({
  root: 'host',
  plugins: [svelte({ compilerOptions: { css: 'injected', runes: true }, emitCss: false }), viteSingleFile()],
  resolve: { conditions: ['browser'] },
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022', assetsInlineLimit: 100000000, cssCodeSplit: false },
})
