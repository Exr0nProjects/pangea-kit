// Builds the component conformance vectors from the kit (canonical). `node conformance/generate.mjs` rewrites
// conformance/components/*.json; tests/conformance.test.js fails if the committed files differ from a fresh build, so a
// behaviour change is a visible vector diff. Another implementation passes by replaying every step and writing the
// state in lib/canonical.js form: byte-equal to `state` (and `error` equal), and for gesture steps `resolved` equal.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registry, declareComponent, resolve } from '../lib/components.js';
import { declare, step } from '../lib/model.js';
import { canonical } from '../lib/canonical.js';
import { gens, rng, resetIds } from './gens.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const VECTOR_DIR = join(HERE, 'components');

/** Run one case: steps are [name, payload]; a gesture name is resolved first. Returns the vector steps. */
export function runCase(kind, args, steps) {
  const comp = registry[kind](...args);
  const decl = declare(declareComponent(kind, comp, { scope: 'ephemeral' }));
  let s = comp.initial;
  return steps.map(([name, payload]) => {
    const out = {};
    let op = name, p = payload;
    if (comp.gestures[name]) {
      const r = resolve(comp, s, name, payload);
      Object.assign(out, { gesture: name, payload, resolved: r });
      if (!r) return { ...out, state: s, error: null };
      [op, p] = r;
    } else Object.assign(out, { op: name, payload });
    const res = step(decl, s, op, p);
    s = res.state;
    return { ...out, state: s, error: res.error };
  });
}

