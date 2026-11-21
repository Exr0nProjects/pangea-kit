// Embeds: another document's live text drawn inline in a host editor, editable in place (PANGEA3-DESIGN §15 "Embeds: live
// transclusion"). The owner 2026-11-11 21:57 PST: "a thin rectangle aronud the text, but the text should still appear and i want
// to be able to edit it within zai direclty. resizable text area like native html style"; 21:58: "the header should have the
// doc name, a collapse button, expand which opens it as a modal ..., and then a open-link button".
//
// Shape: the app's items() puts ONE inert item after the row that holds the chip, { key: 'emb:<row id>', embed: { id, title,
// h, collapsed, status, href } }, and renders it with embedSlot(spec): the rectangle (a header and an empty body). The body is
// owned by a SECOND kit editor over the embedded document, mounted here; the host's render map never sees it (editor.js
// lineOf/on/domSel skip a `[data-qk-embed-body]` below the root). This module is that mounting:
//   createEmbeds({ resolve, margin, maxLive, depth, chain }) -> manager; pass it to createEditor({ embeds }); createEditor
//   calls manager.attach(editor) once and manager.sync() after every commit.
//   resolve({ key, spec, chain, depth, modal, onEdge, leave }) -> Promise<{ mount(body) -> { dispose, focus(at) } } | { placeholder }>
//     the app's: opens the doc's session by the role the server gives, says locked/deleted/cycle by placeholder, and mounts
//     createEditor over `body`, with { embeds: createEmbeds({ ..., depth: depth + 1, chain: [...chain, spec.id] }), onEdge }.
// What this module owns (kit state, never DOM-only): which slots are live (a slot is live only within `margin` viewports of the
// scroll position, at most `maxLive` at once), the resize grip (2026-11-12: a kit-owned full-width strip below the body, NOT the
// browser's native `resize` corner, which sat on the inner scrollbar: a pointer drag is `embed {op:'drag', key, h}` actions, state
// `embedDrag`, painted by `paint()` inside the host commit, and ONE absolute `embed {op:'resize', key, h}` on release), fit
// (`embed {op:'fit', key, on}`: the whole doc in flow, no inner scroll; persisted in the chip as `|fit`), the fullscreen lightbox
// (state.modal; Esc and the close button dispatch `embed {op:'modal', key: null}`), and the focus mirror (`embed {op:'focus', key}`).
// Collapse is `embed {op:'collapse', key, on}`, absolute: the header click is a gesture resolved against state.embeds[key].collapsed
// in the editor's dispatch; fit the same against the chip's own `fit`.

import { inlineTitle } from '../inline-title.js';

export const MIN_H = 72, MAX_H = 2000, MAX_DEPTH = 3, HEADER_H = 24, DEFAULT_H = 240;
/** A height the chip may hold: whole px in [MIN_H, MAX_H]. */
export const clampH = (h) => (Number.isFinite(h) ? Math.max(MIN_H, Math.min(MAX_H, Math.round(h))) : null);

/** May doc `id` be drawn inside the chain of docs above it (chain: ids from the outermost doc down to the one that holds the
 *  chip) at `depth` embedding levels (0: an embed in the page's own document; the page itself is not a level)? Not when it is one of
 *  the chain (a cycle: a doc inside itself, A in B in A) or when it would be a fourth level (depth >= maxDepth). Pure.
 *  -> { ok: true } | { ok: false, placeholder: 'cycle' | 'deep' } */
export function embedPlan(chain, id, maxDepth = MAX_DEPTH, depth = chain.length) {
  if (chain.includes(id)) return { ok: false, placeholder: 'cycle' };
  if (depth >= maxDepth) return { ok: false, placeholder: 'deep' };
  return { ok: true };
}

/** The `|h=<px>` and `|fit` of a chip's label ("title|h=240|fit") -> { title, h, fit, mode } (h null when absent or junk, fit false when
 *  absent). The MODE is the chip's own text: `window` when it holds a height and no `|fit` (a fixed-height box that scrolls inside, the
 *  grip resizes it), else `full` (the default: the whole doc in flow, no inner scroll; `|fit` keeps a stored height beside it so going
 *  back to the window restores it). The title may contain no `]`; a bar inside a title is kept (only trailing `|h=NNN` and `|fit` are options). */
