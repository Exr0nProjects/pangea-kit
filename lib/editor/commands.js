// The editor's context menu items, computed from what the editor can do (The owner 2026-11-14 22:56 PST: "change the right click ctx menu to
// customize it for all avail actions"). The list of actions is NOT written here: it is the app's own registry, the chords it passed to
// `createEditor` (`app.keys`, `app.keyActions`: each one is a `{ type: 'key', name }` or an action the editor already runs), so a chord the
// app adds appears in the menu the moment it is bound, with the shortcut it is bound to, and a chord no longer bound leaves it. This
// file only knows what to CALL each chord and where it belongs (`COMMANDS`, keyed by chord name; a bound chord with no entry is a failure of
// tests/editor.commands.test.js for the app that binds it, never a silent omission). Items are plain data (lib/menu-state.js): `do` says what
// one does: { key } the chord (one `key` action through the reducer), { action } an editor action, { clip } cut/copy/paste, { lint }, { app }.
import { parseSpec } from '../keys.js';
import { matchCase, MAX_SUGGESTIONS } from './lint.js';

/** What a chord is called and where it goes: `group` (the submenu), `edit` (changes the document: off when read only), `sel` (needs a selection),
 *  `alias` (the same command as another chord: not listed twice), `skip` (not a menu item). */
export const COMMANDS = Object.freeze({
  'mod+z': { label: 'Undo', group: 'history', edit: true }, 'mod+shift+z': { label: 'Redo', group: 'history', edit: true },
  'mod+shift+s': { label: 'Share selection as a doc', group: 'doc', sel: true },
  'mod+b': { label: 'Bold', group: 'format', edit: true, sel: true }, 'mod+shift+b': { label: 'Less bold', group: 'format', edit: true, sel: true },
  'mod+i': { label: 'Italic', group: 'format', edit: true, sel: true }, 'mod+u': { label: 'Underline', group: 'format', edit: true, sel: true },
  'mod+shift+x': { label: 'Strikethrough', group: 'format', edit: true, sel: true },
  'mod+alt+0': { label: 'Normal text', group: 'heading', edit: true }, 'mod+alt+1': { label: 'Heading 1', group: 'heading', edit: true }, 'mod+alt+2': { label: 'Heading 2', group: 'heading', edit: true },
  'mod+alt+3': { label: 'Heading 3', group: 'heading', edit: true }, 'mod+alt+4': { label: 'Heading 4', group: 'heading', edit: true },
  'mod+Enter': { label: 'Done or not done', group: 'list', edit: true }, 'mod+.': { label: 'Next marker', group: 'list', edit: true }, 'mod+shift+.': { label: 'Previous marker', group: 'list', edit: true },
  'mod+]': { label: 'Indent', group: 'list', edit: true }, 'mod+[': { label: 'Outdent', group: 'list', edit: true },
  Tab: { alias: 'mod+]' }, 'shift+Tab': { alias: 'mod+[' },
  'alt+ArrowUp': { label: 'Move line up', group: 'line', edit: true }, 'alt+ArrowDown': { label: 'Move line down', group: 'line', edit: true },
  'alt+shift+ArrowUp': { label: 'Duplicate line above', group: 'line', edit: true }, 'alt+shift+ArrowDown': { label: 'Duplicate line below', group: 'line', edit: true },
  'mod+shift+Enter': { label: 'Insert line above', group: 'line', edit: true }, 'mod+shift+k': { label: 'Delete line', group: 'line', edit: true, danger: true },
  'mod+e': { label: 'Archive line', group: 'line', edit: true }, 'mod+o': { label: 'Move line to Next', group: 'line', edit: true }, 'shift+Enter': { label: 'Page break', group: 'line', edit: true },
  'mod+/': { label: 'Fold or unfold', group: 'line' },
  'mod+a': { label: 'Select all', group: 'select' }, 'mod+f': { label: 'Find', group: 'find' },
  Escape: { skip: true },
});
/** Submenu titles, in the order they appear. */
export const GROUPS = Object.freeze([['format', 'Format'], ['heading', 'Heading'], ['list', 'List'], ['line', 'Line']]);

const MAC = /Mac|iPhone|iPad/;
const KEY_GLYPH = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: '↵', Escape: 'Esc', Tab: '⇥', Backspace: '⌫', Delete: '⌦', ' ': 'Space' };
/** A chord spec as the person reads it: "mod+shift+." -> "⇧⌘." on a Mac, "Ctrl+Shift+." elsewhere. */
export function chordLabel(spec, mac = MAC.test(globalThis.navigator?.platform || '')) {
  const s = parseSpec(spec, mac), key = KEY_GLYPH[s.key] ?? (s.key.length === 1 ? s.key.toUpperCase() : s.key);
  if (mac) return `${s.ctrl ? '⌃' : ''}${s.alt ? '⌥' : ''}${s.shift ? '⇧' : ''}${s.meta ? '⌘' : ''}${key}`;
  return [s.ctrl && 'Ctrl', s.alt && 'Alt', s.shift && 'Shift', s.meta && 'Meta', key].filter(Boolean).join('+');
}

