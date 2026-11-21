// The context menu: its state is one declaration with absolute, total, idempotent actions (lib/menu-state.js), its items are the app's chord registry (lib/editor/commands.js),
// and the DOM end (lib/menu-dom.js) draws only what the state says: keys, hover, flip, close edges. PANGEA3-DESIGN §15 "Context menu".
import { describe, expect, it } from 'vitest'
import { contextMenuDecl, cleanMenuItems, cleanMenuItem } from '../lib/menu-state.js'
import { mountMenu } from '../lib/menu-dom.js'
import { COMMANDS, chordLabel, boundChords, unlabelled, commandItems, lintSection, editorMenuItems } from '../lib/editor/commands.js'
import { createReplica } from '../lib/model.js'
import { validate } from '../lib/validate.js'

const mem = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v) }, del: async (k) => { m.delete(k) }, keys: async () => [...m.keys()] } }
const ITEMS = [{ id: 'a', label: 'Cut', keys: '⌘X', do: { clip: 'cut' } }, { separator: true }, { id: 'b', label: 'Copy', disabled: true }, { id: 'c', label: 'Format', children: [{ id: 'c1', label: 'Bold', do: { key: 'mod+b' } }, { id: 'c2', label: 'Italic' }] }]

describe('menu state', () => {
  it('validate runs every law over the declaration', async () => {
    const r = await validate({ decls: [contextMenuDecl('t-menu')], ui: true, timing: false })
    expect(r.ok, JSON.stringify(r).slice(0, 600)).toBe(true)
  }, 60000)
  it('open is by id (a repeat is the same menu), active only for the open menu and only to a selectable path, close by id or any', () => {
    const d = contextMenuDecl('t-menu-2'), a = d.actions
    const o = a['menu.open'](d.initial, { id: 'm1', x: 10.4, y: 20, ctx: { kind: 'text', row: 'l1' }, items: ITEMS })
    expect(o.open).toMatchObject({ id: 'm1', x: 10, y: 20, active: [] }); expect(a['menu.open'](o, { id: 'm1', x: 99, y: 99, ctx: { kind: 'text' }, items: ITEMS })).toBe(o)
    expect(a['menu.open'](o, { id: 'm2', x: 1, y: 1, ctx: { kind: 'text' }, items: ITEMS }).open.id).toBe('m2')
    expect(a['menu.open'](d.initial, { id: 'm', x: 'a', y: 1, ctx: { kind: 't' }, items: ITEMS })).toBe(d.initial)           // junk opens nothing
    expect(a['menu.open'](d.initial, { id: 'm', x: 1, y: 1, ctx: { kind: 't' }, items: [{ id: 'x', label: 'Off', disabled: true }] })).toBe(d.initial) // nothing to do: not opened
    expect(a['menu.active'](o, { id: 'm1', active: [0] }).open.active).toEqual([0])
    expect(a['menu.active'](o, { id: 'm1', active: [2] })).toBe(o)                         // a disabled row cannot be the focus
    expect(a['menu.active'](o, { id: 'm1', active: [3, 1] }).open.active).toEqual([3, 1]); expect(a['menu.active'](o, { id: 'm1', active: [0, 0] })).toBe(o)
    expect(a['menu.active'](o, { id: 'other', active: [0] })).toBe(o); expect(a['menu.active'](d.initial, { id: 'm1', active: [0] })).toBe(d.initial)
    expect(a['menu.close'](o, { id: 'other' })).toBe(o); expect(a['menu.close'](o, { id: 'm1' }).open).toBeNull(); expect(a['menu.close'](o, {}).open).toBeNull(); expect(a['menu.close'](d.initial, {})).toBe(d.initial)
  })
  it('items are plain data: a function never survives, ids are unique, separators are tidy, depth is two', () => {
    expect(cleanMenuItem({ id: 'x', label: 'L', do: { f: () => 1 } }).do).toEqual({}); expect(cleanMenuItem({ id: 'x' })).toBeNull(); expect(cleanMenuItem(null)).toBeNull()
    const l = cleanMenuItems([{ separator: true }, { id: 'a', label: 'A' }, { separator: true }, { separator: true }, { id: 'a', label: 'dup' }, { id: 'b', label: 'B', children: [{ id: 'c', label: 'C', children: [{ id: 'd', label: 'D' }] }] }, { separator: true }])
    expect(l.map((i) => i.id ?? '-')).toEqual(['a', '-', 'b']); expect(l[2].children[0].children).toBeUndefined()
    expect(cleanMenuItem({ id: 'h', label: 'm', heading: true })).toMatchObject({ heading: true, disabled: true })
  })
})

