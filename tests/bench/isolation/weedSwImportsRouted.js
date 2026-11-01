// DX-SW: weedSwImports.js with Chrome's Static Routing API: page loads and worker scripts to the fetch handler, every
// mode 'cors' request (module imports, the page's and the workers') and the rest straight to the network, so the
// worker never wakes for them. Where addRoutes is missing or refuses a rule, the handler alone decides.
// isolationLoadTime.mjs serves it with --servers importsRouted.
self.addEventListener('install', (event) => {
  if (typeof event.addRoutes === 'function') {
    event.waitUntil(
      event
        .addRoutes([
          { condition: { requestMode: 'navigate' }, source: 'fetch-event' },
          { condition: { requestMode: 'cors' }, source: 'network' },
          { condition: { requestDestination: 'worker' }, source: 'fetch-event' },
          { condition: { requestDestination: 'sharedworker' }, source: 'fetch-event' },
          { condition: { urlPattern: new URLPattern({}) }, source: 'network' },
        ])
        .catch(() => {})
    );
  }
  self.skipWaiting();
});
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