/** Every chord an app binds, as { name, action? }: its `keys` (a `key` action named by the chord) and `keyActions` (a chord that runs a given action). */
export function boundChords(app) {
  const out = (app?.keys || []).map((name) => ({ name }));
  for (const [name, action] of Object.entries(app?.keyActions || {})) out.push({ name, action });
  return out;
}
/** The bound chords with no entry in COMMANDS (a chord the menu would not show): [] for a complete app. */
export const unlabelled = (app) => boundChords(app).filter((c) => !COMMANDS[c.name]).map((c) => c.name);

/** The command items of an editor app, by group: { [group]: [item] }. ctx: { readOnly, hasSel, suggesting }, blocked(name): the app's own refusal
 *  (zai: a chord Suggesting mode does not take). An item is disabled (never hidden) when it needs what is not there. */
export function commandItems(app, { readOnly = false, hasSel = false, suggesting = false, blocked = () => false, mac = MAC.test(globalThis.navigator?.platform || '') } = {}) {
  const out = {};
  for (const c of boundChords(app)) {
    const def = COMMANDS[c.name];
    if (!def || def.skip || def.alias) continue;
    const off = (def.edit && readOnly) || (def.sel && !hasSel) || (suggesting && blocked(c.name));
    (out[def.group] ||= []).push({ id: `cmd:${c.name}`, label: def.label, keys: chordLabel(c.name, mac), ...(off ? { disabled: true } : {}), ...(def.danger ? { danger: true } : {}), do: c.action ? { action: c.action } : { key: c.name } });
  }
  return out;
}

const sub = (id, label, items) => (items?.length ? [{ id, label, children: items }] : []);
const group = (cmds, name) => cmds[name] || [];

/** The findings section of the menu: the message, the suggestions, Ignore, Add to dictionary. [] when the click is not on a finding. */
export function lintSection(lint, { row, readOnly = false, canDict = true } = {}) {
  if (!lint || typeof row !== 'string') return [];
  const out = [];
  if (lint.msg) out.push({ id: 'lint.msg', label: lint.msg, heading: true });
  const sug = (lint.sug || []).slice(0, MAX_SUGGESTIONS);
  sug.forEach((s, i) => { const text = lint.cls === 'spelling' ? matchCase(lint.word, s) : s; out.push({ id: `lint.fix.${i}`, label: text === '' ? 'Remove' : text, ...(readOnly ? { disabled: true } : {}), do: { lint: 'fix', row, from: lint.from, to: lint.to, word: lint.word, text } }); });
  if (!sug.length) out.push({ id: 'lint.nosug', label: 'No suggestions', disabled: true });
  out.push({ separator: true });
  out.push({ id: 'lint.ignore', label: 'Ignore', do: { lint: 'ignore', key: lint.key } });
  if (lint.cls === 'spelling' && canDict) out.push({ id: 'lint.dict', label: 'Add to dictionary', do: { lint: 'dict', word: lint.word } });
  return out;
}

/** The whole menu for a click in the text. ctx: { lint (the finding under the pointer, or null), row, hasSel }; flags: { readOnly, suggesting, blocked,
 *  mac, canPaste, checking (the spelling toggle's current value; null: no checker mounted), canDict }; extras: { top: [items before the clip group],
 *  actions: [items after the groups] } for what only the app knows (comment, share, history). */
export function editorMenuItems(app, ctx, flags = {}, extras = {}) {
  const { readOnly = false, checking = null } = flags, hasSel = Boolean(ctx.hasSel), cmds = commandItems(app, { readOnly, hasSel, suggesting: flags.suggesting, blocked: flags.blocked, mac: flags.mac });
  const clip = [
    { id: 'clip.cut', label: 'Cut', keys: chordLabel('mod+x', flags.mac), ...(readOnly || !hasSel ? { disabled: true } : {}), do: { clip: 'cut' } },
    { id: 'clip.copy', label: 'Copy', keys: chordLabel('mod+c', flags.mac), ...(!hasSel ? { disabled: true } : {}), do: { clip: 'copy' } },
    { id: 'clip.paste', label: 'Paste', keys: chordLabel('mod+v', flags.mac), ...(readOnly ? { disabled: true } : {}), do: { clip: 'paste' } },
  ];
  const sel = group(cmds, 'select'), find = group(cmds, 'find'), docs = [...group(cmds, 'doc')];
  return [
    ...lintSection(ctx.lint, { row: ctx.row, readOnly, canDict: flags.canDict }), ...(ctx.lint ? [{ separator: true }] : []),
    ...(extras.top || []), ...(extras.top?.length ? [{ separator: true }] : []),
    ...clip, ...sel, { separator: true },
    ...GROUPS.flatMap(([name, title]) => sub(`group:${name}`, title, group(cmds, name))), { separator: true },
    ...(extras.actions || []), ...docs, ...find, { separator: true },
    ...group(cmds, 'history'),
    ...(checking === null ? [] : [{ separator: true }, { id: 'lint.toggle', label: 'Check spelling and grammar', checked: Boolean(checking), do: { lint: 'toggle', on: !checking } }]),
  ];
}
