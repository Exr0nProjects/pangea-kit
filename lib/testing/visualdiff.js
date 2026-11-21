// Screenshot pixel diff and HTML report (pangea-ui-kit testing, GUIDE section 7). Node only, no dependencies:
// PNG is decoded and encoded here with node:zlib (8-bit RGB/RGBA/gray, non-interlaced: what Playwright and
// Chrome write). diffImages compares two screenshots with a colour threshold (YIQ distance, the pixelmatch
// metric), an antialias tolerance (a pixel whose colour exists within `shift` px in the other image is not a
// difference: one-pixel text and edge rendering jitter), and masks (rectangles never compared: clocks,
// spinners). writeReport writes index.html with A, B and the diff side by side for every view.

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

/** Decode a PNG buffer to { width, height, data: Uint8Array RGBA }. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let off = 8; let width = 0; let height = 0; let bitDepth = 0; let colorType = 0; let interlace = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8); const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); bitDepth = body[8]; colorType = body[9]; interlace = body[12]; }
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace) throw new Error(`unsupported PNG (bit depth ${bitDepth}, interlace ${interlace})`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride); const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0; const b = prev[x]; const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a; else if (filter === 2) v += b; else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4; const i = x * channels;
      if (channels >= 3) { out[o] = cur[i]; out[o + 1] = cur[i + 1]; out[o + 2] = cur[i + 2]; out[o + 3] = channels === 4 ? cur[i + 3] : 255; }
      else { out[o] = out[o + 1] = out[o + 2] = cur[i]; out[o + 3] = channels === 2 ? cur[i + 1] : 255; }
    }
    prev = Uint8Array.from(cur);
  }
  return { width, height, data: out };
}

/** Encode { width, height, data RGBA } as a PNG buffer. */
export function encodePng({ width, height, data }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) { raw[y * (width * 4 + 1)] = 0; Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1); }
  const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb)); return Buffer.concat([len, tb, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// YIQ colour distance normalized to [0,1] (35215 is the maximum squared delta).
function delta(a, i, b, j) {
  const blend = (c, al) => 255 + (c - 255) * (al / 255);
  const r1 = blend(a[i], a[i + 3]); const g1 = blend(a[i + 1], a[i + 3]); const b1 = blend(a[i + 2], a[i + 3]);
  const r2 = blend(b[j], b[j + 3]); const g2 = blend(b[j + 1], b[j + 3]); const b2 = blend(b[j + 2], b[j + 3]);
  const y = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223;
  const ii = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189;
  const q = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
  return (0.5053 * y * y + 0.299 * ii * ii + 0.1957 * q * q) / 35215;
}

/**
 * Compare two decoded images (or PNG buffers). Options: threshold (per-pixel colour distance, 0..1, default
 * 0.1), shift (antialias tolerance radius in px, default 1; 0 disables), masks ([{x,y,w,h}] in image pixels).
 * Returns { width, height, sizeMismatch, diffPixels, compared, ratio, diff: RGBA image (red = differs,
 * blue = masked, faded original elsewhere) }.
 */
export function diffImages(a, b, { threshold = 0.1, shift = 1, masks = [] } = {}) {
  const A = Buffer.isBuffer(a) ? decodePng(a) : a; const B = Buffer.isBuffer(b) ? decodePng(b) : b;
  const width = Math.max(A.width, B.width); const height = Math.max(A.height, B.height);
  const out = new Uint8Array(width * height * 4);
  const inMask = (x, y) => masks.some((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h);
  const at = (img, x, y) => (x < img.width && y < img.height ? (y * img.width + x) * 4 : -1);
  const near = (src, i, other, x, y) => {
    for (let dy = -shift; dy <= shift; dy += 1) for (let dx = -shift; dx <= shift; dx += 1) {
      const j = at(other, x + dx, y + dy);
      if (x + dx >= 0 && y + dy >= 0 && j >= 0 && delta(src.data, i, other.data, j) <= threshold) return true;
    }
    return false;
  };
  let diffPixels = 0; let compared = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const o = (y * width + x) * 4; const i = at(A, x, y); const j = at(B, x, y);
    if (inMask(x, y)) { out[o] = 80; out[o + 1] = 120; out[o + 2] = 255; out[o + 3] = 255; continue; }
    compared += 1;
    let differs = i < 0 || j < 0 || delta(A.data, i, B.data, j) > threshold;
    if (differs && i >= 0 && j >= 0 && shift > 0 && near(A, i, B, x, y) && near(B, j, A, x, y)) differs = false;
    if (differs) { diffPixels += 1; out[o] = 255; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 255; }
    else { const src = i >= 0 ? A.data : B.data; const k = i >= 0 ? i : j; const g = 255 - (255 - (src[k] * 0.3 + src[k + 1] * 0.59 + src[k + 2] * 0.11)) * 0.15; out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255; }
  }
  return { width, height, sizeMismatch: A.width !== B.width || A.height !== B.height, diffPixels, compared, ratio: compared ? diffPixels / compared : 0, diff: { width, height, data: out } };
}

const esc = (s) => String(s).replace(/[&<>"]/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * entries: [{ view, viewport, a: pngBuffer|null, b: pngBuffer|null, maxRatio, threshold?, shift?, masks?, note? }].
 * Writes <dir>/<view>-<viewport>-{a,b,diff}.png and <dir>/index.html; returns { path, results }.
 * A view with a missing side fails (a view that cannot be captured on one build is not parity).
 */
export function writeReport(dir, entries, { title = 'Visual diff' } = {}) {
  mkdirSync(dir, { recursive: true });
  const results = [];
  for (const e of entries) {
    const slug = `${e.view}-${e.viewport}`.replace(/[^\w.-]+/gu, '_');
    const row = { view: e.view, viewport: e.viewport, maxRatio: e.maxRatio, note: e.note || null };
    if (e.a) writeFileSync(join(dir, `${slug}-a.png`), e.a);
    if (e.b) writeFileSync(join(dir, `${slug}-b.png`), e.b);
    if (!e.a || !e.b) Object.assign(row, { pass: false, ratio: null, missing: !e.a ? 'a' : 'b' });
    else {
      const d = diffImages(e.a, e.b, { threshold: e.threshold, shift: e.shift, masks: e.masks || [] });
      writeFileSync(join(dir, `${slug}-diff.png`), encodePng(d.diff));
      Object.assign(row, { ratio: Number(d.ratio.toFixed(6)), diffPixels: d.diffPixels, sizeMismatch: d.sizeMismatch, pass: !d.sizeMismatch && d.ratio <= e.maxRatio });
    }
    row.files = { a: `${slug}-a.png`, b: `${slug}-b.png`, diff: `${slug}-diff.png` };
    results.push(row);
  }
  const rows = results.map((r) => `<section class="${r.pass ? 'pass' : 'fail'}"><h2>${esc(r.view)} · ${esc(r.viewport)} · ${r.pass ? 'pass' : 'FAIL'} · ratio ${r.ratio ?? '—'} (max ${r.maxRatio})${r.missing ? ` · missing on ${r.missing}` : ''}${r.note ? ` · ${esc(r.note)}` : ''}</h2>
<div class="row"><figure><img src="${r.files.a}" loading="lazy"><figcaption>A</figcaption></figure><figure><img src="${r.files.b}" loading="lazy"><figcaption>B</figcaption></figure><figure><img src="${r.files.diff}" loading="lazy"><figcaption>diff (red differs, blue masked)</figcaption></figure></div></section>`).join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:13px ui-monospace,monospace;background:#f4efe3;color:#111;margin:20px}h1{font-size:16px}h2{font-size:13px;font-weight:normal}section{margin:0 0 28px}.fail h2{color:#b00}.row{display:flex;gap:10px}figure{margin:0;flex:1}img{width:100%;border:1px solid #111;background:#fff}figcaption{padding:2px 0}</style><h1>${esc(title)}: ${results.filter((r) => r.pass).length}/${results.length} pass</h1>\n${rows}`;
  const path = join(dir, 'index.html');
  writeFileSync(path, html);
  return { path, results };
}
