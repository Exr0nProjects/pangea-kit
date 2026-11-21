// lib/comments.js: comments on a document of lines (zai3 docs; the generic half of webchat's public-document comments).
// Laws over the three declarations (validate's checkDeclLaws, every action exercised), the merge rules (a comment id is
// written once, a resolve is last-writer-wins), anchors that survive edits and moves and detach rather than drop, the
// op log delivered through the sink (offline keeps it pending, a refusal for good acknowledges it and says why), the
// overlay view, and the rail's stacking without overlap. Planted: a sink that swallows offline errors loses the comment.
import { describe, expect, it } from 'vitest'
import { checkDeclLaws } from '../lib/laws.js'
import { generatorFor } from '../lib/declare-keys.js'
import { createReplica } from '../lib/model.js'
import { anchorOf, resolveAnchor, locateThread, isCommentChord, cleanOp, commentAdd, threadResolve, threadDelete, commentsDecl, threadCacheDecl, commentsUiDecl, threadsOf, overlayThreads, stackCards, commentSink, postOps, threadAtPoint, rangeIsStale } from '../lib/comments.js'

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) } }
const add = (id, threadId, body, at = '2026-11-11T00:00:00.000Z') => ({ id, threadId, lineId: 'l1', quote: 'brown fox', start: 4, end: 13, body, at })

describe('comments: declarations', () => {
  it('every law holds over each declaration and every action is exercised', () => {
    for (const d of [commentsDecl('t-comments'), threadCacheDecl('t-cache'), commentsUiDecl('t-ui')]) {
      const { failures, coverage } = checkDeclLaws(d, generatorFor(d.name), { seeds: 40, length: 24 })
      expect(failures).toEqual([])
      for (const [a, n] of Object.entries(coverage)) expect([d.name, a, n > 0]).toEqual([d.name, a, true])
    }
  })
  it('a comment id is written once (the first copy stands); junk is a no-op', () => {
    let c = commentAdd({}, add('c000001', 't000001', 'first'))
    const same = commentAdd(c, add('c000001', 't000001', 'second'))
    expect(same).toBe(c); expect(c.c000001.body).toBe('first')
    expect(commentAdd(c, { id: 'x' })).toBe(c)
    expect(commentAdd(c, { ...add('c000002', 't000001', '   ') })).toBe(c)
    c = commentAdd(c, add('c000002', 't000001', 'reply', '2026-11-11T00:00:05.000Z'))
    expect(threadsOf({ comments: c, resolved: {} })[0].comments.map((x) => x.body)).toEqual(['first', 'reply'])
  })
  it('a resolve is last-writer-wins on its time; a replay is a no-op', () => {
    let r = threadResolve({}, { threadId: 't000001', resolved: true, at: '2026-11-11T00:00:02.000Z' })
    expect(threadResolve(r, { threadId: 't000001', resolved: false, at: '2026-11-11T00:00:01.000Z' })).toBe(r)
    expect(threadResolve(r, { threadId: 't000001', resolved: true, at: '2026-11-11T00:00:02.000Z' })).toBe(r)
    r = threadResolve(r, { threadId: 't000001', resolved: false, at: '2026-11-11T00:00:03.000Z' })
    expect(r.t000001.resolved).toBe(false)
  })
  it('a delete is an absolute tombstone: idempotent, commutative with the comments it deletes, never undone, the earliest time kept; the thread is gone from threadsOf whatever the order of arrival', () => {
    const d1 = threadDelete({}, { threadId: 't000001', at: '2026-11-11T00:00:09.000Z' })
    expect(threadDelete(d1, { threadId: 't000001', at: '2026-11-11T00:00:09.000Z' })).toBe(d1)
    expect(threadDelete(d1, { threadId: 't000001', at: '2026-11-11T00:00:10.000Z' })).toBe(d1)
    expect(threadDelete(d1, { threadId: 't000001', at: '2026-11-11T00:00:01.000Z' }).t000001.at).toBe('2026-11-11T00:00:01.000Z')
    expect(threadDelete(d1, { threadId: 'bad id' })).toBe(d1)
    const mk = (order) => { const r = createReplica(commentsDecl(`t-del-${order.join('')}`), { storage: mem(), device: 'dv', schedule: (f) => f() }); const ops = { a: ['comment.add', add('c000001', 't000001', 'hi')], b: ['comment.add', add('c000002', 't000001', 'reply', '2026-11-11T00:00:05.000Z')], d: ['thread.delete', { threadId: 't000001', at: '2026-11-11T00:00:09.000Z' }], k: ['comment.add', add('c000003', 't000002', 'other')] }; for (const o of order) r.dispatch(...ops[o]); return threadsOf(r.get()).map((t) => t.id) }
    for (const order of [['a', 'b', 'd', 'k'], ['d', 'a', 'b', 'k'], ['a', 'd', 'k', 'b'], ['k', 'd', 'b', 'a']]) expect(mk(order)).toEqual(['t000002'])
  })
  it('cleanOp takes only the three ops, repaired; the server sets the author, a client author is only a hint', () => {
    expect(cleanOp({ type: 'comment.edit', payload: {} })).toBeNull()
    expect(cleanOp({ type: 'comment.add', payload: { ...add('c000001', 't000001', 'x'.repeat(5000)) } }).payload.body.length).toBe(4000)
    expect(cleanOp({ type: 'thread.resolve', payload: { threadId: 'bad id' } })).toBeNull()
    expect(cleanOp({ type: 'thread.delete', payload: { threadId: 't000001', at: '2026-11-11T00:00:09.000Z', junk: 1 } })).toEqual({ type: 'thread.delete', payload: { threadId: 't000001', at: '2026-11-11T00:00:09.000Z' } })
    expect(cleanOp({ type: 'thread.delete', payload: { threadId: 7 } })).toBeNull()
  })
})

