// Built-in spatial furniture of every 3D view (The owner: "for 3d volumes and 2d images etc there should always be
// axes xyz and scale labels and such"). Drawn by the host with zero app code, in the DATA frame of `viewer.root`
// (an app that flips or shifts root, as microns and h01 do, still reads its own data coordinates):
//   - a bounding box of everything under root, edges muted grey; the three edges from the min corner are the
//     X (red), Y (green), Z (blue) axes with ticks, tick labels and an axis name carrying the unit
//   - tick labels are distances from the min corner, 0 .. extent in display units; the last label IS the extent
//   - a screen-space scale bar (nice 1/2/5 length, valid at the orbit-target depth) that follows zoom
//   - a corner orientation gizmo that rotates with the camera
// Labels are CSS overlay elements (crisp text, integer pixel positions, hidden rather than clipped). Toggle `x`
// (state.axes) and opt out with quicklook.json "axes": false are wired in boot.js; this file only draws.
import { niceTicks, formatNumber, formatLength, scaleBar, unitsPerPixel } from '../lib/scale.js'

const COLORS = ['#d96666', '#66c266', '#6a9be8'] // X Y Z, muted
const HEX = [0xd96666, 0x66c266, 0x6a9be8]
const NAMES = ['X', 'Y', 'Z']

