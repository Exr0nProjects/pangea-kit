# pangea-kit: SKILL (the one landing file)

Load this one file, write the app, publish, verify. It holds the workflow, the templates, the numbered RULES and the numbered PITFALLS. Do not read other kit documents or apps unless a section says to (an older pitfall list was folded in here on 2026-11-21). Everything below was run against a live kit on 2026-11-21. KIT = the root of your kit checkout (apps live in `$KIT/apps/<app-name>/`; see section 9).

**How to add a rule or pitfall** (iterate on this file, one line each; reflow instead of appending near-duplicates). When the owner corrects an applet or a build breaks: (1) add a row to RULES (a correction about what an applet should do) or PITFALLS (a way the kit or a build broke); next free id, never renumber, ids are cited from code and chats; (2) columns: `id | date (YYYY-MM-DD, PST) | source quote (his words, short, or the failing message) | fix (imperative, one sentence) | checked by` where checked-by is one of `gate` (publish/boot gate refuses), `lint` (lint/ rules), `test` (vitest), `none`; (3) prefer upgrading `none` to a gate/test: a rule that recurs twice with `none` is a missing check, fix it in the kit with a test (R3) and change the column; (4) if the rule changes a template, edit the template in the same commit; (5) after committing, push the change to the repo with `scripts/sync-repo.sh` (section 9); (6) run the cold test when a template changes: generate a fresh applet (for example a damped oscillator whose damping slider shows only in damped mode) from this file alone and verify it per section 5; the count of extra docs opened must be 0.

## 0. What you get for free

State that survives reload with no flash; hot-swap (republish `--into` and the open page updates without reload or lost state); light/dark theme; one publish URL `https://<viewer-host>/view/<ULID>/`; the host's axes and scale bar for 3D. You write four small files. If a feature wants `localStorage`, `fetch`, a second copy of a value or a storage `$effect`, add a key to `state.js` instead.

## 1. Decision tree

1. Spatial model people orbit, select, measure in physical units? 3D (section 3). Else 2D (section 2, the default: explainers, calculators, plots, sliders, animations, projected Bloch spheres).
2. Teaching a mechanism? Give a step selector (buttons) where each step sets the whole state (mode, view, parameter defaults, `runId`) through one function and has a one-paragraph caption, and a toggle for each thing the text tells the user to do (R8).
3. List each control and the modes/steps where it changes the picture BEFORE writing the component (R6). Decide which quantities are integrated (clock, angle, trail) and which are pure functions of controls (R7).
4. New tool = new ULID; changing an existing tool = `--into` its ULID (R4). Publish with `--scratch` when the kit tree has others' uncommitted work (section 4).

## 2. 2D applet files (copy, rename `name`, change the drawing)

Directory `KIT/apps/<app-name>/` (kebab-case, unique). `quicklook.json` (a tab title; never ship a tab called "quicklook"):
```json
{ "title": "Phasor: free and driven", "axes": false }
```
`state.js` (the ONLY place state is declared; every key the UI reads must exist in `initial`):
```js
export default {
  name: 'phasor-demo',        // persistence key qk:<name>; renaming loses saved state
  version: 1,                 // bump and add migrations: { 2: (s) => ({ ...s, x: s.old }) } when a key changes meaning
  initial: { camera: null, mode: 'free', speed: 2, drive: 1, runId: 0 },
  migrations: {},
  setup() {},
}
```
Added keys appear with their default and nothing else resets. Keys starting `_` are transient (never saved or logged): hover text, derived readouts. `camera: null` is harmless in 2D.

