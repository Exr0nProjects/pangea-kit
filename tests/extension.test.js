// Extensions v1 gate (docs/EXTENSIONS-V1.md section 10): every refusal rule has a planted extension that must turn it red,
// plus the positive path (load order, capability-checked dispatch, derived intent ids, actor and caused_by).
import { describe, expect, it } from 'vitest';
import {
  CORE_SURFACE, ExtensionError, checkManifest, createDispatcher, derivedId, findCycles, loadSet, providesOf,
  recordExtension, resolveOrder, runReactions, satisfies,
} from '../lib/extension.js';
import { CapabilityViolationError } from '../lib/errors.js';

const base = (over = {}) => ({ id: 'foo', version: '1.0.0', api: 1, depends: { core: '^1' }, ...over });
const good = {
  manifest: base({
    provides: { commands: ['ext.foo.bump'], menus: ['ui.sidebar.chatMenu:ext.foo.bump'], rules: ['count-archives'], routes: ['POST /api/foo'] },
    capabilities: { observe: ['core.chat.archive'], dispatch: ['core.chat.markRead'] },
  }),
  register: (x) => {
    x.command('ext.foo.bump', { title: 'Bump', run: () => 1 });
    x.menu('ui.sidebar.chatMenu', { title: 'Bump', command: 'ext.foo.bump' });
    x.on('count-archives', 'core.chat.archive', async (act, ctx) => ctx.dispatch('core.chat.markRead', { id: act.payload.id, read: true }), { emits: ['core.chat.markRead'] });
    x.route({ method: 'POST', path: '/api/foo', auth: 'own', handler: () => new Response('ok') });
  },
};
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'NO_ERROR'; };
const refusedCode = (items) => loadSet(items).refused.map((r) => r.code);

describe('extension manifest', () => {
  it('accepts a good manifest and normalises it', () => {
    const m = checkManifest(good.manifest);
    expect(m.capabilities.observe).toEqual(['core.chat.archive']);
    expect(m.runtime).toBe('server');
  });
  it('planted: an unknown manifest key is refused', () => expect(code(() => checkManifest(base({ hooks: [] })))).toBe('UNKNOWN_KEY'));
  it('planted: an unknown provides key is refused', () => expect(code(() => checkManifest(base({ provides: { widgets: [] } })))).toBe('UNKNOWN_KEY'));
  it('planted: a capability on a core action core does not publish is refused', () => expect(code(() => checkManifest(base({ capabilities: { dispatch: ['core.chat.delete'] } })))).toBe('UNKNOWN_CORE_ACTION'));
  it('planted: a guard capability (no executor in v1) is refused', () => expect(code(() => checkManifest(base({ capabilities: { guard: ['core.chat.archive'] } })))).toBe('NOT_EXECUTED'));
  it('planted: a bad version and a reserved id are refused', () => {
    expect(code(() => checkManifest(base({ version: '1.0' })))).toBe('BAD_VERSION');
    expect(code(() => checkManifest(base({ id: 'core' })))).toBe('BAD_ID');
  });
});

