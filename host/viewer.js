// The persistent three.js viewer. It is created ONCE by the host and never torn down by a part swap, so
// the WebGL canvas, renderer, scene and camera stay alive and nothing flashes black while a part is replaced.
// Parts add their objects under `viewer.root` (through ctx.add, which removes them when the part swaps) and
// derive everything they show from the state; the camera is the one thing the viewer itself reconciles.
import { createAxes } from './axes.js'

export function createViewer({ THREE, OrbitControls, container, background = 0x0e0e0e, fov = 40, near = 1, far = 20000 }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(devicePixelRatio)
  const el = renderer.domElement
  el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'
  container.appendChild(el)
  const scene = new THREE.Scene(); scene.background = new THREE.Color(background)
  const camera = new THREE.PerspectiveCamera(fov, 1, near, far)
  camera.position.set(900, 350, 1100)
  const root = new THREE.Group(); scene.add(root)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.3))
  const sun = new THREE.DirectionalLight(0xffffff, 1.0); sun.position.set(1, 2, 3); scene.add(sun)
  const controls = new OrbitControls(camera, el); controls.update()

  const size = () => {
    const w = container.clientWidth || innerWidth, h = container.clientHeight || innerHeight
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix()
  }
  size(); addEventListener('resize', size)
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(size).observe(container)

  const frame = new Set()
  let stopped = false
  ;(function loop() {
    if (stopped) return
    requestAnimationFrame(loop)
    for (const f of frame) { try { f() } catch (e) { console.error('[pangea-kit] frame hook', e) } }
    renderer.render(scene, camera)
  })()

  // ---- click router: one pointerdown/up pair, 4 px slop (a drag is the camera's, not a click) ----
  const clickers = new Set()
  let down = null
  el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY] })
  el.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) { down = null; return }
    down = null
    for (const f of [...clickers].reverse()) { if (f(e) === true) break } // newest first; return true to consume
  })
  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  /** First intersection of the pointer event with `objects` (recursive). */
  function raycast(e, objects, recursive = false) {
    const r = el.getBoundingClientRect()
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    ray.setFromCamera(ndc, camera)
    return ray.intersectObjects(objects, recursive)[0] || null
  }

  // ---- camera: smooth fit, one easing, cancelled by any user input ----
  let tween = null
  const cancel = () => { tween = null }
  el.addEventListener('pointerdown', cancel); el.addEventListener('wheel', cancel, { passive: true })
  frame.add(() => {
    if (!tween) return
    const t = Math.min(1, (performance.now() - tween.t0) / tween.ms)
    const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    camera.position.lerpVectors(tween.p0, tween.p1, k); controls.target.lerpVectors(tween.t0v, tween.t1, k); controls.update()
    if (t >= 1) { const done = tween.done; tween = null; done?.() }
  })
  /** Fly the camera to frame a Box3 (world space), keeping the current view direction. */
  function fit(box, { ms = 450, margin = 1.6, done } = {}) {
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3())
    const radius = Math.max(s.length() / 2, 1)
    const dist = (radius * margin) / Math.sin((camera.fov * Math.PI) / 360)
    const dir = camera.position.clone().sub(controls.target).normalize()
    tween = { t0: performance.now(), ms, p0: camera.position.clone(), p1: c.clone().addScaledVector(dir, dist), t0v: controls.target.clone(), t1: c, done }
  }

  const api = {
    THREE, renderer, scene, camera, controls, root, el,
    raycast, fit,
    measure: (opts) => createMeasure(api, opts),
    onClick(fn) { clickers.add(fn); return () => clickers.delete(fn) },
    onFrame(fn) { frame.add(fn); return () => frame.delete(fn) },
    getCamera: () => ({ p: camera.position.toArray(), t: controls.target.toArray() }),
    /** Apply a stored camera. No-op when it already matches (so a reconciler effect cannot fight a drag). */
    setCamera(c) {
      if (!c?.p || !c?.t) return
      const same = camera.position.distanceTo(new THREE.Vector3(...c.p)) < 1e-6 && controls.target.distanceTo(new THREE.Vector3(...c.t)) < 1e-6
      if (same) return
      tween = null; camera.position.fromArray(c.p); controls.target.fromArray(c.t); controls.update()
    },
    onCameraEnd(fn) { controls.addEventListener('end', fn); return () => controls.removeEventListener('end', fn) },
    dispose() { stopped = true; api.axes.dispose(); renderer.dispose(); el.remove() },
  }
  api.axes = createAxes(api, { container }) // built in: bbox + XYZ axes + ticks + scale bar + gizmo; see host/axes.js and GUIDE 3.10
  return api
}

/** Two clicks -> a distance. `toLocal(worldPoint)` maps into the units to report (default: the root's local space). */
export function createMeasure(viewer, { unit = 'µm', parent = viewer.root, decimals = 1 } = {}) {
  const { THREE } = viewer
  let pts = [], objs = []
  const clear = () => { for (const o of objs) { parent.remove(o); o.geometry?.dispose(); o.material?.dispose() } pts = []; objs = [] }
  return {
    clear,
    get points() { return pts.map((p) => p.clone()) },
    /** Add a world-space point. Returns { n, text, distance } ("click second point" after one, the distance after two). */
    add(worldPoint) {
      if (pts.length >= 2) clear()
      const p = parent.worldToLocal(worldPoint.clone()); pts.push(p)
      const dot = new THREE.Mesh(new THREE.SphereGeometry(3), new THREE.MeshBasicMaterial({ color: 0xffff00, depthTest: false })); dot.position.copy(p); dot.renderOrder = 9; parent.add(dot); objs.push(dot)
      if (pts.length < 2) return { n: 1, text: 'measure: click second point', distance: null }
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffff00, depthTest: false })); line.renderOrder = 9; parent.add(line); objs.push(line)
      const distance = pts[0].distanceTo(pts[1])
      return { n: 2, distance, text: `distance ${distance.toFixed(decimals)} ${unit}` }
    },
  }
}
