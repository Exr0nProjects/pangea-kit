// The app-level intent record (lib/intent.js): one owner at rest, total named transitions, a pane-open carries focus into the new pane.
import { describe, expect, it } from 'vitest';
import { actions, highlightsFor, INITIAL, intent, isOwner, paneActive, threadFocus, violations } from '../lib/intent.js';
import { checkLaws } from '../lib/laws.js';
import { rng } from '../conformance/gens.js';
import { createApp, declare } from '../lib/model.js';
import { declareComponent } from '../lib/components.js';

const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v }, removeItem: (k) => { delete m[k] } }; };
const run = (steps, from = INITIAL) => steps.reduce((s, [name, p]) => actions[name](s, p), from);
const PANES = ['p1', 'p2', 'p3'], ATS = [{ kind: 'composer', id: 'c1' }, { kind: 'composer', id: null }, { kind: 'thread', id: 't1' }, { kind: 'thread', id: 't2' }, { kind: 'transcript', id: null }, { kind: 'chrome', id: null }];
const JUNK = [null, 7, 'x', [], {}, { pane: 5 }, { pane: 'p1' }, { pane: '', at: { kind: 'composer' } }, { pane: 'p1', at: 3 }, { start: -1, end: 2 }, { seq: 'a' }];
const gen = (r, s, { junk }) => {
  if (junk && r.chance(0.2)) return [r.pick(Object.keys(actions)), r.pick(JUNK)];
  const pane = r.pick(PANES), at = r.pick(ATS);
  return r.pick([
    () => ['press', { pane, at, inside: r.chance(0.5) }],
    () => ['focusin', { pane, at, caret: r.chance(0.5) ? { start: r.int(0, 5), end: r.int(0, 9) } : undefined }],
    () => ['caret', { pane, at, start: r.int(0, 9), end: r.int(0, 9) }],
    () => ['focus', r.chance(0.5) ? { pane } : { pane, at }],
    () => ['openPane', { pane }],
    () => ['closePane', { pane, next: r.chance(0.5) ? r.pick(PANES) : undefined }],
    () => ['openThread', { pane, id: r.pick(['t1', 't2']) }],
    () => ['blurThread', { pane, id: r.chance(0.5) ? r.pick(['t1', 't2']) : undefined, to: r.chance(0.3) ? at : undefined }],
    () => ['typeToFocus', { printable: r.chance(0.8), editable: r.chance(0.3) }],
    () => ['leave', {}],
    () => ['applied', { seq: s.seq }]
  ])();
};

describe('intent: laws', () => {
  it('keeps every component law (total, pure, same reference on a no-op, idempotent) over 200 seeded sequences', () => {
    expect(checkLaws(intent(), gen)).toEqual([]);
  });
  it('exactly one owner at rest: no reachable state breaks an invariant (20,000 random transitions)', () => {
    const r = rng(7);
    let s = INITIAL;
    for (let i = 0; i < 20000; i++) {
      const [name, p] = gen(r, s, { junk: true });
      s = actions[name](s, p);
      expect(violations(s), `${name} ${JSON.stringify(p)} -> ${JSON.stringify(s)}`).toEqual([]);
    }
  });
  it('every transition is total: junk payloads (null, a number, a string) change nothing and throw nothing', () => {
    for (const name of Object.keys(actions).filter((n) => n !== 'leave')) for (const junk of JUNK.slice(0, 5)) {
      const s = { pane: 'p1', at: { kind: 'thread', id: 't1' }, caret: { start: 1, end: 1 }, pending: false, seq: 3 };
      expect(actions[name](s, junk)).toBe(s);
    }
  });
  it('declares and runs on the kit replica (ephemeral: never saved)', () => {
    const app = createApp({ storage: mem(), device: 'd' });
    const store = app.use(declare(declareComponent('intent', intent(), { scope: 'ephemeral' })));
    store.dispatch('openPane', { pane: 'p2' });
    expect(store.get()).toMatchObject({ pane: 'p2', pending: true });
  });
});

