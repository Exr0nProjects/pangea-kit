// The refill sentinel under the sync-level convergence fuzz (lib/testing/convergence-sync.js model.refill; the real rows.js
// over fake-indexeddb, outages, lost acks, killed tabs). After every step of a device and every sync the editor's rule runs
// on it; at rest no zone is empty on any device, every application found its zone empty and wrote exactly 2 rows, and the
// blank pads never exceed what the refills wrote. rows.prime / primeRefill read used pad generations off disk.
import { describe, expect, it, vi } from 'vitest'
import { writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openRows } from '../lib/engine/rows.js'
import { createMemoryStreamServer } from '../lib/stream-fake.js'
import { syncActions, runSync } from '../lib/testing/convergence-sync.js'
import { padId, primeRefill, refillPuts } from '../lib/editor/refill.js'
import { planted } from './planted.js'

globalThis.IDBKeyRange ??= IDBKeyRange
const KIT = resolve(import.meta.dirname, '..')
const ZONES = ['a', 'b', 'c']
const refill = { zones: ZONES, zoneOf: (r) => r.zone, make: (zone, k) => ({ body: '', ord: k, zone, deleted_at: null, source: 'pad' }) }
const sortKey = (r) => [ZONES.indexOf(r.zone), r.ord, r.id]
const live = (r) => !r.deleted_at
const model = {
  name: 'refill-model', sortKey, live, refill, shape: (r) => `${r.zone}|${r.body}`,
  seedRows: () => ZONES.flatMap((z) => [1, 2, 3].map((k) => ({ id: `s-${z}-${k}`, set: { body: `${z}${k}`, ord: k, zone: z, deleted_at: null } }))),
  edit({ rows, pick, int, token }) { const r = pick(rows); return { kind: 'type', target: r.id, op: { puts: [{ id: r.id, set: { body: `${r.body}${token()}${int(9)}` } }] }, typing: true } },
  wipe({ rows, all, pick, now }) { const r = pick(rows), iso = String(now()); return { kind: 'drop', target: r.id, op: { puts: all.filter((x) => x.zone === r.zone).map((x) => ({ id: x.id, set: { deleted_at: iso } })) } } },
}
const env = { IDBFactory, name: 'refill-sync', timers: { install: (now) => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now }), advance: (ms) => vi.advanceTimersByTimeAsync(ms), uninstall: () => { vi.clearAllTimers(); vi.useRealTimers() } } }
const extra = ['wipe', 'wipe', 'wipe', 'wipe']

describe('the refill sentinel under the sync fuzz (kit harness)', () => {
  it('600 seeds, 2-3 devices, whole-zone deletes: no zone empty at rest, exactly 2 rows per application, pads never exceed what the refills wrote', async () => {
    for (let seed = 1; seed <= 600; seed++) { const bad = await runSync(model, syncActions(seed, 25, { extra }), env); expect(bad, `seed ${seed}`).toBe(null) }
  }, 300_000)
  it('planted: a refill that writes one row too many (or reuses a dead pad id) is red under the same fuzz', async () => {
    const text = readFileSync(join(KIT, 'lib/editor/refill.js'), 'utf8')
    let plant = 0
    for (const [find, repl, what] of [['return Array.from({ length: n }, (_, i)', 'return Array.from({ length: n + 1 }, (_, i)', /wrote 3 rows/], ['while (used()) g += 1;', '', /rewrote a row this device had seen/]]) {
      expect(text.includes(find)).toBe(true)
      const name = `.planted-sync-refill-${process.pid}-${++plant}.js`, copy = join(KIT, 'lib/editor', name) // a fresh name: the module cache keys on the URL
      writeFileSync(copy, text.replace(find, repl))
      try {
        const mod = await planted('lib/testing/convergence-sync.js', "'../editor/refill.js'", `'../editor/${name}'`)
        let hit = 0
        for (let seed = 1; seed <= 120; seed++) { const bad = await mod.runSync(model, syncActions(seed, 40, { extra: [...extra, ...extra, ...extra] }), env).catch((e) => e.message); if (bad && what.test(String(bad))) hit += 1 }
        expect(hit, String(what)).toBeGreaterThan(5)
      } finally { rmSync(copy, { force: true }) }
    }
  }, 120_000)
  it('rows.prime reads rows off disk into memory so peek sees tombstones and rows outside the loaded window; primeRefill finds the used generations', async () => {
    const idb = new IDBFactory(), server = createMemoryStreamServer()
    const open = () => openRows({ name: 'prime', indexedDB: idb, transport: server, sortKey, live, Broadcast: null })
    const a = await open(); await a.load({ from: null })
    a.put([{ id: padId('b', 0, 1), set: { ...refill.make('b', 1), deleted_at: 'x' } }, { id: padId('b', 0, 2), set: { ...refill.make('b', 2), deleted_at: 'x' } }, { id: padId('b', 1, 1), set: refill.make('b', 1) }, { id: padId('b', 1, 2), set: refill.make('b', 2) }])
    await a.flushed(); await a.close()
    const b = await open(); await b.load({ from: [1] }) // a window that holds no live pad of b generation 1... and no tombstones
    expect(b.peek(padId('b', 0, 1))).toBeUndefined()
    expect(await b.prime([padId('b', 0, 1), padId('b', 9, 9)])).toBe(1)
    expect(b.peek(padId('b', 0, 1)).deleted_at).toBe('x')
    await primeRefill(b, refill)
    expect(b.peek(padId('b', 1, 2))).toBeTruthy()
    // an empty zone b now refills at generation 2, never reusing 0 or 1
    expect(refillPuts([], b.peek, refill, 'b', 1, true).map((p) => p.id)).toEqual([padId('b', 2, 1), padId('b', 2, 2)])
    await b.close()
  })
})
