// quicklook-lint rules: the generic structural checks every kit app gets with zero config (docs/LINT.md).
// The owner, 2026-11-08 06:54 PST: "build the checks in structurally where possible to avoid classes of bugs"; 06:57-06:58:
// "a lot of this chat work should belong in the base pangea kit no?" / "Goal is both robust chat and also an easy to use kit".
//
// A rule is data plus a pure counter: { id, cls, prevents, how, guide, scope(rel, ctx), count(text, rel, ctx) }.
// `rel` is the path relative to the app root with forward slashes. `how` is the one-line fix in kit terms, `guide` the
// docs/LINT.md anchor; both are printed on failure. Counts are ratcheted per file (lint/allow.js), so an app adopts the lint
// with its current count frozen and can only go down.

// The kit's engine is the one owner of storage, IndexedDB and the outbox; the rules that say "go through the kit" skip it.
export const KIT_OWNER = /(^|\/)lib\/engine\//;
// The kit editor adapter is the one reader of layout and DOM selection in an editor app.
// and the app's editor definition (src/editor.js: pure render + reducer, the contract) is part of that adapter layer.
export const EDITOR_OWNER = /(^|\/)lib\/editor\/|(^|\/)src\/editor\.js$/;
export const USES_EDITOR = /from\s+['"][^'"]*editor\/editor\.js['"]|\bcreateEditor\s*\(/;
// The kit's one DOM-apply effect for the intent record: the only module that may move DOM focus.
export const INTENT_OWNER = /(^|\/)lib\/intent-dom\.js$/;
const FOCUS_CALL = /\.\s*(?:focus|blur)\s*\(/g;
const FOCUS_FLAG = /\b(?:let|const|var)\s+[\w$]*(?:[fF]ocused|[aA]utofocus|[cC]laimedFocus|[hH]asFocus|[iI]sFocus\w*)[\w$]*\s*=\s*\$state\b/g;
/** An app is an editor app when lintApp found the kit editor anywhere in it (ctx.editorApp), else when this file imports it. */
const editorApp = (t, ctx) => ctx?.editorApp ?? USES_EDITOR.test(t);

/** Comments are not code: block comments, HTML comments and // line comments (not the // inside a URL). */
export const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|[^:'"`\w\\])\/\/.*$/gm, '$1');

const count = (text, re) => (text.match(re) || []).length;

/** The balanced (...) or {...} group whose opening char sits at `open`. */
export function groupAt(text, open) {
  const o = text[open], c = o === '(' ? ')' : o === '{' ? '}' : null;
  if (!c) return '';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === o) depth++;
    else if (text[i] === c && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}
/** Every balanced group opened by `ch` at the end of a `re` match. */
export function groupsAfter(text, re, ch) {
  const out = [];
  for (const m of text.matchAll(re)) {
    const at = text.indexOf(ch, m.index + m[0].length - 1);
    if (at >= 0) out.push(groupAt(text, at));
  }
  return out;
}

// Default file classes. Zero config: SvelteKit `+server.js` routes and any `handlers/` dir are request handlers; anything
// under a `server/` dir is server code; tests, oracles and the lint itself are skipped; the rest of the source is client.
export const classes = {
  test: (rel) => /\.(test|spec)\.[cm]?[jt]s$|(^|\/)__oracle__\/|(^|\/)lint\/|(^|\/)(tests?|fixtures|conformance)\//.test(rel),
  source: (rel) => /\.(m?[jt]s|svelte)$/.test(rel) && !classes.test(rel),
  handler: (rel) => classes.source(rel) && /(^|\/)routes\/(.*\/)?\+server\.[jt]s$|(^|\/)handlers?\//.test(rel),
  server: (rel) => classes.source(rel) && (classes.handler(rel) || /(^|\/)server\//.test(rel)),
  client: (rel) => classes.source(rel) && !classes.server(rel),
  style: (rel) => /\.(svelte|css)$/.test(rel) && !classes.test(rel),
};

const SYNC_IO = /(?<![.\w$])(?:fs\.)?(readFileSync|writeFileSync|appendFileSync|existsSync|statSync|lstatSync|readdirSync|openSync|writeSync|fsyncSync|mkdirSync|rmSync|unlinkSync|renameSync|copyFileSync|execSync|execFileSync|spawnSync)\s*\(/g;
const SPAWN = /(?<![.\w$])(?:child_process\.)?(spawn|execFile|fork)\s*\(/g;
const CLOCK = /\bDate\.now\s*\(|\bnew Date\s*\(\s*\)|\bMath\.random\s*\(|\bperformance\.now\s*\(|\bcrypto\.randomUUID\s*\(/g;
const STORAGE_WRITE = /\b(?:localStorage|sessionStorage)\??\.(?:setItem|removeItem|clear)\s*\(/g;
// Axes PANGEA3-DESIGN sec 5 names that the engine does not read yet (lint/axes.js holds the enforced list and its proof).
import { UNENFORCED_AXES } from './axes.js';
const AXIS_KEY = new RegExp(`(?:^|[,{\\s])(${UNENFORCED_AXES.join('|')})\\s*:`, 'g');

// an id or key assigned from a hash call whose argument is content (identity from content, not minted once; A7)
const HASH_ID = /\b([\w$]*(?:[iI]d|ID|[kK]ey))\s*(?:=|:)\s*(?:await\s+)?[\w$.]*?(?:sha\d+\w*|[hH]ash\w*|digest\w*|md5|fnv\w*|crc32)\s*\(/g;
const CONTENTISH = /JSON\.stringify|canonical\s*\(|\b(?:text|body|content|payload|value|data|html|markdown|words|line|row|action)\b/;

export const rules = [
  {
    id: 'direct-storage-write', cls: 'C01',
    prevents: 'hand-written localStorage/sessionStorage writes: a second persist path the kit cannot hydrate, migrate, sync or undo',
    how: "declare the state once (declare({ name, scope: 'local', fields, actions })) and dispatch; the kit saves it",
    guide: 'direct-storage-write', scope: (r) => classes.client(r) && !KIT_OWNER.test(r), count: (t) => count(t, STORAGE_WRITE),
  },
  {
    id: 'durable-write-outside-outbox', cls: 'C01',
    prevents: 'a mutating request sent straight from UI code, so a tab dying mid-request loses what he made',
    how: "dispatch on a scope: 'cloud' declaration; the kit appends to the durable outbox before any send",
    guide: 'durable-write-outside-outbox', scope: (r) => classes.client(r) && !KIT_OWNER.test(r) && !/outbox|replica|delivery|transport/i.test(r),
    count: (t) => count(t, /method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/g),
  },
  {
    id: 'indexeddb-writer', cls: 'C01',
    prevents: 'a second writer on browser storage (one IndexedDB writer per resource)',
    how: 'let the kit replica own storage; read through its store, never indexedDB.open in app code',
    guide: 'indexeddb-writer', scope: (r) => classes.client(r) && !KIT_OWNER.test(r), count: (t) => count(t, /indexedDB\.open\s*\(/g),
  },
  {
    id: 'pref-read-on-mount', cls: 'C01',
    prevents: 'a persisted preference read in onMount, after an effect already saved the default over it',
    how: 'declare the preference on the kit; it is read where it is declared, before any effect runs',
    guide: 'pref-read-on-mount', scope: (r) => classes.client(r) && r.endsWith('.svelte'),
    count: (t) => groupsAfter(t, /\bonMount\s*\(/g, '(').filter((g) => /getItem\s*\(/.test(g)).length,
  },
  {
    id: 'reducer-clock-or-random', cls: 'C02',
    prevents: 'a reducer reading the clock or randomness, so replicas folding one log diverge',
    how: 'mint the time or id once at the gesture and pass it in the payload; reducers stay pure',
    guide: 'reducer-clock-or-random', scope: (r) => classes.source(r),
    count: (t) => (/\bdeclare\s*\(|\bdeclareComponent\s*\(|pangea-kit/.test(t) ? groupsAfter(t, /\bactions\s*:\s*\{/g, '{').reduce((n, g) => n + count(g, CLOCK), 0) : 0),
  },
  {
    id: 'unenforced-axis', cls: 'C02',
    prevents: 'a declaration naming an axis nothing enforces (declared is not done; Pangea1 hashed five axes and read none)',
    how: 'remove the key, or enforce it in the engine and move it to ENFORCED in lint/axes.js',
    guide: 'unenforced-axis', scope: (r) => classes.source(r),
    count: (t) => groupsAfter(t, /\bdeclare\s*\(/g, '(').reduce((n, g) => n + count(g, AXIS_KEY), 0),
  },
  {
    id: 'content-hash-id', cls: 'C02',
    prevents: 'an action, intent or row id derived from a hash of its content, so two identical actions collapse into one and a retry with edited content is a new intent (census class 3)',
    how: 'mint the id once where the intent is made (engine/ulid.js ulid()) and carry it; derive child ids from that id, never from content (blob ids are the one content-addressed id)',
    guide: 'content-hash-id', scope: (r) => classes.source(r),
    count: (t) => {
      let n = 0;
      for (const m of t.matchAll(HASH_ID)) {
        if (/blob|etag|checksum|integrity|content|digest|hash|cache/i.test(m[1])) continue;
        const arg = groupAt(t, m.index + m[0].length - 1);
        if (CONTENTISH.test(arg)) n += 1;
      }
      return n;
    },
  },
  {
    id: 'handler-sync-io', cls: 'C05',
    prevents: 'a request handler blocking the event loop on synchronous fs or child-process calls',
    how: 'handlers enqueue; the store writer or a read worker does the I/O (async, with a deadline)',
    guide: 'handler-sync-io', scope: (r) => classes.handler(r), count: (t) => count(t, SYNC_IO),
  },
  {
    id: 'handler-spawn', cls: 'C05',
    prevents: 'a request handler spawning a process inline (unbounded latency, a process per request)',
    how: 'hand the job to a supervised worker queue (lib/bounded.js) with a deadline class (lib/engine/deadline.js)',
    guide: 'handler-spawn', scope: (r) => classes.handler(r), count: (t) => count(t, SPAWN),
  },
  {
    id: 'handler-unbounded-select', cls: 'C04',
    prevents: 'a full scan from a request handler (a SELECT with no LIMIT)',
    how: 'page it: LIMIT plus a cursor, or move the read to the read-only worker',
    guide: 'handler-unbounded-select', scope: (r) => classes.handler(r),
    count: (t) => [...t.matchAll(/[`'"]\s*SELECT\b[^`'"]*[`'"]/gi)].filter((m) => !/\bLIMIT\b|COUNT\(|MAX\(|MIN\(/i.test(m[0])).length,
  },
  {
    id: 'fetch-without-deadline', cls: 'C04',
    prevents: 'a fetch with no AbortSignal: a wait with no bound, a spinner with no deadline',
    how: "createDeadlineFetch(fetch).fetchWithin('read', url, opts) from lib/engine/deadline.js (a class per wait, latest-wins)",
    guide: 'fetch-without-deadline', scope: (r) => classes.client(r),
    count: (t) => groupsAfter(t, /(?<![.\w$])fetch\s*\(|window\.fetch\s*\(|globalThis\.fetch\s*\(/g, '(').filter((g) => !/\bsignal\b/.test(g)).length,
  },
  {
    id: 'interval-without-owner', cls: 'C04',
    prevents: 'a timer nobody owns or budgets (a 5 s heartbeat wrote 362 MB of telemetry in 14 hours, 2026-11-08)',
    how: "every('owner-name', ms, fn, { budgetMs }) from lib/timers.js; it is listed, budgeted and stoppable",
    guide: 'interval-without-owner', scope: (r) => classes.source(r), count: (t) => count(t, /(?<![\w$])(?:window\.|globalThis\.)?setInterval\s*\(/g),
  },
  {
    id: 'unbounded-queue', cls: 'C04',
    prevents: 'a queue, outbox or backlog born as a bare [] with no item or byte cap and no overflow policy',
    how: "boundedQueue({ name, maxItems, maxBytes, policy: 'refuse' | 'drop-oldest' }) from lib/bounded.js",
    guide: 'unbounded-queue', scope: (r) => classes.source(r),
    count: (t) => count(t, /(?:\b(?:let|const|var)\s+|this\.)\w*(?:queue|Queue|outbox|Outbox|backlog|Backlog|pending|Pending)\w*\s*=\s*\[\s*\]/g),
  },
  {
    id: 'server-homedir', cls: 'C03',
    prevents: "server state resolving under the real home directory, so a test run can write the owner's live data",
    how: 'resolve every store from one state-dir setting the test harness overrides, never homedir()',
    guide: 'server-homedir', scope: (r) => classes.server(r), count: (t) => count(t, /\bhomedir\s*\(\s*\)/g),
  },
  {
    id: 'meta-or-ctrl', cls: 'C09',
    prevents: 'Command and Control read as one accelerator, which clobbers the macOS emacs bindings',
    how: "bind 'mod+b' with createKeys() from lib/keys.js (mod is Command on macOS, Control elsewhere)",
    guide: 'meta-or-ctrl', scope: (r) => classes.client(r),
    // the pair used AS the accelerator; a modifier-bail list (meta || ctrl || shift || alt) is fine
    count: (t) => count(t, /\(\s*[\w.]*metaKey\s*\|\|\s*[\w.]*ctrlKey\s*\)|\(\s*[\w.]*ctrlKey\s*\|\|\s*[\w.]*metaKey\s*\)/g),
  },
  {
    id: 'focus-outside-intent', cls: 'C11',
    prevents: 'a second owner of focus: a component calling .focus() or .blur() itself, or keeping its own focused/autofocus flag, so the caret, the highlight and the active pane each follow their own idea of where the user is (webchat 2026-11-13: Shift-Enter opened a pane and the next keystroke still went to the old side-chat box)',
    how: "dispatch a transition on the kit intent record (lib/intent.js: press, openPane, openThread, blurThread, typeToFocus ...); the one DOM-apply effect (lib/intent-dom.js installIntent) is the only code that focuses anything; read focus with threadFocus / isOwner / paneActive",
    guide: 'focus-outside-intent', scope: (r) => classes.client(r) && !INTENT_OWNER.test(r),
    count: (t) => { const c = stripComments(t); return count(c, FOCUS_CALL) + count(c, FOCUS_FLAG); },
  },
  {
    id: 'narrow-media-hides-control', cls: 'C06',
    prevents: 'a control removed at phone width by display:none inside a max-width media query',
    how: 'reflow the control (wrap, shrink, move into the overflow menu) instead of removing it',
    guide: 'narrow-media-hides-control', scope: (r) => classes.style(r),
    count: (t) => groupsAfter(t, /@media[^{]*max-width[^{]*\{/g, '{').reduce((n, g) => n + count(g, /display\s*:\s*none/g), 0),
  },
  // Kit editor apps (lib/editor/editor.js). The owner 2026-11-08 23:29-23:30 PST: "all state needs to be owned by the kit ,
  // including scroll state"; "should be no way for styling to change what keys dose". The kit's editor adapter is the one
  // reader of layout and the DOM selection; an app that reads them has a second, styling-dependent source of truth.
  {
    id: 'editor-dom-read', cls: 'C11',
    prevents: 'an editor app reading scroll position, DOM text or the DOM selection itself, so what a key does depends on layout and styling',
    how: 'read editor.state (sel, anchor, focus) or editor.selectionRect()/viewport(); the kit adapter maps the DOM to addresses',
    guide: 'editor-dom-read', scope: (r) => classes.client(r) && !EDITOR_OWNER.test(r),
    count: (t, r, ctx) => (editorApp(t, ctx) ? count(t, /\.scrollTop\b|\.scrollY\b|\.textContent\b(?!\s*=[^=])|\.innerText\b(?!\s*=[^=])|\bgetSelection\s*\(|\bcaret(?:Range|Position)FromPoint\s*\(/g) : 0),
  },
  {
    id: 'editor-app-state', cls: 'C11',
    prevents: 'UI state held in module variables of an editor app (a caret, a pinned flag, an element map) that the kit cannot see, replay or restore',
    how: "put it in kit state: the app reducer's ext subtree (app.init) or a declared action; module scope holds constants",
    guide: 'editor-app-state', scope: (r) => classes.client(r) && !EDITOR_OWNER.test(r),
    count: (t, r, ctx) => (editorApp(t, ctx) ? count(t, /^(?:let|var)\s|^(?:export\s+)?const\s+\w+\s*=\s*new\s+(?:Map|Set|WeakMap)\s*\(/gm) : 0),
  },
  {
    id: 'editor-without-contract', cls: 'C11',
    prevents: 'an editor created without a declared contract (its actions and latency budget), so the gate has nothing to hold it to',
    how: "createEditor({ ..., contract: { name, actions: [...], budget_p95_ms: 100 } }) and a quicklook-ui.config.mjs for the gate",
    guide: 'editor-without-contract', scope: (r) => classes.client(r),
    count: (t) => groupsAfter(t, /\bcreateEditor\s*\(/g, '(').filter((g) => !/\bcontract\b/.test(g)).length,
  },
  {
    id: 'root-overscroll-none', cls: 'C10',
    prevents: 'overscroll-behavior: none on a root stylesheet, which cancels the two-finger back gesture app-wide',
    how: 'use overscroll-behavior-y: none (keeps the rubber-band fix, gives the gesture back)',
    guide: 'root-overscroll-none', scope: (r) => /(^|\/)(app|global|index)\.css$|(^|\/)\+layout\.svelte$/.test(r),
    count: (t) => count(t, /overscroll-behavior\s*:\s*none/g),
  },
];
