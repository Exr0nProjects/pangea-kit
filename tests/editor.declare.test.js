// Row #38 for apps built on createEditor and openRows: the editor and the row store register what they hold
// (lib/editor/declare.js, lib/engine/rows-declare.js), and validate() runs every law over them. Row #46/#28: a landing has a
// deadline exit (pending -> failed, released to free). Row #55: an edit while a select-all is still reading pages is
// refused with a visible notice, never applied to the loaded rows only. Each check has a planted bug that turns it red.
import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { createEditor, memoryLines, WIDE_PENDING } from '../lib/editor/editor.js'
import { declareEditor, VIEW_ACTIONS } from '../lib/editor/declare.js'
import { declareRows } from '../lib/engine/rows-declare.js'
import { openRows } from '../lib/engine/rows.js'
import { declarations, generatorFor } from '../lib/declare-keys.js'
import { validate } from '../lib/validate.js'
import { planted } from './planted.js'

globalThis.IDBKeyRange ??= IDBKeyRange
const KIT = resolve(import.meta.dirname, '..')

// a small editor app: typing and deleting over one or more rows, Tab indents, a pointer appends, IME writes the line
const app = {
  keys: ['Tab'],
  textOf: (r) => r.body ?? '',
  estimate: () => 20,
  items: (doc) => doc.lines().map((r) => ({ ...r, key: r.id, addr: r.id })),
  render: (it) => ({ tag: 'div', addr: it.id, children: it.body ? [it.body] : [{ tag: 'br' }] }),
  reduce(state, a, ctx) {
    const order = (s) => { const i = ctx.index(s.a.id), j = ctx.index(s.f.id); return i < j || (i === j && s.a.off <= s.f.off) ? [s.a, s.f, i, j] : [s.f, s.a, j, i] }
    if (a.type === 'input' && a.sel) {
      const [p, q, i, j] = order(a.sel); if (i < 0 || j < 0) return null
      const text = /^delete/.test(a.inputType) ? '' : String(a.text ?? '')
      let [from, to] = [p.off, q.off]
      if (i === j && from === to && /Backward/.test(a.inputType)) from = Math.max(0, from - 1)
      const head = ctx.lines[i].body.slice(0, from), tail = ctx.lines[j].body.slice(to)
      const puts = [{ id: p.id, set: { body: head + text + tail } }]
      for (let k = i + 1; k <= j; k++) puts.push({ id: ctx.lines[k].id, set: { deleted_at: 1 } })
      return { puts, sel: { a: { id: p.id, off: head.length + text.length }, f: { id: p.id, off: head.length + text.length } } }
    }
    if (a.type === 'key' && state.sel) { const r = ctx.get(state.sel.f.id); return r ? { puts: [{ id: r.id, set: { body: `  ${r.body}` } }] } : null }
    if (a.type === 'pointer' && a.addr) { const r = ctx.get(a.addr); return r ? { puts: [{ id: r.id, set: { body: `${r.body}!` } }] } : null }
    if (a.type === 'compose-end' && a.addr) { const r = ctx.get(a.addr); return r && a.text != null && a.text !== r.body ? { puts: [{ id: r.id, set: { body: a.text } }] } : null }
    if (a.type === 'flip') return { folds: state.folds.length ? [] : [ctx.lines[0]?.id].filter(Boolean) } // a toggle
    return null
  },
}
const mountAt = (doc, contract, opts = {}) => { document.body.innerHTML = '<div><div id="d" contenteditable="true"></div></div>'; let t = 1e12; return createEditor({ root: document.getElementById('d'), app, doc, contract, clock: () => (t += 10), ...opts }) }
const lawsOf = async (decls) => validate({ decls, ui: true, timing: false })
const failText = (r) => r.failures.map((f) => `${f.name}: ${f.law}: ${f.detail}`).join('\n')

