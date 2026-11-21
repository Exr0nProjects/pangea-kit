// An in-memory fake of the Pangea L1 Stream surface (pangea-l1-deploy/contract/streams-v1.md), enough for
// the kit's replicas to be tested against the same rules the Worker enforces: entries are immutable by
// entry_id, sequence is contiguous per (stream, device) starting at 1, an exact retry is idempotent, a
// changed reuse is a conflict, a gap reports the expected sequence, and reads are opaque-cursor pages in
// ingest order. The real transport (a Worker client) implements the same two methods.
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

export function createMemoryStreamServer({ pageSize = 200 } = {}) {
  const streams = new Map();
  const get = (name) => { if (!streams.has(name)) streams.set(name, { rows: [], ids: new Map(), frontier: new Map() }); return streams.get(name); };
  const state = { offline: false, calls: 0 };
  const gate = () => { state.calls++; if (state.offline) throw new Error('offline'); };
  return {
    state,
    streams,
    async push(stream, rows) {
      gate();
      const s = get(stream);
      for (const r of rows) {
        const bytes = stable(r);
        if (s.ids.has(r.entry_id)) { if (s.ids.get(r.entry_id) === bytes) continue; throw Object.assign(new Error('conflict'), { status: 409 }); }
        const expected = (s.frontier.get(r.device_id) ?? 0) + 1;
        if (r.device_seq !== expected) throw Object.assign(new Error('gap'), { status: 409, expected });
        s.ids.set(r.entry_id, bytes); s.frontier.set(r.device_id, r.device_seq); s.rows.push(r);
      }
    },
    async pull(stream, cursor) {
      gate();
      const s = get(stream);
      const from = cursor ? Number(cursor) : 0;
      const entries = s.rows.slice(from, from + pageSize);
      const next = from + entries.length;
      return { entries, cursor: String(next), more: next < s.rows.length };
    },
  };
}
