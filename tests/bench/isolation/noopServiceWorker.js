// A game's own service worker (offline cache, PWA) that knows nothing about isolation: the
// isolation smoke test checks that WeedJS never replaces one (DX-SW, SW-4).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
