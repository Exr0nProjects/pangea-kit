# pangea-ui-kit GUIDE (directory `tools/pangea-kit`, name kept so every path and published URL still works)

**Design test (The owner, 2026-11-07 16:53 PST: "it should be easier not harder to use than native js").** Building a feature with this kit must take fewer lines and fewer concepts than hand-written `localStorage` + `$state` + `$effect`. One declaration per piece of state (name, initial value, pure actions, `scope`, schema version); the kit gives hydrate, save, versioned migration, replay, sync and a log. If a feature needs a storage key, an adapter, an `$effect` that writes, or a second copy of a value, the kit API is wrong: fix the kit, not the app. `webchat/src/lib/ui-state-lint.test.js` enforces it in webchat (new direct storage writes and `$effect` persistence fail the test).

## 0. Layers

| layer | files | knows about |
| --- | --- | --- |
| **state core** (framework-free) | `lib/model.js` (declare, replica, app), `lib/fields.js`, `lib/stream-fake.js`, `lib/persist.js`, `lib/keys.js`, `lib/util.js` | nothing but JSON and a Storage-like object |
| **viewer modules** (optional) | `host/viewer.js`, `host/axes.js`, `lib/scale.js`, `lib/data.js`, `ui/` | three.js, DOM |
| **targets** | `host/boot.js` + `bin/pangea-kit.mjs` (quicklook: hot-swap parts, published at `/view/<ULID>/`); a plain Vite/SvelteKit app imports `lib/model.js` directly (webchat does) | where the pages run |

A greeting-card app imports `lib/model.js` and nothing else. The old viewer store (`lib/store.js`: in-place `set path value`, 300-entry log, `window.name` + `view.json`) stays as the quicklook target's store, unchanged, so microns/h01 and published URLs keep working; new work uses the state core.

## 1. State core: the contract

```js
import { createApp, declare } from '.../pangea-kit/lib/model.js'
import { assign } from '.../pangea-kit/lib/fields.js'
const app = createApp()                                   // device id, localStorage, optional Stream transport
export const card = app.use(declare({
  name: 'card', scope: 'local',                           // scope: 'cloud' (default) | 'local' | 'ephemeral'
  initial: { to: '', msg: 'Happy birthday', color: 'pink' },
  actions: { 'to.set': (s, { to }) => assign(s, { to }),  // pure: (state, payload) => state; same reference = no-op
             'msg.set': (s, { msg }) => assign(s, { msg }), 'color.set': (s, { color }) => assign(s, { color }) },
}))
// component: const c = $derived($card)   card.dispatch('msg.set', { msg })
```
That is the whole greeting card: the state survives reload with no first-paint flash (hydrate is synchronous at `app.use`), saves are coalesced and flushed on `pagehide`, and `scope: 'cloud'` instead of `'local'` makes the same card sync between devices.

**Declaration** (`declare`): `name` (storage key `qk:<name>` and the Stream id: never rename), `version` + `migrations: {2: (state) => state}` (upcasters; the raw record is archived first, an unloadable record is never overwritten), `initial`, `actions`, optional `normalize(state)` (repairs whatever storage returned; return the same object when clean; with `fields` it is derived, section 3), optional `legacy(storage)` or a `legacy: [{key, json, into}]` list (one-time import of the old hand-rolled keys when no record exists; the old keys are left in place).

**The key set is closed** (`lib/declare-keys.js`, one table with the executor of each key; PANGEA3-DESIGN A10). `declare` throws on an unknown key and on an axis the design names that nothing in the kit executes (`durability`, `protection`, `cardinality`, `contentFields`, `retention`, `actor`, `emits`; `conflict: 'crdt'`; `undo: 'stack'`), naming the reason, so a declaration never carries a promise the kit does not keep. Every `declare` is recorded for `validate()` (section 3e), which the deploy gate runs over every app.

**Actions** are absolute end states ("folder `k` is open"), never toggles; they must be pure; returning the same reference means "nothing changed" and then nothing is logged, saved, pushed or notified (that is what makes retries and replays idempotent). Merge type is per field and lives in the reducer: LWW needs nothing (the total order decides), `lib/fields.js` has `assign`, `setMember` (set as a map of members), `bump` (per-device counter). A text/list/map CRDT rides as the action payload (update bytes); the reducer merges it with the CRDT library; the kit only orders and relays.

**Reading**: `replica.get()` and the Svelte store contract (`subscribe` calls back immediately), so `$card` works in a component with no rune plumbing. **Writing**: `replica.dispatch(type, payload)` only.

## 2. Persistence and sync contract

Persist by default; opt out with `scope`. `ephemeral`: never written. `local`: state snapshot only, per device, never pushed. `cloud` (default): the **action** is the unit.

1. `dispatch` runs the reducer now; the view updates at once (optimistic).
2. The action `{device, seq, ts, type, payload}` is appended to the local op log (`pending`), saved to storage (coalesced into one write per tick; `sync()` flushes first, so the log is on disk before it leaves the device).
3. `sync()` pushes pending as Stream entries (mapping below), then pulls the other devices' entries from the saved cursor and replays them through the same reducer.
4. **Confirmed plus pending** (Pangea mixed-field sync): `confirmed = fold(base, tail)` where `tail` holds acked and remote entries in the total order `(ts, device, seq)`; `view = fold(confirmed, pending)`. A late remote entry is inserted by order, confirmed is refolded and pending re-applied on top, so every device converges to `fold(all entries sorted)`. `tests/model.test.js` checks this with 150 seeded random interleavings of three devices (offline gaps, skewed clocks, paged pulls). Pushing the action rather than the state is what makes this deterministic.
5. Bounds: the tail is capped at 200 entries (older ones fold into `base`; an entry arriving older than that horizon is applied in arrival order, a known limit); a schema version bump bakes unpushed entries into `base` (sync before upgrading).

**Stream mapping, one to one** with `pangea-l1-deploy` (`PUT /v1/streams/{stream}/entries/{entry-id}`): stream = state `name`; `entry_id = "<device>:<seq>"`; `device_id`, `device_seq` (contiguous from 1 per device and stream, exact retry idempotent, a changed reuse is a conflict); `event_time = ISO(ts)`; `payload = {type, payload}` (an E2E client wraps it in the `$encrypted` envelope; the Worker orders and relays, never reduces). `lib/stream-fake.js` implements those rules in memory and is what the tests run against; the real transport is any object with `push(stream, entries)` and `pull(stream, cursor) -> {entries, cursor, more}`.

**What the cloud gives today** (read from `pangea-l1-deploy` source, `contract/streams-v1.md`, 2026-11-07): append and opaque-cursor reads (200 entries a page, 1 MiB per payload, 8 MiB per batch), contiguous per-(stream, device) sequence, no delete, token-derived namespace. No push channel: the spec says polling the cursor is the v1 delta mechanism and a WebSocket vocabulary (`subscribe`/`delta`) is specified but not built (a Durable Object would be needed). So cloud-synced state is realistic for preferences, folders, drafts and notes at poll latency (measured from this Mac against the deployed `the cloud Worker` Worker: `/healthz` 75 ms, authenticated reads 80-430 ms), not for cursor-by-cursor multiplayer; interactive multiplayer needs the push channel first.

## 3. Declaring fields (lib/schema.js)

State is a handful of typed fields, not an `initial` object plus a hand-written `normalize`. A field is its default and the function that repairs whatever storage or a payload hands it; `declare` derives `initial`, `normalize` (a clean state comes back as the same object), and the persist projection.

```js
export const prefsDecl = declare({
  name: 'prefs', scope: 'local',
  fields: { voice: shape({ speed: num(1.1), handsFree: bool(true) }) },     // default + repair, one line
  legacy: [{ key: 'host-app.voice', json: true, into: 'voice' }],              // one-time import of an old hand-rolled key
  actions: { 'voice.set': merge('voice') },                                 // state.voice = {...state.voice, ...payload}, repaired
})
```
Types: `field(default, clean?, { ephemeral | save(v, state) })`, `bool`, `num(default, { int })` (positive; a numeric string counts), `list(itemClean)` (unique, no empties), `flags()` (set stored as an object), `shape({...fields})`, `scratch(default)` (memory only: the saved copy has the default). Action shorthands, each a pure reducer where "nothing changed" returns the same reference: `set('width', 'px')`, `merge('voice')`, `on('layout', (layout, payload, state) => layout2)`, `reset('layout', 'transient')` (no names: all). A plain `(state, payload) => state` function is still allowed for an action that spans fields (a folder rename moves the name, the layout, the open key and the current folder together). `legacy` is a list of `{ key, json?, into? | read? }` (each present old key contributes its part; a bad value is ignored; the old keys are left in place) or the old `(storage) => partial` function. `storage: 'tab'` puts a state in this window's sessionStorage instead of the device's localStorage (the pane layout: a second window must not share it). In a component: `const sb = uiApp().use(sidebarDecl)`, read `$sb.width`, write `sb.dispatch('width.set', { px })`; `sb.dispatch` needs no `this`, so `const pane = paneStore.dispatch` works, and it returns the logged action when something changed and `null` when it was a no-op (no "did the layout change" helper needed).

## 3b. State components (lib/components.js), lifecycle, laws and conformance vectors

Editors (viewer3/viewer5, ULM track/density/flow editors) and chat apps share these. A component is data: `{ kind, initial, actions, gestures, conflict, states?, transitions?, terminal?, stateField? }`. `actions` are the log vocabulary (absolute, pure, total, same reference on a no-op); `gestures` turn a relative intent into an absolute action against the state the user saw (`resolve(comp, state, name, payload)`, `gesture(replica, comp, name, payload)`), so "next", "move down" and "undo" never enter the log and a rebase or a redelivery cannot apply them twice.

```js
import { connection, undoHistory, modes, keymap, declareComponent, gesture, inPlace } from '.../lib/components.js'
const conn = connection(); const c = app.use(declare(declareComponent('conn', conn, { scope: 'ephemeral' })))
gesture(c, conn, 'connect', { url })              // logs ['connect', { url, attempt: n + 1 }]
store.component('list', inPlace(listSelect()))     // the same component on a quicklook store path (store undo works)
const km = keymap([{ when: (x) => x.get('mode').mode === 'insert', capture: true, keys: { Escape: ['mode', 'set', { mode: 'normal' }] } },
                   { keys: { j: (x) => ['list', 'move', { delta: 1, row_count: x.rows }], 'mod+z': ['undo', 'undo'] } }])
km.routeEvent(e, { get: (t) => replicas[t].get(), rows }, comps)  // -> { target, op, payload } | 'captured' | null
```

Components: `toggle(options)` (set; gesture next), `modes(names, {transitions})` (editor modes as a lifecycle), `listSelect()` (select, deselect, restore; gesture move), `search()` (+ `searchRows`), `connection()` (lifecycle disconnected/connecting/connected/error; connect carries the absolute attempt), `scrollAnchor()`, `documentCursor()`, `undoHistory()` (record, batch {open}, seek; gestures undo/redo; `undone`/`redone` say what to revert or re-apply), the store-only `selection()`, and `modal()`, `splitPane()`, `sort()`, `pagination()` with the virtual window (3c).

