# Deploying a WeedJS game

WeedJS shares memory between its workers through `SharedArrayBuffer`. Browsers only enable it on a page that is **cross-origin isolated**, which takes two response headers on the HTML page:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

If your host can send them, set them (see [Hosts](#hosts)). If it cannot, WeedJS can do it for you: put **`weed-sw.js`**, which ships with the engine, next to your `index.html` (see [Without headers](#without-headers-weed-swjs)). Games made with `create-weed-game` already do: `npm run build` copies it.

When the page is not isolated, the scene does not start and the page shows an error that says why (no HTTPS, a private window, a missing `weed-sw.js`, …). To check a deployed page, open DevTools and type `crossOriginIsolated` in the console: it must print `true`.

`npm run dev` already sends both headers, so the demos work locally.

## Without headers: `weed-sw.js`

`weed-sw.js` is a small service worker. It adds the two headers to your page and to the engine's worker scripts as the browser loads them, and leaves every other request alone. The browser treats them exactly like headers from the server.

- **Where:** next to your `index.html`, on your own site (a service worker cannot come from a CDN). With npm, copy `node_modules/@weed.js/engine/dist/weed-sw.js`; `create-weed-game`'s `npm run build` does it for you. With the CDN build, download `weed-sw.js` from the same version's `dist/` folder and upload it with your game.
- **First visit:** the engine registers it before anything else loads, waits until it is active, and reloads the page once; the screen stays black meanwhile. Later visits load once.
- **Headers already there:** if the page is isolated (your host sends the headers, or `npm run dev`), the engine does nothing: no service worker is registered.
- **Its folder:** a service worker covers the folder it sits in and everything below it. Next to `index.html` covers the game. Worker scripts loaded by URL count too: if you serve the engine's source (`src/`) rather than a bundle, its workers load from `/src/`, so the engine looks for `weed-sw.js` at your site's root instead.
- **Another service worker:** if your site already has one (an offline cache, a PWA) over the game's folder, the engine never replaces it and shows an error instead. Add the two headers to that worker's responses.
- **Where it cannot help:** plain HTTP (browsers allow it only over HTTPS, or on `localhost`); Firefox private windows and the browsers built into apps, which block service workers; and a game embedded in a page on another site that is not isolated itself (see [Game portals](#game-portals-and-other-iframes)). The error says which.
- **Your own page:** the rules in [What `require-corp` changes](#what-require-corp-changes-for-your-own-page) apply as with real headers.

By default the engine looks for `weed-sw.js` next to the page (at the site root when it runs from source). To use another URL, or none:

```js
new GameEngine({ isolationServiceWorker: '/weed-sw.js' }); // at the site root
new GameEngine({ isolationServiceWorker: false });          // never register one
```

**Removing it** once your host sends the headers: `isolationServiceWorker: false` stops new visitors from getting it, but players who already have it keep it. Replace your `weed-sw.js` with this file, which removes itself and reloads the open pages:

```js
// weed-sw.js that removes itself
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.registration.unregister()
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((pages) => Promise.all(pages.map((page) => page.navigate(page.url)))),
  );
});
```

## Hosts

### Vercel

`vercel.json` at the project root (this repository ships the same file):

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" },
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" }
      ]
    }
  ]
}
```

### Netlify and Cloudflare Pages

A file named `_headers` in the published folder:

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

### nginx

```nginx
location / {
  add_header Cross-Origin-Opener-Policy same-origin always;
  add_header Cross-Origin-Embedder-Policy require-corp always;
}
```

### Apache

`.htaccess` (needs `mod_headers`):

```apache
Header always set Cross-Origin-Opener-Policy "same-origin"
Header always set Cross-Origin-Embedder-Policy "require-corp"
```

### Vite (dev server and preview)

```js
// vite.config.js
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default {
  server: { headers: isolation },
  preview: { headers: isolation },
};
```

### GitHub Pages

GitHub Pages cannot set response headers: put `weed-sw.js` next to your `index.html` (see [Without headers](#without-headers-weed-swjs)). GitHub Pages serves over HTTPS, which it needs. You do not need coi-serviceworker: `weed-sw.js` does the same job, and the engine registers it for you.

### itch.io

Upload the game as an HTML project, then in the project's edit page, under **Embed options**, enable **SharedArrayBuffer support**. itch.io then serves the game's iframe with the isolation it needs.

### Game portals and other iframes

A game inside an iframe is only isolated when the page around it is isolated too and allows it on the frame (`<iframe allow="cross-origin-isolated">`). You do not control the portal's page, so ask the portal whether it supports `SharedArrayBuffer` games before you target it.

## What `require-corp` changes for your own page

With `Cross-Origin-Embedder-Policy: require-corp`, the browser refuses cross-origin resources that do not opt in. Files from your own origin are not affected. For anything loaded from another domain (a CDN image, a web font, an analytics or ad script):

- the server must send `Cross-Origin-Resource-Policy: cross-origin`, **or**
- the resource must be loaded with CORS (`crossorigin` attribute on `<img>` / `<script>` / `<link>`, and the server must send `Access-Control-Allow-Origin`).

Module scripts are always fetched with CORS, and jsDelivr allows any origin, so importing the engine from the CDN (see the README) works on an isolated page.

`Cross-Origin-Embedder-Policy: credentialless` is a looser alternative that loads cross-origin resources without cookies instead of refusing them. Check browser support before you rely on it; `require-corp` is the safe default.

## Builds

- Develop with the debug build (`@weed.js/engine/debug`, or `weed.bundle*.min.js` on the CDN): debug panel, `DebugDraw`, overlays.
- Ship the production build (`@weed.js/engine`, or `weed.prod.bundle*.min.js`): same gameplay API, no debug code.
- Pin an exact engine version on the CDN (`@weed.js/engine@<version>/…`).

## Checklist

1. `crossOriginIsolated` is `true` on the deployed page (with `weed-sw.js`, after the first visit's reload).
2. Every cross-origin asset loads (DevTools **Network** shows no `blocked:NotSameOriginAfterDefaultedToSameOriginByCoep`).
3. The production build is the one being served.
4. Audio starts after the first click or key press (browsers block sound until a user gesture).
