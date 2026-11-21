#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { publish, push, stage, QUICKLOOK_ROOT, viewBase } from '../lib/publish.mjs'
import { gate } from '../lib/editor/gate.mjs'
import { bootGate, formatBootGate } from '../lib/bootgate.mjs'

const [cmd, ...rest] = process.argv.slice(2)
if (rest.includes('--local')) { process.env.PANGEA_KIT_LOCAL = '1'; rest.splice(rest.indexOf('--local'), 1) } // publish to the standalone local viewer (also the default when no hosted publisher is configured)
const flag = (name) => { const i = rest.indexOf(name); if (i < 0) return null; const v = rest[i + 1]; rest.splice(i, 2); return v }
const bool = (name) => { const i = rest.indexOf(name); if (i < 0) return false; rest.splice(i, 1); return true }
const usage = `pangea-kit publish <appdir> [--into <ULID>] [--local] [--rebuild-host] [--scratch] [--allow-undef]
                                       built from a clean commit on main (app and kit, git archive export, BUILD.json stamped);
                                       --scratch: a non-git or throwaway page from the working tree, logged, stamped dirty: true,
                                       refused for a deploy-registry app and for a page a commit publish made
pangea-kit bootgate <dir>             boot smoke gate on a built dir (a quicklook artifact dir): load, reload, fail on errors; publish runs it (--no-gate skips)
pangea-kit push <ULID> '<json>'     a bare object is a patch (names only the keys it sets); {"op":"set","payload":{"path":"a.b","value":1}} is an action
pangea-kit view <ULID>              print what the open page last reported (view.json)
pangea-kit build <appdir>           stage only, print the stage dir
pangea-kit gate <appdir> [--only a,b]  the deploy gate: lint, then the editor's unit and browser checks; exit 1 refuses`

try {
  if (cmd === 'publish') {
    const into = flag('--into'), forceHost = bool('--rebuild-host'), scratch = bool('--scratch')
    const r = await publish(rest[0], { into, forceHost, scratch, allowUndef: bool('--allow-undef'), noGate: bool('--no-gate') })
    const direct = `${viewBase()}/view/${r.ulid}/`
    console.log(JSON.stringify({ ulid: r.ulid, url: direct, build: r.build.build_id, dirty: r.build.dirty, changed: r.changed, unchanged: r.same.length, removed: r.removed }, null, 2))
  } else if (cmd === 'bootgate') {
    const r = await bootGate(rest[0], { log: (m) => console.error(m) }); console.log(JSON.stringify({ ok: r.ok, loads: r.loads, warnings: r.warnings, errors: r.errors }, null, 1)); if (!r.ok) { console.error(formatBootGate(r)); process.exit(1) }
  } else if (cmd === 'push') {
    console.log(JSON.stringify(push(rest[0], rest[1])))
  } else if (cmd === 'view') {
    console.log(fs.readFileSync(path.join(QUICKLOOK_ROOT(), rest[0], 'view.json'), 'utf8'))
  } else if (cmd === 'gate') {
    const only = flag('--only')
    const r = await gate(path.resolve(rest[0] || '.'), { only: only ? only.split(',') : null })
    console.log(JSON.stringify({ ok: r.ok, lint: r.lint?.ok, unit: r.unit?.ok, browser: r.browser && Object.fromEntries(Object.entries(r.browser.results).map(([k, v]) => [k, v.ok ? 'ok' : v.detail])), measurements: r.browser?.measurements }, null, 1))
    process.exit(r.ok ? 0 : 1)
  } else if (cmd === 'build') {
    console.log(await stage(rest[0]))
  } else { console.error(usage); process.exit(cmd ? 2 : 0) }
} catch (e) { console.error(`pangea-kit: ${e.message}`); process.exit(1) }
