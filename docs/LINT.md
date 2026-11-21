# quicklook-lint: structural checks every kit app gets

Created 2026-11-08 for the owner's request, 06:54 PST: *"build the checks in structurally where possible to avoid classes of bugs"*, re-scoped 06:57-06:58: *"a lot of this chat work should belong in the base pangea kit no?"* and *"Goal is both robust chat and also an easy to use kit"*.

## Using it

Zero config. From an app root:

```
node path/to/pangea-kit/lint/cli.mjs            # or: npx quicklook-lint (package bin)
```

It scans `src/` (or the root when there is no `src/`), counts each rule per file, and fails on any count above the app's allowance. An app with existing debt runs `--init` once: that writes `quicklook-lint.allow.json` with today's counts frozen. From then on a new violation fails, and fixing one leaves a stale allowance that also fails until `--ratchet` lowers it, so the debt can only shrink. `--json` prints machine output.

Ratchet file, `quicklook-lint.allow.json`:

```json
{ "version": 1,
  "rules": { "fetch-without-deadline": { "src/lib/api.js": 2 } },
  "off":   { "direct-storage-write": "owned by src/lib/ui-state-lint.test.js (same rule, older ratchet)" } }
```

`off` is a reasoned opt-out and is printed on every run. App-specific rules go in `quicklook-lint.rules.mjs` at the app root (`export const rules = [...]`, same shape as `lint/rules.js`; export `seeds` too and call `selfTest(rules, seeds)` from `lint/seeds.js` in a test so each one is shown red on a seeded violation).

Inside a vitest suite: `const res = await lintApp({ root }); expect(res.ok, format(res)).toBe(true)` (`lint/run.js`).

What else is checked in the kit's own suite (`tests/lint.test.js`): every rule red on its seed and green on its clean twin; the zero-config CLI on a fresh temp app; every registered component kind has a law generator, committed vectors and passes every law (`lint/kinds.js`); every declaration key listed as enforced is actually read by `lib/` (`lint/axes.js`).

## Rules

Each rule's failure prints one line of how to do it in the kit and a link to its anchor below.

<a id="direct-storage-write"></a>
### direct-storage-write
Hand-written `localStorage`/`sessionStorage` writes are a second persist path the kit cannot hydrate, migrate, sync or undo. Declare the state once and dispatch: `declare({ name, scope: 'local', fields, actions })`; the kit saves it (GUIDE.md section 1 and 3).

<a id="durable-write-outside-outbox"></a>
### durable-write-outside-outbox
A POST/PUT/PATCH/DELETE from UI code is lost when the tab dies mid-request. Dispatch on a `scope: 'cloud'` declaration; the engine appends to the durable outbox before any network attempt (persist before you attempt, PANGEA3 A7).

**The one sanctioned non-durable send** (2026-11-12, zai3 live transclusion): a POST whose loss costs nothing (the presence POST, a session-open boot POST; presence is explicitly never stored and never in the op log, PANGEA3-DESIGN section 11 row 53 and section 15 "Embeds") goes through `createEphemeralPost()` from `lib/engine/ephemeral.js`: JSON body, a deadline class on every call (default `telemetry`, `read` for a session open), no retry, no queue. `lib/engine/` is the rule's owner path, so the exemption lives in the kit once and an app takes no allowance for it. Anything that carries what he made is not ephemeral and still dispatches on a `scope: 'cloud'` declaration.

<a id="indexeddb-writer"></a>
### indexeddb-writer
One writer per storage resource. App code never calls `indexedDB.open`; the kit replica owns it (`lib/engine/idb.js`).

