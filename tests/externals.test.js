// @vitest-environment node
// Every external a part can import resolves to a key the host actually provides (lib/build.mjs globalFor vs host/boot.js deps).
import { describe, it, expect } from 'vitest'
import { globalFor } from '../lib/build.mjs'
import { hostDeps, kitDepKeys, isExternal } from '../lib/externals.js'

describe('part externals match the host deps', () => {
  const deps = hostDeps({ svelte: {}, svelteClient: {}, discloseVersion: {}, THREE: {}, ui: { Panel: 1 } })
  for (const k of kitDepKeys) deps[k] = { kit: 1 }
  const read = (id) => globalFor(id).split('.').slice(2).reduce((o, k) => o?.[k], deps)
  it.each(['svelte', 'svelte/internal/client', 'svelte/internal/disclose-version', 'three', 'pangea-kit/ui', 'pangea-kit'])('%s', (id) => {
    expect(isExternal(id)).toBe(true)
    expect(read(id)).toBeDefined()
  })
  it('the UI module is the one a built Panel reads', () => { expect(read('pangea-kit/ui').Panel).toBe(1) })
  it('parts published before the 11-11 rename still find their names', () => { expect(deps.quicklook_kit_ui.Panel).toBe(1); expect(deps.quicklook_kit.kit).toBe(1) })
})
