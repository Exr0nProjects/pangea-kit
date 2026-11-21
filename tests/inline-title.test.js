// @vitest-environment jsdom
// The inline title editor (lib/inline-title.js; the owner 2026-11-12 11:06 PST: one shared click-to-edit title for the embed header, the doc
// page and the share sheet; the rename is an absolute value, so a repeat is harmless).
import { describe, expect, it } from 'vitest'
import { inlineTitle } from '../lib/inline-title.js'

const mk = (opts = {}) => {
  document.body.innerHTML = '<h1 id="t">trip plan</h1>'
  const el = document.getElementById('t'), calls = [], st = { title: 'trip plan' }, closed = []
  const t = inlineTitle(el, { get: () => st.title, commit: async (v) => { calls.push(v); if (opts.fail) throw new Error('no'); st.title = v; return v }, onClose: (s) => closed.push(s), ...opts.o })
  return { el, t, calls, st, closed }
}
const press = (el) => el.dispatchEvent(Object.assign(new Event('click', { bubbles: true, cancelable: true }), { button: 0 }))
const key = (input, k) => input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
const tick = () => new Promise((r) => setTimeout(r, 5))

describe('inlineTitle', () => {
  it('a press replaces the text by an input holding the title; Enter commits the whole new title once (folded, trimmed) and shows it', async () => {
    const { el, calls, closed, st } = mk(); press(el)
    const input = el.querySelector('input'); expect(input.value).toBe('trip plan')
    input.value = '  a   new\n name '; key(input, 'Enter'); await tick()
    expect(calls).toEqual(['a new name']); expect(el.textContent).toBe('a new name'); expect(el.querySelector('input')).toBeNull(); expect(closed).toEqual([true]); expect(st.title).toBe('a new name')
  })
  it('Escape cancels, an unchanged or empty title commits nothing, blur saves', async () => {
    const { el, calls, closed } = mk(); press(el)
    let input = el.querySelector('input'); input.value = 'x'; key(input, 'Escape'); await tick(); expect(calls).toEqual([]); expect(el.textContent).toBe('trip plan')
    press(el); input = el.querySelector('input'); key(input, 'Enter'); await tick(); expect(calls).toEqual([])
    press(el); input = el.querySelector('input'); input.value = '   '; key(input, 'Enter'); await tick(); expect(calls).toEqual([]); expect(el.textContent).toBe('trip plan')
    press(el); input = el.querySelector('input'); input.value = 'blurred'; input.dispatchEvent(new Event('blur')); await tick(); expect(calls).toEqual(['blurred'])
    expect(closed).toEqual([false, false, false, true])
  })
  it('a repeated Enter or blur after the first is the same rename (one commit); a refused commit puts the old title back', async () => {
    const a = mk(); press(a.el); const input = a.el.querySelector('input'); input.value = 'once'; key(input, 'Enter'); input.dispatchEvent(new Event('blur')); key(input, 'Enter'); await tick()
    expect(a.calls).toEqual(['once'])
    const b = mk({ fail: true }); press(b.el); const i2 = b.el.querySelector('input'); i2.value = 'nope'; key(i2, 'Enter'); await tick(); await tick()
    expect(b.calls).toEqual(['nope']); expect(b.el.textContent).toBe('trip plan')
  })
  it('canEdit false opens nothing; set() shows a pushed title but never while editing; Enter on the focused title opens it; max caps the length', async () => {
    const r = mk({ o: { canEdit: () => false } }); press(r.el); expect(r.el.querySelector('input')).toBeNull()
    const { el, t, calls } = mk({ o: { max: 8 } }); t.set('pushed'); expect(el.textContent).toBe('pushed')
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); expect(t.editing()).toBe(true); t.set('ignored'); expect(el.querySelector('input')).toBeTruthy()
    const input = el.querySelector('input'); expect(input.maxLength).toBe(8); input.value = '123456789012'; key(input, 'Enter'); await tick(); expect(calls).toEqual(['12345678'])
  })
  it('overlay mode floats the input over the element from document.body and never writes the element', async () => {
    const { el, t, calls } = mk({ o: { overlay: true, auto: false } })
    expect(t.open()).toBe(true); expect(el.querySelector('input')).toBeNull(); const input = document.querySelector('[data-qk-title-overlay] input'); expect(input.value).toBe('trip plan')
    input.value = 'floating'; key(input, 'Enter'); await tick()
    expect(calls).toEqual(['floating']); expect(el.textContent).toBe('trip plan'); expect(document.querySelector('[data-qk-title-overlay]')).toBeNull()   // the view repaints from its own state
  })
  it('keys typed in the input do not reach shortcuts behind it', () => {
    const { el } = mk(); press(el); const input = el.querySelector('input'); let seen = 0; document.addEventListener('keydown', () => { seen += 1 })
    key(input, 'a'); expect(seen).toBe(0)
  })
})
