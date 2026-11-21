// @vitest-environment node
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp, declare } from '../lib/model.js'
import { fileStorage } from '../lib/node-storage.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'node-storage-'))
const decl = () => declare({
  name: 'daemon-demo', scope: 'local', durable: true, initial: { n: 0 },
  actions: { 'n.set': (s, { n }) => (s.n === n ? s : { ...s, n }) },
})

describe('fileStorage: the kit state core inside a Node daemon', () => {
  it('a declared state survives a restart through the file, and a retried id is a no-op', () => {
    const dir = tmp(), file = path.join(dir, 'store.json')
    const a = createApp({ storage: fileStorage(file), device: 'd1', engine: false }).use(decl())
    const e = a.dispatch('n.set', { n: 7 }, { id: 'intent-1' })
    expect(e.id).toBe('intent-1')
    const b = createApp({ storage: fileStorage(file), device: 'd1', engine: false }).use(decl())
    expect(b.get().n).toBe(7)
    expect(b.dispatch('n.set', { n: 7 }, { id: 'intent-1' })).toBeNull() // already logged or equal: nothing changes
    expect(fs.readdirSync(dir)).toEqual(['store.json']) // no temp file left behind
  })
  it('a corrupt file is moved aside, never overwritten, and the store starts empty', () => {
    const dir = tmp(), file = path.join(dir, 'store.json')
    fs.writeFileSync(file, '{"qk:daemon-demo": "truncated')
    const st = fileStorage(file, { now: () => 42 })
    expect(st.recovered).toBe(`${file}.corrupt-42`)
    expect(fs.readFileSync(st.recovered, 'utf8')).toBe('{"qk:daemon-demo": "truncated') // the bytes are kept
    expect(st.length).toBe(0)
    st.setItem('k', 'v')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ k: 'v' })
  })
  it('planted: a write that fails leaves the old value in memory and on disk', () => {
    const dir = tmp(), file = path.join(dir, 'store.json')
    const st = fileStorage(file)
    st.setItem('k', 'old')
    fs.chmodSync(dir, 0o500) // the directory refuses the temp file
    try {
      if (process.getuid?.() === 0) return // root ignores the mode; the case cannot be made
      expect(() => st.setItem('k', 'new')).toThrow()
      expect(st.getItem('k')).toBe('old')
      expect(st.lastError).toBeTruthy()
    } finally { fs.chmodSync(dir, 0o700) }
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ k: 'old' })
  })
  it('removeItem, key, length and clear follow the Storage contract', () => {
    const st = fileStorage(path.join(tmp(), 's.json'))
    st.setItem('a', '1'); st.setItem('b', '2')
    expect([st.length, st.key(0), st.key(5)]).toEqual([2, 'a', null])
    st.removeItem('a'); st.removeItem('zzz')
    expect([st.getItem('a'), st.getItem('b')]).toEqual([null, '2'])
    st.clear()
    expect(st.length).toBe(0)
  })
})
