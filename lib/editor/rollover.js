// The day rollover: one absolute action, { type: 'day.roll', boundary }, driven by a clock tick (The owner 2026-11-12 18:55 and
// 19:01 PST: a line from 10:47 pm "should've been auto-archived at the day rollover (4am)"; "a simple state extension based on
// clock / timer"). A day starts at `hour` (4) local time in the OWNER's zone. The action names the instant to roll to:
// `boundary`, epoch ms of a day start that has already passed. Applied to the rows it meets, it moves every live row of the
// `from` zone that was last touched before `boundary` to the end of the `to` zone, in the order it had, and writes nothing else.
//
// The contract declares `rollover: { from, to, zoneOf, hour?, touched?, blank? }`:
//   from, to  zone keys (NOW, Past)
//   zoneOf    (row) -> zone key
//   touched   (row) -> epoch ms of the row's last write (default: later of updated_at and created_at; none = always old)
//   blank     (row) -> true for a row that is only space (default: no words, or a page break). Blank rows stay: the blank
//             line he types on is not yesterday's writing, and a placeholder (a refill pad) must keep its zone clickable.
// Pure and total over the rows it is given, so every replica applying it to the same rows writes the same puts: a row already
// in `to` is not selected again (idempotent by value), a row written at or after `boundary` stays (an edit after the boundary
// is today's), two devices that roll at once write identical zone and ord (merge by id), a missed day is caught up by the
// next tick (only the latest boundary matters: everything older than it moves, in its row order), and undo is the app's
// history of these puts. A boundary after `at` or a junk payload is a no-op.
export const ROLLOVER_KEYS = ['from', 'to', 'zoneOf', 'hour', 'touched', 'blank'];
export const DAY_HOUR = 4;

export function checkRollover(spec, name = 'contract') {
  if (spec == null) return null;
  if (typeof spec !== 'object' || typeof spec.from !== 'string' || typeof spec.to !== 'string' || spec.from === spec.to || typeof spec.zoneOf !== 'function') throw new Error(`${name}: rollover needs from, to (two zone keys) and zoneOf(row)`);
  for (const k of Object.keys(spec)) if (!ROLLOVER_KEYS.includes(k)) throw new Error(`${name}: unknown rollover key "${k}" (${ROLLOVER_KEYS.join(', ')})`);
  if (spec.hour != null && !(Number.isInteger(spec.hour) && spec.hour >= 0 && spec.hour <= 12)) throw new Error(`${name}: rollover.hour is an integer 0..12`);
  return spec;
}

const stampMs = (v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : -Infinity; };
export const touchedMs = (r) => Math.max(stampMs(r.updated_at), stampMs(r.created_at));
export const isBlank = (r) => r.kind === 'break' || !String(r.body ?? '').trim();

/** The rows { type: 'day.roll', boundary } would move out of `from`, whether or not the end of `to` is loaded yet. */
export function rollRows(lines, spec, boundary, at) {
  if (!spec || !Number.isFinite(boundary) || !Number.isFinite(at) || boundary > at) return [];
  const touched = spec.touched || touchedMs, blank = spec.blank || isBlank;
  return lines.filter((r) => spec.zoneOf(r) === spec.from && !blank(r) && touched(r) < boundary);
}

/** The puts of the action against `lines` (the doc's loaded live rows, in order) at time `at`. complete: whether the doc
 *  holds every row; with no `to` row loaded and the doc paged, the end of `to` is unknown and nothing moves yet (the caller
 *  loads older rows first). */
export function rollPuts(lines, spec, boundary, at, complete = true) {
  const move = rollRows(lines, spec, boundary, at);
  if (!move.length) return [];
  let tail = 0, seen = false;
  for (const r of lines) if (spec.zoneOf(r) === spec.to) { seen = true; if (Number.isFinite(r.ord) && (!tail || r.ord > tail)) tail = r.ord; }
  if (!seen && !complete) return [];
  return move.map((r, k) => ({ id: r.id, set: { zone: spec.to, ord: tail + 1 + k } }));
}

// ------------------------------------------------------------------ the clock: a day starts at `hour` local time in `tz`
const dtf = new Map();
function parts(ms, tz) {
  let f = dtf.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); dtf.set(tz, f); }
  const o = {}; for (const p of f.formatToParts(ms)) o[p.type] = Number(p.value);
  return o;
}
const wallMs = (p) => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
const offsetMs = (ms, tz) => wallMs(parts(ms, tz)) - Math.floor(ms / 1000) * 1000;
/** The day `ms` belongs to in `tz`: its local date, or the day before while the local time is before `hour`. 'YYYY-MM-DD'. */
export function dayKey(ms, tz, hour = DAY_HOUR) {
  const p = parts(ms, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day - (p.hour < hour ? 1 : 0))).toISOString().slice(0, 10);
}
/** The instant a day starts: `hour`:00 local time on `day` in `tz` (a wall time that does not exist, a spring-forward gap,
 *  is the first instant after it). */
export function boundaryMs(day, tz, hour = DAY_HOUR) {
  const [y, m, d] = day.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour);
  let t = wall - offsetMs(wall, tz);
  for (let i = 0; i < 3; i++) t = wall - offsetMs(t, tz);
  if (wallMs(parts(t, tz)) !== wall) t = Math.max(wall - offsetMs(wall - 864e5, tz), wall - offsetMs(wall + 864e5, tz));
  return t;
}
/** The start of the day `ms` is in. */
export const dayStart = (ms, tz, hour = DAY_HOUR) => boundaryMs(dayKey(ms, tz, hour), tz, hour);
export const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** The tick: when the app opens, gains focus, or a minute passes (which also catches a sleep that ran past 4 am), roll what
 *  the latest day start left behind. `ready()` holds it back until the rows are in, `tz()` is the owner's zone, `prepare()`
 *  loads older rows so the end of Past is known. `every` is the kit's owned timer (lib/timers.js). Returns a stop function. */
export function startDayClock({ editor, spec, tz, ready = () => true, prepare = async () => {}, clock = () => Date.now(), win = globalThis, every }) {
  let busy = false;
  const tick = async () => {
    if (busy || !ready()) return;
    const now = clock(), zone = tz(), hour = spec.hour ?? DAY_HOUR, b = dayStart(now, zone, hour);
    if (!editor.rollPending(b)) return;
    busy = true;
    try { await prepare(); editor.dispatch({ type: 'day.roll', boundary: b, day: dayKey(now, zone, hour) }); } finally { busy = false; }
  };
  const onVis = () => { if (win.document?.visibilityState !== 'hidden') tick(); };
  win.addEventListener?.('focus', tick); win.document?.addEventListener?.('visibilitychange', onVis);
  const stop = every('day-clock', 60_000, tick, { budgetMs: 50 });
  tick();
  return () => { stop(); win.removeEventListener?.('focus', tick); win.document?.removeEventListener?.('visibilitychange', onVis); };
}
