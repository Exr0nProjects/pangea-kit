// lib/engine/ephemeral.js: the sanctioned non-durable POST (presence, boot): JSON body and headers, a deadline on every call,
// no retry and no outbox, and the lint rule that makes it the way (an app's own `method: 'POST'` is flagged, this file is not).
import { describe, expect, it } from 'vitest'
import { createEphemeralPost } from '../lib/engine/ephemeral.js'
import { lintApp } from '../lint/run.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('createEphemeralPost', () => {
  it('sends a JSON POST with the credentials and keepalive it was given, and resolves the Response', async () => {
    const seen = []
    const post = createEphemeralPost(async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200 } })
    const r = await post('/api/docs/x/presence', { body: { away: true }, keepalive: true })
    expect(r.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('/api/docs/x/presence')
    expect(seen[0].init).toMatchObject({ method: 'POST', credentials: 'same-origin', keepalive: true, body: '{"away":true}' })
    expect(seen[0].init.headers['content-type']).toBe('application/json')
    expect(seen[0].init.signal).toBeDefined()
  })
  it('a body-less POST (a session open) has no content-type and no body, and a cache mode passes through', async () => {
    const seen = []
    const post = createEphemeralPost(async (url, init) => { seen.push(init); return { ok: true } })
    await post('/api/boot?doc=x', { klass: 'read', cache: 'no-store' })
    expect(seen[0]).toMatchObject({ method: 'POST', cache: 'no-store' })
    expect(seen[0].body).toBeUndefined(); expect(seen[0].headers).toBeUndefined(); expect(seen[0].keepalive).toBeUndefined()
  })
  it('a send that never answers is bounded by its class deadline, with no retry', async () => {
    let calls = 0
    const post = createEphemeralPost((url, init) => { calls += 1; return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))) }, { deadlines: { telemetry: 20, read: 20 } })
    await expect(post('/p', { body: {} })).rejects.toMatchObject({ name: 'DeadlineError' })
    expect(calls).toBe(1)
  })
  it('an unknown class is refused', () => {
    const post = createEphemeralPost(async () => ({}))
    return expect(post('/p', { klass: 'nope' })).rejects.toThrow(/no deadline class/)
  })
  it('lint: an app that sends its presence through it is clean of both rules, a hand-written POST is not', async () => {
    const app = mkdtempSync(join(tmpdir(), 'ql-eph-'))
    try {
      mkdirSync(join(app, 'src'))
      writeFileSync(join(app, 'src/good.js'), "import { createEphemeralPost } from 'kit/engine/ephemeral.js'\nconst post = createEphemeralPost(fetch)\nexport const send = (p) => post('/presence', { body: p })\n")
      expect((await lintApp({ root: app, allow: { rules: {}, off: {} } })).ok).toBe(true)
      writeFileSync(join(app, 'src/bad.js'), "export const send = (p) => fetch('/presence', { method: 'POST', body: JSON.stringify(p) })\n")
      const res = await lintApp({ root: app, allow: { rules: {}, off: {} } })
      expect(res.over.map((o) => `${o.rule.id}`).sort()).toEqual(expect.arrayContaining(['durable-write-outside-outbox', 'fetch-without-deadline']))
    } finally { rmSync(app, { recursive: true, force: true }) }
  })
})
