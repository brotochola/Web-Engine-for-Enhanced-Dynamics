import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ISOLATION_REASONS,
  ISOLATION_RELOAD_KEY,
  SHARED_ARRAY_BUFFER_MISSING,
  ensureCrossOriginIsolation,
  isolationFailureReason,
  sharedArrayBufferMissing,
} from '../../src/util/crossOriginIsolation.js';

// The old error said "Check CORS headers"; the fix is two other headers.

test('a page without SharedArrayBuffer gets the two isolation headers and the deploy guide', () => {
  const message = sharedArrayBufferMissing({});
  assert.match(message, /Cross-Origin-Opener-Policy: same-origin/);
  assert.match(message, /Cross-Origin-Embedder-Policy: require-corp/);
  assert.match(message, /docs\/guide\/DEPLOY\.md/);
  assert.doesNotMatch(message, /CORS/);
});

test('an isolated page passes', () => {
  assert.equal(sharedArrayBufferMissing({ SharedArrayBuffer }), null);
  assert.equal(sharedArrayBufferMissing(), null);
});

// DX-SW, SW-3. ensureCrossOriginIsolation(), one test per row of the plan's table
// (docs/internal/ISOLATION_SERVICE_WORKER_PLAN.md, "The gate"), on stand-in pages.

const PAGE = 'https://game.test/play/index.html';
const SW = 'https://game.test/play/weed-sw.js';

/** A service worker as the page sees it; setState fires statechange. */
function fakeWorker(scriptURL, state) {
  const listeners = new Set();
  return {
    scriptURL,
    state,
    addEventListener: (type, fn) => type === 'statechange' && listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
    setState(s) {
      this.state = s;
      for (const fn of [...listeners]) fn();
    },
  };
}

function fakeStorage({ throws = false } = {}) {
  const map = new Map();
  const guard = () => {
    if (throws) throw new Error('SecurityError: storage is blocked');
  };
  return {
    map,
    getItem: (k) => (guard(), map.has(k) ? map.get(k) : null),
    setItem: (k, v) => (guard(), map.set(k, String(v))),
    removeItem: (k) => (guard(), map.delete(k)),
  };
}

/** A page that is not isolated, and the calls the gate makes on it. */
function fakePage(opts = {}) {
  const calls = { register: [], getRegistration: [], reload: 0 };
  const timers = [];
  const scope = {
    isSecureContext: opts.secure ?? true,
    location: { href: opts.href ?? PAGE, reload: () => calls.reload++ },
    document: { baseURI: opts.baseURI ?? opts.href ?? PAGE },
    sessionStorage: opts.storage ?? fakeStorage(),
    setTimeout: (fn) => timers.push(fn),
    navigator: opts.noServiceWorker
      ? {}
      : {
        serviceWorker: {
          controller: opts.controller ?? null,
          getRegistration: async (url) => {
            calls.getRegistration.push(url);
            return opts.registration ?? undefined;
          },
          register: async (url) => {
            calls.register.push(url);
            if (opts.registerError) throw opts.registerError;
            return opts.registered;
          },
        },
      },
  };
  scope.self = scope;
  scope.top = opts.framed ? {} : scope;
  return { scope, calls, timers };
}

test('real headers: isolated, the reload marker cleared, nothing registered', async () => {
  const storage = fakeStorage();
  storage.setItem(ISOLATION_RELOAD_KEY, '123');
  const { scope, calls } = fakePage({ storage });
  scope.SharedArrayBuffer = SharedArrayBuffer;
  assert.equal(await ensureCrossOriginIsolation({}, scope), 'isolated');
  assert.equal(storage.map.has(ISOLATION_RELOAD_KEY), false);
  assert.deepEqual(calls, { register: [], getRegistration: [], reload: 0 });
  assert.equal(isolationFailureReason(), null);
});

test('the option off: failed with the plain message about headers', async () => {
  const { scope, calls } = fakePage();
  assert.equal(await ensureCrossOriginIsolation({ serviceWorker: false }, scope), 'failed');
  assert.equal(isolationFailureReason(), null);
  assert.equal(sharedArrayBufferMissing(scope), SHARED_ARRAY_BUFFER_MISSING);
  assert.equal(calls.register.length, 0);
});

test('plain HTTP and no service workers fail with their reason first in the message', async () => {
  const http = fakePage({ secure: false });
  assert.equal(await ensureCrossOriginIsolation({}, http.scope), 'failed');
  assert.equal(isolationFailureReason(), ISOLATION_REASONS.insecure);
  assert.equal(sharedArrayBufferMissing(http.scope), `${ISOLATION_REASONS.insecure} ${SHARED_ARRAY_BUFFER_MISSING}`);

  const noSw = fakePage({ noServiceWorker: true });
  assert.equal(await ensureCrossOriginIsolation({}, noSw.scope), 'failed');
  assert.equal(isolationFailureReason(), ISOLATION_REASONS.noServiceWorker);
});

test('another service worker is never replaced, controlling the page or only registered', async () => {
  const controlling = fakePage({ controller: { scriptURL: 'https://game.test/play/pwa.js' } });
  assert.equal(await ensureCrossOriginIsolation({}, controlling.scope), 'failed');
  assert.match(isolationFailureReason(), /pwa\.js.*does not replace it/);
  assert.equal(controlling.calls.register.length, 0);

  const registered = fakePage({ registration: { waiting: fakeWorker('https://game.test/sw-offline.js', 'installed') } });
  assert.equal(await ensureCrossOriginIsolation({}, registered.scope), 'failed');
  assert.match(isolationFailureReason(), /sw-offline\.js/);
  assert.equal(registered.calls.register.length, 0);
});

