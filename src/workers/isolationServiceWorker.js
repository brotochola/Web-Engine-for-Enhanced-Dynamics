// weed-sw.js: adds the two headers SharedArrayBuffer needs, for hosts that cannot send them
// (GitHub Pages, a plain static host). WeedJS registers it next to the game's page and reloads
// once on the first visit. Not an engine worker: published on its own as dist/weed-sw.js, and its
// bytes carry no version, since any change makes every visitor's browser reinstall it. DX-SW.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const request = event.request;
  // DevTools sends these; fetch() rejects them outside same-origin mode.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  // Isolation is decided by the page and by each worker's own script; the rest goes to the network untouched. The
  // modules a worker imports have its destination too, but mode 'cors' where its own script has 'same-origin':
  // rewriting them made a boot from source, hundreds of imports, a third slower than real headers.
  const workerScript =
    (request.destination === 'worker' || request.destination === 'sharedworker') && request.mode !== 'cors';
  if (request.mode !== 'navigate' && !workerScript) return;
  event.respondWith(fetch(request).then((response) => {
    if (response.status === 0) return response; // opaque or redirect: the browser handles it
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin'); // lets an isolated portal embed the page
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }));
});
