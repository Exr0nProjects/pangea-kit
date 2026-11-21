// Storage for the viewer5 persistence contract inside a quicklook page. The page is sandboxed to an
// opaque origin, so localStorage, sessionStorage, IndexedDB and Cache all throw. Two places survive:
//   window.name  - same tab, survives reload and navigation (written synchronously on every save)
//   view.json    - the artifact's own file on the server (POSTed to __view, fetched at boot): survives
//                  a new tab or a closed browser, and is what the owner's agent reads
// getItem returns whichever record is newer. Archives (raw bytes kept before a migration) ride in
// window.name, last three only.
const NAME_TAG = 'qk1'

export function createKitStorage({ win = globalThis.window, serverRecord = null, key, legacyKeys = [], post = () => {} } = {}) {
  const mem = new Map()
  let archives = []
  const readName = () => {
    try {
      const j = JSON.parse(win?.name || 'null')
      return j && j.t === NAME_TAG ? j : null
    } catch { return null }
  }
  const named = readName()
  if (named) { for (const [k, v] of Object.entries(named.r || {})) mem.set(k, v); archives = named.a || [] }
  // an app renamed in state.js (`name`, `legacyNames`): its saved state sits under the old key; adopt it once when the new key is empty (the server record, if any, still wins when newer)
  if (key && !mem.has(key)) for (const lk of legacyKeys) if (mem.has(lk)) { mem.set(key, mem.get(lk)); break }
  const ts = (raw) => { try { return JSON.parse(raw).savedAt || 0 } catch { return 0 } }
  if (serverRecord && key) {
    const raw = typeof serverRecord === 'string' ? serverRecord : JSON.stringify(serverRecord)
    if (!mem.has(key) || ts(raw) > ts(mem.get(key))) mem.set(key, raw)
  }
  const writeName = () => {
    if (!win) return
    // never overwrite a window.name somebody else set
    if (win.name && !readName()) return
    try { win.name = JSON.stringify({ t: NAME_TAG, r: Object.fromEntries([...mem].filter(([k]) => !k.startsWith('__archive__'))), a: archives }) } catch {}
  }
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem(k, v) {
      if (k.startsWith('__archive__')) { archives = [...archives, { k, v }].slice(-3); writeName(); return }
      mem.set(k, v); writeName(); post(k, v)
    },
    removeItem(k) { mem.delete(k); writeName() },
    get archives() { return archives },
  }
}