describe('createEditor registers what it holds (row #38)', () => {
  it('createEditor registers the kit state and every action it dispatches as two declarations: absolute (lww) and text edits (log)', () => {
    const contract = { name: 'reg-test', actions: [] }
    const ed = mountAt(memoryLines([{ id: 'a', body: 'x', ord: 1 }]), contract)
    const names = declarations().decls.map((d) => d.name)
    expect(names).toEqual(expect.arrayContaining(['editor:reg-test', 'editor:reg-test:edits']))
    const view = declarations().decls.find((d) => d.name === 'editor:reg-test'), edits = declarations().decls.find((d) => d.name === 'editor:reg-test:edits')
    expect(view.conflict).toBe('lww')
    expect(Object.keys(view.actions).sort()).toEqual(VIEW_ACTIONS.filter((t) => t !== 'drag').sort()) // `drag` is declared only for an app with an `outline` (this one has none)
    expect(edits.conflict).toBe('log')
    expect(Object.keys(edits.actions).sort()).toEqual(['compose-end', 'input', 'key', 'pointer'])
    expect(Object.keys(view.initial.view)).toEqual(expect.arrayContaining(['sel', 'anchor', 'follow', 'landing', 'folds', 'find', 'wide', 'notice']))
    expect(typeof generatorFor('editor:reg-test')).toBe('function')
    ed.dispose()
  })
  it('validate runs every law over the editor actions, with per-action coverage and reload checks', async () => {
    const d = declareEditor({ name: 'lawful', actions: [] }, app)
    const r = await lawsOf([d.view, d.edits])
    expect(failText(r)).toBe('')
    for (const x of r.decls) { expect(x.cases).toBe(960); expect(x.uncovered).toEqual([]) }
    expect(r.decls.find((x) => x.name === 'editor:lawful:edits').coverage.input).toBeGreaterThan(10)
  }, 60000)
  it('planted: a toggle-style editor action declared absolute is red (idempotent); declared a text edit it is idempotent by intent id (dedupe)', async () => {
    const bad = declareEditor({ name: 'toggly', actions: ['flip'] }, app)
    const r = await lawsOf([bad.view])
    expect(r.ok).toBe(false)
    expect(failText(r)).toMatch(/editor:toggly: idempotent: flip/)
    const ok = declareEditor({ name: 'toggly-edit', actions: ['flip'], edits: ['flip'] }, app)
    const r2 = await lawsOf([ok.view, ok.edits])
    expect(failText(r2)).toBe('')
  }, 60000)
  it('a redelivered text edit (same intent id) changes nothing; the same edit by value is not idempotent (why edits are conflict log)', () => {
    const d = declareEditor({ name: 'redeliver', actions: [] }, app)
    const s0 = d.edits.initial
    const sel = s0.view.sel
    const typed = d.edits.actions.input(s0, { id: 'e1', at: 5, inputType: 'insertText', text: 'z', sel })
    expect(typed).not.toBe(s0)
    expect(d.edits.actions.input(typed, { id: 'e1', at: 5, inputType: 'insertText', text: 'z', sel })).toBe(typed)
    const again = d.edits.actions.input(typed, { id: 'e2', at: 5, inputType: 'insertText', text: 'z', sel: typed.view.sel })
    expect(again.doc.rows[sel.a.id].body).toBe(`zz`) // by value a second "z" is another "z": only the intent id makes it a no-op
    expect(d.edits.actions.input(typed, { at: 5, inputType: 'insertText', text: 'z', sel })).toBe(typed) // no intent id: skipped
  })
  it("planted: the kit's fold reverted to a toggle in the reducer is red", async () => {
    const dir = join(KIT, 'lib/editor'), tag = `.planted-${process.pid}-fold`
    const ed = readFileSync(join(dir, 'editor.js'), 'utf8')
    const find = "case 'fold': { if (a.addr == null || typeof a.on !== 'boolean') break; const has = state.folds.includes(a.addr); if (a.on && !has)"
    expect(ed.includes(find)).toBe(true)
    writeFileSync(join(dir, `${tag}-editor.js`), ed.replace(find, "case 'fold': { if (a.addr == null) break; const has = state.folds.includes(a.addr); if (!has)"))
    try {
      const mod = await planted('lib/editor/declare.js', "from './editor.js'", `from './${tag}-editor.js'`)
      const d = mod.declareEditor({ name: 'fold-toggle', actions: [] }, app)
      const r = await lawsOf([d.view])
      expect(failText(r)).toMatch(/editor:fold-toggle: idempotent: fold/)
    } finally { rmSync(join(dir, `${tag}-editor.js`), { force: true }) }
  }, 60000)
  it('declareEditor refuses a contract it cannot keep (unknown key, an edit that is not an action, a kit action listed as the app\'s)', () => {
    expect(() => declareEditor({ name: 'x1', actions: [], undo: true }, app)).toThrow(/unknown contract key "undo"/)
    expect(() => declareEditor({ name: 'x2', actions: ['a'], edits: ['b'] }, app)).toThrow(/edits names "b"/)
    expect(() => declareEditor({ name: 'x3', actions: ['select'] }, app)).toThrow(/kit action/)
  })
})

