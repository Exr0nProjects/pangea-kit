# pangea-kit RECIPE

Three things: a tested minimal app to copy, the verify-before-reporting checklist, and the one-shot prompt template. Read [../GUIDE.md](../GUIDE.md) first for the API.

## 1. Minimal app (copied, built, published and driven in real Chrome on 2026-11-06 [ran])

Five clickable bars: select, shift-add, `h` hide, `u` undo, `c` clear, opacity slider, panel with help line. Copy into `apps/<yourapp>/` (four files):

`state.js`
```js
export default {
  name: 'min-bars',
  version: 1,
  initial: { camera: null, bars: { opacity: 0.9, visible: true }, sel: { ids: [], picks: [] }, _info: '' },
  migrations: {},
  setup(store, { selection }) { store.component('sel', selection()) },
}
```
`parts/10-bars.js`
```js
// Scene: five bars. Everything visible is derived from state through ctx.sync; clicks only dispatch.
export default function bars(ctx) {
  const { THREE, state, viewer } = ctx
  const meshes = [0, 1, 2, 3, 4].map((i) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(40, 40 + i * 30, 40), new THREE.MeshStandardMaterial({ color: 0x7fb0ff, transparent: true }))
    m.position.set((i - 2) * 70, (40 + i * 30) / 2, 0); m.userData.id = i
    return ctx.add(m)
  })
  for (const m of meshes) {
    ctx.sync(m, { visible: () => state.bars.visible })
    ctx.sync(m.material, {
      opacity: () => state.bars.opacity,
      emissive: () => new THREE.Color(state.sel.ids.includes(m.userData.id) ? 0x224488 : 0x000000),
    })
  }
  ctx.onClick((e) => {
    const hit = viewer.raycast(e, meshes)
    if (!hit) return false
    const id = hit.object.userData.id
    const ids = e.shiftKey ? [...new Set([...state.sel.ids, id])] : [id]
    ctx.dispatch('sel/set', { ids }, { undoable: true })
    ctx.dispatch('set', { path: '_info', value: `bar ${id}: height ${40 + id * 30} um` })
    return true
  })
  ctx.bindKeys({
    h: () => ctx.dispatch('set', { path: 'bars.visible', value: !state.bars.visible }),
    u: () => ctx.store.undo(),
    c: () => ctx.dispatch('sel/clear', {}, { undoable: true }),
  })
}
```
`parts/90-panel.js`
```js
import Panel from './Panel.svelte'
export default (ctx) => { ctx.mount(Panel, { state: ctx.state }) }
```
`parts/Panel.svelte`
```svelte
<script>
  import { Panel, Slider, Toggle } from 'pangea-kit/ui'
  let { state } = $props()
</script>
<Panel title="five bars: height in um">
  <div style="color:#7fb0ff">{state._info || 'click a bar'} · selected {state.sel.ids.length}</div>
  <Slider label="opacity" bind:value={state.bars.opacity} min={0.1} max={1} step={0.05} />
  <Toggle label="bars [h]" bind:checked={state.bars.visible} />
  <div style="color:#888">click select · shift add · h hide · u undo · c clear · x axes</div>
</Panel>
```
Publish and iterate:
```
export PATH=<node-bin>:$PATH; cd $KIT
node bin/pangea-kit.mjs publish apps/<yourapp>                 # prints the ULID + URL
# edit parts/Panel.svelte, then:
node bin/pangea-kit.mjs publish apps/<yourapp> --into <ULID>   # changed: ["parts/90-panel.js"], unchanged: 3 [ran]
node bin/pangea-kit.mjs push <ULID> '{"bars":{"opacity":0.3}}' # scene opacity 0.3 on all five bars, camera untouched [ran]
```
Any element a part mounts is clickable by default (`partContext` opts in; PITFALLS 29), and the boot gate fails a build whose control falls through to the canvas.

Real app additions, in order: data in `quicklook.json` + `ctx.layer` / `data.memo`; `80-tools.js` gestures (copy `apps/microns/parts/80-tools.js`); legend with inferred-vs-labeled; dataset header.

## 2. Verify before reporting (adapted from `<private-path>`; each step was run for the example above)

The note's lesson: green tests miss transitions (reload, retry, race). Test the transitions in the real browser.

Setup: `cdp job claim NAME --url https://viewer.example.invalid/view/<ULID>/`, `--job NAME` on every verb, `job release NAME --close` at the end (one job, one tab). Run JS with `cdp --job NAME eval '...'`. `__pangea.kit` is the live kit in the page: `__pangea.kit.state`, `.store.log`, `.viewer`.

