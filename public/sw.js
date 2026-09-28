// Offline shell: network first (so updates arrive as soon as there is signal),
// falling back to the last cached copy. Pages give up on the network after 3 s,
// because gym signal is often "one bar, nothing loads" rather than fully offline.
// Only same-origin GETs are handled; sheet API calls go straight to the network.

const CACHE = 'shell-v1';

// Cache the page and every asset it references on install, so one online visit is enough.
self.addEventListener('install', (e) => e.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  const index = new URL('./', self.location.href).href;
  const res = await fetch(index, { cache: 'no-cache' });
  if (res.ok) {
    const html = await res.clone().text();
    await cache.put(index, res);
    const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => new URL(m[1], index).href)
      .filter((u) => u.startsWith(new URL('./', self.location.href).origin));
    await cache.addAll(assets);
  }
  await self.skipWaiting();
})()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(req).then((res) => {
      if (res.ok) void cache.put(req, res.clone());
      return res;
    });
    const timeout = req.mode === 'navigate'
      ? new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 3000))
      : new Promise(() => {});
    try {
      return await Promise.race([network, timeout]);
    } catch {
      const hit = (await cache.match(req, { ignoreSearch: true, ignoreVary: true }))
        ?? (req.mode === 'navigate' ? await cache.match(new URL('./', self.location.href).href, { ignoreVary: true }) : undefined);
      if (hit) return hit;
      return network;
    }
  })());
});
