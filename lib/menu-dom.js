// The DOM end of the context menu (state: lib/menu-state.js, keys and placement: lib/menu.js, look: lib/menu.css). Output only: the menu
// drawn is a projection of `store.get().open` ({ id, x, y, ctx, items, active }); every hover, key and click is one absolute action
// (`menu.active`, `menu.close`) or, for an item, the close followed by the app's `onRun(item, ctx)`. role=menu with menuitem rows, keyboard
// by lib/menu.js menuKey (arrows, Home/End, Right and Enter open a submenu, Left and Escape close a level, a letter jumps), flipped to
// stay inside the viewport, closed by a press outside, the window losing focus, a resize, a wheel or a scroll outside it, and by any ⌘ ⌃ ⌥
// chord (which then goes on to the app). The editor keeps DOM focus: a press on the menu is cancelled (so it neither takes the caret nor the
// selection), and keys are read at the window's capture phase while a menu is open, so there is no second focus owner (law 6).
import { menuKey, placeMenu, placeSubmenu, isSelectable } from './menu.js';

/** mountMenu({ store, onRun, host }): store is a contextMenuDecl handle ({ get, dispatch, subscribe }); onRun(item, ctx) runs a chosen item
 *  (its `do` is the app's); host: where the panels go (default the document body). Returns { dispose, panels() }. */
