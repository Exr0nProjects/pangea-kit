// Click-to-edit title: the one inline title editor every view of a document's name uses (The owner 2026-11-12 11:06 PST: "the doc title
// must be click-to-edit inline in three places: the embed header title, the standalone doc page title, the share sheet's title ...
// One shared kit-level inline title editor, rename is an idempotent absolute action through the existing rename path, and all three
// views update live"). PANGEA3-DESIGN §15 "Embeds", "Inline title".
//
// inlineTitle(el, { get, commit, canEdit, max, auto, overlay, onClose }) -> { open(), close(save), set(text), editing(), dispose() }
//   get()          the title as the document has it now (the truth the view falls back to)
//   commit(value)  the ABSOLUTE rename: the new whole title (whitespace folded, trimmed, at most `max` characters). A repeat of the same
//                  value is the same title, so a retry or a double blur is harmless; it may return a promise of the stored title; a
//                  rejection puts the old title back. Called only when the value differs from get() and is not empty.
//   canEdit()      false: a press does nothing (a reader, a non-owner)
//   auto           (default true) a click on `el`, or Enter / F2 while it has focus, opens the editor; false: only open() does
//   overlay        false (default): the input replaces el's text in place. true: the input floats over el from document.body (for a view whose
//                  DOM an editor owns and observes, e.g. an embed header inside a kit editor: nothing there is written outside a commit)
//   onClose(saved) the editor ended (Enter or blur = save, Esc = cancel)
// Enter and blur save, Escape cancels; a key typed in the input never reaches shortcuts behind it. Self-contained on purpose (no imports
// and no outer names): worker/pages.js ships `inlineTitle.toString()` into the share sheet's inline script, so all three views run this code.
export function inlineTitle(el, { get, commit, canEdit = () => true, max = 120, auto = true, overlay = false, onClose = () => {} } = {}) {
  const D = el.ownerDocument, W = D.defaultView;
  let input = null, over = null, done = false;
  const norm = (v) => String(v).replace(/\s+/g, ' ').trim().slice(0, max);
  const show = (t) => { if (!input && !overlay) el.textContent = t; };   // overlay: the view repaints the text from its own state
  const finish = (save) => {
    if (!input || done) return; done = true;
    const v = norm(input.value); input.remove(); over?.remove(); input = null; over = null;
    const was = get();
    if (save && v && v !== was) {
      show(v);                                                           // optimistic: the same text the rename will store
      Promise.resolve().then(() => commit(v)).then((t) => { if (typeof t === 'string') show(t); }, () => show(get()));
    } else show(was);
    onClose(Boolean(save && v && v !== was));
  };
  const open = () => {
    if (input || !canEdit()) return false; done = false;
    const cs = W.getComputedStyle(el), r = el.getBoundingClientRect();
    input = D.createElement('input'); input.type = 'text'; input.value = get(); input.maxLength = max; input.spellcheck = false;
    input.setAttribute('aria-label', 'title'); input.setAttribute('data-qk-title-input', '');
    input.style.cssText = `font:${cs.font};letter-spacing:${cs.letterSpacing};color:${cs.color};background:transparent;border:0;border-bottom:1px solid ${cs.color};border-radius:0;outline:none;padding:0;margin:0;box-sizing:border-box;min-width:6ch;`;
    if (overlay) {
      over = D.createElement('div'); over.setAttribute('data-qk-title-overlay', '');
      over.style.cssText = `position:fixed;z-index:2147483000;left:${r.left}px;top:${r.top}px;width:${Math.max(r.width, 140)}px;height:${r.height}px;display:flex;align-items:center;background:${W.getComputedStyle(D.body).backgroundColor};`;
      input.style.width = '100%'; over.append(input); D.body.append(over);
    } else { input.style.width = `${Math.max(r.width, 140)}px`; el.replaceChildren(input); }
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    W.setTimeout(() => { input?.focus(); input?.select(); }, 0);
    return true;
  };
  const onPress = (e) => { if (!input && e.button === 0) open(); };   // on click, after the press's own focus change is done (a focus moved by the press would blur the new input at once)
  const onKey = (e) => { if ((e.key === 'Enter' || e.key === 'F2') && !input && e.target === el) { e.preventDefault(); open(); } };
  if (auto) { el.addEventListener('click', onPress); el.addEventListener('keydown', onKey); if (!el.hasAttribute('tabindex')) el.tabIndex = 0; el.style.cursor ||= 'text'; }
  return {
    open, close: (save) => finish(Boolean(save)), editing: () => Boolean(input),
    /** A title that arrived from elsewhere (a push): shown unless this view is being edited. */
    set: (t) => show(t),
    dispose() { finish(false); el.removeEventListener('click', onPress); el.removeEventListener('keydown', onKey); },
  };
}
