// One seeded violation and its clean twin per rule: [rule id, path it pretends to live at, bad text, good text].
// tests/lint.test.js requires a seed for every rule in lint/rules.js, so a rule cannot ship without being shown red.
// Apps adding rules in quicklook-lint.rules.mjs export `seeds` in the same shape and run selfTest() on them.
export const seeds = [
  ['direct-storage-write', 'src/lib/prefs.js', "localStorage.setItem('scale', '1.2');", "prefs.dispatch('scale.set', { px: 1.2 });"],
  ['durable-write-outside-outbox', 'src/lib/ui/X.svelte', "fetch('/api/notes', { method: 'POST', body, signal })", "notes.dispatch('note.add', { id, body });"],
  ['indexeddb-writer', 'src/lib/cache.js', "const db = indexedDB.open('mine', 1);", "const rows = replica.view();"],
  ['pref-read-on-mount', 'src/lib/ui/X.svelte', "onMount(() => { scale = Number(localStorage.getItem('scale')) || 1; });", 'onMount(() => { measure(); });'],
  ['reducer-clock-or-random', 'src/lib/notes.js', "import { declare } from 'pangea-kit/lib/model.js'; declare({ name: 'n', initial: {}, actions: { add: (s, p) => ({ ...s, at: Date.now() }) } });", "import { declare } from 'pangea-kit/lib/model.js'; declare({ name: 'n', initial: {}, actions: { add: (s, p) => ({ ...s, at: p.at }) } });"],
  ['unenforced-axis', 'src/lib/notes.js', "declare({ name: 'n', durability: 'persistent', initial: {}, actions })", "declare({ name: 'n', scope: 'cloud', initial: {}, actions })"],
  ['content-hash-id', 'src/lib/actions.js', 'const intentId = sha256(JSON.stringify({ type, payload }));', 'const intentId = ulid();'],
  ['handler-sync-io', 'src/routes/api/x/+server.js', "export async function GET() { return new Response(readFileSync('/x')); }", "export async function GET() { return new Response(await readFile('/x')); }"],
  ['handler-spawn', 'src/routes/api/x/+server.js', "export async function POST() { spawn('git', ['log']); }", "export async function POST() { jobs.push({ kind: 'git-log' }); }"],
  ['handler-unbounded-select', 'src/routes/api/x/+server.js', "db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY ts').all(k)", "db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY ts LIMIT ?').all(k, 50)"],
  ['fetch-without-deadline', 'src/lib/api.js', "const r = await fetch('/api/x');", "const r = await net.fetchWithin('read', '/api/x');"],
  ['interval-without-owner', 'src/lib/presence.js', 'setInterval(() => ping(), 5000);', "every('presence', 5000, () => ping(), { budgetMs: 4 });"],
  ['unbounded-queue', 'src/lib/send.js', 'const sendQueue = [];', "const sendQueue = boundedQueue({ name: 'send', maxItems: 500, maxBytes: 1 << 20, policy: 'refuse' });"],
  ['server-homedir', 'src/lib/server/store.js', "const p = join(homedir(), '.local/state/x');", "const p = join(stateDir(), 'x');"],
  ['meta-or-ctrl', 'src/lib/ui/X.svelte', "if ((event.metaKey || event.ctrlKey) && event.key === 'b') toggle();", "if (isAccel(event) && event.key === 'b') toggle();"],
  ['narrow-media-hides-control', 'src/lib/ui/X.svelte', '<style>@media (max-width: 860px) { .model-select { display: none; } }</style>', '<style>@media (max-width: 860px) { .model-select { flex-basis: 100%; } }</style>'],
  ['editor-dom-read', 'src/main.js', "import { createEditor } from 'kit/editor/editor.js'; const st = scroller.scrollTop;", "import { createEditor } from 'kit/editor/editor.js'; const st = editor.viewport().top_px;"],
  ['editor-app-state', 'src/main.js', "import { createEditor } from 'kit/editor/editor.js';\nlet pinned = false;", "import { createEditor } from 'kit/editor/editor.js';\nconst PAGE = 300;"],
  ['editor-without-contract', 'src/main.js', 'createEditor({ root, app, doc })', 'createEditor({ root, app, doc, contract })'],
  ['focus-outside-intent', 'src/lib/ui/X.svelte', "function open() { field.focus({ preventScroll: true }); }", "function open() { intent.dispatch('openPane', { pane }); }"],
  ['root-overscroll-none', 'src/app.css', 'html, body { overscroll-behavior: none; }', 'html, body { overscroll-behavior-y: none; }'],
];

/** Problems with a rule set's seeds: missing seed, seed out of scope, bad text not caught, good text flagged. */
export function selfTest(rules, seedList, ctx = {}) {
  const problems = [];
  const by = new Map(seedList.map((s) => [s[0], s]));
  for (const r of rules) {
    const s = by.get(r.id);
    if (!s) { problems.push(`${r.id}: no seeded violation`); continue; }
    const [, rel, bad, good] = s;
    if (!r.scope(rel, ctx)) problems.push(`${r.id}: seed path ${rel} is outside the rule's scope`);
    else {
      if (!(r.count(bad, rel, ctx) > 0)) problems.push(`${r.id}: misses its seeded violation`);
      if (r.count(good, rel, ctx) !== 0) problems.push(`${r.id}: flags its clean twin`);
    }
    for (const k of ['prevents', 'how']) if (!r[k]) problems.push(`${r.id}: no ${k} line`);
  }
  return problems;
}
