# Isolation service worker plan (SharedArrayBuffer without COOP/COEP headers)

**Opened:** 2026-10-22 (planned in a chat session), saved here 2026-10-23. **Status:** in progress
on branch `isolation_sw` (from 2026-10-23); the four decisions are taken (see "Decisions").
**Next step:** the phase 2 rows not run yet (Firefox, hot reload, audio, the allowed frame). SW-1 to
SW-8 are done; phase 3 is measured (2026-10-28, below) and SW-9 is not needed. **Registry:** `DX-SW` in
[`hypotheses.json`](./hypotheses.json).

The goal: WeedJS runs exactly as it does today, with SharedArrayBuffers and Box2D's 4 threads,
on hosts that cannot send the two isolation headers (GitHub Pages, a plain static host,
`npx serve`), without the game's author having to set anything up. A small service worker of
our own adds the headers. The engine registers it, keeps the screen black, and reloads once on
the first visit. It applies coi-serviceworker's principles; it does not vendor that library.

**For the agent executing this plan:**
- Read `CLAUDE.md`, `docs/internal/HOW_WE_MEASURE.md` and this whole file before the first
  commit.
- Work on a branch in this folder (no worktrees).
- One item per commit; the node suite is green before each commit.
- Tick the item here (`[x]` plus the commit hash) in the same commit, add anything new under
  "Found during implementation", and update `DX-SW` in `hypotheses.json` (then run
  `node scripts/buildHypothesesPage.mjs`).
- Before any browser run, check that no other session is benchmarking.

---

## 1. How coi-serviceworker works (v0.1.7, about 100 lines, MIT)

The same file runs in two places.

**As the service worker:**
- `install` calls `skipWaiting()`, so a new version activates without waiting for old tabs to
  close.
- `activate` calls `clients.claim()`, so it takes over tabs that are already open.
- It accepts two messages from the page: `deregister` (unregister, then reload every tab) and
  `coepCredentialless` (set a mode variable).
- `fetch`: for every request in its folder, it fetches the response. Unless the response is
  opaque (status 0), it returns a copy with three headers added:
  - COEP (`require-corp` or `credentialless`);
  - COOP `same-origin`;
  - CORP `cross-origin` (in `require-corp` mode only).

  In credentialless mode it re-sends no-cors requests without cookies. It skips
  `only-if-cached` requests, which DevTools sends.

**On the page:**
- It reads a "reloaded by self" flag from sessionStorage and takes options from `window.coi`.
- If the page is controlled but not isolated, it switches the worker to `require-corp` and
  reloads once.
- If the page is already isolated, or this load came from its own reload, it stops there.
- Otherwise it registers its own URL (`document.currentScript.src`). It reloads on
  `updatefound`, or right away when a worker is active but not controlling the page (which is
  what happens after a hard reload).

Two consequences worth knowing:
- **Updating the file does not reload a running game.** A page that is already isolated returns
  before it registers, so it never listens for updates.
- **The browser treats headers added by a service worker exactly like server headers**, so once
  the page is controlled it is `crossOriginIsolated` and the engine behaves as with real headers.

## 2. What we change from coi

| # | coi-serviceworker | WeedJS version |
|---|---|---|
| 1 | Reloads on `updatefound`, when the worker *starts installing*. If the reloaded page arrives before the worker is active, it is not intercepted and comes back without isolation. Because of the "reloaded by self" flag it then stops, and stays broken until the player reloads by hand. | Reload only after the worker reports `activated`. |
| 2 | The COEP mode is a variable inside the worker, set by a message. The browser stops idle workers and re-runs the script, which resets it, so the mode varies between visits. Safari's fallback path adds reloads. | No state and no messages: always `require-corp`, which is what DEPLOY.md says. If a mode is ever needed, put it in the worker's URL; `self.location` survives a restart. |
| 3 | Rewrites every response in its folder, so every image, sound and WASM body streams through the worker. | Isolation is decided only by the page and by each worker's own script. Same-origin files need nothing under `require-corp`, CORS responses need nothing, and opaque responses cannot be fixed by a service worker anyway. So rewrite only page loads and worker scripts, and send everything else straight to the network. |
| 4 | Registers itself even when another service worker owns the folder. That **replaces** the game's own offline/PWA worker. | Check `getRegistration()` first. Never replace another worker; say in the error where to add the headers instead. |
| 5 | sessionStorage access is not guarded, so it throws where storage is blocked. The loop guard is a flag with no time limit, and failures only go to the console. | A timestamped marker inside try/catch: if it cannot be written, do not reload. Every failure becomes a specific message in WeedJS's existing error overlay. |
| 6 | Races the app: the game starts loading while the worker registers. | The gate is part of engine boot. Nothing loads until it has settled, so the screen stays black. |
| 7 | Needs its own classic `<script>` tag, first in `<head>`. | The engine registers the file by URL. No tag, and it works with module scripts and importmaps. |
| 8 | Logs to the console by default. | Silent unless something fails. |

