// Presence (lib/presence.js; PANGEA3-DESIGN §11 row 53, §15 "Embeds"): the model (set, drop, expire, last writer wins on `at`),
// the client (20 Hz throttle with a trailing value, a heartbeat that keeps `at` inside the 10 s ttl, away on blur and dispose,
// own echo dropped), the colours, the declaration's laws through validate(), and the editor: a `presence` action is state
// (state.peers), repaints only the peers' layer (no row commit, the rows' DOM is untouched), draws a caret with a name flag and a
// tint over a selection, expires after 10 s, and never disturbs the local editor's goal x, kill ring or pending select-all.
import { describe, expect, it } from 'vitest'
import { applyPresence, cleanPeer, colorOf, createPresence, presenceDecl, PALETTE, TTL_MS } from '../lib/presence.js'
import { createEditor, memoryLines, initState, step } from '../lib/editor/editor.js'
import { validate } from '../lib/validate.js'

const sel = (id, a, f = a) => ({ a: { id, off: a }, f: { id, off: f } })
const peer = (id, at, extra = {}) => ({ id, name: id, sel: sel('l1', 1), at, ...extra })

describe('presence model', () => {
  it('sets a peer, last writer wins on at, an older or identical one is the same reference', () => {
    let p = applyPresence({}, { peer: peer('u1:a', 100) })
    expect(Object.keys(p)).toEqual(['u1:a']); expect(p['u1:a'].color).toBe(colorOf('u1:a'))
    const q = applyPresence(p, { peer: peer('u1:a', 90, { sel: sel('l1', 4) }) })
    expect(q).toBe(p)
    expect(applyPresence(p, { peer: peer('u1:a', 100) })).toBe(p)
    expect(applyPresence(p, { peer: peer('u1:a', 120, { sel: sel('l1', 4) }) })['u1:a'].sel.f.off).toBe(4)
  })
  it('drop removes, expire removes what is older than the ttl, both the same reference when nothing changes', () => {
    let p = applyPresence(applyPresence({}, { peer: peer('a:1', 1000) }), { peer: peer('b:2', 9000) })
    expect(applyPresence(p, { drop: 'zz' })).toBe(p)
    expect(Object.keys(applyPresence(p, { drop: 'a:1' }))).toEqual(['b:2'])
    expect(applyPresence(p, { expire: 1000 + TTL_MS })).toBe(p)           // exactly the ttl: still here
    expect(Object.keys(applyPresence(p, { expire: 1000 + TTL_MS + 1 }))).toEqual(['b:2'])
    expect(Object.keys(applyPresence(p, { expire: 9000 + TTL_MS + 1 }))).toEqual([])
  })
  it('is total: junk is a no-op, a junk peer is refused, the colour is from the fixed palette', () => {
    const p = {}
    for (const j of [null, 5, {}, { peer: null }, { peer: { id: '' } }, { peer: { id: 'x', at: 'nope' } }, { drop: 4 }, { expire: 'x' }]) expect(applyPresence(p, j)).toBe(p)
    expect(cleanPeer({ id: 'x', at: 1, color: 'red' }).color).toBe(colorOf('x'))
    expect(PALETTE).toContain(colorOf('anything'))
    expect(cleanPeer({ id: 'x', at: 1, name: 'a\nb' }).name).toBe('a b')
  })
  it('validate() runs every law over the declaration (total, pure, noop reference, idempotent by value, reload) with every action covered', async () => {
    const d = presenceDecl('presence-test')
    const r = await validate({ decls: [d], ui: true, timing: false })
    expect(r.failures.map((f) => `${f.law}: ${f.detail}`).join('\n') || 'clean').toBe('clean')
    expect(r.decls[0].cases).toBeGreaterThan(100); expect(r.decls[0].uncovered).toEqual([])
  }, 60000)
})

