// zai2's service worker before the kit owned it (its src/public/sw.js until 2026-11-09): cache first for navigations,
// refreshed in the background, no kit client on the page. Shared by the release takeover tests.
export const OLD_SW = `const CACHE = 'zai2-shell-v2';
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))));
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  const key = e.request.mode === 'navigate' ? '/' : e.request;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key);
    const net = (e.request.mode === 'navigate' ? fetch('/', { credentials: 'same-origin', redirect: 'manual', cache: 'no-store' }) : fetch(e.request)).then(async (r) => { if (r.ok && r.type === 'basic') await cache.put(key, r.clone()); return r; });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net;
  })());
});`