What we keep: `skipWaiting` plus `claim`, leaving opaque responses untouched, the
`only-if-cached` guard, hard-reload detection, and doing nothing when real headers are already
present.

**Why not a blob URL inside the bundle:** browsers only register a service worker from a
same-origin http(s) URL, never from a blob. The bundle registering *itself* as the worker would
only work when the bundle sits in the page's folder (never from the CDN), and the browser would
parse 1–2 MB every time the worker starts. So the worker ships as its own small file.

## 3. Design

### The service worker file

Source in `src/workers/isolationServiceWorker.js`, published as `dist/weed-sw.js`. The bundle
build lists its engine workers by name (`WORKER_NAMES` in `scripts/buildBundle.js`), so a new
file in that folder is not picked up as an engine worker. The file must not carry the version
number: any change to its bytes makes every visitor's browser reinstall it.

```js
// weed-sw.js: adds the two headers SharedArrayBuffer needs, for hosts that can't send them.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return; // DevTools quirk
  // Isolation is decided by the page and by each worker's own script; the rest goes to the network untouched.
  if (request.mode !== 'navigate' && request.destination !== 'worker' && request.destination !== 'sharedworker') return;
  event.respondWith(fetch(request).then((response) => {
    if (response.status === 0) return response; // opaque or redirect: the browser handles it
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin'); // lets an isolated portal embed it
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }));
});
```

### The gate: `ensureCrossOriginIsolation()` in `src/util/crossOriginIsolation.js`

It returns `isolated`, `reloading` or `failed`. On `failed` it stores the reason, and
`sharedArrayBufferMissing()` adds that reason to its message.

| Situation when the page loads | Result |
|---|---|
| SharedArrayBuffer exists (real headers, or our worker already did its job) | `isolated`; clear the reload marker |
| Option set to `false` | `failed`, with today's message about headers |
| Not HTTPS (localhost is fine) | `failed`: "serve over HTTPS" |
| No `navigator.serviceWorker` | `failed`: "private window or in-app browser; open the game in a normal window" |
| Another service worker controls or owns this folder | `failed`: name that worker; never replace it |
| Our worker controls the page, but it is still not isolated | `failed`. Inside a frame: "the page embedding this game must be isolated". Otherwise: "the browser didn't apply the headers". A reload cannot fix either. |
| Our own reload happened less than 10 s ago and the page still is not controlled | `failed` (for example, DevTools "Bypass for network" is on) |
| The worker's folder does not contain the page | `failed`: "put weed-sw.js next to index.html" |
| Anything else | Register (or reuse the existing registration), wait for `activated` (10 s timeout), write the marker, `location.reload()`: `reloading` |

### `GameEngine`

- **Finding:** `src/core/gameEngine.js:39` runs `new Int32Array(new SharedArrayBuffer(4))`. On a
  page without isolation `SharedArrayBuffer` is not defined, so `new GameEngine()` throws a
  ReferenceError. The friendly message in `Scene.init` (`src/core/scene.js:1008`) is never
  reached, although DEPLOY.md says it is.
  - **Fix (SW-1):** fall back to a plain `ArrayBuffer` there. `Atomics.store` works on it, and
    the scene never starts without isolation anyway.
  - **Checked (2026-10-22):** with `SharedArrayBuffer` deleted, `src/index.js` imports fine in
    Node, and nothing else on the constructor path uses it.