describe('intent: the named transitions', () => {
  it('click-into-box: a press on the box body moves focus into it; a press on its text field does not ask the screen to move', () => {
    const body = run([['press', { pane: 'p1', at: { kind: 'thread', id: 't1' } }]]);
    expect(body).toMatchObject({ pane: 'p1', at: { kind: 'thread', id: 't1' }, pending: true });
    const field = run([['press', { pane: 'p1', at: { kind: 'thread', id: 't1' }, inside: true }]]);
    expect(field.pending).toBe(false);
    const transcript = run([['press', { pane: 'p1', at: { kind: 'transcript' } }]]);
    expect(transcript).toMatchObject({ at: { kind: 'transcript', id: null }, pending: false });
  });

  it('Shift-Enter opens a pane: focus is carried into the new pane and a stale echo from the old box does not take it back', () => {
    let s = run([['openThread', { pane: 'p1', id: 't1' }], ['focusin', { pane: 'p1', at: { kind: 'thread', id: 't1' } }]]);
    expect(s).toMatchObject({ pane: 'p1', pending: false });
    s = actions.openPane(s, { pane: 'p2' });
    expect(s).toMatchObject({ pane: 'p2', at: { kind: 'composer', id: null }, pending: true });
    // the old thread's textarea still has DOM focus and reports it (a late focusin, or a click-through): the intent stands
    expect(actions.focusin(s, { pane: 'p1', at: { kind: 'thread', id: 't1' } })).toBe(s);
    // typing before the screen caught up keeps the new pane as the target
    expect(actions.typeToFocus(s, { printable: true, editable: false })).toBe(s);
    // the new composer takes focus: the echo ends the pending move
    const done = actions.focusin(s, { pane: 'p2', at: { kind: 'composer', id: 'chat-9' }, caret: { start: 0, end: 0 } });
    expect(done).toMatchObject({ pane: 'p2', pending: false, caret: { start: 0, end: 0 } });
    expect(isOwner(done, 'p2', { kind: 'composer', id: 'chat-9' })).toBe(true);
    expect(isOwner(done, 'p1', { kind: 'thread', id: 't1' })).toBe(false);
  });

  it('focus: code asks for the caret in a box; a place that holds no caret is just recorded', () => {
    expect(actions.focus(INITIAL, { pane: 'p1' })).toMatchObject({ pane: 'p1', at: { kind: 'composer', id: null }, pending: true });
    expect(actions.focus(INITIAL, { pane: 'p1', at: { kind: 'transcript' } })).toMatchObject({ at: { kind: 'transcript' }, pending: false });
    const s = actions.focus(INITIAL, { pane: 'p1' });
    expect(actions.focus(s, { pane: 'p1' })).toBe(s);
  });

  it('closing the focused pane moves focus to the next pane; closing another changes nothing', () => {
    const s = run([['openPane', { pane: 'p2' }], ['applied', { seq: 1 }]]);
    expect(actions.closePane(s, { pane: 'p1', next: 'p3' })).toBe(s);
    expect(actions.closePane(s, { pane: 'p2', next: 'p1' })).toMatchObject({ pane: 'p1', at: { kind: 'composer' }, pending: true });
    expect(actions.closePane(s, { pane: 'p2' })).toMatchObject({ pane: null, at: null, caret: null, pending: false });
  });

  it('side-thread open then blur: the box takes the caret, and putting it away hands focus to the composer', () => {
    let s = actions.openThread(INITIAL, { pane: 'p1', id: 't1' });
    expect(threadFocus(s, 'p1')).toBe('t1');
    expect(s.pending).toBe(true);
    s = actions.blurThread(s, { pane: 'p1', id: 't1' });
    expect(threadFocus(s, 'p1')).toBeNull();
    expect(s).toMatchObject({ at: { kind: 'composer' }, pending: true });
    expect(actions.blurThread(s, { pane: 'p1', id: 't1' })).toBe(s); // already away
    const toText = actions.blurThread(actions.openThread(INITIAL, { pane: 'p1', id: 't1' }), { pane: 'p1', to: { kind: 'transcript' } });
    expect(toText).toMatchObject({ at: { kind: 'transcript' }, pending: false });
  });

  it('type-to-focus: a printable key with nothing editable focused goes to the owner box, or the pane composer; an editable target is left alone', () => {
    const owner = run([['openThread', { pane: 'p1', id: 't1' }], ['focusin', { pane: 'p1', at: { kind: 'thread', id: 't1' } }]]);
    expect(actions.typeToFocus(owner, { printable: true, editable: false })).toMatchObject({ at: { kind: 'thread', id: 't1' }, pending: true });
    expect(actions.typeToFocus(owner, { printable: true, editable: true })).toBe(owner);
    expect(actions.typeToFocus(owner, { printable: false, editable: false })).toBe(owner);
    const onText = run([['press', { pane: 'p1', at: { kind: 'transcript' } }]]);
    expect(actions.typeToFocus(onText, { printable: true, editable: false })).toMatchObject({ at: { kind: 'composer' }, pending: true });
    expect(actions.typeToFocus(INITIAL, { printable: true, editable: false })).toBe(INITIAL);
  });

  it('the caret is only ever the owner box\'s: another element or pane cannot move it', () => {
    let s = run([['openThread', { pane: 'p1', id: 't1' }], ['focusin', { pane: 'p1', at: { kind: 'thread', id: 't1' } }]]);
    s = actions.caret(s, { pane: 'p1', at: { kind: 'thread', id: 't1' }, start: 4, end: 2 });
    expect(s.caret).toEqual({ start: 2, end: 4 });
    expect(actions.caret(s, { pane: 'p2', at: { kind: 'thread', id: 't1' }, start: 0, end: 0 })).toBe(s);
    expect(actions.caret(s, { pane: 'p1', at: { kind: 'thread', id: 't2' }, start: 0, end: 0 })).toBe(s);
    expect(actions.press(s, { pane: 'p1', at: { kind: 'transcript' } }).caret).toBeNull();
  });

  it('the highlight and the pane\'s activity read the one record: another pane focused paints nothing, focus back paints it again', () => {
    const ids = ['t1', 't2', 't3'];
    let s = run([['openThread', { pane: 'p1', id: 't2' }]]);
    expect(highlightsFor(s, 'p1', ids)).toEqual({ faint: ['t1', 't3'], strong: ['t2'] });
    s = actions.press(s, { pane: 'p2', at: { kind: 'transcript' } }); // he clicked another pane
    expect(highlightsFor(s, 'p1', ids)).toEqual({ faint: [], strong: [] });
    expect(paneActive(s, 'p2')).toBe(true);
    s = actions.openThread(s, { pane: 'p1', id: 't2' });
    expect(highlightsFor(s, 'p1', ids).strong).toEqual(['t2']);
    s = actions.press(s, { pane: 'p1', at: { kind: 'transcript' } }); // focus leaves the thread inside the pane
    expect(highlightsFor(s, 'p1', ids)).toEqual({ faint: ids, strong: [] });
    expect(paneActive(INITIAL, 'p1', true)).toBe(true); // before anything was focused a pane says what the layout says
  });
});
