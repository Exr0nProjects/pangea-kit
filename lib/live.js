// Page side of /view/<ULID>/__live. Events: hello {files}, state <json>, code {files}.
// hello after a reconnect is handled like code (a change missed while offline is still seen).
export function connectLive({ base = '', onFiles, onState, onStatus = () => {}, EventSourceImpl = globalThis.EventSource } = {}) {
  if (!EventSourceImpl) { onStatus('off'); return () => {} }
  const es = new EventSourceImpl(`${base}__live`)
  const json = (t) => { try { return JSON.parse(t) } catch { return null } }
  es.addEventListener('hello', (e) => { const d = json(e.data); if (d?.files) onFiles(d.files, 'hello'); onStatus('live') })
  es.addEventListener('code', (e) => { const d = json(e.data); if (d?.files) onFiles(d.files, 'code') })
  es.addEventListener('state', (e) => { const d = json(e.data); if (d && typeof d === 'object') onState(d) })
  es.onerror = () => onStatus('reconnecting')
  return () => es.close()
}

/** POST a JSON record to __view, coalescing: at most one in flight, the newest wins. */
export function createReporter({ base = '', fetchImpl = (...a) => globalThis.fetch(...a), delay = 300 } = {}) {
  let timer = null, latest = null, inflight = false
  async function send() {
    if (inflight || latest === null) return
    const body = latest; latest = null; inflight = true
    try { await fetchImpl(`${base}__view`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }) } catch {}
    inflight = false
    if (latest !== null) send()
  }
  return {
    report(text) { latest = text; clearTimeout(timer); timer = setTimeout(send, delay) },
    flush() { clearTimeout(timer); return send() },
  }
}
