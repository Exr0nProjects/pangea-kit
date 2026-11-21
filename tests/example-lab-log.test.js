// The second example app (apps/lab-log) on the same engine modules as webchat's chat core: offline write, reload,
// delivery under one id, two tabs on one engine, offline search, refusal handed back.
import { describe, expect, it } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { connectEngine, microtaskChannel } from '../lib/engine/host.js'
import { makeLabServer, memoryLabApi } from '../apps/lab-log/lab-log.mjs'

globalThis.IDBKeyRange ??= IDBKeyRange
const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, n = 200) => { for (let i = 0; i < n && !(await fn()); i++) await tick(); return fn() }

describe('lab-log, a non-chat app on the kit engine', () => {
  it('writes offline, survives a reload, delivers once, and two tabs see one engine', async () => {
    const api = memoryLabApi()
    api.state.down = true
    const indexedDB = new IDBFactory()
    const server1 = makeLabServer({ api, indexedDB })
    const tab = connectEngine({ name: 'lab', prefer: 'local', local: () => server1 })
    await tab.ready
    const id = await tab.call('write', { experiment: 'tank-01', text: 'degassed 40 min, 22.1 C' })
    expect(Object.keys(tab.state().pending)).toEqual([id])
    await tick(20) // its first attempt fails while the server is down
    // the browser closes; a new engine starts on the same IndexedDB with the server back
    api.state.down = false
    const server2 = makeLabServer({ api, indexedDB })
    const a = connectEngine({ name: 'lab2', hasShared: true, shared: () => { const ch = microtaskChannel(); server2.connect(ch.port1); return { port: ch.port2 } } })
    const b = connectEngine({ name: 'lab2', hasShared: true, shared: () => { const ch = microtaskChannel(); server2.connect(ch.port1); return { port: ch.port2 } } })
    await a.ready; await b.ready
    expect(await until(() => api.rows.length === 1)).toBe(true)
    expect(api.rows[0].id).toBe(id)                               // the id minted offline is the one delivered
    expect(await until(() => Object.keys(b.state().entries).length === 1)).toBe(true)
    expect(b.state().pending).toEqual({})
    await a.call('write', { experiment: 'phantom-3', text: 'agar 2 percent, degassed' })
    expect(await until(() => Object.keys(b.state().entries).length === 2)).toBe(true)
    // offline search over the replica, with coverage
    api.state.down = true
    const r = await b.call('search', 'degassed')
    expect(r.hits.map((h) => h.part).sort()).toEqual(['phantom-3', 'tank-01'])
    expect(r.complete).toBe(true)
  })

  it('a refused entry is handed back, not retried or dropped silently', async () => {
    const api = memoryLabApi()
    const server = makeLabServer({ api })
    const tab = connectEngine({ name: 'lab3', prefer: 'local', channel: microtaskChannel, local: () => server })
    await tab.ready
    await tab.call('write', { experiment: 'x', text: '' })
    expect(await until(() => tab.state().status.refused.length === 1)).toBe(true)
    expect(tab.state().status.refused[0].status).toBe(400)
  })
})
