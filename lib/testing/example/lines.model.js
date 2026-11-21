// The line document (lines.js) as a model for the kit's convergence fuzz (../convergence.js): seed import, regions
// (one zone per device), structure check and the op generator. The same shape an app supplies (zai2: test/sync-model.js).
import * as D from './lines.js';
import { identify } from '../../engine/structure.js';

const words = ['a', 'bb', 'ccc', 'x y', '**b**', '$x^2$', '- [ ] t', '- ', '  - [x] d', '# h', 'ü', ''];
const KINDS = ['type', 'type', 'type', 'enter', 'enter', 'back', 'del', 'range', 'paste', 'indent', 'outdent', 'todo', 'undo', 'undo', 'redo'];
const ZONE = ['past', 'timeline', 'future'];

export default {
  name: 'lines',
  sortKey: D.sortKey,
  live: D.isLive,
  cas: D.CAS,
  reset: () => D.resetIdSeq(),
  region: (row, k) => row.zone === ZONE[k % 3],
  shape: (row) => `${row.zone}|${row.body}`,
  // split, join and a paste's carried tail are ops with identity (lib/engine/structure.js): rows show their text
  // through viewRow, every op is identified, every write carries body and mvseen together
  structure: { text: 'body' },
  inverse: (before, puts, now) => D.inverse(before, puts, now),
  seedRows() {
    const out = [];
    for (const zone of ZONE) for (let i = 0; i < 4; i++) out.push({ id: `s-${zone}-${i}`, set: { kind: 'text', body: `${zone} ${i}`, ord: i + 1, indent: 0, zone, deleted_at: null, created_at: 'x', updated_at: 'x', source: 'import' } });
    return out;
  },
  check(rows) {
    const keys = new Set();
    for (const r of rows) {
      if (!ZONE.includes(r.zone) && r.zone !== 'state') return `bad zone ${r.zone} on ${r.id}`;
      if (!Number.isFinite(r.ord)) return `bad ord on ${r.id}`;
      if (typeof r.body !== 'string') return `body not a string on ${r.id}`;
      const k = D.sortKey(r).join('|'); if (keys.has(k)) return `duplicate sort key ${k}`; keys.add(k);
    }
    return null;
  },
  edit({ rows, all, now, rnd, int, pick, token, disjoint, device }) {
    const r = pick(rows), i = all.findIndex((x) => x.id === r.id), body = r.body || '';
    const kind = pick(KINDS), t = now();
    const get = (id) => all.find((x) => x.id === id);
    const step = (op, typing) => ({ kind, target: r.id, op: op && identify(op, { get, moves: op.moves }), typing });
    switch (kind) {
      case 'type': { const o = int(body.length + 1); const op = D.typed(r, body.slice(0, o) + pick(words) + token() + body.slice(o), t); return step(op, rnd() < 0.7); }
      case 'enter': return step(D.enter(all, i, int(body.length + 1), t));
      case 'back': return step(D.backspaceAtStart(all, i, t));
      case 'del': return step(D.deleteAtEnd(all, i, t));
      case 'range': case 'paste': {
        const same = all.map((x, k) => [x, k]).filter(([x]) => D.rankOf(x.zone) === D.rankOf(r.zone) && (!disjoint || x.zone === ZONE[device % 3]));
        const [, j] = pick(same), [a, b] = i <= j ? [i, j] : [j, i];
        return step(D.replaceRange(all, a, int((all[a].body || '').length + 1), b, int((all[b].body || '').length + 1), kind === 'paste' ? `${pick(words)}${token()}\n${pick(words)}${token()}\n${pick(words)}` : '', t));
      }
      case 'indent': case 'outdent': return step(D.indent(all, i, i, kind === 'indent' ? 1 : -1, t));
      case 'todo': return step(D.toggleTodo(r, t));
      default: return { kind, target: r.id }; // undo, redo
    }
  },
};