- **The constructor starts the gate.** As its very first step, `loadScene` waits for it:
  - On `reloading`, it returns a promise that never settles: the page is about to reload, so
    nothing after `await loadScene()` should run.
  - On `failed`, it carries on, so `Scene.init` shows the overlay with the reason.
- **New option** `isolationServiceWorker`, default `'weed-sw.js'`, resolved against
  `document.baseURI`; `false` turns it off. Add it to `GameEngineConfig` in `types/weed.d.ts`.
  (Default on or opt-in is decision 1.)

### Black screen and first-visit cost

While the gate waits, nothing is fetched and nothing is drawn. The template page is already
`background: #000` and the canvas stays empty.

On the first visit the engine bundle downloads once (the reload gets it from cache) but is
parsed twice. The scene and its assets load only after the reload. If phase 3 shows the double
parse matters, a small inline gate in the template HTML can skip it.

**Measured (phase 3, 2026-10-28):** with the bundle the first visit reaches its first frame about
125 ms later than real headers (698 against 572 ms, the reload at 179 ms), once. Not worth an
inline gate.

### Hot reload during development

It keeps working as today, because during development the worker never gets involved (worked
out by reading the code, not run yet):
- Hot reload opens a Server-Sent Events stream on `/__weed/reload`
  (`src/core/debug/hotReload.js:20`). A changed scene script is swapped in place; any other
  change saves the scene, reloads the page and restores the save.
- Only `npm run dev` serves that stream, and both dev servers send COOP/COEP on every response,
  the stream included (`server/node_server.js:99`,
  `packages/create-weed-game/template/scripts/dev.mjs:14`).
- So the page is already isolated, and the gate's first check returns at once: no
  registration, no request intercepted.
- The state-preserving reload goes straight into an isolated page. Its sessionStorage key
  (`weed.hotReload`) does not collide with the gate's marker, and the gate never reloads an
  isolated page.

**A leftover worker:** a production build tested without headers on the same `localhost` port
leaves `weed-sw.js` registered in front of later `npm run dev` pages. With the narrow design
that is harmless: page loads and worker scripts get the headers the dev server already sends,
the stream, re-imported scripts and assets go straight to the network, and the worker caches
nothing, so code is never stale. (coi's rewrite-everything approach would route the stream and
every reloaded script through the worker: one more reason for the narrow design.) To remove
it: DevTools → Application → Service workers → Unregister.

**Setups where hot reload never worked anyway:**
- A server without the headers (VS Code Live Server, `npx serve`, Vite without config): there
  is no `/__weed/reload`. With the gate the author gets "copy `weed-sw.js` next to index.html,
  or use `npm run dev`" instead of today's ReferenceError.
- A phone over the LAN (`http://192.168…`): browsers ignore COOP/COEP on plain HTTP and do not
  allow service workers there, so it fails with or without the worker; the gate at least says
  "needs HTTPS". Chrome's USB port forwarding (`chrome://inspect`) makes the phone open
  `localhost:port`, which counts as secure, and then everything works.

### Build, package, template, docs

- **`scripts/buildBundle.js`** (check its line endings with `git ls-files --eol`): write
  `dist/weed-sw.js` and add it to `KEEP_DIST_FILES`, or `cleanupDistTemps()` deletes it.
- **`package.json`:** `files` is `dist/*.min.js`, so add `dist/weed-sw.js`, plus an
  `exports["./weed-sw.js"]` entry. Its own commit (the pre-commit hook stages `package.json`).
- **Template `build.mjs`:** copy `weed-sw.js` next to `dist/index.html` when the installed
  engine has it (older engines do not). Keep `_headers`. Extend `createWeedGame.test.js`.
- **`docs/guide/DEPLOY.md`:** replace the coi-serviceworker paragraph. Explain the folder rule
  and list the limits: HTTPS, Firefox private windows, iOS in-app browsers, frames on other
  sites, other service workers. Fix the claim about the error message.