`parts/90-ui.js` (parts mount in filename order):
```js
import App from './App.svelte'
export default (ctx) => { ctx.mount(App, { state: ctx.state }) }
```
`parts/App.svelte` (a complete working 2D applet: a phasor with a "driven" mode that owns an extra control):
```svelte
<script>
  import { Panel, Slider, Button } from 'pangea-kit/ui'
  let { state: st } = $props()          // never name the prop `state` (P30)
  const TAU = Math.PI * 2
  // Non-reactive locals: the clock and the simulated quantities. NOT $state, NOT in `st` (R7).
  let cv, phase = 0, t = 0, seenRun = -1, trail = []
  let readout = $state('')              // $state only for text the template prints
  const cc = (n) => getComputedStyle(document.documentElement).getPropertyValue('--qk-' + n).trim() || '#888'
  const setMode = (m) => { st.mode = m; st.runId += 1 }   // a mode change is a deliberate restart; a slider never is

  $effect(() => {                        // reads NO state synchronously => runs once; the loop never restarts
    const g = cv.getContext('2d'); let raf, last = performance.now()
    const frame = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now
      if (st.runId !== seenRun) { seenRun = st.runId; phase = 0; t = 0; trail = [] }   // the ONLY reset
      const w = st.speed + (st.mode === 'driven' ? st.drive : 0)   // read parameters HERE (untracked); a hidden control cannot affect the picture (R6)
      phase += w * dt; t += dt                                      // integrate; never phase = w * t
      const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight
      if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr) }
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.fillStyle = cc('canvas-bg'); g.fillRect(0, 0, W, H)
      const cx = W / 2 + 80, cy = H / 2, R = Math.min(W - 400, H) * 0.35
      g.strokeStyle = cc('canvas-line'); g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke()
      const x = cx + R * Math.cos(phase), y = cy - R * Math.sin(phase)
      trail.push([x, y]); if (trail.length > 200) trail.shift()
      g.strokeStyle = cc('plot-line'); g.lineWidth = 2; g.beginPath(); trail.forEach(([a, b], i) => (i ? g.lineTo(a, b) : g.moveTo(a, b))); g.stroke()
      g.fillStyle = cc('plot-hot'); g.beginPath(); g.arc(x, y, 6, 0, TAU); g.fill()
      readout = `t = ${t.toFixed(1)} s · angular speed ${w.toFixed(2)} rad/s · ${st.mode}`   // visible clock = the verification hook
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  })
</script>

<canvas bind:this={cv} style="position:absolute;inset:0;width:100%;height:100%;display:block"></canvas>
<Panel title="phasor: speed and drive">
  <div>
    <Button label="free" active={st.mode === 'free'} onclick={() => setMode('free')} />
    <Button label="driven" active={st.mode === 'driven'} onclick={() => setMode('driven')} />
    <Button label="restart" onclick={() => (st.runId += 1)} />
  </div>
  <Slider label="speed" bind:value={st.speed} min={0} max={6} step={0.05} />
  {#if st.mode === 'driven'}                 <!-- only where it has an effect (R6) -->
    <Slider label="drive" bind:value={st.drive} min={-3} max={3} step={0.05} />
  {/if}
  <div style="color:var(--qk-mute)">{readout}</div>
</Panel>
```
Kit UI: `import { Panel, Slider, Toggle, Button, Legend, ScaleBar, ImagePlane, FramePlayer, RangeHistogram } from 'pangea-kit/ui'` (themed, click-ready). `Panel {title, pos:'left'|'right', open}` (318 px wide, collapsible, scrolls; its header is a `<button>`); `Slider {label, value (bind), min, max, step, fmt}`; `Toggle {label, checked (bind), color, note}`; `Button {label, hint, active, disabled, onclick}`; `Legend {items:[{id,label,color,count,on}], ontoggle}`. `bind:value={st.x}` writes the state tree and is saved (same-path writes within 500 ms collapse into one log entry, so a drag is one entry). Math: draw it or say it in words; no KaTeX or external fonts (P12).

Theme variables that exist (a typo such as `--qk-text` or `--qk-panel-bg` silently renders nothing): `--qk-bg --qk-fg --qk-panel --qk-panel-line --qk-head --qk-ctl --qk-ctlb --qk-accent --qk-active-bg --qk-active-b --qk-mute --qk-label --qk-faint --qk-line --qk-raised --qk-warn --qk-danger --qk-ok --qk-err --qk-canvas-bg --qk-canvas-line --qk-canvas-grid --qk-canvas-text --qk-canvas-title --qk-plot-hot --qk-plot-line --qk-plot-ref --qk-plot-mark`. Canvas code reads them with `getComputedStyle(document.documentElement).getPropertyValue(...)`; never hard-code `#0e0e0e`/`#ddd`. Semantic colours you choose (a red field arrow) may be fixed hex if readable on both schemes.

