// lib/versions.js: history as a pure fold of the stream at a stamp, sessions, diffs, restore as new absolute writes (never a
// rewind), named versions as rows of the document. Planted: a restore that rewrote the log (dropped later entries) would
// lose the offline device's later write; here the fold of the log after a restore still holds every entry.
import { describe, expect, it } from 'vitest';
import { stampOf, foldRows } from '../lib/engine/rows.js';
import { foldAt, lastStamp, sessionsOf, diffRows, restorePuts, nameVersionPuts, renameVersionPuts, forgetVersionPuts, versionsOf, isVersionRow } from '../lib/versions.js';

const T0 = Date.UTC(2026, 10, 12, 18, 0, 0);
const S = (min, writer, l = 0) => stampOf(T0 + min * 60_000, writer, l);
const entry = (device, seq, ...patches) => ({ entry_id: `${device}:${seq}`, device_id: device, device_seq: seq, event_time: '', payload: { type: 'rows', payload: { rows: patches } } });
const patch = (id, stamp, set) => ({ id, set, at: Object.fromEntries(Object.keys(set).map((k) => [k, stamp])) });
const body = (m, id) => m.get(id)?.body;

// alice (device aa, tab x) writes lines 1-2, bob (device bb) edits line 2, alice edits line 1 much later, bob deletes line 2
const log = [
  entry('aa', 1, patch('l1', S(0, 'aa-x'), { body: 'hello', zone: 'timeline', ord: 1, mvseen: '' }), patch('l2', S(0, 'aa-x', 1), { body: 'world', zone: 'timeline', ord: 2, mvseen: '' })),
  entry('aa', 2, patch('l1', S(2, 'aa-x'), { body: 'hello there' })),
  entry('bb', 1, patch('l2', S(5, 'bb-y'), { body: 'brave world' })),
  entry('aa', 3, patch('l1', S(60, 'aa-x'), { body: 'hello again' })),
  entry('bb', 2, patch('l2', S(61, 'bb-y'), { deleted_at: '2026-11-12T19:01:00.000Z' })),
];

describe('foldAt: the document as of a stamp', () => {
  it('with no horizon it is the live fold; with one it holds only writes stamped at or before it', () => {
    const now = foldAt(log);
    const live = new Map(); foldRows(live, log);
    expect([...now.keys()].sort()).toEqual([...live.keys()].sort());
    expect(body(now, 'l1')).toBe('hello again');
    const early = foldAt(log, S(3, 'zz'));
    expect(body(early, 'l1')).toBe('hello there'); expect(body(early, 'l2')).toBe('world');
    const mid = foldAt(log, S(10, 'zz'));
    expect(body(mid, 'l2')).toBe('brave world'); expect(mid.get('l2').deleted_at).toBeUndefined();
    expect(foldAt(log, S(-5, 'zz')).size).toBe(0);
  });
  it('is the same whatever order the entries arrive in (the log is a set under per-field LWW)', () => {
    const shuffled = [log[4], log[2], log[0], log[3], log[1]];
    for (const h of [null, S(3, 'zz'), S(10, 'zz'), S(61, 'zz')]) {
      const a = foldAt(log, h), b = foldAt(shuffled, h);
      expect([...a.entries()].map(([k, v]) => [k, v.body, v.deleted_at]).sort()).toEqual([...b.entries()].map(([k, v]) => [k, v.body, v.deleted_at]).sort());
    }
  });
  it('a late arrival stamped before the horizon belongs to the version once it arrives', () => {
    const h = S(10, 'zz');
    const before = body(foldAt(log, h), 'l1');
    const late = entry('cc', 1, patch('l1', S(7, 'cc-z'), { body: 'offline edit' }));
    expect(before).toBe('hello there');
    expect(body(foldAt([...log, late], h), 'l1')).toBe('offline edit');
  });
  it('lastStamp is the horizon of the current version', () => { expect(lastStamp(log)).toBe(S(61, 'bb-y')); expect(lastStamp([])).toBeNull(); });
});

describe('sessions', () => {
  it('group by writer and a quiet gap, newest first, with the rows they touched', () => {
    const s = sessionsOf(log);
    expect(s.map((x) => [x.writer, x.entries, x.rows])).toEqual([['bb', 1, 1], ['aa', 1, 1], ['bb', 1, 1], ['aa', 2, 2]]);
    expect(s[3].key).toBe(S(2, 'aa-x')); expect(s[3].from).toBe(S(0, 'aa-x'));
    expect(sessionsOf(log, { gapMs: 60_000 })).toHaveLength(5); // a quiet gap of more than a minute splits one writer's run
    expect(sessionsOf(log, { gapMs: 24 * 60 * 60_000 })).toHaveLength(4); // writers alternate, so a long gap never merges them
  });
  it('a session key is a stamp: stable, unique, and the horizon its preview folds at', () => {
    const keys = sessionsOf(log).map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(body(foldAt(log, sessionsOf(log)[3].key), 'l1')).toBe('hello there');
  });
});