describe('versions and order', () => {
  it('ranges', () => {
    expect(satisfies('1.4.2', '^1.2.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false);
    expect(satisfies('1.2.9', '~1.2.0')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.0')).toBe(false);
    expect(satisfies('0.3.1', '^0.3.0')).toBe(true);
    expect(satisfies('0.4.0', '^0.3.0')).toBe(false);
    expect(satisfies('1.0.0', '>=0.9.0')).toBe(true);
    expect(code(() => satisfies('1.0.0', 'latest'))).toBe('BAD_RANGE');
  });
  it('orders by dependency, ties by id', () => {
    const ms = [base({ id: 'c', depends: { b: '^1' } }), base({ id: 'b', depends: { a: '^1' } }), base({ id: 'a' }), base({ id: 'z' })].map((m) => checkManifest(m));
    expect(resolveOrder(ms).order).toEqual(['a', 'b', 'c', 'z']);
  });
  it('planted: a missing dependency refuses the extension and its dependents', () => {
    const ms = [base({ id: 'b', depends: { a: '^1' } }), base({ id: 'c', depends: { b: '^1' } })].map((m) => checkManifest(m));
    const r = resolveOrder(ms);
    expect(r.order).toEqual([]);
    expect(r.problems.map((p) => p.code).sort()).toEqual(['DEPENDENCY_MISSING', 'DEPENDENCY_REFUSED']);
  });
  it('planted: an out-of-range dependency is refused', () => {
    const ms = [base({ id: 'a', version: '2.0.0' }), base({ id: 'b', depends: { a: '^1' } })].map((m) => checkManifest(m));
    expect(resolveOrder(ms).problems[0].code).toBe('DEPENDENCY_RANGE');
  });
  it('planted: a core version out of range is refused', () => {
    expect(resolveOrder([checkManifest(base({ depends: { core: '^2' } }))]).problems[0].code).toBe('DEPENDENCY_RANGE');
  });
  it('planted: a dependency cycle is refused (Tarjan)', () => {
    const ms = [base({ id: 'a', depends: { b: '^1' } }), base({ id: 'b', depends: { a: '^1' } }), base({ id: 'c' })].map((m) => checkManifest(m));
    const r = resolveOrder(ms);
    expect(r.order).toEqual(['c']);
    expect(r.problems.some((p) => p.code === 'DEPENDENCY_CYCLE' && p.cycle.join() === 'a,b')).toBe(true);
    expect(findCycles(new Map([['x', ['x']]]))).toEqual([['x']]);
  });
  it('a missing optional dependency degrades, not refuses', () => {
    const r = loadSet([{ manifest: base({ id: 'b', optional: { reader: '^1' } }) }]);
    expect(r.order).toEqual(['b']);
    expect(r.missingOptional).toEqual({ b: ['reader'] });
  });
});

describe('registration gate', () => {
  it('loads the good extension and reports what it provides', () => {
    const r = loadSet([good]);
    expect(r.refused).toEqual([]);
    expect(providesOf(r.regs[0])).toEqual({ commands: ['ext.foo.bump'], menus: ['ui.sidebar.chatMenu:ext.foo.bump'], routes: ['POST /api/foo'], rules: ['count-archives'] });
  });
  it('planted: a registration missing from provides is refused', () => {
    expect(refusedCode([{ ...good, register: (x) => { good.register(x); x.tool('foo-tool', 'bin/foo'); } }])).toEqual(['UNDECLARED_REGISTRATION']);
  });
  it('planted: provides naming something never registered is refused', () => {
    expect(refusedCode([{ ...good, register: (x) => { x.command('ext.foo.bump', { title: 'Bump', run: () => 1 }); x.menu('ui.sidebar.chatMenu', { title: 'Bump', command: 'ext.foo.bump' }); x.on('count-archives', 'core.chat.archive', () => {}); } }])).toEqual(['UNREGISTERED_PROVIDES']);
  });
  it('planted: observing outside capabilities.observe is refused', () => {
    const m = { ...good.manifest, capabilities: { observe: [], dispatch: ['core.chat.markRead'] } };
    expect(refusedCode([{ manifest: m, register: good.register }])).toEqual(['CAPABILITY_OBSERVE']);
  });
  it('planted: a rule emitting outside capabilities.dispatch is refused', () => {
    const m = { ...good.manifest, capabilities: { observe: ['core.chat.archive'], dispatch: [] } };
    expect(refusedCode([{ manifest: m, register: good.register }])).toEqual(['CAPABILITY_DISPATCH']);
  });
  it('planted: a menu item running a core action without capability is refused', () => {
    const m = base({ provides: { menus: ['ui.sidebar.chatMenu:core.chat.open'] } });
    expect(refusedCode([{ manifest: m, register: (x) => x.menu('ui.sidebar.chatMenu', { title: 'Open', command: 'core.chat.open' }) }])).toEqual(['CAPABILITY_DISPATCH']);
  });
  it('planted: a rule that emits what it observes without a re-entry guard is refused (emit-graph cycle)', () => {
    const m = base({ provides: { rules: ['loop'] }, capabilities: { observe: ['core.chat.archive'], dispatch: ['core.chat.archive'] } });
    expect(refusedCode([{ manifest: m, register: (x) => x.on('loop', 'core.chat.archive', () => {}, { emits: ['core.chat.archive'] }) }])).toEqual(['EMIT_CYCLE']);
    expect(refusedCode([{ manifest: m, register: (x) => x.on('loop', 'core.chat.archive', () => {}, { emits: ['core.chat.archive'], reentry: 'guarded' }) }])).toEqual([]);
  });
  it('planted: two registrations of one name are refused (never last-wins)', () => {
    const m = base({ provides: { commands: ['ext.foo.a'] } });
    expect(refusedCode([{ manifest: m, register: (x) => { x.command('ext.foo.a', { title: 'A', run: () => 1 }); x.command('ext.foo.a', { title: 'A2', run: () => 2 }); } }])).toEqual(['DUPLICATE_NAME']);
  });
  it('planted: two extensions claiming one route are refused (single-valued slot)', () => {
    const route = (id) => ({ manifest: base({ id, provides: { routes: ['POST /api/x'] } }), register: (x) => x.route({ method: 'POST', path: '/api/x', auth: 'own', handler: () => null }) });
    const r = loadSet([route('a'), route('b')]);
    expect(r.order).toEqual(['a']);
    expect(r.refused.map((x) => x.code)).toEqual(['SLOT_COLLISION']);
  });
  it('planted: a route without an auth mode, a command outside its namespace, an async register are refused', () => {
    expect(refusedCode([{ manifest: base({ provides: { routes: ['GET /x'] } }), register: (x) => x.route({ path: '/x', handler: () => null }) }])).toEqual(['BAD_ROUTE']);
    expect(refusedCode([{ manifest: base({ provides: { commands: ['ext.bar.x'] } }), register: (x) => x.command('ext.bar.x', { title: 'x', run: () => 1 }) }])).toEqual(['BAD_NAME']);
    expect(refusedCode([{ manifest: base(), register: async () => {} }])).toEqual(['ASYNC_REGISTER']);
  });
  it('planted: a menu item naming a core action whose payload needs more than the chat id is refused', () => {
    const m = base({ provides: { menus: ['ui.sidebar.chatMenu:core.chat.pin'] }, capabilities: { dispatch: ['core.chat.pin'] } });
    expect(refusedCode([{ manifest: m, register: (x) => x.menu('ui.sidebar.chatMenu', { title: 'Pin', command: 'core.chat.pin' }) }])).toEqual(['MENU_PAYLOAD']);
  });
  it('an unknown UI slot is refused', () => {
    expect(refusedCode([{ manifest: base({ provides: { menus: ['ui.nowhere:ext.foo.a'] } }), register: (x) => x.menu('ui.nowhere', { title: 'a', command: 'ext.foo.a' }) }])).toEqual(['UNKNOWN_SLOT']);
  });
});

describe('dispatch: capability, actor, caused_by, derived ids', () => {
  it('stamps actor and a minted-once id; refuses an undeclared core action', async () => {
    const m = checkManifest(good.manifest);
    const seen = [];
    const d = createDispatcher(m, async (type, payload, meta) => { seen.push({ type, payload, meta }); return { ok: true }; });
    await d('core.chat.markRead', { id: 'c1', read: true }, { id: 'intent-1' });
    expect(seen[0].meta).toEqual({ id: 'intent-1', actor: 'app:foo', caused_by: null, correlation_id: 'intent-1' });
    await expect(d('core.chat.archive', { id: 'c1', on: true }, { id: 'i2' })).rejects.toBeInstanceOf(CapabilityViolationError);
    await expect(d('core.chat.markRead', { id: 'c1', read: true })).rejects.toBeInstanceOf(ExtensionError);
    expect(seen).toHaveLength(1);
  });
  it('a reaction derives its id from the trigger, so redelivery makes one entry', async () => {
    const { regs } = loadSet([good]);
    const log = new Map();
    const core = async (type, payload, meta) => { log.set(meta.id, { type, payload, meta }); return { ok: true }; };
    const trigger = { id: 'A1', type: 'core.chat.archive', payload: { id: 'c9', on: true } };
    await runReactions(regs, trigger, core);
    await runReactions(regs, trigger, core);
    expect([...log.keys()]).toEqual([derivedId('A1', 'foo', 'count-archives')]);
    expect(log.get('A1.foo.count-archives').meta).toMatchObject({ actor: 'app:foo', caused_by: 'A1', correlation_id: 'A1' });
  });
  it('one rule failing does not stop another, and never throws into core', async () => {
    const bad = { manifest: base({ id: 'bad', provides: { rules: ['boom'] }, capabilities: { observe: ['core.chat.archive'] } }), register: (x) => x.on('boom', 'core.chat.archive', () => { throw new Error('boom'); }) };
    const { regs } = loadSet([bad, good]);
    const r = await runReactions(regs, { id: 'A2', type: 'core.chat.archive', payload: { id: 'c', on: true } }, async () => ({ ok: true }));
    expect(r.map((x) => [x.ext, x.ok])).toEqual([['bad', false], ['foo', true]]);
  });
  it('an absent optional extension answers DEPENDENCY_MISSING instead of throwing', async () => {
    const m = checkManifest(base({ optional: { reader: '^1' }, capabilities: { dispatch: [] } }));
    const d = createDispatcher({ ...m, capabilities: { ...m.capabilities, dispatch: ['ext.reader.save'] } }, async () => ({ ok: true }), { missingOptional: ['reader'] });
    expect(await d('ext.reader.save', {}, { id: 'x' })).toEqual({ ok: false, code: 'DEPENDENCY_MISSING', type: 'ext.reader.save' });
  });
  it('core surface names are all core.*', () => expect(Object.keys(CORE_SURFACE).every((k) => k.startsWith('core.'))).toBe(true));
});

describe('recordExtension directly', () => {
  it('returns handlers as functions', () => {
    const reg = recordExtension(checkManifest(good.manifest), good.register);
    expect(typeof reg.routes[0].handler).toBe('function');
  });
});