const HAND = {
  toggle: [
    ['next wraps to the first option', [['next', {}], ['next', {}], ['next', {}]]],
    ['set is absolute and idempotent', [['set', { value: 'mine' }], ['set', { value: 'mine' }]]],
    ['an unknown value is ignored, not an error', [['set', { value: 'nope' }]]],
  ],
  modes: [
    ['normal -> insert -> normal', [['set', { mode: 'insert' }], ['set', { mode: 'normal' }]]],
    ['insert -> visual is not a declared edge', [['set', { mode: 'insert' }], ['set', { mode: 'visual' }]]],
  ],
  listSelect: [
    ['deselect remembers the row and restore brings it back clamped', [['select', { index: 4 }], ['deselect', {}], ['restore', { row_count: 3 }]]],
    ['move with no cursor restores the anchor and ignores delta', [['move', { delta: 3, row_count: 5 }]]],
    ['move clamps at both ends', [['select', { index: 1 }], ['move', { delta: -3, row_count: 5 }], ['move', { delta: 9, row_count: 5 }]]],
    ['select with row_count clamps; without it does not', [['select', { index: 9, row_count: 3 }], ['select', { index: 9 }]]],
    ['an empty list clears the cursor', [['select', { index: 2 }], ['move', { delta: 1, row_count: 0 }]]],
    ['deselect twice keeps the remembered row', [['select', { index: 2 }], ['deselect', {}], ['deselect', {}]]],
  ],
  search: [
    ['commit strips Python whitespace: U+0085 and U+001C..U+001F go, U+FEFF stays', [['update', { value: '\u0085\u001cfoo\ufeff\u001f ' }], ['commit', {}]]],
    ['start resets the draft to the committed query', [['update', { value: 'a' }], ['commit', {}], ['update', { value: 'abc' }], ['start', {}]]],
    ['cancel clears both', [['update', { value: 'x' }], ['commit', {}], ['cancel', {}]]],
  ],
  connection: [
    ['opened before connect is refused', [['opened', {}]]],
    ['connect gesture counts attempts; reconnect_at clears on open', [['connect', { url: 'ws://a' }], ['errored', { msg: 'boom', reconnect_at: 3.5 }], ['connect', { url: 'ws://a' }], ['opened', {}]]],
    ['a redelivered absolute connect is a no-op', [['connect', { url: 'ws://a' }], ['connect', { url: 'ws://a', attempt: 1 }]]],
    ['closed without reconnect_at clears it', [['connect', { url: 'ws://a' }], ['errored', { msg: 'x', reconnect_at: 9 }], ['closed', {}]]],
    ['connected -> connecting is not a declared edge', [['connect', { url: 'ws://a' }], ['opened', {}], ['connect', { url: 'ws://b' }]]],
  ],
  scrollAnchor: [
    ['snap_to_block zeroes the offset; snap_to_live drops the anchor', [['user_scrolled', { top_block_id: 'p2', offset: 40 }], ['snap_to_block', { block_id: 'p3' }], ['snap_to_live', {}]]],
  ],
  documentCursor: [
    ['collapse keeps the caret and drops the anchor', [['set_with_selection', { para_id: 'p2', offset: 3, sel_anchor_para: 'p1', sel_anchor_offset: 0 }], ['collapse_selection', {}]]],
    ['select_all spans first to last', [['select_all', { first_para_id: 'p1', last_para_id: 'p3', last_para_length: 7 }]]],
    ['a negative offset is ignored', [['set', { para_id: 'p1', offset: -1 }]]],
  ],
  undoHistory: [
    ['a batch keeps its first cursor_before even when it is null', [['batch', { open: true }], ['record', { id: 'a', actions: [1], cursor_before: null, cursor_after: { o: 1 } }], ['record', { id: 'b', actions: [2], cursor_before: { o: 1 }, cursor_after: { o: 2 } }], ['batch', { open: false }]]],
    ['opening an open batch drops nothing', [['batch', { open: true }], ['record', { id: 'a', actions: [1] }], ['batch', { open: true }], ['batch', { open: false }]]],
    ['undo inside an open batch commits it, then undoes it whole', [['record', { id: 'a', actions: [1] }], ['batch', { open: true }], ['record', { id: 'b', actions: [2] }], ['record', { id: 'c', actions: [3] }], ['undo', {}]]],
    ['closing an empty batch keeps the redo entries', [['record', { id: 'a', actions: [1] }], ['undo', {}], ['batch', { open: true }], ['batch', { open: false }], ['redo', {}]]],
    ['a new edit drops the redo entries', [['record', { id: 'a', actions: [1] }], ['record', { id: 'b', actions: [2] }], ['undo', {}], ['record', { id: 'c', actions: [3] }], ['redo', {}]]],
    ['a redelivered record is a no-op', [['record', { id: 'a', actions: [1] }], ['record', { id: 'a', actions: [1] }]]],
    ['two devices undoing once from the same position land one step back', [['record', { id: 'a', actions: [1] }], ['record', { id: 'b', actions: [2] }], ['seek', { position: 1 }], ['seek', { position: 1 }]]],
    ['seek clamps', [['record', { id: 'a', actions: [1] }], ['seek', { position: 9 }], ['seek', { position: -4 }]]],
  ],
  modal: [
    ['a confirm over a sheet: Escape closes the confirm only, then the sheet', [['open', { id: 'rules', return_to: 'rules-button' }], ['open', { id: 'confirm', kind: 'confirm', return_to: 'scope' }], ['escape', {}], ['escape', {}]]],
    ['a doubled Escape resolves to one absolute close, so a redelivery closes nothing more', [['open', { id: 'a' }], ['open', { id: 'b' }], ['close', { id: 'b' }], ['close', { id: 'b' }]]],
    ['closing a lower entry closes everything opened over it', [['open', { id: 'a' }], ['open', { id: 'b' }], ['open', { id: 'c' }], ['close', { id: 'b' }]]],
    ['a required prompt ignores Escape and its backdrop', [['open', { id: 'name', esc: 'ignore', backdrop: 'ignore' }], ['escape', {}], ['backdrop', { id: 'name' }]]],
    ['a backdrop click on a layer that is no longer on top does nothing', [['open', { id: 'a' }], ['open', { id: 'b' }], ['backdrop', { id: 'a' }]]],
    ['reopening an open id moves it to the top with its new fields', [['open', { id: 'a', payload: 1 }], ['open', { id: 'b' }], ['open', { id: 'a', payload: 2 }]]],
    ['a payload that is not plain JSON, or an unknown policy, is ignored', [['open', { id: 'a', esc: 'sometimes' }], ['open', { id: 'a', capture: 'yes' }]]],
  ],
  splitPane: [
    ['a drag is one gesture: the whole displacement against the layout he grabbed', [['resize', { divider: 0, delta_px: 120, container_px: 1000 }]]],
    ['a drag past collapse_below shuts the pane to a rail; between it and min it clamps at min', [['resize', { divider: 0, delta_px: -290, container_px: 1000 }], ['resize', { divider: 0, delta_px: -320, container_px: 1000 }]]],
    ['the last open pane never collapses', [['collapse', { pane: 'list' }], ['collapse', { pane: 'detail' }], ['collapse', { pane: 'third' }]]],
    ['focusing a rail opens it (webchat activate)', [['collapse', { pane: 'detail' }], ['focus', { pane: 'detail' }]]],
    ['no divider beside a rail', [['collapse', { pane: 'detail' }], ['resize', { divider: 0, delta_px: 50, container_px: 1000 }]]],
    ['add takes half the donor and focuses the new pane', [['add', { pane: 'p4', after: 'detail' }]]],
    ['a donor too narrow to halve above min gives an even split', [['resize', { divider: 0, delta_px: -220, container_px: 1000 }], ['add', { pane: 'p4', after: 'list' }]]],
    ['max_panes refuses a fifth pane', [['add', { pane: 'p4', after: 'list' }], ['add', { pane: 'p5', after: 'p4' }]]],
    ['removing the focused pane focuses its left neighbour; removing another keeps focus', [['focus', { pane: 'detail' }], ['remove', { pane: 'detail' }], ['remove', { pane: 'third' }]]],
    ['shift and focus_neighbour resolve to absolute move and focus, skipping rails', [['collapse', { pane: 'detail' }], ['focus_neighbour', { delta: 1 }], ['shift', { pane: 'third', delta: -1 }]]],
  ],
  sort: [
    ['a column click flips the current key and starts a new one ascending', [['column', { key: 'due' }], ['column', { key: 'title' }], ['column', { key: 'title' }]]],
    ['set is absolute and multi-key; reset returns to the declared order', [['set', { by: [['n', 'desc'], ['title', 'asc']] }], ['set', { by: [['n', 'desc'], ['title', 'asc']] }], ['reset', {}]]],
    ['an unknown key, a bad direction or a repeated key is ignored', [['set', { by: [['due', 'up']] }], ['set', { by: [['due', 'asc'], ['due', 'desc']] }], ['column', { key: 'nope' }]]],
  ],
  request: [
    ['a request runs and completes; a duplicate answer is a no-op', [['request', { id: '01J0000000000000000000000A', at: 1, deadline_at: 21 }], ['start', { id: '01J0000000000000000000000A', at: 2 }], ['progress', { id: '01J0000000000000000000000A', value: 0.5, text: 'half' }], ['complete', { id: '01J0000000000000000000000A', result: { n: 1 }, at: 3 }], ['complete', { id: '01J0000000000000000000000A', result: { n: 2 }, at: 4 }]]],
    ['a newer request supersedes; the old answer is dropped', [['request', { id: '01J0000000000000000000000A' }], ['start', { id: '01J0000000000000000000000A' }], ['request', { id: '01J0000000000000000000000B' }], ['complete', { id: '01J0000000000000000000000A', result: 'old' }], ['start', { id: '01J0000000000000000000000B' }], ['complete', { id: '01J0000000000000000000000B', result: 'new' }]]],
    ['an older request id never replaces a newer one', [['request', { id: '01J0000000000000000000000B' }], ['request', { id: '01J0000000000000000000000A' }], ['request', { id: '01J0000000000000000000000B' }]]],
    ['a deadline fails a pending request; a late answer after it is dropped; retry starts it again', [['request', { id: '01J0000000000000000000000A' }], ['fail', { id: '01J0000000000000000000000A', error: { code: 'AsyncTimeout', timeout_ms: 20000 } }], ['complete', { id: '01J0000000000000000000000A', result: 'late' }], ['retry', {}], ['complete', { id: '01J0000000000000000000000A', result: 'ok' }]]],
    ['cancel ends it; answers after a cancel are dropped', [['request', { id: '01J0000000000000000000000A' }], ['start', { id: '01J0000000000000000000000A' }], ['cancel', {}], ['complete', { id: '01J0000000000000000000000A', result: 'late' }], ['fail', { id: '01J0000000000000000000000A', error: 'E' }]]],
    ['progress outside 0..1 or before start is ignored; complete needs running', [['request', { id: '01J0000000000000000000000A' }], ['progress', { id: '01J0000000000000000000000A', value: 0.5 }], ['complete', { id: '01J0000000000000000000000A', result: 1 }], ['start', { id: '01J0000000000000000000000A' }], ['progress', { id: '01J0000000000000000000000A', value: 1.5 }]]],
  ],
  pagination: [
    ['next stops at the last page once the total is known', [['set_total', { total: 7 }], ['next', {}], ['next', {}], ['next', {}]]],
    ['goto past the end clamps to the last page', [['set_total', { total: 4 }], ['goto', { page: 9 }]]],
    ['a smaller total pulls the page back; an unknown total lets next run on', [['goto', { page: 4 }], ['set_total', { total: 5 }], ['set_total', { total: null }], ['next', {}]]],
    ['a new page size keeps the first row on screen', [['goto', { page: 3 }], ['set_page_size', { page_size: 2 }], ['set_page_size', { page_size: 5 }]]],
  ],
};

