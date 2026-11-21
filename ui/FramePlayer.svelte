<script>
  import ScaleBar from './ScaleBar.svelte'
  // FramePlayer: a video-style player for an indexed sequence drawn on a canvas (fUSI/ultrasound frames, simulation steps, any array of images).
  // The app owns drawing: draw(canvas, i) paints frame i. The player owns transport: play/pause, loop, speed, step, scrub bar with a per-frame
  // marks strip (e.g. task on/off), time readout, keyboard (space, arrows, Home/End when focused). Playback runs on lib/timers.js every().
  //   <FramePlayer n={180} bind:index bind:playing bind:fps width={240} height={128} zoom={3} draw={(c, i) => ...} times={t} marks={task} bind:canvas onclick={...} />
  import { every } from '../lib/timers.js'
  let { n = 1, index = $bindable(0), playing = $bindable(false), fps = $bindable(10), speedN = $bindable(null), global = true, loop = true, width = 1, height = 1, zoom = 1, draw = null, times = null, marks = null, ticks = [], tickSeconds = 0, canvas = $bindable(null), onclick = null, label = '', mmPerPx = 0, sx = 1, sy = 1, mirrorX = false, mirrorY = false } = $props()
  let strip = $state(null)
  // Speed is a real-time multiple, stepped by < and > exactly as viewer3 does (lib/viewer3/app.py _bump_speed): an integer counter K, multiple = SPEED_STEP^K
  // (viewer3: 1.33^N). Real time = the data's own frame interval (median of `times` diffs, else 1/fps); the effective frame rate is multiple / dt, in parentheses.
  const SPEED_STEP = 1.33
  const dt = $derived.by(() => { if (times && n > 2) { const d = []; for (let i = 1; i < Math.min(n, 200); i++) d.push(times[i] - times[i - 1]); d.sort((a, b) => a - b); const m = d[d.length >> 1]; if (m > 0) return m } return 1 / Math.max(0.5, fps) })
  const K = $derived(speedN ?? Math.round(Math.log(8 * dt) / Math.log(SPEED_STEP))) // default: about 8 frames per second
  const mult = $derived(SPEED_STEP ** K)
  const eff = $derived(mult / dt)
  const fmtM = (m) => (m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1) : m.toFixed(2).replace(/0$/, ''))
  const fmtF = (f) => (f >= 10 ? f.toFixed(0) : f.toFixed(1))
  const faster = () => (speedN = Math.min(40, K + 1)), slower = () => (speedN = Math.max(-40, K - 1))
  const clamp = (i) => Math.max(0, Math.min(n - 1, i))
  const uid = `frameplayer-${Math.random().toString(36).slice(2)}`
  $effect(() => { if (canvas && draw) { index; width; height; draw(canvas, clamp(index)) } })
  $effect(() => {
    if (!playing || n < 2) return
    return every(uid, 1000 / Math.min(120, Math.max(0.2, eff)), () => { const nx = index + 1; if (nx >= n) { if (loop) index = 0; else playing = false } else index = nx }, { budgetMs: 80 })
  })
  // Tick marks on the scrub strip: `ticks` = [{ i, label?, major? }] (app-defined, e.g. task onsets) plus automatic time ticks when `times` is given
  // (tickSeconds, or a nice step chosen so there are about 8-12). [ and ] jump to the previous/next tick.
  const allTicks = $derived.by(() => {
    const out = [...ticks]
    if (times && n > 1) {
      const span = times[n - 1] - times[0], nice = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800], step = tickSeconds || nice.find((v) => span / v <= 12) || 3600
      for (let t = 0; t <= span + 1e-9; t += step) { let i = times.findIndex((x) => x - times[0] >= t - 1e-9); if (i >= 0) out.push({ i, label: t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : `${t}s`, auto: true }) }
    }
    return out.sort((a, b) => a.i - b.i)
  })
  const pal = ['transparent', '#5aa84a', '#d98a52', '#5a7ad9']
  $effect(() => {
    if (!strip) return
    const w = strip.width, h = strip.height, c = strip.getContext('2d'), BAR = 18; c.clearRect(0, 0, w, h)
    if (marks) for (let i = 0; i < n; i++) if (marks[i]) { c.fillStyle = pal[marks[i]] || '#888'; c.fillRect(i / n * w, 0, Math.ceil(w / n) + 1, BAR) }
    const fg = getComputedStyle(strip).color; c.fillStyle = fg; c.font = '9px ui-monospace,Menlo,monospace'; c.textBaseline = 'top'
    for (const t of allTicks) { const x = (t.i + 0.5) / n * w; c.globalAlpha = t.auto ? 0.5 : 1; c.fillRect(Math.round(x), BAR, 1, 5); if (t.label) { const tw = c.measureText(t.label).width; c.fillText(t.label, Math.max(0, Math.min(w - tw, x - tw / 2)), BAR + 6) } }
    c.globalAlpha = 1; c.fillRect(Math.min(w - 2, (clamp(index) + 0.5) / n * w - 1), 0, 2, BAR)
  })
  let dragging = false
  function down(e) { dragging = true; strip.setPointerCapture(e.pointerId); scrub(e) }
  function move(e) { if (dragging) scrub(e) }
  function up(e) { dragging = false; strip.releasePointerCapture?.(e.pointerId) }
  function scrub(e) { const r = strip.getBoundingClientRect(); index = clamp(Math.floor((e.clientX - r.left) / r.width * n)) }
  // Keys follow viewer3 (ultrasound-imaging lib/viewer3 _handle_key): space play/pause; left or , back one frame; right or . forward one frame;
  // < slower and > faster (real-time multiple, x1.33 per press as viewer3). Extra: shift+arrows jump 10, Home/End. With `global` the keys work anywhere on the page except in text fields.
  function key(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
    const t = e.target, tag = t && t.tagName
    if (tag === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return
    const k = e.key
    if (k === ' ') playing = !playing
    else if (k === 'ArrowRight' || k === '.') index = clamp(index + (e.shiftKey && k === 'ArrowRight' ? 10 : 1))
    else if (k === 'ArrowLeft' || k === ',') index = clamp(index - (e.shiftKey && k === 'ArrowLeft' ? 10 : 1))
    else if (k === '>') faster()
    else if (k === '<') slower()
    else if (k === '[') { const t = [...allTicks].reverse().find((x) => x.i < index); if (t) index = t.i }
    else if (k === ']') { const t = allTicks.find((x) => x.i > index); if (t) index = t.i }
    else if (k === 'Home') index = 0
    else if (k === 'End') index = n - 1
    else return
    e.preventDefault()
  }
  $effect(() => { if (!global) return; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key) })
  const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
