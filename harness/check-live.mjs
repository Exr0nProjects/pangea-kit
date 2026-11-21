#!/usr/bin/env node
// Minimal live check for a published kit applet. No dependencies (Node 22+: global fetch and WebSocket).
// Usage: node check-live.mjs <page-url> [--cdp http://localhost:9222] [--clock 't = ([0-9.]+)']
// Needs a Chrome started with --remote-debugging-port. Opens one tab, runs the checks, closes the tab.
// Exit code 0 only if every check passes. Checks implemented: C1 loads clean, C2 no dead controls,
// C3 real clicks reach controls, C4 live drag does not reset the clock. See ../README.md for the full list.
const args = process.argv.slice(2)
const url = args.find((a) => /^https?:/.test(a))
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d)
const cdp = opt('--cdp', 'http://localhost:9222'), clockRe = new RegExp(opt('--clock', 't = ([0-9.]+)'))
if (!url) { console.error('usage: check-live.mjs <page-url> [--cdp URL] [--clock REGEX]'); process.exit(2) }

const tab = await (await fetch(`${cdp}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r))
let id = 0; const waiting = new Map()
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id) } }
const send = (method, params = {}) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const click = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }); await sleep(300) }
const key = async (k, code) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: 39 }) }
const state = () => ev('JSON.stringify(globalThis.__pangea?.kit?.state ?? null)')
const clock = async () => { const m = (await ev('document.body.innerText')).match(clockRe); return m ? parseFloat(m[1]) : null }
const centres = (sel) => ev(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map((e,i)=>{const r=e.getBoundingClientRect();return {i,label:(e.textContent||e.type).trim().slice(0,24),x:r.x+r.width/2,y:r.y+r.height/2,inView:r.width>0&&r.height>0&&r.y>=0&&r.y+r.height<=innerHeight&&r.x>=0&&r.x+r.width<=innerWidth,hit:(()=>{const t=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return t===e||e.contains(t)})()}}))`).then(JSON.parse)

const results = []; const rec = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`) }
try {
  await fetch(`${cdp}/json/activate/${tab.id}`); await send('Page.enable'); await send('Runtime.enable')
  await sleep(5000) // let the host mount parts and the canvas start
  const chip = await ev('document.getElementById("qk-chip")?.innerText || ""')
  rec('C1 loads clean (chip reads "● live", a canvas or part is present)', chip.trim() === '● live' && await ev('!!document.querySelector("canvas")'), JSON.stringify(chip.slice(0, 120)))

  const controls = await centres('button, input')
  const dead = controls.filter((c) => c.inView && !c.hit)
  rec('C2 no dead controls (every visible control is the topmost element at its centre)', controls.length > 0 && dead.length === 0, dead.length ? 'covered: ' + dead.map((d) => d.label).join(', ') : `${controls.length} controls`)

  const ranges = (await centres('input[type=range]')).filter((r) => r.inView && r.hit)
  if (!ranges.length) rec('C4 live drag keeps the clock running', true, 'skipped: no visible range input in the current mode')
  else {
    const c0 = await clock(); const s0 = await state()
    await click(ranges[0].x, ranges[0].y); for (let i = 0; i < 5; i++) await key('ArrowRight', 'ArrowRight'); await sleep(500)
    const c1 = await clock(), s1 = await state()
    rec('C4 live drag keeps the clock running (clock rises, state changed, no reset)', c0 !== null && c1 !== null && c1 > c0 && s1 !== s0, `clock ${c0} -> ${c1}${s1 === s0 ? ', state unchanged' : ''}`)
  }
  const buttons = (await centres('button')).filter((b) => b.inView && b.hit)
  const before = await state(); let changed = []
  for (const b of [...buttons].reverse()) { // last first: the first button is usually a collapsing panel header
    const s0 = await state(); await click(b.x, b.y); if ((await state()) !== s0) changed.push(b.label) }
  rec('C3 real clicks reach controls (at least one button changes saved state)', changed.length > 0, changed.length ? 'changed state: ' + changed.join(', ') : 'no button changed state; tried ' + JSON.stringify(buttons.map((b) => [b.label, Math.round(b.x), Math.round(b.y)])))

} catch (e) { rec('harness error', false, String(e).slice(0, 200)) }
finally { await fetch(`${cdp}/json/close/${tab.id}`).catch(() => {}); ws.close(); const failed = results.filter((r) => !r.ok).length; console.log(failed ? `${failed} failed` : 'all passed'); process.exit(failed ? 1 : 0) }
