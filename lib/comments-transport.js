// The transport of a comments op log (lib/comments.js commentsDecl): the app's server is the sink (PANGEA3 §7: "comments stream
// owner-devices only; guests write through the docs server"). The kit replica appends every comment to its durable outbox
// before this sends anything; a push that fails offline leaves the entries pending, so nothing typed is held only by a request.
import { fromStreamEntry } from './model.js';

export const isOffline = (e) => Boolean(e?.offline) || e?.name === 'TimeoutError' || e?.name === 'AbortError' || e instanceof TypeError;
/** POST { ops } to `url` as JSON: the answer, or a throw: { offline: true } for no answer, a 5xx or a page that is not JSON
 *  (a Cloudflare error page is "offline", never a verdict), else an Error with the server's message (a refusal for good). */
export function postOps(url, { fetch: f = (u, init) => globalThis.fetch(u, { ...init, signal: init.signal }), timeoutMs = 10_000, onAnswer = () => {} } = {}) {
  return async (ops) => {
    let r;
    try { r = await f(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops }), signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw Object.assign(new Error('offline'), { offline: true, cause: e }); }
    if (r.status >= 500 || !(r.headers.get('content-type') || '').includes('json')) throw Object.assign(new Error('offline'), { offline: true });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `comments ${r.status}`);
    onAnswer(j);
    return j;
  };
}
/** The comments op log's transport: the app's server is the sink (guests write through it, PANGEA3 §7). push sends the
 *  entries in log order as one batch (a thread's first comment lands before its resolve) through `post(ops)` (default:
 *  postOps(url)), whose answer carries the server's threads, which `adopt` takes. Offline (a throw with .offline, a timeout,
 *  a network TypeError) rejects the push and the entries stay pending for the next sync; a refusal for good (any other
 *  throw: no right to comment, too long) is reported through `refuse` and the entries are acknowledged, never retried for
 *  ever. pull: the threads are read whole by the app, so there is no entry feed. */
export function commentSink({ url = null, post = url ? postOps(url) : null, adopt = () => {}, refuse = () => {} }) {
  if (typeof post !== 'function') throw new Error('commentSink: give url or post');
  return {
    async push(_stream, entries) {
      const ops = entries.map(fromStreamEntry).map(({ type, payload }) => ({ type, payload }));
      if (!ops.length) return;
      try { const answer = await post(ops); if (answer?.threads) adopt(answer.threads); }
      catch (e) { if (isOffline(e)) throw e; refuse(String(e?.message || e)); }
    },
    async pull(_stream, cursor) { return { entries: [], cursor: cursor ?? null, more: false }; },
  };
}