export function mountMenu({ store, onRun, host = globalThis.document?.body, doc = host.ownerDocument }) {
  const W = doc.defaultView;
  let drawn = null, panels = [], listening = false;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const close = (id) => store.dispatch('menu.close', id ? { id } : {});

  function levelsOf(open) {
    const out = [{ list: open.items, depth: 0 }];
    for (let d = 0; d < open.active.length; d += 1) {
      const it = (out[d]?.list || [])[open.active[d]];
      if (it?.children?.length && isSelectable(it)) out.push({ list: it.children, depth: d + 1, parent: open.active[d] }); else break;
    }
    return out;
  }
  function build(open) {
    clear();
    const levels = levelsOf(open), vw = W.innerWidth, vh = W.innerHeight;
    levels.forEach((lv, d) => {
      const p = el('div', 'qk-menu'); p.setAttribute('role', 'menu'); p.setAttribute('data-qk-menu', String(d)); p.setAttribute('aria-label', d ? 'submenu' : 'context menu'); p.tabIndex = -1;
      p.style.visibility = 'hidden'; p.style.left = '0px'; p.style.top = '0px';
      const checks = lv.list.some((x) => typeof x.checked === 'boolean');
      lv.list.forEach((it, i) => {
        if (it.separator) { const s = el('div', 'qk-sep'); s.setAttribute('role', 'separator'); p.append(s); return; }
        const row = el('div', `qk-item${it.disabled ? ' off' : ''}${it.danger ? ' danger' : ''}${it.heading ? ' heading' : ''}${it.id.startsWith('lint.fix') ? ' sug' : ''}`);
        row.setAttribute('role', typeof it.checked === 'boolean' ? 'menuitemcheckbox' : 'menuitem'); row.id = `qk-mi-${open.id.slice(-8)}-${d}-${i}`; row.setAttribute('data-index', String(i)); row.setAttribute('data-id', it.id);
        if (it.disabled) row.setAttribute('aria-disabled', 'true');
        if (typeof it.checked === 'boolean') row.setAttribute('aria-checked', String(it.checked));
        if (it.children?.length) row.setAttribute('aria-haspopup', 'menu');
        if (it.hint) row.title = it.hint;
        if (checks) row.append(el('span', 'qk-check', it.checked ? '✓' : ''));
        row.append(el('span', 'qk-label', it.label));
        if (it.keys) row.append(el('span', 'qk-keys', it.keys));
        if (it.children?.length) row.append(el('span', 'qk-sub', '›'));
        p.append(row);
      });
      host.append(p); panels.push(p);
      const w = p.offsetWidth, h = p.offsetHeight;
      const pos = d === 0 ? placeMenu({ x: open.x, y: open.y, w, h, vw, vh }) : (() => { const row = panels[d - 1].querySelector(`[data-index="${lv.parent}"]`)?.getBoundingClientRect(); return row ? placeSubmenu({ row, w, h, vw, vh }) : { left: open.x, top: open.y }; })();
      p.style.left = `${pos.left}px`; p.style.top = `${pos.top}px`; p.style.visibility = '';
      p.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); }); // the press never takes the caret or the selection from the editor
      p.addEventListener('mousedown', (e) => e.preventDefault());
      p.addEventListener('contextmenu', (e) => e.preventDefault());
      p.addEventListener('pointermove', (e) => { const row = e.target.closest?.('.qk-item'); if (!row || row.classList.contains('heading')) return; hover(d, +row.dataset.index); });
      p.addEventListener('click', (e) => { const row = e.target.closest?.('.qk-item'); if (!row) return; const it = lv.list[+row.dataset.index]; if (!isSelectable(it)) return; if (it.children?.length) store.dispatch('menu.active', { id: open.id, active: [...store.get().open.active.slice(0, d), +row.dataset.index] }); else run(it); });
    });
    drawn = { id: open.id, depth: levels.length };
    listen(true);
  }
  function mark(open) {
    panels.forEach((p, d) => {
      let cur = null;
      for (const row of p.querySelectorAll('.qk-item')) { const on = open.active[d] === +row.dataset.index; row.classList.toggle('on', on); if (on) cur = row; }
      if (cur) p.setAttribute('aria-activedescendant', cur.id); else p.removeAttribute('aria-activedescendant');
    });
  }
  function hover(d, i) { const o = store.get().open; if (!o) return; const path = [...o.active.slice(0, d), i]; if (path.join() !== o.active.join()) store.dispatch('menu.active', { id: o.id, active: path }); }
  function run(item) { const o = store.get().open; if (!o) return; const ctx = o.ctx; close(o.id); onRun(item, ctx); }
  function clear() { for (const p of panels) p.remove(); panels = []; drawn = null; listen(false); }

  const onKey = (e) => {
    const o = store.get().open; if (!o || e.isComposing) return;
    if (e.metaKey || e.ctrlKey || e.altKey) { close(o.id); return; } // a chord closes the menu and goes on to the app
    const r = menuKey(o.items, o.active, e.key);
    if (!r) { if (e.key === 'Tab') { e.preventDefault(); close(o.id); } else if (e.key.length === 1) e.preventDefault(); return; } // typing never reaches the line under a menu
    e.preventDefault(); e.stopPropagation();
    if (r.close) close(o.id); else if (r.run) run(r.run); else if (r.active) store.dispatch('menu.active', { id: o.id, active: r.active });
  };
  const inside = (t) => panels.some((p) => p.contains(t));
  const onDown = (e) => { if (!inside(e.target)) close(store.get().open?.id); };
  const away = () => close(store.get().open?.id);
  const onScroll = (e) => { if (!inside(e.target)) away(); };
  function listen(on) {
    if (on === listening) return; listening = on;
    const f = on ? 'addEventListener' : 'removeEventListener';
    W[f]('keydown', onKey, true); W[f]('pointerdown', onDown, true); W[f]('blur', away); W[f]('resize', away);
    W[f]('wheel', onScroll, { capture: true, passive: true }); W[f]('scroll', onScroll, { capture: true, passive: true });
  }
  const off = store.subscribe((s) => {
    const o = s.open;
    if (!o) { if (drawn) clear(); return; }
    if (!drawn || drawn.id !== o.id || drawn.depth !== levelsOf(o).length) build(o);
    mark(o);
  });
  const o0 = store.get().open; if (o0) { build(o0); mark(o0); }
  return { panels: () => panels.slice(), dispose() { off(); clear(); } };
}
