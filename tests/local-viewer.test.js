// The standalone local viewer: sandbox CSP, CORS for the sandboxed page, the live channel, no path escape, and a CLI that spawns it exits promptly.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createLocalViewer, ensureLocalViewer, viewerUp } from '../lib/local-viewer.mjs'

const ULID = '01M800ATQDGW1DW4QEXJEC3YRG'
const get = (port, p, opts = {}) => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port, path: p, ...opts }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b })) }); q.on('error', rej); q.end() })
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))

describe('local viewer', () => {
  it('serves a page with the sandbox CSP and CORS, a live hello, and refuses path escapes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qk-lv-')); fs.mkdirSync(path.join(root, ULID)); fs.writeFileSync(path.join(root, ULID, 'index.html'), '<p>hi</p>'); fs.writeFileSync(path.join(root, 'secret.txt'), 'no')
    const srv = createLocalViewer({ root }); const port = await listen(srv)
    try {
      const page = await get(port, `/view/${ULID}/`)
      expect(page.status).toBe(200); expect(page.body).toBe('<p>hi</p>')
      expect(page.headers['content-security-policy']).toMatch(/^sandbox allow-scripts; default-src 'none'.*frame-src 'none'$/)
      expect(page.headers['content-security-policy']).toContain(`connect-src http://127.0.0.1:${port}/view/${ULID}/`)
      expect(page.headers['access-control-allow-origin']).toBe('*') // the sandboxed page has an opaque origin: its fetches are cross-origin
      expect((await get(port, `/view/${ULID}/../secret.txt`)).status).toBe(404)
      expect((await get(port, `/view/${ULID}/%2e%2e/secret.txt`)).status).toBe(404)
      expect((await get(port, '/view/NOTAULID/')).status).toBe(404)
      const live = await new Promise((res) => { const q = http.get({ host: '127.0.0.1', port, path: `/view/${ULID}/__live` }, (r) => { r.once('data', (c) => { res(String(c)); q.destroy() }) }) })
      expect(live).toMatch(/^event: hello\ndata: \{"files":\{.*"index\.html"/)
    } finally { srv.close(); srv.closeAllConnections?.() }
  })

  it('a CLI that starts the viewer exits within a few seconds even with its stdout piped (the child holds no pipe)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qk-lv-')); const port = 41000 + Math.floor(Math.random() * 2000)
    const here = path.resolve(import.meta.dirname, '../lib/local-viewer.mjs')
    const t0 = Date.now()
    const out = await new Promise((res) => { const c = spawn(process.execPath, ['--input-type=module', '-e', `import { ensureLocalViewer } from ${JSON.stringify(here)}; console.log(await ensureLocalViewer({ root: ${JSON.stringify(root)}, port: ${port} }))`], { stdio: ['ignore', 'pipe', 'pipe'] }); let b = ''; c.stdout.on('data', (d) => (b += d)); c.on('close', () => res(b.trim())) })
    const pid = Number(out)
    try { expect(Date.now() - t0).toBeLessThan(5000); expect(pid).toBeGreaterThan(0); expect(await viewerUp(port)).toBe(true) } finally { try { process.kill(pid) } catch { /* already gone */ } }
  }, 15000)
})
