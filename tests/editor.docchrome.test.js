// lib/editor/docchrome.js: the outline of headings, document tabs as rows of the document (a filtered view, one stream), and the
// chrome's declared state (absolute, idempotent, total; the gate's laws over every action).
import { describe, expect, it } from 'vitest';
import { checkDeclLaws } from '../lib/laws.js';
import { generatorFor } from '../lib/declare-keys.js';
import { createReplica } from '../lib/model.js';
import { memoryLines } from '../lib/editor/editor.js';
import { outlineOf, outlineView, currentHeading, tabsOf, tabOf, addTabPuts, renameTabPuts, deleteTabPuts, tabDoc, tabRowId, docChromeDecl, MAIN_TAB } from '../lib/editor/docchrome.js';

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const head = (r) => { const m = /^(#{1,6}) (.*)$/.exec(r.body || ''); return m ? { level: m[1].length, text: m[2] } : null; };
const row = (id, body, extra = {}) => ({ id, kind: 'text', body, ord: Number(id.slice(1)) || 0, zone: 'timeline', ...extra });

describe('outline', () => {
  const lines = [row('a1', '# One'), row('a2', 'text'), row('a3', '## One.a'), row('a4', '### deep'), row('a5', '## One.b'), row('a6', '# Two'), row('a7', '# '), row('a8', '#nospace')];
  it('lists the headings in order with their level, skipping blank ones', () => {
    const o = outlineOf(lines, head);
    expect(o.map((e) => [e.id, e.level, e.text])).toEqual([['a1', 1, 'One'], ['a3', 2, 'One.a'], ['a4', 3, 'deep'], ['a5', 2, 'One.b'], ['a6', 1, 'Two']]);
    expect(o[1].index).toBe(2);
  });
  it('a folded heading hides what is under it, down to the next heading of its level or higher', () => {
    const o = outlineOf(lines, head);
    expect(outlineView(o, { a1: true }).map((e) => e.id)).toEqual(['a1', 'a6']);
    expect(outlineView(o, { a3: true }).map((e) => e.id)).toEqual(['a1', 'a3', 'a5', 'a6']);
    const v = outlineView(o, { a3: true });
    expect(v[1]).toMatchObject({ child: true, shut: true }); expect(v[0]).toMatchObject({ child: true, shut: false }); expect(v[3].child).toBe(false);
    expect(outlineView(o, { a6: true }).find((e) => e.id === 'a6').shut).toBe(false); // nothing under it, nothing to fold
  });
  it('the current heading is the last one at or before the caret', () => {
    const o = outlineOf(lines, head);
    expect(currentHeading(o, 1).id).toBe('a1'); expect(currentHeading(o, 3).id).toBe('a4'); expect(currentHeading(o, 5).id).toBe('a6');
    expect(currentHeading([{ id: 'x', index: 3 }], 1)).toBeNull();
  });
});

describe('document tabs are rows of the document', () => {
  const rows = [
    row('l1', 'main one', { ord: 1 }), row('l2', 'second tab', { ord: 1, tab: 'b2' }), row('l3', 'third tab', { ord: 1, tab: 'c3' }),
    { id: tabRowId('c3'), kind: 'tab', body: 'Gamma', ord: 2 }, { id: tabRowId('b2'), kind: 'tab', body: 'Beta', ord: 1 },
    { id: tabRowId('gone'), kind: 'tab', body: 'Gone', ord: 3, deleted_at: '2026-11-12T00:00:00.000Z' }, { id: 'junk', kind: 'tab', body: 'not a tab row' },
  ];
  it('lists the main tab first, then live tab rows by ord; a tombstone and a malformed row are not tabs', () => {
    expect(tabsOf(rows).map((t) => [t.id, t.title])).toEqual([['main', 'Tab 1'], ['b2', 'Beta'], ['c3', 'Gamma']]);
    expect(tabsOf([{ id: tabRowId('main'), kind: 'tab', body: 'Plan' }])[0].title).toBe('Plan');
    expect(tabsOf([])).toEqual([{ id: 'main', title: 'Tab 1', ord: 0 }]);
  });
  it('a line belongs to the tab it names; none is the main tab; junk is the main tab', () => {
    expect(tabOf(row('x1', 'a'))).toBe(MAIN_TAB); expect(tabOf({ tab: 'b2' })).toBe('b2'); expect(tabOf({ tab: 'Bad Id!' })).toBe(MAIN_TAB);
  });
  it('the doc view of a tab shows its lines only, and a new line made inside it carries the tab', () => {
    let active = 'b2';
    const base = memoryLines(rows.filter((r) => r.kind !== 'tab'), { sortKey: (r) => [r.ord, r.id] });
    const puts = [];
    const doc = tabDoc({ ...base, put: (p, o) => { puts.push(...p); return base.put(p, o); } }, () => active);
    expect(doc.lines().map((r) => r.id)).toEqual(['l2']);
    doc.put([{ id: 'new1', set: { kind: 'text', body: 'x', ord: 2, zone: 'timeline', created_at: 'now' } }, { id: 'l2', set: { body: 'edited' } }]);
    expect(puts.find((p) => p.id === 'new1').set.tab).toBe('b2');
    expect('tab' in puts.find((p) => p.id === 'l2').set).toBe(false); // an edit of an existing row is not restamped
    expect(doc.lines().map((r) => r.id)).toEqual(['l2', 'new1']);
    active = 'main';
    expect(doc.lines().map((r) => r.id)).toEqual(['l1']);
    doc.put([{ id: 'new2', set: { kind: 'text', body: 'm', ord: 5, zone: 'timeline', created_at: 'now' } }]);
    expect('tab' in puts.find((p) => p.id === 'new2').set).toBe(false); // the main tab is the absence of the field
    expect(doc.lines().map((r) => r.id)).toEqual(['l1', 'new2']);
  });
  it('add, rename and delete are absolute writes: a repeat is the same rows; delete tombstones the tab and its lines, never the main tab', () => {
    const at = Date.UTC(2026, 10, 12);
    const tabs = tabsOf(rows);
    const a = addTabPuts(tabs, 'd4', 'Delta', at);
    expect(a).toHaveLength(1); expect(a[0].id).toBe('tab:d4'); expect(a[0].set).toMatchObject({ kind: 'tab', body: 'Delta', ord: 3 });
    expect(addTabPuts(tabs, 'b2', 'Again', at)).toEqual([]); // an id that exists adds nothing
    expect(addTabPuts(tabs, 'Bad Id', 'x', at)).toEqual([]);
    expect(renameTabPuts('b2', '  Beta2 ', at)[0].set.body).toBe('Beta2');
    const del = deleteTabPuts(rows, 'b2', at);
    expect(del.map((p) => p.id).sort()).toEqual(['l2', 'tab:b2']);
    expect(deleteTabPuts(rows, 'main', at)).toEqual([]);
  });
});

describe('the chrome state', () => {
  it('every law holds and every action is exercised', () => {
    const d = docChromeDecl('t-chrome');
    const { failures, coverage } = checkDeclLaws(d, generatorFor(d.name), { seeds: 60, length: 30 });
    expect(failures).toEqual([]);
    for (const [a, n] of Object.entries(coverage)) expect([a, n > 0]).toEqual([a, true]);
  });
  it('is absolute and idempotent; junk repairs to the default; the popover and the pick are not saved', () => {
    const storage = mem();
    const r = createReplica(docChromeDecl('t-chrome2'), { storage, device: 'x', schedule: (f) => f() });
    r.dispatch('side.set', { mode: 'history' }); r.dispatch('side.set', { mode: 'history' });
    r.dispatch('tab.open', { id: 'b2' }); r.dispatch('tab.open', { id: 'Not Valid' });
    r.dispatch('outline.fold', { id: 'h1', on: true }); r.dispatch('outline.fold', { id: 'h1', on: true }); r.dispatch('outline.fold', { id: 'h2', on: true }); r.dispatch('outline.fold', { id: 'h2', on: false });
    r.dispatch('fmt.set', { panel: 'color' }); r.dispatch('hist.pick', { key: 'cur' });
    expect(r.get()).toMatchObject({ side: 'history', tab: 'main', shut: { h1: true }, fmt: 'color', pick: 'cur', mode: 'editing' });
    r.dispatch('side.set', { mode: 'bogus' }); expect(r.get().side).toBeNull();
    // a reload keeps the sidebar, the folds and the mode, and drops the popover and the pick
    r.dispatch('side.set', { mode: 'nav' }); r.dispatch('mode.set', { mode: 'suggesting' });
    const again = createReplica(docChromeDecl('t-chrome2'), { storage, device: 'x', schedule: (f) => f() });
    expect(again.get()).toMatchObject({ side: 'nav', shut: { h1: true }, mode: 'suggesting', fmt: null, pick: null });
  });
});