export const RANDOM_CASES = 16, RANDOM_LEN = 25;
export function buildVectors() {
  const out = {};
  for (const [kind, { args, gen }] of Object.entries(gens)) {
    resetIds();
    const cases = (HAND[kind] || []).map(([name, steps]) => ({ name, steps: runCase(kind, args, steps) }));
    for (let seed = 1; seed <= RANDOM_CASES; seed++) {
      const r = rng(seed * 7919 + kind.length);
      const comp = registry[kind](...args);
      const decl = declare(declareComponent(kind, comp, { scope: 'ephemeral' }));
      let s = comp.initial;
      const steps = [];
      for (let i = 0; i < RANDOM_LEN; i++) {
        const st = gen(r, s, { junk: true });
        steps.push(st);
        const res = comp.gestures[st[0]] ? resolve(comp, s, st[0], st[1]) : st;
        if (res) s = step(decl, s, res[0], res[1]).state;
      }
      cases.push({ name: `random seed ${seed}`, steps: runCase(kind, args, steps) });
    }
    out[kind] = { format: 'pangea-kit-component-vectors/1', kind, args, cases };
  }
  return out;
}
export const fileText = (v) => `${canonical(v)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(VECTOR_DIR, { recursive: true });
  for (const [kind, v] of Object.entries(buildVectors())) writeFileSync(join(VECTOR_DIR, `${kind}.json`), fileText(v));
  console.log(`wrote ${Object.keys(gens).length} vector files to ${VECTOR_DIR}`);
}
