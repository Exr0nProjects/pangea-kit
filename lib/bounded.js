// A queue that cannot grow without bound (lint rule unbounded-queue; docs/LINT.md). Construction refuses without an item
// cap, a byte cap and an overflow policy, so "unbounded" is not expressible.
//   policy 'refuse'      push returns false when full (backpressure; use for durable user writes: never drop his data)
//   policy 'drop-oldest' push evicts from the head and counts the drop (telemetry, previews)
export function boundedQueue({ name, maxItems, maxBytes, policy, size = (v) => JSON.stringify(v ?? null).length } = {}) {
  if (!name) throw new Error('boundedQueue: name is required (it is reported in health)');
  if (!(maxItems > 0)) throw new Error(`boundedQueue ${name}: maxItems must be a positive number`);
  if (!(maxBytes > 0)) throw new Error(`boundedQueue ${name}: maxBytes must be a positive number`);
  if (!['refuse', 'drop-oldest'].includes(policy)) throw new Error(`boundedQueue ${name}: policy must be 'refuse' or 'drop-oldest'`);
  const items = [];
  let bytes = 0, dropped = 0, refused = 0;
  const shift = () => { const it = items.shift(); bytes -= it.n; return it.v; };
  return {
    name,
    push(v) {
      const n = size(v);
      if (n > maxBytes) { refused++; return false; }
      while (items.length >= maxItems || bytes + n > maxBytes) {
        if (policy === 'refuse') { refused++; return false; }
        shift(); dropped++;
      }
      items.push({ v, n }); bytes += n; return true;
    },
    shift: () => (items.length ? shift() : undefined),
    peek: () => items[0]?.v,
    get length() { return items.length; },
    stats: () => ({ name, items: items.length, bytes, maxItems, maxBytes, policy, dropped, refused }),
  };
}
