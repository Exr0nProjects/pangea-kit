// Main-thread interaction budget monitor: records longtasks and slow input events over budget into kit.perf.slow.
const RING = 100, WARN_EVERY_MS = 10000, FLAG_MS = 2000

export function installPerf(kit, { budgetMs = 50 } = {}) {
  const slow = []
  const perf = { budgetMs, slow }
  kit.perf = perf
  const PO = globalThis.PerformanceObserver
  if (typeof PO !== 'function') return perf
  const lastWarn = new Map()
  let flagTimer = 0
  const nameOf = (e, kind) => {
    if (kind === 'longtask') return 'longtask'
    const t = e.target
    const id = t?.getAttribute?.('data-id') || t?.tagName?.toLowerCase?.() || ''
    return id ? `${e.name} ${id}` : e.name
  }
  const flag = () => {
    const el = globalThis.document?.documentElement
    if (!el) return
    el.setAttribute('data-qk-slow', '1')
    clearTimeout(flagTimer)
    flagTimer = setTimeout(() => el.removeAttribute('data-qk-slow'), FLAG_MS)
  }
  const onEntries = (list) => {
    for (const e of list.getEntries()) {
      if (!(e.duration > budgetMs)) continue
      const kind = e.entryType === 'longtask' ? 'longtask' : 'event'
      const name = nameOf(e, kind), ms = Math.round(e.duration)
      const pendingDerived = (kit.pending?.list || []).map((p) => (typeof p === 'string' ? p : p?.name)).filter(Boolean)
      slow.push({ t: e.startTime, ms, kind, name, pendingDerived })
      if (slow.length > RING) slow.splice(0, slow.length - RING)
      const now = Date.now()
      if (now - (lastWarn.get(name) ?? -Infinity) >= WARN_EVERY_MS) {
        lastWarn.set(name, now)
        console.warn(`[kit] interaction over budget: ${name} took ${ms} ms; move the work behind kit.derive`)
      }
      flag()
    }
  }
  try {
    const obs = new PO(onEntries)
    for (const [type, extra] of [['longtask', {}], ['event', { durationThreshold: 16 }]]) {
      try { obs.observe({ type, buffered: true, ...extra }) } catch { /* entry type unsupported here */ }
    }
  } catch { /* observer unavailable */ }
  return perf
}
