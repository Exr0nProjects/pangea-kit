// Push-then-pull sync for a rows replica: a server-sent event stream says "something changed" and the client pulls
// (rows.sync()); the stream carries no data the replica trusts, so a missed or duplicated event costs nothing. The poll
// stays as the fallback: every fallbackMs while the stream is down, every liveMs while it is up (a stream that is open
// but silently dead still converges). Events arriving while a pull runs coalesce into one more pull.
//
// pushPull({ url, pull, fallbackMs, liveMs, visible, events, EventSourceImpl, setTimer, clearTimer, onStatus }) -> { stop, status }
//   events: { name: (json) => void } for named server-sent events (presence), which never trigger a pull
export function pushPull({ url, pull, fallbackMs = 5000, liveMs = 60000, visible = () => true, events = null,
  EventSourceImpl = globalThis.EventSource, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t), onStatus = () => {} }) {
  let es = null, live = false, running = false, again = false, timer = null, stopped = false;
  const st = { pushes: 0, pulls: 0, polls: 0 };
  async function run(why) {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    try { do { again = false; st.pulls += 1; await pull(why); } while (again && !stopped); }
    catch { /* the pull reports its own errors; the next push or poll retries */ }
    finally { running = false; }
  }
  function arm() {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => { timer = null; if (visible()) { st.polls += 1; run('poll'); } arm(); }, live ? liveMs : fallbackMs);
  }
  const set = (v) => { if (live !== v) { live = v; onStatus(v ? 'live' : 'polling'); arm(); } };
  if (EventSourceImpl && url) {
    es = new EventSourceImpl(url);
    es.onopen = () => { set(true); run('open'); }; // catch up on what was missed while the stream was down
    es.onmessage = () => { st.pushes += 1; run('push'); };
    es.onerror = () => set(false); // EventSource reconnects by itself; meanwhile the fast poll runs
    // named events (`event: presence`, PANGEA3 §11 row 53): handed to the app as parsed JSON, never a pull (only the default event pulls)
    for (const [name, fn] of Object.entries(events || {})) es.addEventListener(name, (e) => { let v = null; try { v = JSON.parse(e.data); } catch { return; } try { fn(v); } catch { /* the app's handler must not break the stream */ } });
  }
  arm();
  return {
    stop() { stopped = true; if (timer) clearTimer(timer); es?.close(); },
    get status() { return { live, ...st }; },
    kick: () => run('kick'),
  };
}