describe('comments: anchors', () => {
  const text = 'the quick brown fox jumps over the brown fox'
  it('a selection trims its blank edges and keeps context', () => {
    const a = anchorOf('l1', text, 9, 20)
    expect(a).toMatchObject({ lineId: 'l1', quote: 'brown fox', start: 10, end: 19, prefix: 'the quick ' })
    expect(anchorOf('l1', text, 3, 4)).toBeNull()
  })
  it('finds the words after an edit, picks the right twin by context, matches loosely over reflowed blanks, and is null when the words are gone', () => {
    const a = anchorOf('l1', text, 35, 44) // the second "brown fox"
    expect(resolveAnchor(`XX${text}`, a)).toMatchObject({ start: 37, how: 'context' })
    expect(resolveAnchor('a brown   fox here', { quote: 'brown fox', start: 0 })).toMatchObject({ start: 2, how: 'loose' })
    expect(resolveAnchor('nothing like it', a)).toBeNull()
  })
  it('a thread follows its words to another line; one whose words are nowhere is detached (null), never dropped from the list', () => {
    const t = { lineId: 'l1', quote: 'brown fox', start: 10 }
    expect(locateThread(t, [{ lineId: 'l1', text: 'edited' }, { lineId: 'l2', text: 'a brown fox' }])).toMatchObject({ lineId: 'l2', start: 2, moved: true })
    expect(locateThread(t, [{ lineId: 'l1', text: 'gone' }])).toBeNull()
  })
  it('the chord is mod+alt+m: ⌘⌥M on a Mac by key or character (µ), Ctrl+Alt+M elsewhere; never with shift, never the other platform\'s modifier', () => {
    expect(isCommentChord({ metaKey: true, altKey: true, key: 'µ', code: 'KeyM' }, { mac: true })).toBe(true)
    expect(isCommentChord({ metaKey: true, altKey: true, key: 'm', code: 'Period' }, { mac: true })).toBe(true) // Dvorak: the character
    expect(isCommentChord({ ctrlKey: true, altKey: true, key: 'm' }, { mac: false })).toBe(true)
    expect(isCommentChord({ ctrlKey: true, altKey: true, key: 'm' }, { mac: true })).toBe(false) // ⌃⌥M on a Mac is not the chord
    expect(isCommentChord({ metaKey: true, altKey: true, shiftKey: true, key: 'm' }, { mac: true })).toBe(false)
    expect(isCommentChord({ metaKey: true, key: 'm' }, { mac: true })).toBe(false)
  })
})

