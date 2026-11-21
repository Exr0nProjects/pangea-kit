# pangea-kit DERIVED-STATE

Kit-level async derived state: a value that is a function of state, whose computation can be in flight. Code: `lib/derived.js` (framework-free core), `lib/derived-dom.js` (indicator), `host/kit.svelte.js` (`createDerivedKit`, `kit.derive`), `ui/Pending.svelte`, `lib/logbound.js` (bounded persisted log). Tests: `tests/derived.test.js` (core, 21), `tests/derived-kit.test.js` (binding, 6). Read [../GUIDE.md](../GUIDE.md) first for the rest of the API.

## Model

The kit knows three things apart: state (persisted, undoable, the only source of truth), derived values (never persisted, recomputed after a reload), and the work in flight that produces them. A derivation is `name + inputs() + run(inputs, ctx)`.

- `inputs()` reads the state. It is tracked by a Svelte effect and snapshotted to plain data (`$state.snapshot`), so the key is stable and the function never sees a live proxy.
- `run` is async, always runs after the next paint (rAF, then a macrotask; a 250 ms timer covers a hidden tab), never inside the dispatch that caused it.
- Latest wins: only the newest inputs key is ever applied. An older run is aborted through its `AbortSignal` and its late answer is ignored even if the function ignores the signal.
- Stale while revalidate: with `keep: previous` (default) the old value stays readable with `status: stale` while the new one computes. `keep: none` clears it.
- Errors never throw into the caller: `status: error`, `error: { name, code, message }`, previous value still readable, `core.retry(name)` re-runs with the current inputs.
- A small per-derivation cache (`cache: 4` keys) serves a repeated inputs key at once (`status: ready, cached: true`), which is what makes undo instant.

Status values: `idle | pending | stale | ready | error`. `pending` and `stale` count as in flight.

## API

```js
kit.derive(scene, {                       // ctx.derive(...) in a part: cancelled and removed when the part swaps
  inputs: () => ({ preset: kit.state.preset }),      // reads state; plain data comes out
  run: async (inputs, { signal, progress, prev, key, attempt }) => build(inputs, signal),
  label: Scene, debounceMs: 0, keep: previous, timeoutMs: Infinity, retries: 0, retryBackoffMs: 300,
  cache: 4, key: (inputs) => string, fallback: async (inputs, ctx, err) => value,
})                                           // returns a disposer
kit.derived.scene   // reactive record { status, value, hasValue, error, progress, inputsKey, via, attempt, since, cached, pending }
kit.pending         // reactive { count, list: [{ name, label, status, since, progress, attempt }] }
kit.derivedCore     // set / get / retry / cancel / invalidate / running / subscribe / idle (harness: await __pangea.derived.idle())
```

Names match `[\w-]+` because they become CSS attribute values. The record and the indicator are updated synchronously inside the change (core `subscribe(fn, { sync: true })`), so a view reads "pending" in the same tick as the dispatch; ordinary subscribers are coalesced in a microtask. A dispatch never runs a derivation: the effect only calls `core.set`, which compares keys, aborts the old run, serves a cache hit or marks the status, and schedules.

## Indicator spec

- One global spinner, fixed bottom right (`right:12px; bottom:30px`, above the status chip), 18 px ring, compositor-only `transform` rotation, so it keeps turning while a synchronous compute blocks the main thread. It fades in after 0.15 s so sub-frame work never flashes it. Click it for the list (label, seconds, progress fraction and text, retry count).
- `<html data-qk-pending="scene doppler">` lists the names in flight; absent when none.
- Any element with `data-derived="scene"` (or `<Pending of="scene">` from `ui/`) dims to opacity 0.85 while that derivation is in flight. Input is never blocked; controls respond at once.
- Installed on the first `derive()`; an app that declares nothing gets no extra DOM.

## Persistence and undo

Derived values are not in the state tree, so they are never persisted and never in a snapshot (`tests/derived-kit.test.js`, "never persisted"). Undo restores inputs in the state, the effect sees the restored inputs, and the derivation serves from its cache (`cached: true`, ready in the same tick) or recomputes after paint. Redo is the same. Nothing in history refers to a derivation.

## Network and model calls

A derivation is the same shape for local compute, a scene load, a fetch or a model call. `signal` aborts the request on supersede, dispose, timeout; `timeoutMs` produces `AsyncTimeoutError` (`code: AsyncTimeout`); `retries` with exponential `retryBackoffMs` covers transient failures; `fallback` supplies a second source and sets `via: fallback` with `fallbackReason`; `debounceMs` coalesces typing; `progress(fraction, text)` feeds the list. Failure and latency are tested with a simulated 20 ms call ("network-shaped derivation").

## Profile: the log trim cost

Profiled on 2026-11-18 on an app whose actions carry whole arrays (`patch { vessels: [...] }`, 24 KB payload plus the same again in `prev`). Every save cost 0.75 to 1.9 s of main thread: persist stringified the whole 2.7 MB op log, and the 200 KB server-copy trim in `host/boot.js` re-stringified the whole record once per dropped entry (about 120 entries). Fix, `lib/logbound.js`: `boundLog` keeps the newest suffix of the log that fits 150 KB, with each entry measured once (WeakMap), and `trimRecord` parses once and sums entry sizes once. A save is now O(state + kept log), not O(log history). The kit-level consequence for the design: the spinner could not have helped here (the cost was synchronous inside the save), which is why the log is bounded rather than hidden.

## Alternatives not taken

- Per-app `$derived` plus ad hoc `loading` flags: no latest-wins, no cancellation, a different spinner per app; the owner asked for the kit to track every derivation.
- `$derived(await ...)` or Svelte async: ties cancellation and the indicator to component lifecycles, and parts hot-swap.
- Persisting derived values: large (the scene), stale across kit versions, and hides recompute bugs. Recompute after reload instead.
- A Web Worker per derivation: useful for heavy compute, orthogonal; a `run` may already post to a worker and honour `signal`. Not built in.
- Blocking overlay while pending: rejected, controls must respond immediately; the dim is 0.85.

## What would reverse it

- If apps need derivations whose inputs are not state (timers, external pushes), `inputs()` becomes the wrong entry point; add `core.set` calls from those sources.
- If the 4-key cache holds large values and memory matters, lower `cache` per derivation or key on a hash.
- If the sync subscribers become a measured cost on progress-heavy runs, coalesce progress notifications.
- If a save is still slow with the bounded log, the next cost is `stripTransient(state)` itself; profile before changing the bound.
