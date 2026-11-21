// What a changed manifest means for a running page. Files of an artifact:
//   index.html        the host (kit runtime): changing it is the one thing that needs a reload
//   parts/<name>.js   one swappable part each (a layer, the panel, the interaction tools)
//   state.js          the state schema: version, initial, migrations (new keys merge in, nothing resets)
//   everything else   data files: reloaded one by one by the data layer, shown by whichever part watches
export const isPart = (n) => /^parts\/[^/]+\.js$/u.test(n)
export const partName = (n) => n.slice('parts/'.length, -'.js'.length)

export function planChange(prev, next) {
  const changed = (n) => prev[n] !== next[n]
  const names = new Set([...Object.keys(prev), ...Object.keys(next)])
  const plan = { reload: false, schema: false, parts: [], removedParts: [], data: [] }
  for (const n of [...names].sort()) {
    if (!changed(n)) continue
    if (n === 'index.html') plan.reload = true
    else if (n === 'state.js') plan.schema = true
    else if (isPart(n)) (n in next ? plan.parts : plan.removedParts).push(n)
    else plan.data.push(n)
  }
  return plan
}

/**
 * Mount every part without letting any part wait on another part's data. All part scripts are fetched at once
 * (load(file) starts for every file before anything is awaited); part i is mounted as soon as its own script AND
 * the scripts of parts 0..i-1 are in, so part contexts (their DOM order, their keymap rank) are still created in
 * file order, but a part never waits for an earlier part's mount promise (its data). A slow vessels.json no longer
 * holds back the panel. mount(name, factory, rank) must create the part's context synchronously and return the
 * factory's promise; a failed load or mount goes to fail(name, error). Resolves when every part has settled.
 */
export async function mountParts(files, { load, mount, fail }) {
  const fetched = files.map((file) => Promise.resolve().then(() => load(file)).then((factory) => ({ factory }), (error) => ({ error })))
  const running = []
  for (let i = 0; i < files.length; i++) {
    const name = partName(files[i])
    const r = await fetched[i] // scripts only: small, already in flight in parallel
    if (r.error) { fail(name, r.error); continue }
    running.push(Promise.resolve().then(() => mount(name, r.factory, i)).catch((e) => fail(name, e)))
  }
  await Promise.all(running)
}
