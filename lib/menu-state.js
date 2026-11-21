// The state of the one open context menu, as plain data (The owner 2026-11-14 22:56 PST: "change the right click ctx menu to customize it for
// all avail actions"; model of the items: lib/menu.js, the DOM end: lib/menu-dom.js). The menu is kit state, not DOM: where it opened (x, y),
// what was right-clicked (`ctx`: the app's description of the target, plain strings and numbers), the items that were offered (plain data: an
// item carries `do`, a plain descriptor of what it does, never a function), and the highlighted path (`active`, the focused item). Every
// change is one absolute action through this reducer: `menu.open` (id minted by the opener, a repeat is the same menu), `menu.active`
// (the highlighted path of menu `id`; ignored once that menu is gone), `menu.close` (menu `id`, or whichever is open). scope ephemeral: a
// reload closes it. Running an item is not a state change of the menu: the DOM end closes the menu, then hands the item's `do` to the app.
import { declare } from './model.js';
import { field, on } from './schema.js';
import { registerGenerator } from './declare-keys.js';
import { isSelectable } from './menu.js';

const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
export const MAX_ITEMS = 40;
const json = (v, max) => { try { const s = JSON.stringify(v); return s && s.length <= max ? JSON.parse(s) : null; } catch { return null; } };

/** One menu item repaired, or null: { id, label, keys?, hint?, disabled?, checked?, danger?, do?, children? } or { separator: true }. */
export function cleanMenuItem(v, depth = 0) {
  const p = plain(v);
  if (p.separator === true) return { separator: true };
  const id = str(p.id, 80), label = str(p.label, 120);
  if (!id || !label) return null;
  const out = { id, label };
  if (typeof p.keys === 'string' && p.keys) out.keys = p.keys.slice(0, 24);
  if (typeof p.hint === 'string' && p.hint) out.hint = p.hint.slice(0, 160);
  if (p.disabled === true) out.disabled = true;
  if (typeof p.checked === 'boolean') out.checked = p.checked;
  if (p.danger === true) out.danger = true;
  if (p.heading === true) { out.heading = true; out.disabled = true; } // a line of text in the menu (a finding's message), never selectable
  if (p.do !== undefined) { const d = json(p.do, 800); if (d && typeof d === 'object') out.do = d; }
  if (depth < 1 && Array.isArray(p.children)) { const c = cleanMenuItems(p.children, depth + 1); if (c.length) out.children = c; }
  return out;
}
/** A list of items repaired: junk dropped, at most MAX_ITEMS, no separator at an end or twice in a row, ids unique within the list. */
export function cleanMenuItems(list, depth = 0) {
  const out = [], seen = new Set();
  for (const raw of Array.isArray(list) ? list.slice(0, MAX_ITEMS * 2) : []) {
    const it = cleanMenuItem(raw, depth); if (!it) continue;
    if (it.separator) { if (out.length && !out[out.length - 1].separator) out.push(it); continue; }
    if (seen.has(it.id)) continue; seen.add(it.id); out.push(it);
    if (out.length >= MAX_ITEMS) break;
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}
const cleanCtx = (c) => { const o = json(c, 1200); return o && typeof o === 'object' && !Array.isArray(o) && typeof o.kind === 'string' ? o : null; };
const cleanPath = (a, items) => {
  if (!Array.isArray(a) || a.length > 2 || !a.every((i) => Number.isInteger(i) && i >= 0)) return null;
  if (!a.length) return [];
  const top = items[a[0]]; if (!isSelectable(top)) return null;
  return a.length === 1 || isSelectable(top.children?.[a[1]]) ? a : null;
};
const cleanOpen = (o) => {
  const p = plain(o), ctx = cleanCtx(p.ctx), x = Number(p.x), y = Number(p.y), id = str(p.id, 64);
  if (!id || !ctx || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const items = cleanMenuItems(p.items); if (!items.some(isSelectable)) return null; // a menu with nothing in it to do is not opened
  return { id, x: Math.round(x), y: Math.round(y), ctx, items, active: cleanPath(p.active, items) ?? [] };
};

/** The declaration: `open` is null or { id, x, y, ctx, items, active }. */
export const contextMenuDecl = (name) => {
  const d = declare({
    name, scope: 'ephemeral',
    fields: { open: field(null, cleanOpen) },
    actions: {
      'menu.open': on('open', (cur, p) => { const next = cleanOpen({ ...plain(p), active: [] }); if (!next) return cur; return cur && cur.id === next.id ? cur : next; }),
      'menu.active': on('open', (cur, { id, active } = {}) => { if (!cur || cur.id !== id) return cur; const a = cleanPath(active, cur.items); return !a || a.join() === cur.active.join() ? cur : { ...cur, active: a }; }),
      'menu.close': on('open', (cur, { id } = {}) => (cur && (id === undefined || id === null || cur.id === id) ? null : cur)),
    },
  });
  registerGenerator(name, (r) => {
    const k = r.int(0, 3), id = r.pick(['m1', 'm2']);
    const items = [{ id: 'a', label: 'Cut', keys: '⌘X', do: { clip: 'cut' } }, { separator: true }, { id: 'b', label: 'Copy', disabled: true }, { id: 'c', label: 'Format', children: [{ id: 'c1', label: 'Bold', do: { key: 'mod+b' } }, { id: 'c2', label: 'Italic' }] }];
    if (k === 0) return ['menu.open', r.chance(0.85) ? { id, x: r.int(0, 800), y: r.int(0, 600), ctx: { kind: 'text', row: 'l1', off: r.int(0, 9) }, items: r.chance(0.9) ? items : r.pick([[], [{ separator: true }], null]) } : { id, x: 'a' }];
    if (k === 1) return ['menu.active', { id, active: r.pick([[0], [2], [3, 0], [3, 1], [9], [-1], 'x', []]) }];
    return ['menu.close', r.chance(0.5) ? { id } : {}];
  });
  return d;
};