describe('commands: the menu is the app registry', () => {
  const app = { keys: ['mod+b', 'mod+z', 'Tab', 'mod+shift+s', 'mod+alt+1', 'alt+ArrowUp', 'Escape'], keyActions: { 'mod+a': { type: 'select-all' }, 'mod+f': { type: 'find', open: true } } }
  it('every bound chord appears with its shortcut, aliases and Escape do not; a chord with no label is named', () => {
    expect(boundChords(app).map((c) => c.name)).toEqual([...app.keys, 'mod+a', 'mod+f']); expect(unlabelled(app)).toEqual([])
    expect(unlabelled({ keys: ['mod+q'] })).toEqual(['mod+q'])
    const c = commandItems(app, { hasSel: true, mac: true })
    expect(c.format).toEqual([expect.objectContaining({ id: 'cmd:mod+b', label: 'Bold', keys: '⌘B', do: { key: 'mod+b' } })])
    expect(c.select[0]).toMatchObject({ label: 'Select all', do: { action: { type: 'select-all' } } }); expect(JSON.stringify(c)).not.toContain('Escape'); expect(c.list ?? []).toEqual([])
    expect(c.line[0].keys).toBe('⌥↑'); expect(commandItems(app, { mac: false }).format[0].keys).toBe('Ctrl+B')
  })
  it('disabled, never hidden: read only turns edits off, a missing selection turns selection commands off, Suggesting turns blocked chords off', () => {
    const on = (c, id) => !c.format.concat(c.history, c.doc, c.heading, c.line).find((i) => i.id === id).disabled
    let c = commandItems(app, { hasSel: true }); expect(on(c, 'cmd:mod+b')).toBe(true); expect(on(c, 'cmd:mod+shift+s')).toBe(true)
    c = commandItems(app, { hasSel: false }); expect(on(c, 'cmd:mod+b')).toBe(false); expect(on(c, 'cmd:mod+z')).toBe(true)
    c = commandItems(app, { hasSel: true, readOnly: true }); expect(on(c, 'cmd:mod+b')).toBe(false); expect(on(c, 'cmd:mod+z')).toBe(false); expect(on(c, 'cmd:mod+shift+s')).toBe(true)
    c = commandItems(app, { hasSel: true, suggesting: true, blocked: (n) => n === 'mod+b' }); expect(on(c, 'cmd:mod+b')).toBe(false); expect(on(c, 'cmd:mod+alt+1')).toBe(true)
    expect(chordLabel('mod+shift+.', true)).toBe('⇧⌘.'); expect(chordLabel('mod+Enter', true)).toBe('⌘↵'); expect(Object.keys(COMMANDS).length).toBeGreaterThan(30)
  })
  it('a finding puts its message, suggestions (in the word\'s case), Ignore and Add to dictionary first; no finding, none of it', () => {
    const lint = { from: 1, to: 4, cls: 'spelling', key: 's:teh', word: 'Teh', msg: 'Did you mean the?', sug: ['the', 'ten'] }
    const s = lintSection(lint, { row: 'r1' })
    expect(s.map((i) => i.label ?? '-')).toEqual(['Did you mean the?', 'The', 'Ten', '-', 'Ignore', 'Add to dictionary'])
    expect(s[1].do).toEqual({ lint: 'fix', row: 'r1', from: 1, to: 4, word: 'Teh', text: 'The' }); expect(lintSection({ ...lint, cls: 'grammar' }, { row: 'r1' }).map((i) => i.label)).not.toContain('Add to dictionary')
    expect(lintSection(lint, { row: 'r1', readOnly: true })[1].disabled).toBe(true); expect(lintSection({ ...lint, sug: [] }, { row: 'r' }).some((i) => i.label === 'No suggestions')).toBe(true); expect(lintSection(null, { row: 'r' })).toEqual([])
    const all = editorMenuItems(app, { lint, row: 'r1', hasSel: false }, { checking: true, canDict: true }, { actions: [{ id: 'app.comment', label: 'Comment', do: { app: 'comment' } }] })
    expect(all[0].label).toBe('Did you mean the?'); expect(all.map((i) => i.label)).toEqual(expect.arrayContaining(['Cut', 'Paste', 'Select all', 'Comment', 'Find', 'Check spelling and grammar']))
    expect(cleanMenuItems(all).length).toBe(all.length)                                      // everything it offers is valid menu data
    expect(editorMenuItems(app, { row: 'r1' }, { checking: null }).map((i) => i.label)).not.toContain('Check spelling and grammar')
  })
})

