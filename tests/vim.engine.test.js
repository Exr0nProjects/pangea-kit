// Ported from old zai's src/lib/core/vim.test.js (unit tests per command family with expectations recorded from Neovim, failure paths, options, properties, and the replay
// of golden.jsonl.gz: 42,451 Neovim observations). fast-check properties became seeded loops (the kit has no such dependency).
// Unit tests for the vim engine. The NVIM table's expectations were produced by real Neovim
// (nvim --headless --clean, through tests/vim-parity/driver.lua with its option set), so each
// row is a recorded Neovim observation, not a hand-written guess. Rows start like the parity
// check: the redo buffer holds "dl" (an earlier "x"), registers are empty.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
const STARTS = [
  { id: 'empty', lines: [''], row: 0, col: 0 },
  { id: 'single', lines: ['a'], row: 0, col: 0 },
  { id: 'blanks', lines: ['one two', '', '', 'three four'], row: 0, col: 4 },
  { id: 'list', lines: ['- [ ] parent', '  - [ ] child', '  - [ ] other'], row: 1, col: 2 },
  { id: 'list-eol', lines: ['- [ ] parent', '  - [ ] child', '  - [ ] other'], row: 0, col: 11 },
  { id: 'trailing', lines: ['foo bar  ', 'baz   ', 'qux'], row: 0, col: 8 },
  { id: 'quotes', lines: ['say "hello world" now', 'x = "a" + "b"'], row: 0, col: 6 },
  { id: 'paras', lines: ['first para', 'line two', '', 'second para', '', '', 'third'], row: 1, col: 3 },
  { id: 'brackets', lines: ['f(a, [b, c]) {', '  return {x: (1)};', '}'], row: 0, col: 0 },
  { id: 'words', lines: ['foo.bar baz-qux  end', '  indented line here'], row: 0, col: 19 },
  { id: 'indents', lines: ['    deep', 'shallow', '        deeper'], row: 2, col: 0 },
  { id: 'tabs', lines: ['\tTabbed line', 'x\ty'], row: 0, col: 0 }
];
import { createVim, vimKey, vimKeys, vimMode, vimNvimMode, vimBlocking, vimCursor, vimAnchor, parseNormal, DEFAULTS, MAXCOL } from '../lib/editor/vim.js';

const PRIMED = { lastChange: { count: 0, keys: ['d', 'l'] } };
const keysOf = (s) => s.match(/<[^>]+>|./g);

function start(lines, row, col, options = PRIMED) {
  let offset = 0;
  for (let r = 0; r < row; r += 1) offset += lines[r].length + 1;
  return createVim(lines.join('\n'), offset + col, options);
}

function settle(state) {
  let s = state;
  let esc = 0;
  while (vimBlocking(s) && esc < 10) {
    s = vimKey(s, '<Esc>');
    esc += 1;
  }
  return { s, esc };
}

function regPair(reg) {
  if (!reg) return ['', ''];
  return reg.linewise ? [reg.text + '\n', 'V'] : [reg.text, 'v'];
}

