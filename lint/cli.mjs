#!/usr/bin/env node
// quicklook-lint [root] [--json] [--init | --ratchet]
//   no flag    check: exit 1 on a new violation or a stale allowance, printing how to do it in the kit
//   --init     freeze today's counts into quicklook-lint.allow.json (adopting the lint on an existing app)
//   --ratchet  lower allowances to today's counts (never raises one)
import { resolve } from 'node:path';
import { format, lintApp, writeAllow } from './run.js';

const args = process.argv.slice(2);
const root = resolve(args.find((a) => !a.startsWith('--')) || process.cwd());
const res = await lintApp({ root });
if (args.includes('--init') || args.includes('--ratchet')) {
  writeAllow(root, res.counts, { mode: args.includes('--init') ? 'init' : 'ratchet' });
  console.log(`quicklook-lint: wrote ${root}/quicklook-lint.allow.json`);
  process.exit(0);
}
if (args.includes('--json')) {
  console.log(JSON.stringify({ ok: res.ok, over: res.over.map((o) => ({ ...o, rule: o.rule.id })), stale: res.stale.map((o) => ({ ...o, rule: o.rule.id })), off: res.off, totals: Object.fromEntries(Object.entries(res.counts).map(([k, v]) => [k, Object.values(v).reduce((a, b) => a + b, 0)])) }, null, 1));
} else {
  const text = format(res);
  if (text) console.log(text);
  console.log(`quicklook-lint: ${res.rules.length} rules, ${res.over.length} new violations, ${res.stale.length} stale allowances`);
}
process.exit(res.ok ? 0 : 1);
