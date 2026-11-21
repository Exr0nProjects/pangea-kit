// A scene part: builds its objects once, then LETS THE STATE drive them (ctx.sync), including on first run
// and after a swap, so the scene and the panel can never disagree.
export default function cube(ctx) {
  const { THREE, state, viewer } = ctx
  const mesh = ctx.add(new THREE.Mesh(new THREE.BoxGeometry(200, 200, 200), new THREE.MeshStandardMaterial({ color: 0x3b82f6, transparent: true })))
  ctx.sync(mesh, { visible: () => state.cube.visible, 'material.opacity': () => state.cube.opacity })
  // click selects (absolute action), shift adds
  ctx.onClick((e) => {
    const hit = viewer.raycast(e, [mesh])
    if (!hit) return
    ctx.dispatch('sel/set', { ids: e.shiftKey ? [...state.sel.ids, 1] : [1], picks: [1] }, { undoable: true })
    state._info = `selected cube at ${hit.point.toArray().map((v) => v.toFixed(0)).join(', ')}`
  })
  ctx.sync(mesh.material, { emissive: () => new THREE.Color(state.sel.ids.includes(1) ? 0x112244 : 0x000000) })
  ctx.bindKeys({ h: () => ctx.dispatch('set', { path: 'cube.visible', value: !state.cube.visible }), u: () => ctx.store.undo() })
}