**Declaration axes.** `declare` takes `conflict: 'lww' | 'log'` (default lww; scope plus conflict is Pangea's scope x conflict_model, with the kit's three scopes standing for Pangea's local/replicated and durability). Both fold the one total order (E2E clients fold one order and the server never reduces, so Pangea's "server wins" and LWW topologies are the same fold here); `conflict` picks the law the gate checks: lww, re-applying an action is a no-op (idempotent); log, a redelivered intent is a no-op (dedupe) and the noLoss law runs. `crdt` is refused: the kit has no CRDT merge, so a CRDT rides as an action payload under lww and the reducer merges it. `undo: 'compensating'` (or `{ model: 'compensating', limit }`) gives the replica `undo()`, `redo()`, `seek(position)` and `history` (`lib/undo.js`): each dispatch records its changed top-level fields by value, an undo or redo is a compare-and-set against the current value through `lib/history.js` (a field someone else changed since wins and the step is dropped), applied as a new logged action `$undo`; bind the undo button to `seek(history.position - 1)` as seen, so a double press steps once. History is per tab and in memory; undo with a lifecycle is refused. The declaration also takes an optional lifecycle `states`, `transitions`, `terminal`, `stateField`. `step(decl, state, type, payload) -> { state, error }` is the one place an action meets a state: dispatch throws on `InvalidTransition`/`TerminalState` (`err.code`), and a replayed fold skips the entry, the same way on every replica.

