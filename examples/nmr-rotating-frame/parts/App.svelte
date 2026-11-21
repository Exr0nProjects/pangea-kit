<script>
  let { state: st } = $props()
  const W0 = Math.PI, W1 = Math.PI / 2 // rad/s: omega0 = 0.5 rev/s, B1 tips 90 deg per second (toy numbers, not physical rates)
  const S = [
    { t: '1 Precession', view: 'lab', b1: 0, m0: 60, d: 'B1 is off. B0 points along z. M starts tilted 60 deg and swings around z at ω0 = γB0 (dM/dt = γ M×B). Lab view: it spins forever.' },
    { t: '2 Rotating frame', view: 'rot', b1: 0, m0: 60, d: 'Same physics, but the camera now turns with the spins at ω0. M freezes: B0 has disappeared. Switch to lab frame to see it spinning again.' },
    { t: '3 Apply B1', view: 'rot', b1: 1, m0: 0, d: 'B1 (red) turns at ω0 in the lab, so in the rotating frame it is static along x. M sees only B1 and precesses about x. Switch to lab frame: the same motion is a spiral from z down to the xy plane while B1 chases it around.' },
    { t: '4 Tip angle', view: 'rot', b1: 1, m0: 0, d: 'Tip angle α = γB1·τ grows linearly with the time B1 is on: 90 deg after 1 s here. Stop B1 at the right time for the tip you want. At 7T B1 varies by position, so α varies by position.' },
    { t: '5 Resonance', view: 'rot', b1: 1, m0: 0, d: 'Drag detuning. If the RF frequency is not ω0, B0 is not cancelled in the rotating frame: a leftover z field (blue) tilts the total field Beff (green). M circles Beff, mostly z, so it only wobbles near the top and never tips far. Resonance = detuning 0.' }]
  const AZ = .6, EL = .35
  let cv, trail = [], T = 0, lastKey = '', phase = 0, Mrot = null // clock and M live outside state: a slider only changes the rates read each frame
  const cc = (n) => getComputedStyle(document.documentElement).getPropertyValue('--qk-' + n).trim() || '#888'
  function pick(i) { st.b1On = true; st.step = i; st.view = S[i].view; st.delta = i === 4 ? 2.5 : 0 }
  const proj = ([x, y, z]) => { const a = x * Math.cos(AZ) + y * Math.sin(AZ), b = -x * Math.sin(AZ) + y * Math.cos(AZ); return [W / 2 + a * 150, 215 - (z * Math.cos(EL) - b * Math.sin(EL)) * 150] }
  const W = 560, H = 420
  function rod(v, k, a) { const kk = Math.hypot(...k); if (!kk) return v; k = k.map((x) => x / kk); const cs = Math.cos(a), sn = Math.sin(a), d = k[0] * v[0] + k[1] * v[1] + k[2] * v[2]; const cr = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]]; return v.map((x, i) => x * cs + cr[i] * sn + k[i] * d * (1 - cs)) }
  let readout = $state('')
  $effect(() => {
    const g = cv.getContext('2d'); let raf, last = performance.now()
    const arrow = (v, col, w, lab) => { const o = proj([0, 0, 0]), p = proj(v); g.strokeStyle = g.fillStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(...o); g.lineTo(...p); g.stroke(); g.beginPath(); g.arc(p[0], p[1], w + 2, 0, 7); g.fill(); if (lab) g.fillText(lab, p[0] + 6, p[1] - 6) }
    const frame = (now) => {
      const dt = Math.min(.05, (now - last) / 1000); last = now
      const key = st.step + st.view + st.tKey
      if (key !== lastKey) { lastKey = key; T = 0; trail = []; phase = 0; Mrot = null }
      T += dt
      const s = S[st.step], D = s.t.startsWith('5') ? st.delta : 0, w = W0 + D, m0 = s.m0 * Math.PI / 180
      if (!Mrot) Mrot = [Math.sin(m0), 0, Math.cos(m0)]
      const b1 = s.b1 && st.b1On ? 1 : 0, Om = [b1 * W1, 0, W0 - w]
      Mrot = rod(Mrot, Om, Math.hypot(...Om) * dt); phase += w * dt // integrate with the current rates, so dragging detuning bends the path without a reset
      const M = Mrot, ang = phase, Mv = st.view === 'lab' ? rod(M, [0, 0, 1], ang) : M
      trail.push(Mv); if (trail.length > 260) trail.shift()
      g.clearRect(0, 0, W, H); g.fillStyle = cc('canvas-bg'); g.fillRect(0, 0, W, H); g.font = '13px ui-monospace,Menlo,monospace'
      g.strokeStyle = cc('canvas-line'); g.lineWidth = 1; g.beginPath(); for (let i = 0; i <= 64; i++) { const a = i / 64 * 6.283, p = proj([Math.cos(a), Math.sin(a), 0]); i ? g.lineTo(...p) : g.moveTo(...p) } g.stroke()
      for (const [v, l] of [[[1, 0, 0], 'x'], [[0, 1, 0], 'y']]) { g.strokeStyle = cc('canvas-line'); g.beginPath(); g.moveTo(...proj([0, 0, 0])); g.lineTo(...proj(v)); g.stroke(); g.fillStyle = cc('canvas-text'); g.fillText(l, ...proj(v.map((x) => x * 1.1))) }
      arrow([0, 0, 1.05], cc('canvas-text'), 2, 'z (B0)')
      g.strokeStyle = '#e0a'; g.lineWidth = 2; g.beginPath(); trail.forEach((p, i) => { const q = proj(p); i ? g.lineTo(...q) : g.moveTo(...q) }); g.stroke()
      if (b1) {
        arrow((st.view === 'lab' ? [Math.cos(ang), Math.sin(ang), 0] : [1, 0, 0]).map((x) => x * .8), '#d22', 3, 'B1')
        if (st.view === 'rot' && Math.abs(D) > .01) { arrow([0, 0, -D / W1 * .5], '#27c', 2, 'leftover B0'); const e = [1, 0, -D / W1], n = Math.hypot(...e); arrow(e.map((x) => x / n * .9), '#2a2', 2, 'Beff') }
      }
      arrow(Mv, cc('canvas-title'), 4, 'M')
      readout = `t = ${T.toFixed(2)} s · tilt of M from z = ${(Math.acos(Math.max(-1, Math.min(1, M[2]))) * 180 / Math.PI).toFixed(0)}° · ${st.view} frame · RF = ω0 ${D >= 0 ? '+' : ''}${D.toFixed(2)} rad/s`
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  })
  const btn = 'font:inherit;border:1px solid var(--qk-line);background:transparent;color:var(--qk-text);padding:3px 7px;margin:2px;cursor:pointer'
</script>
<div style="pointer-events:auto;position:absolute;top:10px;left:10px;width:{W + 4}px;max-width:calc(100vw - 20px);max-height:calc(100vh - 20px);overflow:auto;font:13px/1.45 ui-monospace,Menlo,monospace;color:var(--qk-text);background:var(--qk-panel-bg, var(--qk-canvas-bg));padding:8px;border:1px solid var(--qk-line)">
  <div>{#each S as s, i}<button style={btn + (st.step === i ? ';background:var(--qk-accent);color:#000' : '')} onclick={() => pick(i)}>{s.t}</button>{/each}</div>
  {#if S[st.step].b1}
    <div>B1 pulse: <button style={btn + (st.b1On ? ';background:var(--qk-accent);color:#000' : '')} onclick={() => (st.b1On = !st.b1On)}>{st.b1On ? 'B1 ON (click to stop)' : 'B1 OFF (click to resume)'}</button> M keeps its tilt while B1 is off.</div>
  {/if}
  <canvas bind:this={cv} width={W} height={H} style="width:100%;display:block;margin:6px 0"></canvas>
  <div style="min-height:6em">{S[st.step].d}</div>
  {#if st.step === 4}
  <label style="display:flex;gap:8px;align-items:center">detuning (RF minus ω0)
    <input type="range" min="-4" max="4" step="0.05" bind:value={st.delta} style="flex:1"><b style="width:9ch">{(+st.delta).toFixed(2)} rad/s</b></label>
  {/if}
  <div>view: <button style={btn + (st.view === 'lab' ? ';background:var(--qk-accent);color:#000' : '')} onclick={() => (st.view = 'lab')}>lab frame</button><button style={btn + (st.view === 'rot' ? ';background:var(--qk-accent);color:#000' : '')} onclick={() => (st.view = 'rot')}>rotating frame</button><button style={btn} onclick={() => (st.tKey = st.tKey + 1)}>restart</button></div>
  <div style="color:var(--qk-mute)">{readout}</div>
</div>
