// First-class derived state: the kit knows that a value can be a function of other state, that computing it can be in
// flight, and exposes that as data (status, value, error, progress) so a view can render a pending look and the host can
// show one spinner for everything in flight. Framework-free and DOM-free; the Svelte binding is host/kit.svelte.js, the
// indicator lib/derived-dom.js. Design and rationale: docs/DERIVED-STATE.md.
//
//   const d = createDerived()
//   d.define('scene', { run: async (inputs, { signal, progress, prev }) => build(inputs), debounceMs: 0, keep: 'previous' })
//   d.set('scene', { preset: 'cortex' })        // synchronous and cheap: marks pending, schedules the run AFTER the next paint
//   d.get('scene')   // { status: 'idle' | 'pending' | 'stale' | 'ready' | 'error', value, error, progress, inputsKey, via, attempt, pending }
//
// Rules (each one is a test in tests/derived.test.js):
//   - set() never runs the function. It compares the inputs key, supersedes an in-flight run (abort + ignore its late
//     answer even when the function ignores the signal), serves a cached value at once, else marks the status and schedules.
//   - latest wins: only the newest key's answer is ever applied; an older answer, however late, is dropped.
//   - stale-while-revalidate: keep 'previous' (default) shows the old value with status 'stale' while the new one computes.
//   - errors never throw into the caller: status 'error', the error shape, the previous value still readable.
//   - the kit persists nothing here: inputs live in state, a derived value is recomputed after a reload.
export const DEFAULTS = { keep: 'previous', debounceMs: 0, timeoutMs: Infinity, retries: 0, retryBackoffMs: 300, cache: 4 }
const PENDING = new Set(['pending', 'stale'])

/** Run `fn` after the next paint: rAF then a macrotask (so the click that caused this has been painted), with a timer
 *  fallback for a hidden tab (rAF paused) and plain setTimeout outside a browser. */
export function afterPaint(fn, g = globalThis) {
  if (typeof g.requestAnimationFrame !== 'function') { g.setTimeout(fn, 0); return }
  let done = false
  const go = () => { if (!done) { done = true; fn() } }
  g.requestAnimationFrame(() => g.setTimeout(go, 0))
  g.setTimeout(go, 250)
}

const errShape = (e, extra = {}) => ({ name: e?.name || 'Error', code: e?.code || null, message: String(e?.message ?? e), ...extra })
const abortError = (reason) => Object.assign(new Error(reason), { name: 'AbortError', code: 'AsyncCancelled' })

