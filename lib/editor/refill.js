// The zone refill sentinel (The owner 2026-11-10 21:22-21:25 PST: "we should maintain that now always has at least 2 new lines
// so i can always click on it"; "past should also never be empty, have at least 2 newlines. same for future"; "its a
// sentinel action type named refill, so server/other reducers know to handle it specially"; "its not ending in 2 blank
// lines, its if its completely empty").
//
// The editor contract declares `refill: { zones, zoneOf, make, count? }`:
//   zones   the zone keys that must never be empty, in document order
//   zoneOf  (row) -> zone key of a live row
//   make    (zone, k, at) -> the `set` of blank row k (1-based) of that zone (every field the app's rows carry; its ord
//           places it; `source: 'pad'` is how exports and the MCP view tell a placeholder from content)
//   count   how many rows a refill creates, default 2
// The action is the sentinel { type: 'refill', zone }. It carries no rows. Every reducer applies it the same way, to the
// state it is applied to: if the zone holds ANY live row (blank or not) it does nothing; if the zone holds none it writes
// exactly `count` blank rows whose ids come from the zone and a generation, nothing else. So a single application yields
// exactly `count` rows on an empty zone and 0 on any other, applying it twice is applying it once (the second finds the
// zone filled), two devices refilling the same state write the same rows by id and merge as one (per-field LWW over the
// same ids), and a late or replayed refill is a no-op unless the zone is empty again. It never stacks.
//
// Row ids: pad:<zone>:<g>:<k>. The generation g is the smallest one none of whose ids this replica has ever seen (live or
// tombstoned, the rows store's peek): a refill after the last row was deleted does not resurrect a dead pad (a resurrected
// row would replay the move records an old split or join left on it) and never overwrites a pad that was typed into and
// moved to another zone. `primeRefill` reads the used generations off disk at boot, since peek only knows what a tab loaded.
export const PAD_PREFIX = 'pad:';
export const padId = (zone, g, k) => `${PAD_PREFIX}${zone}:${g}:${k}`;
/** Whether a row is a refill placeholder (by id), blank or not. A typed-into pad is an ordinary row that keeps its id. */
export const isPadRow = (row) => typeof row?.id === 'string' && row.id.startsWith(PAD_PREFIX);

export const REFILL_KEYS = ['zones', 'zoneOf', 'make', 'count'];
export function checkRefill(spec, name = 'contract') {
  if (spec == null) return null;
  if (typeof spec !== 'object' || !Array.isArray(spec.zones) || !spec.zones.length || spec.zones.some((z) => typeof z !== 'string' || !z || z.includes(':'))) throw new Error(`${name}: refill.zones is a list of zone key strings`);
  if (typeof spec.zoneOf !== 'function' || typeof spec.make !== 'function') throw new Error(`${name}: refill needs zoneOf(row) and make(zone, k, at)`);
  for (const k of Object.keys(spec)) if (!REFILL_KEYS.includes(k)) throw new Error(`${name}: unknown refill key "${k}" (${REFILL_KEYS.join(', ')})`);
  if (spec.count != null && !(Number.isInteger(spec.count) && spec.count >= 1 && spec.count <= 8)) throw new Error(`${name}: refill.count is an integer 1..8`);
  return spec;
}
export const refillCount = (spec) => spec.count ?? 2;

/** Whether `zone` can be judged empty from the loaded rows. A paged doc loads a contiguous window ending at the document's
 *  end, so a zone is certainly empty only if every row it could hold is in the window: the doc is complete, or the zone
 *  comes after the zone of the first loaded row. (A zone before it may hold older rows nobody has read.) */
const knowable = (lines, spec, zone, complete) => {
  if (complete) return true;
  if (!lines.length) return false;
  const at = spec.zones.indexOf(spec.zoneOf(lines[0]));
  return spec.zones.indexOf(zone) > (at < 0 ? Infinity : at);
};

/** The zones with no live row among `lines` (the doc's loaded, ordered, live rows): the zones a refill would fill.
 *  complete: whether the doc holds every row (a paged doc may not; see knowable). */
export function emptyZones(lines, spec, complete = true) {
  const seen = new Set();
  for (const r of lines) seen.add(spec.zoneOf(r));
  return spec.zones.filter((z) => !seen.has(z) && knowable(lines, spec, z, complete));
}

/** The puts the sentinel { type: 'refill', zone } makes against `lines` (the doc's live rows) and `peek` (any row by id,
 *  tombstones included): [] unless the zone is empty, else exactly `count` blank rows. Pure. */
export function refillPuts(lines, peek, spec, zone, at, complete = true) {
  if (!spec || !spec.zones.includes(zone)) return [];
  for (const r of lines) if (spec.zoneOf(r) === zone) return [];
  if (!knowable(lines, spec, zone, complete)) return [];
  const n = refillCount(spec);
  let g = 0;
  const used = () => { for (let k = 1; k <= n; k++) if (peek(padId(zone, g, k))) return true; return false; };
  while (used()) g += 1;
  return Array.from({ length: n }, (_, i) => ({ id: padId(zone, g, i + 1), set: spec.make(zone, i + 1, at) }));
}

/** Read the used pad generations of every zone off disk into the row store's memory (rows.prime), so peek sees pads that
 *  are tombstoned or live outside the loaded window. Call once after the rows are opened, before the editor's first refill. */
export async function primeRefill(rows, spec, { max = 64 } = {}) {
  const n = refillCount(spec);
  for (const zone of spec.zones) for (let g = 0; g < max; g++) {
    const ids = Array.from({ length: n }, (_, i) => padId(zone, g, i + 1));
    if (!(await rows.prime(ids))) break;
  }
}
