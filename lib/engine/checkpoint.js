// Checkpoints for keyed rows (PANGEA3-DESIGN §11 "Compaction" and §3 CRDTDocumentPattern: state = snapshot + deltas since
// snapshot_seq; row #43). A checkpoint is the fold of a row Stream up to a cursor (the data plane's ingest_seq): every row,
// tombstones included, with its per-field stamps. Because the rows merge is per-field LWW (commutative, associative,
// idempotent: rows.js mergeRow), fold(checkpoint at C) then every entry after C equals the fold of the whole log, in any
// order of arrival, and a checkpoint applied twice changes nothing. So a cold device needs only the checkpoint and the
// tail, never the whole log (zai3, 2026-11-16: 51 MB of 2026-11-10 import entries on a new device before the first line;
// The owner 14:13 PST: "it should load the blocks around now immediately and lock the scroll then load other stuff in bg").
// Nothing is deleted from the log (no frontier is needed: a checkpoint is a derived base for readers, A2), and nothing is
// lossy (a tombstone keeps every field, so an undo or a restore that revives it finds its text).
//
// Parts: a checkpoint is cut into a `hot` part (the rows a first paint needs: `around` the app's landing row in sort
// order) and `rest.<n>` parts (everything else, chunked by bytes), so the client paints from the small part and folds the
// rest in the background; every part carries the same cursor.
//
// Sealing: gzip, then AES-256-GCM under HKDF(secret, "qk-checkpoint:" + name) with a fresh 96-bit IV; the AAD is the part's
// header (name, part, cursor, row count), so a part cannot be replayed as another part, another stream or another cursor.
// Wire: [u32 BE header length][header JSON][12-byte IV][ciphertext]. Runs in a browser, a Worker and Node (WebCrypto and
// CompressionStream only).
const enc = new TextEncoder(), dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

/** A folded row as the patch that recreates it: every field with its own stamp (internal `_` fields never travel). */
export const rowPatch = (row) => {
  const set = {}, at = {};
  for (const [f, s] of Object.entries(row?._s || {})) { if (f === 'id' || f.startsWith('_') || typeof s !== 'string') continue; set[f] = row[f] ?? null; at[f] = s; }
  return { id: row.id, set, at };
};
/** Rows as Stream entries a replica ingests (rows.ingest, foldRows): one synthetic entry, the same wire as a push. */
export const asEntries = (rows) => [{ payload: { type: 'rows', payload: { rows: rows.map((r) => (r._s ? rowPatch(r) : r)) } } }];

const cmpKey = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) { const x = a[i], y = b[i]; if (x === y) continue; if (typeof x !== typeof y) return typeof x === 'number' ? -1 : 1; return x < y ? -1 : 1; } return a.length - b.length; };

/** Cut folded rows into parts. `landing(row)`: the first live row (in sort order) at or after which the app opens; the hot part
 *  is `before` live rows before it and `after` from it on; every other row (other live rows and every tombstone) goes to rest
 *  parts of at most `chunkBytes` of JSON. Pure. */
export function splitCheckpoint(rows, { sortKey, live, landing, before = 300, after = 500, chunkBytes = 4_000_000 }) {
  const lv = rows.filter((r) => live(r)).map((r) => ({ r, k: sortKey(r) })).sort((a, b) => cmpKey(a.k, b.k) || (a.r.id < b.r.id ? -1 : 1)).map((x) => x.r);
  let i = lv.findIndex((r) => landing(r)); if (i < 0) i = lv.length;
  const hot = lv.slice(Math.max(0, i - before), i + after), hotIds = new Set(hot.map((r) => r.id));
  const rest = [], parts = [];
  let bytes = 0;
  for (const r of rows) {
    if (hotIds.has(r.id)) continue;
    const b = JSON.stringify(rowPatch(r)).length;
    if (rest.length && bytes + b > chunkBytes) { parts.push(rest.splice(0)); bytes = 0; }
    rest.push(r); bytes += b;
  }
  if (rest.length) parts.push(rest);
  return { hot, rest: parts };
}

async function keyFor(secret, name) {
  const ikm = await subtle().importKey('raw', typeof secret === 'string' ? enc.encode(secret) : secret, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(`qk-checkpoint:${name}`) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const pipe = async (bytes, T) => { // through a (De)CompressionStream: write and read concurrently, collect the chunks
  const t = new T('gzip'), w = t.writable.getWriter(), r = t.readable.getReader(), chunks = [];
  const writing = w.write(ArrayBuffer.isView(bytes) ? bytes : new Uint8Array(bytes)).then(() => w.close(), (e) => { r.cancel(e).catch(() => {}); throw e; });
  let n = 0; for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); n += value.length; }
  await writing;
  const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out;
};

