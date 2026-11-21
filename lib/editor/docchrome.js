// The chrome of a document editor, Google Docs style (The owner 2026-11-12 11:00 PST: "document outline sidebar, document tabs, all
// gated behind a floating hamburger top left that appears on hover"): the outline of headings, the document tabs, and the
// declaration of the state that drives them. Pure and DOM-free, so the same functions run in the browser, the Worker and
// the tests (A4); the app draws, the kit decides.
//
// TABS are rows of the document itself, not a second document: a tab is the row `tab:<id>` (kind 'tab', its title in `body`,
// `ord` its place among the tabs, `deleted_at` its tombstone) and a line belongs to the tab named in its `tab` field (absent =
// the main tab). A row of kind 'tab' has no `zone`, so no live-row index carries it and no editor, find, select-all or
// refill ever sees it: the document view of the active tab is a filtered view (`tabDoc`) over the same row store, so one
// stream, one op log, one history, one set of comments and one share carry every tab, and a tab made offline is delivered
// like any other row. Nothing is copied or moved between streams; per-field LWW over the tab row and the line rows merges
// two devices adding tabs at once (ids are minted per action, A7) and renaming one concurrently (the later stamp wins).
//
// STATE (`docChromeDecl`): the sidebar mode, the active tab, the folded outline headings, the format popover, the history
// selection, the editing mode. Every action is absolute (set this), idempotent, total; a toggle is a gesture the app resolves
// against what the user saw before dispatching (A6). What must survive a reload (sidebar, active tab, folds, mode) is a
// persisted field; the popover and the history selection are `scratch` (session only, never saved).
import { declare } from '../model.js';
import { field, scratch, on, set } from '../schema.js';
import { registerGenerator } from '../declare-keys.js';

export const MAIN_TAB = 'main';
export const TAB_ROW = 'tab:';
export const TAB_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const SIDE_MODES = Object.freeze([null, 'nav', 'history']);
export const EDIT_MODES = Object.freeze(['editing', 'suggesting']);
export const FORMAT_PANELS = Object.freeze([null, 'text', 'font', 'color', 'bg']);
export const MAIN_TITLE = 'Tab 1';

// ------------------------------------------------------------------------------------------------------------- outline
/** The headings of a list of lines: [{ id, level (1-6), text, index }], in order. `headingOf(row) -> { level, text } | null`
 *  is the app's reading of a row (zai: a line that starts with `# `). Blank headings are skipped. Pure. */
export function outlineOf(lines, headingOf) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const h = headingOf(lines[i]);
    if (!h || !String(h.text ?? '').trim()) continue;
    out.push({ id: lines[i].id, level: Math.max(1, Math.min(6, h.level | 0 || 1)), text: String(h.text).trim().slice(0, 200), index: i });
  }
  return out;
}

/** The outline as the sidebar shows it: a heading under a folded heading of a lower level is hidden; each entry says whether it
 *  has children and whether it is shut. `shut`: { id: true } (the persisted folds). Pure. */
export function outlineView(entries, shut = {}) {
  const out = []; let hideBelow = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (hideBelow !== null && e.level > hideBelow) continue;
    hideBelow = null;
    const child = entries[i + 1] && entries[i + 1].level > e.level;
    out.push({ ...e, child: Boolean(child), shut: Boolean(child && shut[e.id]) });
    if (child && shut[e.id]) hideBelow = e.level;
  }
  return out;
}

/** The heading the caret is in: the last entry at or before the caret's line index (null before the first). */
export const currentHeading = (entries, lineIndex) => { let cur = null; for (const e of entries) { if (e.index <= lineIndex) cur = e; else break; } return cur; };

// ---------------------------------------------------------------------------------------------------------------- tabs
export const tabOf = (row) => (row && typeof row.tab === 'string' && TAB_ID.test(row.tab) ? row.tab : MAIN_TAB);
export const isTabRow = (row) => row?.kind === 'tab' && typeof row.id === 'string' && row.id.startsWith(TAB_ROW);
export const tabRowId = (id) => `${TAB_ROW}${id}`;