describe('openRows registers its fields and conflict policy (row #38)', () => {
  const fields = ['body', 'mvseen', 'ord', 'zone', 'deleted_at', 'mv:*', 'in:*']
  it('openRows registers a row declaration (per-field LWW, conflict lww) and refuses a put writing an undeclared field', async () => {
    const decl = declareRows({ name: 'notes-a', fields, together: [['body', 'mvseen']] })
    const rows = await openRows({ name: 'notes-a', indexedDB: new IDBFactory(), sortKey: (r) => [r.ord ?? 0, r.id], declaration: decl, Broadcast: null })
    expect(rows.declaration).toBe(decl)
    expect(decl.decl).toMatchObject({ name: 'rows:notes-a', conflict: 'lww', scope: 'cloud' })
    expect(declarations().decls.map((d) => d.name)).toContain('rows:notes-a')
    expect(() => rows.put([{ id: 'r', set: { colour: 'red' } }])).toThrow(/undeclared field "colour"/)
    expect(() => rows.put([{ id: 'r', set: { body: 'x' } }])).toThrow(/without mvseen/)
    expect(rows.put([{ id: 'r', set: { body: 'x', mvseen: '', 'mv:op1': '{}' } }])).toHaveLength(1)
    await rows.close()
    const own = await openRows({ name: 'notes-b', indexedDB: new IDBFactory(), sortKey: (r) => [r.id], Broadcast: null })
    expect(own.declaration.decl.name).toBe('rows:notes-b') // no declaration given: openRows declares its own (any field)
    await own.close()
  })
  it('validate runs every law over the row merge: idempotent, total, reload, no loss, two devices converging over a lossy Stream', async () => {
    const d = declareRows({ name: 'notes-c', fields, together: [['body', 'mvseen']] })
    const r = await lawsOf([d.decl])
    expect(failText(r)).toBe('')
    expect(r.decls[0].cases).toBe(960)
  }, 60000)
  it('planted: a merge where the last arrival wins (no stamps) is red', async () => {
    const mod = await planted('lib/engine/rows-declare.js', 'const m = mergeRow(old, p);', 'const m = { ...(old || { id: p.id }), ...p.set };')
    const d = mod.declareRows({ name: 'notes-planted', fields, together: [['body', 'mvseen']] })
    const r = await lawsOf([d.decl])
    expect(r.ok).toBe(false)
    expect(failText(r)).toMatch(/rows:notes-planted: (idempotent|tabsConverge)/)
  }, 60000)
})

describe('a landing has a deadline exit (row #46, §8 waits)', () => {
  const contract = { name: 'landing-test', actions: [] }
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms))
  // true when a landing on a row that never arrives is released (free, anchor cleared) and marked failed after the deadline
  const exits = async (create) => {
    document.body.innerHTML = '<div><div id="d" contenteditable="true"></div></div>'
    let t = 1e12
    const ed = create({ root: document.getElementById('d'), app, doc: memoryLines([{ id: 'a', body: 'x', ord: 1 }]), contract, clock: () => (t += 10), landingDeadlineMs: 30 })
    ed.dispatch({ type: 'scroll', anchor: { id: 'never', px: 40 } })
    const pending = { ...ed.state.landing }, follow0 = ed.state.follow
    await wait(80)
    const out = { pending, follow0, landing: ed.state.landing, follow: ed.state.follow, anchor: ed.state.anchor }
    ed.dispose()
    return out
  }
  it('a landing whose row never arrives shows pending, then failed, and is released to free', async () => {
    const r = await exits(createEditor)
    expect(r.pending).toMatchObject({ id: 'never', status: 'pending' })
    expect(r.follow0).toBe('pinned')
    expect(r.landing).toMatchObject({ id: 'never', status: 'failed' })
    expect(r.follow).toBe('free')
    expect(r.anchor).toBe(null)
  })
  it('a landing whose row arrives before the deadline lands and stays pinned', async () => {
    const doc = memoryLines([{ id: 'a', body: 'x', ord: 1 }])
    const ed = mountAt(doc, contract, { landingDeadlineMs: 60 })
    ed.dispatch({ type: 'scroll', anchor: { id: 'late', px: 40 } })
    expect(ed.state.landing.status).toBe('pending')
    await wait(10)
    doc.put([{ id: 'late', set: { body: 'here', ord: 2 } }]); ed.dispatch({ type: 'remote' })
    await wait(100)
    expect(ed.state.landing).toMatchObject({ id: 'late', status: 'landed' })
    expect(ed.state).toMatchObject({ follow: 'pinned', anchor: { id: 'late', px: 40 } })
    ed.dispose()
  })
  it('a landing on a row already drawn is landed at once; a user scroll ends the landing', async () => {
    const ed = mountAt(memoryLines([{ id: 'a', body: 'x', ord: 1 }]), contract)
    ed.dispatch({ type: 'scroll', anchor: { id: 'a', px: 10 } })
    await wait(0)
    expect(ed.state.landing).toMatchObject({ id: 'a', status: 'landed' })
    ed.dispatch({ type: 'scroll', anchor: { id: 'a', px: 3 }, follow: 'free' })
    expect(ed.state.landing).toBe(null)
    ed.dispose()
  })
  it('planted: without the deadline exit the landing stays pending and pinned forever (red)', async () => {
    const mod = await planted('lib/editor/editor.js', 'if (!landingTimer) landingTimer = W.setTimeout(', 'if (false) landingTimer = W.setTimeout(')
    const r = await exits(mod.createEditor)
    expect(r.landing.status).toBe('pending')
    expect(r.follow).toBe('pinned')
  })
})