### The live-drag pattern in one place (R7)
Control handlers write `st.<key>` and nothing else. Clock, angle, position, velocity and trail are plain `let` locals advanced by `dt` from the current parameters inside the frame callback (`phase += w * dt`, `v += a * h; x += v * h`), never recomputed from time zero with a parameter that can change (`phase = w * t` jumps when `w` changes). The `$effect` body reads no state synchronously (else it re-runs on every change and restarts the loop and its locals). Pure functions of controls (a curve, a spectrum, a diagram) are recomputed from `st` each frame. Only `st.runId` (restart button, mode or step change, or load) resets the locals. Print `t = x.x s` in the panel.

### Controls only where they apply (R6) and instructions have controls (R8)
Gate each control, readout, legend row and drawn arrow with `{#if st.mode === ...}` or `{#if [2,3].includes(st.step)}`, or disable it with the reason beside it. The drawing reads the control through the same condition. A step function sets that step's defaults and bumps `runId`. Every sentence on screen that tells the user to do something ("stop B1 at 90 degrees", "drag detuning", "turn the field off") needs a visible control for exactly that action, in the step where the sentence appears (a `Toggle` or `Button` bound to a state key the frame reads), and the text must name the control's label.

## 3. 3D scene template (only for spatial models)

`state.js`: `initial: { camera: null, bars: { opacity: 0.9, visible: true }, sel: { ids: [], picks: [] }, _info: '' }`, `setup(store, { selection }) { store.component('sel', selection()) }`.

`parts/10-bars.js`:
```js
export default function bars(ctx) {
  const { THREE, state, viewer } = ctx
  const meshes = [0, 1, 2, 3, 4].map((i) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(40, 40 + i * 30, 40), new THREE.MeshStandardMaterial({ color: 0x7fb0ff, transparent: true }))
    m.position.set((i - 2) * 70, (40 + i * 30) / 2, 0); m.userData.id = i
    return ctx.add(m)                                    // removed and disposed on swap
  })
  for (const m of meshes) {
    ctx.sync(m, { visible: () => state.bars.visible })   // right after creation: derived from state now and on every change
    ctx.sync(m.material, { opacity: () => state.bars.opacity,
      emissive: () => new THREE.Color(state.sel.ids.includes(m.userData.id) ? 0x224488 : 0) })
  }
  ctx.onClick((e) => {                                   // pointer down/up within 4 px; return true to consume
    const hit = viewer.raycast(e, meshes); if (!hit) return false
    const id = hit.object.userData.id
    ctx.dispatch('sel/set', { ids: e.shiftKey ? [...new Set([...state.sel.ids, id])] : [id] }, { undoable: true })
    ctx.dispatch('set', { path: '_info', value: `bar ${id}: height ${40 + id * 30} um` })
    return true
  })
  ctx.bindKeys({ h: () => ctx.dispatch('set', { path: 'bars.visible', value: !state.bars.visible }), u: () => ctx.store.undo(), c: () => ctx.dispatch('sel/clear', {}, { undoable: true }) })
}
```
`parts/90-panel.js`: `import Panel from './Panel.svelte'; export default (ctx) => { ctx.mount(Panel, { state: ctx.state }) }`; `Panel.svelte` uses `let { state: st } = $props()` and the kit's `Panel`/`Slider`/`Toggle`. API: `ctx.add(obj)`, `ctx.sync(obj, {path: () => stateExpr})`, `ctx.effect(fn)`, `ctx.dispatch(op, payload, {undoable})` (ops `set {path,value}`, `patch {...}`, `sel/set|include|clear`), `ctx.onClick`, `ctx.bindKeys({ g: fn, 'shift+g': fn, 'mod+z': fn })`, `ctx.onFrame(fn)`, `ctx.layer(file, fn)`, `ctx.data.json|buffer|memo`, `ctx.mount(Comp, props)`, `ctx.cleanup(fn)`, `viewer.raycast`, `viewer.fit(box3)`. Own reducers need `Object.assign(fn, { touch: (payload) => [paths] })` (P15). Opacity at max must become opaque (`mat.transparent = opacity < 0.98; mat.depthWrite = !mat.transparent; mat.needsUpdate = true`); translucent context layer `renderOrder 1` with an opaque highlighted selection `renderOrder 0`; real shapes with true sizes and units in the panel; selectable (click, shift-add), clearable, hideable; centre data near the origin or `viewer.fit` after first load (camera starts about 1500 units out); the host draws axes and the scale bar (units via `"units"`/`"unitScale"` in `quicklook.json`). Heavy data: one file per concern in `quicklook.json` `{"data":{"dir":"~/path","files":["a.json"]}}`, quantized, derived once with `ctx.data.memo`. Multi-layer viewer with selection tools: see lessons/08-viewers.md.

