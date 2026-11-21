// Boot smoke gate: load the BUILT page in headless Chrome, wait, RELOAD, wait, and fail on anything that should never
// happen on a plain boot: an uncaught error, an unhandled rejection, a console.error, a 'Maximum call stack' text, a long
// task over 200 ms after the first 3 s of a load. Long tasks over 50 ms are only reported (warnings).
//
// Why a reload: the second load exercises everything that is restored from persisted state (window.name / server
// record / IndexedDB). The 2026-11-18 live stack overflow (MotionCache restore pending -> onUpdate -> get -> _kick ->
// _loop -> onUpdate, synchronous recursion) only happened there, and every unit test used a store that resolved at once.
//
// Driver: raw CDP over Node's global WebSocket, own temp profile and a loopback static server; nothing of the owner's
// Chrome is touched. No Playwright needed.
import { spawn, execFileSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const BENIGN = [/ResizeObserver loop/i]
export const LONGTASK_FAIL_MS = 200
export const LONGTASK_WARN_MS = 50
export const LONGTASK_GRACE_MS = 3000

export function findChrome() {
  const cands = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)
  for (const c of cands) if (fs.existsSync(c)) return c
  for (const n of ['google-chrome', 'chromium', 'chromium-browser']) { try { return execFileSync('which', [n], { encoding: 'utf8' }).trim() || null } catch { /* next */ } }
  return null
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' }
function listFiles(root) { const files = {}; (function walk(d, p) { for (const f of fs.readdirSync(d)) { const fp = path.join(d, f); if (fs.statSync(fp).isDirectory()) walk(fp, `${p}${f}/`); else if (!['SOURCE.json', 'view.json'].includes(f)) files[p + f] = 'h1' } })(root, ''); return files }
function serveDir(dir, overrides = {}) {
  const root = path.resolve(dir)
  const s = http.createServer((q, r) => {
    if (q.url.startsWith('/__live')) { r.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); r.write(`event: hello\ndata: ${JSON.stringify({ files: listFiles(root) })}\n\n`); return } // the quicklook live channel: the hello event the page waits for, then held open
    if (q.url.startsWith('/__view')) { r.writeHead(200); r.end('ok'); return }
    const u = decodeURIComponent(q.url.split('?')[0]), f = path.join(root, u === '/' ? 'index.html' : u)
    if (overrides[u]) { r.writeHead(200, { 'content-type': TYPES[path.extname(u)] || 'application/octet-stream' }); r.end(overrides[u]); return }
    if (!f.startsWith(root)) { r.writeHead(403); r.end(); return }
    fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); r.end('nf'); return } r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); r.end(b) })
  })
  return new Promise((res) => s.listen(0, '127.0.0.1', () => res(s)))
}

// installed before any page script: records errors, rejections, console.error and long tasks into window.__bootgate
const HOOK = `(() => {
  Error.stackTraceLimit = Infinity
  const G = (window.__bootgate = { errors: [], longtasks: [] })
  const trim = (e, msg) => { const s = String((e && e.stack) || msg || e).split('\\n'); return { n: s.length, head: s.slice(0, 3), tail: s.length > 9 ? s.slice(-6) : s.slice(3) } }
  addEventListener('error', (e) => G.errors.push({ kind: 'error', message: String(e.message || (e.error && e.error.message) || e.error), ...trim(e.error, e.message) }))
  addEventListener('unhandledrejection', (e) => G.errors.push({ kind: 'unhandledrejection', message: String((e.reason && e.reason.message) || e.reason), ...trim(e.reason) }))
  const ce = console.error.bind(console)
  console.error = (...a) => { try { G.errors.push({ kind: 'console.error', message: a.map((x) => (x && x.message) || String(x)).join(' ').slice(0, 400), ...trim(a.find((x) => x && x.stack), '') }) } catch {} ce(...a) }
  try { new PerformanceObserver((l) => { for (const x of l.getEntries()) G.longtasks.push({ start: Math.round(x.startTime), ms: Math.round(x.duration) }) }).observe({ type: 'longtask', buffered: true }) } catch {}
})()`

