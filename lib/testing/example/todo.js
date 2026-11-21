// The second app through the testing harness (not webchat): a tiny todo list on the kit state core, synced
// between devices through the in-memory Stream fake. It exists to prove the harness is generic: its driver
// (todo.harness.js) is the only glue, and fuzzing, the model check and the visual diff come from lib/testing.
import { declare, createReplica } from '../../model.js';

export const todos = declare({
  name: 'todos', scope: 'cloud', version: 1,
  initial: { items: {}, order: [] },
  actions: {
    // absolute end states (A6): adding an id twice, or setting done to what it is, is a no-op
    'item.add': (s, { id, text }) => (s.items[id] ? s : { items: { ...s.items, [id]: { text, done: false } }, order: [...s.order, id] }),
    'item.done': (s, { id, done }) => (!s.items[id] || s.items[id].done === done ? s : { ...s, items: { ...s.items, [id]: { ...s.items[id], done } } })
  }
});

export function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null };
}

/** One device. `bug` makes a deliberately broken build for the harness's own tests: 'forget-offline' drops the outbox when a sync fails. */
export function openTodo({ storage, device, transport, now, bug = null }) {
  const make = () => createReplica(todos, { storage, device, transport, now, schedule: (f) => f() });
  const self = {
    replica: make(),
    add: (id, text) => self.replica.dispatch('item.add', { id, text }),
    done: (id, done) => self.replica.dispatch('item.done', { id, done }),
    async sync() {
      try { await self.replica.sync(); return true; } catch {
        // the broken build: a failed sync throws the outbox away (the record is wiped and the replica rebuilt)
        if (bug === 'forget-offline') { storage.removeItem('qk:todos'); self.replica = make(); }
        return false;
      }
    },
    view: () => { const s = self.replica.get(); return s.order.map((id) => `${s.items[id].done ? '[x]' : '[ ]'} ${s.items[id].text}`); }
  };
  return self;
}