- **Folder rule:** the worker must cover the page *and* every worker script loaded by URL. A
  worker loaded by URL is handled by whichever service worker covers *its* URL, not the page's.
  The bundle's workers are blob URLs, which inherit the page's isolation, so they are fine. The
  src-mode workers in `/src/workers/` need `weed-sw.js` at the site root.

## 4. Test plan

**Phase 0, prerequisites:**
- Give `createStaticBenchmarkServer` (`tests/helpers/createStaticBenchmarkServer.mjs`) an option
  to omit COOP, COEP and CORP; it always sends them today. A second instance on another port
  gives a second origin.
- Install Playwright's Firefox.

**Phase 1, Node unit tests (no browser):**
- **The service worker:** load the real file into a `vm` context with a fake `self` and a
  stubbed `fetch`. Dispatch fake fetch events and check:
  - page loads and worker scripts get the headers, with status and body unchanged;
  - images, scripts and WASM get no `respondWith` call;
  - opaque responses pass through untouched;
  - `only-if-cached` requests are skipped;
  - `install` calls `skipWaiting` and `activate` calls `claim`;
  - re-running the script (a simulated restart) behaves the same.
- **The gate:** stand-in objects, as `tests/node/crossOriginIsolation.test.js` already does.
  Cover every row of the table, the marker expiring, storage throwing, the timeout (fake
  timers), the worker's folder not covering the page, and another worker never being replaced
  (`register` is never called).

**Phase 2, browser end-to-end** (`tests/bench/isolationWorkerSmoke.mjs`, Chromium and Firefox):
a server without isolation headers, with the worker at the root (src mode) or next to
`dist/index.html` (bundles). The bundle cases need `dist/` rebuilt.

**The bundles, 2026-10-28** (`tests/bench/isolationBundleSmoke.mjs`, 48c26573; Chrome 156, headed): all
eight bundles built from the working tree at 417b5f0a (`check:dist` matching), each through `dist/weed-sw.js`
on a server without the headers (first visit 2 loads, return visit 1, hard reload 2) and on one with them
(1 load, nothing registered): **32/32**. Every case isolated, BallsScene running (204 entities, Box2D on four
threads and the renderer past 10 frames each), drawn, no page error, no overlay. Load time on that build
(`isolationLoadTime --mode bundle`, 5 runs): first visit 552 → 670 ms, return visit 430 → 430 ms.

| Case | Expected |
|---|---|
| First visit | 2 loads; isolated; the scene runs; no Box2D thread errors; the overlay never appears (checked by a `MutationObserver` added with `addInitScript`); black until the first frame (screenshots) |
| Return visit | 1 load |
| Hard reload (Chromium, `Page.reload({ignoreCache: true})`) | 2 loads |
| Worker stopped (`ServiceWorker.stopAllWorkers`), then navigate | Still isolated |
| Worker file returns 404, has the wrong MIME type, or has a syntax error | 1 load; the reason is shown |
| `navigator.serviceWorker` removed | 1 load; the reason is shown |
| Plain HTTP (Chromium `--host-resolver-rules`, then `http://game.test`) | The reason is shown |
| Another worker already registered for the folder | Not replaced; the reason is shown |
| In a frame on the second origin, without isolation | The "embedded" reason; at most 2 loads |
| In a frame inside an isolated parent with `allow="cross-origin-isolated"` | Works |
| Worker placed in `/demos/` with src mode | Workers fail, which confirms the folder rule |
| Real headers present | No registration created |
| Audio | The AudioWorklet attaches its SharedArrayBuffer |
| `npm run dev`, edit a scene script | Swapped in place; `navigator.serviceWorker.getRegistrations()` is empty |
| `npm run dev`, edit an asset | The page reloads with the scene's state kept |
| Both of the above with a leftover `weed-sw.js` on the same port | Both still work; the `/__weed/reload` stream never reaches the worker |

**Phase 3, performance:**
- **Runtime:** Predator ABAB, real headers against the worker (return visit). Expect no
  difference, since the worker only touches loading.