export function parseEmbedLabel(label) {
  let t = String(label ?? ''), fit = false;
  if (/\|fit$/.test(t)) { fit = true; t = t.slice(0, -4); }
  const m = /^([^]*?)\|h=(\d{2,4})$/.exec(t);
  const r = m ? { title: m[1], h: clampH(+m[2]), fit } : { title: t, h: null, fit };
  return { ...r, mode: r.h != null && !fit ? 'window' : 'full' };
}
const labelOf = (title, h, fit) => `${title}${h == null ? '' : `|h=${h}`}${fit ? '|fit' : ''}`;
/** The label with its height set (or removed: h null); the fit flag is kept. */
export const withHeight = (label, h) => { const p = parseEmbedLabel(label); return labelOf(p.title, clampH(h), p.fit); };
/** The label in a mode: `full` keeps a stored height behind `|fit` (none stored: the bare title is already full); `window` clears the flag
 *  and uses the stored height, else `h` (clamped), else DEFAULT_H. */
export const withMode = (label, mode, h = null) => {
  const p = parseEmbedLabel(label);
  if (mode === 'full') return labelOf(p.title, p.h, p.h != null);
  if (mode === 'window') return labelOf(p.title, p.h ?? clampH(h) ?? DEFAULT_H, false);
  return String(label ?? '');
};

const svg = (d) => `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${d}"/></svg>`;
const btn = (cls, action, label, html, extra = {}) => ({ tag: 'span', cls: `qk-embed-btn ${cls}`, inert: true, editable: false, html, attrs: { 'data-action': action, role: 'button', 'aria-label': label, title: label, ...extra } });
/** The vnode of an embed slot (the app styles it; the structure is the kit's). spec: { id, title, h, mode ('full' | 'window'), collapsed,
 *  status ('live' | 'locked' | 'deleted' | 'cycle' | 'deep' ...), href (open-link target) }. A resting embed is a thin rectangle (the
 *  `qk-embed-box`: a title row, the body for the embedded editor, and in window mode the resize grip as its own row below the body);
 *  the root around it is OUTSET so the text inside sits where the host's own lines are. The fold caret is the title row's first child, just
 *  INSIDE the box's left edge, before the title (The owner 2026-11-12 18:54 PST: "the fold carat should be just inside the box here, not outsied");
 *  tools (window, expand, fullscreen, open-link) sit in the row's right end. `lib/editor/embed.css` shows the caret, the tools and the full-strength
 *  title only while the pointer is over the title row (or a control in it is pressed or keyboard-focused), never because the caret or focus is in
 *  the embedded text. The slot is `stable`: a change of height, mode, title or fold PATCHES the same elements in place (editor.js patchStable), so
 *  the toolbar under the pointer is never rebuilt, never loses its hover and never fades in again (The owner 18:53: "the menu bar flashes when i
 *  click one of the view options"). */
export function embedSlot(key, spec) {
  const collapsed = Boolean(spec.collapsed), mode = spec.mode === 'window' ? 'window' : 'full', win = mode === 'window' && !collapsed, h = clampH(spec.h) ?? DEFAULT_H;
  return {
    tag: 'div', cls: `qk-embed mode-${mode}${collapsed ? ' collapsed' : ''}${spec.status ? ` qk-embed-${spec.status}` : ''}`, inert: true, editable: false, stable: true, adopt: '.qk-embed-body',
    attrs: { 'data-qk-embed': key, 'data-embed-mode': mode, role: 'group', 'aria-label': `embedded doc: ${spec.title}`, style: win ? `height:${h}px` : '' },
    children: [
      { tag: 'div', cls: 'qk-embed-box', inert: true, editable: false, children: [
        { tag: 'div', cls: 'qk-embed-head', inert: true, editable: false, children: [
          btn('qk-embed-collapse', 'embed:collapse', collapsed ? 'unfold the embed' : 'fold the embed', svg(collapsed ? 'm7 4 6 6-6 6' : 'm4 7 6 6 6-6'), { 'aria-expanded': collapsed ? 'false' : 'true' }),
          { tag: 'span', cls: 'qk-embed-name', inert: true, editable: false, text: spec.title || 'untitled', attrs: { 'data-action': 'embed:title', title: 'click to rename' } },
          { tag: 'span', cls: 'qk-embed-btns', inert: true, editable: false, children: [
            btn('qk-embed-window', 'embed:window', 'fixed height, scrolls inside (drag the bottom edge to resize)', svg('M3 4h14v12H3zM3 8h14M13 11v3'), { 'aria-pressed': mode === 'window' ? 'true' : 'false' }),
            btn('qk-embed-full', 'embed:full', 'show the whole doc (no scrolling)', svg('M10 3v14M6.5 6.5 10 3l3.5 3.5M6.5 13.5 10 17l3.5-3.5'), { 'aria-pressed': mode === 'full' ? 'true' : 'false' }),
            btn('qk-embed-fullscreen', 'embed:fullscreen', 'fullscreen', svg('M12 3h5v5M8 17H3v-5M17 3l-5 5M3 17l5-5')),
            ...(spec.href ? [btn('qk-embed-open', `open:${spec.href}`, 'open in a new tab', svg('M8 4H4v12h12v-4M11 3h6v6M17 3l-8 8'))] : []),
          ] },
        ] },
        { tag: 'div', cls: 'qk-embed-body', inert: true, editable: false, attrs: { 'data-qk-embed-body': '' } },
        ...(win ? [{ tag: 'div', cls: 'qk-embed-grip', inert: true, editable: false, attrs: { 'data-qk-embed-grip': '', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'drag to resize', title: 'drag to resize' } }] : []),
      ] },
    ],
  };
}

