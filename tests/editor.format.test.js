import { describe, it, expect } from 'vitest';
import { applyFormat, formatAt, readSpans, stripSpans, parseOpen, openTag, spanClasses, stepSize, createFormatSheet, cleanAttrs, MIXED, FONTS, SIZES, PALETTE } from '../lib/editor/format.js';

// a stand-in for an app's marker finder: `**` pairs are markers
const stars = (plain) => { const out = []; for (let i = plain.indexOf('**'); i >= 0; i = plain.indexOf('**', i + 2)) out.push([i, i + 2]); return out; };
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

describe('format spans: the text is the formatting', () => {
  it('writes a span around the selection and reads it back', () => {
    const r = applyFormat('hello big world', 6, 9, { font: 'georgia', size: 18, color: 'D93025', bg: '#FFF2CC' });
    expect(r.body).toBe('hello <span data-f="georgia" data-s="18" data-t="d93025" data-h="fff2cc">big</span> world');
    expect(r.body.slice(r.start, r.end)).toBe('big');
    expect(stripSpans(r.body)).toBe('hello big world');
    expect(formatAt(r.body, r.start, r.end)).toEqual({ font: 'georgia', size: 18, color: 'd93025', bg: 'fff2cc' });
  });
  it('is idempotent by value: the same patch twice is the same text', () => {
    const once = applyFormat('abc def', 0, 3, { size: 24 });
    const twice = applyFormat(once.body, once.start, once.end, { size: 24 });
    expect(twice.body).toBe(once.body);
  });
  it('a patch merges into what is there; null clears one attribute; clear removes every attribute', () => {
    let r = applyFormat('abcdef', 1, 4, { size: 20, color: 'ff0000' });
    r = applyFormat(r.body, r.start, r.end, { bg: 'ffff00' });
    expect(formatAt(r.body, r.start, r.end)).toEqual({ font: null, size: 20, color: 'ff0000', bg: 'ffff00' });
    r = applyFormat(r.body, r.start, r.end, { color: null });
    expect(formatAt(r.body, r.start, r.end).color).toBeNull();
    r = applyFormat(r.body, r.start, r.end, { clear: true });
    expect(r.body).toBe('abcdef');
  });
  it('formatting part of a span splits it; formatting across spans reports MIXED until applied', () => {
    const a = applyFormat('one two three', 0, 3, { size: 18 });
    const b = applyFormat(a.body, a.body.indexOf('two'), a.body.indexOf('two') + 3, { size: 24 });
    const all = formatAt(b.body, 0, b.body.length);
    expect(all.size).toBe(MIXED);
    const c = applyFormat(b.body, 0, b.body.length, { size: 12 });
    expect(formatAt(c.body, 0, c.body.length).size).toBe(12);
    expect(stripSpans(c.body)).toBe('one two three');
  });
  it('never nests: a patch over a span inside a longer selection flattens', () => {
    const a = applyFormat('abcdef', 2, 4, { color: '0000ff' });
    const b = applyFormat(a.body, 0, a.body.length, { size: 14 });
    expect(b.body.match(/<span/g).length).toBe(3);
    expect(b.body).not.toMatch(/<span[^>]*><span/);
  });
  it('cuts a span around another mark\'s markers so pairs stay pairs', () => {
    const body = 'a **bold** b';
    const r = applyFormat(body, 0, body.length, { color: 'ff0000' }, { barriers: stars });
    expect(r.body).toBe('<span data-t="ff0000">a </span>**<span data-t="ff0000">bold</span>**<span data-t="ff0000"> b</span>');
    expect(stripSpans(r.body)).toBe(body);
    // formatting only the bold words writes the span inside the markers
    const inner = applyFormat(body, 4, 8, { size: 20 }, { barriers: stars });
    expect(inner.body).toBe('a **<span data-s="20">bold</span>** b');
    expect(inner.body.slice(inner.start, inner.end)).toBe('bold');
  });
  it('a selection that spans hidden tags maps to the text it covers', () => {
    const a = applyFormat('xx yy zz', 3, 5, { font: 'mono' });
    // select from before the open tag through after the close tag (what a drag over hidden syntax does)
    const r = applyFormat(a.body, 0, a.body.length, { size: 16 });
    expect(stripSpans(r.body)).toBe('xx yy zz');
    expect(formatAt(r.body, 0, r.body.length).size).toBe(16);
  });
  it('junk is dropped, an unmatched tag is literal text, nothing throws', () => {
    expect(parseOpen('<span data-s="999999">')).toBeNull();
    expect(parseOpen('<span data-f="nope">')).toBeNull();
    expect(readSpans('a <span data-s="12">no close').plain).toBe('a <span data-s="12">no close');
    expect(readSpans('a </span> b').plain).toBe('a </span> b');
    expect(applyFormat('abc', 1, 1, { size: 12 }).body).toBe('abc');
    expect(applyFormat('abc', 0, 3, { size: 'huge', font: 'comic sans', color: 'red' }).body).toBe('abc');
    expect(applyFormat('abc', 0, 3, null).body).toBe('abc');
    expect(cleanAttrs({ size: '18', color: '#ABCDEF', font: 'x', bg: 3 })).toEqual({ size: 18, color: 'abcdef' });
  });
  it('property: any patch over any body keeps the text and is idempotent (4,000 random cases)', () => {
    const r = rng(7), words = ['a', 'bc', ' ', '**', 'x y', '<b>', '</b>', 'é'], pick = (a) => a[Math.floor(r() * a.length)];
    const patches = [{ size: 18 }, { font: 'serif' }, { color: 'ff0000' }, { bg: 'ffff00' }, { color: null }, { clear: true }, { size: 12, font: 'mono' }];
    for (let n = 0; n < 4000; n++) {
      let body = ''; for (let k = Math.floor(r() * 8); k > 0; k--) body += pick(words);
      for (let step = 0; step < 3; step++) {
        const s = Math.floor(r() * (body.length + 1)), e = Math.floor(r() * (body.length + 1));
        const patch = pick(patches);
        const o = applyFormat(body, s, e, patch, { barriers: stars });
        expect(stripSpans(o.body)).toBe(stripSpans(body));
        const again = applyFormat(o.body, o.start, o.end, patch, { barriers: stars });
        expect(again.body).toBe(o.body);
        body = o.body;
      }
    }
  });
  it('classes and tags are the same text, the same way', () => {
    expect(openTag({ size: 18, font: 'serif' })).toBe('<span data-f="serif" data-s="18">');
    expect(spanClasses({ font: 'serif', size: 18, color: 'ff0000', bg: 'ffff00' })).toEqual(['ff-serif', 'fs-18', 'tc-ff0000', 'hc-ffff00']);
    expect(spanClasses({ font: 'zzz' })).toEqual([]);
  });
  it('the stepper walks the size list from the document size and clamps', () => {
    expect(stepSize(null, 1, 16)).toBe(18);
    expect(stepSize(null, -1, 16)).toBe(14);
    expect(stepSize(18, 1)).toBe(20);
    expect(stepSize(96, 1)).toBe(96);
    expect(stepSize(10, -1)).toBe(10);
    expect(stepSize(15, 1)).toBe(16);
  });
  it('the palette is Google\'s 10 by 8 grid of distinct colours and every font has a stack', () => {
    expect(PALETTE.length).toBe(80); expect(new Set(PALETTE).size).toBe(80);
    expect(FONTS.every((f) => f.stack && f.label)).toBe(true);
    expect(SIZES.includes(11) && SIZES.includes(18)).toBe(true);
  });
  it('the stylesheet carries a rule for every class, and any colour on demand', () => {
    const sheet = createFormatSheet(document);
    const n = sheet.rules();
    expect(n).toBeGreaterThan(FONTS.length + SIZES.length + PALETTE.length);
    sheet.ensure({ color: '123456', size: 15 });
    expect(sheet.rules()).toBe(n + 2);
    sheet.ensure({ color: '123456', size: 15 });
    expect(sheet.rules()).toBe(n + 2); // a repeat adds nothing
  });
});
