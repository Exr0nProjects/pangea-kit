// The data layer: heavy files live here, outside the reactive store and outside the app code, so a
// swap of any part never refetches or reparses them.
//   - every file is versioned independently by its content hash (the server's manifest); the URL is
//     <name>?v=<hash>, which the server answers `immutable`, so even a full page reload is served from
//     the browser's cache and a change to one file never touches the others
//   - json()/buffer() fetch once per (name, hash); concurrent callers share the promise
//   - memo(key, deps, fn) keeps DERIVED products (geometry, volumes) across part swaps; it is dropped
//     only when one of its dep files changes version
//   - setManifest(files) returns the names that changed and notifies watch()ers, which is how a changed
//     data file reaches only the part that shows it
export function createData({ baseUrl = '', fetchImpl = (...a) => globalThis.fetch(...a), onProgress = () => {} } = {}) {
  let versions = {}
  const raw = new Map() // `${name}@${hash}` -> { json?:Promise, buffer?:Promise }
  const memos = new Map() // key -> { deps:[names], at:{name:hash}, value }
  const watchers = new Map() // name -> Set(fn)
  const url = (name) => `${baseUrl}${name}${versions[name] ? `?v=${versions[name]}` : ''}`

  async function fetchRaw(name, kind) {
    const slot = `${name}@${versions[name] ?? ''}`
    let e = raw.get(slot)
    if (!e) raw.set(slot, e = {})
    if (!e[kind]) {
      e[kind] = (async () => {
        onProgress(name, 'start')
        try {
          const res = await fetchImpl(url(name))
          if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
          const body = await (kind === 'json' ? res.json() : res.arrayBuffer())
          onProgress(name, 'fetched')
          return body
        } catch (e) { onProgress(name, 'failed'); throw e }
      })()
      e[kind].catch(() => { if (raw.get(slot) === e) delete e[kind] })
    }
    return e[kind]
  }

  const api = {
    get versions() { return { ...versions } },
    version: (name) => versions[name],
    has: (name) => name in versions,
    url,
    json: (name) => fetchRaw(name, 'json'),
    buffer: (name) => fetchRaw(name, 'buffer'),
    /** Drop a raw parse after deriving from it (the derived value stays in memo). */
    release(name) { for (const k of [...raw.keys()]) if (k.startsWith(`${name}@`)) raw.delete(k) },
    memo(key, deps, fn) {
      const m = memos.get(key)
      const at = Object.fromEntries(deps.map((d) => [d, versions[d]]))
      if (m && deps.every((d) => m.at[d] === at[d])) return m.value
      const value = fn()
      const entry = { deps, at, value }
      memos.set(key, entry)
      // a derivation that failed is not a cached answer: the next caller (a fixed part) tries again
      if (value && typeof value.then === 'function') value.catch(() => { if (memos.get(key) === entry) memos.delete(key) })
      return value
    },
    watch(name, fn) {
      if (!watchers.has(name)) watchers.set(name, new Set())
      watchers.get(name).add(fn)
      return () => watchers.get(name)?.delete(fn)
    },
    /** files: { name: hash }. Returns { changed, added, removed }; watchers run for added and changed. */
    setManifest(files) {
      const prev = versions
      versions = { ...files }
      const changed = Object.keys(files).filter((n) => n in prev && prev[n] !== files[n])
      const added = Object.keys(files).filter((n) => !(n in prev))
      const removed = Object.keys(prev).filter((n) => !(n in files))
      for (const n of [...changed, ...removed]) for (const k of [...raw.keys()]) if (k.startsWith(`${n}@`) && k !== `${n}@${versions[n] ?? ''}`) raw.delete(k)
      for (const n of [...changed, ...added, ...removed]) for (const w of [...(watchers.get(n) || [])]) {
        try { w(n, versions[n]) } catch (err) { console.error(`[pangea-kit] watcher for ${n}`, err) }
      }
      return { changed, added, removed }
    },
  }
  return api
}
