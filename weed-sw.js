// The site's isolation service worker, for GitHub Pages (https://brotochola.github.io/Web-Engine-for-Enhanced-Dynamics/):
// at the repo root it covers the landing page (index.html) and the demos (demos/). dist/weed-sw.js adds the headers.
//
// Pages serves this repo one folder below the site root, and the demos ask for '/demos/…', '/src/…' from the root.
// Those requests are answered from the repo's folder, under their own URL, so a module's relative imports resolve
// to the same '/demos/…' URLs again (one module per file, whichever way it was imported).
const BASE = new URL('./', self.location).pathname; // '/Web-Engine-for-Enhanced-Dynamics/' on Pages
const REPO_PATH = /^\/(?:demos|src|tests|dist|wasm)\//;

if (BASE !== '/') {
  self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.mode === 'navigate') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || url.pathname.startsWith(BASE) || !REPO_PATH.test(url.pathname)) return;
    event.stopImmediatePropagation(); // dist/weed-sw.js's listener must not answer it too
    event.respondWith(
      fetch(BASE + url.pathname.slice(1) + url.search).then(
        (response) =>
          new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          }),
      ),
    );
  });
}

importScripts('dist/weed-sw.js');