- **Load time:** median time to first frame over 10 runs each, for real headers, a return
  visit and a first visit. Also compare rewriting everything against rewriting only page loads
  and worker scripts. Keep the narrow version only if it is not slower and passes phase 2.

**Phase 3 done (2026-10-28, Chrome 156, GTX 1650, headed).** `tests/bench/isolationLoadTime.mjs`
(1ade2dea, e8f4ba74): the time from the navigation to the renderer's first published frame, 10
runs a row in rotating order, a fresh context a run, after one unrecorded warm-up visit (the
session's first paid 4.7 s for the GPU process). Medians (p25–p75), ms:

| Page | Visit | Real headers | weed-sw.js (narrow) | Every response (wide) | Static Routing |
| --- | --- | --- | --- | --- | --- |
| bundle (`dist/index.html`, 300 balls) | first | 572 (552–580) | 698 (681–707), reload at 179 | 713 (704–721) | 690 (677–699) |
| bundle | return | 429 (413–441) | 443 (432–447) | 446 (433–458) | 442 (429–465) |
| source (`isolationSmoke.html`) | first | 1 151 (1 142–1 211) | 1 664 (1 651–1 686) | 1 877 (1 857–2 029) | 1 708 (1 644–1 807) |
| source | return | 1 063 (1 047–1 101) | 1 431 (1 429–1 456) | 1 680 (1 649–1 720) | 1 432 (1 414–1 549) |

The Static Routing column is a second sitting (headers 552 / 442 / 1 181 / 1 118, narrow
680 / 431 / 1 673 / 1 446 in it).
- **A deploy (the bundle):** the first visit costs about 125 ms once; a return visit is within
  the noise of real headers (443 against 429 ms, and 431 against 442 in the second sitting).
- **Narrow against wide:** a tie with the bundle, and the wide worker 17 % slower on a return
  visit from source (1 680 against 1 431 ms), where every module request goes through it. Decision 2
  stands.
- **Source through the worker** (`npm run dev:sw`): a return visit was 330 to 370 ms slower than
  real headers, and the Static Routing API did not help. **Found and fixed the same day (417b5f0a):**
  a module worker's imports carry the worker's destination (`worker`), so the filter for "worker
  scripts" rewrote all 728 imports of the engine's workers through `fetch` and a new `Response`; the
  Static Routing rules sent them to the fetch handler for the same reason. The imports are mode
  `cors`, a worker's own script `same-origin` (seen by a probe worker: 6 engine workers and 3 Box2D
  threads `same-origin` with a resulting client, 728 imports `cors` without). weed-sw.js now leaves
  `cors` requests alone. 10 runs, from source: return visit 1 415 → 1 114 ms (real headers 1 071),
  first visit 1 684 → 1 363 (1 159); the bundle unchanged. With routes on top it ties (screen: 1 107
  against 1 087), so the worker ships without them. The main thread's own 175 modules were never the
  cost: 140–153 ms to load the graph controlled or not, with or without a fetch handler.
- **Runtime:** Predator, 4 pairs, one build, real headers against the worker on a return visit
  (`weedIsolation=sw`, f5eb5417): logic +0.7 %, spatial 0.0 %, renderer −3.1 %, pre-render −3.2 %,
  physics −5.9 % (cv 8/12 %), presented 60 both. No difference, as expected: the worker only touches
  loading.

**Phase 4, manual:**
- Should work: Safari on macOS and iOS, Chrome on Android.
- Should show a clear reason: a Firefox private window, an iOS in-app browser.
- Real deploys: GitHub Pages with the template, and itch.io with and without its
  SharedArrayBuffer option.

## 5. Items (one commit each)

- [x] **SW-1** `fix(engine)`: `GameEngine` survives a page without SharedArrayBuffer, so the
  existing message becomes reachable. Done 2026-10-23 (`2da0511c`): the presenting flag falls back to a plain
  `ArrayBuffer`; `tests/node/engineWithoutIsolation.test.js` runs the real constructor and
  `Scene.init` on a fake page with SharedArrayBuffer deleted (the old code throws the ReferenceError).
