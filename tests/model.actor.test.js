// Rows #13 (actor) and #14 (caused_by) on model.js entries: stored at dispatch, carried through the Stream envelope and
// back (EXTENSIONS-V1 section 5). Planted: an envelope that drops them is caught by the round trip.
import { describe, expect, it } from 'vitest';
import { createReplica, declare, fromStreamEntry, toStreamEntry } from '../lib/model.js';

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const decl = declare({ name: 'actor-test', initial: { n: 0 }, scope: 'cloud', conflict: 'lww', actions: { set: (s, p) => (typeof p?.n === 'number' && p.n !== s.n ? { n: p.n } : s) } });

describe('actor and caused_by on entries', () => {
  it('dispatch stores actor and caused_by, and the stream envelope round-trips them', () => {
    const r = createReplica(decl, { storage: mem(), device: 'd1', schedule: (f) => f() });
    const e = r.dispatch('set', { n: 3 }, { id: 'T1.foo.rule', actor: 'app:foo', causedBy: 'T1' });
    expect(e).toMatchObject({ id: 'T1.foo.rule', actor: 'app:foo', caused_by: 'T1' });
    const back = fromStreamEntry(toStreamEntry(e));
    expect(back).toMatchObject({ id: 'T1.foo.rule', actor: 'app:foo', caused_by: 'T1', type: 'set', payload: { n: 3 } });
  });
  it('an entry without them stays without them (older builds)', () => {
    const r = createReplica(decl, { storage: mem(), device: 'd1', schedule: (f) => f() });
    const e = r.dispatch('set', { n: 4 });
    expect('actor' in e || 'caused_by' in e).toBe(false);
    expect(Object.keys(toStreamEntry(e).payload).sort()).toEqual(['id', 'payload', 'type']);
  });
  it('planted: an envelope that drops actor is caught', () => {
    const e = { id: 'x', device: 'd', seq: 1, ts: 1, actor: 'app:foo', caused_by: 'T', type: 'set', payload: {} };
    const lossy = (x) => ({ ...toStreamEntry(x), payload: { type: x.type, payload: x.payload, id: x.id } });
    expect(fromStreamEntry(lossy(e)).actor).toBeUndefined();
    expect(fromStreamEntry(toStreamEntry(e)).actor).toBe('app:foo');
  });
});