// Dead controls: a visible control inside the kit's UI layer whose centre point hits the 3D canvas (or the page) instead of the control. The kit's #qk-ui is pointer-events:none so empty space orbits the camera; a control under it that does not opt back in swallows nothing and does nothing (2026-11-21 nmr applet, and several times before). Controls clipped by a scroll container or covered by another panel are not flagged: only a hit on the stage, canvas, body or html means the click fell through.
export const DEAD_CONTROLS_EXPR = `(() => {
  const root = document.getElementById('qk-ui'); if (!root) return []
  const out = [], vw = innerWidth, vh = innerHeight
  for (const e of root.querySelectorAll('button, input, select, textarea, summary, a[href], [role=button], [role=slider], [role=checkbox]')) {
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e)
    if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none' || e.disabled) continue
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    if (x < 0 || y < 0 || x > vw || y > vh) continue
    const t = document.elementFromPoint(x, y)
    if (t && !e.contains(t) && !t.contains(e) && (t.tagName === 'CANVAS' || t.tagName === 'HTML' || t.tagName === 'BODY' || t.id === 'qk-stage')) out.push((e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + ' "' + (e.textContent || e.getAttribute('aria-label') || e.type || '').trim().slice(0, 24) + '" at ' + Math.round(x) + ',' + Math.round(y) + ' (pointer-events:' + cs.pointerEvents + ') hit <' + t.tagName.toLowerCase() + '>'))
  }
  return out
})()`

function cdp(ws) {
  let id = 0; const pend = new Map()
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id) } }
  return (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
}

