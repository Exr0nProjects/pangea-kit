// The real Stream transport: the kit's two-method sink ({ push(stream, rows), pull(stream, cursor) }) against the
// hosted Cloudflare Pangea L1 Worker (pangea-l1-deploy; contract/pangea-l1-streams.openapi.yaml). Runs in a browser or
// Node: only fetch and WebCrypto.
//
//   const t = createWorkerTransport({ base, token, secret })
//   app.use(decl, { transport: t })
//
// base    the Worker origin, from pangea.config.json `worker_base` (the deployment whose signing secret is in the
//         vault: worker.example.invalid, the replica-worker build; the replica.example.invalid
//         host's secret was rotated out of the local vault, so nothing can mint for it here).
// token   a Pangea token ("pnga1.<payload>.<sig>", sent as `Authorization: Pangea <token>`, scopes streams:read + streams:write), a string or an async
//         function; a 401 asks the function once more, so a short-lived token can be re-minted by whoever holds the
//         HMAC signing secret. The Worker derives the tenant namespace from the token, so the token IS the account.
//         The signing secret never reaches a client: a server mints the token (see GUIDE 4c).
// secret  the E2E key material (string or bytes) the client encrypts under. The Worker never sees it. One AES-256-GCM
//         key per stream is derived by HKDF-SHA256(secret, info = "qk-stream:" + stream name).
//
// Wire mapping (one kit row = one Worker entry):
//   stream id    `qk.` + the declared name with every character outside [A-Za-z0-9._-] written `_xx` (hex), or
//                `qk.h` + sha256 hex when that exceeds 128 characters. Injective, so two states never share a stream.
//   entry id     sha256("qk-entry:" + stream name + "\n" + device + ":" + seq) in hex: deterministic, so a retry is the
//                same PUT and the Worker answers it as an idempotent duplicate.
//   device_id    the kit device id, plaintext (routing metadata, contiguous per (stream, device) from 1).
//   event_time   the kit entry time, plaintext ISO (the Worker orders pages by it; it leaks timing, as the README says).
//   schema_id    null (the payload is opaque ciphertext; no plaintext schema is declared).
//   payload      the envelope { v: 1, alg: "A256GCM", iv, ct } (base64url); AAD binds stream name, device and seq, so a
//                ciphertext replayed under another position fails to open.
//   payload_sha256  sha256 of the canonical JSON of the envelope (sorted keys), checked again on read.
//
// Wire (this deployment): append is one PUT /v1/streams/{stream}/entries/{entryId} per entry, sent in order so the
// per-(stream, device) contiguity rule holds; an exact retry answers 200 duplicate. Pull is GET /entries?after=N, an
// integer ingest_seq cursor: a real delta, persisted in the replica record, so a poll costs only the new entries. A
// token may also carry `sources` (an allowlist of stream ids) and `device_id` (binds writes to one device): the
// issuer uses both to scope an app token down.
const enc = new TextEncoder(), dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64 = (str) => { const s = atob(str.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const sha256Hex = async (text) => hex(await subtle().digest('SHA-256', enc.encode(text)));

/** Canonical JSON per streams-v1.md: members sorted by code point, no whitespace. */
export const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('canonical: non-finite number');
  return JSON.stringify(v);
};

export const streamIdOf = async (name) => {
  const id = `qk.${String(name).replace(/[^A-Za-z0-9._-]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}`;
  return id.length <= 128 ? id : `qk.h${await sha256Hex(name)}`;
};
export const entryIdOf = (name, device, seq) => sha256Hex(`qk-entry:${name}\n${device}:${seq}`);

const aad = (name, device, seq) => enc.encode(`qk-aad:${name}\n${device}:${seq}`);

export function createWorkerTransport({ base, token, secret, fetch: fetchImpl = globalThis.fetch, onUndecryptable = () => {} }) {
  if (!base || !token || !secret) throw new Error('createWorkerTransport: base, token and secret are required');
  const root = String(base).replace(/\/+$/, '');
  const getToken = typeof token === 'function' ? token : async () => token;
  const keys = new Map();
  const stats = { requests: 0, undecryptable: 0 };
  let pageLimit = 200;

  const keyFor = (name) => {
    if (!keys.has(name)) keys.set(name, (async () => {
      const ikm = await subtle().importKey('raw', typeof secret === 'string' ? enc.encode(secret) : secret, 'HKDF', false, ['deriveKey', 'deriveBits']);
      const aes = await subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(`qk-stream:${name}`) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const ivk = await subtle().importKey('raw', await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(`qk-stream-iv:${name}`) }, ikm, 256), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return { aes, ivk };
    })());
    return keys.get(name);
  };

  // The IV is deterministic (SIV style): HMAC(ivk, aad || plaintext), truncated. A retry of the same entry therefore
  // reproduces the same ciphertext bytes, which is what makes the worker's exact-retry idempotence reachable from a
  // client that re-encrypts on retry; a different plaintext at the same position gets a different IV, so (key, IV)
  // never repeats across distinct messages.
  async function seal(name, row) {
    const { aes, ivk } = await keyFor(name);
    const ad = aad(name, row.device_id, row.device_seq);
    const pt = enc.encode(JSON.stringify(row.payload));
    const whole = new Uint8Array(ad.length + pt.length); whole.set(ad); whole.set(pt, ad.length);
    const iv = new Uint8Array(await subtle().sign('HMAC', ivk, whole)).slice(0, 12);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: ad }, aes, pt);
    return { v: 1, alg: 'A256GCM', iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  }
  async function open(name, device, seq, env) {
    if (env?.v !== 1 || env.alg !== 'A256GCM') throw new Error('unknown envelope');
    const { aes } = await keyFor(name);
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: aad(name, device, seq) }, aes, unb64(env.ct));
    return JSON.parse(dec.decode(pt));
  }

  async function call(method, path, body, retried = false) {
    stats.requests++;
    const res = await fetchImpl(`${root}${path}`, { method, headers: { authorization: `Pangea ${await getToken(retried)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    if (res.status === 401 && !retried && typeof token === 'function') return call(method, path, body, true);
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    if (!res.ok) throw Object.assign(new Error(`pangea ${method} ${path.split('?')[0]}: ${res.status} ${json.error || ''}`.trim()), { status: res.status, expected: json.expected_device_seq });
    return json;
  }

  return {
    stats,
    async push(name, rows) {
      const stream = await streamIdOf(name);
      for (const r of rows) { // in order: device_seq is contiguous per writer and the worker enforces it
        const payload = await seal(name, r);
        const entry = { device_id: r.device_id, device_seq: r.device_seq, event_time: r.event_time, schema_id: null, payload, payload_sha256: await sha256Hex(canonical(payload)) };
        await call('PUT', `/v1/streams/${encodeURIComponent(stream)}/entries/${await entryIdOf(name, r.device_id, r.device_seq)}`, entry);
      }
    },
    async pull(name, cursor) {
      const stream = await streamIdOf(name);
      const after = /^\d+$/.test(String(cursor ?? '')) ? String(cursor) : '0';
      // The page size is adaptive: a data plane answers a page of heavy entries (zai3's import batches carry hundreds of rows each)
      // with a 5xx when 200 of them are too much for one response (the cloud Worker 500 internal_error on limit=200, 200 on limit=50,
      // 2026-11-10). A 5xx on a page retries it with a quarter of the size, down to 1, and the transport keeps the size that
      // worked, so a cold reader (an app's first sync, an MCP isolate) converges instead of failing forever.
      let page
      for (;;) {
        try { page = await call('GET', `/v1/streams/${encodeURIComponent(stream)}/entries?after=${after}&limit=${pageLimit}`); break }
        catch (err) { if (!(err.status >= 500) || pageLimit <= 1) throw err; pageLimit = Math.max(1, Math.floor(pageLimit / 4)) }
      }
      const entries = [];
      for (const e of page.entries || []) {
        try {
          if (e.payload_sha256 !== await sha256Hex(canonical(e.payload))) throw new Error('payload hash mismatch');
          const payload = await open(name, e.device_id, e.device_seq, e.payload);
          entries.push({ entry_id: e.entry_id, device_id: e.device_id, device_seq: e.device_seq, event_time: e.event_time, payload });
        } catch (err) { stats.undecryptable++; onUndecryptable(e.entry_id, err); }
      }
      return { entries, cursor: String(page.next_cursor ?? after), more: Boolean(page.has_more) };
    },
  };
}

/** A token source for a client that cannot hold the signing secret: ask a server (same-origin, session-authenticated) for a fresh token. */
export const tokenFromEndpoint = (url, { fetch: f = globalThis.fetch } = {}) => async () => {
  const res = await f(url, { method: 'POST', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`token endpoint ${res.status}`);
  return (await res.json()).token;
};
