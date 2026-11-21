// A Storage-like object over ONE JSON file, for a Node daemon that hosts kit state (`createApp({ storage })`).
// The state core wants getItem/setItem/removeItem and nothing else (GUIDE section 0: "a Storage-like object"); a browser
// gives it localStorage, a daemon had nothing, so every daemon would hand-roll one. This is that one.
//   const app = createApp({ storage: fileStorage('/var/lib/x/store.json'), device: 'x', engine: false })
// Single writer by design (PANGEA3-DESIGN A9): one process owns the file. Every write is temp + fsync + rename + dir fsync,
// so a crash leaves the old file or the new file, never half of one. A file that does not parse is moved aside as
// `<file>.corrupt-<ms>` and never overwritten (A2 / persist.js "abort on unloadable"): the store starts empty and
// `recovered` names the copy, so nothing is lost and the caller can say so.
import fs from 'node:fs';
import path from 'node:path';

export function fileStorage(file, { now = Date.now } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let data = Object.create(null);
  let recovered = null;
  let lastError = null;
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    try {
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') data[k] = v;
    } catch {
      recovered = `${file}.corrupt-${now()}`;
      fs.renameSync(file, recovered);
    }
  }
  function persist() {
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      const dfd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
      lastError = null;
    } catch (e) {
      lastError = e;
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw e;
    }
  }
  return {
    getItem: (k) => (Object.hasOwn(data, k) ? data[k] : null),
    setItem(k, v) { const prev = data[k]; data[k] = String(v); try { persist(); } catch (e) { if (prev === undefined) delete data[k]; else data[k] = prev; throw e; } },
    removeItem(k) { if (!Object.hasOwn(data, k)) return; const prev = data[k]; delete data[k]; try { persist(); } catch (e) { data[k] = prev; throw e; } },
    key: (i) => Object.keys(data)[i] ?? null,
    get length() { return Object.keys(data).length; },
    clear() { data = Object.create(null); persist(); },
    get recovered() { return recovered; },
    get lastError() { return lastError; },
    get file() { return file; },
  };
}
