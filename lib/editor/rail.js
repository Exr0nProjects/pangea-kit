// A side rail of recent items (a stream of notes, highlights, results) beside an editor: its state, as a kit declaration, and the pure
// helpers a rail needs. Ported from old zai's NotesStream.svelte / core/notes-stream.js ("a stream of recent notes / transclude them into the
// notes app", the owner 2026-10-04 17:19 PDT) as kit state (PANGEA3-DESIGN section 15 law 1: nothing only in the DOM).
//
// railDecl(name) declares the rail's state (scope local; `open` persists across reloads, the list is session state read from the server):
//   open     the rail is shown
//   items    the newest-first list the server last answered, replaced whole by every answer (a deleted item leaves; one edited moves up)
//   limit    the limit the last answer was fetched with; more: the list was full, so there is probably another page ("more" asks for a bigger
//            limit, which is all the endpoint offers); status: 'idle' | 'loading' | 'ready' | 'error'; err: the failure's words
//   at       the wall time of the last answer (a display hint)
// Every action is absolute: rail.open {on}, rail.loading {}, rail.loaded {items, limit, more, at}, rail.failed {err}.
import { declare } from '../model.js';
import { field, scratch } from '../schema.js';
import { registerGenerator } from '../declare-keys.js';

export const MAX_ITEMS = 500;
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
/** An item as the rail keeps it: { id, text, note, title, kind, color, href, at }. Junk (no id) is dropped by cleanItems. */
export function cleanItem(x) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !x.id || x.id.length > 120) return null;
  const at = Number(x.at);
  return { id: x.id, text: str(x.text, 2000), note: str(x.note, 4000), title: str(x.title, 200), kind: x.kind === 'chat' ? 'chat' : 'book', color: str(x.color, 16), href: /^https?:\/\//.test(str(x.href, 600)) ? str(x.href, 600) : '', at: Number.isFinite(at) ? at : 0 };
}
export const cleanItems = (list) => (Array.isArray(list) ? list.map(cleanItem).filter(Boolean).slice(0, MAX_ITEMS) : []);

// the same state by value is the same state (an absolute action applied twice changes nothing)
const same = (a, b) => (JSON.stringify(a) === JSON.stringify(b) ? a : b);

export const railDecl = (name) => {
  const d = declare({
    name, scope: 'local',
    fields: {
      open: field(false, Boolean),
      items: scratch([]),
      limit: scratch(0),
      more: scratch(false),
      status: scratch('idle'),
      err: scratch(null),
      at: scratch(0),
    },
    actions: {
      'rail.open': (s, { on } = {}) => (typeof on === 'boolean' && s.open !== on ? { ...s, open: on } : s),
      'rail.loading': (s) => (s.status === 'loading' ? s : { ...s, status: 'loading' }),
      'rail.loaded': (s, p = {}) => {
        const items = cleanItems(p.items), limit = Number.isInteger(p.limit) && p.limit > 0 ? Math.min(p.limit, MAX_ITEMS) : s.limit;
        return same(s, { ...s, items, limit, more: p.more === true, status: 'ready', err: null, at: Number.isFinite(p.at) ? p.at : s.at });
      },
      'rail.failed': (s, p = {}) => same(s, { ...s, status: 'error', err: str(p.err, 160) || 'could not load' }),
    },
  });
  registerGenerator(name, (r) => {
    const k = r.int(0, 5), item = () => ({ id: r.pick(['a', 'b', 'c', '']), text: r.pick(['quote one', '', 'x'.repeat(30)]), title: 'Book', kind: r.pick(['book', 'chat', 'x']), href: r.pick(['https://x.test/r', 'javascript:1', '']), at: r.int(0, 9e12) });
    if (k === 0) return ['rail.open', { on: r.pick([true, false, 'yes']) }];
    if (k === 1) return ['rail.loading', {}];
    if (k === 2) return ['rail.loaded', { items: r.chance(0.1) ? 'x' : Array.from({ length: r.int(0, 4) }, item), limit: r.pick([20, 40, 0, -1, 1.5]), more: r.chance(0.5), at: r.int(0, 9e12) }];
    if (k === 3) return ['rail.failed', { err: r.pick(['offline', '', 5]) }];
    return ['rail.loaded', { items: [item(), item()], limit: 20, more: true }];
  });
  return d;
};

/** "3m", "2h", "5d", "Mar 4": the ago column (now is passed in, never read). */
export function shortAgo(at, now) {
  if (!Number.isFinite(at) || !at) return '';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Whitespace collapsed: a quote is one row of the document, never a paragraph of it. */
export const oneLine = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

/** The ids of the rail items already written into a document: one whose backlink (`href` carrying `note=<id>`, which nothing routes on: it is the mark
 *  that says this block came from that note) is in the document's text. texts: the live rows' text. */
export function writtenIds(texts, items) {
  const have = new Set(), joined = texts.join('\n');
  for (const it of items) if (it.href && joined.includes(`note=${encodeURIComponent(it.id)}`)) have.add(it.id);
  return have;
}