- [x] **SW-2** `test(helpers)`: the static server can omit the isolation headers; second origin.
  Done 2026-10-23 (`36195d0a`): `createStaticBenchmarkServer(root, port, { isolationHeaders: false, files })`;
  `files` maps a URL to another file under the root (`/weed-sw.js` → the worker's source). A second
  instance on another port is the second origin. `tests/node/staticBenchmarkServer.test.js`.
- [x] **SW-3** `feat(engine)`: `weed-sw.js`, the gate and the `GameEngine` wiring, with the
  phase 1 Node tests. Done 2026-10-23: `src/workers/isolationServiceWorker.js`;
  `ensureCrossOriginIsolation()` in `src/util/crossOriginIsolation.js` (the table's rows, reasons in
  `ISOLATION_REASONS`, the marker `weed.isolationReload`; commit `d8a01c5b`); `GameEngine` starts it in the constructor
  and `loadScene` waits for it; option `isolationServiceWorker` (default `'weed-sw.js'`) in
  `ENGINE_DEFAULTS` and `types/weed.d.ts`. Tests: `isolationServiceWorker.test.js` (the worker in a
  `vm`, restarts included), `crossOriginIsolation.test.js` (every row), `engineWithoutIsolation.test.js`
  (the real constructor, `Scene.init` and `loadScene`).
- [x] **SW-4** `test(bench)`: the phase 2 end-to-end isolation smoke test. Done 2026-10-23
  (`ab8dc717`): `tests/bench/isolationWorkerSmoke.mjs`, Chromium, 11 cases, all passing twice in a
  row with the gate fix that followed (see "Found during implementation"): first visit (2 loads,
  isolated, the scene draws, no overlay), return visit (1), hard reload (2), stopped worker (1),
  real headers (no registration), a 404 worker, no service worker API, another worker owning the
  folder (not replaced), an embedding page on another origin (2 frame loads, the embedded
  reason), plain HTTP, and the folder rule (worker next to the page in src mode: the scene does
  not start). Not covered yet: Firefox (not installed), the hot-reload rows (need `npm run dev`),
  the AudioWorklet row, the frame inside an isolated parent with `allow="cross-origin-isolated"`,
  and black-until-first-frame screenshots.
- [x] **SW-5** `build`: the `dist/weed-sw.js` artifact. Done 2026-10-23: `writeIsolationServiceWorker()`
  in `scripts/buildBundle.js` copies the source byte for byte after the bundles, and the cleanup keeps
  it (`dbe9353d`). `dist/` is committed, so `dist/weed-sw.js` was written by that function alone (no bundle
  rebuild); `isolationServiceWorkerArtifact.test.js` fails when it goes stale.
- [x] **SW-6** `package.json`: `files` and `exports` for `weed-sw.js`, on its own. Done 2026-10-23
  (`e27a3f55`): `dist/weed-sw.js` in `files`, `"./weed-sw.js"` in `exports`; `npm pack --dry-run`
  lists it; `packageExports.test.js`.
- [x] **SW-7** `template`: copy `weed-sw.js`, with its test. Done 2026-10-23: `scripts/build.mjs` copies
  it next to `dist/index.html` when the installed engine has it, and keeps `_headers` (`93042637`);
  `createWeedGame.test.js` builds once without it (an older engine) and once with it.
- [x] **SW-8** `docs`: DEPLOY.md and the error text. Done 2026-10-23: DEPLOY.md's opening now offers
  `weed-sw.js` beside the headers, a "Without headers" section (where it goes for npm, the
  template and the CDN; the first visit; real headers make it inert; the folder rule; another
  service worker; the limits; the option; removal with a self-removing `weed-sw.js`, whose snippet
  `isolationServiceWorker.test.js` runs from the guide's text), GitHub Pages without
  coi-serviceworker; `SHARED_ARRAY_BUFFER_MISSING` names `weed-sw.js` first; the README, the CLI's
  README and the template's README say the same.
- [x] **SW-9** optional, only with phase 3 numbers: rewrite everything if the narrow worker
  loses, or send static assets past the worker with Chrome's Static Routing API. **Not needed
  (2026-10-28):** the narrow worker does not lose (a tie with the bundle, 17 % ahead of the wide one
  from source), and the Static Routing API ties it (phase 3 above).

## 6. Decisions (taken 2026-10-23)

1. **On by default.** The owner: game authors should not have to deal with the headers. The
   engine looks for `weed-sw.js` next to the page; the option is `isolationServiceWorker`
   (a URL, default `'weed-sw.js'`; `false` turns it off).
2. **Rewrite only page loads and worker scripts.** Phase 3 can still overturn it (SW-9).
3. **Error wording:** each reason says what happened and what fixes it. The cases a player can
   hit on a correct deploy (a private window, an in-app browser, a game embedded in a page that
   is not isolated) are worded for the player; the rest (HTTPS, the folder, another service
   worker, a missing file) for the developer.
4. **Removing it later:** DEPLOY.md documents a self-unregistering `weed-sw.js` to put in its
   place. `isolationServiceWorker: false` stops new registrations; it does not remove one a
   visitor already has, which the self-unregistering file does.

## Related

- Chrome 137+ supports `Document-Isolation-Policy`, a single page header that does not break
  popups or iframes the way COOP/COEP do. Chrome only.
- COEP `credentialless` works in Chrome and Firefox, not Safari.
- coi-serviceworker: <https://github.com/gzuidhof/coi-serviceworker>.

## Found during implementation

- Phase 0's "install Playwright's Firefox" waits for the owner: sessions here install nothing
  unasked. Chromium covers phase 2 until then.
- The gate's own checks run in this order: SharedArrayBuffer, the option, HTTPS, service worker
  support, the worker's site and folder, the controller (ours: no reload can help; another: never
  replaced), another registration for the page, the reload marker, then register. The folder test
  comes before the controller so a misplaced file is named even on a page another worker controls.
- **The isolated page has its own copy of sessionStorage** (SW-4, Chromium). COOP moves it into a
  new browsing context group, which gets a copy of the tab's sessionStorage taken at the switch.
  Writes there, including clearing the reload marker, never reach the copy a later page without
  COOP sees; a hard reload, which bypasses the worker and so has no COOP, sees the first visit's
  marker again. With a one-reload guard, a hard reload within 10 s of the first visit failed as
  a loop. The marker now counts reloads (`time:count`) and allows two in 10 s; a real loop
  (DevTools "Bypass for network") still stops at the second. The smoke test counts loads as
  navigation commits for the same reason (its first version kept a log in sessionStorage).
- **From source the default location is the site root** (2026-10-23, for `npm run dev:sw`). The engine
  loads its source-mode workers from the root-absolute `/src/workers/` and `/src/box2d/`, which a
  `weed-sw.js` next to a page in another folder (`/demos/index.html`) does not cover, so the demos
  started isolated but their workers did not. `defaultIsolationServiceWorker()`: `'weed-sw.js'` with
  a bundle (`WEED.BUNDLE_MODE`), `'/weed-sw.js'` otherwise; `ENGINE_DEFAULTS` no longer holds one.
- **`npm run dev:sw`**: `server/node_server.js --sw` serves without the isolation headers (pages and
  the hot-reload stream) and serves `/weed-sw.js` from the engine, on port 8090 by default so the
  registration never lands on the usual dev origin. The demo launcher runs through it, Predator
  included, and a hot reload keeps the page isolated with the scene restored.
- **The first visit hid nothing before its reload** (seen by the owner, 2026-10-23): the debug bar and
  the demo menu showed for about 1.2 s (75 frames in the smoke test) and vanished with the reload.
  `GameEngine` now puts a black veil over the page from its constructor whenever the gate will try
  the worker (`showIsolationVeil`, in the top layer as a popover, the highest z-index otherwise) and
  takes it off unless the page reloads, so a failure still shows its error. The smoke test hit-tests
  the page's UI every frame before the reload: covered on every frame now.
- **A reload issued while a hard reload is still loading comes back uncontrolled** (SW-4,
  Chromium); issued after `load` it is controlled. The gate now waits for the page's `load`
  event before reloading. The screen is black either way.
