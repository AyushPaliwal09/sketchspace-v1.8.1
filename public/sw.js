const CACHE_NAME = 'sketchspace-shell-v23-v1810-emoji-body-portal';
const APP_SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/assets/icon-catalog.js', '/assets/icon-catalog.json', '/assets/ui-icons.js', '/assets/eraser-cursor.svg', '/icons/sketchspace.svg', '/icons/sketchspace-192.png', '/icons/sketchspace-512.png'];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    // The icon catalog is small enough to precache as a group so the full library
    // stays available after installation even when the user opens the app offline.
    try {
      const catalogResponse = await cache.match('/assets/icon-catalog.json');
      if (catalogResponse) {
        const catalog = await catalogResponse.json();
        await cache.addAll(catalog.map(item => item.path));
      }
    } catch (error) {
      // Keep the app shell usable if an optional icon asset cannot be cached.
    }
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const unversionedKey = new Request(`${url.origin}${url.pathname}`);
  event.respondWith(caches.match(event.request).then(cached => cached || caches.match(unversionedKey)).then(cached => {
    if (cached) return cached;
    return fetch(event.request).then(response => {
      if (response.ok && (event.request.destination === 'script' || event.request.destination === 'style' || event.request.destination === 'image' || url.pathname === '/' || url.pathname.endsWith('.webmanifest') || url.pathname.endsWith('.svg'))) {
        const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => event.request.mode === 'navigate' ? caches.match('/index.html') : new Response('', { status: 503, statusText: 'Offline asset unavailable' }));
  }));
});