describe('comments: delivery', () => {
  const decl = commentsDecl('t-sink')
  const replica = (post, extra = {}) => createReplica(decl, { storage: mem(), device: 'dev1', transport: commentSink({ post, ...extra }), schedule: (f) => f() })
  it('offline keeps the comment pending (shown at once through the overlay) and the next sync delivers it once', async () => {
    let online = false; const got = []
    const post = async (ops) => { if (!online) throw Object.assign(new Error('offline'), { offline: true }); got.push(...ops); return { threads: [{ id: 't000001', lineId: 'l1', quote: 'brown fox', comments: [{ id: 'c000001', body: 'hi', author: 'srv' }] }] } }
    let adopted = null
    const r = createReplica(decl, { storage: mem(), device: 'dev1', transport: commentSink({ post, adopt: (t) => { adopted = t } }), schedule: (f) => f() })
    r.dispatch('comment.add', add('c000001', 't000001', 'hi'))
    await expect(r.sync()).rejects.toThrow('offline')
    expect(r.pending).toHaveLength(1)
    const shown = overlayThreads([], r.pending, { me: 'me' })
    expect(shown[0]).toMatchObject({ id: 't000001', pending: true }); expect(shown[0].comments[0]).toMatchObject({ body: 'hi', author: 'me', pending: true })
    online = true
    await r.sync(); await r.sync()
    expect(got.map((o) => o.payload.id)).toEqual(['c000001'])
    expect(r.pending).toHaveLength(0); expect(adopted[0].comments[0].author).toBe('srv')
  })
  it('a refusal for good is acknowledged and reported, never retried for ever', async () => {
    const why = []; let calls = 0
    const r = replica(async () => { calls += 1; throw new Error('you can view this doc, not comment') }, { refuse: (m) => why.push(m) })
    r.dispatch('thread.resolve', { threadId: 't000001', resolved: true, at: '2026-11-11T00:00:00.000Z' })
    await r.sync(); await r.sync()
    expect(calls).toBe(1); expect(r.pending).toHaveLength(0); expect(why).toEqual(['you can view this doc, not comment'])
  })
  it('planted: a sink that swallows an offline error acknowledges the entry and the comment is lost (red without the rethrow)', async () => {
    const lossy = { push: async () => {}, pull: async (_s, c) => ({ entries: [], cursor: c ?? null, more: false }) }
    const r = createReplica(decl, { storage: mem(), device: 'dev2', transport: lossy, schedule: (f) => f() })
    r.dispatch('comment.add', add('c000009', 't000009', 'lost'))
    await r.sync()
    expect(r.pending).toHaveLength(0) // gone without delivery: the real sink rethrows offline so this cannot happen
  })
  it('postOps over HTTP: no answer, a 5xx or a non-JSON page is offline (kept); a 4xx is the server\'s verdict (acknowledged)', async () => {
    const res = (status, body, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } })
    const calls = []
    const answers = [() => { throw new TypeError('network') }, () => res(502, '<html>bad gateway</html>', 'text/html'), () => res(503, { error: 'busy' }), () => res(403, { error: 'you can view this doc, not comment on it' }), () => res(200, { threads: [] })]
    const post = postOps('/api/docs/x/comments', { fetch: async (u, init) => { calls.push([u, init.method, JSON.parse(init.body)]); return answers.shift()() } })
    for (let i = 0; i < 3; i++) await expect(post([{ type: 'comment.add', payload: {} }])).rejects.toMatchObject({ offline: true })
    await expect(post([])).rejects.toThrow('you can view this doc, not comment on it')
    await expect(post([])).resolves.toEqual({ threads: [] })
    expect(calls[0]).toEqual(['/api/docs/x/comments', 'POST', { ops: [{ type: 'comment.add', payload: {} }] }])
  })
  it('an undelivered delete removes its thread from the overlay at once, with any undelivered reply to it; the server list is not mutated', () => {
    const server = [{ id: 't000001', lineId: 'l1', quote: 'q', comments: [{ id: 'c000001', body: 'a' }], resolvedAt: null }, { id: 't000002', lineId: 'l1', quote: 'q', comments: [{ id: 'c000009', body: 'z' }], resolvedAt: null }]
    const pending = [{ type: 'comment.add', payload: add('c000002', 't000001', 'b') }, { type: 'thread.delete', payload: { threadId: 't000001', at: 'z' } }]
    expect(overlayThreads(server, pending).map((t) => t.id)).toEqual(['t000002'])
    expect(server).toHaveLength(2)
  })
  it('the overlay flips a thread on an undelivered resolve and joins a reply to its thread', () => {
    const server = [{ id: 't000001', lineId: 'l1', quote: 'q', comments: [{ id: 'c000001', body: 'a' }], resolvedAt: null }]
    const pending = [{ type: 'comment.add', payload: add('c000002', 't000001', 'b') }, { type: 'thread.resolve', payload: { threadId: 't000001', resolved: true, at: 'z' } }]
    const [t] = overlayThreads(server, pending)
    expect(t.comments.map((c) => c.body)).toEqual(['a', 'b']); expect(t.resolvedAt).toBe('z')
    expect(server[0].comments).toHaveLength(1) // pure
  })
})

