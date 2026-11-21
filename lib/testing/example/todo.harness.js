// The todo app's harness: its vocabulary, its driver, its normalizer and its invariants. Everything else
// (generation, shrinking, recording, comparing, checking, reporting) is lib/testing.
import { defineVocabulary } from '../scenario.js';
import { defineNormalizer } from '../trace.js';
import { noLoss, idempotentRetry, replayStable, tabsConverge, reloadRestores } from '../invariants.js';
import { createMemoryStreamServer } from '../../stream-fake.js';
import { memoryStorage, openTodo } from './todo.js';

export const vocabulary = defineVocabulary({
  name: 'todo',
  ops: {
    add: { weight: 5, args: (g) => ({ text: g.marker() }), family: 'user' },
    done: { weight: 3, args: (g) => ({ index: g.pick(6), done: g.r() < 0.7 }), family: 'user' },
    sync: { weight: 4, family: 'server' },
    replay: { weight: 2, family: 'server' },
    reload: { weight: 2, family: 'user' },
    useTab: { weight: 2, args: (g) => ({ tab: g.pick(2) }), family: 'user' },
    offline: { weight: 2, closes: 'online', family: 'fault' },
    online: { weight: 0, family: 'fault' }
  }
});

/** Driver factory: a fresh server and two devices per run. `bug` selects a broken build. */
export const driver = ({ bug = null } = {}) => () => {
  let server; let tabs; let clock = 0; let current = 0;
  const now = () => (clock += 1000);
  const tab = (i, storage) => openTodo({ storage, device: `d${i}`, transport: server, now, bug });
  return {
    start() { server = createMemoryStreamServer(); tabs = [0, 1].map((i) => { const storage = memoryStorage(); return { storage, app: tab(i, storage) }; }); },
    async apply(step, rec) {
      const t = tabs[current];
      if (step.op === 'add') { t.app.add(step.text, step.text); rec.accept(step.text); }
      if (step.op === 'done') { const ids = t.app.replica.get().order; if (ids.length) t.app.done(ids[step.index % ids.length], step.done); else return { skipped: 'empty' }; }
      if (step.op === 'sync') return { ok: await t.app.sync() };
      // re-deliver exactly what this device already holds (every entry in its log), again: must change nothing
      if (step.op === 'replay') {
        if (server.state.offline) return { skipped: 'offline' };
        const held = new Set(t.app.replica.log.map((e) => `${e.device}:${e.seq}`));
        const again = (await server.pull('todos', null)).entries.filter((r) => held.has(r.entry_id));
        if (!again.length) return { skipped: 'nothing delivered yet' };
        t.app.replica.ingest(again);
        return { replayed: again.length };
      }
      if (step.op === 'reload') { t.app.replica.flush(); t.app = tab(current, t.storage); }
      if (step.op === 'useTab') current = step.tab;
      if (step.op === 'offline') { server.state.offline = true; rec.fault.offline = true; }
      if (step.op === 'online') { server.state.offline = false; rec.fault.offline = false; }
      return {};
    },
    settle: () => ({ settled: true }),
    observe: () => ({ tab: current, items: tabs[current].app.view() }),
    async finale() {
      server.state.offline = false;
      for (let round = 0; round < 2; round += 1) for (const t of tabs) await t.app.sync();
      const rows = server.streams.get('todos')?.rows || [];
      return {
        tabs: tabs.map((t) => ({ items: t.app.view() })),
        converge: [{ items: tabs[0].app.view() }, { items: tabs[1].app.view() }],
        durable: rows.filter((r) => r.payload.type === 'item.add').map((r) => r.payload.payload.text)
      };
    },
    stop() {}
  };
};

export const normalizer = defineNormalizer({ project: (obs) => obs, tolerated: [] });

const items = (obs) => obs?.items;
export const invariants = {
  noLoss: noLoss({ durable: (t) => t.finale.durable }),
  idempotentRetry: idempotentRetry({ durable: (t) => t.finale.durable }),
  replayStable: replayStable({ isReplay: (s) => s.step.op === 'replay' && !s.meta.skipped, project: items }),
  tabsConverge: tabsConverge({ project: items }),
  reloadRestores: reloadRestores({ isReload: (s) => s.step.op === 'reload', project: items })
};

/** A picture of a state, for the visual diff without a browser: one bar per item, green when done. */
export function render(obs, { width = 120, row = 10 } = {}) {
  const list = obs.items || [];
  const height = Math.max(row, list.length * row);
  const data = new Uint8Array(width * height * 4).fill(255);
  list.forEach((item, i) => {
    const len = 20 + (item.length * 7) % (width - 30);
    for (let y = i * row + 2; y < i * row + row - 2; y += 1) for (let x = 4; x < 4 + len; x += 1) {
      const o = (y * width + x) * 4; const done = item.startsWith('[x]');
      data[o] = done ? 40 : 20; data[o + 1] = done ? 160 : 20; data[o + 2] = done ? 60 : 20;
    }
  });
  return { width, height, data };
}