## 4. Publish (exact commands)

```
# Node 22+ on PATH
cd $KIT
node bin/pangea-kit.mjs publish apps/<app> --scratch                 # first time: prints {"ulid","url",...}
node bin/pangea-kit.mjs publish apps/<app> --scratch --into <ULID>   # same URL; the open page hot-swaps only what changed
node bin/pangea-kit.mjs push <ULID> '{"speed":3}'                    # change a live page's state; a bare object patches only its leaves
```
Plain `publish` refuses unless the app dir AND the whole kit tree are committed ("publish refused: kit ... has N uncommitted change(s)"); other agents usually have uncommitted kit work, so use `--scratch` (same URL form). Commit only your app by pathspec from the repo root (`git add apps/<app> && git commit -m "..." -- apps/<app>`); never `git add -A`, never `git checkout <rev> -- <path>`. Update by republishing `--into`; never ask the owner to reload. Retire a test artifact with `rm -rf <artifact-store>/<ULID>`. `npm test` (vitest, never bare `node --test`) only if you touched the kit. Publish scope-checks every part and fails with `undefined identifier <name> at parts/<file>:<line>` or `dead-control ...`: fix and republish.

## 5. Verify before reporting (real Chrome driven over the DevTools protocol; a green build is not enough; `cdp` below stands for any wrapper with job claim/activate/eval/tap/keys/screenshot/reload/release, or use `harness/check-live.mjs` for checks C1-C4)

`U=https://<viewer-host>/view/<ULID>/`; `job claim` prints `targetId` (call it `T`); one named job tab, released at the end.
```
cdp job claim chk --url $U                       # prints targetId
cdp --job chk activate $T                        # a background tab pauses requestAnimationFrame; activate before screenshots
sleep 5
cdp --job chk eval 'JSON.stringify({chip:document.getElementById("qk-chip")?.innerText, canvas:!!document.querySelector("canvas"), btns:[...document.querySelectorAll("button")].map(b=>b.textContent), ranges:document.querySelectorAll("input[type=range]").length})'
```
1. **Loads clean:** chip is exactly `● live`; a `part 90-ui: Error ...` line is a crash (`store_invalid_shape` = a prop named `state`, P30). Counts are not zero.
2. **Real click:** `cdp --job chk tap $T 'button' --index N` (hit-tested real mouse events; exit 7 means something covers it, the dead-control bug). `--index` counts the Panel header button as 0 and `--text` is a substring match ("damped" also matches "undamped"), so list the button texts first (above) and pick the index. Then `eval '__pangea.kit.state.mode'` shows the new value. `el.click()` in eval proves nothing.
3. **Applicability:** after the click the range count and button list change exactly as designed (R6).
4. **Live drag does not reset (R7):** `clk(){ cdp --job chk eval 'document.body.innerText.match(/t = [0-9.]+/)[0]' | tail -1; }`; read `clk`; `cdp --job chk tap $T 'input[type=range]' --index K`; then `cdp --job chk keys $T ArrowRight` five times; read `clk` again: it must be larger. Read `__pangea.kit.state.<key>` to see the change landed.
5. **Instructions have controls (R8):** read `document.body.innerText` for each step and confirm every "do X" sentence has a button/slider/toggle whose label names X.
6. **Screenshot and pixels:** `cdp --job chk screenshot $T /tmp/x.png`; `uv run --with pillow python -W ignore -c "from PIL import Image; im=Image.open('/tmp/x.png').convert('RGB'); px=list(im.getdata()); bg=px[0]; print(round(100*sum(p!=bg for p in px)/len(px),1),'% non-bg')"` (blank = 0.0 %). Embed the image; say pixels were counted, not looked at, unless you inspected it.
7. **Reload restores:** `cdp --job chk reload $T; sleep 5`; the mode and slider you changed are still set, chip `● live`.
8. **Clean up:** `cdp job release chk --close`; delete throwaway ULIDs and probe app dirs; commit your app by pathspec. The debug Chrome viewport can be small (about 730 x 410); the panel scrolls inside itself.
Do not claim a step you did not run.

