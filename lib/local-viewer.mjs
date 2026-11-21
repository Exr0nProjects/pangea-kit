// Standalone local viewer for published kit pages: no private host, no dependencies.
// Serves <root>/<ULID>/ at /view/<ULID>/ with the same sandbox CSP the hosted viewer uses, and speaks the page's live
// channel (`__live`: hello {files}, code {files} when a file changes, state <json> when state.json changes; `__view`
// POST stores the page's last reported view in view.json), so `publish --into <ULID>` hot-swaps an open page.
//
//   node lib/local-viewer.mjs [--root DIR] [--port 4180]      (root default: PANGEA_KIT_LOCAL_ROOT or ./.pangea-kit/pages)
//
// `ensureLocalViewer()` starts it detached when nothing answers on the port, so `publish --local` is one command.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const LOCAL_ROOT = () => path.resolve(process.env.PANGEA_KIT_LOCAL_ROOT || path.join(process.cwd(), '.pangea-kit', 'pages'))
export const LOCAL_PORT = () => Number(process.env.PANGEA_KIT_LOCAL_PORT || 4180)
export const LOCAL_BASE = () => process.env.PANGEA_KIT_VIEW_BASE || `http://127.0.0.1:${LOCAL_PORT()}`

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.bin': 'application/octet-stream' }
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u
const HIDDEN = new Set(['state.json', 'view.json', 'SOURCE.json'])
// The hosted viewer's artifact CSP: scripts inline only, no network except this page's own prefix, no frames, sandboxed origin.
export const csp = (prefix) => `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; worker-src blob:; connect-src ${prefix}; frame-src 'none'`

function listFiles(dir, rel = '', out = {}) {
  for (const n of fs.readdirSync(path.join(dir, rel))) {
    if (n.startsWith('.')) continue
    const r = rel ? `${rel}/${n}` : n, st = fs.statSync(path.join(dir, r))
    if (st.isDirectory()) listFiles(dir, r, out)
    else if (!HIDDEN.has(r)) out[r] = crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, r))).digest('hex').slice(0, 12)
  }
  return out
}

export function createLocalViewer({ root = LOCAL_ROOT(), pollMs = 600 } = {}) {
  root = path.resolve(root)
  const streams = new Set() // { res, ulid, files, state }
  const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  const stateOf = (ulid) => { try { return fs.readFileSync(path.join(root, ulid, 'state.json'), 'utf8') } catch { return '' } }
  const server = http.createServer((q, r) => {
    const url = new URL(q.url, 'http://x'), parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (parts.length === 0) { // an index of the pages on disk
      const ids = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => ULID.test(n)) : []
      r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      r.end(`<!doctype html><title>pangea-kit local pages</title><ul>${ids.map((i) => `<li><a href="/view/${i}/">${i}</a></li>`).join('') || '<li>nothing published yet</li>'}</ul>`)
      return
    }
    if (parts[0] !== 'view' || !ULID.test(parts[1] || '')) { r.writeHead(404); r.end('not found'); return }
    const ulid = parts[1], dir = path.join(root, ulid), rel = parts.slice(2).join('/')
    if (!fs.existsSync(dir)) { r.writeHead(404); r.end('no such page'); return }
    if (url.pathname === `/view/${ulid}`) { r.writeHead(308, { location: `/view/${ulid}/` }); r.end(); return }
    const prefix = `http://${q.headers.host}/view/${ulid}/`
    if (rel === '__live') {
      r.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*', connection: 'keep-alive' })
      const s = { res: r, ulid, files: listFiles(dir), state: stateOf(ulid) }
      sse(r, 'hello', { files: s.files }); if (s.state) { try { sse(r, 'state', JSON.parse(s.state)) } catch { /* ignore a half-written file */ } }
      streams.add(s); q.on('close', () => streams.delete(s)); return
    }
    if (rel === '__view') {
      if (q.method === 'OPTIONS') { r.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' }); r.end(); return }
      if (q.method !== 'POST') { r.writeHead(405); r.end(); return }
      const chunks = []; q.on('data', (c) => chunks.push(c)); q.on('end', () => { try { fs.writeFileSync(path.join(dir, 'view.json'), Buffer.concat(chunks)) } catch { /* best effort */ } r.writeHead(204, { 'access-control-allow-origin': '*' }); r.end() }); return
    }
    const f = path.join(dir, rel || 'index.html')
    if (!f.startsWith(dir + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { r.writeHead(404); r.end('not found'); return }
    r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'content-security-policy': csp(prefix), 'cache-control': 'no-store', 'access-control-allow-origin': '*' }) // the sandbox gives the page an opaque origin: its own fetches are cross-origin and need CORS
    fs.createReadStream(f).pipe(r)
  })
  const timer = setInterval(() => { // push code and state changes to every open page
    for (const s of streams) {
      try {
        const dir = path.join(root, s.ulid), files = listFiles(dir)
        if (JSON.stringify(files) !== JSON.stringify(s.files)) { s.files = files; sse(s.res, 'code', { files }) }
        const st = stateOf(s.ulid); if (st && st !== s.state) { s.state = st; sse(s.res, 'state', JSON.parse(st)) }
      } catch { /* a file mid-rename: next tick */ }
    }
  }, pollMs); timer.unref()
  server.on('close', () => clearInterval(timer))
  return server
}

/** True when something answers /healthz-like GET / on the local port. */
export const viewerUp = (port = LOCAL_PORT()) => new Promise((res) => { const q = http.get({ host: '127.0.0.1', port, path: '/', timeout: 700 }, (r) => { r.resume(); res(r.statusCode === 200) }); q.on('error', () => res(false)); q.on('timeout', () => { q.destroy(); res(false) }) })

/** Start the viewer detached if it is not running; resolves with its pid when started, 0 when one was already up. stdio is ignored and the child unref'd so the calling CLI exits at once. */
export async function ensureLocalViewer({ root = LOCAL_ROOT(), port = LOCAL_PORT() } = {}) {
  if (await viewerUp(port)) return 0
  fs.mkdirSync(root, { recursive: true })
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--root', root, '--port', String(port)], { detached: true, stdio: 'ignore' }); child.unref()
  for (let i = 0; i < 30; i++) { if (await viewerUp(port)) return child.pid; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error(`local viewer did not start on port ${port}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2), opt = (n, d) => { const i = a.indexOf(n); return i < 0 ? d : a[i + 1] }
  const root = path.resolve(opt('--root', LOCAL_ROOT())), port = Number(opt('--port', LOCAL_PORT()))
  fs.mkdirSync(root, { recursive: true })
  createLocalViewer({ root }).listen(port, '127.0.0.1', () => console.log(`pangea-kit local viewer: http://127.0.0.1:${port}/ serving ${root} (loopback only)`))
}
