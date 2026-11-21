// The agent surface (lib/agent-surface.js; PANGEA3-DESIGN A1 / invariant 10, "agents use the same dispatch and query as the UI"): an app's
// declared editor actions described and dispatched over rows by the editor's OWN declared reducer, with the state a server cannot hold
// (view state) refused rather than faked. Planted: a run through a reducer of its own (one that does not go through the declaration)
// would not agree with the declared one, and the retry law below fails without the intent on the patches.
import { describe, expect, it } from 'vitest'
import { describeEditor, describeDecl, dispatchEditor, classify, VIEW_ONLY } from '../lib/agent-surface.js'
import { declare } from '../lib/model.js'
import { on } from '../lib/schema.js'
import { field } from '../lib/schema.js'
import { declareEditor } from '../lib/editor/declare.js'
import { createEditor, memoryLines, modelRun, initState } from '../lib/editor/editor.js'

const app = {
  textOf: (r) => r.body,
  estimate: () => 20,
  items: (doc) => doc.lines().map((r) => ({ ...r, key: r.id, addr: r.id })),
  render: (it) => ({ tag: 'div', addr: it.id, children: it.body ? [it.body] : [{ tag: 'br' }] }),
  keys: ['mod+d'],
  reduce(state, a, ctx) {
    if (a.type === 'key' && a.name === 'mod+d') { const id = state.sel?.f.id; return id ? { puts: [{ id, set: { deleted_at: 'x' } }] } : null }
    if (a.type === 'shout') { const r = ctx.get(a.row); return r ? { puts: [{ id: r.id, set: { body: `${r.body.toUpperCase()}!` } }] } : null }
    if (a.type !== 'input' || !a.sel) return null
    const r = ctx.get(a.sel.a.id), off = a.sel.a.off
    if (!r) return null
    if (a.inputType === 'insertText') return { puts: [{ id: r.id, set: { body: r.body.slice(0, off) + a.text + r.body.slice(off) } }], sel: { a: { id: r.id, off: off + a.text.length }, f: { id: r.id, off: off + a.text.length } } }
    return null
  },
}
const contract = { name: 'agent-surface-editor', actions: ['shout'], edits: ['shout'], gens: { shout: (r, { rowId }) => ({ row: rowId() }) }, sample: [{ id: 'a', ord: 1, body: 'hello there' }, { id: 'b', ord: 2, body: 'second line' }] }
declareEditor(contract, app)
const rows = () => [{ id: 'a', body: 'hello there', ord: 1, _s: { body: 'x' } }, { id: 'b', body: 'second line', ord: 2 }, { id: 'c', body: 'gone', ord: 3, deleted_at: 't' }]
const at = (id, off) => ({ a: { id, off }, f: { id, off } })
const run = (action, over = {}) => dispatchEditor({ contract, app, rows: rows(), action, now: 1.7e12, ...over })

describe('describeEditor', () => {
  const list = describeEditor(contract, app, { rows: rows() })
  const by = Object.fromEntries(list.map((a) => [a.name, a]))
  it('lists every declared action, document actions held in the cloud and view actions on the device', () => {
    for (const n of ['input', 'key', 'pointer', 'select', 'scroll', 'fold', 'find', 'hover', 'shout']) expect(by[n], n).toBeTruthy()
    expect(by.input).toMatchObject({ class: 'document', held: 'cloud', dispatchable: true, edit: true, kit: true })
    expect(by.input.args.sel).toMatch(/anchor and focus/)
    for (const n of VIEW_ONLY.filter((n) => n !== 'move')) if (by[n]) expect(by[n], n).toMatchObject({ class: 'view', held: 'device', dispatchable: false })
    expect(by.remote).toMatchObject({ class: 'ingest', dispatchable: false })
  })
  it("gives an app action its declared generator's example payload, and none to a kit action", () => {
    expect(by.shout).toMatchObject({ kit: false, edit: true, dispatchable: true, example: { row: 'a' } })
    expect(by.input.example).toBeUndefined()
  })
})

describe('describeDecl', () => {
  it('says where a declaration lives and what its actions are', () => {
    const d = declare({ name: 'agent-surface-demo', scope: 'cloud', fields: { n: field(0, Number) }, actions: { 'n.set': on('n', (_n, p) => Number(p.n) || 0) } })
    expect(describeDecl(d, { readable: true })).toMatchObject({ name: 'agent-surface-demo', held: 'cloud', readable: true, dispatchable: false, actions: [{ name: 'n.set' }] })
    const l = declare({ name: 'agent-surface-demo-local', scope: 'local', fields: { n: field(0, Number) }, actions: { 'n.set': on('n', (_n, p) => Number(p.n) || 0) } })
    expect(describeDecl(l, { readable: true, dispatchable: true })).toMatchObject({ held: 'device', readable: false, dispatchable: false })
  })
})