describe('comments: hit testing a highlight', () => {
  const rng = (rects, extra = {}) => ({ collapsed: false, startContainer: { isConnected: true }, getClientRects: () => rects.map(([l, t, r, b]) => ({ left: l, top: t, right: r, bottom: b })), ...extra })
  it('a press inside a highlight finds its thread; the slack is one px; a miss and a skipped (resolved) thread give null; a wrapped highlight is hit on every line of it', () => {
    const ranges = new Map([['t1', rng([[10, 10, 100, 28], [10, 28, 60, 46]])], ['t2', rng([[200, 10, 300, 28]])]])
    expect(threadAtPoint(ranges, 50, 20)).toBe('t1'); expect(threadAtPoint(ranges, 30, 40)).toBe('t1'); expect(threadAtPoint(ranges, 250, 20)).toBe('t2')
    expect(threadAtPoint(ranges, 101, 20)).toBe('t1'); expect(threadAtPoint(ranges, 103, 20)).toBeNull(); expect(threadAtPoint(ranges, 90, 40)).toBeNull()
    expect(threadAtPoint(ranges, 50, 20, { skip: (id) => id === 't1' })).toBeNull(); expect(threadAtPoint(new Map(), 1, 1)).toBeNull(); expect(threadAtPoint(null, 1, 1)).toBeNull()
  })
  it('the rects are read at the press, not cached: a range that moved is hit where it is now', () => {
    let top = 10; const r = { collapsed: false, startContainer: { isConnected: true }, getClientRects: () => [{ left: 0, top, right: 100, bottom: top + 18 }] }
    const ranges = new Map([['t1', r]])
    expect(threadAtPoint(ranges, 50, 15)).toBe('t1'); top = 200; expect(threadAtPoint(ranges, 50, 15)).toBeNull(); expect(threadAtPoint(ranges, 50, 210)).toBe('t1')
  })
  it('a collapsed or detached range is stale (the caller re-places it before testing) and is never a hit', () => {
    expect(rangeIsStale(rng([[0, 0, 9, 9]]))).toBe(false); expect(rangeIsStale(rng([], { collapsed: true }))).toBe(true)
    expect(rangeIsStale(rng([], { startContainer: { isConnected: false } }))).toBe(true); expect(rangeIsStale(null)).toBe(true)
    expect(threadAtPoint(new Map([['t1', rng([[0, 0, 100, 100]], { collapsed: true })]]), 5, 5)).toBeNull()
  })
})

describe('comments: the rail', () => {
  it('cards never overlap; the focused card sits at its span; the others move away from it', () => {
    const cards = [{ id: 'a', want: 100, h: 80 }, { id: 'b', want: 120, h: 60 }, { id: 'c', want: 130, h: 40 }]
    const free = stackCards(cards)
    expect(free).toEqual({ a: 100, b: 188, c: 256 })
    const f = stackCards(cards, { focus: 'c' })
    expect(f.c).toBe(130); expect(f.b + 60 + 8).toBeLessThanOrEqual(130); expect(f.a + 80 + 8).toBeLessThanOrEqual(f.b)
  })
  it('the ui state is absolute: a draft opened twice is one draft, empty text clears its key', () => {
    const d = commentsUiDecl('t-ui2'), r = createReplica(d, { storage: mem(), device: 'x', schedule: (f) => f() })
    const draft = { id: 't000005', lineId: 'l1', quote: 'w', start: 0, end: 1 }
    r.dispatch('draft.open', draft); r.dispatch('draft.open', draft)
    r.dispatch('text', { id: 't000005', text: 'hello' }); r.dispatch('text', { id: 't000005', text: '' })
    expect(r.get().drafts).toHaveLength(1); expect(r.get().text).toEqual({})
  })
  it('the delete button is armed by one absolute action (the first press), disarmed by another; arming twice is one state', () => {
    const r = createReplica(commentsUiDecl('t-ui3'), { storage: mem(), device: 'x', schedule: (f) => f() })
    r.dispatch('delete.arm', { id: 't000005' }); r.dispatch('delete.arm', { id: 't000005' })
    expect(r.get().armed).toBe('t000005')
    r.dispatch('delete.arm', { id: null }); expect(r.get().armed).toBeNull()
  })
})