export function createDerived({ schedule = afterPaint, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t), now = () => Date.now() } = {}) {
  const entries = new Map(), listeners = new Set(), syncListeners = new Set(), idleWaiters = []
  let queued = false
  const notify = () => {
    for (const f of [...syncListeners]) { try { f(api) } catch (e) { console.error('[pangea-kit] derived sync listener', e) } }
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      for (const f of [...listeners]) { try { f(api) } catch (e) { console.error('[pangea-kit] derived listener', e) } }
      if (!count()) for (const r of idleWaiters.splice(0)) r()
    })
  }
  const count = () => { let n = 0; for (const e of entries.values()) if (PENDING.has(e.s.status)) n++; return n }
  const blank = { status: 'idle', value: undefined, hasValue: false, error: null, progress: null, inputsKey: null, via: null, attempt: 0, since: null, cached: false, pending: false }
  const put = (e, patch) => { e.s = { ...e.s, ...patch }; e.s.pending = PENDING.has(e.s.status); notify() }
  const stop = (e, reason = 'superseded') => { // abort whatever is in flight and make its answer irrelevant
    e.token++
    if (e.timers.size) { for (const t of e.timers) clearTimer(t); e.timers.clear() }
    if (e.ctrl) { try { e.ctrl.abort(abortError(reason)) } catch {} e.ctrl = null }
  }
  const later = (e, fn, ms) => { const t = setTimer(() => { e.timers.delete(t); fn() }, ms); e.timers.add(t) }

  function start(e) {
    const token = ++e.token, { def } = e
    const go = () => { if (token === e.token) exec(e, token, 0) }
    if (def.debounceMs > 0) later(e, () => schedule(go), def.debounceMs); else schedule(go)
  }

  async function exec(e, token, attempt) {
    const { def, inputs, key } = e
    const ctrl = (e.ctrl = new AbortController())
    if (attempt) put(e, { attempt })
    let timer = null, timedOut = false
    if (Number.isFinite(def.timeoutMs)) timer = setTimer(() => { timedOut = true; ctrl.abort(Object.assign(new Error(`timed out after ${def.timeoutMs} ms`), { name: 'AsyncTimeoutError', code: 'AsyncTimeout', timeout_ms: def.timeoutMs })) }, def.timeoutMs)
    const guard = new Promise((_, rej) => ctrl.signal.addEventListener('abort', () => rej(ctrl.signal.reason)))
    const ctx = { signal: ctrl.signal, key, attempt, prev: e.s.hasValue ? e.s.value : undefined, progress: (fraction, text) => { if (token === e.token) put(e, { progress: { fraction: fraction ?? null, text: text ?? null } }) } }
    const call = (fn, ...a) => Promise.race([Promise.resolve().then(() => fn(inputs, ctx, ...a)), guard])
    try {
      let value, via = 'primary'
      try { value = await call(def.run) } catch (err) {
        if (token !== e.token) return
        if (!timedOut && !ctrl.signal.aborted && attempt < def.retries) { // transient failure: retry with backoff, same token
          if (timer) clearTimer(timer)
          later(e, () => { if (token === e.token) exec(e, token, attempt + 1) }, def.retryBackoffMs * 2 ** attempt)
          put(e, { attempt: attempt + 1 }); return
        }
        if (!def.fallback) throw err
        value = await call(def.fallback, err); via = 'fallback'
        e.fallbackReason = errShape(err)
      }
      if (token !== e.token) return // superseded or cancelled while running: the answer is dropped
      e.cache.delete(key); e.cache.set(key, { value, via }); while (e.cache.size > def.cache) e.cache.delete(e.cache.keys().next().value)
      put(e, { status: 'ready', value, hasValue: true, error: null, progress: null, via, cached: false, fallbackReason: via === 'fallback' ? e.fallbackReason : null })
    } catch (err) {
      if (token !== e.token) return
      put(e, { status: 'error', error: errShape(err, timedOut ? { timeout_ms: def.timeoutMs } : {}), progress: null, via: null })
    } finally {
      if (timer) clearTimer(timer)
      if (token === e.token) e.ctrl = null
    }
  }

  const api = {
    /** Declare a derivation. Redefining a name (a hot-swapped part) cancels the old run and keeps the last value. */
    define(name, def) {
      if (typeof def?.run !== 'function') throw new Error(`derived "${name}": run must be a function (inputs, { signal, progress, prev }) => value`)
      if (!/^[\w-]+$/.test(name)) throw new Error(`derived name "${name}" must match [\\w-]+ (it becomes a CSS attribute value)`)
      let e = entries.get(name)
      if (!e) { e = { name, s: { ...blank }, token: 0, ctrl: null, timers: new Set(), cache: new Map(), key: null, inputs: undefined }; entries.set(name, e) }
      else { stop(e, 'redefined'); e.key = null; if (PENDING.has(e.s.status)) put(e, { status: e.s.hasValue ? 'ready' : 'idle' }) }
      e.def = { ...DEFAULTS, ...def }
      notify()
      return () => { if (entries.get(name) === e) { stop(e, 'disposed'); entries.delete(name); notify() } }
    },
    /** New inputs (already plain data). Cheap and synchronous; the function runs later. Returns true when it started or served something new. */
    set(name, inputs) {
      const e = entries.get(name)
      if (!e) throw new Error(`derived "${name}" is not defined`)
      const key = e.def.key ? e.def.key(inputs) : JSON.stringify(inputs)
      if (key === e.key && e.s.status !== 'error' && e.s.status !== 'idle') { e.inputs = inputs; return false } // same inputs: nothing to do
      stop(e); e.key = key; e.inputs = inputs
      const hit = e.cache.get(key)
      if (hit) { e.cache.delete(key); e.cache.set(key, hit); put(e, { status: 'ready', value: hit.value, hasValue: true, error: null, progress: null, inputsKey: key, via: hit.via, attempt: 0, cached: true, since: null }); return true }
      const keep = e.def.keep === 'previous' && e.s.hasValue
      put(e, { status: keep ? 'stale' : 'pending', value: keep ? e.s.value : undefined, hasValue: keep, error: null, progress: null, inputsKey: key, via: null, attempt: 0, cached: false, since: now() })
      start(e); return true
    },
    /** Retry a failed derivation with its current inputs. */
    retry(name) { const e = entries.get(name); if (!e || e.s.status !== 'error') return false; stop(e); const keep = e.def.keep === 'previous' && e.s.hasValue; put(e, { status: keep ? 'stale' : 'pending', value: keep ? e.s.value : undefined, error: null, attempt: 0, since: now() }); start(e); return true },
    /** Throw away the cache and recompute with the same inputs (something outside the inputs changed). */
    invalidate(name) { const e = entries.get(name); if (!e || e.inputs === undefined) return false; e.cache.clear(); const inputs = e.inputs; e.key = null; return api.set(name, inputs) },
    /** Stop the in-flight run; the previous value (if any) stays and the status settles to ready, else idle. */
    cancel(name) { const e = entries.get(name); if (!e || !PENDING.has(e.s.status)) return false; stop(e, 'cancelled'); e.key = null; put(e, { status: e.s.hasValue ? 'ready' : 'idle', progress: null, since: null }); return true },
    get: (name) => entries.get(name)?.s ?? null,
    all: () => [...entries].map(([n, e]) => [n, e.s]),
    /** What is in flight: [{ name, label, status, since, progress, attempt }], oldest first. */
    running: () => [...entries.values()].filter((e) => PENDING.has(e.s.status)).map((e) => ({ name: e.name, label: e.def.label || e.name, status: e.s.status, since: e.s.since, progress: e.s.progress, attempt: e.s.attempt })).sort((a, b) => a.since - b.since),
    get count() { return count() },
    /** Called after any status change: coalesced in a microtask, or with { sync: true } immediately inside the change (the
     *  host binding mirrors the record and the indicator this way, so a view reads "pending" in the same tick as the dispatch). */
    subscribe(fn, { sync = false } = {}) { const set = sync ? syncListeners : listeners; set.add(fn); return () => set.delete(fn) },
    /** Resolves when nothing is in flight (tests and the headless harness: `await window.__pangea.derived.idle()`). */
    idle() { return new Promise((r) => { if (!count() && !queued) r(); else { idleWaiters.push(r); notify() } }) },
  }
  return api
}
