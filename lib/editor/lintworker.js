// The page's end of a checker that runs in a Web Worker (the checker is heavy WASM: it never runs on the typing thread, A11). `workerCheck({ spawn,
// idle, timeoutMs })` -> `check(text) -> Promise<findings>` for lib/editor/lintdom.js: the worker is made on the first check (after `idle()`, so the
// page's own boot is not competing with a download of several MB), each request carries an id, the worker answers `{ id, items }` or `{ id, error }`,
// a request that is not answered within `timeoutMs` rejects (the line is then not asked again until its text changes, lintdom `failed`), and a
// worker that dies rejects everything in flight and is made again by the next check. The protocol of the worker: `{ id, text }` in,
// `{ id, items: [{ start, end, kind, message, suggestions, text }] }` out; `{ ready: true }` once when it can answer (its binary is loaded).
// The binary is big (zai3: ~20 MB of WASM): until the worker has said `ready` a request waits `loadTimeoutMs` (default 10 minutes, a slow
// network is not an error), after it `timeoutMs`. A rejected request is never final for the caller (lintdom asks again after a backoff), and a
// worker that failed to load answers `{ id, error }`, so the next check asks it again (the worker retries its own load).
export function workerCheck({ spawn, idle = () => Promise.resolve(), timeoutMs = 20_000, loadTimeoutMs = 600_000, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t) }) {
  let worker = null, starting = null, seq = 0, ready = false;
  const waiting = new Map(); // id -> { resolve, reject, timer }
  const fail = (why) => { for (const [, w] of waiting) { clearTimer(w.timer); w.reject(new Error(why)); } waiting.clear(); };
  const onMessage = (e) => {
    const m = e?.data; if (!m || typeof m !== 'object') return;
    if (m.ready) { ready = true; return; }
    const w = waiting.get(m.id); if (!w) return;
    waiting.delete(m.id); clearTimer(w.timer);
    if (m.error) w.reject(new Error(String(m.error))); else w.resolve(Array.isArray(m.items) ? m.items : []);
  };
  const start = () => (starting ||= idle().then(() => {
    worker = spawn();
    worker.onmessage = onMessage;
    worker.onerror = () => { fail('checker crashed'); try { worker.terminate?.(); } catch { /* gone */ } worker = null; starting = null; ready = false; };
    return worker;
  }));
  const check = async (text) => {
    const w = worker || await start();
    return new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject, timer: setTimer(() => { waiting.delete(id); reject(new Error('checker timed out')); }, ready ? timeoutMs : loadTimeoutMs) });
      try { w.postMessage({ id, text }); } catch (e) { waiting.delete(id); reject(e); }
    });
  };
  check.dispose = () => { fail('checker closed'); try { worker?.terminate?.(); } catch { /* gone */ } worker = null; starting = null; ready = false; };
  return check;
}