/** The tabs of a document, in order: the main tab (always there; its title is the row `tab:main` when someone renamed it) and
 *  every live tab row by `ord` then id. rows: every row of the store (tombstones included are ignored). [{ id, title, ord }]. */
export function tabsOf(rows) {
  const out = [{ id: MAIN_TAB, title: MAIN_TITLE, ord: 0 }];
  const extra = [];
  for (const r of rows || []) {
    if (!isTabRow(r) || r.deleted_at) continue;
    const id = r.id.slice(TAB_ROW.length);
    if (!TAB_ID.test(id)) continue;
    const title = String(r.body ?? '').trim().slice(0, 120);
    if (id === MAIN_TAB) { out[0].title = title || MAIN_TITLE; continue; }
    extra.push({ id, title: title || 'Untitled tab', ord: Number.isFinite(r.ord) ? r.ord : 0 });
  }
  extra.sort((a, b) => a.ord - b.ord || (a.id < b.id ? -1 : 1));
  return out.concat(extra);
}

/** The puts that add a tab after `tabs` (ids come from the action, never from randomness here): the tab row and nothing else,
 *  its lines are made on first use (the refill sentinel gives it two blank rows). `at` is the action's time. */
export function addTabPuts(tabs, id, title, at) {
  if (!TAB_ID.test(id) || tabs.some((t) => t.id === id)) return [];
  const iso = new Date(at).toISOString(), last = tabs[tabs.length - 1];
  return [{ id: tabRowId(id), set: { kind: 'tab', body: String(title || 'Untitled tab').slice(0, 120), ord: (last?.ord ?? 0) + 1, created_at: iso, updated_at: iso, deleted_at: null } }];
}
/** Rename: an absolute write of the title. */
export const renameTabPuts = (id, title, at) => (TAB_ID.test(id) ? [{ id: tabRowId(id), set: { kind: 'tab', body: String(title ?? '').trim().slice(0, 120), updated_at: new Date(at).toISOString(), ...(id === MAIN_TAB ? { created_at: new Date(at).toISOString(), deleted_at: null } : {}) } }] : []);
/** Delete a tab: its row and every live line of it get a tombstone (a restorable, mergeable delete; the main tab cannot be deleted). */
export function deleteTabPuts(rows, id, at) {
  if (!TAB_ID.test(id) || id === MAIN_TAB) return [];
  const iso = new Date(at).toISOString(), puts = [{ id: tabRowId(id), set: { deleted_at: iso, updated_at: iso } }];
  for (const r of rows || []) if (!isTabRow(r) && !r.deleted_at && typeof r.zone === 'string' && tabOf(r) === id) puts.push({ id: r.id, set: { deleted_at: iso, updated_at: iso } });
  return puts;
}

/** A view of a doc (kit editor doc: lines/get/peek/put/...) restricted to the lines of one tab. `active()` is read at every
 *  call, so a tab switch is one state change plus one editor refresh. A line made while a tab is open is stamped with it (a row
 *  that does not exist yet and carries `created_at`), so the refill sentinel's pads and every new line land in the tab. */