describe('an edit during a select-all that is still reading pages (row #55)', () => {
  const contract = { name: 'wide-test', actions: [] }
  function pagedDoc(n, loaded, page = 50) {
    const base = memoryLines(Array.from({ length: n }, (_, k) => ({ id: `r${String(k).padStart(4, '0')}`, body: `line ${k}`, ord: k })))
    let from = n - loaded
    return {
      lines: () => base.lines().slice(from), get: base.get, peek: base.peek, put: base.put, all: () => base.lines(),
      atStart: () => from === 0,
      async loadOlder(k = page) { await Promise.resolve(); const b = from; from = Math.max(0, from - Math.min(k, page)); return b - from },
    }
  }
  const run = async (create) => {
    const doc = pagedDoc(300, 40)
    document.body.innerHTML = '<div><div id="d" contenteditable="true"></div></div>'
    let t = 1e12
    const ed = create({ root: document.getElementById('d'), app, doc, contract, clock: () => (t += 10) })
    ed.dispatch({ type: 'select-all' })
    const p = ed.widening()
    ed.dispatch({ type: 'input', inputType: 'deleteContentBackward', text: '', sel: ed.state.sel })
    const during = { live: doc.all().length, notice: ed.state.notice && { ...ed.state.notice }, wide: ed.state.wide }
    await p; await new Promise((ok) => setTimeout(ok, 0))
    const after = { sel: ed.state.sel, notice: ed.state.notice, wide: ed.state.wide }
    ed.dispatch({ type: 'input', inputType: 'deleteContentBackward', text: '', sel: ed.state.sel })
    const end = doc.all().map((r) => r.body)
    ed.dispose()
    return { during, after, end }
  }
  it('is refused with a visible notice (nothing deleted, the select-all stands); once the selection covers the document the delete removes every row', async () => {
    const r = await run(createEditor)
    expect(r.during).toMatchObject({ live: 300, notice: { code: WIDE_PENDING, type: 'input' }, wide: { op: 'select-all' } })
    expect(r.after.wide).toBe(null)
    expect(r.after.notice).toBe(null)
    expect(r.after.sel).toEqual({ a: { id: 'r0000', off: 0 }, f: { id: 'r0299', off: 'line 299'.length } })
    expect(r.end).toEqual(['']) // one empty row left, every other row deleted
  })
  it('planted: without the refusal the delete removes only the loaded rows and the rest survive (red)', async () => {
    const mod = await planted('lib/editor/editor.js', "if (state.wide?.op === 'select-all' && (REFUSED_WHILE_WIDE", "if (false && (REFUSED_WHILE_WIDE")
    const r = await run(mod.createEditor)
    expect(r.during.live).toBeLessThan(300)
    expect(r.during.live).toBeGreaterThan(200) // the unloaded rows survived a "delete everything"
  })
})
