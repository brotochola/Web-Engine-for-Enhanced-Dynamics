// DX-SW phase 3, SW-9: weed-sw.js with Chrome's Static Routing API. At install it routes page loads and worker scripts
// to its fetch handler and every other request straight to the network, so a module, an image or a fetch() no longer
// starts the worker for an event it ignores. Where addRoutes does not exist (Firefox, Safari) or a rule is refused,
// the fetch handler alone decides, as in the shipped worker. isolationLoadTime.mjs serves it with --servers routed.
self.addEventListener('install', (event) => {
  self.weedRoutes = typeof event.addRoutes === 'function' ? 'pending' : 'no addRoutes';
  if (typeof event.addRoutes === 'function') {
    event.waitUntil(
      event
        .addRoutes([
          { condition: { requestMode: 'navigate' }, source: 'fetch-event' },
          { condition: { requestDestination: 'worker' }, source: 'fetch-event' },
          { condition: { requestDestination: 'sharedworker' }, source: 'fetch-event' },
          { condition: { urlPattern: new URLPattern({}) }, source: 'network' },
        ])
        // What happened, readable from the running worker (isolationLoadTime.mjs prints it).
        .then(() => {
          self.weedRoutes = 'ok';
        })
        .catch((err) => {
          self.weedRoutes = String((err && err.message) || err);
        })
    );
  }
  self.skipWaiting();
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  if (
    request.mode !== 'navigate' &&
    request.destination !== 'worker' &&
    request.destination !== 'sharedworker'
  )
    return;
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