export function createAxes(viewer, { container }) {
  const { THREE, scene, camera, controls, root } = viewer
  const cfg = { enabled: true, available: true, unit: 'µm', scale: 1 }
  let box = null // Box3 in root-local (data) units
  let frameNo = 0, dirty = true
  const group = new THREE.Group(); group.matrixAutoUpdate = false; group.visible = false; group.renderOrder = 4; scene.add(group)

  // ---- DOM overlay ----
  const css = document.createElement('style')
  css.textContent = `
  #qk-axes{position:absolute;inset:0;overflow:hidden;pointer-events:none;font:11px/14px ui-monospace,Menlo,monospace;color:#9a9a9a}
  #qk-axes .l{position:absolute;left:0;top:0;width:60px;height:14px;margin:-7px 0 0 -30px;text-align:center;white-space:nowrap;text-shadow:0 0 3px #000,0 0 3px #000,0 0 2px #000;display:none}
  #qk-axes .n{font-weight:600;font-size:12px}
  #qk-axes .sb{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);text-align:center;display:none}
  #qk-axes .sb .t{color:#ccc;text-shadow:0 0 3px #000,0 0 3px #000;margin-bottom:2px}
  #qk-axes .sb .b{height:6px;margin:0 auto;border:1.5px solid #ccc;border-top:none;box-sizing:border-box}
  #qk-axes .hint{position:absolute;left:50%;bottom:8px;transform:translateX(-50%);color:#777;text-shadow:0 0 3px #000}
  #qk-axes canvas{position:absolute;right:12px;bottom:30px;width:84px;height:84px;display:none}`
  const overlay = Object.assign(document.createElement('div'), { id: 'qk-axes' })
  overlay.append(css)
  const sbEl = Object.assign(document.createElement('div'), { className: 'sb' }); sbEl.dataset.qk = 'scalebar'
  const sbText = Object.assign(document.createElement('div'), { className: 't' })
  const sbBar = Object.assign(document.createElement('div'), { className: 'b' })
  sbEl.append(sbText, sbBar)
  const hint = Object.assign(document.createElement('div'), { className: 'hint', textContent: 'x axes' }); hint.dataset.qk = 'hint'
  const gizmo = document.createElement('canvas'); gizmo.dataset.qk = 'gizmo'
  overlay.append(sbEl, hint, gizmo)
  container.appendChild(overlay)
  const gctx = gizmo.getContext('2d')
  const dpr = () => Math.min(devicePixelRatio || 1, 3)

  let labels = [] // { el, p: Vector3 (root-local), kind, axis, value? }
  const mkLabel = (text, color, cls = '') => {
    const el = Object.assign(document.createElement('div'), { className: `l ${cls}`, textContent: text }); el.style.color = color
    overlay.appendChild(el); return el
  }

  const mats = [0, 1, 2, 3].map((i) => new THREE.LineBasicMaterial({ color: i ? HEX[i - 1] : 0x6b7280, transparent: true, opacity: i ? 0.85 : 0.45, depthTest: false }))
  let lines = []
  const clearLines = () => { for (const l of lines) { group.remove(l); l.geometry.dispose() } lines = [] }

  function rebuild() {
    clearLines()
    for (const l of labels) l.el.remove()
    labels = []
    if (!box || box.isEmpty()) return
    const mn = box.min, e = box.getSize(new THREE.Vector3()), ext = [e.x, e.y, e.z]
    const maxExt = Math.max(ext[0], ext[1], ext[2], 1e-9)
    const at = (a, t, o = [0, 0, 0]) => { const v = mn.clone(); v.setComponent(a, mn.getComponent(a) + t); for (let k = 0; k < 3; k++) if (o[k]) v.setComponent(k, v.getComponent(k) + o[k]); return v }
    const corner = (i) => new THREE.Vector3(i & 1 ? box.max.x : mn.x, i & 2 ? box.max.y : mn.y, i & 4 ? box.max.z : mn.z)
    // 12 edges: the three from the min corner (index 0) are axes, the rest are the grey box
    const grey = [], axis = [[], [], []]
    for (let i = 0; i < 8; i++) for (let a = 0; a < 3; a++) {
      if (i & (1 << a)) continue
      const p = corner(i), q = corner(i | (1 << a))
      if (i === 0) axis[a].push(p, q); else grey.push(p, q)
    }
    const add = (pts, m) => { if (!pts.length) return; const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mats[m]); l.renderOrder = 4; l.frustumCulled = false; group.add(l); lines.push(l) }
    add(grey, 0)
    const tickLen = maxExt * 0.02, labelOff = maxExt * 0.055
    for (let a = 0; a < 3; a++) {
      const out = (a + 1) % 3 // outward direction for this axis' ticks: the next axis, pointing away from the box
      const ticks = niceTicks(ext[a] * cfg.scale, 5)
      const pts = [...axis[a]]
      for (const v of ticks) {
        const t = v / cfg.scale
        const p = at(a, t), q = p.clone(); q.setComponent(out, q.getComponent(out) - tickLen); pts.push(p, q)
        const lp = p.clone(); lp.setComponent(out, lp.getComponent(out) - labelOff)
        labels.push({ el: mkLabel(formatNumber(v), COLORS[a]), p: lp, kind: 'tick', axis: a, value: v })
      }
      add(pts, a + 1)
      const np = at(a, ext[a] + labelOff * 0.9); np.setComponent(out, np.getComponent(out) - labelOff * 0.5)
      labels.push({ el: mkLabel(`${NAMES[a]} ${cfg.unit}`, COLORS[a], 'n'), p: np, kind: 'name', axis: a })
    }
    for (const l of labels) { l.el.dataset.qkAxis = NAMES[l.axis]; l.el.dataset.qkKind = l.kind; if (l.kind === 'tick') l.el.dataset.qkValue = String(l.value) }
  }

  const tmpBox = new THREE.Box3(), inv = new THREE.Matrix4(), m4 = new THREE.Matrix4()
  /** Union of every geometry under root, in root-local units. Objects with userData.qkNoBounds are skipped. */
  function computeBounds() {
    root.updateWorldMatrix(true, false)
    inv.copy(root.matrixWorld).invert()
    const out = new THREE.Box3()
    root.traverse((o) => {
      if (!o.geometry || o.userData?.qkNoBounds) return
      const g = o.geometry
      if (!g.boundingBox) g.computeBoundingBox()
      if (!g.boundingBox || g.boundingBox.isEmpty()) return
      m4.multiplyMatrices(inv, o.matrixWorld)
      tmpBox.copy(g.boundingBox).applyMatrix4(m4)
      if (Number.isFinite(tmpBox.min.x + tmpBox.max.x + tmpBox.min.y + tmpBox.max.y + tmpBox.min.z + tmpBox.max.z)) out.union(tmpBox)
    })
    return out
  }
  const sameBox = (a, b) => (!a && !b) || (a && b && a.min.distanceTo(b.min) < 1e-6 && a.max.distanceTo(b.max) < 1e-6)
  function refresh() {
    const nb = computeBounds()
    const next = nb.isEmpty() ? null : nb
    if (!sameBox(box, next) || dirty) { box = next; dirty = false; rebuild() }
    return box
  }

  const v = new THREE.Vector3(), dirV = new THREE.Vector3()
  let sb = null, lastSb = ''
  function project(el, p, w, h, margin = 6) {
    v.copy(p).applyMatrix4(root.matrixWorld).applyMatrix4(camera.matrixWorldInverse)
    if (v.z >= -camera.near) { el.style.display = 'none'; return false }
    v.applyMatrix4(camera.projectionMatrix)
    const x = Math.round((v.x + 1) / 2 * w), y = Math.round((1 - v.y) / 2 * h)
    if (x < margin + 30 || x > w - margin - 30 || y < margin + 7 || y > h - margin - 7) { el.style.display = 'none'; return false } // hidden, never half-clipped
    el.style.display = 'block'; el.style.transform = `translate(${x}px,${y}px)`
    return true
  }

  function drawGizmo() {
    const S = 84, k = dpr()
    if (gizmo.width !== S * k) { gizmo.width = S * k; gizmo.height = S * k }
    gctx.setTransform(k, 0, 0, k, 0, 0); gctx.clearRect(0, 0, S, S)
    gctx.fillStyle = 'rgba(0,0,0,.35)'; gctx.beginPath(); gctx.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2); gctx.fill()
    const items = []
    for (let a = 0; a < 3; a++) {
      dirV.setFromMatrixColumn(root.matrixWorld, a).normalize().transformDirection(camera.matrixWorldInverse) // data axis in camera space
      items.push({ a, x: dirV.x, y: dirV.y, z: dirV.z })
    }
    items.sort((p, q) => p.z - q.z) // far first
    gctx.lineWidth = 2; gctx.lineCap = 'round'; gctx.font = '600 11px ui-monospace,Menlo,monospace'; gctx.textAlign = 'center'; gctx.textBaseline = 'middle'
    const L = 27, c = S / 2
    for (const it of items) {
      const ex = c + it.x * L, ey = c - it.y * L
      gctx.globalAlpha = it.z < 0 ? 0.6 : 1
      gctx.strokeStyle = COLORS[it.a]; gctx.beginPath(); gctx.moveTo(c, c); gctx.lineTo(ex, ey); gctx.stroke()
      gctx.fillStyle = COLORS[it.a]; gctx.fillText(NAMES[it.a], c + it.x * (L + 9), c - it.y * (L + 9))
    }
    gctx.globalAlpha = 1
  }

  function paint() {
    const live = cfg.available
    overlay.style.display = live ? 'block' : 'none'
    group.visible = live && cfg.enabled && !!box
    if (!live) return
    hint.textContent = cfg.enabled ? 'x axes' : 'x axes (off)'
    const show = cfg.enabled
    sbEl.style.display = show && sb ? 'block' : 'none'
    gizmo.style.display = show ? 'block' : 'none'
    for (const l of labels) if (!show) l.el.style.display = 'none'
  }

  const onFrame = () => {
    if (!cfg.available) return
    if (frameNo++ % 15 === 0 || dirty) refresh()
    if (!cfg.enabled) { paint(); return }
    root.updateWorldMatrix(true, false)
    group.matrix.copy(root.matrixWorld); group.matrixWorld.copy(root.matrixWorld); group.matrixWorldNeedsUpdate = true
    camera.updateMatrixWorld(); camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
    const w = container.clientWidth || innerWidth, h = container.clientHeight || innerHeight
    for (const l of labels) project(l.el, l.p, w, h)
    const perPx = unitsPerPixel({ distance: camera.position.distanceTo(controls.target), fovDeg: camera.fov, heightPx: h, sceneScale: root.matrixWorld.getMaxScaleOnAxis(), unitScale: cfg.scale })
    const bar = scaleBar(perPx)
    if (bar) {
      const f = formatLength(bar.value, cfg.unit)
      sb = { value: bar.value, unit: cfg.unit, px: Math.round(bar.px), text: f.text }
      const sig = `${sb.text}|${sb.px}`
      if (sig !== lastSb) { lastSb = sig; sbText.textContent = sb.text; sbBar.style.width = `${sb.px}px`; sbEl.dataset.value = String(sb.value); sbEl.dataset.unit = sb.unit; sbEl.dataset.px = String(sb.px) }
    } else sb = null
    paint(); drawGizmo()
  }
  viewer.onFrame(onFrame)

  const api = {
    /** Show or hide the axes, ticks, scale bar and gizmo (the `x` key / state.axes). */
    setEnabled(on) { on = !!on; if (on !== cfg.enabled) { cfg.enabled = on; paint() } },
    /** false removes everything including the hint (quicklook.json "axes": false, for non-spatial apps). */
    setAvailable(on) { on = !!on; if (on !== cfg.available) { cfg.available = on; paint() } },
    /** Display unit label and scale (display units per scene unit); rebuilds the tick labels. */
    setUnits({ unit, scale }) { if (unit !== cfg.unit || scale !== cfg.scale) { cfg.unit = unit; cfg.scale = scale; dirty = true } },
    refresh,
    /** What is drawn now (for tests and verification): box extent in display units, ticks, scale bar. */
    info() {
      const e = box ? box.getSize(new THREE.Vector3()).toArray().map((x) => x * cfg.scale) : null
      return { enabled: cfg.enabled, available: cfg.available, unit: cfg.unit, scale: cfg.scale, extent: e, ticks: labels.filter((l) => l.kind === 'tick').map((l) => ({ axis: NAMES[l.axis], value: l.value, text: l.el.textContent, shown: l.el.style.display === 'block' })), scaleBar: sb }
    },
    dispose() { overlay.remove(); clearLines(); scene.remove(group); for (const m of mats) m.dispose() },
  }
  return api
}