describe('presence client', () => {
  const clock = () => {
    let t = 1000; const timers = []
    return { now: () => t, setTimer: (f, ms) => { const x = { f, at: t + ms }; timers.push(x); return x }, clearTimer: (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1) },
      advance(ms) { const end = t + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const n = timers[0]; if (!n || n.at > end) break; timers.shift(); t = n.at; n.f() } t = end }, timers }
  }
  it('sends the first caret at once, then at most 20 a second with the latest value trailing', () => {
    const c = clock(), out = []
    const p = createPresence({ cid: 'me', send: (x) => out.push({ ...x, t: c.now() }), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer })
    p.local(sel('l1', 0)); expect(out.length).toBe(1)
    for (let i = 1; i <= 9; i++) { c.advance(5); p.local(sel('l1', i)) }  // 45 ms of typing
    expect(out.length).toBe(1)
    c.advance(10)
    expect(out.length).toBe(2); expect(out[1].sel.f.off).toBe(9); expect(out[1].t - out[0].t).toBeGreaterThanOrEqual(50)
    p.dispose()
  })
  it('heartbeats every 4 s while focused (so a peer stays inside the 10 s ttl) and says away on blur and dispose', () => {
    const c = clock(), out = []
    const p = createPresence({ cid: 'me', send: (x) => out.push(x), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer })
    p.local(sel('l1', 2)); c.advance(12_100)
    expect(out.filter((x) => x.sel).length).toBe(1 + 3)
    p.local(sel('l1', 2), { focused: false }); expect(out.at(-1)).toMatchObject({ away: true, sel: null })
    const n = out.length; c.advance(20_000); expect(out.length).toBe(n)  // blurred: silent
    p.local(sel('l1', 3)); p.dispose(); expect(out.at(-1).away).toBe(true)
  })
  it('drops its own echo and turns an event into a peer or a drop; stamped on arrival', () => {
    const c = clock(), got = []
    const p = createPresence({ cid: 'me', send: () => {}, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer })
    expect(p.receive({ peer: 'u1:me', name: 'x', sel: null }, (a) => got.push(a))).toBe(false)
    expect(p.receive({ peer: 'u2:you', name: 'dana', sel: sel('l1', 1), at: 5 }, (a) => got.push(a))).toBe(true)
    expect(got[0].peer).toMatchObject({ id: 'u2:you', name: 'dana', at: 1000 })
    p.receive({ peer: 'u2:you', away: true }, (a) => got.push(a)); expect(got[1]).toEqual({ drop: 'u2:you' })
    p.dispose()
  })
})

// jsdom has no layout: every range gets one 40 x 16 box at (10, 20), enough to prove what is drawn and where it hangs
const rect = { left: 10, right: 50, top: 20, bottom: 36, width: 40, height: 16 }
Range.prototype.getClientRects ??= function () { return [rect] }

describe('the editor draws peers', () => {
  const app = { textOf: (r) => r.body, estimate: () => 20, items: (doc) => doc.lines().map((r) => ({ ...r, key: r.id, addr: r.id })), render: (it) => ({ tag: 'div', addr: it.id, children: it.body ? [it.body] : [{ tag: 'br' }] }), reduce: () => null }
  const contract = { name: 'presence-editor', actions: [] }
  const mk = () => {
    document.body.innerHTML = '<div id="s"><div id="d" contenteditable="true"></div></div>'
    let t = 1e12
    const ed = createEditor({ root: document.getElementById('d'), scroller: document.getElementById('s'), app, doc: memoryLines([{ id: 'l1', body: 'hello world', ord: 1 }, { id: 'l2', body: 'second', ord: 2 }]), contract, dev: true, clock: () => (t += 10) })
    return { ed, adv: (ms) => { t += ms } }
  }
  it('a presence action is state (state.peers), and the rows are not re-rendered by it', () => {
    const { ed } = mk()
    const before = document.getElementById('d').innerHTML, commits = ed.log.length
    ed.dispatch({ type: 'presence', peer: peer('u2:b', 1e12 + 5, { sel: sel('l1', 2, 5) }) })
    expect(Object.keys(ed.state.peers)).toEqual(['u2:b'])
    expect(document.getElementById('d').innerHTML).toBe(before)
    expect(ed.log.length).toBe(commits)                       // presence never enters the action log that checks replay
    expect(document.querySelector('#s .qk-presence [data-peer="u2:b"]')).toBeTruthy()
    expect(ed.checks.mutations()).toBeNull(); expect(ed.checks.freshDiff()).toBeNull()
    ed.dispose()
  })
  it('does not disturb the local goal x, the kill ring or a pending select-all', () => {
    const doc = memoryLines([{ id: 'l1', body: 'abc', ord: 1 }]), st = initState(app)
    st.goal = 42; st.kill = { text: 'k', open: true }; st.wide = { op: 'select-all' }
    step(app, doc, st, { type: 'presence', peer: peer('u2:b', 5) })
    expect(st.goal).toBe(42); expect(st.kill.open).toBe(true); expect(st.wide).toEqual({ op: 'select-all' })
  })
  it('expires a peer after the ttl by its own timer, and a drop removes it at once', async () => {
    const { ed } = mk()
    ed.dispatch({ type: 'presence', peer: peer('u2:b', 1e12 + 5) })
    ed.dispatch({ type: 'presence', expire: 1e12 + 5 + TTL_MS + 1 })
    expect(ed.state.peers).toEqual({})
    ed.dispatch({ type: 'presence', peer: peer('u3:c', 1e12 + 9) }); ed.dispatch({ type: 'presence', drop: 'u3:c' })
    expect(ed.state.peers).toEqual({})
    ed.dispose()
  })
  it('planted: a peer whose caret is in a row this document does not have draws nothing (another document)', () => {
    const { ed } = mk()
    ed.dispatch({ type: 'presence', peer: peer('u2:b', 1e12 + 5, { sel: sel('elsewhere', 1) }) })
    expect(document.querySelector('#s .qk-presence [data-peer]')).toBeNull()
    ed.dispose()
  })
})
