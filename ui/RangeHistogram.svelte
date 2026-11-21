<script>
  // RangeHistogram: the colour-clip (window/level) control. Shows a histogram of the data's values with the colormap as a colour bar underneath,
  // and a draggable selected range [lo, hi] in data units. Drag a handle, drag the shaded body to move it, or drag on empty space to select a new range;
  // double-click selects the full domain. Buttons: auto (percentiles) and full. The app owns the data: it passes `counts` (bin counts over `domain`).
  //   <RangeHistogram counts={c} domain={[9, 15]} bind:lo bind:hi lut={lutUint8x768} units="log10" autoPct={[1, 99.5]} />
  let { counts = [], domain = [0, 1], lo = $bindable(0), hi = $bindable(1), lut = null, units = '', width = 320, height = 90, logCounts = true, autoPct = [1, 99.5], label = 'colour clip' } = $props()
  let cv = $state(null), dragMode = null, anchor = 0, startLo = 0, startHi = 0, hover = $state(null)
  const D0 = $derived(domain[0]), D1 = $derived(domain[1])
  const x2v = (x) => D0 + Math.max(0, Math.min(1, x / width)) * (D1 - D0)
  const v2x = (v) => (v - D0) / (D1 - D0 || 1) * width
  const BAR = 10
  $effect(() => {
    if (!cv) return
    lo; hi; counts; lut; D0; D1; logCounts
    const c = cv.getContext('2d'), st = getComputedStyle(cv), fg = st.color, h = height - BAR - 2
    c.clearRect(0, 0, width, height)
    let mx = 1; const f = (v) => (logCounts ? Math.log1p(v) : v)
    for (let i = 0; i < counts.length; i++) mx = Math.max(mx, f(counts[i]))
    const bw = width / Math.max(1, counts.length)
    for (let i = 0; i < counts.length; i++) {
      const bh = f(counts[i]) / mx * h, vx = (i + 0.5) / counts.length * (D1 - D0) + D0, inside = vx >= lo && vx <= hi
      c.globalAlpha = inside ? 0.95 : 0.35; c.fillStyle = fg; c.fillRect(i * bw, h - bh, Math.ceil(bw), bh)
    }
    c.globalAlpha = 1
    if (lut) for (let x = 0; x < width; x++) { const v = x2v(x), t = Math.max(0, Math.min(255, Math.round((v - lo) / (hi - lo || 1) * 255))) * 3; c.fillStyle = `rgb(${lut[t]},${lut[t + 1]},${lut[t + 2]})`; c.fillRect(x, height - BAR, 1, BAR) }
    c.fillStyle = 'rgba(80,140,255,0.18)'; c.fillRect(v2x(lo), 0, v2x(hi) - v2x(lo), h)
    c.fillStyle = '#4a7ab0'; for (const v of [lo, hi]) c.fillRect(v2x(v) - 1, 0, 2, height - BAR)
  })
  const pos = (e) => { const r = cv.getBoundingClientRect(); return (e.clientX - r.left) / r.width * width }
  function down(e) {
    const x = pos(e); cv.setPointerCapture(e.pointerId)
    if (Math.abs(x - v2x(lo)) < 7) dragMode = 'lo'
    else if (Math.abs(x - v2x(hi)) < 7) dragMode = 'hi'
    else if (x > v2x(lo) && x < v2x(hi)) { dragMode = 'move'; anchor = x2v(x); startLo = lo; startHi = hi }
    else { dragMode = 'new'; anchor = x2v(x); lo = anchor; hi = anchor }
  }
  function move(e) {
    const x = pos(e), v = x2v(x); hover = v
    if (!dragMode) return
    const eps = (D1 - D0) / 200
    if (dragMode === 'lo') lo = Math.min(v, hi - eps)
    else if (dragMode === 'hi') hi = Math.max(v, lo + eps)
    else if (dragMode === 'new') { lo = Math.min(anchor, v); hi = Math.max(anchor, v, lo + eps) }
    else { let d = v - anchor; d = Math.max(D0 - startLo, Math.min(D1 - startHi, d)); lo = startLo + d; hi = startHi + d }
  }
  function up(e) { dragMode = null; cv.releasePointerCapture?.(e.pointerId) }
  const full = () => { lo = D0; hi = D1 }
  function auto() {
    const tot = counts.reduce((a, v) => a + v, 0); if (!tot) return
    const q = (p) => { let s = 0, t = tot * p / 100; for (let i = 0; i < counts.length; i++) { s += counts[i]; if (s >= t) return D0 + (i + 1) / counts.length * (D1 - D0) } return D1 }
    lo = q(autoPct[0]); hi = Math.max(q(autoPct[1]), lo + (D1 - D0) / 200)
  }
</script>
<div class="qk-rh" data-qk="rangehistogram">
  <div class="top"><span>{label}</span><span style="flex:1"></span><button onclick={auto} title="percentile clip">auto</button><button onclick={full} title="full range (or double-click)">full</button></div>
  <canvas bind:this={cv} {width} {height} style="width:{width}px;height:{height}px" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} ondblclick={full}></canvas>
  <div class="top"><span>{lo.toFixed(2)}</span><span style="flex:1;text-align:center">{hover == null ? '' : `${hover.toFixed(2)} ${units}`}</span><span>{hi.toFixed(2)} {units}</span></div>
</div>
<style>
  .qk-rh { display: inline-block; font: 11px/16px ui-monospace, Menlo, monospace; color: var(--fg, inherit) }
  .qk-rh canvas { display: block; touch-action: none; cursor: ew-resize; color: var(--dim, #567); outline: 1px solid var(--line, #888) }
  .top { display: flex; gap: 6px; align-items: center }
  button { background: var(--ctl, #eee); color: var(--fg, inherit); border: 1px solid var(--ctlb, #aaa); padding: 0 8px; font: inherit; cursor: pointer }
</style>
