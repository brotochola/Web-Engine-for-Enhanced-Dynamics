// DX-SW: weed-sw.js that leaves module imports alone. A module worker's imports have the worker's destination too
// ('worker'), so the shipped filter rewrote every one (728 requests on a boot from source); they are mode 'cors', a
// worker's own script is mode 'same-origin' (it alone decides the worker's isolation). isolationLoadTime.mjs serves it
// with --servers imports.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  const workerScript =
    (request.destination === 'worker' || request.destination === 'sharedworker') &&
    request.mode !== 'cors';
  if (request.mode !== 'navigate' && !workerScript) return;
  event.respondWith(
    fetch(request).then((response) => {
      if (response.status === 0) return response;
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    })
  );
});
