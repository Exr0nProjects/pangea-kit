// The host's part mount: a part's own heavy data must never hold back another part. The MICrONS viewer's panel
// (parts/90-panel.js, UI only) appeared ~36 s after load because each part awaited its data before the next part's
// script was even fetched. These tests fail on that serial loop.
import { describe, it, expect } from 'vitest'
import { mountParts } from '../lib/parts.js'
import { createKeys } from '../lib/keys.js'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise((r) => setTimeout(r, 0))

function harness(files, { slowData, scriptDelay = {}, badScript = [] } = {}) {
  const log = []
  const loads = []
  const mounted = []
  const failed = []
  const load = async (file) => {
    loads.push(file)
    if (scriptDelay[file]) await scriptDelay[file]
    if (badScript.includes(file)) throw new Error(`${file}: HTTP 404`)
    return async (ctx) => { log.push(`start ${ctx.name}`); if (slowData?.[ctx.name]) await slowData[ctx.name].promise; log.push(`done ${ctx.name}`) }
  }
  const mount = (name, factory, rank) => { const ctx = { name, rank }; mounted.push([name, rank]); return factory(ctx) }
  const fail = (name, e) => failed.push([name, e.message])
  return { log, loads, mounted, failed, run: () => mountParts(files, { load, mount, fail }) }
}

describe('mountParts: parts never wait on each other', () => {
  const files = ['parts/10-vessels.js', 'parts/20-em.js', 'parts/40-cells.js', 'parts/90-panel.js']

  it('mounts the panel while every data layer is still loading', async () => {
    const slow = { '10-vessels': deferred(), '20-em': deferred(), '40-cells': deferred() }
    const h = harness(files, { slowData: slow })
    const all = h.run()
    await tick(); await tick()
    expect(h.log).toContain('done 90-panel') // the UI-only part is up before any data arrived
    expect(h.log.filter((l) => l.startsWith('start'))).toEqual(['start 10-vessels', 'start 20-em', 'start 40-cells', 'start 90-panel'])
    let settled = false; all.then(() => { settled = true })
    await tick(); expect(settled).toBe(false) // still waiting on the data layers
    slow['20-em'].resolve(); slow['40-cells'].resolve(); slow['10-vessels'].resolve()
    await all
    expect(h.log.filter((l) => l.startsWith('done')).length).toBe(4)
  })

  it('fetches every part script at once, before any part has mounted', async () => {
    const gate = deferred()
    const h = harness(files, { scriptDelay: { 'parts/10-vessels.js': gate.promise } })
    const all = h.run()
    await tick()
    expect(h.loads).toEqual(files) // all four requests out while the first is still pending
    gate.resolve(); await all
  })

  it('creates part contexts in file order with their rank even when scripts arrive out of order', async () => {
    const first = deferred()
    const h = harness(files, { scriptDelay: { 'parts/10-vessels.js': first.promise } })
    const all = h.run()
    await tick(); await tick()
    expect(h.mounted).toEqual([]) // 20/40/90 arrived first but wait for 10's script (not its data)
    first.resolve(); await all
    expect(h.mounted).toEqual([['10-vessels', 0], ['20-em', 1], ['40-cells', 2], ['90-panel', 3]])
  })

  it('reports a part whose script fails and still mounts the rest', async () => {
    const h = harness(files, { badScript: ['parts/20-em.js'] })
    await h.run()
    expect(h.failed).toEqual([['20-em', 'parts/20-em.js: HTTP 404']])
    expect(h.mounted.map(([n]) => n)).toEqual(['10-vessels', '40-cells', '90-panel'])
  })

  it('reports a part whose factory throws without blocking later parts', async () => {
    const h = harness(files)
    const run = mountParts(files, {
      load: async (f) => (f === 'parts/10-vessels.js' ? async () => { throw new Error('boom') } : async () => {}),
      mount: (name, factory) => { h.mounted.push(name); return factory({ name }) },
      fail: (name, e) => h.failed.push([name, e.message]),
    })
    await run
    expect(h.failed).toEqual([['10-vessels', 'boom']])
    expect(h.mounted).toEqual(['10-vessels', '20-em', '40-cells', '90-panel'])
  })
})

describe('keys rank: binding order no longer depends on which part mounted first', () => {
  const press = (target, key) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  it('a higher-rank part wins over a lower-rank part that bound later; unranked host default loses to both', () => {
    const t = new EventTarget(); t.document = { activeElement: null }
    const keys = createKeys(t, { mac: true })
    const hits = []
    keys.bind({ x: () => hits.push('host') }, { rank: -1 })
    keys.bind({ g: () => hits.push('tools'), x: () => hits.push('tools-x') }, { rank: 4 }) // tools (rank 4) mounts first
    keys.bind({ g: () => hits.push('vessels') }, { rank: 0 }) // vessels' data arrives later: binds last, ranks lower
    press(t, 'g'); press(t, 'x')
    expect(hits).toEqual(['tools', 'tools-x'])
    const off = keys.bind({ g: () => hits.push('unranked') }) // unranked: newest wins, as before
    press(t, 'g'); off(); press(t, 'g')
    expect(hits.slice(2)).toEqual(['unranked', 'tools'])
  })
})