## 6. Report to the owner

URL on its own line; three bullets of what to click or drag; what is a toy number or unsourced; the screenshot; any step not run. No build story. Short, plain, answer first.

## 7. RULES (what an applet must do; each from a correction; ids are stable)

| id | date | source | rule and fix | checked by |
| --- | --- | --- | --- | --- |
| R1 | 2026-11-19 | owner 15:31 PST: "use the pangea kit" | Interactive explainers, calculators and viewers are kit apps published at one `/view/<ULID>/`, never raw HTML or a new host. | none |
| R2 | 2026-11-07 | owner 16:53 PST: "it should be easier not harder to use than native js" | If a kit app needs more than this file to write, the gap is a kit or doc bug: fix this file or the kit, then re-run the cold test. | none |
| R3 | 2026-11-09 | owner's standing instructions, the owner: fix Pangea-built apps "in the kit, not the app" | A bug or missing behaviour in any kit app is fixed in the kit with a kit test; the app keeps only what is app-specific. | test (per fix) |
| R4 | 2026-11-06 | the owner: "why did u make a whole new url bruh lol . overbulit." | One URL form `/view/<ULID>/`; same tool = `--into` its ULID; new tool = new ULID; no hostname, tunnel or LaunchAgent. | none |
| R5 | 2026-11-06 | the owner: "your responses are generally way too long" | Report = URL, three bullets of what to click, what is inferred, screenshot, what was not run. No build story. | none |
| R6 | 2026-11-21 | owner 13:01 PST: "you shouldn't show detuning on something that it doesn't apply to ... that just confused me" | Every control, readout, legend row and drawn arrow is visible only in the modes/steps where it changes the picture (`{#if}`), or disabled with the reason beside it; the drawing reads a control through the same condition; a step sets its own defaults. | none |
| R7 | 2026-11-21 | owner 13:01 PST: "live dragging the sliders made the app glitch-reset, whereas it should have just derived from that setting ... so i can see changes in real time as i drag" | Controls write `st.*` only; clock, integrated state and trail are non-reactive locals advanced by `dt` from current parameters in the frame callback; the `$effect` reads no state synchronously; only `runId` (restart, mode or step change) resets; print `t =` and check it keeps rising after a drag. | none |
| R8 | 2026-11-21 | owner 13:04 PST (B1 step): any instruction in on-screen text must have a visible control for it | If the caption says "stop B1 at 90 degrees" or "drag detuning", that step has a toggle or slider labelled with that action, bound to a state key the frame reads. | none |
| R9 | 2026-11-06 | the owner: "after reload my checkboxes were correct but the viewer still showed stuff that was unchecked" | The picture is derived from state (canvas frame, `$derived`, `ctx.sync`); handlers dispatch absolute values and never set a mesh or canvas property. | test (tests/sync.test.js) |
| R10 | 2026-11-18 | owner 16:56 PST standing ask (theme host): kit apps follow system light/dark | Colours come from `--qk-*` variables (list in section 2); semantic colours must read on both schemes. | none |
| R11 | 2026-11-18 | owner's standing instructions: render every generated artifact and look at it before saying done | Screenshot after each state change you claim works; pixels counted is not looked at, say which. | none |
| R12 | 2026-11-06 | volumetric viewer request, paraphrased (no verbatim kept) | 3D means meshes with true sizes, selectable, measurable, units in the panel; not matplotlib images or point clouds. | none |
| R13 | 2026-11-07 | owner's standing instructions (voice, equations) | Page text: no em dashes, no emoji, plain; every symbol defined at first use with units; "toy" or "unverified" next to unsourced numbers. | none |
| R14 | 2026-11-06 | viewer reload/flash complaint (P1), no verbatim quote kept | Update with `publish --into`; never ask the owner to reload; never push a whole-state blob (patch only the leaves you mean). | test (hot-swap, push ids) |
| R15 | 2026-11-06 | owner's standing instructions (shared checkout) | Commit only your app by pathspec; the kit tree has other agents' uncommitted work; use `--scratch`, never `git add -A`. | none |
| R16 | 2026-11-08 | owner 06:54 PST: "build the checks in structurally where possible" | A recurring `none` becomes a gate or test in the kit and this column is updated the same commit. | none |

