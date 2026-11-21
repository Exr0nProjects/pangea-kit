// The kit's pending indicator (docs/DERIVED-STATE.md, "Indicator"). Everything that must show while the main thread is
// frozen is CSS driven by an attribute set BEFORE the work starts: the global spinner is a compositor-only rotation (a
// `transform` animation keeps turning while a synchronous compute blocks the main thread) and the dim is an opacity rule.
//   <html data-qk-pending="scene doppler">   the names in flight (absent when nothing is)
//   [data-derived~="scene"]                  any element showing the derivation `scene`: dims to PENDING_OPACITY while it is in flight
// The spinner (#qk-derived .qk-dspin) sits bottom right, above the status chip; click it for the list of what is running.
export const PENDING_OPACITY = 0.85
const BASE_CSS = `
#qk-derived{position:fixed;right:12px;bottom:30px;z-index:20;font:11px ui-monospace,monospace;color:#bbb;display:flex;flex-direction:column;align-items:flex-end;gap:6px;pointer-events:none}
#qk-derived .qk-dspin{box-sizing:border-box;width:18px;height:18px;border:2px solid #ffffff33;border-top-color:#7fb0ff;border-radius:50%;opacity:0;transition:opacity .12s linear;animation:qk-dspin .8s linear infinite;cursor:pointer;pointer-events:none}
html[data-qk-pending] #qk-derived .qk-dspin{opacity:1;transition-delay:.15s;pointer-events:auto}
#qk-derived .qk-dlist{display:none;background:#000d;border:1px solid #fff2;border-radius:4px;padding:6px 8px;pointer-events:auto;white-space:nowrap}
#qk-derived[data-open] .qk-dlist{display:block}
@keyframes qk-dspin{to{transform:rotate(360deg)}}
[data-derived]{transition:opacity .15s linear}
`
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

/** Install once per document; returns { track(name), dispose }. `core` is a createDerived() instance. */
export function installPendingUI(core, doc = globalThis.document) {
  if (!doc?.documentElement) return { track() {}, dispose() {} }
  const style = doc.createElement('style'); style.id = 'qk-derived-style'; style.textContent = BASE_CSS; doc.head.appendChild(style)
  const names = new Set()
  const box = doc.createElement('div'); box.id = 'qk-derived'
  const spin = doc.createElement('div'); spin.className = 'qk-dspin'; spin.setAttribute('role', 'status'); spin.setAttribute('aria-label', 'computing')
  const list = doc.createElement('div'); list.className = 'qk-dlist'
  box.append(list, spin); doc.body.appendChild(box)
  spin.addEventListener('click', () => { if (box.hasAttribute('data-open')) box.removeAttribute('data-open'); else { box.setAttribute('data-open', ''); paint() } })
  const root = doc.documentElement
  function paint() {
    const run = core.running()
    if (run.length) root.setAttribute('data-qk-pending', run.map((r) => r.name).join(' ')); else root.removeAttribute('data-qk-pending')
    spin.title = run.length ? `computing: ${run.map((r) => r.label).join(', ')}` : ''
    if (box.hasAttribute('data-open') || !run.length) {
      const t = Date.now()
      list.innerHTML = run.length ? run.map((r) => `<div>${esc(r.label)} ${r.since ? ((t - r.since) / 1000).toFixed(1) + 's' : ''}${r.progress?.fraction != null ? ' ' + Math.round(r.progress.fraction * 100) + '%' : ''}${r.progress?.text ? ' ' + esc(r.progress.text) : ''}${r.attempt ? ' retry ' + r.attempt : ''}</div>`).join('') : ''
      if (!run.length) box.removeAttribute('data-open')
    }
  }
  const off = core.subscribe(paint, { sync: true })
  const track = (name) => { // the dim rule for one derivation name
    if (names.has(name)) return; names.add(name)
    style.textContent += `html[data-qk-pending~="${name}"] [data-derived~="${name}"]{opacity:${PENDING_OPACITY}}\n`
  }
  return { track, dispose() { off(); box.remove(); style.remove(); root.removeAttribute('data-qk-pending') } }
}
