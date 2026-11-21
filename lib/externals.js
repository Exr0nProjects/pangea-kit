// The one table of what a part imports from the host. lib/build.mjs compiles each external import of a part to
// `__pangea.deps.<depKey(id)>`; host/boot.js fills __pangea.deps from hostDeps() and kitDepKeys, so the two sides cannot drift.
// (They did: the 2026-11-11 quicklook-kit -> pangea-kit rename made new parts read __pangea.deps.pangea_kit_ui while the host
// still only provided quicklook_kit_ui, and every rebuilt Panel threw "reading 'Panel'".)
export const depKey = (id) => id.replace(/\W/gu, '_')
export const isExternal = (id) => id === 'three' || id === 'svelte' || id.startsWith('svelte/') || id === 'pangea-kit/ui' || id === 'pangea-kit'
// Parts already published before the rename reference the old names; the host keeps answering them.
const LEGACY = { 'pangea-kit/ui': 'quicklook_kit_ui', 'pangea-kit': 'quicklook_kit' }
const keysFor = (id) => [depKey(id), ...(LEGACY[id] ? [LEGACY[id]] : [])]

/** __pangea.deps for the modules the host bundles (everything except the kit object, which exists only after boot). */
export function hostDeps({ svelte, svelteClient, discloseVersion, THREE, ui }) {
  const mods = { svelte, 'svelte/internal/client': svelteClient, 'svelte/internal/disclose-version': discloseVersion, three: THREE, 'pangea-kit/ui': ui }
  return Object.fromEntries(Object.entries(mods).flatMap(([id, m]) => keysFor(id).map((k) => [k, m])))
}
/** The keys the kit object itself is published under (`import kit from 'pangea-kit'`). */
export const kitDepKeys = keysFor('pangea-kit')