describe('mountMenu (DOM)', () => {
  const setup = () => {
    const r = createReplica(contextMenuDecl(`t-menu-dom-${Math.random()}`), { storage: mem(), device: 'd' }), ran = []
    const m = mountMenu({ store: r, onRun: (item, ctx) => ran.push([item.id, ctx.kind]) })
    return { r, ran, m }
  }
  const open = (r, over = {}) => r.dispatch('menu.open', { id: 'm1', x: 40, y: 50, ctx: { kind: 'text' }, items: ITEMS, ...over })
  const key = (k, o = {}) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }); window.dispatchEvent(e); return e }
  it('draws role=menu rows from the state, the active row follows the state, a submenu is a second panel', () => {
    const { r, m } = setup(); open(r)
    const p = document.querySelector('[data-qk-menu="0"]'); expect(p.getAttribute('role')).toBe('menu')
    expect([...p.querySelectorAll('[role=menuitem]')].map((x) => x.querySelector('.qk-label').textContent)).toEqual(['Cut', 'Copy', 'Format'])
    expect(p.querySelector('[aria-disabled=true]').textContent).toContain('Copy'); expect(p.querySelector('.qk-keys').textContent).toBe('⌘X')
    r.dispatch('menu.active', { id: 'm1', active: [3] }); expect(document.querySelector('[data-qk-menu="1"]')).not.toBeNull(); expect(document.querySelector('.qk-item.on .qk-label').textContent).toBe('Format')
    r.dispatch('menu.close', {}); expect(document.querySelector('[data-qk-menu]')).toBeNull(); m.dispose()
  })
  it('keys: arrows skip disabled rows and wrap, Right opens the submenu, Enter runs and closes, Escape closes a level then the menu, a chord closes and goes on', () => {
    const { r, ran, m } = setup(); open(r)
    key('ArrowDown'); expect(r.get().open.active).toEqual([0]); key('ArrowDown'); expect(r.get().open.active).toEqual([3]); key('ArrowDown'); expect(r.get().open.active).toEqual([0])
    key('ArrowUp'); key('ArrowRight'); expect(r.get().open.active).toEqual([3, 0]); expect(document.querySelector('[data-qk-menu="1"]')).not.toBeNull()
    key('Escape'); expect(r.get().open.active).toEqual([3]); key('ArrowRight'); const e = key('Enter'); expect(e.defaultPrevented).toBe(true)
    expect(ran).toEqual([['c1', 'text']]); expect(r.get().open).toBeNull()
    open(r, { id: 'm2' }); key('ArrowDown'); key('Enter'); expect(ran.at(-1)).toEqual(['a', 'text'])
    open(r, { id: 'm3' }); expect(key('Escape').defaultPrevented).toBe(true); expect(r.get().open).toBeNull()
    open(r, { id: 'm4' }); const c = key('z', { metaKey: true }); expect(c.defaultPrevented).toBe(false); expect(r.get().open).toBeNull()
    open(r, { id: 'm5' }); key('c'); expect(r.get().open.active).toEqual([0]); expect(key('q').defaultPrevented).toBe(true)  // a letter jumps; typing never reaches the line
    m.dispose()
  })
  it('a click runs an enabled row once and a disabled row nothing; a press outside, a resize and a wheel outside close it; the panel stays in the window', () => {
    const { r, ran, m } = setup(); open(r, { x: 5000, y: 5000 })
    const p = document.querySelector('[data-qk-menu="0"]'); expect(parseFloat(p.style.left)).toBeLessThanOrEqual(window.innerWidth); expect(p.style.visibility).toBe('')
    const row = (id) => p.querySelector(`[data-id="${id}"]`)
    row('b').dispatchEvent(new MouseEvent('click', { bubbles: true })); expect(ran).toEqual([]); expect(r.get().open).not.toBeNull()
    expect(row('a').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))).toBe(false)   // the press never takes the caret from the editor
    row('a').dispatchEvent(new MouseEvent('click', { bubbles: true })); expect(ran).toEqual([['a', 'text']]); expect(r.get().open).toBeNull()
    open(r, { id: 'm2' }); document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); expect(r.get().open).toBeNull()
    open(r, { id: 'm3' }); window.dispatchEvent(new Event('resize')); expect(r.get().open).toBeNull()
    open(r, { id: 'm4' }); document.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true })); expect(r.get().open).toBeNull()
    m.dispose()
  })
})