describe('diff and restore', () => {
  const v1 = foldAt(log, S(3, 'zz')), cur = foldAt(log);
  it('diff names added, changed and removed rows', () => {
    expect(diffRows(foldAt(log, S(-1, 'z')), v1)).toEqual({ added: ['l1', 'l2'], changed: [], removed: [] });
    expect(diffRows(v1, foldAt(log, S(10, 'z')))).toEqual({ added: [], changed: ['l2'], removed: [] });
    expect(diffRows(foldAt(log, S(10, 'z')), cur)).toEqual({ added: [], changed: ['l1'], removed: ['l2'] });
  });
  it('restore is new absolute writes: applying it to the live fold gives the snapshot, and the log keeps every entry', () => {
    const at = T0 + 120 * 60_000;
    const puts = restorePuts(cur, v1, at);
    const byId = Object.fromEntries(puts.map((p) => [p.id, p.set]));
    expect(byId.l1.body).toBe('hello there'); expect(byId.l1.mvseen).toBe('');
    expect(byId.l2).toMatchObject({ body: 'world', deleted_at: null });
    // the store stamps each field later than anything seen: simulate it and fold
    const restore = entry('aa', 4, ...puts.map((p) => patch(p.id, S(130, 'aa-x'), p.set)));
    const after = foldAt([...log, restore]);
    expect(body(after, 'l1')).toBe('hello there'); expect(body(after, 'l2')).toBe('world'); expect(after.get('l2').deleted_at).toBeNull();
    // history is intact: the version before the restore is still there to open and restore again
    expect(body(foldAt([...log, restore], S(100, 'zz')), 'l1')).toBe('hello again');
    expect(foldAt([...log, restore], S(100, 'zz')).get('l2').deleted_at).toBe('2026-11-12T19:01:00.000Z');
  });
  it('restoring is idempotent by value: a second restore of the same snapshot writes nothing', () => {
    const restore = entry('aa', 4, ...restorePuts(cur, v1, T0).map((p) => patch(p.id, S(130, 'aa-x'), p.set)));
    const now = foldAt([...log, restore]);
    expect(restorePuts(now, v1, T0 + 1)).toEqual([]);
  });
  it('a row the snapshot never had is tombstoned; version rows are never touched; a no-op restore is empty', () => {
    const snap = foldAt(log, S(3, 'zz'));
    const withExtra = new Map(cur); withExtra.set('l9', { id: 'l9', kind: 'text', body: 'new', zone: 'timeline', ord: 9 });
    withExtra.set('ver:abcdef', { id: 'ver:abcdef', kind: 'version', body: 'v', vat: S(1, 'a') });
    const puts = restorePuts(withExtra, snap, T0, { skip: isVersionRow });
    expect(puts.find((p) => p.id === 'l9').set.deleted_at).toBeTruthy();
    expect(puts.find((p) => p.id === 'ver:abcdef')).toBeUndefined();
    expect(restorePuts(snap, snap, T0)).toEqual([]);
  });
});

describe('named versions are rows of the document', () => {
  const at = T0;
  it('name, rename and forget are absolute writes; the id is minted by the action so a retry is the same row', () => {
    const [n] = nameVersionPuts('v00001', '  Draft   one ', S(3, 'zz'), at);
    expect(n.id).toBe('ver:v00001'); expect(n.set).toMatchObject({ kind: 'version', body: 'Draft one', vat: S(3, 'zz') }); expect(n.set.zone).toBeUndefined();
    expect(nameVersionPuts('v00001', '  Draft   one ', S(3, 'zz'), at)).toEqual([n]);
    expect(nameVersionPuts('bad id', 'x', 'h', at)).toEqual([]); expect(nameVersionPuts('v00001', '   ', 'h', at)).toEqual([]); expect(nameVersionPuts('v00001', 'x', '', at)).toEqual([]);
    expect(renameVersionPuts('v00001', 'Final', at)[0].set).toMatchObject({ body: 'Final' });
    expect(renameVersionPuts('v00001', 'Final', at)[0].set.vat).toBeUndefined(); // the horizon is its identity
    expect(forgetVersionPuts('v00001', at)[0].set.deleted_at).toBeTruthy();
  });
  it('versionsOf lists the live named versions by horizon', () => {
    const rows = [
      { id: 'ver:v00002', kind: 'version', body: 'Later', vat: S(50, 'a'), created_at: 'x' }, { id: 'ver:v00001', kind: 'version', body: 'Earlier', vat: S(3, 'a') },
      { id: 'ver:v00003', kind: 'version', body: 'Gone', vat: S(9, 'a'), deleted_at: 'y' }, { id: 'ver:v00004', kind: 'version', body: 'no horizon' }, { id: 'l1', kind: 'text', body: 'x', zone: 'timeline' },
    ];
    expect(versionsOf(rows).map((v) => v.name)).toEqual(['Earlier', 'Later']);
  });
  it('a version row has no zone, so it is not a live line of any editor', () => {
    const live = (r) => !r.deleted_at && typeof r.zone === 'string';
    const [n] = nameVersionPuts('v00001', 'x', 'h', at);
    expect(live({ id: n.id, ...n.set })).toBe(false);
  });
});
