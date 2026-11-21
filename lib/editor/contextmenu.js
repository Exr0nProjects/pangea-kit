// The editor's own right-click menu (PANGEA3-DESIGN §15 "Context menu"; the owner 2026-11-14 22:56 PST: "change the right click ctx menu to
// customize it for all avail actions"). One listener on the editor's root replaces the browser's menu with the kit's (lib/menu-state.js state,
// lib/menu-dom.js drawing, lib/editor/commands.js items): what was right-clicked becomes `ctx` (the line, the offset, the finding under the
// pointer, whether there is a selection), the items are computed from the editor's own chord registry and the finding, and the open menu is
// kit state (`menu.open`). Choosing an item runs its `do`: a chord is ONE `key` action through the reducer, a suggestion is ONE `input`
// (insertReplacementText) over the finding's characters, so it is a text edit that ⌘Z undoes; cut and copy go through the editor's own clipboard
// handlers; paste reads the clipboard and is one `insertFromPaste` input (as the touch bar's). Escape hatches the browser keeps: Shift or Alt
// held, a touch long-press, a press with a text composition running, and a right-click inside an embedded editor that has no menu of its own.
// The caret before the menu opens is decided here, not by the browser's timing: a press outside the selection puts the caret at the point (one
// absolute `select`), a press inside a selection keeps it, so Cut, Copy and the formatting act on what the person sees selected.
import { ulid } from '../engine/ulid.js';
import { fixAction } from './lint.js';
import { editorMenuItems } from './commands.js';

/** mountEditorMenu({ id, editor, app, menu, prefs, view, lint, dict, extras, flags, onApp }) -> { run, dispose }.
 *  menu: the contextMenuDecl store; prefs/view: the lint stores (optional); lint: the mountLint handle (optional: no findings section without it);
 *  dict: { add(word) } (optional: no "Add to dictionary" without it); extras(ctx) -> { top, actions } the app's own items; flags() -> { readOnly, suggesting,
 *  blocked, mac }; onApp(do, ctx): an `{ app }` item. `id` names this editor in the menu's ctx (`ctx.ed`), so one menu
 *  mounted for the page can hand a chosen item to the editor that opened it. */
export function mountEditorMenu({ id = 'ed', editor, app, menu, prefs = null, view = null, lint = null, dict = null, extras = () => ({}), flags = () => ({}), onApp = () => {}, readText = null }) {
  const root = editor.root, doc = root.ownerDocument, W = doc.defaultView;
  const order = () => { const m = new Map(); editor.items.forEach((it, i) => { if (it.addr != null) m.set(it.addr, i); }); return m; };
  const before = (m, p, q) => { const i = m.get(p.id), j = m.get(q.id); return i < j || (i === j && p.off <= q.off); };
  /** Is point `a` inside the (non-collapsed) selection? */
  function inSelection(a) {
    const s = editor.state.sel; if (!s || !a || (s.a.id === s.f.id && s.a.off === s.f.off)) return false;
    const m = order(); if (!m.has(a.id) || !m.has(s.a.id) || !m.has(s.f.id)) return false;
    const [lo, hi] = before(m, s.a, s.f) ? [s.a, s.f] : [s.f, s.a];
    return before(m, lo, a) && before(m, a, hi);
  }
  const nested = (el) => { const b = el?.closest?.('[data-qk-embed-body]'); return Boolean(b) && b !== root && root.contains(b); };

  function onContext(e) {
    if (e.shiftKey || e.altKey || e.pointerType === 'touch' || editor.state.composing || nested(e.target)) return; // the browser's menu stays
    if (!root.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    const a = editor.addrAtPoint(e.clientX, e.clientY);
    if (a && !inSelection(a)) editor.dispatch({ type: 'select', sel: { a: { ...a }, f: { ...a } }, reveal: false }, { ts: e.timeStamp });
    const s = editor.state.sel, hasSel = Boolean(s && !(s.a.id === s.f.id && s.a.off === s.f.off));
    const hit = a && lint && (!prefs || prefs.get().on) ? lint.at(e.clientX, e.clientY) : null, item = hit?.item ?? null;
    if (view) view.dispatch('lint.hover', item ? { id: hit.id, from: item.from, to: item.to, cls: item.cls } : null); // the menu's target is the one painted: a click on plain text paints nothing
    const ctx = { kind: 'text', ed: id, row: a?.id ?? null, off: a?.off ?? null, hasSel, readOnly: Boolean(editor.readOnly), lint: item ? { from: item.from, to: item.to, cls: item.cls, key: item.key, word: item.word, msg: item.msg, sug: item.sug } : null };
    const f = flags();
    const items = editorMenuItems(app, ctx, { ...f, readOnly: Boolean(f.readOnly ?? editor.readOnly), checking: prefs ? prefs.get().on : null, canDict: Boolean(dict) }, extras(ctx) || {});
    menu.dispatch('menu.open', { id: ulid(), x: e.clientX, y: e.clientY, ctx, items });
  }
  root.addEventListener('contextmenu', onContext);
  // when the menu this editor opened closes, the painted finding is whatever the pointer is over now (the menu held it; nothing may stay painted away from the pointer)
  let mine = false;
  const offMenu = menu.subscribe((s) => { const was = mine; mine = s.open?.ctx?.ed === id; if (was && !mine) lint?.refresh?.(); });

  /** Run a chosen item (the menu has already closed). */
  async function run(item, ctx) {
    const d = item?.do; if (!d || typeof d !== 'object') return;
    if (typeof d.lint === 'string' || typeof d.app === 'string' || d.clip) return runOther(d, ctx);
    if (typeof d.key === 'string') { editor.dispatch({ type: 'key', name: d.key }); return; }
    if (d.action && typeof d.action === 'object' && typeof d.action.type === 'string') { editor.dispatch({ ...d.action }); return; }
  }
  async function runOther(d, ctx) {
    if (d.clip === 'copy' || d.clip === 'cut') { doc.execCommand(d.clip); return; } // the editor's own copy and cut handlers read the state selection
    if (d.clip === 'paste') {
      try {
        const text = await (readText ? readText() : W.navigator.clipboard.readText()), s = editor.state.sel;
        if (text && s) editor.dispatch({ type: 'input', inputType: 'insertFromPaste', text, sel: s });
      } catch { onApp({ app: 'note', text: 'paste with the keyboard: the browser did not allow reading the clipboard' }, ctx); }
      return;
    }
    if (d.lint === 'fix') {
      // the words must still be exactly where the finding was seen (an edit since then: nothing is replaced in the wrong place)
      const text = editor.rowText(d.row);
      if (typeof text !== 'string' || text.slice(d.from, d.to) !== d.word) return;
      const a = fixAction(d.row, { from: d.from, to: d.to }, d.text); if (a) editor.dispatch(a);
      return;
    }
    if (d.lint === 'ignore' && prefs) { prefs.dispatch('lint.ignore', { key: d.key }); view?.dispatch('lint.hover', null); return; }
    if (d.lint === 'dict' && dict) { dict.add(d.word); view?.dispatch('lint.hover', null); return; }
    if (d.lint === 'toggle' && prefs) { prefs.dispatch('lint.on', { on: d.on === true }); view?.dispatch('lint.hover', null); return; }
    if (typeof d.app === 'string') onApp(d, ctx);
  }
  return { run, dispose() { root.removeEventListener('contextmenu', onContext); offMenu?.(); } };
}