**Laws** (`lib/laws.js`, Pangea's generate_tests): `checkLaws(comp, gen)` runs seeded random sequences and checks total, pure, noop-ref, idempotent (lww) or dedupe (log), json, lifecycle and gestures; tests show each law catches a plausible broken component. `checkDeclLaws(decl, gen)` runs the same laws over a declaration's own step and counts, per action, the steps that changed the state.

**validate() and the gate** (`lib/validate.js`, Pangea's validate + generate_tests; `lib/validate-app.mjs`). `validate()` takes every `declare()` and `defineView()` made so far and runs `checkDeclLaws` and `checkUiLaws` on each declaration (a generic generator unless `gens[name]` is given; an action no generated step exercised is a coverage failure), then the view checks: every `from` name resolves, the views form a DAG (Tarjan), and each view is pure (`defineView` refuses a source naming the clock, randomness, storage, network or DOM; validate calls it twice on deep-frozen initial states). The deploy gate (`lib/editor/gate.mjs`, step 1b) loads every app module that declares state through the app's vite config and refuses on any failure, on a declaring module that does not load, and on state declared in a `.svelte` file. Generators: `quicklook-ui.config.mjs` `validate: { gens: 'test/gens.js' }` (default export `{ [name]: (rng, state) => [action, payload] }`). The generic generator reaches a `set(field, key)` action through its declared payload key (`payloadKey` on the reducer); any other payload shape it cannot spell needs a generator. A reducer that throws under any UI law (reloadRestores, firstPaint, noLoss, reducerBudget) is reported as `total` with its seed and steps, never as an exception that skips the declaration's other laws. State built with `createEditor` or `openRows` has no declaration and is not covered.

**Conformance vectors** live with the kit, in `conformance/components/<kind>.json` (canonical JSON, `lib/canonical.js`: sorted keys, no whitespace, JSON.stringify numbers and strings). `node conformance/generate.mjs` rebuilds them; `tests/conformance.test.js` fails if a fresh build differs, replays every step byte for byte, and runs a differential of three execution paths (pure fold, replica dispatch, in-place store) over seeded sequences. Any other implementation (the Python reference, a Worker) conforms by replaying the vectors and writing states in the canonical form. `node conformance/diff-python.mjs [n]` compares the kit with the Python reference (`<private-path>`, needs uv).

**What differs from the Python reference, on purpose** (the Python is what these were learned from; the kit is canonical):
- Relative ops become gestures: Python's `toggle` (Toggle), `move` (ListSelect), and `connect`'s `attempt_count + 1` are gestures here; the logged action is absolute (`set {value}`, `select {index}`, `connect {url, attempt}`), so a duplicate or rebased entry cannot flip or double count.
- Reducers are total: an invalid payload is a no-op instead of Python's assert, because a log written by another build replays on every replica and must never throw mid-fold.
- Lifecycle is enforced in `step`, not only in a bus, so replica, fold and store agree.
- Undo is entries plus a position instead of two stacks, with `seek {position}` absolute (two devices that undo once land one step back, not two), records deduplicated by id, and four Python behaviours fixed because each loses history: begin_batch inside a batch dropped the batch; undo/redo inside a batch dropped it (now it is committed, then undone whole); end_batch with nothing to commit cleared the redo stack; a batch whose first push had `cursor_before: null` took the second push's cursor. A batched entry's actions are flat, the same shape as a single edit.
- Search strips exactly Python's `str.isspace` set; the notesapp JS port in <private-path> uses `\s`, which strips U+FEFF and keeps U+0085 (a divergence from its own Python reference).

## 3c. Modal, SplitPane, Sort, Pagination and the virtual window (designed from webchat)

These four were designed from what webchat and the memory graph page actually do (file:line below, webchat paths under `webchat/src`), not from the Python stubs; the Python namesakes are projections of them, compared in `conformance/diff-python.mjs`. Same contract as 3b: absolute actions, gestures resolved against what he saw, total reducers (any payload, including `null` or a number, is a no-op rather than a throw; every component in the file now gets an object payload whatever arrives), same reference when nothing changes, vectors in `conformance/components/`, laws in `lib/laws.js`. Performance is part of each API: what is logged is small and absolute, what changes every frame (a drag in flight, row heights, a sort index) is a pure derived structure and never enters the log.

**`modal()`: the overlay stack.** State `{ stack: [{ id, kind, payload, capture, esc, backdrop, return_to }] }`, top last. Today every overlay keeps its own flag and its own Escape listener, and the page hand-orders them: `routes/+page.svelte:507-511` (quicklook, then search, then the sidebar), `routes/reader/+page.svelte:1492-1500` (six flags in a fixed chain), `lib/ui/ScopeBar.svelte:54` (confirm before rules), `lib/ui/DeferSheet.svelte:47,51` (two Escape listeners, kept apart by stopPropagation), and modality is found by DOM query (`+page.svelte:338`, `lib/services/voice/core/pushtotalk.js:13`). Focus return is per component (`lib/ui/Lightbox.svelte:42-58` remembers the trigger), outside-click closing is per component (`lib/ui/PaneMenu.svelte:40-49`), and a required prompt has no Escape (`lib/ui/DocNamePrompt.svelte:123`, cancel only with allowCancel).
- `open {id, ...}` puts id on top (an open id moves up with its new fields); `close {id}` removes id and everything opened over it; `close_all`. Gestures `escape` and `backdrop {id}` resolve to `close {id}` of the top the user saw, so a doubled Escape or a redelivered entry closes one layer, and a click on a backdrop that is no longer on top does nothing.
- `esc` and `backdrop` are `'close' | 'ignore'` per entry; `capture` says the top owns the keyboard. `modalLayer('modal', keys)` is the keymap layer: active while the top captures, Escape bound to the gesture, every other key swallowed. `keymap` now returns `'captured'` when a capturing layer's binding resolves to nothing, so Escape on a prompt that ignores it can no longer fall through and close the sidebar.
- `return_to` is an app string (an element id, a row id); `focusReturn(before, after)` gives the `return_to` of the lowest entry a transition closed. No DOM in the component.

```js
// +page.svelte today: if (quicklook) ...; else if (searching) ...; else sidebarOpen = false   (507-511)
const overlays = app.use(declare(declareComponent('overlays', modal(), { scope: 'ephemeral' })))
gesture(overlays, m, 'open', { id: 'search', return_to: 'composer' })       // Cmd-K
const km = keymap([modalLayer('overlays', { ArrowDown: ['palette', 'move', ...] }), pageLayer])
const before = overlays.get(); const hit = km.routeEvent(e, ctx, comps)    // Escape -> close {id: 'search'}
focusElement(focusReturn(before, overlays.get()))
```

**`splitPane(options)`: panes, rails, constraints, one-gesture drags, per-device layout.** Two real shapes: the chat panes, fractions of the stage that sum to 1 with a minimum, a collapse threshold below it and 34 px rails (`lib/core/panels.js:3-12, 240-255, 104-110`), and the chat list, a pixel width between 200 and 560 that hides below 140 and reopens when dragged back out, default 280, double-click reset (`routes/+page.svelte:69-81, 150-186`). Both persist per device (`lib/core/panes-state.js:19-20` tab storage, `lib/core/sidebar-state.js:23,30,56`).
- Options (JSON): `unit: 'fraction' | 'px'`, `fluid` (px: the pane that takes the rest), constraints `min, max, collapse_below, collapsible, snap, snap_within, default` globally or per pane in `per`, `rail_px`, `max_panes`. Between `collapse_below` and `min` a drag clamps at `min`; below `collapse_below` the pane becomes a rail (`panels.js:248-250`).
- Actions are absolute: `size {pane, size, against}` (fraction: moves width between two panes, conserving their sum; px: the pane's pixels), `collapse`, `expand {pane, size?}` (focuses it, as `panels.js:187,204` do), `focus` (opens a rail, as `panels.js:97` activate does), `add {pane, after}` (halves the donor, or an even split when half would be under min: `panels.js:39-58`), `remove`, `move {pane, to}`, `reset {pane?}`. Gestures `resize {divider, delta_px, container_px}`, `toggle`, `focus_neighbour {delta}` (skips rails, `panels.js:160-167`), `shift {pane, delta}`.
- **A drag is one gesture.** `delta_px` is the whole displacement since pointerdown, resolved against the layout he grabbed; render each frame with `preview(comp, grabbed, 'resize', {...})` and dispatch the gesture once on release. Today the pane divider dispatches a relative `pane.resize {delta}` per animation frame (`+page.svelte:600-615`, `panes-state.js:37`): N entries per drag, each saved, and a relative entry that a replay applies again lands somewhere else. The chat-list drag already commits once on release (`+page.svelte:172-177`); this makes that the only way.
- `splitLayout(comp, state, container_px)` gives on-screen pixels (`panels.js` panelPx). Declare it `scope: 'local'` (or `storage: 'tab'`) for the per-device layout.
- Checked by a differential against `lib/core/panels.js` itself: 400 seeded sequences of resize, collapse, expand, rail click, close, duplicate and move agree on every one of 12,000 steps, float for float (`tests/layout-components.test.js`).

```js
// The chat list (+page.svelte:72 constants)
const sidebar = splitPane({ panes: ['list', 'stage'], unit: 'px', fluid: 'stage', rail_px: 0,
  per: { list: { min: 200, max: 560, collapse_below: 140, default: 280 } } })
const layout = app.use(declare(declareComponent('layout', sidebar, { scope: 'local' })))
let grabbed, x0
onpointerdown = (e) => { grabbed = layout.get(); x0 = e.clientX }
onpointermove = (e) => { draft = preview(sidebar, grabbed, 'resize', { divider: 0, delta_px: e.clientX - x0, container_px }) }
onpointerup = (e) => { draft = null; gesture(layout, sidebar, 'resize', { divider: 0, delta_px: e.clientX - x0, container_px }) }
ondblclick = () => layout.dispatch('reset', { pane: 'list' })
```

**`sort(options)`: the ordering as state, a total comparator, an incremental view.** The sidebar sorts pinned, then activity, then id (`lib/core/recency.js:11-16`); until 2026-11-04 its comparator parsed dates per comparison, ~25,000 `Date.parse` calls per update and ~50 ms a keystroke (`recency.js:7-10`), and it still re-sorts all 1,300 chats on every update (`lib/ui/Sidebar.svelte:258-264`). The reader shelf (`lib/core/reader-replica.js:59`) and the notes rail (`lib/core/notes-stream.js:138`) sort without a final tie-break, so two rows with the same time can swap between renders; the memory graph sorts a node's notes by time with no tie-break either (`host-app/src/app.js:293`).
- Options: `keys: { name: { type: 'string'|'number'|'time'|'bool', from: field | [fields], dir? } }`, `by` (initial order), `lead` (always first, not his to change: pinned), `id` (the final ascending tie-break, so the order is total). State `{ by: [[key, dir], ...] }`; `set {by}`, `reset`; gesture `column {key}` (Python's set: clicking the current key flips it).
- `sorter(comp, state)` extracts each row's key once; missing values go last in either direction; strings compare by UTF-16 code unit (localeCompare differs between machines). `sortedView(comp, state, rows)` keeps the order incrementally: `upsert(row)` and `remove(id)` are two binary searches and a splice, `slice(start, end)` is O(window). Measured on the M4 Pro: building 10,000 rows 12 ms, one upsert 5 µs, a full re-sort 4.1 ms; a test pins it under 2·log2(n)+2 comparisons per upsert, and a differential checks `recency.js` order exactly on 50 random 200-chat sidebars.

```js
const chatOrder = sort({ keys: { pinned: { type: 'bool' }, active: { type: 'time', from: ['activeAt', 'updatedAt'] } },
  by: [['active', 'desc']], lead: [['pinned', 'desc']] })
const view = sortedView(chatOrder, chatOrder.initial, Object.values(conversations))  // once
onConversationChanged = (c) => view.upsert(c)                                       // per event, O(log n)
```

**`pagination({ page_size })`, `heightIndex`, `windowFor`: pages and the virtual window.** Real lists: the transcript loads 1,500 events a page by cursor (`lib/client/session.js:981, 1086-1126`), renders every loaded row with `content-visibility` and learned per-bucket height estimates (`lib/ui/Transcript.svelte:325-375, 720-726`), and keeps the view still with a top-row anchor (cursor + offset, `Transcript.svelte:383-410, 620-642`); the reader shelf truncates at 200 (`reader-replica.js:43`); the palette at 200 cached hits (`lib/core/search.js:124`); the memory graph shows a node's newest 14 notes and 60 hulls with no way to see more (`host-app/src/app.js:84-89, 293`).
- `pagination` state `{ page, page_size, total }` (Python's fields); `goto {page}` (clamped to the last page once total is known), `set_total {total}` (null while the end is unknown, as with a cursor), `set_page_size` (the first row on screen stays on screen); gestures `next`, `prev`. `pageRange(state, { extent: true })` is "show more" (rows 0 to page·size), without it one page.
- The virtual window is device measurement, not log: `heightIndex({ estimate, bucket })` holds row heights in a Fenwick tree (offset of row i and row at pixel y in O(log n), a measurement O(log n), `sync(rows)` O(n) only when the list changes and free for the same array), with Transcript's learning of a bucket mean; `windowFor(index, { scroll_top, viewport_px, overscan_px })` gives `[start, end)` and the spacer heights in O(log n). What is logged is the existing `scrollAnchor` (`anchorAt(index, scroll_top, idAt)` gives its `user_scrolled` payload when a scroll settles); `scrollTopFor(index, anchor)` puts the anchored row back after an older page is prepended or rows above change height. A test renders 10,000 rows in windows under 80 rows with no estimate calls after sync.

```js
const ix = heightIndex({ estimate, bucket: (row) => `${row.type}:${Math.round(Math.log2(row.text.length + 1))}` })
ix.sync(rows)                                                  // when the row array changes
const { start, end, before_px, after_px } = windowFor(ix, { scroll_top, viewport_px, overscan_px: 2000 })
// render rows.slice(start, end) between two spacers; ResizeObserver -> ix.measure(id, height)
onScrollSettled = () => anchor.dispatch('user_scrolled', anchorAt(ix, scroller.scrollTop, (i) => rows[i].id))
afterPrepend = () => { ix.sync(rows); scroller.scrollTop = scrollTopFor(ix, anchor.get()) }
```

**Where these differ from the Python namesakes, on purpose** (diff-python.mjs, 300 seeded cases each; every divergence is attributed at its first diverging step and none is unexplained):
- ModalComponent: none in the comparable part (one id, show/dismiss/confirm); the kit adds the stack, policies, capture per entry and focus return.
- SortComponent: none (set is the `column` gesture, reset is reset); the kit adds multi-key `by`, `lead`, the id tie-break and typed keys.
- SplitPaneComponent: `toggle_pane` is a gesture; collapsing the last open pane is refused (Python can collapse every pane, leaving nothing to read: `panels.js` violations); expand focuses its pane and focus opens a rail (webchat's panels.js rules). The kit adds sizes, constraints, rails, add/remove/move.
- PaginationComponent: `next`/`prev` are gestures; goto past the last page clamps (Python stores a page that does not exist); a new page size keeps the first row on screen (Python keeps the page number, which shows different rows).
- Not from Python, not from panels.js: removing a pane that is not focused keeps focus where it was (panels.js closePanel always moves focus left; prune keeps it, `panels.js:86` vs `:266`).

Adoption order for webchat (none done here): the divider drag first (one entry per drag instead of one per frame, and an absolute size that replays to the same place), then the overlay stack (one Escape owner instead of five hand-ordered chains), then `sortedView` in the sidebar (one changed chat costs a binary search instead of re-sorting 1,300), then `heightIndex`/`windowFor` in the transcript (O(window) rows mounted instead of every loaded row).

## 4. Worked example 2: webchat's slices, and the line count

`webchat/src/lib/core/sidebar-state.js` (folders open, folders made here, layout, the folder he is in, Inbox folded, list width: six fields, nine actions), `panes-state.js` (the chat page's layout and the uncommitted blank chat: twelve one-line actions over the pure `core/panels.js` helpers, `storage: 'tab'`, the saved copy drops an incognito pane and the blank chat) and `prefs-state.js` (voice speed and hands-free). `client/ui-app.js` is the one `createApp` (lazy, with the pagehide flush). Components have no storage call and no persisting `$effect`. The differential gates: `src/lib/ui/Sidebar.diff.test.js` (pinned oracle `__oracle__/Sidebar.v1.svelte`), `src/lib/ui/Page.diff.test.js` (`__oracle__/page/Page.v1.svelte`, 23 controls), `src/lib/ui/ChatPane.diff.test.js` (`__oracle__/ChatPane.v1.svelte`).

**Honest count (2026-11-08).** Method: non-blank, non-comment lines; old = lines removed and new = lines added by `git diff <commit before migration>` over the production files each slice touched (sidebar: `Sidebar.svelte`, `routes/+page.svelte` width code, `workspaces.js` readLocal/writeLocal; panes: `routes/+page.svelte`, `panel-store.js`; prefs: `ChatPane.svelte`), plus the whole new slice file. Component call sites are one line before and after (`layout = closePanel(layout, i)` vs `pane('pane.close', { index: i })`), so they cancel; the difference is plumbing against the declaration.

| slice | native, before | kit as first written (HEAD 3af9b278) | kit after the reflow |
| --- | --- | --- | --- |
| sidebar | 78 | 61 slice file + 41 glue = 102 | 47 file + 41 glue = 88 (8 are the legacy import, deletable) |
| panes | 67 | 36 + 34 = 70 | 30 + 32 = 62 (1 legacy) |
| prefs | 21 | 26 + 5 = 31 | 10 + 6 = 16 (1 legacy) |
| shared app file | 0 | 20 | 11 |
| total | 166 | 223 | 177 (166 without the app file) |

Slice files shrank 143 -> 98 lines (-31%), the three slices with glue and app file 223 -> 177 (-21%) from the field types, `legacy` entries, `on`/`set`/`merge`/`reset`, `storage: 'tab'` (the second `tabApp`, 9 lines, is gone) and deleting what they replaced (a duplicate `cleanLayout`, `WIDTH_MIN`, the `readLocal`/`writeLocal` pair in `workspaces.js` that nothing called any more, two `$derived($store)` lines, `panesChanged`). Against native: prefs and panes are now shorter (-5 each), the sidebar is longer (+10, of which 8 are the temporary legacy import and the rest is the nine reducers that were inline assignments); the three together are level (166 native, 166 kit, plus 11 for the shared app file). **So the kit does not beat native on lines for slices whose logic already lived in pure helpers, and it will not: every named action costs one line in the slice that a native assignment did not.** What it buys instead: a new persisted field costs one line (`flags()`, `num()`) and one per action, where native cost a storage key, a parse with repair, a write effect and a first-render default (6 to 9 lines each, and the source of every flash and key-mismatch bug this month); hydrate is synchronous before first render; a corrupt record is repaired and an unreadable one is archived, never overwritten; the same declaration flips to `scope: 'cloud'` for sync; and the differential fuzz against pinned oracles proves behaviour unchanged.

Differential acceptance (the gate for each webchat phase): `src/lib/ui/Sidebar.diff.test.js` drives the pinned oracle (`__oracle__/Sidebar.v1.svelte`, the hand-written build, with one explained patch: lowercase open-folder keys) and the new build with the same seeded interaction sequences (toggle, Inbox fold, enter/leave, create, rename, remove, menu move, drag move, reload mid-sequence, search, file a chat, new via menu, strip drop), compares the observable folder tree after every step, shrinks a mismatch (ddmin) and prints the seed (`SIDEBAR_FUZZ_SEED=n`). It also asserts every interaction kind and control was exercised.

## 4b. Worked example 3: the docs (phase 5), and the first `scope: 'cloud'` customer

`webchat/src/lib/core/docs-state.js` declares four states. `docsDecl` (local, `crossTab: true`): the commenter name, the per-document meta cache and the /docs list cache; DocPage, DocNamePrompt and the list page read the same replica, so there is no second copy of the name to go stale. `docThreadsDecl(token)` (local): the threads last seen. `docCommentsDecl(token)` (**cloud**): what this device wrote in a document, two actions, `comment.add` (written once per id: the first entry in the total order stands, as the server keeps the first copy of an id) and `thread.resolve` (a last-writer-wins register on its `at`). The old outbox array is the same thing without a reducer; its undelivered entries are imported as actions (`legacy: [{ key, json, actions }]`: replayed through the reducers into the op log, the old key archived as `__archive__<key>` and removed only after the record is saved).

Kit additions this needed, each tested in `tests/phase5.test.js`: `app.use(decl, { transport })` (a state brings its own sink; asking again rebinds it, because a remounted component hands over fresh closures); `legacy` entries with `actions`; `crossTab: true` on a local state (the `storage` event re-reads the record, so a rename in one tab reaches the others).

**What the cloud path does today.** The comments log is delivered by `client/docs-sync.js`, a two-method transport (`push`, `pull`) whose sink is the docs server: each entry is a POST (comment) or PATCH (resolve) in log order, a batch that fails half way is replayed whole (the server keeps the first copy of an id; a resolve is absolute), an offline error leaves the entries pending, a refusal for good is acknowledged and shown. The Stream mapping (entry `device:seq`, contiguous per device, idempotent retry, replay through the same reducer) is tested against `lib/stream-fake.js` in `core/docs-state.test.js`: 200 seeded runs of three devices with skewed clocks, offline gaps, lost acks and paged pulls converge to one state, every comment once. **What it does not do:** nothing is wired to the real Pangea Worker. The real adapter needs a token source (never stored in the repo or the state), the `$encrypted` envelope, a stream per document with a membership rule (the document link is public: who may read its stream?), cursor persistence across sessions (already saved in the record) and a pull that turns another device's entries into threads for a device that has no docs-server access.

**Differential fuzz.** `src/lib/ui/Docs.diff.test.js`: DocPage with DocNamePrompt, the /docs list and DocComments, each against its pinned oracle (`__oracle__/docs/*.v1.svelte`), seeded, shrinking, every kind and control asserted (page 12 controls, list 3, comments 26 including network modes, narrow and wide, quick box, peek card, retry, `online`, remount, a legacy outbox in the starting storage). Two oracles carry one explained line each (`*.v1-aligned.svelte`), because the old build had a bug there; the same test reproduces each bug on the pristine oracle: a guest named "The owner" after an owner session ended (cached owner flag), a rename in another tab never reaching the open page, and a deleted document returning from the cached list on an offline reload.

**Line count (non-blank, non-comment, script blocks).** The four components 664 -> 635, plus 129 in `docs-state.js` and `docs-sync.js` (764 total, +15%). Of the new 129, about 45 are capability native never had (the two reducers, `threadsOf`, the sink), about 20 are the thread overlay moved out of DocComments, about 25 are the legacy imports. Same honest line as before: not shorter, one declaration per persisted field, and the name is read from one place.

## 4c. The real cloud path: the hosted Worker, tokens, and the envelope

`scope: 'cloud'` delivers to the real hosted Cloudflare Pangea Worker since 2026-11-08 (The owner 00:06 PST: "it should probably hit the hosted cf pangea lol not some l1 fake ?"). Three pieces, all config from `pangea.config.json` beside `lib/` (worker URL, issuer URL, token TTL; single source of truth, no defaults in code):

- **`lib/stream-worker.js`**: the transport (`push`/`pull`, same two methods as `lib/stream-fake.js`, which stays as the test double). Wire: one `PUT /v1/streams/{stream}/entries/{entryId}` per entry in order, pull by integer `after` cursor (a true delta; the cursor persists in the replica record). The worker is `worker.example.invalid` (the replica-worker build; it is the deployment whose signing secret is in the vault; the `replica.example.invalid` host's secret was rotated away). Envelope: AES-256-GCM per stream (HKDF of the app secret), AAD binds (stream, device, seq), IV is deterministic SIV-style HMAC(aad‖plaintext) so a retried push is byte-identical and lands on the worker's idempotent-duplicate path instead of 409. `payload_sha256` is the canonical-JSON hash (conformance vectors pass byte-for-byte, `tests/stream-worker.test.js`). The app key never reaches any worker; an entry under the wrong key is counted `undecryptable` and skipped.
- **`lib/cloud.js`**: the one-step path. `cloudApp({ token?, secret })` then `app.use(declare({... scope:'cloud'}))` then `app.autosync()`. Without `token` it asks the issuer (browser, signed-in example.invalid session). Proof: `apps/greeting-card/card.mjs`, 32 lines, four devices converged through the live worker; `scripts/live-worker-demo.mjs` is the repeatable check (2 devices + a cold third).
- **Auth** (The owner 00:08 PST: "the pangea cloud needs some auth and shit"): `issuer-auth` (issuer.example.invalid) mints Pangea tokens for signed-in passkey identities. `POST /api/pangea/token` (session cookie) → 1h token; namespace = salted hash of the email (stable per person, so every device of one identity shares one namespace); optional `device_id` (binds writes; verified live: wrong device is 403 `device_not_allowed`) and `streams` allowlist. Refresh = call again; `POST /api/pangea/revoke` marks issued jtis (ledger `pangea_tokens`); the data plane verifies statelessly, so a revoked token dies at TTL and the namespace invariant (from token only, never a path) is untouched.

Rules learned the hard way: a cloud **device id must be as durable as its op log** (a fresh store reusing a device id is a permanent 409; localStorage is fine, memory is not); never delete local stores while the stream lives. **Public-link docs read rule (minimal, decided 2026-11-08):** the per-document comments stream is owner-devices only; a share-link guest never gets a Pangea token or the E2E key and keeps writing through the docs server, which remains the guest surface. **Key to a second device:** not built; the key is per app today (the greeting card hardcodes a demo key; real apps must fetch it from an owner-only place). Candidates: wrap the app key to the passkey's PRF extension, or device-to-device transfer. **Switching live webchat comments over** still needs: the owner device key decision above, the docs server replaying its existing threads into the stream once, and DocComments reading pulled entries instead of the server threads.


## 4d. Local durability, per-key families and recipes (webchat phases 4, 6; `lib/recipes.js`)

Three declaration flags for local state, each one word (tests: `tests/outbox-local.test.js`):
- `durable: true`: every dispatch first adopts what storage holds (another tab may have written) and the record is on disk before `dispatch` returns; `get()` reads the disk. For a counter that must never hand out a number twice, or anything a send follows. Costs one parse per dispatch, as the hand-written `getItem`/`setItem` it replaces did.
- `dropEmpty: true`: a state equal to its initial value has no record (the key is removed), the `if (v) setItem else removeItem` idiom; a missing record reads as initial, also in another tab (`crossTab`).
- `legacy: [{ key, ..., archive: true }]` on a local state: once the imported record is saved the old key is moved to `__archive__<key>` (rollback: copy it back); a failed save leaves it in place.

Recipes (`tests/recipes.test.js`):
```js
import { range, counter, advance, mint, keyed } from '.../lib/recipes.js'
// webchat/src/lib/core/reader-state.js, the whole slice:
export const readerDecl = declare({ name: 'reader', scope: 'local', durable: true, crossTab: true,
  fields: { textScale: range(1, 0.85, 1.5), autoMic: bool(true), deviceSeq: counter() },
  legacy: [{ key: 'reader.textScale', into: 'textScale', archive: true }, /* ... */],
  actions: { 'textScale.set': set('textScale', 'scale'), 'autoMic.set': set('autoMic', 'on'), 'deviceSeq.advance': advance('deviceSeq') } })
const seq = mint(reader, 'deviceSeq', 'deviceSeq.advance')     // minted once, saved before it is used
// a per-chat family (one record per key, gone when empty, cross-tab), e.g. composer drafts:
const drafts = keyed('draft', { fields: { text: field('', String) }, actions: { 'text.set': set('text', 'text') },
  legacy: (key) => [{ key: `host-app:${key}`, into: 'text', archive: true }], legacyPrefix: 'host-app:' })
drafts.use(app, chatId).dispatch('text.set', { text })   drafts.keys(localStorage)   // chats with a draft
```
`advance` is the absolute form of "increment": the payload names the value, so a replay or a stale tab cannot count twice.

---

## 4e. Testing: fuzzing, model check and visual diff for any kit app (`lib/testing/`)

An app gets differential fuzzing (build A vs build B, first diverging step, shrunk minimal scenario), a model check (named invariants over every trace) and a screenshot diff report by declaring three things: its **vocabulary** (the actions and faults a scenario is made of), a **driver** (how to perform one step and read the visible state), and a **normalizer** (what of that state is compared, which minted ids are canonicalized, and the explicit list of tolerated nondeterminism). Everything else is the kit.

| file | gives |
| --- | --- |
| `lib/testing/scenario.js` | `defineVocabulary`, `generate(vocab, seed, {length})` (seeded, scenarios are JSON data, a fault op with `closes` is closed a few steps later), `shrink` (ddmin; the driver's finale clears faults, so any subsequence is a valid scenario), `coverage` |
| `lib/testing/trace.js` | `record({scenario, driver})` -> trace, `defineNormalizer({project, ids, tolerated})`, `compareTraces` (first divergence, field path, both values), `differential({...})` (A vs B over seeds, shrinks divergences and B violations), `canonicalizer` |
| `lib/testing/invariants.js` | `noLoss`, `idempotentRetry`, `replayStable`, `tabsConverge`, `reloadRestores`, `deadlineBound`, `invariant(fn)`, `check`, `summarize` |
| `lib/testing/frames.js` | `installFrameRecorder` / `readFrames` (run in the page: rAF + MutationObserver, per-frame boxes of tracked selectors), `longFrames`, `firstFrame`, `jumps`, `monotone`, `quietFrom` (motion and first-paint laws) |
| `lib/testing/visualdiff.js` | `decodePng`/`encodePng` (no dependencies), `diffImages` (YIQ threshold, 1 px antialias shift tolerance, masks), `writeReport(dir, entries)` -> side-by-side HTML |

A driver is `{ start(rec), apply(step, rec) -> meta, settle() -> {settled}, observe() -> obs, finale(rec) -> { tabs: [obs], durable, converge? }, stop() }`; `rec.accept(key)` records an intent the app took ownership of, `rec.fault` is the fault state the driver keeps (stamped on every step). Build B is just a second driver factory (another build dir, a URL flag, a mutant). The whole thing for a todo app:

```js
const vocabulary = defineVocabulary({ ops: {
  add: { weight: 5, args: (g) => ({ text: g.marker() }) }, sync: {}, reload: {},
  offline: { closes: 'online' }, online: { weight: 0 } } })
const driver = (bug) => () => { let app; return {
  start: () => { app = bootTodo({ bug }) },
  apply: async (s, rec) => { if (s.op === 'add') { app.add(s.text); rec.accept(s.text) } else await app[s.op]() },
  settle: () => ({ settled: true }), observe: () => app.view(),
  finale: async () => { await app.online(); await app.sync(); return { tabs: [app.view()], durable: app.serverTexts() } },
  stop: () => {} } }
const invariants = {
  noLoss: noLoss({ durable: (t) => t.finale.durable }),
  idempotentRetry: idempotentRetry({ durable: (t) => t.finale.durable }),
  reloadRestores: reloadRestores({ isReload: (s) => s.step.op === 'reload', project: (o) => o }) }
const rows = await differential({ vocabulary, generate, seeds: [1, 2, 3], length: 20,
  driverA: driver(null), driverB: driver('suspect'), normalizer: defineNormalizer(), invariants, check })
// rows[i].divergence, rows[i].shrunk.steps, rows[i].violationsB.noLoss
```

The runnable version is `lib/testing/example/todo.harness.js` over `lib/testing/example/todo.js` (the state core plus the Stream fake), tested in `tests/testing-harness.test.js`: A vs A over 200 seeds, 0 divergences and 0 violations in 86 ms; A vs a build that throws its outbox away on a failed sync, 15 of 50 seeds diverge, `noLoss` fires on 14, and every divergence shrinks to the same 3 steps (`add`, `offline`, `sync`). Webchat's browser harness (`webchat/tests/parity/`) is the same API with a Playwright driver, a fault proxy and the chat vocabulary.

## 4f. The engine: robust by default (`lib/engine/`)

Pangea3 section 8 as kit modules (design: `<private-path>`). **An app author writes none of this for `scope: 'cloud'` state:** `createApp()` turns it on wherever IndexedDB exists (`engine: false` opts out, an object passes options), so `app.use(decl)` (or `app.use(decl, { scope: 'cloud' })`) gets a durable outbox, deadlines, auto sync that never drops, a telemetry lane and cross-tab pull (`lib/engine/defaults.js`, `tests/engine.app.test.js`). The modules below are for apps that own a bigger state engine (webchat's chat core, `apps/lab-log`). Laws: `tests/engine.laws.test.js`; vectors: `conformance/engine/*.json` (`node conformance/engine-generate.mjs`, checked byte for byte by `tests/engine.conformance.test.js`).

**Cloud state, zero code** (what `createApp` already does):
```js
const app = createApp({ transport })                       // in a browser: engine 'auto'
const notes = app.use(notesDecl)                           // scope 'cloud'
notes.dispatch('add', { id, text })                        // committed to IndexedDB, pushed within the push deadline, retried forever
notes.status()                                             // { pending, attempts, blocked (a 409 is reported, not looped), lastError, restored }
app.telemetry.push({ kind: 'longtask', durationMs: 90 })   // drop-oldest; shares nothing with the outbox
```

**An existing app opts in on purpose.** `'auto'` changes the behaviour of every `scope: 'cloud'` state an app already ships (automatic sync, an IndexedDB copy), so an app with users keeps it off until that state is verified in its UI. Webchat does: `webchat/src/lib/client/ui-app.js` creates its app with `engine: false`, so the docs comments (`core/docs-state.js`) keep syncing only when the page asks, legacy default included (pinned by `src/lib/client/ui-app.test.js`). To try the engine on the comments in one browser, set localStorage `host-app.ui-engine` to `auto` and reload (read once, when the app is created); remove the key to go back. At cutover, the default in `uiEngineChoice` becomes `'auto'` and the test flips with it.

**First paint never waits for the worker.** A tab that shows state an engine serves from a SharedWorker reads the engine's stored snapshot itself (read only, `openExisting`, one transaction, close on `versionchange`) while the worker starts, and drops it at the engine's first real state. The worker's hello snapshot is empty before its boot and must not blank what the tab painted. Webchat: `peekHeaders` in `webchat/src/lib/engine/session-host.js`; measured 2026-11-08, spawning the worker and evaluating its script took 15 to 110 ms before the engine read anything, and the cold load went from 1.36x the old client's to 0.92x (`npm run parity:coldload`).

**Durable outbox** (`outbox.js`; law: no loss, one id per intent, exactly once at an idempotent server):
```js
const box = await openOutbox({ name: 'my-outbox' })        // own database: no event write or eviction sits in front of it
const sender = createSender({ outbox: box, send: (e) => net.fetchWithin('send', '/api/x', { method: 'POST', body: JSON.stringify(e.body) }, { key: `send:${e.id}` }),
  onRefused: (e, r) => showRefusal(e.body, r.status) })    // a 4xx verdict is handed back, never retried, never silently dropped
const id = await sender.enqueue('stream-a', body)          // a ULID minted once; on disk when this resolves; same id on every retry
// full: box.admit throws BackpressureError (code 'backpressure') before anything is applied
```

**Synchronous outbox** (`outbox-local.js`; the same contract over Web Storage, for an outbox a view reads at its first render, before any promise resolves: a room's unsent messages, a clip waiting to upload). `createSender` takes it unchanged; the `*Sync` methods are the same work without the promise. Two tabs on one origin see each other's rows at their next call (every call is one read-modify-write of one key). An old key is imported once and retired entry by entry, so a rolled-back build finds exactly what is still owed:
```js
const box = localOutbox({ key: 'qk-outbox:room:lab', legacy: [{ key: 'old-unsent',
  entries: (raw) => JSON.parse(raw).map((e) => ({ id: e.id, stream: 'lab', body: e })),
  remove: (raw, ids) => { const kept = JSON.parse(raw).filter((e) => !ids.has(e.id)); return kept.length ? JSON.stringify(kept) : null } }] })
box.putSync([{ id, stream: 'lab', body: { text } }])        // on disk when this returns (throws if storage refuses)
box.rows('lab')                                             // synchronous, commit order
box.patchSync(id, (b) => ({ ...b, attempts: b.attempts + 1 }))
box.replaceSync(list)                                       // a caller that owns a whole ordered list
```
Tests: `tests/engine.local-outbox.test.js` (differential against `memoryOutbox`, the outbox law with `createSender`, legacy retirement). Used by webchat's room outbox and dictation clip queue.

**Deadline classes** (`deadline.js`; law: latest-wins per key, every call settles):
```js
const net = createDeadlineFetch(fetch, { deadlines: { ...DEADLINE_MS, hydrate: 20_000 } })
await net.fetchWithin('search', `/api/search?q=${q}`, {}, { key: 'search' })   // a newer search aborts this one
await net.within('pull', (signal) => transport.pull(stream, cursor, { signal }))  // any promise, not only fetch
```

**Telemetry lane** (`lane.js`; law: bounded, newest kept, never touches the outbox):
```js
const lane = createTelemetryLane({ maxItems: 500, maxBytes: 256_000, send: (records) => net.fetchWithin('telemetry', '/lag', { method: 'POST', body: JSON.stringify({ records }) }) })
lane.push(record)                                          // never blocks, never throws; a failed batch is counted and gone
```

**Derived jobs and accounting** (`jobs.js`; law: one run per key at a time, no trigger lost):
```js
const jobs = createJobs({ budgetMs: 8 })
const book = ledger()                                      // per-partition bytes, counts, last activity; O(1) total
book.add(part, bytes, 1, at)
if (book.total() > budget) jobs.run('evict', async (tick) => { for (const p of book.evictionOrder({ keepAfter })) { await drop(p.id); await tick() } })
```

**Replica store with a declared budget** (`replica-store.js`):
```js
const store = await openReplicaStore({ name: 'lab-log', key: 'pos', partition: 'experiment', time: 'at',
  policy: { budgetBytes: 200e6, windowMs: 14 * 864e5 } }) // keep two weeks whole; evict outside the window first
await store.append(records)                                // add-only by key: a re-delivered page cannot inflate the totals
await store.readLatest('tank-01', 100); store.usage()      // { bytes, records, parts, windowBreached }
```

**Offline search** (`search.js`):
```js
const r = await searchStore(store, 'degassed tank', { textOf: (e) => e.text, partOf: (e) => e.experiment, deadlineMs: 1500 })
// { hits: [{ part, score, best: { text, key, excerpt } }], complete, scanned }: never shows a partial answer as complete
```

**One engine per browser, tabs as views** (`host.js`, `patch.js`):
```js
// worker.js
workerMain(() => serveEngine({ methods, view: () => state, subscribe, diffOptions: { maps: ['entries'] } }))
// tab
const engine = connectEngine({ name: 'lab-log',
  shared: () => new SharedWorker(new URL('./worker.js', import.meta.url), { type: 'module' }),
  dedicated: () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }), local: () => makeServer() })
engine.subscribe((state) => render(state)); await engine.call('write', { id: ulid(), text })
// engine.kind: 'shared' | 'leader' (Web Locks, BroadcastChannel relay; the next tab takes over) | 'worker' | 'local'
```
A patch is reference diffing of an immutable state: top-level keys, entries of declared maps, one splice per changed array, so a streamed token in a 10,000-row list sends one row. Calls not answered when the leader changes are re-sent; make engine methods idempotent by an id the tab minted.

**Worked second example: `apps/lab-log/lab-log.mjs`** (a bench notebook, not a chat; `tests/example-lab-log.test.js`): entries written offline survive a reload and are delivered under the id minted offline, two tabs share one engine, search answers offline with coverage, a refusal is handed back. Webchat's chat core uses the same modules with a chat schema (`webchat/src/lib/engine/chat-store.js`, `core.js`, `chat-engine.js`).

**Known limit (not fixed):** two tabs of one browser using the kit's state core *without* the shared engine share a device id and may log the same `device:seq` with different payloads; the Stream answers 409. The defaults report it (`status().blocked`) and keep the entries; the structural fix is to run cloud states inside the shared engine (one sequence per browser).

## 4g. Big documents: keyed rows (`lib/engine/rows.js`), and pagination in practice (zai2, 2026-11-08)

The whole-state replica (section 1) cannot hold a 30,000-line document: one JSON record in localStorage (about 8 MB, over quota), a full stringify per save and per ingest, a 200-entry tail. `openRows` is the kit's state for that shape: one IndexedDB record per row, per-field last-writer-wins on a stamp carried in the payload (commutative and idempotent, so no tail, no refold, no horizon), pending patches coalesced per row and field (typing 60 characters is one field in one Stream entry), an `outgoing` entry written before the push so a lost ack re-sends identical bytes, one Web Lock holder per browser pushing (one device_seq sequence, which removes the two-tab 409), BroadcastChannel to other tabs. Pagination is by sort key over an IndexedDB index that only live rows carry: `load({ from })` then `loadOlder(n)`.
```js
const doc = await openRows({ name: 'zai2-lines', transport, sortKey: (r) => [rank[r.zone], r.ord, r.id], live: (r) => !r.deleted_at })
await doc.load({ from: [1] }); await doc.loadOlder(300)   // NOW onwards, then one page of Past
doc.put([{ id, set: { body } }])                          // memory now, disk in one transaction, pending for the cloud
doc.view.rows() / .get(id) / .indexOf(id)                  // the loaded live rows in order
```
`mergeRow`/`foldRows` are the same merge for a server (zai2's MCP Worker folds the stream with them). Tests: `tests/engine.rows.test.js` (40 seeded three-device runs with offline gaps, coalescing, the lost-ack retry, pagination and deleted rows).

Measured in zai2 (Chrome, 30,002 live rows, `?stream=zai2-test-big`): first paint from IndexedDB 61 ms; an older page of 300 rows 8 to 55 ms; scrolling from NOW to the top through 100 pages held the top row within 0.7 px; frames p95 19 ms; a keystroke 18 ms and an undo 18 ms. Gaps found and fixed on the way (each is a rule now):
- `anchorAt(index, top, idAt, { skip })`: a "loading older" sentinel or zone head never anchors; anchoring on the index-0 sentinel held the page at the top while 300 rows arrived under it (723 px jump).
- Before writing `scrollTopFor(...)` after a prepend, grow the scroll range (the bottom spacer) to the index's new total, or the browser clamps scrollTop to the old height (a 2,112 px jump on the first page).
- No row may carry a CSS margin: `heightIndex` measures `offsetHeight`, a margin is outside it (4 px drift per page).
- The first sync of a fresh device pulls everything (the Stream has no partial read): about 20 s for 29,667 rows in 43 entries before reads were batched; `put`/`ingest` now issue every read of a transaction at once.

## 3e. UI laws (lib/laws-ui/): the owner's corrections as laws an app gets by declaring state

Source: 198 of the owner's webchat corrections, classified in `webchat/tests/corrections/catalog.json` (classes in `classes.json` there). Every law below names the correction classes it exists for; `uiContract(decl)` (`lib/laws-ui/contract.js`) turns them on from the declaration's shape, so the author writes numbers, never the harness. Defaults live once, in `UI_DEFAULTS`: interaction p95 100 ms and p99 200 ms, load p95 1000 ms, reducer step p95 4 ms, motion max 400 ms with a 34 ms stutter gap, network wait deadline 15 s.

| law | on by default when | classes | runs | cost |
| --- | --- | --- | --- | --- |
| `reloadRestores`, `firstPaint` | scope is `local` or `cloud` | first-paint-flash, state-lost-on-reload | every deploy (gate, validate) | about 50 ms per declaration |
| `noLoss` | `owner` actions, `durable`, or `conflict: 'log'` | data-loss | every deploy (gate, validate) | about 50 ms |
| `idempotentRetry` + `tabsConverge` | scope `cloud` | duplicate-or-replay, cross-device-convergence, echo-fight | every deploy (gate, validate) | about 0.3 s |
| `reducerBudget` | always | interaction-latency, freeze-starvation | every deploy (gate, validate; generic or declared generator) | 1 to 10 s on a large state |
| `budget` (browser) | always, one per action plus named `budget` entries | interaction-latency, load-latency | opt-in: only where an app's browser test calls `checkBudgets` (the editor gate's `timing` check is p95 over all actions) | about 1 min per page |
| `liveness` | `waits` declared | liveness-stuck | at declare (structural: the exit edge); the trace check `checkLiveness` is opt-in; no runtime timer moves a waiting state | ms |
| `motion`, `settled`, `layoutStable`, `anchorStable`, `flicker` (frames) | `motion` declared; settled for persisted state | motion-quality, flicker, first-paint-flash, layout-shift, scroll-anchor-jump | per commit for the kit's vectors; for an app, opt-in (its browser test calls them) | seconds per gesture |
| fuzz | any declaration with a `gen` | editor-semantics, data-loss, every model law above | opt-in (an app test calls `fuzz`) | seconds to minutes |

**Structural first.** What can be made impossible is refused at `declare` time (`declare` calls `uiContract`), not tested: a budget for an action that does not exist, an `owner` action that is not declared, a `waits` state with no declared exit edge (a spinner that cannot be stuck forever because the lifecycle has no way to be), and the existing kit rules (persist by declaring, no storage keys in components, `webchat/src/lib/ui-state-lint.test.js`). The runtime laws cover what a shape cannot.

**Declaring** (all optional; omit everything and the defaults still apply):
```js
export const sidebar = app.use(declare({
  name: 'sidebar', scope: 'local', initial: { open: {} },
  actions: { 'folder.open': (s, { key, open }) => assign(s, { open: { ...s.open, [key]: open } }) },
  budget: { 'folder.open': { p95_ms: 50 }, switchChat: { kind: 'load', p95_ms: 300 } }, // numbers only
  owner: [],                                                    // actions that carry his words: noLoss
  motion: { fold: { property: 'h', max_ms: 200 } },             // gestures the motion law watches
  firstPaint: true,                                             // default for persisted scopes
}))
```

**Model laws, per commit** (one call; `gen` is the generator the component laws already use):
```js
import { ui } from '.../pangea-kit/lib/laws.js'
it('sidebar keeps every UI law', async () => {
  const { failures } = await ui.checkUiLaws(sidebarSpec, gen)   // reloadRestores, firstPaint, noLoss, converge, reducerBudget
  expect(failures).toEqual([])                                  // each failure: { law, seed, steps, detail }
})
```

**Latency budget in a browser** (input-to-next-paint, clock starts at the input event's own timestamp):
```js
const samples = []
for (let i = 0; i < 20; i++) samples.push({ name: 'folder.open',
  ms: await ui.measureInteraction(page, () => page.click('[data-folder=a] .fold'), "document.querySelector('[data-folder=a]').dataset.open === 'true'") })
expect(ui.checkBudgets(ui.uiContract(sidebarDecl), samples)).toEqual([])
```

**First paint equals settled state** (generalizes the 2026-11-07 sidebar fold flash; `recordFrames` uses the kit's one recorder, `lib/testing/frames.js`, installed before the page's own scripts):
```js
const frames = await ui.recordFrames(page, { inbox: '[data-group=inbox]', pine: '[data-folder=pine]' },
  () => page.reload(), { fromLoad: true, settleMs: 2500 })
expect(ui.checkSettled(frames, (f) => ({ inbox: f.els.inbox?.text, pine: f.els.pine?.text }))).toEqual([])
```

**Motion** (one easing, no bounce, no mid-motion vanish, nothing showing through, no stutter):
```js
const frames = await ui.recordFrames(page, { card: '.cert', flap: '.flap' }, () => page.click('.envelope'))
expect(ui.checkMotion(frames, 'card', { property: 'y', hiddenDuring: ['flap'] })).toEqual([])
expect(ui.checkLayoutStable(frames, ['composer'])).toEqual([])   // what the gesture does not own does not move
```

**Engines the kit does not own** (an app's outbox, transport, IndexedDB replica) feed traces to the same verdicts:
```js
expect(ui.checkLiveness(samples, { deadline_ms: 15000 })).toEqual([])   // pending => armed retry or a young request
expect(ui.checkNoLossTrace(dispatchedIds, survivingIds)).toEqual([])
expect(ui.checkBoundedWork(scansPerAppend, { perEvent: 1 })).toEqual([])
```

**Coverage-guided fuzz** (corpus seeded from incident reproductions; feedback is V8 block coverage of the files you name, or state shape plus event-kind pairs where V8 is not available):
```js
const r = await ui.fuzz({ exec: ui.declExec(decl, step, (prev, next) => lostSomething(prev, next)),
  fresh: gen, seeds: [incidentSteps], runs: 2000, coverage: 'v8', filter: /reducer\.js/ })
expect(r.failures).toEqual([])   // each failure is shrunk to its shortest sequence
```

Vectors: `conformance/laws-ui/frames.json` (generated by `conformance/laws-ui/generate.mjs`): one good trace per law and one bad trace per correction shape (bounce on set-down, two easings, mid-motion vanish, flap showing through, stutter, folders flashing unfolded, hover layout shift, mic icon flicker), each citing the correction. Tests: `tests/laws-ui.test.js`.


# quicklook target: the viewer kit (original guide)
Read this once, then build. Companion files: [docs/RECIPE.md](docs/RECIPE.md) (a tested 40-line app to copy, the verify checklist, the one-shot prompt template) and [docs/PITFALLS.md](docs/PITFALLS.md) (every failure that already cost the owner time; read before you write a part). Source of truth is the code: `host/`, `lib/`, `ui/`, `tests/`. Statements below are checked against that code or against a run on 2026-11-06 (marked `[ran]`); anything unchecked says `[unverified]`.

## 1. What it is, when to use it

A kit for one-off interactive viewers and editors (3D scenes, selection, sliders, keybinds) that publish into quicklook at `https://viewer.example.invalid/view/<ULID>/`. The ULID is stable across republishes, so the link you gave the owner keeps working while you change the app under it. Open pages update live: only the file that changed is fetched, nothing reloads, the camera and selection stay.

Use it when the owner wants to look at, trace, segment, measure or edit something spatial or tabular that he will iterate on ("i want a 3d explorer", "make it segmentable, deletable"). Do not use it for: a static figure (publish the image/HTML to quicklook directly), anything that needs another origin, cookies, or fetching other sites (see Limits), or a one-time python plot. The owner (2026-11-06): *"stop making these python shit , if ur gonna make something make it 3d, ideally give me direct links to 3d stuff"*, and *"why did u make a whole new url bruh lol . overbulit. just use the svelte thing ... we're gonna make hella of these one off tools and they should live in quicklook"*. One new app = one new ULID at most; never a new hostname, tunnel or server.

## 2. Quickstart

```
export PATH=<node-bin>:$PATH      # node 22; no other node is on PATH
cd $KIT
node bin/pangea-kit.mjs build   apps/<app>                    # stage only, prints the stage dir (a cheap compile check)
node bin/pangea-kit.mjs publish apps/<app>                    # new artifact; prints {ulid,url,changed,...}
node bin/pangea-kit.mjs publish apps/<app> --into <ULID>      # same URL; open pages hot-swap what changed
node bin/pangea-kit.mjs publish apps/<app> --rebuild-host     # force-rebuild the host (only if you edited host/ lib/ ui/)
node bin/pangea-kit.mjs push <ULID> '{"em":{"contrast":2}}'   # agent -> open page (bare object = patch)
node bin/pangea-kit.mjs push <ULID> '{"op":"set","payload":{"path":"camera","value":{"p":[900,350,1100],"t":[0,0,0]}}}'
node bin/pangea-kit.mjs view <ULID>                           # what the open page last reported (view.json: state + op log)
npm test                                                          # vitest, 54 tests; never bare `node --test`
```
`pangea-kit` is not on PATH [ran: `which pangea-kit` is empty]; call `node bin/pangea-kit.mjs` (the README shorthand `pangea-kit` means that). `publish` without `--into` goes through `<private-path>` (creates the ULID); the stage dir is a temp dir and is removed afterwards. Artifacts live in `<private-path>` (override `PANGEA_KIT_QUICKLOOK_ROOT`); `rm -rf` the dir to retire a test artifact [ran].

App layout, `apps/<name>/`:
```
state.js            the ONLY place state is declared: { name, version, initial, migrations, setup(store,{selection}) }
parts/NN-name.js    one swappable part each; export default (ctx) => { ...; return dispose? }; mounted in sorted name order
parts/Foo.svelte    components imported by a part are bundled INTO that part (a change to Foo swaps the parts that import it)
lib/*.js            helpers imported by parts (bundled into each importing part; use ctx.data.memo to share heavy results)
quicklook.json      optional: "title" (tab title, served via meta.json; default = app dir name; set it, never ship a tab called "quicklook"; live override: push {"title":"..."} or state.title), "units"/"unitScale" (label unit and display units per scene unit; default µm and 1), "axes": false (opt out of the built-in axes, non-spatial apps only), { "data": { "dir": "~/path", "files": ["a.json","b.bin"], "optional": ["b.bin"] } }
```
Rules the builder enforces (lib/build.mjs, lib/publish.mjs): part filenames match `[A-Za-z0-9][\w.-]*\.js`; a part may import only its own files plus the externals `three`, `svelte`, `svelte/*`, `pangea-kit/ui`, `pangea-kit` (these resolve to the host's single instance, so a swapped part joins the same Svelte runtime and THREE); everything else is bundled. Svelte 5 runes mode is forced. `three/addons/...` is NOT external: import it and it is bundled into that part (OrbitControls is already in the host as `viewer.controls`). A missing non-`optional` data file fails the publish. Data files are copied by APFS clone (no second copy of a 50 MB file). `state.json`, `view.json`, `SOURCE.json` in the artifact are reserved; do not name a data file that.

## 3. API reference

### 3.1 State, store, actions (`lib/store.js`, `host/kit.svelte.js`)
- `ctx.state`: one Svelte `$state` proxy, shape = `schema.initial` merged with the persisted state. Read it freely, including inside `ctx.effect`/`ctx.sync` and Svelte templates (`bind:value={state.em.contrast}` works and writes the same tree).
- `ctx.dispatch(op, payload, { undoable, actor='user', id, ts, quiet })` (also `ctx.store.dispatch`). Built-in ops, all absolute end-states:
  - `set {path, value}`: `path` is dotted (`'em.contrast'`, `'cells.on.excitatory'`); value is deep-cloned.
  - `patch {...obj}`: writes only the leaf paths it names; a push of `{em:{contrast:2}}` cannot reset the camera.
  - `restore {prev}`: used by undo; do not call it yourself.
  - `sel/set {ids, picks?}`, `sel/include {id,on}`, `sel/clear {}`: exist after `setup` runs `store.component('sel', selection())`. State slice `sel = {ids:[], picks:[]}`; `picks` keeps the last two clicked ids (for "path between two clicks").
- Own reducers: `store.register({ 'rotate': Object.assign((s, {path, deg}) => {...mutate s in place...}, { touch: ({path}) => [path] }) })` in `setup`. Declare `touch` (the paths written): without it the action logs an empty `prev`, so undo restores nothing and an all-`_` write is not recognised as transient. Component actions (`store.component(path, {initial, actions})`, names `<path>/<name>`) get `touch = [path]`, i.e. undo restores the whole slice.
- `store.undo()` restores the pre-state of the newest `undoable` action not yet undone (compensating `restore`, itself logged with actor `undo`; there is no redo). `store.canUndo`. Only actions dispatched with `{undoable:true}` are undoable; mark user-meaningful edits (selection, delete), not slider sweeps or camera.
- Log: append-only, kept 300 entries, each `{id, seq, op, payload, actor, ts, prev, undoable}`. Same-actor non-undoable `set`s to the same path within 500 ms collapse into one entry (a slider drag is one entry). A repeated `id` is ignored (`dispatch` returns null): that is how an agent push is never applied twice.
- Transient: any action whose touched paths all start with `_` is applied but never logged or persisted. Nested `_` keys are stripped from the persisted checkpoint too (`stripTransient`). Use `_` for hover info, derived text, load flags, and for big derived metadata the panel needs (`_meta`).
- Persistence: `schedulePersist` writes the checkpoint `{version, savedAt, state, log}` 400 ms after the last action, and `flushPersist` on `pagehide` and before a host reload. Where it goes: `window.name` (same tab, survives reload) and a POST to `__view` (server `view.json`, survives a new tab). On load the newer `savedAt` wins. Server copy is capped at 256 KB (the page drops oldest log entries until under 200 KB).

### 3.2 `state.js` schema
```js
export default {
  name: 'my-app',                      // persistence key is `qk:<name>`: rename = lose everyone's saved state
  version: 1,                          // bump when a key's shape/meaning changes
  initial: { camera: null, ... },      // EVERY key the UI reads must exist here (assertComplete aborts a load that drops one)
  migrations: { 2: (st) => ({ ...st, x: st.oldX }) },   // upcasters keyed by target version; missing one aborts rather than clobbers
  setup(store, { selection }) { store.component('sel', selection()) },   // runs at boot and again after a state.js swap
}
```
`initial` is tier 1; persisted state is deep-merged over it, so a key you ADD appears in open pages with its default and nothing else resets (also true for a live `state.js` swap [`host/boot.js` `plan.schema`]). `camera: null` is legal (null base takes the persisted object). Bumping `version` upcasts live state; raw bytes are archived before every migrate (last 3 in `window.name`); an unloadable saved state aborts: the app runs on `initial`, shows a red message in the chip, and does NOT persist over the old bytes.

### 3.3 Scene derivation: `ctx.sync` and `ctx.effect` (the rule that prevents desync)
```js
ctx.sync(mesh, { visible: () => state.gray.visible, 'material.opacity': () => state.gray.opacity })
ctx.effect(() => { /* any code reading state; re-runs when what it read changes */ })
```
`sync(obj, spec)` assigns `obj[path] = read()` when it differs (`undefined` is skipped) now and whenever the state it read changes. Call it right after you create the object: a layer that finishes loading late immediately shows the CURRENT (restored or pushed) state. Never set a mesh property from a click handler or a Svelte `onchange`; dispatch, and let the sync apply it. Effects that need `needsUpdate`, uniforms or buffer rebuilds go in `ctx.effect` (see `apps/microns/parts/10-vessels.js`). `ctx.dispatch` inside an effect does not subscribe the effect to what it reads (`untrack`), so writing derived info back (`dispatch('set',{path:'_selInfo',...})`) is safe.

### 3.4 Part context (`ctx`)
`state dispatch store viewer data keys THREE ui el name deps commands live getPath setPath selection` plus, all auto-cleaned when this part swaps (newest first):
- `ctx.add(obj, parent=viewer.root)`: add a three.js object; removed and its materials/maps disposed on swap. Geometries you share across parts or memoize are NOT disposed (dispose private ones with `ctx.cleanup`).
- `ctx.mount(Comp, props)`: mount Svelte into this part's element (`display:contents`, inside the pointer-events:none overlay; the kit's `Panel` re-enables pointer events for itself).
- `ctx.layer(file, async (json, scope) => {...})`: build a layer from one data file; reruns with a fresh `scope` (a part-like ctx: `scope.add/effect/sync/...`) when that file's hash changes or the file first appears; previous scope disposed first. If the file is absent the scope is torn down.
- `ctx.watch(file, fn)`, `ctx.effect`, `ctx.sync`, `ctx.cleanup(fn)` (or return a function from the part), `ctx.onFrame(fn)` (per-frame hook), `ctx.onClick(fn)`, `ctx.bindKeys(map, {repeat})`, `ctx.command(name, fn)` (publishes `ctx.commands[name]` so the panel's buttons call the same function the key calls; removed on swap).
- A part may be `async` (await data); a throw leaves a red line in the bottom-right chip and the other parts keep running. Parts never wait for each other: all part scripts are fetched at once and every part mounts as soon as its script (and the earlier parts' scripts) are in, so a UI-only part (the panel) is up while the layers' data is still loading; the chip lists parts and data files still loading (`lib/parts.js` `mountParts`, `tests/parts-mount.test.js`). Contexts are still created in file order, so DOM order and key ranking follow the file names, not data arrival. A panel button whose command a still-loading part publishes should call it as `commands.x?.()`.

### 3.5 Viewer (`host/viewer.js`), persistent: created once, never torn down
`viewer`: `THREE renderer scene camera controls(OrbitControls) root el`, background `0x0e0e0e`, hemisphere + one directional light, fov 40, near 1, far 20000, default camera at (900,350,1100) looking at the origin. Size your data to that scale or call `fit` first (units are whatever you put in; the microns app uses µm and flips/shifts `viewer.root` to centre the cube).
- `viewer.raycast(e, objects, recursive=false)`: first hit under the pointer event or null (`hit.object, hit.point, hit.faceIndex`).
- `viewer.onClick(fn)` / `ctx.onClick(fn)`: one pointerdown/up pair within 4 px (a drag is the camera's). Handlers run newest first; return `true` to consume so older handlers (e.g. selection) do not also fire (measure mode does this).
- `viewer.fit(box3, {ms=450, margin=1.6, done})`: fly to frame a world-space `Box3`, same view direction, one ease-in-out cubic, cancelled by any pointerdown/wheel. Pass `done: () => dispatch('set',{path:'camera',value:viewer.getCamera()})` so the end pose is saved (`fit` itself writes no state).
- Camera: `getCamera()` is `{p:[x,y,z], t:[x,y,z]}` (position, orbit target). The host dispatches `set camera` on every OrbitControls `end` and reconciles the camera from `state.camera` (same-value writes are no-ops, so it cannot fight a drag). To move the camera from code or from a push: write `camera`.
- `viewer.measure({unit='µm', parent=root, decimals=1})` returns `{add(worldPoint), clear(), points}`; two clicks give `{n:2, distance, text:'distance 12.3 µm'}` in `parent` local units, so the unit is correct only if your scene units are that unit. Dots/line are yellow, `depthTest:false`. Call `ctx.cleanup(measure.clear)`.

### 3.6 UI (`import { Panel, Slider, Toggle, Button, Legend, ScaleBar, ImagePlane } from 'pangea-kit/ui'`, Svelte 5)
- `<Panel title pos="left|right" bind:open>`: floating 318 px, dark translucent, collapsible, scrolls.
- `<Slider label bind:value min max step fmt>`, `<Toggle label bind:checked color note>`: bind straight to `state.*` paths (binding writes the same tree the scene reads; no handler needed). A bound write is not logged and cannot undo (use `dispatch` for anything that must undo), but the host persists any non-`_` state change, debounced.
- `<Button label hint active disabled onclick>`: `hint` prints `[g]` next to the label.
- `<Legend items={[{id,label,color,count?,on}]} ontoggle={(id,on)=>...}>`: one coloured swatch row per class; `ontoggle` must dispatch (derive `items` with `$derived` from state).
- `<ScaleBar pixelSize zoom maxPx units unitScale>` and `<ImagePlane src|oncanvas width height pixelSize pixelSizeY shown units>`: the 2D side of the axes rule, see 3.10.
- Styling is fixed in the components: `#000d` panel, `#ddd` text, accent `#7fb0ff`, 12 px `ui-monospace`. Info lines `color:#7fb0ff`, help lines `color:#888`.

### 3.7 Keys (`lib/keys.js`)
`ctx.bindKeys({ g: fn, 'shift+g': fn, 'mod+z': fn, Escape: fn, ArrowLeft: fn }, { repeat:false })`. Specs are `[mod+|ctrl+|meta+|alt+|shift+]key`; `mod` = meta on macOS. Nothing fires while focus is in a text input, textarea, select or contenteditable (range/checkbox/button focus does not block). A bare `g` never fires on ctrl-g or cmd-g (macOS emacs text keys stay intact). Shift is strict for letters/named keys (`g` is not `shift+g`) and ignored for punctuation and digits (`?`). Between parts the later part file wins (bindings are ranked by part order, so a part whose data arrives late does not steal a key); within one part the newest binding wins; key repeat ignored unless `repeat:true`; `preventDefault` only on a match. Unbound on part swap.

### 3.7b Undo / redo (`lib/snaphistory.js`, `trackHistory` in `host/kit.svelte.js`, `kit.history`)
Opt in with `history: true` or `history: { limit: 100, coalesceMs: 400, exclude: ['camera'], passive: ['sel'], onApply(state, 'undo' | 'redo') }` next to `version` in state.js (no state shape change, no version bump: the history is in memory, never in `state`, never persisted). The host watches the persistable tree, so it records `dispatch` writes and direct writes (`bind:value`) alike. A step is everything between pointer-down and pointer-up (a slider sweep, a vertex drag), else consecutive changes to the same keys under `coalesceMs` apart (arrow keys); a new edit clears redo; the stack keeps the newest `limit`. `_` keys and `exclude` (default camera, axes, title) are never recorded or touched; `passive` keys (a selection) are not a step alone but are restored with the step that owned them. cmd/ctrl-Z, shift-cmd/ctrl-Z and ctrl-Y are bound on the window except while focus is in a text field, textarea or contenteditable (native undo there). `kit.history`: `undo()`, `redo()`, `canUndo`, `canRedo` (reactive), `sizes`, `limit`, `reset()` (called after a hot-swapped schema is upcast). `lib/undo.js` (`declare({ undo })`) is the other facility, for declared replicas whose writes are all actions.

### 3.8 Data layer (`lib/data.js`)
- Files named in `quicklook.json` are published beside the page; the server lists every file with its content hash; the page fetches `<name>?v=<hash>` (served `immutable`). Changing one file changes only its hash.
- `data.json(name)`, `data.buffer(name)`: fetch once per (name, hash); concurrent callers share one promise; a failed fetch is not cached. `data.has(name)`, `data.url(name)`, `data.version(name)`.
- `data.memo(key, [files], fn)`: cache a DERIVED product (decoded geometry, volume) that survives part swaps and is recomputed only when a listed file's hash changes. `fn` may return a promise; a rejected one is dropped so a fixed part retries. Put heavy decode here, not in the part body, or every part swap re-decodes. `data.release(name)` drops the raw parsed JSON after memoizing (it is not needed again).
- `data.watch(name, fn)` (via `ctx.watch`) fires for added/changed/removed files. Blobs/images from base64 data URLs: decode base64 yourself and `createImageBitmap(new Blob(...))`; `fetch('data:...')` is blocked by the page CSP.

### 3.9 Live channel and agent push
- Page side opens `EventSource('<base>__live')`. Server (`webchat/src/lib/server/quicklook-live.js`): `hello {files:{name:hash}}` on connect and reconnect, `code {files}` after files have been stable for 500 ms (identical bytes never fire), `state <json>` with the contents of `state.json` (sent on every connect, then on change; polled every 400 ms). Status dot bottom-right: `live` / `reconnecting`.
- `push` appends `{id:'push-<ms>-<hex>', ts, actor:'agent', op, payload}` to `<artifact>/state.json` (last 20 kept, temp+rename). Every open page applies unseen ids through the store (same reducer as a click), so a reload or reconnect replays the file but ids already in the page's log are ignored. Consequence: a push is an edit to what the user sees; push only the keys you mean, and remember a later user change is not overwritten on reload.
- `POST <base>__view` (page to server, 256 KB cap, coalesced, newest wins) writes `view.json`; `pangea-kit view <ULID>` prints it. Use it to see what the owner currently sees (camera, selection, sliders) before you reason about "the view".
- The page may connect only to its own artifact URL prefix (CSP `connect-src`). An app may declare extra exact origins in quicklook.json, `"connect": ["https://compute.example.com", "wss://compute.example.com"]` (https/wss origins, plus plain http/ws to localhost or 127.0.0.1 only; no wildcards or paths; publish refuses anything else): pangea-kit writes them to meta.json and the webchat `/view` route adds them to `connect-src` of the page's CSP (nothing else is widened). The target must send CORS headers (the page's origin is opaque, so `Access-Control-Allow-Origin: *` with an Authorization header preflight). [code: lib/meta.js, webchat file-response.js] No CDNs, no fonts or images from other hosts (`img-src data: blob:`), no `fetch` of external APIs: bake what you need into data files at publish time.

### 3.10 Built-in axes, scale bar and units (host/axes.js, lib/scale.js, ui/ScaleBar.svelte, ui/ImagePlane.svelte)
The owner: *"for 3d volumes and 2d images etc there should always be axes xyz and scale labels and such"*. So the kit does it; an app writes no code for it and a one-shot app cannot forget it. Every 3D view draws, in the data frame of `viewer.root` (a flipped or shifted root, as in microns and h01, still shows its own data coordinates) [ran 2026-11-06 on a copy of apps/h01]:
- a bounding box of everything under `root` (muted grey), re-measured twice a second, so layers that load or hide late are included; skip an object with `obj.userData.qkNoBounds = true`;
- the three edges from the min corner are the X (red), Y (green), Z (blue) axes with ticks and tick labels, plus an axis name `X µm`; tick labels are the distance from the min corner, `0 .. extent` in display units, 1/2/5 steps, and the last label is the extent itself (h01: `0 200 400 600 770`, Z `0 50 100 150 175`);
- a screen-space scale bar, bottom centre, a round 1/2/5 length (50 / 100 / 200 µm ...) at most 140 px wide, recomputed every frame so it follows zoom. It is exact at the orbit-target depth (perspective: nearer parts are bigger than the bar says) [ran: 100 µm projects to 77.8 px, the bar is 78 px];
- an orientation gizmo bottom right (the data X, Y, Z directions, rotating with the camera);
- the hint `x axes` under the scale bar. Key `x` toggles everything; the toggle is `state.axes` (default `true`, merged under every app's `initial` by the host, persisted and restored like any state key; an app's own `x` binding wins if it makes one). `push {"axes":false}` works too.
Labels are CSS overlay elements (`#qk-axes .l`, `data-qk-axis`, `data-qk-kind`, `data-qk-value`), hidden rather than clipped at the viewport edge, never over a panel (panels sit above the overlay), never blocking pointer events.

Units. Kit convention: one scene unit = 1 µm. To label differently set `units` and `unitScale` (display units per scene unit) in `quicklook.json` (`{"units":"mm","unitScale":0.001}`, served via meta.json, hot-applied without a reload) or in state (`push {"units":"mm","unitScale":0.001}`; state wins). `um`, `micron(s)`, `μm` all normalize to `µm`. The scale bar steps `µm` to `nm` below 1 and `mm` from 1000; other units are shown as written. `viewer.measure({unit})` is separate: pass the same unit. `kit.units` is the resolved `{unit, scale}`.

Opt-out: `"axes": false` in `quicklook.json`, only for non-spatial apps (a table, a chart); it removes everything including the hint and ignores `x`.

2D images. Any image the kit draws gets a scale bar and x/y extent labels from `<ImagePlane>`, or `<ScaleBar>` over your own canvas. The app passes its pixel size, scene units (µm) per source pixel:
```svelte
<ImagePlane src={url} width={512} height={512} pixelSize={4} shown={320} />   <!-- 512 px source at 4 µm/px = 2048 µm wide; src may be a data:/blob: URL -->
<ImagePlane width={w} height={h} pixelSize={4} pixelSizeY={4} oncanvas={(c) => paint(c)} />   <!-- or draw into the canvas it hands you -->
<ScaleBar pixelSize={4} zoom={shown / width} />                                  <!-- zoom = screen px per source px -->
```
`width`/`height` are the source pixel size, `shown` the on-screen width in CSS px. EM planes drawn as textured quads inside the 3D scene need nothing: they are inside the bbox and the 3D scale bar. Logic and its tests: `lib/scale.js`, `tests/scale.test.js`.

## 4. Why it is designed this way

The microns viewer (2026-11-06) failed in four ways in one afternoon: every code edit reloaded the page and re-downloaded 47 MB; the page flashed black and dropped the owner's view; after a reload the checkboxes were right but the 3D still showed unchecked layers; a restore crashed on an empty saved camera. The kit is the structural fix for each, following the Pangea state model (`<private-path>`, case-study `extras/case-studies/viewer3`) and the viewer5 persistence contract (`<private-path>`):

- **One state tree, path-level reducers.** Every control and every scene property reads one `$state` tree; only touched leaves invalidate. There is no second copy of "what is checked" that can disagree with the scene.
- **Absolute actions.** `set path=value`, `sel/set ids=[...]`. A gesture ("toggle", "grow") reads the state, computes the target, dispatches that. Replaying an action twice gives the same state, which makes retries, pushes and reload-replays safe.
- **Append-only op log with idempotency ids; undo is a compensating restore.** The log and checkpoint are the truth; `view.json` on the server is a sync peer. A push from the agent is the same action with the same id rules, so it is never re-applied after a reload (the earlier "force flag re-applied on every reload" bug).
- **Views derived from state.** Parts reconcile the scene in effects (`ctx.sync`), including at creation, so the scene cannot desync from the sidebar, and a layer that loads after a restore comes up in the right state. Tested in `tests/sync.test.js`.
- **Data, state, code are separate with an explicit survives/resets contract.** Host (canvas, scene, camera, state, store, data cache, keymap, live channel) is never swapped. Parts swap alone. Data files are versioned by content hash. State schema changes merge new keys and migrate versions, never reset. So a swap cannot flash black (the WebGL canvas stays), cannot re-download (heavy files are keyed by hash and memoized), cannot lose the view.
- **Cleanup tied to part lifetime.** Everything a part adds (objects, effects, keys, frame hooks, commands, Svelte mounts) is released when that part swaps; no stale listeners double-firing after the third republish.
- **Ephemeral `_` keys are never persisted**, so a derived value never becomes a stale saved value that fights fresh data.
- **Hot-swap of parts only; the host changes only when the kit itself changes** (then the page reloads once, flushing state first). Updating an app never reloads.
- **No same-origin, no storage.** Published pages are sandboxed (`sandbox allow-scripts`, opaque origin) so a page cannot read the chat app's cookies. That is why state rides in `window.name` + `view.json` and why there is no service worker (the earlier `ulm_web_deploy/site/sw.js` cache-first trick is impossible here).

## 5. Pitfalls (summary; details and fixes in [docs/PITFALLS.md](docs/PITFALLS.md))
Never touch a mesh from a handler (desync). Never reload to update (republish `--into`). Read the camera null case. Data snapshot does not follow `live/`: republish. Opaque means `transparent:false, depthWrite:true`. EM needs contrast controls and an honest "inferred vs labeled" legend. No external fetches. Do not mint a new URL or host. 3D, not python plots; real shapes, not dots. Full reload re-downloads big files (2-4 s each), no fix inside the sandbox.

## 6. Conventions

- **Always axes, scale bar and units (built in):** every spatial view shows XYZ axes, a bbox with tick labels in µm, a scale bar and the orientation gizmo by default (3.10). Do not turn it off for a spatial app, do not draw your own copy; declare `units`/`unitScale` only if your scene is not in µm; pass `pixelSize` to every 2D image. Put `x axes` in the panel help line.
- **Naming:** app dir `apps/<topic>`; `state.js` `name` is the persistence key (`<topic>-<thing>`, never change it); parts `NN-name.js` in layers of tens: `10-` scene objects, `20-`..`70-` layers/data, `80-tools` gestures and keys, `90-panel` sidebar. Commands and keys are verbs (`grow path undo clear isolate`). Never name anything a bare first name or generic word.
- **Declare data in `quicklook.json`** (`dir` may use `~`; mark non-essential files `optional`). Name files by content (`vessels.json`, `cells.json`), keep one concern per file so one change swaps one layer. Large arrays as base64 quantized `Uint16`/`Uint32` inside JSON (or `data.buffer` for raw), not nested number lists; the microns `vessels.json` is the model.
- **Keybinds (house set):** `g` grow selection, `u` undo, `c` clear, `h` hide the context layer (the translucent whole), `m` measure, `p` path between the last two picks, `f` fly to selection, `i` isolate (fade everything else). Click select, shift-click add/remove, drag rotate, right-drag pan. Every key has a button with `hint="g"` in the panel and the same function behind both (`ctx.command`).
- **Help one-liner** at the bottom of the panel, `color:#888`: `click = select · shift-click = add · g grow · u undo · x axes · drag rotate · right-drag pan`. Selection info (diameter, length, id) on a `#7fb0ff` line at the top, from a `_` key.
- **Dataset header ("what am I looking at"):** the Panel title states object, scale and units (`MICrONS vessels · 770 µm cube`); first line of the panel or a header block gives source, n objects, coordinates/units, date of data. The owner asks "what are the dark strands" and "is that real"; the page should answer without him asking.
- **Honest legends:** every colour class says whether it is labeled by a source or inferred by us, and how (`pale = inferred from the nearer labelled side, <=300 µm`). Inferred layers default off and use paler hues. Show counts. If a class covers 38% of branches say 38%. Do not claim a segmentation or label you derived.
- **Taste:** classy and plain: near-black `#0e0e0e` stage, monospace, 12 px, muted/pastel status colours (`#f2c14e #4db3ff #6fdc8c #ff5fa2 #b58cff #ff9f43 #ff5555` were the cell-type set), one accent `#7fb0ff`, selection in a saturated blue/yellow against a translucent grey context. No unasked chrome (no logos, banners, animations, gradients). Physically plausible motion: one easing per gesture, camera fly cancels on user input. Short labels, units in labels (`µm`).
- **Show real shape and scale:** meshes, true diameters, measure in µm; not dots, not bars when the object is a vessel. Provide direct links out (Neuroglancer link for a cell) when a primary viewer exists.
- **Reply to the owner** with the URL on its own line, what to click (3 bullets max), and what is inferred vs measured. Do not paste the build story.
