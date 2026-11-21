// Bound the persisted op log by BYTES. Profiling 2026-11-18 (docs/DERIVED-STATE.md, "Profile"): an app whose actions carry
// whole arrays (`patch {vessels: [...]}`, 24 KB payload plus the same again in `prev`) made every persist stringify a
// 2.7 MB log, and the server-copy trim re-stringified the whole record once per dropped entry (1.9 s of main thread per
// save at 120 entries). Entry sizes are measured once per entry object (a WeakMap), the newest suffix that fits is kept,
// and the persisted record is built from that suffix, so a save is O(state + kept log), never O(log history).
const sizes = new WeakMap()
export const entryBytes = (a) => { let n = sizes.get(a); if (n === undefined) { n = JSON.stringify(a).length + 1; sizes.set(a, n) } return n }

/** The newest entries of `entries` whose serialized size is at most `maxBytes` (always keeps the newest one). */
export function boundLog(entries, maxBytes = 150_000) {
  let total = 0, i = entries.length
  while (i > 0) { const n = entryBytes(entries[i - 1]); if (total + n > maxBytes && i < entries.length) break; total += n; i-- }
  return i === 0 ? entries : entries.slice(i)
}

/** Drop the oldest log entries of a serialized record until it is under `limit` characters: one parse, sizes summed once. */
export function trimRecord(text, limit = 200_000) {
  if (text.length < limit) return text
  const rec = JSON.parse(text)
  if (!Array.isArray(rec.log)) return text
  const sizesNow = rec.log.map((a) => JSON.stringify(a).length + 1)
  let over = text.length - limit, drop = 0
  while (over > 0 && drop < rec.log.length) over -= sizesNow[drop++]
  rec.log = rec.log.slice(drop)
  return JSON.stringify(rec)
}
