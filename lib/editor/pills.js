// Floating pills beside a selection, stacked: the selection pill (swatches, bold ...) nearest the words and the pills it opens
// (zai3's format popup) beyond it. One pure function places the whole stack from ONE measurement of the anchor and the pills'
// sizes, so two pills can never be placed from different readings of the selection (zai3 2026-11-12: the format popup sat tight
// over the selection pill and overlapped it, each pill having placed itself from its own, stale, rect). Laws, all tested:
//   - the pills never overlap each other or the anchor when there is room, and a gap of `gap` px separates each neighbouring pair
//     (words | pill | pill ...), the same gap everywhere;
//   - the stack goes on the side of the words with room (above first, then below); when neither has room it is shifted
//     into the view and may cover the words, but the pills still never cover each other;
//   - every pill is inside the view by `margin` on every side (a stack taller than the view is cut at the top, never left offscreen);
//   - a pill is centred on the anchor and clamped horizontally.
// stackPills({ anchor: { left, right, top, bottom }, sizes: [{ w, h }, ...] (nearest the words first), view: { w, h }, gap = 8, margin = 8 })
//   -> { side: 'above' | 'below', items: [{ left, top }, ...] }   (viewport px; `side` is where the stack sits relative to the words)
export function stackPills({ anchor, sizes, view, gap = 8, margin = 8 }) {
  const n = sizes.length;
  if (!n) return { side: 'above', items: [] };
  const total = sizes.reduce((s, z) => s + z.h, 0) + gap * (n - 1);
  const roomAbove = anchor.top - gap - margin, roomBelow = view.h - margin - (anchor.bottom + gap);
  const side = total <= roomAbove ? 'above' : total <= roomBelow ? 'below' : roomAbove >= roomBelow ? 'above' : 'below';
  const mid = (anchor.left + anchor.right) / 2;
  const x = (w) => Math.max(margin, Math.min(view.w - margin - w, mid - w / 2));
  // the stack's top edge: above, it ends gap over the words; below, it starts gap under them; then the whole stack is moved into the view
  let top = side === 'above' ? anchor.top - gap - total : anchor.bottom + gap;
  top = Math.max(margin, Math.min(view.h - margin - total, top));
  if (top < margin) top = margin; // a stack taller than the view starts at the top margin
  const items = new Array(n);
  let y = top;
  if (side === 'above') { for (let k = n - 1; k >= 0; k--) { items[k] = { left: x(sizes[k].w), top: y }; y += sizes[k].h + gap; } } // farthest first (top of the stack)
  else { for (let k = 0; k < n; k++) { items[k] = { left: x(sizes[k].w), top: y }; y += sizes[k].h + gap; } }
  return { side, items };
}
