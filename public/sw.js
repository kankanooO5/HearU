const CACHE = 'tingjian-shell-v2';
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/','/manifest.webmanifest','/icon.svg']))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil((async () => { for (const key of await caches.keys()) if (key.startsWith('tingjian-shell-') && key !== CACHE) await caches.delete(key); await self.clients.claim(); })()); });
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    try { const response = await fetch(request); if (response.ok && !url.pathname.endsWith('.html')) { const cache = await caches.open(CACHE); cache.put(request, response.clone()).catch(() => {}); } return response; }
    catch { return (await caches.match(request)) || (request.mode === 'navigate' ? (await caches.match('/')) || Response.error() : Response.error()); }
  })());
});
