// The one-step cloud path (The owner 2026-11-08 00:08 PST: "can u make pangea properly set up so we can easily build
// with it?"): declare state, get persistence, offline queueing and multi-device sync through the hosted Pangea
// Worker, with no per-app transport code. Every endpoint and lifetime comes from pangea.config.json beside lib/
// (single source of truth; nothing here has a default URL or TTL).
//
//   import { cloudApp } from '.../pangea-kit/lib/cloud.js'
//   const app = cloudApp({ token, secret })           // token: a Pangea token, or omit in a browser signed in to
//   const card = app.use(declare({ ... scope:'cloud' }))  // issuer.example.invalid (the issuer is asked, then re-asked on 401)
//   app.autosync()                                    // sync now, on 'online', and every pollMs
//
// token    string, async () => string, or omitted: then the issuer endpoint from the config is used, which needs a
//          signed-in example.invalid session in the browser (POST {issuer_base}{token_path}, cookie auth). A node tool
//          passes a token minted the same way.
// secret   the app's E2E key. It never reaches any worker. How a second device gets it is the app's contract: for
//          a per-person app, derive or fetch it from somewhere only that person's devices reach; the kit does not
//          move keys.
import config from '../pangea.config.json' with { type: 'json' };
import { createApp } from './model.js';
import { createWorkerTransport, tokenFromEndpoint } from './stream-worker.js';

export const pangeaConfig = () => {
  for (const k of ['worker_base', 'issuer_base', 'token_path', 'token_ttl_seconds']) if (!config[k]) throw new Error(`pangea.config.json is missing ${k}`);
  return config;
};

export function cloudApp({ token = null, secret, storage, device, pollMs = 15000 } = {}) {
  const c = pangeaConfig();
  const tok = token ?? tokenFromEndpoint(`${c.issuer_base}${c.token_path}`);
  const transport = createWorkerTransport({ base: c.worker_base, token: tok, secret });
  const app = createApp({ ...(storage ? { storage } : {}), ...(device ? { device } : {}), transport });
  let timer = null;
  app.autosync = (ms = pollMs) => {
    const tick = () => app.sync().catch(() => {}); // offline is a retry, never a crash; pending stays on disk
    globalThis.addEventListener?.('online', tick);
    timer = setInterval(tick, ms);
    tick();
    return () => { clearInterval(timer); globalThis.removeEventListener?.('online', tick); };
  };
  return app;
}