1. **Loads clean.** `eval 'JSON.stringify({parts:[...document.querySelectorAll("[data-part]")].map(e=>e.dataset.part), canvas:!!document.querySelector("canvas"), chip:document.getElementById("qk-chip").innerText})'`. Expect every part name, `canvas:true`, chip exactly `● live` (any red line in the chip is an error with its first stack lines; the host also routes `error` and `unhandledrejection` there). Also check the data actually arrived: `Object.keys(__pangea.kit.data.versions)`.
2. **Screenshot and pixel stats.** `cdp --job NAME screenshot <targetId> /abs/out.png`, view it, then `uv run --with pillow python` to count pixels that differ from the background `#0e0e0e` (example scene: 1.9% non-background, 511 colours). A blank scene is `0.0%`. Embed the image in the reply. Do the same after turning the main layer off and on; the fraction must move.
3. **Click select works.** Project a known object to screen coordinates (`obj.getWorldPosition(...).project(__pangea.kit.viewer.camera)`, then `(x+1)/2*width`, `(1-y)/2*height` with `viewer.el.getBoundingClientRect()`), `cdp --job NAME click <targetId> X Y` (a real pointer event), then read `__pangea.kit.state.sel.ids` and the info line. Also click empty space: selection must not change unexpectedly.
4. **A control changes the scene (state to scene).** Change the state through a push (`pangea-kit push`) or a dispatch and read the scene object (`mesh.material.opacity`, `mesh.visible`), not the state. Press each documented key with `cdp --job NAME keys <targetId> h` and read the scene.
5. **Reload restores state, and the scene matches the state.** `cdp --job NAME reload <targetId>`, wait about 4 s, then compare `state.*` against the scene objects (selected object's `emissive`, `opacity`, `visible`) and `state.camera` non-null. A checkbox and a mesh that disagree is the exact bug the owner reported twice.
6. **Hot swap fetches only the changed file, and nothing resets.** Before: `eval 'globalThis.__c=document.querySelector("canvas"); performance.clearResourceTimings()'`. Edit one part, `publish --into`, wait 2-3 s. After: `performance.getEntriesByType("resource").map(r=>r.name)` must list only that part (`parts/90-panel.js?v=<hash>`), `document.querySelector("canvas")===__c`, selection and camera unchanged. Repeat for a data file: only that file is fetched and only its layer rebuilds.
7. **Push does not clobber.** After the user-like change (click), push an unrelated key; selection and camera stay. Reload; the earlier push is not re-applied over the newer user change.
8. **Cold start.** Open the URL in a fresh job tab (no `window.name`): state comes from `view.json` or `initial`, no abort message in the chip.
9. **Axes, scale bar and meaning.** Axes and scale bar are visible by default (the host draws them, press `x` to toggle: `__pangea.kit.state.axes` flips, `[...document.querySelectorAll('#qk-axes .l')]` has the tick labels, `__pangea.kit.viewer.axes.info()` gives extent, ticks and scale bar) and the numbers are right: verify the scale bar against a known distance (project two points 100 µm apart at the orbit target, `viewer.controls.target` plus the camera right vector, and compare the pixel distance to the bar's `data-px`), and the bbox tick labels against the data's known extent (the 770 µm box reads `770` at the end of X and Y; `axes.info().extent`). Reload keeps the toggle. 2D images: `<ImagePlane pixelSize=...>` shows the µm bar and extents. Units in the labels; a distance you can check by hand (two points at known spacing give the right number); legend states labeled vs inferred; numbers in the info line match the data file.
10. **Clean up.** `cdp job release NAME --close`; remove throwaway artifacts (`rm -rf <private-path>`); `npm test` if you touched the kit; commit your own paths only.

Report: the URL on its own line, three bullets of what to click, what is inferred vs measured, the screenshot, and any step you could not run. Do not claim a step you did not run.

## 3. One-shot prompt template (what to tell the agent)

```
Build a pangea-kit app: apps/<name>, published to quicklook (use `--into <ULID>` if this extends an existing viewer; no new host or URL).
1. Read tools/pangea-kit/SKILL.md first (templates, rules, pitfalls); GUIDE.md only for API details it does not cover.
2. Goal in one sentence: <what the owner wants to see/do and what decision it supports>. Data: <paths, units, scale, which are labeled vs inferred>.
3. State first: write state.js (every control and scene property is a key; camera null; _ keys for derived text). Scene only via ctx.sync/ctx.effect from state; handlers only dispatch absolute actions.
4. 3D and real shape (meshes, true diameters), translucent context layer plus an opaque highlighted selection; selection tools g u c h m p f i with buttons and one command each; measure in <unit>.
5. Panel: title = object + scale + units; dataset line (source, counts, date); honest legend (inferred pale and off by default); help one-liner; classy plain, monospace, no extra chrome.
6. Heavy data in quicklook.json, one file per concern, quantized; derive geometry in data.memo.
7. No python plots, no external fetches, no new hostname. Commit only your paths (git commit -m ... -- paths).
8. Verify in real Chrome with cdp using the checklist in docs/RECIPE.md section 2; include the screenshot and pixel stats; release the tab; delete throwaway artifacts.
9. Reply short: URL, what to click (3 bullets), what is inferred, what you could not verify. No build story.
10. If anything in the kit blocks you (a bug, missing helper), fix it in the kit with a test, not around it.
```