describe('suggestions: a comment that proposes an edit of its anchor (docs parity v1.0)', () => {
  const sug = (kind, text, where) => ({ kind, text, where })
  it('cleanSuggestion keeps a valid proposal and drops junk; a delete carries no text; an insert or replace needs text', async () => {
    const { cleanSuggestion } = await import('../lib/comments.js')
    expect(cleanSuggestion(sug('replace', 'fox'))).toEqual({ kind: 'replace', text: 'fox', where: 'after' })
    expect(cleanSuggestion({ kind: 'delete', text: 'ignored' })).toEqual({ kind: 'delete', text: '', where: 'after' })
    expect(cleanSuggestion(sug('insert', 'big ', 'before'))).toEqual({ kind: 'insert', text: 'big ', where: 'before' })
    for (const bad of [null, {}, { kind: 'bogus' }, { kind: 'replace', text: '' }, { kind: 'insert' }, 'replace']) expect(cleanSuggestion(bad)).toBeNull()
  })
  it('the thread carries the suggestion of the comment that made it, an outcome with its resolve; junk suggestion leaves a plain comment', () => {
    const base = add('c000001', 't000001', 'replace “brown fox”')
    const decl = commentsDecl('t-sug'), r = createReplica(decl, { storage: mem(), device: 'x', schedule: (f) => f() })
    r.dispatch('comment.add', { ...base, suggestion: sug('replace', 'red fox') })
    r.dispatch('comment.add', { ...add('c000002', 't000002', 'plain note'), suggestion: { kind: 'bogus' } })
    let ts = threadsOf(r.get())
    expect(ts.find((t) => t.id === 't000001').suggestion).toEqual({ kind: 'replace', text: 'red fox', where: 'after' })
    expect(ts.find((t) => t.id === 't000002').suggestion).toBeUndefined()
    r.dispatch('thread.resolve', { threadId: 't000001', resolved: true, at: '2026-11-12T00:00:00.000Z', outcome: 'accepted' })
    r.dispatch('thread.resolve', { threadId: 't000001', resolved: true, at: '2026-11-12T00:00:00.000Z', outcome: 'accepted' }) // idempotent
    ts = threadsOf(r.get()); expect(ts.find((t) => t.id === 't000001')).toMatchObject({ resolvedAt: '2026-11-12T00:00:00.000Z', outcome: 'accepted' })
    r.dispatch('thread.resolve', { threadId: 't000001', resolved: false, at: '2026-11-12T00:00:01.000Z' })
    expect(threadsOf(r.get()).find((t) => t.id === 't000001').outcome).toBeNull()
  })
  it('a draft can be a suggestion in the making: kind and side survive, junk kinds are dropped', () => {
    const r = createReplica(commentsUiDecl('t-ui-sug'), { storage: mem(), device: 'x', schedule: (f) => f() })
    r.dispatch('draft.open', { id: 't000007', lineId: 'l1', quote: 'fox', start: 0, end: 3, sk: 'replace' })
    r.dispatch('draft.open', { id: 't000008', lineId: 'l1', quote: 'fox', start: 0, end: 3, sk: 'insert', sw: 'before' })
    r.dispatch('draft.open', { id: 't000009', lineId: 'l1', quote: 'fox', start: 0, end: 3, sk: 'bogus' })
    expect(r.get().drafts.map((d) => [d.id, d.sk, d.sw])).toEqual([['t000007', 'replace', 'after'], ['t000008', 'insert', 'before'], ['t000009', undefined, undefined]])
  })
  it('the overlay of undelivered entries shows a pending suggestion and its pending outcome', () => {
    const pending = [{ type: 'comment.add', payload: { ...add('c000009', 't000009', 'x'), suggestion: sug('delete') } }, { type: 'thread.resolve', payload: { threadId: 't000009', resolved: true, at: 'now', outcome: 'rejected' } }]
    const t = overlayThreads([], pending)[0]
    expect(t).toMatchObject({ pending: true, suggestion: { kind: 'delete' }, outcome: 'rejected' })
  })
})