const BODY = '[data-qk-embed-body]';
/** Is `node` inside an embed body that sits strictly inside `root` (so the root's own editor does not own it)? */
export function inEmbedBody(root, node) {
  const el = node && (node.nodeType === 1 ? node : node.parentElement); if (!el?.closest) return false;
  const b = el.closest(BODY);
  return Boolean(b && b !== root && root.contains(b));
}

export function createEmbeds({ resolve, margin = 1, maxLive = 8, depth = 0, chain = [], IO = globalThis.IntersectionObserver }) {
  if (typeof resolve !== 'function') throw new Error('createEmbeds: resolve(ctx) is required');
  let ed = null, D = null, W = null, root = null, scroller = null, disposed = false;
  const slots = new Map();   // key -> { el, body, io, live, handle, status, token, order }
  let modal = null;          // { key, el, handle, off }
  let tick = 0, offGrip = null, titleEd = null;   // titleEd: { key, t } the inline title editor open over a slot's name (state.embedTitleEdit says which)

  const specOf = (key) => ed.items.find((it) => it.key === key)?.embed ?? null;
  const rowOf = (key) => key.startsWith('emb:') ? key.slice(4) : key;

  function note(slot, text) { slot.body.replaceChildren(); const p = D.createElement('div'); p.className = 'qk-embed-note'; p.textContent = text; slot.body.append(p); }

  async function mount(key) {
    const slot = slots.get(key); if (!slot || slot.live || disposed) return;
    const spec = specOf(key); if (!spec) return;
    if (spec.collapsed) return;
    slot.live = true; const token = ++tick; slot.token = token; slot.order = token;
    // at most maxLive: the oldest live one that does not hold focus gives way
    const live = [...slots.values()].filter((s) => s.handle && s !== slot).sort((a, b) => a.order - b.order);
    while (live.length >= maxLive) { const old = live.shift(); if (ed.state.embedFocus === old.key) continue; unmount(old.key); }
    if (spec.status && spec.status !== 'live' && spec.status !== 'pending') { note(slot, spec.placeholder || spec.status); slot.live = false; return; }
    let r;
    try { r = await resolve({ key, spec, chain, depth, modal: false, onEdge: (dir) => leave(key, dir), leave: (dir) => leave(key, dir) }); }
    catch (e) { if (slot.token === token) { note(slot, 'could not open this doc'); slot.live = false; } return; }
    if (disposed || slot.token !== token || !slot.live || !slot.el.isConnected) { r?.mount && void 0; slot.live = slot.token === token ? false : slot.live; return; }
    if (r.placeholder) { note(slot, r.placeholder); slot.status = r.placeholder; slot.live = false; return; }
    slot.body.replaceChildren();
    slot.handle = r.mount(slot.body); slot.status = 'live';
    // the doc's own title (its session: a rename from anywhere arrives by push) is the header's title: one absolute `embed title` action
    slot.offTitle = slot.handle.onTitle?.((t) => ed.dispatch({ type: 'embed', op: 'title', key, title: t }));
    const t0 = slot.handle.title?.(); if (typeof t0 === 'string' && t0 && t0 !== (ed.state.embeds[key]?.title ?? spec.title)) ed.dispatch({ type: 'embed', op: 'title', key, title: t0 });
    if (slot.body.style.minHeight) W.setTimeout(() => { if (slot.live && !disposed) slot.body.style.minHeight = ''; }, 400); // the height kept while it was unmounted gives way to the real one
    slot.body.addEventListener('keydown', slot.onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !e.isComposing) { e.preventDefault(); leave(key, 0); } });
  }
  function unmount(key) {
    const slot = slots.get(key); if (!slot) return;
    slot.token = ++tick; slot.live = false;
    // a FULL embed has no fixed height: keep the one it had (a spacer height on its own body, inside the embed so the host's observer ignores it)
    const sp = specOf(key), keep = sp && !sp.collapsed && sp.mode !== 'window' && slot.handle ? Math.round(slot.body.getBoundingClientRect().height) : 0;
    slot.offTitle?.(); slot.offTitle = null; if (titleEd?.key === key) closeTitle(false);
    if (slot.handle) { try { slot.handle.dispose(); } catch { /* disposing must not throw into a commit */ } slot.handle = null; if (slot.onKey) slot.body.removeEventListener('keydown', slot.onKey); }
    slot.body.replaceChildren(); slot.status = null;
    if (keep > 0) slot.body.style.minHeight = `${keep}px`;
    if (ed.state.embedFocus === key && !disposed) ed.dispatch({ type: 'embed', op: 'focus', key: null });
  }

  function watch(key, el) {
    const body = el.querySelector(BODY);
    let slot = slots.get(key);
    if (slot && slot.el === el) return;
    if (slot) { // the element was replaced (adopt kept the body): move the observers to the new one
      slot.io?.disconnect(); slot.el = el; slot.body = body;
    } else { slot = { key, el, body, io: null, live: false, handle: null, status: null, token: 0, order: 0 }; slots.set(key, slot); }
    if (IO) { slot.io = new IO((es) => { for (const en of es) { slot.visible = en.isIntersecting; if (en.isIntersecting) mount(key); else if (slot.handle || slot.live) unmount(key); } }, { root: scroller, rootMargin: `${Math.round(margin * 100)}% 0px` }); slot.io.observe(el); }
    else mount(key); // no IntersectionObserver (a headless test document): every slot is live
  }

  // ---- the resize grip: a drag is absolute `embed drag` actions (state.embedDrag, painted by paint() inside the host commit) and ONE
  // absolute `embed resize` on release. Not the browser's native corner (it sat on the inner scrollbar, 2026-11-12).
  let drag = null;           // { key, grip, pid, y0, h0, last, off }: the pointer gesture; the state it paints is state.embedDrag
  function endDrag(commit) {
    const g = drag; if (!g) return; drag = null; g.off();
    try { g.grip.releasePointerCapture?.(g.pid); } catch { /* already released */ }
    if (disposed) return;
    const spec = specOf(g.key);
    if (commit && spec && g.last != null && Math.abs(g.last - (clampH(spec.h) ?? DEFAULT_H)) >= 1) ed.dispatch({ type: 'embed', op: 'resize', key: g.key, h: g.last });
    ed.dispatch({ type: 'embed', op: 'drag', key: null });
  }
  function onGripDown(e) {
    const grip = e.target?.closest?.('[data-qk-embed-grip]'); if (!grip) return;
    const el = grip.closest('[data-qk-embed]');
    if (!el || el.parentElement !== root) return;            // a nested embed's grip belongs to the manager of the editor it is drawn in
    if (e.button !== 0 || ed.readOnly || drag) { e.preventDefault(); e.stopPropagation(); return; }
    e.preventDefault(); e.stopPropagation();                 // the host editor must not take this press (no selection gesture, no focus move)
    const key = el.getAttribute('data-qk-embed'), g = { key, grip, pid: e.pointerId, y0: e.clientY, h0: el.getBoundingClientRect().height, last: null, off: null };
    try { grip.setPointerCapture(e.pointerId); } catch { /* a synthetic event has no active pointer */ }
    const move = (ev) => { ev.stopPropagation(); const h = clampH(g.h0 + ev.clientY - g.y0); if (h == null || h === g.last) return; g.last = h; ed.dispatch({ type: 'embed', op: 'drag', key, h }); };
    const up = (ev) => { ev.stopPropagation(); endDrag(true); };
    const cancel = (ev) => { ev.stopPropagation(); endDrag(false); };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', cancel); grip.addEventListener('lostpointercapture', cancel);
    g.off = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', cancel); grip.removeEventListener('lostpointercapture', cancel); };
    drag = g;
  }
  /** Output only, inside the host commit (before the dev mutation observer is drained): each slot's height is the state's: the drag
   *  preview while one runs, else the chip's own `h`; a fit or collapsed slot has none. */
  function paint() {
    const d = ed.state.embedDrag;
    for (const [key, s] of slots) {
      const sp = specOf(key); if (!sp || !s.el.isConnected) continue;
      const free = sp.collapsed || sp.mode !== 'window', dragging = !free && d?.key === key;
      const want = free ? '' : `${dragging ? d.h : clampH(sp.h) ?? DEFAULT_H}px`;
      if (s.el.style.height !== want) s.el.style.height = want;
      if (s.el.hasAttribute('data-qk-dragging') !== dragging) s.el.toggleAttribute('data-qk-dragging', dragging);
      const nm = s.el.querySelector('.qk-embed-name'), want2 = ed.state.embeds[key]?.title ?? (sp.title || 'untitled');   // the live title (state) over the chip's label
      if (nm && !(titleEd?.key === key && titleEd.t.editing()) && nm.textContent !== want2) nm.textContent = want2;
    }
  }

  // ---- the inline title: a press on the name is `embed title-edit` (state.embedTitleEdit); the editor floats over the name (overlay: the
  // host's DOM is written only by its commits); Enter or blur dispatches the absolute `embed title` (shown at once) and renames the doc
  // through the mounted doc's `rename` (the app's existing rename path); a refused rename puts the previous title back
  const titleOf = (key) => ed.state.embeds[key]?.title ?? specOf(key)?.title ?? '';
  function closeTitle(save) { const e = titleEd; if (!e) return; titleEd = null; try { e.t.close(save); } catch { /* ignore */ } e.t.dispose(); }
  function reconcileTitle() {
    const want = ed.state.embedTitleEdit;
    if (titleEd && titleEd.key !== want) closeTitle(false);
    if (!want || titleEd) return;
    const slot = slots.get(want), nm = slot?.el.querySelector('.qk-embed-name'), h = slot?.handle;
    if (!nm || !h?.rename || !(h.canRename?.() ?? true)) { ed.dispatch({ type: 'embed', op: 'title-edit', key: null }); return; }
    const key = want, was = titleOf(key);
    const t = inlineTitle(nm, {
      auto: false, overlay: true, max: 120, get: () => titleOf(key),
      commit: async (v) => {
        ed.dispatch({ type: 'embed', op: 'title', key, title: v });
        try { const stored = await h.rename(v); if (typeof stored === 'string' && stored !== v && !disposed) ed.dispatch({ type: 'embed', op: 'title', key, title: stored }); return stored; }
        catch (e) { if (!disposed) ed.dispatch({ type: 'embed', op: 'title', key, title: was }); throw e; }
      },
      onClose: () => { if (titleEd?.t === t) titleEd = null; if (!disposed && ed.state.embedTitleEdit === key) ed.dispatch({ type: 'embed', op: 'title-edit', key: null }); },
    });
    titleEd = { key, t }; t.open();
  }

  // ---- the fullscreen lightbox: the same doc as a full-page editor over the page (a fixed overlay that IS the editor's scroller: the page
  // scrolls, there is no frame, like the photo lightbox's full-viewport layer); state.modal says whether it is open
  function openModal(key) {
    const spec = specOf(key); if (!spec) { ed.dispatch({ type: 'embed', op: 'modal', key: null }); return; }
    const el = D.createElement('div'); el.className = 'qk-embed-modal'; el.setAttribute('data-qk-modal', key); el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', spec.title || 'embedded doc');
    const bar = D.createElement('div'); bar.className = 'qk-embed-modal-bar';
    const name = D.createElement('span'); name.className = 'qk-embed-name'; name.textContent = ed.state.embeds[key]?.title ?? (spec.title || 'untitled');
    const close = D.createElement('span'); close.className = 'qk-embed-btn qk-embed-close'; close.setAttribute('role', 'button'); close.setAttribute('aria-label', 'close'); close.title = 'close (Esc)'; close.innerHTML = svg('M5 5l10 10M15 5L5 15');
    bar.append(name, close);
    const body = D.createElement('div'); body.className = 'qk-embed-body'; body.setAttribute('data-qk-embed-body', '');
    el.append(bar, body);
    const shut = () => ed.dispatch({ type: 'embed', op: 'modal', key: null });
    close.addEventListener('pointerdown', (e) => { e.preventDefault(); shut(); });
    const onKey = (e) => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopImmediatePropagation(); shut(); } };
    D.addEventListener('keydown', onKey, true);
    D.body.append(el);
    const m = { key, el, handle: null, off: () => D.removeEventListener('keydown', onKey, true), token: ++tick };
    modal = m;
    (async () => {
      let r; try { r = await resolve({ key, spec, chain, depth, modal: true, scroller: el, onEdge: () => {}, leave: () => {} }); } catch { r = { placeholder: 'could not open this doc' }; }
      if (disposed || modal !== m) return;
      if (r.placeholder) { const p = D.createElement('div'); p.className = 'qk-embed-note'; p.textContent = r.placeholder; body.append(p); return; }
      m.handle = r.mount(body); m.handle.focus?.('end');
    })();
  }
  function closeModal() {
    const m = modal; if (!m) return; modal = null;
    try { m.handle?.dispose(); } catch { /* ignore */ }
    m.off(); m.el.remove();
    if (!disposed) ed.focus();
  }
  const reconcile = () => {
    const want = ed.state.modal, have = modal?.key ?? null;
    if (want === have) return;
    if (have) closeModal();
    if (want) openModal(want);
  };

  // ---- focus: into a slot (the host's arrow at its edge) and back out
  function leave(key, dir) {
    if (disposed) return;
    const id = rowOf(key), lines = ed.items, i = lines.findIndex((it) => it.key === key);
    ed.dispatch({ type: 'embed', op: 'focus', key: null });
    let to = null;
    if (dir > 0) { for (let k = i + 1; k < lines.length; k++) if (lines[k].addr != null) { to = { id: lines[k].addr, off: 0 }; break; } }
    if (!to) { const row = ed.rowText(id); if (row != null) to = { id, off: row.length }; }
    ed.focus();
    if (to) ed.dispatch({ type: 'select', sel: { a: to, f: { ...to } }, reveal: true });
  }
  function canEnter(key) { const s = slots.get(key); return Boolean(s?.handle?.focus); }
  function enter(key, at) { const s = slots.get(key); if (!s?.handle?.focus) return false; s.handle.focus(at); return true; }

  return {
    attach(editor) {
      ed = editor; D = editor.root.ownerDocument; W = D.defaultView; root = editor.root; scroller = editor.scroller;
      root.addEventListener('pointerdown', onGripDown, true);
      offGrip = () => root.removeEventListener('pointerdown', onGripDown, true);
    },
    /** Inside every host commit, before the dev mutation observer is drained: the slots' heights follow the state (see paint). */
    paint() { if (ed && !disposed) paint(); },
    /** After every host commit: watch the slots now drawn, drop the ones gone, and bring the modal in line with the state. */
    sync() {
      if (!ed || disposed) return;
      const seen = new Set();
      for (const el of root.querySelectorAll(':scope > [data-qk-embed]')) { const key = el.getAttribute('data-qk-embed'); seen.add(key); watch(key, el); }
      for (const key of [...slots.keys()]) if (!seen.has(key)) { const s = slots.get(key); unmount(key); s.io?.disconnect(); slots.delete(key); }
      reconcile(); reconcileTitle();
      // a slot that was collapsed and is open again (or the other way) is mounted or unmounted from its state; an observed slot mounts again when the
      // observer last said it is on screen (the slot element is patched in place, so the observer does not fire a second time)
      for (const [key, s] of slots) { const sp = specOf(key); if (sp?.collapsed && s.handle) unmount(key); else if (sp && !sp.collapsed && !s.live && !s.handle && (!s.io || s.visible)) mount(key); }
    },
    /** A host action happened (editor.subscribe): the modal and the focus mirror follow the state. */
    onAction(a) {
      if (a?.type !== 'embed') return;
      if (a.op === 'modal') reconcile();
      if (a.op === 'focus' && a.key && ed.state.embedFocus === a.key) { const s = slots.get(a.key); if (s?.handle?.focus && !s.handle.focused?.()) s.handle.focus(a.where === 'end' ? 'end' : 'start'); }
    },
    canEnter, enter, leave,
    /** For tests and probes: the slot keys, whether each is live, and the modal. */
    status: () => ({ slots: [...slots].map(([key, s]) => ({ key, live: Boolean(s.handle), status: s.status })), modal: modal?.key ?? null, depth, chain }),
    /** For tests: drop a slot's live editor as the virtualization does (a full embed keeps its height). */
    unmountSlot: (key) => unmount(key),
    handle: (key) => slots.get(key)?.handle ?? null,
    modalHandle: () => modal?.handle ?? null,
    dispose() { disposed = true; for (const key of [...slots.keys()]) { try { slots.get(key).handle?.dispose(); } catch { /* ignore */ } slots.get(key).io?.disconnect(); } slots.clear(); endDrag(false); closeTitle(false); offGrip?.(); closeModal(); },
  };
}