/** Seal one part: { name, part, cursor, rows, extra? } -> Uint8Array. `extra` rides inside the ciphertext (e.g. the logged intents). */
export async function sealPart({ secret, name, part, cursor, rows, extra = null, parts = null }) {
  const header = enc.encode(JSON.stringify({ v: 1, name, part, cursor: String(cursor), n: rows.length, ...(parts ? { parts } : {}) }));
  const body = await pipe(enc.encode(JSON.stringify({ rows: rows.map((r) => (r._s ? rowPatch(r) : r)), ...(extra ? { extra } : {}) })), CompressionStream);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: header }, await keyFor(secret, name), body));
  const out = new Uint8Array(4 + header.length + 12 + ct.length);
  new DataView(out.buffer).setUint32(0, header.length); out.set(header, 4); out.set(iv, 4 + header.length); out.set(ct, 16 + header.length);
  return out;
}
/** The header of a sealed part, readable without the key (the cursor and the part name). */
export function partHeader(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0);
  if (n > 4096 || 4 + n + 12 > b.length) throw new Error('checkpoint: malformed part');
  return { header: JSON.parse(dec.decode(b.subarray(4, 4 + n))), at: 4 + n };
}
/** Open one part: -> { name, part, cursor, rows (patches), extra }. Throws on a wrong key, a tampered byte or a part of another stream. */
export async function openPart({ secret, name, bytes }) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const { header, at } = partHeader(b);
  if (header.v !== 1 || header.name !== name) throw new Error(`checkpoint: part of ${header.name}, not ${name}`);
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: b.subarray(at, at + 12), additionalData: b.subarray(4, at) }, await keyFor(secret, name), b.subarray(at + 12));
  const body = JSON.parse(dec.decode(await pipe(pt, DecompressionStream)));
  if (!Array.isArray(body.rows) || body.rows.length !== header.n) throw new Error('checkpoint: row count does not match its header');
  return { name, part: header.part, cursor: header.cursor, parts: header.parts ?? [], rows: body.rows, extra: body.extra ?? null };
}

/** Seal a whole checkpoint: { hot, rest: [[rows]...] } (splitCheckpoint) -> Map part -> bytes; the hot part's header lists the others. */
export async function sealCheckpoint({ secret, name, cursor, hot, rest, extra = null }) {
  const names = rest.map((_, i) => `rest.${i}`), out = new Map();
  out.set('hot', await sealPart({ secret, name, part: 'hot', cursor, rows: hot, parts: names }));
  for (let i = 0; i < rest.length; i++) out.set(names[i], await sealPart({ secret, name, part: names[i], cursor, rows: rest[i], extra: i === rest.length - 1 ? extra : null }));
  return out;
}

/** A cold device's start (rows.js seed/seedDone): fetch the hot part, fold it (the app paints from it), then fold the rest parts in
 *  the background and mark the device as covering the checkpoint's cursor. `fetchPart(part, cursor)` -> bytes | null (null for
 *  the hot part: no checkpoint yet, sync the whole log as before). Returns null, or { cursor, hot, rest } where `rest` settles
 *  when the device is complete (it rejects on a part of another cursor or a failed fetch; the device stays seeding and the
 *  next start fetches again). Not used once the device has completed a pull (rows.status().cursor). */
export async function coldStart({ rows, secret, name, fetchPart, concurrency = 3 }) {
  if (rows.status().cursor != null) return null;
  const hb = await fetchPart('hot', null);
  if (!hb) return null;
  const hot = await openPart({ secret, name, bytes: hb });
  await rows.seed(hot.rows, { cursor: hot.cursor });
  const rest = (async () => {
    const queue = [...hot.parts];
    const worker = async () => {
      for (let p; (p = queue.shift());) {
        const b = await fetchPart(p, hot.cursor);
        if (!b) throw new Error(`checkpoint: part ${p} at ${hot.cursor} is gone`);
        const o = await openPart({ secret, name, bytes: b });
        if (o.cursor !== hot.cursor || o.part !== p) throw new Error(`checkpoint: asked ${p}@${hot.cursor}, got ${o.part}@${o.cursor}`);
        await rows.seed(o.rows, { cursor: hot.cursor });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return rows.seedDone(hot.cursor);
  })();
  return { cursor: hot.cursor, hot: hot.rows.length, rest };
}

/** Cursors are the data plane's integer ingest_seq as strings; the later of two (null-safe). */
export const laterCursor = (a, b) => (a == null ? b ?? null : b == null ? a : (/^\d+$/.test(a) && /^\d+$/.test(b) ? (BigInt(a) >= BigInt(b) ? a : b) : b));
