// Seeded generators of gestures and actions per component, shared by the vector generator, the law tests and the
// Python differential. gen(rng, state, { junk }) -> [name, payload]: name is a gesture or an action; junk mixes in payloads
// a total reducer must ignore. Python-valid mode (junk false) only emits payloads the Python reference accepts.
export function rng(seed) { // mulberry32
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), pick: (xs) => xs[Math.floor(next() * xs.length)], chance: (p) => next() < p };
}
const JUNK = [{}, { value: 7 }, { index: -1 }, { row_count: -2 }, { url: 3 }, { position: 'x' }, { open: 'yes' }, { offset: -1, para_id: 'p1' }, { id: 5, actions: [] }];
const TEXT = ['', ' ', 'a', ' ab ', '\u0085x\u0085', '\ufeffq', '\u001cz\u001f', '\u3000\u3000', 'Ünï', 'x\ty', '\u00a0b'];
const para = (r) => r.pick(['p1', 'p2', 'p3']);
let uid = 0;

export const gens = {
  toggle: { args: [['open', 'all', 'mine']], gen: (r, s, { junk }) => (junk && r.chance(0.15) ? ['set', r.pick(JUNK)] : r.chance(0.5) ? ['next', {}] : ['set', { value: r.pick(['open', 'all', 'mine']) }]) },
  modes: { args: [['normal', 'insert', 'visual'], { transitions: { normal: ['insert', 'visual'], insert: ['normal'], visual: ['normal'] } }], gen: (r, s, { junk }) => (junk && r.chance(0.15) ? ['set', r.pick(JUNK)] : ['set', { mode: r.pick(['normal', 'insert', 'visual']) }]) },
  listSelect: {
    args: [],
    gen: (r, s, { junk }) => {
      if (junk && r.chance(0.15)) return [r.pick(['select', 'restore', 'move']), r.pick(JUNK)];
      return r.pick([
        () => ['move', { delta: r.int(-3, 3), row_count: r.int(0, 5) }],
        () => ['select', { index: r.int(0, 5) }],
        () => ['deselect', {}],
        () => ['restore', { row_count: r.int(0, 5) }],
      ])();
    },
  },
  search: {
    args: [],
    gen: (r, s, { junk }) => (junk && r.chance(0.1) ? ['update', r.pick(JUNK)] : r.pick([() => ['start', {}], () => ['update', { value: r.pick(TEXT) + (r.chance(0.5) ? r.pick(TEXT) : '') }], () => ['commit', {}], () => ['cancel', {}], () => ['clear', {}]])()),
  },
  connection: {
    args: [],
    gen: (r, s, { junk }) => {
      if (junk && r.chance(0.15)) return [r.pick(['connect', 'errored']), r.pick(JUNK)];
      const at = () => (r.chance(0.4) ? null : r.pick([0, 1.5, 3, 12.25, 1700000000.5]));
      return r.pick([
        () => ['connect', { url: r.pick(['ws://a', 'ws://b']) }],
        () => ['opened', {}],
        () => ['errored', { msg: r.pick(['boom', 'offline']), reconnect_at: at() }],
        () => (r.chance(0.5) ? ['closed', {}] : ['closed', { reconnect_at: at() }]),
      ])();
    },
  },
  scrollAnchor: {
    args: [],
    gen: (r, s, { junk }) => (junk && r.chance(0.15) ? ['user_scrolled', r.pick(JUNK)] : r.pick([() => ['user_scrolled', { top_block_id: para(r), offset: r.int(0, 100) }], () => ['snap_to_live', {}], () => ['snap_to_block', { block_id: para(r) }]])()),
  },
  documentCursor: {
    args: [],
    gen: (r, s, { junk }) => (junk && r.chance(0.15) ? [r.pick(['set', 'select_all', 'set_with_selection']), r.pick(JUNK)] : r.pick([
      () => ['set', { para_id: para(r), offset: r.int(0, 10) }],
      () => ['set_with_selection', { para_id: para(r), offset: r.int(0, 10), sel_anchor_para: para(r), sel_anchor_offset: r.int(0, 10) }],
      () => ['collapse_selection', {}],
      () => ['select_all', { first_para_id: para(r), last_para_id: para(r), last_para_length: r.int(0, 10) }],
    ])()),
  },
  undoHistory: {
    args: [],
    gen: (r, s, { junk }) => {
      if (junk && r.chance(0.1)) return [r.pick(['record', 'batch', 'seek']), r.pick(JUNK)];
      const cur = () => (r.chance(0.3) ? null : { para_id: para(r), offset: r.int(0, 10) });
      return r.pick([
        () => ['record', { id: `e${++uid}`, actions: Array.from({ length: r.int(0, 2) }, () => ({ id: r.int(0, 5) })), cursor_before: cur(), cursor_after: cur() }],
        () => ['batch', { open: true }],
        () => ['batch', { open: false }],
        () => ['undo', {}],
        () => ['redo', {}],
        ...(junk ? [() => ['seek', { position: r.int(-1, 6) }]] : []),
      ])();
    },
  },
  // The four designed from webchat. Python-valid mode (junk false) keeps to what the Python namesake accepts: one modal
  // id, the declared panes with focus/collapse/expand/toggle, column clicks and reset, and page navigation.
  modal: {
    args: [],
    gen: (r, s, { junk }) => {
      const id = junk ? r.pick(['a', 'b', 'c']) : 'm';
      if (junk && r.chance(0.12)) return [r.pick(['open', 'close', 'backdrop']), r.pick([...JUNK, { id: 'a', esc: 'maybe' }, { id: 'a', capture: 'yes' }, { id: 'a', payload: { at: undefined } }, { id: '' }, { id: 'a', return_to: 4 }])];
      const open = () => {
        const p = { id, payload: r.pick([null, { title: 'x' }, [1, 2], 'p', { n: r.int(0, 3) }]) };
        if (junk) { if (r.chance(0.3)) p.esc = r.pick(['close', 'ignore']); if (r.chance(0.3)) p.backdrop = r.pick(['close', 'ignore']); if (r.chance(0.2)) p.capture = r.chance(0.5); if (r.chance(0.4)) p.return_to = r.pick(['row-1', 'composer', null]); if (r.chance(0.2)) p.kind = r.pick(['confirm', 'menu']); }
        return ['open', p];
      };
      return r.pick([open, open, () => ['close', { id }], () => ['escape', {}], () => ['backdrop', { id: junk ? r.pick(['a', 'b', 'c']) : 'm' }], ...(junk ? [() => ['close_all', {}]] : [])])();
    },
  },
  splitPane: {
    args: [{ panes: ['list', 'detail', 'third'], unit: 'fraction', min: 0.06, collapse_below: 0.042, rail_px: 34, max_panes: 4 }],
    gen: (r, s, { junk }) => {
      const declared = ['list', 'detail', 'third'];
      const pane = () => (junk ? r.pick([...s.order, ...s.order, 'p4', 'p5']) : r.pick(declared));
      if (!junk) return r.pick([() => ['focus', { pane: pane() }], () => ['collapse', { pane: pane() }], () => ['expand', { pane: pane() }], () => ['toggle', { pane: pane() }]])();
      if (r.chance(0.1)) return [r.pick(['size', 'collapse', 'add', 'move', 'resize', 'focus_neighbour']), r.pick([...JUNK, { pane: 'list', size: Infinity }, { divider: 0, delta_px: 5, container_px: 0 }, { pane: 'list', to: 9 }])];
      return r.pick([
        () => ['resize', { divider: r.int(0, 3), delta_px: r.pick([-900, -300, -60, -5, 0, 7, 40, 250, 800]), container_px: r.pick([1000, 1400, 320]) }],
        () => ['resize', { divider: r.int(0, 3), delta_px: r.int(-500, 500), container_px: 1000 }],
        () => ['size', { pane: pane(), size: r.pick([0.01, 0.1, 0.3, 0.5, 0.9]), against: pane() }],
        () => ['collapse', { pane: pane() }],
        () => (r.chance(0.5) ? ['expand', { pane: pane() }] : ['expand', { pane: pane(), size: r.pick([0.02, 0.25, 0.5, 1.2]) }]),
        () => ['focus', { pane: pane() }],
        () => ['toggle', { pane: pane() }],
        () => ['add', { pane: r.pick(['p4', 'p5', 'p6']), after: r.chance(0.2) ? null : pane() }],
        () => ['remove', { pane: pane() }],
        () => ['move', { pane: pane(), to: r.int(0, 4) }],
        () => ['shift', { pane: pane(), delta: r.pick([-1, 1]) }],
        () => ['focus_neighbour', { delta: r.pick([-2, -1, 1, 2]) }],
        () => (r.chance(0.5) ? ['reset', {}] : ['reset', { pane: pane() }]),
      ])();
    },
  },
  sort: {
    args: [{ keys: { due: { type: 'time' }, title: { type: 'string' }, n: { type: 'number' } }, by: [['due', 'asc']] }],
    gen: (r, s, { junk }) => {
      const key = () => r.pick(['due', 'title', 'n']);
      if (!junk) return r.chance(0.85) ? ['column', { key: key() }] : ['reset', {}];
      if (r.chance(0.12)) return [r.pick(['set', 'column']), r.pick([...JUNK, { by: [] }, { by: [['due', 'up']] }, { by: [['due', 'asc'], ['due', 'desc']] }, { by: [['nope', 'asc']] }, { key: 'nope' }])];
      return r.pick([
        () => ['column', { key: key() }],
        () => ['reset', {}],
        () => ['set', { by: [...new Set(Array.from({ length: r.int(1, 3) }, key))].map((k) => [k, r.pick(['asc', 'desc'])]) }],
      ])();
    },
  },
  pagination: {
    args: [{ page_size: 3 }],
    gen: (r, s, { junk }) => {
      if (junk && r.chance(0.12)) return [r.pick(['goto', 'set_total', 'set_page_size']), r.pick([...JUNK, { page: 0 }, { page: 1.5 }, { total: -1 }, { page_size: 0 }, { total: 2.5 }])];
      return r.pick([
        () => ['next', {}], () => ['prev', {}],
        () => ['goto', { page: r.int(1, 6) }],
        () => ['set_total', { total: r.chance(0.25) ? null : r.int(0, 14) }],
        () => ['set_page_size', { page_size: r.int(1, 5) }],
      ])();
    },
  },
  request: {
    args: [],
    gen: (r, s, { junk }) => {
      const ids = ['01J0000000000000000000000A', '01J0000000000000000000000B', '01J0000000000000000000000C'];
      const id = () => (s.id && r.chance(0.7) ? s.id : r.pick(ids));
      if (junk && r.chance(0.15)) return [r.pick(['request', 'start', 'complete', 'fail', 'progress', 'cancel']), r.pick([...JUNK, { id: 7 }, { id: '' }, { id: s.id, value: 2 }, { id: s.id, error: '' }, { id: s.id, error: { message: 'no code' } }])];
      return r.pick([
        () => ['request', { id: r.pick(ids), at: r.int(0, 9), deadline_at: r.chance(0.5) ? r.int(10, 20) : null }],
        () => ['start', { id: id(), at: r.int(0, 9) }],
        () => ['progress', { id: id(), value: r.pick([0, 0.25, 0.5, 1]), text: r.chance(0.5) ? 'working' : undefined }],
        () => ['complete', { id: id(), result: r.pick([null, { n: 1 }, ['a'], 'done']), at: r.int(0, 9) }],
        () => ['fail', { id: id(), error: r.pick(['AsyncTimeout', { code: 'E_NET', message: 'offline' }]), at: r.int(0, 9) }],
        () => ['cancel', { id: id(), actor: 'user' }],
        () => ['retry', {}],
      ])();
    },
  },
};
/** Reset the record id counter so a generator run is reproducible. */
export const resetIds = () => { uid = 0; };