## 8. PITFALLS (how the kit or a build broke; ids P1..P30 keep the old docs/PITFALLS.md numbering)

| id | date | what broke (quote or message) | fix | checked by |
| --- | --- | --- | --- | --- |
| P1 | 2026-11-06 | viewer "keeps reloading, flashes black, deletes his view" | Parts hot-swap, pushes carry ids and are never re-applied, `camera: null` allowed; update with `--into`, push only leaves. | test |
| P2 | 2026-11-06 | "checkboxes were correct but the viewer still showed stuff unchecked" | Call `ctx.sync(obj, {prop: () => state...})` right after creating an object; never set a mesh property from a handler or build it once from literals. | test |
| P3 | 2026-11-06 | one tiny change re-downloaded 47 MB | One data file per concern (each has its own hash); no big arrays in `state.js` or a part; read data only via `ctx.data.json/buffer/memo`. | none |
| P4 | 2026-11-06 | full reload re-downloads heavy files, 2-4 s each | Sandbox has no storage or service worker; keep data lean (quantized), never promise instant reloads, no new host without the owner's yes. | none |
| P5 | 2026-11-06 | translucent grey never reached opaque | `mat.transparent = opacity < 0.98; mat.depthWrite = !mat.transparent; mat.needsUpdate = true`; context `renderOrder 1`, selection `0` opaque. | none |
| P6 | 2026-11-06 | EM slices "illegible mud" | Brightness, contrast, gamma, invert sliders from the start via one LUT effect, default contrast above 1; per-axis slice slider; say where data does not exist. | none |
| P7 | 2026-11-06 | page showed an old data snapshot after `live/` changed | `quicklook.json` copies data at publish: republish `--into`; label "snapshot as of <time>" if it can lag. | none |
| P8 | 2026-11-06 | first viewer got its own hostname and tunnel | Everything lives at `/view/<ULID>/`; remove probe artifacts with `rm -rf <artifact-store>/<ULID>`. | none |
| P9 | 2026-11-06 | asked for a viewer, got matplotlib images and dots | Build the 3D explorer: meshes, real diameters, selectable, units in the UI (R12). | none |
| P10 | 2026-11-06 | "give me the shit in like way fewer words" | Reply = link, 3 click bullets, inferred, caveats (R5). | none |
| P11 | 2026-11-06 | a whole mesh unusable until traceable | Object-rich scenes need translucent context, highlighted selection, grow/isolate, hide, clear, measure (the selection-tools part of a layered viewer; see lessons/08-viewers.md). | none |
| P12 | 2026-11-06 | blank or failing page from an external resource | The page is sandboxed: CSP allows no external scripts, fonts, images, tiles, iframes or fetch (`connect-src` is the artifact itself); `fetch('data:')` fails; bake everything into the part or a data file; Cloudflare beacon and speculation-rules console errors are noise. | none (browser enforces) |
| P13 | 2026-11-06 | `bind:value` on a missing key does nothing | Declare every key in `initial` (nested too) before binding a `Slider`/`Toggle` to it. | none |
| P14 | 2026-11-06 | `ctx.sync` left an object unchanged | `sync` skips `undefined` and assigns only on change; return a value for every state. | test |
| P15 | 2026-11-06 | undo did nothing for a custom action | Register reducers with `Object.assign(fn, { touch: (payload) => [paths] })`; an all-`_` write is transient. | none |
| P16 | 2026-11-06 | log and persist churn | Never `dispatch` per frame or per pointermove; per-frame values live in locals, hover text in a `_` key. | none |
| P17 | 2026-11-06 | a decoded volume vanished on part swap | Plain `let` in a part dies on swap: keep heavy results in `ctx.data.memo`, user choices in state; module-level singletons are bundled per part so never share through module scope. | none |
| P18 | 2026-11-06 | panel appeared last | Parts mount in filename order and `await`; keep the panel part light or at a low number. | none |
| P19 | 2026-11-06 | `setup()` re-ran on swap | No side effects in `setup`; `store.component` is idempotent. | none |
| P20 | 2026-11-06 | saved state aborted or orphaned | Never rename `name`; add keys, bump `version` with an upcaster for anything else; an unloadable save shows a red chip and keeps the old bytes. | test |
| P21 | 2026-11-06 | selection vs camera drag conflict | A click is up within 4 px of down; use `ctx.onClick` (return `true` to consume), not your own canvas pointer handlers. | none |
| P22 | 2026-11-06 | black scene | Camera frames the origin at about 1500 units: recentre data or `viewer.fit(new THREE.Box3().setFromObject(obj))` after first load. | none |
| P23 | 2026-11-06 | blank scene with a clean chip | A part that throws shows a red line in the bottom-right chip; blank plus clean chip means the object is out of view or opacity 0: pixel stats. | none |
| P24 | 2026-11-06 | `pangea-kit` or `node` not found | `# Node 22+ on PATH` and `node bin/pangea-kit.mjs`; tests with `npm test`, never bare `node --test`. | none |
| P25 | 2026-11-06 | half-published artifact | Never hand-copy into the artifact dir; `publish --into` renames changed files, writes `index.html` last, then removes stale ones. | none |
| P26 | 2026-11-06 | other agents' apps dirty in the tree | Commit with an explicit pathspec only; touch no other app dir; publish with `--scratch` when the tree is dirty (section 4). | gate (plain publish refuses) |
| P27 | 2026-11-11 | two sets of axes or scale bars | The host draws axes and scale bar; mark helpers `userData.qkNoBounds = true`; units via `"units"/"unitScale"`; `"axes": false` for non-spatial apps; `cdp activate` your tab before screenshots. | none |
| P28 | 2026-11-12 | a Svelte part used `draft` outside its scope: ReferenceError only in the browser | Publish and build refuse `undefined identifier <name> at parts/<file>:<line>:<col>`; declare the name in an enclosing scope; `--allow-undef` only deliberately. | gate (lib/no-undef.mjs) |
| P29 | 2026-11-21 | "cant edit anything" in the nmr applet (buttons and sliders swallowed no clicks) | The host UI layer is `pointer-events:none`; `partContext` now sets `pointer-events:auto` on everything a part mounts and the boot gate fails a control whose centre hits the canvas; do not add your own `pointer-events:auto` per app; Cloudflare console errors are unrelated. | gate (DEAD_CONTROLS_EXPR) + test |
| P30 | 2026-11-21 | part died with `store_invalid_shape` | Do not name a Svelte prop `state` and use `$state(...)` in the same component (read as a store subscription); `let { state: st } = $props()`. | none (shows as red chip) |
| P31 | 2026-11-21 | a hidden control's stale value still moved the picture; a slider value in the reset key reset the app | See R6 and R7: read each control through the condition that shows it; never key a reset on a slider. | none |
| P32 | 2026-11-21 | `cdp tap --text damped` hit the "undamped" button; `--index 0` was the Panel header | `--text` is a substring match and the Panel header is a button: list button texts, then use `--index`. | none |

Cold test of 2026-11-21 (osc-probe): 0 extra docs opened, 2 gaps found and fixed in this file (P32, the `--index` note).

## 9. Where this file lives

This repository holds the skill, the verification harness (`harness/`), prompts (`prompts/`), small example applets (`examples/`) and generic lessons (`lessons/`). The kit runtime that the templates import (`pangea-kit/ui`, the host, the state core) is not in this repository; `$KIT` is wherever you keep it. Edit this file, keep rows one line each, and when a rule recurs with `none` in the "checked by" column add a harness check and change the column.