describe('dispatchEditor', () => {
  it('an insertText input writes one row patch with the intent, through the declared reducer', () => {
    const r = run({ id: 'i1', type: 'input', inputType: 'insertText', text: 'X', sel: at('a', 2) })
    expect(r).toMatchObject({ ok: true, applied: true })
    expect(r.patches).toHaveLength(1)
    expect(r.patches[0]).toMatchObject({ id: 'a', intent: 'i1', set: { body: 'heXllo there' } })
    expect(Object.keys(r.patches[0].set)).not.toContain('_s')
  })
  it('agrees with the browser model: the same action run through modelRun gives the same text', () => {
    const a = { id: 'i2', type: 'input', inputType: 'insertText', text: 'Q', sel: at('b', 0) }
    const r = run(a)
    const model = modelRun(app, rows().map(({ _s, ...x }) => x), [{ ...a, at: 1.7e12 }])
    const got = rows().map(({ _s, ...x }) => x).map((x) => ({ ...x, ...(r.patches.find((p) => p.id === x.id)?.set || {}) }))
    expect(got.filter((x) => !x.deleted_at).map((x) => x.body)).toEqual(model.doc.lines().map((x) => x.body))
  })
  it('a key acts on the caret seeded by sel; without one it does nothing (a fresh view has no caret)', () => {
    expect(run({ id: 'k1', type: 'key', name: 'mod+d', sel: at('b', 1) }).patches).toEqual([{ id: 'b', set: { deleted_at: 'x' }, intent: 'k1' }])
    const none = run({ id: 'k2', type: 'key', name: 'mod+d' })
    expect(none).toMatchObject({ ok: true, applied: false, patches: [] })
  })
  it("an app's own edit action runs and carries its intent", () => {
    expect(run({ id: 's1', type: 'shout', row: 'b' }).patches).toEqual([{ id: 'b', set: { body: 'SECOND LINE!' }, intent: 's1' }])
  })
  it('view state is refused as client_only, never faked; ingest is not dispatchable', () => {
    for (const type of ['select', 'scroll', 'fold', 'find', 'hover', 'focus', 'select-all']) expect(run({ id: 'v1', type }), type).toMatchObject({ ok: false, code: 'client_only' })
    expect(run({ id: 'v2', type: 'embed', op: 'collapse', key: 'emb:a' })).toMatchObject({ ok: false, code: 'client_only' })
    expect(run({ id: 'v4', type: 'remote', rows: [] })).toMatchObject({ ok: false, code: 'not_dispatchable' })
  })
  it('refuses a missing or malformed id, an unknown action, a bad shape and a read-only role', () => {
    expect(run({ type: 'key', name: 'mod+d' })).toMatchObject({ ok: false, code: 'bad_id' })
    expect(run({ id: 'has space', type: 'key' })).toMatchObject({ ok: false, code: 'bad_id' })
    expect(run({ id: 'u1', type: 'nope' })).toMatchObject({ ok: false, code: 'unknown_action' })
    expect(dispatchEditor({ contract, app, rows: rows(), action: null, now: 1 })).toMatchObject({ ok: false, code: 'bad_action' })
    expect(run({ id: 'r1', type: 'key', name: 'mod+d', sel: at('a', 0) }, { readOnly: true })).toMatchObject({ ok: false, code: 'read_only' })
  })
  it('junk payloads are a no-op, not a throw (A4 totality reaches the API)', () => {
    for (const a of [{ type: 'input', inputType: 7, sel: 'x' }, { type: 'input', sel: at('zzz', 4), inputType: 'insertText', text: 'x' }, { type: 'shout', row: null }, { type: 'key', name: 5 }]) {
      const r = run({ id: 'j1', ...a })
      expect(r, JSON.stringify(a)).toMatchObject({ ok: true, patches: [] })
    }
  })
  it('a reducer that throws comes back as reducer_error, never as an exception', () => {
    const bad = { ...app, reduce: () => { throw new Error('boom') } }
    expect(dispatchEditor({ contract: { ...contract, name: 'agent-surface-bad' }, app: bad, rows: rows(), action: { id: 'b1', type: 'input', inputType: 'insertText', text: 'x', sel: at('a', 0) }, now: 1 })).toMatchObject({ ok: false, code: 'reducer_error', why: 'boom' })
  })
  it('is pure: the caller rows are untouched and the same call twice gives the same patches (retry law)', () => {
    const input = rows(), snap = JSON.stringify(input)
    const a = { id: 'p1', type: 'input', inputType: 'insertText', text: 'Z', sel: at('a', 0) }
    const x = dispatchEditor({ contract, app, rows: input, action: a, now: 1.7e12 }), y = dispatchEditor({ contract, app, rows: input, action: a, now: 1.7e12 })
    expect(JSON.stringify(input)).toBe(snap)
    expect(x).toEqual(y)
    expect(x.patches.every((p) => p.intent === 'p1')).toBe(true)
  })
  it('classify: row-writing ops of embed and drag are document actions', () => {
    expect(classify('embed', { op: 'resize' })).toBe('doc'); expect(classify('embed', { op: 'collapse' })).toBe('view')
    expect(classify('drag', { op: 'drop' })).toBe('doc'); expect(classify('drag', { op: 'over' })).toBe('view')
    expect(classify('input')).toBe('doc')
  })
})