test('ours controls the page and it is still not isolated: no reload; embedded pages say so', async () => {
  const top = fakePage({ controller: { scriptURL: SW } });
  assert.equal(await ensureCrossOriginIsolation({}, top.scope), 'failed');
  assert.equal(isolationFailureReason(), ISOLATION_REASONS.notApplied);
  const framed = fakePage({ controller: { scriptURL: SW }, framed: true });
  assert.equal(await ensureCrossOriginIsolation({}, framed.scope), 'failed');
  assert.equal(isolationFailureReason(), ISOLATION_REASONS.embedded);
  assert.equal(top.calls.reload + framed.calls.reload, 0);
});

test('a reload of our own under 10 s ago that left the page uncontrolled is not tried again', async () => {
  const storage = fakeStorage();
  storage.setItem(ISOLATION_RELOAD_KEY, '50000');
  const active = fakeWorker(SW, 'activated');
  const recent = fakePage({ storage, registration: { active } });
  assert.equal(await ensureCrossOriginIsolation({ now: 55000 }, recent.scope), 'failed');
  assert.equal(isolationFailureReason(), ISOLATION_REASONS.reloadLoop);
  assert.equal(recent.calls.reload, 0);

  // Older than the window (a hard reload long after the first visit): reload again.
  const old = fakePage({ storage, registration: { active } });
  assert.equal(await ensureCrossOriginIsolation({ now: 70000 }, old.scope), 'reloading');
  assert.equal(old.calls.reload, 1);
  assert.equal(old.calls.register.length, 0, 'the active registration is reused');
  assert.equal(storage.getItem(ISOLATION_RELOAD_KEY), '70000');
});

test('the worker must cover the page and be on its site', async () => {
  const elsewhere = fakePage();
  assert.equal(await ensureCrossOriginIsolation({ serviceWorker: '/other/weed-sw.js' }, elsewhere.scope), 'failed');
  assert.match(isolationFailureReason(), /https:\/\/game\.test\/other\/weed-sw\.js does not cover https:\/\/game\.test\/play\/index\.html/);

  const crossSite = fakePage();
  assert.equal(await ensureCrossOriginIsolation({ serviceWorker: 'https://cdn.test/weed-sw.js' }, crossSite.scope), 'failed');
  assert.match(isolationFailureReason(), /own site/);

  // At the site root it covers every page below it.
  const rootWorker = fakeWorker('https://game.test/weed-sw.js', 'activated');
  const atRoot = fakePage({ registered: { active: rootWorker } });
  assert.equal(await ensureCrossOriginIsolation({ serviceWorker: '/weed-sw.js', now: 1 }, atRoot.scope), 'reloading');
  assert.deepEqual(atRoot.calls.register, ['https://game.test/weed-sw.js']);
});

test('first visit: register next to the page, wait for activated, mark, reload once', async () => {
  const installing = fakeWorker(SW, 'installing');
  const { scope, calls } = fakePage({ registered: { installing } });
  const result = ensureCrossOriginIsolation({ now: 1000 }, scope);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.register, [SW]);
  assert.equal(calls.reload, 0, 'not before the worker is active');
  installing.setState('installed');
  installing.setState('activating');
  assert.equal(calls.reload, 0);
  installing.setState('activated');
  assert.equal(await result, 'reloading');
  assert.equal(calls.reload, 1);
  assert.equal(scope.sessionStorage.getItem(ISOLATION_RELOAD_KEY), '1000');
});

test('a worker that fails to install, never activates, or cannot be fetched is named; no reload', async () => {
  const doomed = fakeWorker(SW, 'installing');
  const a = fakePage({ registered: { installing: doomed } });
  const pending = ensureCrossOriginIsolation({}, a.scope);
  await new Promise((r) => setImmediate(r));
  doomed.setState('redundant');
  assert.equal(await pending, 'failed');
  assert.equal(isolationFailureReason(), ISOLATION_REASONS.redundant);

  const slow = fakeWorker(SW, 'installing');
  const b = fakePage({ registered: { installing: slow } });
  const waiting = ensureCrossOriginIsolation({ timeoutMs: 10000 }, b.scope);
  await new Promise((r) => setImmediate(r));
  assert.equal(b.timers.length, 1);
  b.timers[0]();
  assert.equal(await waiting, 'failed');
  assert.equal(isolationFailureReason(), ISOLATION_REASONS.timeout);

  const c = fakePage({ registerError: new TypeError('Failed to register a ServiceWorker: A bad HTTP response code (404) was received') });
  assert.equal(await ensureCrossOriginIsolation({}, c.scope), 'failed');
  assert.match(isolationFailureReason(), /could not be installed \(Failed to register a ServiceWorker: A bad HTTP response code \(404\)/);
  assert.equal(a.calls.reload + b.calls.reload + c.calls.reload, 0);
});

test('storage that cannot keep the marker means no reload, and the player is told', async () => {
  const { scope, calls } = fakePage({ storage: fakeStorage({ throws: true }), registered: { active: fakeWorker(SW, 'activated') } });
  assert.equal(await ensureCrossOriginIsolation({}, scope), 'failed');
  assert.equal(isolationFailureReason(), ISOLATION_REASONS.storage);
  assert.equal(calls.reload, 0);
});