// [name, lines, row, col, keys, Neovim's observation]
const NVIM = [
  ["motion h", ["foo bar baz","qux.quux  end",""], 0, 5, "h", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["",""]}],
  ["motion h at col 0 fails", ["foo bar baz","qux.quux  end",""], 0, 0, "h", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["motion l", ["foo bar baz","qux.quux  end",""], 0, 0, "l", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":1,"mode":"n","esc":0,"reg":["",""]}],
  ["motion 3l", ["foo bar baz","qux.quux  end",""], 0, 0, "3l", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":3,"mode":"n","esc":0,"reg":["",""]}],
  ["motion l at end fails", ["foo bar baz","qux.quux  end",""], 0, 10, "l", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":10,"mode":"n","esc":0,"reg":["",""]}],
  ["motion j", ["foo bar baz","qux.quux  end",""], 0, 9, "j", {"lines":["foo bar baz","qux.quux  end",""],"row":1,"col":9,"mode":"n","esc":0,"reg":["",""]}],
  ["motion j curswant", ["foo bar baz","qux.quux  end",""], 0, 10, "jj", {"lines":["foo bar baz","qux.quux  end",""],"row":2,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["motion k", ["foo bar baz","qux.quux  end",""], 1, 3, "k", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":3,"mode":"n","esc":0,"reg":["",""]}],
  ["motion w", ["foo bar baz","qux.quux  end",""], 0, 0, "w", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["",""]}],
  ["motion 2w", ["foo bar baz","qux.quux  end",""], 0, 0, "2w", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":8,"mode":"n","esc":0,"reg":["",""]}],
  ["motion W", ["foo bar baz","qux.quux  end",""], 1, 0, "W", {"lines":["foo bar baz","qux.quux  end",""],"row":1,"col":10,"mode":"n","esc":0,"reg":["",""]}],
  ["motion w punctuation", ["foo bar baz","qux.quux  end",""], 1, 0, "w", {"lines":["foo bar baz","qux.quux  end",""],"row":1,"col":3,"mode":"n","esc":0,"reg":["",""]}],
  ["motion b", ["foo bar baz","qux.quux  end",""], 0, 8, "b", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["",""]}],
  ["motion B", ["foo bar baz","qux.quux  end",""], 1, 12, "B", {"lines":["foo bar baz","qux.quux  end",""],"row":1,"col":10,"mode":"n","esc":0,"reg":["",""]}],
  ["motion e", ["foo bar baz","qux.quux  end",""], 0, 0, "e", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":2,"mode":"n","esc":0,"reg":["",""]}],
  ["motion E", ["foo bar baz","qux.quux  end",""], 1, 0, "E", {"lines":["foo bar baz","qux.quux  end",""],"row":1,"col":7,"mode":"n","esc":0,"reg":["",""]}],
  ["motion 0", ["foo bar baz","qux.quux  end",""], 0, 5, "0", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["motion ^", ["- [ ] parent","  - [ ] child","  - [ ] other"], 1, 8, "^", {"lines":["- [ ] parent","  - [ ] child","  - [ ] other"],"row":1,"col":2,"mode":"n","esc":0,"reg":["",""]}],
  ["motion $", ["foo bar baz","qux.quux  end",""], 0, 0, "$", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":10,"mode":"n","esc":0,"reg":["",""]}],
  ["motion $ keeps end", ["foo bar baz","qux.quux  end",""], 0, 0, "$j", {"lines":["foo bar baz","qux.quux  end",""],"row":1,"col":12,"mode":"n","esc":0,"reg":["",""]}],
  ["motion gg", ["foo bar baz","qux.quux  end",""], 1, 3, "gg", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":3,"mode":"n","esc":0,"reg":["",""]}],
  ["motion G", ["foo bar baz","qux.quux  end",""], 0, 3, "G", {"lines":["foo bar baz","qux.quux  end",""],"row":2,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["motion 2G", ["foo bar baz","qux.quux  end",""], 0, 3, "2G", {"lines":["foo bar baz","qux.quux  end",""],"row":1,"col":3,"mode":"n","esc":0,"reg":["",""]}],
  ["motion f", ["foo bar baz","qux.quux  end",""], 0, 0, "fa", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":5,"mode":"n","esc":0,"reg":["",""]}],
  ["motion F", ["foo bar baz","qux.quux  end",""], 0, 10, "Fb", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":8,"mode":"n","esc":0,"reg":["",""]}],
  ["motion t", ["foo bar baz","qux.quux  end",""], 0, 0, "tb", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":3,"mode":"n","esc":0,"reg":["",""]}],
  ["motion T", ["foo bar baz","qux.quux  end",""], 0, 10, "Tb", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":9,"mode":"n","esc":0,"reg":["",""]}],
  ["motion ;", ["foo bar baz","qux.quux  end",""], 0, 0, "fa;", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":9,"mode":"n","esc":0,"reg":["",""]}],
  ["motion ,", ["foo bar baz","qux.quux  end",""], 0, 10, "Fa,", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":9,"mode":"n","esc":0,"reg":["",""]}],
  ["motion f fails", ["foo bar baz","qux.quux  end",""], 0, 0, "fz", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":10,"mode":"n","esc":0,"reg":["",""]}],
  ["motion %", ["f(a, [b, c]) {","  return {x: (1)};","}"], 0, 0, "%", {"lines":["f(a, [b, c]) {","  return {x: (1)};","}"],"row":0,"col":11,"mode":"n","esc":0,"reg":["",""]}],
  ["motion % nested", ["f(a, [b, c]) {","  return {x: (1)};","}"], 0, 5, "%", {"lines":["f(a, [b, c]) {","  return {x: (1)};","}"],"row":0,"col":10,"mode":"n","esc":0,"reg":["",""]}],
  ["motion }", ["first para","line two","","second para","","third"], 0, 0, "}", {"lines":["first para","line two","","second para","","third"],"row":2,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["motion {", ["first para","line two","","second para","","third"], 5, 2, "{", {"lines":["first para","line two","","second para","","third"],"row":4,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["motion 2}", ["first para","line two","","second para","","third"], 0, 0, "2}", {"lines":["first para","line two","","second para","","third"],"row":4,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["motion <CR>", ["- [ ] parent","  - [ ] child","  - [ ] other"], 0, 5, "<CR>", {"lines":["- [ ] parent","  - [ ] child","  - [ ] other"],"row":1,"col":2,"mode":"n","esc":0,"reg":["",""]}],
  ["motion <BS> wraps", ["foo bar baz","qux.quux  end",""], 1, 0, "<BS>", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":10,"mode":"n","esc":0,"reg":["",""]}],
  ["op dw", ["foo bar baz","qux.quux  end",""], 0, 0, "dw", {"lines":["bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["foo ","v"]}],
  ["op dw last word", ["foo bar baz","qux.quux  end",""], 0, 8, "dw", {"lines":["foo bar ","qux.quux  end",""],"row":0,"col":7,"mode":"n","esc":0,"reg":["baz","v"]}],
  ["op de", ["foo bar baz","qux.quux  end",""], 0, 0, "de", {"lines":[" bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["foo","v"]}],
  ["op db", ["foo bar baz","qux.quux  end",""], 0, 8, "db", {"lines":["foo baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["bar ","v"]}],
  ["op d$", ["foo bar baz","qux.quux  end",""], 0, 4, "d$", {"lines":["foo ","qux.quux  end",""],"row":0,"col":3,"mode":"n","esc":0,"reg":["bar baz","v"]}],
  ["op d0", ["foo bar baz","qux.quux  end",""], 0, 4, "d0", {"lines":["bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["foo ","v"]}],
  ["op dd", ["foo bar baz","qux.quux  end",""], 0, 4, "dd", {"lines":["qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["foo bar baz\n","V"]}],
  ["op 2dd", ["foo bar baz","qux.quux  end",""], 0, 4, "2dd", {"lines":[""],"row":0,"col":0,"mode":"n","esc":0,"reg":["foo bar baz\nqux.quux  end\n","V"]}],
  ["op dj", ["foo bar baz","qux.quux  end",""], 0, 4, "dj", {"lines":[""],"row":0,"col":0,"mode":"n","esc":0,"reg":["foo bar baz\nqux.quux  end\n","V"]}],
  ["op dk", ["foo bar baz","qux.quux  end",""], 1, 4, "dk", {"lines":[""],"row":0,"col":0,"mode":"n","esc":0,"reg":["foo bar baz\nqux.quux  end\n","V"]}],
  ["op dG", ["foo bar baz","qux.quux  end",""], 0, 0, "dG", {"lines":[""],"row":0,"col":0,"mode":"n","esc":0,"reg":["foo bar baz\nqux.quux  end\n\n","V"]}],
  ["op dgg", ["foo bar baz","qux.quux  end",""], 1, 0, "dgg", {"lines":[""],"row":0,"col":0,"mode":"n","esc":0,"reg":["foo bar baz\nqux.quux  end\n","V"]}],
  ["op df", ["foo bar baz","qux.quux  end",""], 0, 0, "dfa", {"lines":["r baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["foo ba","v"]}],
  ["op dt", ["foo bar baz","qux.quux  end",""], 0, 0, "dtb", {"lines":["bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["foo ","v"]}],
  ["op d}", ["first para","line two","","second para","","third"], 0, 0, "d}", {"lines":["","second para","","third"],"row":0,"col":0,"mode":"n","esc":0,"reg":["first para\nline two\n","V"]}],
  ["op d%", ["f(a, [b, c]) {","  return {x: (1)};","}"], 0, 1, "d%", {"lines":["f {","  return {x: (1)};","}"],"row":0,"col":1,"mode":"n","esc":0,"reg":["(a, [b, c])","v"]}],
  ["op 2d3w", ["foo bar baz","qux.quux  end",""], 0, 0, "2d3w", {"lines":["end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["foo bar baz\nqux.quux  ","v"]}],
  ["op cw", ["foo bar baz","qux.quux  end",""], 0, 0, "cwX<Esc>", {"lines":["X bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["foo","v"]}],
  ["op cw on space", ["foo bar baz","qux.quux  end",""], 0, 3, "cwX<Esc>", {"lines":["fooXbar baz","qux.quux  end",""],"row":0,"col":3,"mode":"n","esc":0,"reg":[" ","v"]}],
  ["op cc keeps indent", ["- [ ] parent","  - [ ] child","  - [ ] other"], 1, 5, "ccnew<Esc>", {"lines":["- [ ] parent","  new","  - [ ] other"],"row":1,"col":4,"mode":"n","esc":0,"reg":["  - [ ] child\n","V"]}],
  ["op c$", ["foo bar baz","qux.quux  end",""], 0, 4, "c$!<Esc>", {"lines":["foo !","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["bar baz","v"]}],
  ["op yw p", ["foo bar baz","qux.quux  end",""], 0, 0, "ywP", {"lines":["foo foo bar baz","qux.quux  end",""],"row":0,"col":3,"mode":"n","esc":0,"reg":["foo ","v"]}],
  ["op yy p", ["foo bar baz","qux.quux  end",""], 0, 0, "yyp", {"lines":["foo bar baz","foo bar baz","qux.quux  end",""],"row":1,"col":0,"mode":"n","esc":0,"reg":["foo bar baz\n","V"]}],
  ["op yb moves", ["foo bar baz","qux.quux  end",""], 0, 8, "yb", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["bar ","v"]}],
  ["op >>", ["- [ ] parent","  - [ ] child","  - [ ] other"], 0, 0, ">>", {"lines":["  - [ ] parent","  - [ ] child","  - [ ] other"],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["op 2>>", ["- [ ] parent","  - [ ] child","  - [ ] other"], 0, 0, "2>>", {"lines":["  - [ ] parent","    - [ ] child","  - [ ] other"],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["op <<", ["- [ ] parent","  - [ ] child","  - [ ] other"], 1, 0, "<<", {"lines":["- [ ] parent","- [ ] child","  - [ ] other"],"row":1,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["op >j", ["- [ ] parent","  - [ ] child","  - [ ] other"], 0, 0, ">j", {"lines":["  - [ ] parent","    - [ ] child","  - [ ] other"],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["op <G", ["- [ ] parent","  - [ ] child","  - [ ] other"], 0, 0, "<G", {"lines":["- [ ] parent","- [ ] child","- [ ] other"],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["obj diw", ["foo bar baz","qux.quux  end",""], 0, 5, "diw", {"lines":["foo  baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["bar","v"]}],
  ["obj daw", ["foo bar baz","qux.quux  end",""], 0, 5, "daw", {"lines":["foo baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["bar ","v"]}],
  ["obj ciw", ["foo bar baz","qux.quux  end",""], 0, 5, "ciwX<Esc>", {"lines":["foo X baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["bar","v"]}],
  ["obj yiw", ["foo bar baz","qux.quux  end",""], 0, 5, "yiwP", {"lines":["foo barbar baz","qux.quux  end",""],"row":0,"col":6,"mode":"n","esc":0,"reg":["bar","v"]}],
  ["obj di\"", ["say \"hello world\" now","x = \"a\" + \"b\""], 0, 7, "di\"", {"lines":["say \"\" now","x = \"a\" + \"b\""],"row":0,"col":5,"mode":"n","esc":0,"reg":["hello world","v"]}],
  ["obj da\"", ["say \"hello world\" now","x = \"a\" + \"b\""], 0, 7, "da\"", {"lines":["say now","x = \"a\" + \"b\""],"row":0,"col":4,"mode":"n","esc":0,"reg":["\"hello world\" ","v"]}],
  ["obj ci\" before quote", ["say \"hello world\" now","x = \"a\" + \"b\""], 0, 0, "ci\"z<Esc>", {"lines":["say \"z\" now","x = \"a\" + \"b\""],"row":0,"col":5,"mode":"n","esc":0,"reg":["hello world","v"]}],
  ["obj dip", ["first para","line two","","second para","","third"], 0, 3, "dip", {"lines":["","second para","","third"],"row":0,"col":0,"mode":"n","esc":0,"reg":["first para\nline two\n","V"]}],
  ["obj dap", ["first para","line two","","second para","","third"], 0, 3, "dap", {"lines":["second para","","third"],"row":0,"col":3,"mode":"n","esc":0,"reg":["first para\nline two\n\n","V"]}],
  ["obj yap", ["first para","line two","","second para","","third"], 3, 0, "yap", {"lines":["first para","line two","","second para","","third"],"row":3,"col":0,"mode":"n","esc":0,"reg":["second para\n\n","V"]}],
  ["obj diW", ["foo bar baz","qux.quux  end",""], 1, 2, "diW", {"lines":["foo bar baz","  end",""],"row":1,"col":0,"mode":"n","esc":0,"reg":["qux.quux","v"]}],
  ["obj daw at end", ["foo bar baz","qux.quux  end",""], 0, 9, "daw", {"lines":["foo bar","qux.quux  end",""],"row":0,"col":6,"mode":"n","esc":0,"reg":[" baz","v"]}],
  ["cmd x", ["foo bar baz","qux.quux  end",""], 0, 0, "x", {"lines":["oo bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["f","v"]}],
  ["cmd 3x", ["foo bar baz","qux.quux  end",""], 0, 0, "3x", {"lines":[" bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["foo","v"]}],
  ["cmd x at end", ["foo bar baz","qux.quux  end",""], 0, 10, "x", {"lines":["foo bar ba","qux.quux  end",""],"row":0,"col":9,"mode":"n","esc":0,"reg":["z","v"]}],
  ["cmd X", ["foo bar baz","qux.quux  end",""], 0, 3, "X", {"lines":["fo bar baz","qux.quux  end",""],"row":0,"col":2,"mode":"n","esc":0,"reg":["o","v"]}],
  ["cmd X at 0", ["foo bar baz","qux.quux  end",""], 0, 0, "X", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd s", ["foo bar baz","qux.quux  end",""], 0, 0, "sZ<Esc>", {"lines":["Zoo bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["f","v"]}],
  ["cmd S", ["- [ ] parent","  - [ ] child","  - [ ] other"], 1, 3, "Snew<Esc>", {"lines":["- [ ] parent","  new","  - [ ] other"],"row":1,"col":4,"mode":"n","esc":0,"reg":["  - [ ] child\n","V"]}],
  ["cmd r", ["foo bar baz","qux.quux  end",""], 0, 0, "rZ", {"lines":["Zoo bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd 3r", ["foo bar baz","qux.quux  end",""], 0, 0, "3rZ", {"lines":["ZZZ bar baz","qux.quux  end",""],"row":0,"col":2,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd r too far", ["foo bar baz","qux.quux  end",""], 0, 9, "3rZ", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":9,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd r<CR>", ["foo bar baz","qux.quux  end",""], 0, 3, "r<CR>", {"lines":["foo","bar baz","qux.quux  end",""],"row":1,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd o", ["- [ ] parent","  - [ ] child","  - [ ] other"], 1, 0, "onew<Esc>", {"lines":["- [ ] parent","  - [ ] child","  new","  - [ ] other"],"row":2,"col":4,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd O", ["- [ ] parent","  - [ ] child","  - [ ] other"], 1, 0, "Onew<Esc>", {"lines":["- [ ] parent","  new","  - [ ] child","  - [ ] other"],"row":1,"col":4,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd o empty removes indent", ["- [ ] parent","  - [ ] child","  - [ ] other"], 1, 0, "o<Esc>", {"lines":["- [ ] parent","  - [ ] child","","  - [ ] other"],"row":2,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd a", ["foo bar baz","qux.quux  end",""], 0, 0, "aZ<Esc>", {"lines":["fZoo bar baz","qux.quux  end",""],"row":0,"col":1,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd A", ["foo bar baz","qux.quux  end",""], 0, 0, "AZ<Esc>", {"lines":["foo bar bazZ","qux.quux  end",""],"row":0,"col":11,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd i", ["foo bar baz","qux.quux  end",""], 0, 4, "iZ<Esc>", {"lines":["foo Zbar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd I", ["- [ ] parent","  - [ ] child","  - [ ] other"], 1, 8, "IZ<Esc>", {"lines":["- [ ] parent","  Z- [ ] child","  - [ ] other"],"row":1,"col":2,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd 3iab", ["foo bar baz","qux.quux  end",""], 0, 0, "3iab<Esc>", {"lines":["abababfoo bar baz","qux.quux  end",""],"row":0,"col":5,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd 2o", ["foo bar baz","qux.quux  end",""], 0, 0, "2ohi<Esc>", {"lines":["foo bar baz","hi","hi","qux.quux  end",""],"row":2,"col":1,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd p char", ["foo bar baz","qux.quux  end",""], 0, 0, "xp", {"lines":["ofo bar baz","qux.quux  end",""],"row":0,"col":1,"mode":"n","esc":0,"reg":["f","v"]}],
  ["cmd P char", ["foo bar baz","qux.quux  end",""], 0, 4, "dwP", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":7,"mode":"n","esc":0,"reg":["bar ","v"]}],
  ["cmd p line", ["foo bar baz","qux.quux  end",""], 0, 0, "ddp", {"lines":["qux.quux  end","foo bar baz",""],"row":1,"col":0,"mode":"n","esc":0,"reg":["foo bar baz\n","V"]}],
  ["cmd 3p", ["foo bar baz","qux.quux  end",""], 0, 0, "yl3p", {"lines":["ffffoo bar baz","qux.quux  end",""],"row":0,"col":3,"mode":"n","esc":0,"reg":["f","v"]}],
  ["cmd p empty register", ["foo bar baz","qux.quux  end",""], 0, 0, "p", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd u", ["foo bar baz","qux.quux  end",""], 0, 0, "dwu", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["foo ","v"]}],
  ["cmd u twice", ["foo bar baz","qux.quux  end",""], 0, 0, "dwxuu", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["b","v"]}],
  ["cmd <C-r>", ["foo bar baz","qux.quux  end",""], 0, 0, "dwu<C-r>", {"lines":["bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["foo ","v"]}],
  ["cmd u nothing", ["foo bar baz","qux.quux  end",""], 0, 4, "u", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd .", ["foo bar baz","qux.quux  end",""], 0, 0, "dw.", {"lines":["baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["bar ","v"]}],
  ["cmd 2.", ["foo bar baz","qux.quux  end",""], 0, 0, "x2.", {"lines":[" bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["oo","v"]}],
  ["cmd . insert", ["foo bar baz","qux.quux  end",""], 0, 0, "iab<Esc>j.", {"lines":["abfoo bar baz","qabux.quux  end",""],"row":1,"col":2,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd . cw", ["foo bar baz","qux.quux  end",""], 0, 0, "cwZ<Esc>w.", {"lines":["Z Z baz","qux.quux  end",""],"row":0,"col":2,"mode":"n","esc":0,"reg":["bar","v"]}],
  ["cmd J", ["foo bar baz","qux.quux  end",""], 0, 0, "J", {"lines":["foo bar baz qux.quux  end",""],"row":0,"col":11,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd 3J", ["foo bar baz","qux.quux  end",""], 0, 0, "3J", {"lines":["foo bar baz qux.quux  end"],"row":0,"col":24,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd J indent", ["- [ ] parent","  - [ ] child","  - [ ] other"], 0, 0, "J", {"lines":["- [ ] parent - [ ] child","  - [ ] other"],"row":0,"col":12,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd J last line", ["foo bar baz","qux.quux  end",""], 2, 0, "J", {"lines":["foo bar baz","qux.quux  end",""],"row":2,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["cmd dd last", ["foo bar baz","qux.quux  end",""], 2, 0, "dd", {"lines":["foo bar baz","qux.quux  end"],"row":1,"col":0,"mode":"n","esc":0,"reg":["\n","V"]}],
  ["cmd yyP", ["- [ ] parent","  - [ ] child","  - [ ] other"], 1, 4, "yyP", {"lines":["- [ ] parent","  - [ ] child","  - [ ] child","  - [ ] other"],"row":1,"col":2,"mode":"n","esc":0,"reg":["  - [ ] child\n","V"]}],
  ["insert typing", ["foo bar baz","qux.quux  end",""], 0, 0, "ihello <Esc>", {"lines":["hello foo bar baz","qux.quux  end",""],"row":0,"col":5,"mode":"n","esc":0,"reg":["",""]}],
  ["insert BS", ["foo bar baz","qux.quux  end",""], 0, 4, "iab<BS><Esc>", {"lines":["foo abar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["",""]}],
  ["insert BS joins", ["foo bar baz","qux.quux  end",""], 1, 0, "i<BS><Esc>", {"lines":["foo bar bazqux.quux  end",""],"row":0,"col":10,"mode":"n","esc":0,"reg":["",""]}],
  ["insert CR", ["foo bar baz","qux.quux  end",""], 0, 4, "i<CR><Esc>", {"lines":["foo ","bar baz","qux.quux  end",""],"row":1,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["insert CR autoindent", ["- [ ] parent","  - [ ] child","  - [ ] other"], 1, 13, "a<CR>x<Esc>", {"lines":["- [ ] parent","  - [ ] child","  x","  - [ ] other"],"row":2,"col":2,"mode":"n","esc":0,"reg":["",""]}],
  ["insert BS smarttab", ["- [ ] parent","  - [ ] child","  - [ ] other"], 1, 2, "i<BS><Esc>", {"lines":["- [ ] parent","- [ ] child","  - [ ] other"],"row":1,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["insert Tab smarttab", ["foo bar baz","qux.quux  end",""], 0, 0, "i<Tab><Esc>", {"lines":["  foo bar baz","qux.quux  end",""],"row":0,"col":1,"mode":"n","esc":0,"reg":["",""]}],
  ["insert Tab mid line", ["foo bar baz","qux.quux  end",""], 0, 3, "i<Tab><Esc>", {"lines":["foo      bar baz","qux.quux  end",""],"row":0,"col":7,"mode":"n","esc":0,"reg":["",""]}],
  ["insert C-r", ["foo bar baz","qux.quux  end",""], 0, 0, "yiwA <C-r>\"<Esc>", {"lines":["foo bar baz foo","qux.quux  end",""],"row":0,"col":14,"mode":"n","esc":0,"reg":["foo","v"]}],
  ["insert left open", ["foo bar baz","qux.quux  end",""], 0, 0, "ihi", {"lines":["hifoo bar baz","qux.quux  end",""],"row":0,"col":2,"mode":"i","esc":0,"reg":["",""]}],
  ["insert Esc at col 0", ["foo bar baz","qux.quux  end",""], 0, 0, "i<Esc>", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["visual v d", ["foo bar baz","qux.quux  end",""], 0, 0, "vlld", {"lines":[" bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["foo","v"]}],
  ["visual v y", ["foo bar baz","qux.quux  end",""], 0, 4, "vey", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["bar","v"]}],
  ["visual v c", ["foo bar baz","qux.quux  end",""], 0, 4, "vecZ<Esc>", {"lines":["foo Z baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["bar","v"]}],
  ["visual V d", ["foo bar baz","qux.quux  end",""], 0, 4, "Vd", {"lines":["qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["foo bar baz\n","V"]}],
  ["visual V j d", ["foo bar baz","qux.quux  end",""], 0, 4, "Vjd", {"lines":[""],"row":0,"col":0,"mode":"n","esc":0,"reg":["foo bar baz\nqux.quux  end\n","V"]}],
  ["visual V >", ["- [ ] parent","  - [ ] child","  - [ ] other"], 0, 0, "Vj>", {"lines":["  - [ ] parent","    - [ ] child","  - [ ] other"],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["visual v <", ["- [ ] parent","  - [ ] child","  - [ ] other"], 1, 3, "v<", {"lines":["- [ ] parent","- [ ] child","  - [ ] other"],"row":1,"col":3,"mode":"n","esc":0,"reg":["",""]}],
  ["visual x", ["foo bar baz","qux.quux  end",""], 0, 0, "vex", {"lines":[" bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["foo","v"]}],
  ["visual J", ["foo bar baz","qux.quux  end",""], 0, 0, "VjJ", {"lines":["foo bar baz qux.quux  end",""],"row":0,"col":11,"mode":"n","esc":0,"reg":["",""]}],
  ["visual p", ["foo bar baz","qux.quux  end",""], 0, 0, "yiwwvep", {"lines":["foo foo baz","qux.quux  end",""],"row":0,"col":6,"mode":"n","esc":0,"reg":["bar","v"]}],
  ["visual P keeps register", ["foo bar baz","qux.quux  end",""], 0, 0, "yiwwveP", {"lines":["foo foo baz","qux.quux  end",""],"row":0,"col":6,"mode":"n","esc":0,"reg":["foo","v"]}],
  ["visual o", ["foo bar baz","qux.quux  end",""], 0, 4, "veoh", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":3,"mode":"v","esc":0,"reg":["",""],"anchor":[0,6]}],
  ["visual Esc", ["foo bar baz","qux.quux  end",""], 0, 4, "ve<Esc>", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":6,"mode":"n","esc":0,"reg":["",""]}],
  ["visual v v exits", ["foo bar baz","qux.quux  end",""], 0, 4, "vv", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["",""]}],
  ["visual v V switches", ["foo bar baz","qux.quux  end",""], 0, 4, "vV", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":4,"mode":"V","esc":0,"reg":["",""],"anchor":[0,4]}],
  ["visual u lowers", ["ABC DEF"], 0, 0, "veu", {"lines":["abc DEF"],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["visual r", ["foo bar baz","qux.quux  end",""], 0, 0, "verx", {"lines":["xxx bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["visual . repeats", ["foo bar baz","qux.quux  end",""], 0, 0, "vldw.", {"lines":["o r baz","qux.quux  end",""],"row":0,"col":2,"mode":"n","esc":0,"reg":["ba","v"]}],
  ["visual iw", ["foo bar baz","qux.quux  end",""], 0, 5, "viwd", {"lines":["foo  baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["bar","v"]}],
  ["visual ip", ["first para","line two","","second para","","third"], 0, 0, "vipd", {"lines":["","second para","","third"],"row":0,"col":0,"mode":"n","esc":0,"reg":["first para\nline two\n","V"]}],
  ["visual $ d", ["foo bar baz","qux.quux  end",""], 0, 4, "v$d", {"lines":["foo qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["bar baz\n","v"]}],
  ["visual left open", ["foo bar baz","qux.quux  end",""], 0, 4, "ve", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":6,"mode":"v","esc":0,"reg":["",""],"anchor":[0,4]}],
  ["visual-line open", ["foo bar baz","qux.quux  end",""], 0, 4, "Vj", {"lines":["foo bar baz","qux.quux  end",""],"row":1,"col":4,"mode":"V","esc":0,"reg":["",""],"anchor":[0,4]}],
  ["pending d", ["foo bar baz","qux.quux  end",""], 0, 4, "d", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":4,"mode":"no","esc":0,"reg":["",""]}],
  ["pending count", ["foo bar baz","qux.quux  end",""], 0, 4, "2", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":1,"reg":["",""]}],
  ["pending f", ["foo bar baz","qux.quux  end",""], 0, 4, "f", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":1,"reg":["",""]}],
  ["pending r", ["foo bar baz","qux.quux  end",""], 0, 4, "r", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":1,"reg":["",""]}],
  ["pending g", ["foo bar baz","qux.quux  end",""], 0, 4, "g", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":1,"reg":["",""]}],
  ["pending register", ["foo bar baz","qux.quux  end",""], 0, 4, "\"", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":1,"reg":["",""]}],
  ["pending insert C-r", ["foo bar baz","qux.quux  end",""], 0, 4, "i<C-r>", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":4,"mode":"i","esc":1,"reg":["",""]}],
  ["pending d2", ["foo bar baz","qux.quux  end",""], 0, 4, "d2", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":1,"reg":["",""]}],
  ["cancel dy", ["foo bar baz","qux.quux  end",""], 0, 4, "dyw", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":8,"mode":"n","esc":0,"reg":["",""]}],
  ["cancel d<Esc>", ["foo bar baz","qux.quux  end",""], 0, 4, "d<Esc>x", {"lines":["foo ar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["b","v"]}],
  ["cancel 2<Esc>", ["foo bar baz","qux.quux  end",""], 0, 4, "2<Esc>x", {"lines":["foo ar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["b","v"]}],
  ["cancel dx", ["foo bar baz","qux.quux  end",""], 0, 4, "dx", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["",""]}],
  ["register \"a", ["foo bar baz","qux.quux  end",""], 0, 0, "\"ayw\"ap", {"lines":["ffoo oo bar baz","qux.quux  end",""],"row":0,"col":4,"mode":"n","esc":0,"reg":["foo ","v"]}],
  ["register \"A append", ["foo bar baz","qux.quux  end",""], 0, 0, "\"ayiww\"Ayiw\"aP", {"lines":["foo foobarbar baz","qux.quux  end",""],"row":0,"col":9,"mode":"n","esc":0,"reg":["foobar","v"]}],
  ["register \"_", ["foo bar baz","qux.quux  end",""], 0, 0, "yiww\"_dw0P", {"lines":["foofoo baz","qux.quux  end",""],"row":0,"col":2,"mode":"n","esc":0,"reg":["foo","v"]}],
  ["register small delete", ["foo bar baz","qux.quux  end",""], 0, 0, "dwx", {"lines":["ar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["b","v"]}],
  ["register numbered shift", ["foo bar baz","qux.quux  end",""], 0, 0, "dddd", {"lines":[""],"row":0,"col":0,"mode":"n","esc":0,"reg":["qux.quux  end\n","V"]}],
  ["register \"\" explicit", ["foo bar baz","qux.quux  end",""], 0, 0, "\"\"x", {"lines":["oo bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["f","v"]}],
  ["undo cursor after o", ["- [ ] parent","  - [ ] child","  - [ ] other"], 0, 3, "onew<Esc>u", {"lines":["- [ ] parent","  - [ ] child","  - [ ] other"],"row":0,"col":3,"mode":"n","esc":0,"reg":["",""]}],
  ["undo cursor after dd", ["- [ ] parent","  - [ ] child","  - [ ] other"], 1, 3, "jddu", {"lines":["- [ ] parent","  - [ ] child","  - [ ] other"],"row":2,"col":3,"mode":"n","esc":0,"reg":["  - [ ] other\n","V"]}],
  ["undo redo chain", ["foo bar baz","qux.quux  end",""], 0, 0, "xxxuu<C-r>", {"lines":["o bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["o","v"]}],
  ["undo empty change", ["foo bar baz","qux.quux  end",""], 2, 0, "xu", {"lines":["foo bar baz","qux.quux  end",""],"row":2,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["undo after J", ["foo bar baz","qux.quux  end",""], 0, 2, "Ju", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":2,"mode":"n","esc":0,"reg":["",""]}],
  ["empty buffer dd", [""], 0, 0, "dd", {"lines":[""],"row":0,"col":0,"mode":"n","esc":0,"reg":["\n","V"]}],
  ["empty buffer x", [""], 0, 0, "x", {"lines":[""],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["empty buffer p", [""], 0, 0, "p", {"lines":[""],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["single char x", ["a"], 0, 0, "x", {"lines":[""],"row":0,"col":0,"mode":"n","esc":0,"reg":["a","v"]}],
  ["single char dd p", ["a"], 0, 0, "ddp", {"lines":["","a"],"row":1,"col":0,"mode":"n","esc":0,"reg":["a\n","V"]}],
  ["g gUw", ["foo bar baz","qux.quux  end",""], 0, 1, "gUw", {"lines":["fOO bar baz","qux.quux  end",""],"row":0,"col":1,"mode":"n","esc":0,"reg":["",""]}],
  ["g guu", ["Abc dEf","  xyz"], 0, 5, "guu", {"lines":["abc def","  xyz"],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["g gUU", ["foo bar baz","qux.quux  end",""], 0, 5, "gUU", {"lines":["FOO BAR BAZ","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["g g~iw repeat", ["Abc dEf","  xyz"], 0, 5, "g~iwj.", {"lines":["Abc DeF","  XYZ"],"row":1,"col":2,"mode":"n","esc":0,"reg":["",""]}],
  ["g gJ", ["- [ ] parent","  - [ ] child","  - [ ] other"], 0, 5, "gJ", {"lines":["- [ ] parent  - [ ] child","  - [ ] other"],"row":0,"col":12,"mode":"n","esc":0,"reg":["",""]}],
  ["g ge", ["foo bar baz","qux.quux  end",""], 0, 5, "ge", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":2,"mode":"n","esc":0,"reg":["",""]}],
  ["g gE", ["foo bar baz","qux.quux  end",""], 1, 9, "gE", {"lines":["foo bar baz","qux.quux  end",""],"row":1,"col":7,"mode":"n","esc":0,"reg":["",""]}],
  ["g 2gI", ["- [ ] parent","  - [ ] child","  - [ ] other"], 1, 5, "2gIx<Esc>", {"lines":["- [ ] parent","xx  - [ ] child","  - [ ] other"],"row":1,"col":1,"mode":"n","esc":0,"reg":["",""]}],
  ["g dge", ["foo bar baz","qux.quux  end",""], 0, 5, "dge", {"lines":["for baz","qux.quux  end",""],"row":0,"col":2,"mode":"n","esc":0,"reg":["o ba","v"]}],
  ["g visual gJ", ["- [ ] parent","  - [ ] child","  - [ ] other"], 0, 0, "VjgJ", {"lines":["- [ ] parent  - [ ] child","  - [ ] other"],"row":0,"col":12,"mode":"n","esc":0,"reg":["",""]}],
  ["g visual U", ["foo bar baz","qux.quux  end",""], 0, 0, "veU", {"lines":["FOO bar baz","qux.quux  end",""],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["g visual gu", ["ABC DEF"], 0, 0, "vegu", {"lines":["abc DEF"],"row":0,"col":0,"mode":"n","esc":0,"reg":["",""]}],
  ["force dvj", ["foo bar baz","qux.quux  end",""], 0, 1, "dvj", {"lines":["fux.quux  end",""],"row":0,"col":1,"mode":"n","esc":0,"reg":["oo bar baz\nq","v"]}],
  ["force dVw", ["foo bar baz","qux.quux  end",""], 0, 1, "dVw", {"lines":["qux.quux  end",""],"row":0,"col":1,"mode":"n","esc":0,"reg":["foo bar baz\n","V"]}],
  ["force dve", ["foo bar baz","qux.quux  end",""], 0, 1, "dve", {"lines":["fo bar baz","qux.quux  end",""],"row":0,"col":1,"mode":"n","esc":0,"reg":["o","v"]}],
  ["force pending", ["foo bar baz","qux.quux  end",""], 0, 1, "dv", {"lines":["foo bar baz","qux.quux  end",""],"row":0,"col":1,"mode":"nov","esc":0,"reg":["",""]}],
  ["tab j", ["\tab","xxxxxxxxxxxx"], 0, 0, "j", {"lines":["\tab","xxxxxxxxxxxx"],"row":1,"col":7,"mode":"n","esc":0,"reg":["",""]}],
  ["tab >>", ["\tab"], 0, 0, ">>", {"lines":["          ab"],"row":0,"col":7,"mode":"n","esc":0,"reg":["",""]}],
  ["tab x", ["\tab"], 0, 0, "x", {"lines":["ab"],"row":0,"col":0,"mode":"n","esc":0,"reg":["\t","v"]}],
];

describe('matches recorded Neovim behaviour', () => {
  const families = new Map();
  for (const row of NVIM) {
    const family = row[0].split(' ')[0];
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(row);
  }
  for (const [family, rows] of families) {
    describe(family, () => {
      for (const [name, lines, row, col, keys, exp] of rows) {
        it(`${name}: ${keys}`, () => {
          const { s, esc } = settle(vimKeys(start(lines, row, col), keysOf(keys)));
          const cur = vimCursor(s);
          expect(s.text.split('\n')).toEqual(exp.lines);
          expect([cur.line, cur.col]).toEqual([exp.row, exp.col]);
          expect(vimNvimMode(s)).toBe(exp.mode);
          expect(esc).toBe(exp.esc);
          expect(regPair(s.registers['"'])).toEqual(exp.reg);
          if (exp.anchor) {
            const a = vimAnchor(s);
            expect([a.line, a.col]).toEqual(exp.anchor);
          }
          expect(s.unsupported).toBe(false);
        });
      }
    });
  }
});

// tests/vim-parity/golden.jsonl.gz: Neovim's observations for every sequence of up to two keys
// over the full 53-key alphabet from all twelve starting buffers, plus seeded random sequences
// (3-6 keys over the full, objects and visual alphabets), recorded by `check.mjs --record`. Replaying them offline gives the unit tests
// (and the mutation run) the parity check's verdicts without a Neovim.
describe('golden Neovim observations', () => {
  // (vitest's jsdom environment does not give a file: import.meta.url, so resolve from the cwd)
  const file = ['tests/fixtures/vim-golden.jsonl.gz', '<kit>/tests/fixtures/vim-golden.jsonl.gz'].map((p) => resolve(process.cwd(), p)).find(existsSync);
  const golden = gunzipSync(readFileSync(file))
    .toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
  const byStart = new Map();
  for (const row of golden) {
    if (!byStart.has(row.s)) byStart.set(row.s, []);
    byStart.get(row.s).push(row);
  }
  for (const [id, rows] of byStart) {
    it(`${id}: ${rows.length} sequences`, () => {
      const st = STARTS.find((x) => x.id === id);
      const bad = [];
      for (const row of rows) {
        const { s, esc } = settle(vimKeys(start(st.lines, st.row, st.col), row.k));
        const cur = vimCursor(s);
        const got = { t: s.text, c: [cur.line, cur.col], m: vimNvimMode(s), e: esc, r: regPair(s.registers['"']) };
        const want = { t: row.t, c: row.c, m: row.m || 'n', e: row.e || 0, r: row.r || ['', ''] };
        if (row.v) {
          const a = vimAnchor(s);
          got.v = a ? [a.line, a.col] : null;
          want.v = row.v;
        }
        if (JSON.stringify(got) !== JSON.stringify(want)) bad.push({ keys: row.k.join(' '), got, want });
      }
      expect(bad.slice(0, 5)).toEqual([]);
    });
  }
});

describe('API and state', () => {
  it('createVim builds plain normal-mode state', () => {
    const s = createVim('ab\ncd', 4);
    expect(s.mode).toBe('normal');
    expect(vimCursor(s)).toEqual({ line: 1, col: 1 });
    expect(s.anchor).toBeNull();
    expect(s.pending).toEqual([]);
    expect(s.undo).toEqual([]);
    expect(s.redo).toEqual([]);
    expect(s.lastChange).toBeNull();
    expect(s.registers['"']).toBeNull();
    expect(JSON.parse(JSON.stringify(s)).text).toBe('ab\ncd');
  });
  it('clamps a cursor past the end of a line onto its last character', () => {
    expect(vimCursor(createVim('abc', 3))).toEqual({ line: 0, col: 2 });
    expect(vimCursor(createVim('abc', 99))).toEqual({ line: 0, col: 2 });
    expect(vimCursor(createVim('abc', -5))).toEqual({ line: 0, col: 0 });
    expect(vimCursor(createVim('', 0))).toEqual({ line: 0, col: 0 });
  });
  it('vimKey never mutates its input', () => {
    const deepFreeze = (o) => {
      if (o && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const v of Object.values(o)) deepFreeze(v);
      }
      return o;
    };
    let s = createVim('foo bar\n  baz', 0);
    for (const k of keysOf('dwxpuu<C-r>ihi<CR><Esc>vjd.yyPJ>>')) {
      const before = JSON.stringify(s);
      const next = vimKey(deepFreeze(s), k);
      expect(JSON.stringify(s)).toBe(before);
      s = next;
    }
  });
  it('is deterministic', () => {
    const keys = keysOf('dwjci"x<Esc>u.p');
    expect(JSON.stringify(vimKeys(createVim('a "b" c\nd "e" f', 0), keys))).toBe(JSON.stringify(vimKeys(createVim('a "b" c\nd "e" f', 0), keys)));
  });
  it('vimKeys equals vimKey applied in turn', () => {
    const keys = keysOf('wdwiX<Esc>Vjy');
    let s = createVim('a b c\nd e', 0);
    for (const k of keys) s = vimKey(s, k);
    expect(vimKeys(createVim('a b c\nd e', 0), keys)).toEqual(s);
  });
  it('reports modes for the indicator', () => {
    const s = createVim('abc def', 0);
    expect(vimMode(s)).toBe('normal');
    expect(vimMode(vimKey(s, 'i'))).toBe('insert');
    expect(vimMode(vimKeys(s, ['i', '<C-r>']))).toBe('insert-pending');
    expect(vimMode(vimKey(s, 'v'))).toBe('visual');
    expect(vimMode(vimKey(s, 'V'))).toBe('visual-line');
    expect(vimMode(vimKey(s, 'd'))).toBe('operator-pending');
    expect(vimMode(vimKey(s, 'r'))).toBe('replace-pending');
    expect(vimMode(vimKey(s, '2'))).toBe('pending');
    expect(vimMode(vimKey(s, 'f'))).toBe('pending');
    expect(vimMode(vimKeys(s, ['"', 'a']))).toBe('normal');
  });
  it('maps modes to nvim_get_mode() and blocking', () => {
    const s = createVim('abc def', 0);
    expect(vimNvimMode(vimKey(s, 'd'))).toBe('no');
    expect(vimBlocking(vimKey(s, 'd'))).toBe(false);
    expect(vimBlocking(vimKeys(s, ['d', '2']))).toBe(true);
    expect(vimBlocking(vimKeys(s, ['i', '<C-r>']))).toBe(true);
    expect(vimBlocking(s)).toBe(false);
    expect(vimNvimMode(vimKey(s, 'v'))).toBe('v');
    expect(vimNvimMode(vimKey(s, 'V'))).toBe('V');
    expect(vimNvimMode(vimKey(s, 'a'))).toBe('i');
  });
  it('exposes the visual anchor', () => {
    const s = vimKeys(createVim('abc def', 4), ['v', 'l']);
    expect(vimAnchor(s)).toEqual({ line: 0, col: 4 });
    expect(vimCursor(s)).toEqual({ line: 0, col: 5 });
    expect(vimAnchor(createVim('x', 0))).toBeNull();
  });
  it('exports its defaults', () => {
    expect(DEFAULTS.shiftwidth).toBe(2);
    expect(DEFAULTS.expandtab).toBe(true);
    expect(MAXCOL).toBeGreaterThan(1e9);
  });
});

describe('parser', () => {
  it('classifies partial and complete commands', () => {
    expect(parseNormal(['d'], false)).toMatchObject({ status: 'incomplete', blocking: false, op: 'd' });
    expect(parseNormal(['2', 'd', '3'], false)).toMatchObject({ status: 'incomplete', blocking: true });
    expect(parseNormal(['2', 'd', '3', 'w'], false)).toMatchObject({ status: 'done', op: 'd', cmd: 'w', count0: 6, count1: 6 });
    expect(parseNormal(['"', 'a', 'y', 'y'], false)).toMatchObject({ status: 'done', reg: 'a', op: 'y', lineop: true });
    expect(parseNormal(['d', 'y'], false)).toMatchObject({ status: 'cancel' });
    expect(parseNormal(['d', '"'], false)).toMatchObject({ status: 'cancel' });
    expect(parseNormal(['f', '<Esc>'], false)).toMatchObject({ status: 'cancel' });
    expect(parseNormal(['"', '<Esc>'], false)).toMatchObject({ status: 'cancel' });
    expect(parseNormal(['"', '!'], false)).toMatchObject({ status: 'unsupported' });
    expect(parseNormal(['d', 'i'], false)).toMatchObject({ status: 'incomplete', blocking: true, waiting: 'obj' });
    expect(parseNormal(['i'], true)).toMatchObject({ status: 'incomplete', waiting: 'obj' });
    expect(parseNormal(['i'], false)).toMatchObject({ status: 'done', cmd: 'i' });
    expect(parseNormal(['d'], true)).toMatchObject({ status: 'done', visualOp: true });
    expect(parseNormal(['0'], false)).toMatchObject({ status: 'done', cmd: '0' });
    expect(parseNormal(['1', '0', 'x'], false)).toMatchObject({ status: 'done', cmd: 'x', count0: 10 });
    expect(parseNormal(['d', 'r'], false)).toMatchObject({ status: 'done', cmd: 'r', nchar: null });
  });
});

describe('failure paths and unsupported commands', () => {
  it('flags an unknown normal-mode key and leaves the text alone', () => {
    const s = vimKey(createVim('abc', 0), '<F1>');
    expect(s.unsupported).toBe(true);
    expect(s.text).toBe('abc');
  });
  it('flags an unknown insert-mode key', () => {
    const s = vimKeys(createVim('abc', 0), ['i', '<Left>']);
    expect(s.unsupported).toBe(true);
    expect(s.mode).toBe('insert');
  });
  it('flags g-commands other than gg, unsupported text objects and {count}v reselect', () => {
    expect(vimKeys(createVim('abc', 0), ['g', 'v']).unsupported).toBe(true);
    expect(vimKeys(createVim('(abc)', 1), ['d', 'i', 'b']).unsupported).toBe(true);
    expect(vimKeys(createVim('(abc)', 1), ['d', 'v', 'l']).text).toBe('(c)'); // o_v makes l inclusive (nvim: "(c)")
    expect(vimKeys(createVim('abc', 0), ['v', 'I']).unsupported).toBe(true);
    const afterVisualOp = vimKeys(createVim('abc def', 0), ['v', 'y']);
    expect(vimKeys(afterVisualOp, ['2', 'v']).unsupported).toBe(true);
    expect(vimKeys(createVim('abc', 0), ['2', 'v']).unsupported).toBe(false);
  });
  it('a pending operator is abandoned by keys that cannot follow it', () => {
    for (const k of ['x', 'X', 'J', 'p', 'u', '<C-r>', '.', 'o', 'O', 'A', 'I', '<Esc>', 'r', 's', 'S', 'D', 'C']) {
      const s = vimKeys(createVim('abc def', 4), ['d', k]);
      expect(s.text).toBe('abc def');
      expect(s.pending).toEqual([]);
    }
  });
  it('dot with nothing to repeat does nothing', () => {
    const s = vimKey(createVim('abc', 1), '.');
    expect(s.text).toBe('abc');
    expect(vimCursor(s)).toEqual({ line: 0, col: 1 });
  });
  it('undo and redo with empty stacks do nothing', () => {
    expect(vimKey(createVim('abc', 1), 'u').text).toBe('abc');
    expect(vimKey(createVim('abc', 1), '<C-r>').text).toBe('abc');
  });
  it('a failed find with an operator deletes nothing', () => {
    const s = vimKeys(createVim('abc', 0), ['d', 'f', 'z']);
    expect(s.text).toBe('abc');
    expect(s.registers['"']).toBeNull();
  });
  it('register <C-r> in insert mode with an unknown or empty register', () => {
    expect(vimKeys(createVim('abc', 0), ['i', '<C-r>', 'q', '<Esc>']).text).toBe('abc');
    expect(vimKeys(createVim('abc', 0), ['i', '<C-r>', '<Esc>', 'x', '<Esc>']).text).toBe('xabc');
    expect(vimKeys(createVim('abc', 0), ['i', '<C-r>', '!']).unsupported).toBe(true);
  });
  it('r with a special key or Tab', () => {
    expect(vimKeys(createVim('abc', 0), ['r', '<BS>']).text).toBe('abc');
    expect(vimKeys(createVim('abc', 0), ['r', '<Tab>']).unsupported).toBe(true);
  });
});

describe('options', () => {
  it('noexpandtab indents with tabs once the indent reaches a tabstop', () => {
    const s = vimKeys(createVim('x', 0, { expandtab: false, shiftwidth: 8 }), ['>', '>']);
    expect(s.text).toBe('\tx');
    const t = vimKeys(createVim('x', 0, { expandtab: false, shiftwidth: 4 }), ['>', '>', '>', '>', '>', '>']);
    expect(t.text).toBe('\t    x');
  });
  it('shiftwidth 0 uses tabstop', () => {
    expect(vimKeys(createVim('x', 0, { shiftwidth: 0, tabstop: 4 }), ['>', '>']).text).toBe('    x');
  });
  it('noautoindent opens unindented lines', () => {
    expect(vimKeys(createVim('  a', 0, { autoindent: false }), ['o', 'b', '<Esc>']).text).toBe('  a\nb');
  });
  it('startofline sends dd and G to the first non-blank', () => {
    expect(vimCursor(vimKeys(createVim('a\n  bcd\n  efg', 0, { startofline: true }), ['G']))).toEqual({ line: 2, col: 2 });
  });
  it('joinspaces puts two spaces after a period', () => {
    expect(vimKeys(createVim('end.\nnext', 0, { joinspaces: true }), ['J']).text).toBe('end.  next');
  });
  it('undolevels caps the undo stack', () => {
    const s = vimKeys(createVim('abcdef', 0, { undolevels: 2 }), ['x', 'x', 'x', 'u', 'u', 'u']);
    expect(s.text).toBe('bcdef'); // three changes, only two kept
  });
  it('initial registers are available to put', () => {
    const s = vimKeys(createVim('a', 0, { registers: { '"': { text: 'XY', linewise: false }, a: { text: 'line', linewise: true } } }), ['p', '"', 'a', 'p']);
    expect(s.text).toBe('aXY\nline');
  });
});

describe('properties', () => {
  const ALPHA = ['h', 'j', 'k', 'l', 'w', 'b', 'e', '0', '$', 'G', 'x', 'd', 'c', 'y', 'p', 'P', 'u', '<C-r>', '.', 'i', 'a', 'o', 'O', 'v', 'V', '<Esc>', '<CR>', '<BS>', 'J', '>', '<', 'f', 't', ';', '%', '{', '}', 'r', '"', '2', 'q', ' '];
  // seeded generators in place of fast-check (the kit has no such dependency): random lines over [ a-c"(){}.-], random keys over ALPHA
  const rng = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; };
  const CH = ' abc"(){}.-';
  const gen = (r, maxKeys, alpha = ALPHA) => {
    const nl = 1 + Math.floor(r() * 4), text = Array.from({ length: nl }, () => Array.from({ length: Math.floor(r() * 9) }, () => CH[Math.floor(r() * CH.length)]).join('')).join('\n');
    return { text, cur: Math.floor(r() * 41), keys: Array.from({ length: Math.floor(r() * (maxKeys + 1)) }, () => alpha[Math.floor(r() * alpha.length)]) };
  };
  it('never throws and keeps the cursor on the text', () => {
    const r = rng(20261012);
    for (let n = 0; n < 400; n++) {
      const { text, cur, keys } = gen(r, 14);
      let s = createVim(text, cur);
      for (const k of keys) {
        s = vimKey(s, k);
        const lines = s.text.split('\n'), c = vimCursor(s);
        expect(c.line).toBeLessThan(lines.length);
        // (normal mode can briefly leave the cursor on the end-of-line position, as Neovim does after an empty Visual delete or a failed Visual J)
        expect(c.col).toBeLessThanOrEqual(lines[c.line].length);
        expect(['normal', 'insert', 'visual', 'visual-line']).toContain(s.mode);
        expect(s.anchor === null).toBe(!(s.mode === 'visual' || s.mode === 'visual-line'));
      }
    }
  });
  it('vimKeys over a sequence equals vimKey applied key by key', () => {
    const r = rng(7);
    for (let n = 0; n < 300; n++) {
      const { text, cur, keys } = gen(r, 12);
      let one = createVim(text, cur);
      for (const k of keys) one = vimKey(one, k);
      expect(vimKeys(createVim(text, cur), keys)).toEqual(one);
    }
    // regression: the empty-buffer flag outlived the put that refilled the buffer within one call
    expect(vimKeys(createVim('a\nb', 0), ['d', 'G', 'p', 's', 'X', '<Esc>']).text).toBe('\nX\nb');
  });
  it('undoing every change restores the original text', () => {
    const r = rng(99), alpha = ALPHA.filter((k) => k !== 'u' && k !== '<C-r>');
    for (let n = 0; n < 300; n++) {
      const { text, keys } = gen(r, 12, alpha);
      let s = vimKeys(createVim(text, 0), [...keys, '<Esc>', '<Esc>']);
      if (s.mode !== 'normal' || s.pending.length) s = vimKeys(s, ['<Esc>', '<Esc>']);
      const m = s.undo.length;
      for (let i = 0; i < m; i += 1) s = vimKey(s, 'u');
      expect(s.text).toBe(text);
    }
  });
});
