// Async answers: the runner for the request() state component (lib/components.js), Pangea's AsyncActionMixin + JobHandle
// (P1:954-972, :1259; py l1/job_handle.py, l2/mixins.py AsyncStatusMixin; PANGEA3-DESIGN section 8, rows #15, #22, #29,
// #31). The request's lifecycle (pending, running, completed, failed, cancelled) is kit STATE in a declared replica, so
// it renders, persists and syncs like anything else, and every answer is an absolute action keyed by the request id:
// a late, duplicated or superseded answer is a no-op by the reducer, never by a flag in this file.
//
//   const req = app.use(declareComponent('search', request(), { scope: 'ephemeral' }))
//   const runner = createRequester(req)                          // { deadlineMs, now, mint, setTimer, clearTimer }
//   const job = runner.run(({ signal, progress }) => fetchHits(q, { signal }))   // -> JobHandle
//   job.status()            // 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'superseded'
//   await job.await_completion({ timeoutMs })                   // the result, or a typed error (lib/errors.js)
//   job.cancel()            // aborts the work (its AbortSignal) and dispatches cancel
//
// Latest wins: run() mints a new ULID, dispatches `request` (superseding whatever was current), aborts the previous job's
// signal, dispatches `start` and calls the work. Its answer is `complete`/`fail` for its own id; the reducer drops it if a
// newer request, a cancel or the deadline got there first. The deadline (default DEADLINE_MS.read; the component's
// `waits` exit edge) dispatches `fail { code: 'AsyncTimeout' }` and aborts the work. Model calls are exempt from wall-clock
// bounds (The owner): pass deadlineMs: Infinity for them. Each lifecycle action carries the intent id `<request id>.<op>`
// (py emit: children get parent.action_id + "." + n), so a redelivered start/complete/fail/cancel is a no-op at dispatch.

import { DEADLINE_MS } from './deadline.js';
import { ulid as defaultMint } from './ulid.js';
import { AsyncCancelledError, AsyncFailedError, AsyncTimeoutError, ERRORS, errorShape } from '../errors.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** The typed error for a request state that did not complete (null when it did or is still running). */
export function requestError(state, jobId) {
  if (!state || state.id !== jobId) return new AsyncCancelledError({ job_id: jobId, cancel_actor: 'superseded' });
  if (state.status === 'cancelled') return new AsyncCancelledError({ job_id: jobId, cancel_actor: state.error?.actor ?? 'user' });
  if (state.status !== 'failed') return null;
  const e = state.error || {};
  if (e.code === 'AsyncTimeout') return new AsyncTimeoutError({ job_id: jobId, timeout_ms: e.timeout_ms ?? null });
  const Klass = ERRORS[e.name];
  if (Klass && Klass !== AsyncFailedError && e.name !== 'ActionError') { try { const { name, code, message, ...fields } = e; const err = new Klass(fields, { message, code }); return err; } catch { /* fall through */ } }
  return new AsyncFailedError({ job_id: jobId, error: e }, { message: `request ${jobId} failed: ${e.code}${e.message ? `: ${e.message}` : ''}`, code: e.code });
}

/** createRequester(replica, opts) -> { run(work, { deadlineMs, id }) -> JobHandle, current() -> JobHandle | null }.
 *  `replica` holds a request() component (app.use(declareComponent(name, request(), ...))). */
export function createRequester(replica, { deadlineMs = DEADLINE_MS.read, now = () => Date.now(), mint = defaultMint,
  setTimer = (f, ms) => globalThis.setTimeout(f, ms), clearTimer = (t) => globalThis.clearTimeout(t) } = {}) {
  let current = null; // { id, controller, timer }
  const act = (type, payload, id) => { try { return replica.dispatch(type, payload, id ? { id } : {}); } catch { return null; } };

  function handle(id, ctl) {
    const state = () => replica.get();
    const status = () => { const s = state(); return s.id !== id ? 'superseded' : s.status; };
    const settled = () => TERMINAL.has(status()) || status() === 'superseded';
    return {
      job_id: id, job_type: 'async_action',
      status,
      progress: () => { const s = state(); return s.id === id ? { value: s.progress, text: s.status_text } : null; },
      /** The answer, or the typed error: AsyncCancelledError (cancelled or superseded), AsyncTimeoutError, the failure. */
      result() {
        const s = state(), st = status();
        if (st === 'completed') return s.result;
        const e = requestError(s, id);
        if (e) throw e;
        throw new AsyncTimeoutError({ job_id: id, timeout_ms: 0 }, { message: `request ${id} is ${st}: no result yet` });
      },
      cancel(actor = 'user') { if (settled()) return false; ctl.abort('cancelled'); act('cancel', { id, actor, at: now() }, `${id}.cancel`); return true; },
      /** Resolves with the result when the request ends (rejects with its typed error); `timeoutMs` bounds the wait
       *  itself (AsyncTimeoutError) without touching the request. */
      await_completion({ timeoutMs = Infinity } = {}) {
        return new Promise((resolve, reject) => {
          let timer = null, off = () => {};
          const finish = () => { try { resolve(this.result()); } catch (e) { reject(e); } };
          const check = () => { if (settled()) { off(); clearTimer(timer); finish(); return true; } return false; };
          if (check()) return;
          off = replica.subscribe(() => { check(); });
          if (Number.isFinite(timeoutMs)) timer = setTimer(() => { off(); reject(new AsyncTimeoutError({ job_id: id, timeout_ms: timeoutMs })); }, timeoutMs);
        });
      },
    };
  }

  function run(work, { deadlineMs: ms = deadlineMs, id = mint() } = {}) {
    if (typeof work !== 'function') throw new TypeError('run(work): work is ({ signal, progress, id }) => Promise');
    if (current) { clearTimer(current.timer); current.controller.abort('superseded'); }
    const controller = typeof AbortController === 'function' ? new AbortController() : { signal: null, abort() {} };
    const t0 = now();
    act('request', { id, at: t0, deadline_at: Number.isFinite(ms) ? t0 + ms : null }, `${id}.request`);
    const job = handle(id, controller);
    const me = { id, controller, timer: null };
    current = me;
    if (Number.isFinite(ms)) {
      me.timer = setTimer(() => {
        controller.abort('timeout');
        act('fail', { id, error: { name: 'AsyncTimeoutError', code: 'AsyncTimeout', timeout_ms: ms }, at: now() }, `${id}.fail`);
      }, ms);
      me.timer?.unref?.();
    }
    act('start', { id, at: now() }, `${id}.start`);
    let n = 0;
    const progress = (value, text) => act('progress', { id, value, ...(typeof text === 'string' ? { text } : {}) }, `${id}.progress.${++n}`);
    Promise.resolve().then(() => work({ signal: controller.signal, progress, id })).then(
      (result) => {
        let json; try { json = JSON.parse(JSON.stringify(result === undefined ? null : result)); } catch { json = undefined; }
        if (json === undefined) return act('fail', { id, error: { code: 'ResultNotJson', message: 'an answer is state: it must survive JSON' }, at: now() }, `${id}.fail`);
        return act('complete', { id, result: json, at: now() }, `${id}.complete`);
      },
      (cause) => act('fail', { id, error: errorShape(cause) || { code: 'Error' }, at: now() }, `${id}.fail`),
    ).finally(() => { clearTimer(me.timer); if (current === me) current = null; });
    return job;
  }

  return { run, current: () => (current ? handle(current.id, current.controller) : null) };
}