</script>
<div class="qk-fp" tabindex="0" role="group" aria-label={label || 'frame player'} onkeydown={(e) => { if (!global) key(e) }} data-qk="frameplayer">
  <div style="position:relative;width:{width * zoom * sx}px;height:{height * zoom * sy}px"><canvas bind:this={canvas} {width} {height} {onclick} style="width:{width * zoom * sx}px;height:{height * zoom * sy}px;transform:scale({mirrorX ? -1 : 1},{mirrorY ? -1 : 1})"></canvas><ScaleBar {mmPerPx} {zoom} /></div>
  <div class="bar" style="width:{width * zoom * sx}px">
    <button onclick={() => (playing = !playing)} title="space">{playing ? 'pause' : 'play'}</button>
    <button onclick={() => (index = clamp(index - 1))} title=", or left arrow">&lt;</button>
    <button onclick={() => (index = clamp(index + 1))} title=". or right arrow">&gt;</button>
    <canvas bind:this={strip} class="strip" width="800" height="40" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}></canvas>
  </div>
  <div class="bar" style="width:{width * zoom * sx}px">
    <span>{clamp(index) + 1}/{n}{times ? `  ${fmt(times[clamp(index)] - times[0])} / ${fmt(times[n - 1] - times[0])}` : ''}</span>
    <span style="flex:1"></span>
    <button onclick={slower} title="< slower (x1/1.33 per press, as viewer3)">&lt;</button><span title="real-time multiple (frames per second shown in parentheses)">&times;{fmtM(mult)} ({fmtF(eff)} fps)</span><button onclick={faster} title="> faster (x1.33 per press, as viewer3)">&gt;</button>
    <label><input type="checkbox" bind:checked={loop} /> loop</label>
  </div>
</div>
<style>
  .qk-fp { display: inline-block; outline: none; font: 11px/16px ui-monospace, Menlo, monospace }
  .qk-fp > canvas:first-child { display: block; image-rendering: pixelated; outline: 1px solid var(--line, #888) }
  .bar { display: flex; gap: 6px; align-items: center; margin-top: 4px }
  .strip { touch-action: none; flex: 1; height: 40px; min-width: 0; cursor: pointer; border: 1px solid var(--line, #888) }
  button { background: var(--ctl, #eee); color: var(--fg, inherit); border: 1px solid var(--ctlb, #aaa); padding: 1px 8px; font: inherit; cursor: pointer }
</style>
