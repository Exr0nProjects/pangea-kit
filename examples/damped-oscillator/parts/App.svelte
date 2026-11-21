<script>
  // A mass on a spring: x'' = -k x - c x'. The damping slider exists only in damped mode (R6).
  // Position, velocity, clock and trace are plain locals integrated each frame from the current
  // controls, so dragging a slider bends the motion and never restarts it (R7).
  import { Panel, Slider, Button } from 'pangea-kit/ui'
  let { state: st } = $props()
  let cv, x = 1, v = 0, t = 0, seenRun = -1, trace = []
  let readout = $state('')
  const cc = (n) => getComputedStyle(document.documentElement).getPropertyValue('--qk-' + n).trim() || '#888'
  const setMode = (m) => { st.mode = m; st.runId += 1 }

  $effect(() => {
    const g = cv.getContext('2d'); let raf, last = performance.now()
    const frame = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now
      if (st.runId !== seenRun) { seenRun = st.runId; x = 1; v = 0; t = 0; trace = [] }
      const k = st.k, c = st.mode === 'damped' ? st.damping : 0     // a hidden damping value cannot act
      const n = 8, h = dt / n
      for (let i = 0; i < n; i++) { v += (-k * x - c * v) * h; x += v * h }   // semi-implicit Euler, sub-stepped
      t += dt
      trace.push(x); if (trace.length > 400) trace.shift()
      const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight
      if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr) }
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.fillStyle = cc('canvas-bg'); g.fillRect(0, 0, W, H)
      const mid = H / 2, amp = Math.min(H * 0.35, 160), left = 60, right = Math.max(left + 100, W - 360)
      g.strokeStyle = cc('canvas-line'); g.beginPath(); g.moveTo(left, mid); g.lineTo(right, mid); g.stroke()
      g.strokeStyle = cc('plot-line'); g.lineWidth = 2; g.beginPath()
      trace.forEach((val, i) => { const px = right - (trace.length - 1 - i) * ((right - left) / 400), py = mid - val * amp; i ? g.lineTo(px, py) : g.moveTo(px, py) })
      g.stroke()
      g.fillStyle = cc('plot-hot'); g.beginPath(); g.arc(right, mid - x * amp, 7, 0, 7); g.fill()
      readout = `t = ${t.toFixed(1)} s · x = ${x.toFixed(2)} · ${st.mode}`
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  })
</script>

<canvas bind:this={cv} style="position:absolute;inset:0;width:100%;height:100%;display:block"></canvas>
<Panel title="mass on a spring">
  <div>
    <Button label="undamped" active={st.mode === 'undamped'} onclick={() => setMode('undamped')} />
    <Button label="damped" active={st.mode === 'damped'} onclick={() => setMode('damped')} />
    <Button label="restart" onclick={() => (st.runId += 1)} />
  </div>
  <Slider label="spring constant k" bind:value={st.k} min={1} max={20} step={0.1} />
  {#if st.mode === 'damped'}
    <Slider label="damping c" bind:value={st.damping} min={0} max={3} step={0.05} />
    <div style="color:var(--qk-mute)">c below 2 sqrt(k) rings and decays; above it the mass creeps back without crossing zero.</div>
  {/if}
  <div style="color:var(--qk-mute)">{readout}</div>
</Panel>
