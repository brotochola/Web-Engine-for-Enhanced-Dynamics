# Deploying a WeedJS game

WeedJS shares memory between its workers through `SharedArrayBuffer`. Browsers only enable it on a page that is **cross-origin isolated**, which takes two response headers on the HTML page:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them the scene fails to load with `WeedJS needs SharedArrayBuffer…`. To check a deployed page, open DevTools and type `crossOriginIsolated` in the console: it must print `true`.

`npm run dev` already sends both headers, so the demos work locally. Anything you host yourself needs them too.

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

GitHub Pages cannot set response headers. The usual workaround is [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker): a service worker that adds the two headers to every response. Copy `coi-serviceworker.js` next to your `index.html` (it must be served from your own origin, not a CDN) and load it before anything else:

```html
<script src="coi-serviceworker.js"></script>
```

The first visit installs the service worker and reloads the page once. It needs HTTPS, which GitHub Pages provides.

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

1. `crossOriginIsolated` is `true` on the deployed page.
2. Every cross-origin asset loads (DevTools **Network** shows no `blocked:NotSameOriginAfterDefaultedToSameOriginByCoep`).
3. The production build is the one being served.
4. Audio starts after the first click or key press (browsers block sound until a user gesture).
