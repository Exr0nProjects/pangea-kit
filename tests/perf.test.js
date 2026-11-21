// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installPerf } from '../host/perf.js'

let cb, observed
class FakePO {
  constructor(fn) { cb = fn }
  observe(o) { observed.push(o) }
}
const emit = (...entries) => cb({ getEntries: () => entries })
const ev = (duration, name = 'click', id = 'btn') => ({ entryType: 'event', name, duration, startTime: 1, target: { getAttribute: () => id } })

beforeEach(() => {
  observed = []
  vi.useFakeTimers()
  globalThis.PerformanceObserver = FakePO
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); delete globalThis.PerformanceObserver })

describe('installPerf', () => {
  it('observes longtask and event with durationThreshold 16, exposes budgetMs', () => {
    const kit = {}
    installPerf(kit, { budgetMs: 40 })
    expect(kit.perf.budgetMs).toBe(40)
    expect(observed.map((o) => o.type)).toEqual(['longtask', 'event'])
    expect(observed[1].durationThreshold).toBe(16)
  })
  it('records over-budget entries with pending derived names, ignores under-budget', () => {
    const kit = { pending: { list: [{ name: 'fft' }] } }
    installPerf(kit)
    emit(ev(30), ev(120), { entryType: 'longtask', name: 'self', duration: 80, startTime: 5 })
    expect(kit.perf.slow).toHaveLength(2)
    expect(kit.perf.slow[0]).toMatchObject({ ms: 120, kind: 'event', name: 'click btn', pendingDerived: ['fft'] })
    expect(kit.perf.slow[1]).toMatchObject({ kind: 'longtask', name: 'longtask' })
  })
  it('caps the ring buffer at 100', () => {
    const kit = {}
    installPerf(kit)
    emit(...Array.from({ length: 130 }, (_, i) => ({ ...ev(60 + i), startTime: i })))
    expect(kit.perf.slow).toHaveLength(100)
    expect(kit.perf.slow[0].t).toBe(30)
  })
  it('warns once per name per 10 s', () => {
    installPerf({})
    emit(ev(90), ev(95))
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn.mock.calls[0][0]).toBe('[kit] interaction over budget: click btn took 90 ms; move the work behind kit.derive')
    emit(ev(90, 'click', 'other'))
    expect(console.warn).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(10001)
    emit(ev(90))
    expect(console.warn).toHaveBeenCalledTimes(3)
  })
  it('does not throw without PerformanceObserver', () => {
    delete globalThis.PerformanceObserver
    const kit = {}
    expect(() => installPerf(kit)).not.toThrow()
    expect(kit.perf.slow).toEqual([])
  })
})