<a id="pref-read-on-mount"></a>
### pref-read-on-mount
A preference read in `onMount` is read after an earlier `$effect` saved the default over it (the reader's text size, 2026-09-28). Declare it on the kit; it hydrates where it is declared.

<a id="reducer-clock-or-random"></a>
### reducer-clock-or-random
`Date.now()`, `new Date()`, `Math.random()`, `performance.now()` or `crypto.randomUUID()` inside `actions: {...}` make replicas folding one log diverge. Mint the time or id once at the gesture and pass it in the payload.

<a id="unenforced-axis"></a>
### unenforced-axis
A `declare({...})` naming an axis nothing in the kit executes (`NOT_EXECUTED` in `lib/declare-keys.js`: `durability`, `protection`, `cardinality`, `contentFields`, `retention`, `actor`, `emits`) is documentation that drifts (PANGEA3 A10, "Declared means enforced"); `declare` also throws on it at run time, so this rule is the earlier, static signal. Remove it, or execute it in the engine and move it to `DECLARE_KEYS` in `lib/declare-keys.js` in the same commit; tests/lint.test.js then proves `lib/` reads it.

<a id="content-hash-id"></a>
### content-hash-id
An id or key assigned from a hash of content (`id = sha256(JSON.stringify(action))`, `key: hash(row.text)`) gives two identical actions one identity (the second is dropped as a duplicate) and a retry with edited content a new one (PANGEA3 A7, census class 3). Mint the id once where the intent is made (`ulid()` from `lib/engine/ulid.js`), persist it with the intent, reuse it on every retry; derive child ids from that id (`<id>.<n>`), never from content. Blob ids are the one content-addressed identity (`blobId`, `contentHash` names are not flagged).

<a id="handler-sync-io"></a>
### handler-sync-io
No synchronous fs or child-process call in a request handler (`+server.js`, `handlers/`): handlers enqueue; the store's writer or a read worker does the I/O.

<a id="handler-spawn"></a>
### handler-spawn
No `spawn`/`execFile`/`fork` in a request handler. Hand the job to a supervised worker queue (`lib/bounded.js`) with a deadline class (`lib/engine/deadline.js`).

<a id="handler-unbounded-select"></a>
### handler-unbounded-select
A `SELECT` in a handler carries a `LIMIT` (plus a cursor) or runs in the read-only worker.

<a id="fetch-without-deadline"></a>
### fetch-without-deadline
Every wait has a bound and the surface says so when it fires. Use `createDeadlineFetch(fetch).fetchWithin(klass, url, opts, { key })` from `lib/engine/deadline.js` (classes `send`, `push`, `pull`, `read`, `bulk`, `search`, `file`, `telemetry`; latest-wins by key). Model streams are exempt by the owner's rule; pass them a `signal` the caller owns.

<a id="interval-without-owner"></a>
### interval-without-owner
`every(owner, ms, fn, { budgetMs })` from `lib/timers.js`: one timer per owner, listed by `timers()` for health, a tick over budget backs off by doubling. A bare `setInterval` is how a 5 s heartbeat wrote 362 MB of telemetry in 14 hours (2026-11-08).

<a id="unbounded-queue"></a>
### unbounded-queue
`boundedQueue({ name, maxItems, maxBytes, policy })` from `lib/bounded.js`; construction refuses without both caps and a policy. `refuse` is backpressure (durable user writes: never drop his data), `drop-oldest` is for telemetry and previews.

<a id="server-homedir"></a>
### server-homedir
Server state resolves from one state-dir setting the test harness overrides, never `homedir()`, or a test run writes the owner's live data (the reader store, 2026-09-28).

<a id="meta-or-ctrl"></a>
### meta-or-ctrl
`(e.metaKey || e.ctrlKey)` as an accelerator eats the macOS emacs bindings (The owner 2026-08-29: *"never clobber those"*). Bind `'mod+b'` with `createKeys()` from `lib/keys.js`. A modifier-bail list (`meta || ctrl || shift || alt` then return) is not flagged.

<a id="focus-outside-intent"></a>
### focus-outside-intent
Focus has one owner: the kit intent record (`lib/intent.js`: pane, element, caret, pending) and its one DOM-apply effect (`lib/intent-dom.js`, `installIntent`). A component that calls `.focus()` / `.blur()` or keeps a `focused` / `autofocus` `$state` flag is a second owner (webchat 2026-11-13, the owner: *"all the state bugs we've had recently were multiple people controling focus/select"*; Shift-Enter opened a pane and the next keystroke still landed in the old side-chat box). Dispatch the transition that says what happened (`press`, `openPane`, `closePane`, `openThread`, `blurThread`, `typeToFocus`), mark the elements with `data-focus-pane` / `data-focus-at` / `data-focus-field`, and read focus back with `threadFocus`, `isOwner`, `paneActive`. An existing app freezes its count in the ratchet and can only go down.

<a id="narrow-media-hides-control"></a>
### narrow-media-hides-control
`display: none` inside a `max-width` media query removes a control on the phone (the model select at 860 px). Reflow it instead, and assert its geometry in a mobile spec.

<a id="root-overscroll-none"></a>
### root-overscroll-none
`overscroll-behavior: none` on a root stylesheet cancels two-finger back for the whole app; `overscroll-behavior-y: none` keeps the rubber-band fix.

<a id="editor-dom-read"></a>
### editor-dom-read
In an app on the kit editor (`lib/editor/editor.js`), only the kit adapter reads layout and the DOM selection. App code reading `scrollTop`, `textContent`, `innerText`, `getSelection()` or `caretRangeFromPoint` builds a second source of truth that styling can change (zai2, 2026-11-08: blank rows of 2 pt skipped by Backspace; a caret read back from the DOM after undo). Read `editor.state`, `editor.selectionRect()` or `editor.viewport()`. Writes such as `statusEl.textContent = ...` are not flagged. The app's editor definition `src/editor.js` and the kit's `lib/editor/` are exempt.

<a id="editor-app-state"></a>
### editor-app-state
Module-scope `let`/`var` and module-level `Map`/`Set` in an editor app are state the kit cannot see, replay or restore (zai2 had `pinned`, `lastEdit`, `els` and a caret cache in module variables). Put UI state in the reducer's `ext` (from `app.init()`) or in an action. The owner 2026-11-08 23:29 PST: *"all state needs to be owned by the kit , including scroll state"*. Ratchet the non-UI ones (an id sequence) in `quicklook-lint.allow.json`.

<a id="editor-without-contract"></a>
### editor-without-contract
`createEditor()` must carry a `contract` ({ name, actions, budget_p95_ms }); it also throws without one. The deploy gate (`lib/editor/gate.mjs`) refuses an editor app with no `quicklook-ui.config.mjs` naming its checks.