export function tabDoc(doc, active) {
  const mine = (r) => tabOf(r) === active();
  // every other property (get, peek, loadOlder, atStart, reachedStart ...) is the wrapped doc's, inherited, getters included (as structure.js viewDoc)
  return Object.create(doc, {
    lines: { value: () => doc.lines().filter(mine) },
    put: {
      value(puts, o) {
        const t = active();
        const stamped = t === MAIN_TAB ? puts : puts.map((p) => (p?.set && p.set.created_at !== undefined && !('tab' in p.set) && !(doc.peek ? doc.peek(p.id) : doc.get(p.id)) ? { ...p, set: { ...p.set, tab: t } } : p));
        return doc.put(stamped, o);
      },
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------- state
const str = (v) => (typeof v === 'string' ? v : '');
const cleanShut = (v) => Object.fromEntries(Object.entries(v && typeof v === 'object' && !Array.isArray(v) ? v : {}).filter(([k, x]) => typeof k === 'string' && k.length <= 64 && x === true).slice(-500));
const oneOf = (list, dflt) => (v) => (list.includes(v) ? v : dflt);

/** The chrome's state for one document (`name` is per document: `zai3-docs-ui:<doc id>`). Persisted: side (null | 'nav' | 'history'),
 *  tab (the active tab id), shut (folded outline headings), mode (editing | suggesting), named (history lists named
 *  versions only), marks (history highlights changes). Session only: fmt (the format popover: null | 'text' | 'font' | 'color' |
 *  'bg'), pick (the version shown in the history preview), menu (the tab's own menu), log (the history's read of the stream). */
export const docChromeDecl = (name) => {
  const d = declare({
    name, scope: 'local',
    fields: {
      side: field(null, oneOf(SIDE_MODES, null)),
      tab: field(MAIN_TAB, (v) => (TAB_ID.test(str(v)) ? v : MAIN_TAB)),
      shut: field({}, cleanShut),
      mode: field('editing', oneOf(EDIT_MODES, 'editing')),
      named: field(false, Boolean),
      marks: field(true, (v) => v !== false),
      fmt: scratch(null),
      pick: scratch(null),
      menu: scratch(null),
      log: scratch(null),
    },
    actions: {
      'side.set': set('side', 'mode'),
      'tab.open': set('tab', 'id'),
      'outline.fold': on('shut', (s, { id, on: shut } = {}) => {
        if (typeof id !== 'string' || !id || id.length > 64) return s;
        if (shut === true) return s[id] ? s : { ...s, [id]: true };
        if (!s[id]) return s;
        const { [id]: _gone, ...rest } = s; return rest;
      }),
      'mode.set': set('mode', 'mode'),
      'hist.named': set('named', 'on'),
      'hist.marks': set('marks', 'on'),
      'fmt.set': on('fmt', (_, { panel } = {}) => (FORMAT_PANELS.includes(panel) ? panel : null)),
      'hist.pick': on('pick', (_, { key } = {}) => (typeof key === 'string' && key && key.length <= 80 ? key : null)),
      // the history panel's read of the stream (session only): { status: 'loading' | 'ready' | 'error', n (entries read), err }
      'hist.load': on('log', (_, p = {}) => (['loading', 'ready', 'error'].includes(p.status) ? { status: p.status, n: Math.max(0, Math.floor(Number(p.n) || 0)), err: typeof p.err === 'string' ? p.err.slice(0, 120) : null } : null)),
      'menu.set': on('menu', (_, { id } = {}) => (typeof id === 'string' && TAB_ID.test(id) ? id : null)),
    },
  });
  registerGenerator(name, (r) => {
    const k = r.int(0, 9), id = r.pick(['main', 'a1', 'b2', 'c3']);
    if (k === 0) return ['side.set', { mode: r.pick([null, 'nav', 'history', 'bogus']) }];
    if (k === 1) return ['tab.open', { id: r.pick([id, 'Bad Id', 7]) }];
    if (k === 2) return ['outline.fold', { id: r.pick(['h1', 'h2', 'h3', '']), on: r.chance(0.5) }];
    if (k === 3) return ['mode.set', { mode: r.pick(['editing', 'suggesting', 'viewing', 'x']) }];
    if (k === 4) return ['hist.named', { on: r.chance(0.5) }];
    if (k === 5) return ['hist.marks', { on: r.chance(0.5) }];
    if (k === 6) return ['fmt.set', { panel: r.pick([null, 'text', 'font', 'color', 'bg', 'x']) }];
    if (k === 7) return ['hist.pick', { key: r.pick(['cur', 's1', '', null]) }];
    if (k === 8) return ['hist.load', r.pick([{ status: 'loading', n: 3 }, { status: 'ready', n: 9 }, { status: 'error', err: 'offline' }, { status: 'bogus' }])];
    return ['menu.set', { id: r.pick([id, null, 'Bad']) }];
  });
  return d;
};