/** Run the gate on a built output dir (index.html at its root). Resolves { ok, errors, warnings, loads, skipped? }. */
export async function bootGate(dir, { waitMs = 8000, readyExpr = null, quietMs = 1000, minMs = 2000, extraChecks = [], view = null, chrome = findChrome(), log = () => {} } = {}) {
  if (!chrome) return { ok: false, skipped: true, errors: [], warnings: [], loads: [], reason: 'no Chrome found (set CHROME_BIN)' }
  const srv = await serveDir(dir, view ? { '/view.json': typeof view === 'string' ? view : JSON.stringify(view) } : {}), port = srv.address().port
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'bootgate-'))
  const p = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--use-angle=metal', '--disable-gpu-sandbox', '--enable-unsafe-webgpu', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
  let ws
  const cleanup = () => { try { ws?.close() } catch { /* gone */ } try { p.kill('SIGKILL') } catch { /* gone */ } srv.close(); try { fs.rmSync(prof, { recursive: true, force: true }) } catch { /* gone */ } }
  try {
    let dport = null
    for (let i = 0; i < 100 && !dport; i++) { try { dport = fs.readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch { await sleep(100) } }
    if (!dport) throw new Error('boot gate: Chrome did not open a debugging port')
    let list = []; for (let i = 0; i < 50 && !list.some((t) => t.type === 'page'); i++) { try { list = await (await fetch(`http://127.0.0.1:${dport}/json`)).json() } catch { await sleep(100) } }
    const tgt = list.find((t) => t.type === 'page'); if (!tgt) throw new Error('boot gate: no page target')
    ws = new WebSocket(tgt.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('boot gate: CDP socket failed')) })
    const send = cdp(ws)
    await send('Runtime.enable'); await send('Page.enable')
    await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK })
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value }
    const errors = [], warnings = [], loads = []
    // wait for the page instead of sleeping: stop at the first recorded error (a stack overflow shows ~100 ms after start), else when the app says ready (readyExpr) AND the main thread has had no long task for quietMs, after at least minMs; waitMs is only the cap
    const settle = async () => {
      const t0 = Date.now()
      for (;;) {
        await sleep(200); const el = Date.now() - t0; if (el >= waitMs) return
        let st = null; try { st = await ev(`(async()=>{const g=window.__bootgate;if(!g)return null;const last=Math.max(0,...g.longtasks.filter((l)=>l.ms>150).map((l)=>l.start+l.ms));let ready=true;${readyExpr ? `try{ready=!!(${readyExpr})}catch(e){ready=false}` : ''}await new Promise((r)=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {errs:g.errors.length,quiet:performance.now()-last,ready}})()`) } catch { st = null }
        if (st && st.errs > 0) return
        if (st && el >= minMs && st.ready && st.quiet >= quietMs) return
      }
    }
    const collect = async (n) => {
      const g = JSON.parse((await ev('JSON.stringify(window.__bootgate || null)')) || 'null')
      if (!g) { errors.push({ load: n, kind: 'boot', message: 'the page never installed the hook (did not load?)', head: [], tail: [] }); return }
      for (const e of g.errors) { const txt = `${e.message} ${(e.head || []).join(' ')}`; if (BENIGN.some((re) => re.test(txt))) continue; errors.push({ load: n, ...e }) }
      for (const l of g.longtasks) {
        if (l.ms > LONGTASK_FAIL_MS && l.start > LONGTASK_GRACE_MS) errors.push({ load: n, kind: 'longtask', message: `a ${l.ms} ms long task at ${l.start} ms after load (limit ${LONGTASK_FAIL_MS} ms)`, head: [], tail: [] })
        else if (l.ms > LONGTASK_WARN_MS) warnings.push({ load: n, kind: 'longtask', message: `${l.ms} ms long task at ${l.start} ms` })
      }
      loads.push({ load: n, errors: g.errors.length, longtasks: g.longtasks.length })
    }
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/index.html` }); await settle(); await collect(1)
    await send('Page.reload', {}); await settle(); await collect(2)
    { let dead = []; try { dead = (await ev(DEAD_CONTROLS_EXPR)) || [] } catch { /* page gone: the other checks report it */ } for (const d of dead) errors.push({ load: 2, kind: 'dead-control', message: `control does not receive clicks, they fall through to the canvas: ${d}. Mounted parts are clickable by default; check for pointer-events:none on the control or an ancestor (docs/PITFALLS.md 29)`, head: [], tail: [] }) }
    for (const expr of extraChecks) { let v; try { v = await ev(`(async()=>!!(${expr}))()`) } catch { v = false } if (!v) errors.push({ load: 2, kind: 'extraCheck', message: `app check is falsy after reload: ${expr}`, head: [], tail: [] }) }
    for (const e of errors) if (/Maximum call stack/i.test(`${e.message} ${(e.head || []).join(' ')}`)) e.kind = `${e.kind} (stack overflow)`
    log(`boot gate: ${loads.length} loads, ${errors.length} errors, ${warnings.length} warnings`)
    return { ok: errors.length === 0, errors, warnings, loads }
  } finally { cleanup() }
}

export const formatBootGate = (r) => r.skipped ? `boot gate skipped: ${r.reason}` : r.errors.map((e) => `  [load ${e.load}] ${e.kind}: ${e.message}${e.n > 9 ? ` (stack ${e.n} frames)` : ''}${e.head?.length ? `\n      ${e.head.join('\n      ')}` : ''}${e.tail?.length && e.n > 9 ? `\n      ...\n      ${e.tail.join('\n      ')}` : ''}`).join('\n')

/** App-level options: <appDir>/validation/bootgate.json { waitMs, extraChecks: [js expression], viewFile: 'name.json' } ; viewFile (in the same validation dir) is served as the page's view.json, the saved state it boots with: a representative state that reaches the app's heavy code (a staged page has no view.json, so it would boot the default state only) */
export function readAppBootConfig(appDir) {
  let c = {}; try { c = JSON.parse(fs.readFileSync(path.join(appDir, 'validation', 'bootgate.json'), 'utf8')) } catch { return {} }
  if (c.viewFile) { try { c.view = fs.readFileSync(path.join(appDir, 'validation', c.viewFile), 'utf8') } catch { /* no view file: default state */ } }
  return c
}
