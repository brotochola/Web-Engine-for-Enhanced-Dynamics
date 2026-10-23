/**
 * The engine cannot start without SharedArrayBuffer, and browsers only expose it
 * on a cross-origin isolated page. Most people meet this on their first deploy,
 * so the error names the two headers and where the per-host setup lives.
 */
export const SHARED_ARRAY_BUFFER_MISSING =
  'WeedJS needs SharedArrayBuffer, which browsers only enable on a cross-origin isolated page. ' +
  'Serve the HTML page with "Cross-Origin-Opener-Policy: same-origin" and ' +
  '"Cross-Origin-Embedder-Policy: require-corp". Per-host setup (Vercel, Netlify, GitHub Pages, itch.io): ' +
  'docs/guide/DEPLOY.md.';

/**
 * sessionStorage key: "time:count", when ensureCrossOriginIsolation last reloaded the page (ms since
 * the epoch) and how many reloads it made inside the window.
 */
export const ISOLATION_RELOAD_KEY = 'weed.isolationReload';
/** Reloads that leave the page uncontrolled are tried at most MAX_RELOADS times inside this window. */
const RELOAD_WINDOW_MS = 10000;
/**
 * Two, not one: the isolated page's COOP moves it into a new browsing context group with its own
 * copy of sessionStorage, so clearing the marker there does not reach the copy a later page
 * without COOP sees (a hard reload bypasses the worker). That page finds the first visit's marker;
 * one more reload is right then. A real loop (DevTools' "Bypass for network") stops at the second.
 */
const MAX_RELOADS = 2;
/** How long the service worker gets to install and activate. */
const ACTIVATE_TIMEOUT_MS = 10000;

/**
 * Why the page cannot be isolated, said first in the error. The cases a player can meet on a
 * correct deploy are worded for the player; the rest for the game's developer.
 */
export const ISOLATION_REASONS = Object.freeze({
  insecure:
    'This page is served over plain HTTP. Browsers allow what WeedJS needs only over HTTPS (or on localhost).',
  noServiceWorker:
    'This browser window does not let the game start: private windows in Firefox and the browsers built into ' +
    'apps block what it needs. Open the game in a normal browser window.',
  embedded:
    'This game is embedded in a page that does not let it run. Open it in its own tab.',
  notApplied:
    'weed-sw.js controls this page, but the browser did not apply the headers it added.',
  reloadLoop:
    'The page reloaded twice to start weed-sw.js and is still not controlled by it. DevTools\' ' +
    '"Bypass for network" (Application, Service workers) does this.',
  timeout: 'weed-sw.js did not activate within 10 s.',
  redundant: 'weed-sw.js failed to install.',
  storage:
    'This browser blocks the site storage the game uses to restart once while it sets itself up. ' +
    'Allow site data for this page, or open it in a normal browser window.',
});

/** @param {string} script */
const otherWorkerReason = (script) =>
  `Another service worker (${script}) controls this page, and WeedJS does not replace it. ` +
  'Add the two headers to that worker\'s responses, or have the host send them.';
/** @param {string} swUrl @param {string} pageUrl */
const folderReason = (swUrl, pageUrl) =>
  `weed-sw.js must sit in the page's folder or above it: ${swUrl} does not cover ${pageUrl}. ` +
  'Put it next to index.html.';
/** @param {string} swUrl */
const crossOriginReason = (swUrl) => `weed-sw.js must be on the page's own site, not ${swUrl}.`;
/** @param {unknown} err */
const registerReason = (err) =>
  `weed-sw.js could not be installed (${(err && err.message) || err}). Put the weed-sw.js that ships with ` +
  'WeedJS next to index.html, served as JavaScript.';

let isolationFailure = null;

/** Why the last ensureCrossOriginIsolation() failed, or null. */
export function isolationFailureReason() {
  return isolationFailure;
}

/**
 * @param {object} [scope] - globalThis, or a stand-in in tests
 * @returns {string|null} the message when SharedArrayBuffer is missing, else null. It starts
 *   with the reason ensureCrossOriginIsolation() found, when it found one.
 */
export function sharedArrayBufferMissing(scope = globalThis) {
  if (typeof scope.SharedArrayBuffer !== 'undefined') return null;
  return isolationFailure ? `${isolationFailure} ${SHARED_ARRAY_BUFFER_MISSING}` : SHARED_ARRAY_BUFFER_MISSING;
}

/** { t, n } from the marker, or null. */
function readMarker(scope) {
  try {
    const raw = scope.sessionStorage.getItem(ISOLATION_RELOAD_KEY);
    if (raw === null) return null;
    const [t, n] = raw.split(':').map(Number);
    return Number.isFinite(t) && n >= 1 ? { t, n } : null;
  } catch {
    return null;
  }
}

function writeMarker(scope, now, count) {
  const value = `${now}:${count}`;
  try {
    scope.sessionStorage.setItem(ISOLATION_RELOAD_KEY, value);
    return scope.sessionStorage.getItem(ISOLATION_RELOAD_KEY) === value;
  } catch {
    return false;
  }
}

function clearMarker(scope) {
  try {
    if (scope.sessionStorage && scope.sessionStorage.getItem(ISOLATION_RELOAD_KEY) !== null) {
      scope.sessionStorage.removeItem(ISOLATION_RELOAD_KEY);
    }
  } catch {
    // Storage blocked: there is no marker to clear.
  }
}

/**
 * Resolves once the page has loaded. Chromium keeps a reload issued while a hard reload is still
 * loading out of the service worker's reach (the next page is uncontrolled again); issued after
 * `load` it is controlled. Found by the isolation smoke test (DX-SW, SW-4).
 */
function whenLoaded(scope) {
  const doc = scope.document;
  if (!doc || doc.readyState === 'complete' || typeof scope.addEventListener !== 'function') return Promise.resolve();
  return new Promise((resolve) => scope.addEventListener('load', () => resolve(), { once: true }));
}

/** 'activated', 'redundant' or 'timeout'. */
function whenActivated(registration, scope, timeoutMs) {
  const worker = registration.installing || registration.waiting || registration.active;
  if (!worker) return Promise.resolve('redundant');
  if (worker.state === 'activated') return Promise.resolve('activated');
  return new Promise((resolve) => {
    let done = false;
    const finish = (state) => {
      if (done) return;
      done = true;
      worker.removeEventListener('statechange', onState);
      resolve(state);
    };
    const onState = () => {
      if (worker.state === 'activated') finish('activated');
      else if (worker.state === 'redundant') {
        // Replaced by a newer copy that is already active counts as installed.
        const active = registration.active;
        finish(active && active.state === 'activated' ? 'activated' : 'redundant');
      }
    };
    worker.addEventListener('statechange', onState);
    scope.setTimeout(() => finish('timeout'), timeoutMs);
  });
}

/**
 * DX-SW. Makes the page cross-origin isolated without the host's help: registers our service
 * worker (weed-sw.js, which adds COOP and COEP to page loads and worker scripts), waits until it
 * is active and reloads once. Nothing else should load while this is pending.
 *
 * @param {{ serviceWorker?: string|false, timeoutMs?: number, now?: number }} [options]
 *   serviceWorker: the worker's URL, resolved against the page (default 'weed-sw.js', next to it);
 *   false never registers one.
 * @param {object} [scope] - window, or a stand-in in tests
 * @returns {Promise<'isolated'|'reloading'|'failed'>} on 'failed', isolationFailureReason() and
 *   sharedArrayBufferMissing() say why (null and the plain message when the option is false).
 */
export async function ensureCrossOriginIsolation(options = {}, scope = globalThis) {
  isolationFailure = null;
  const fail = (reason) => {
    isolationFailure = reason;
    return 'failed';
  };
  try {
    if (typeof scope.SharedArrayBuffer !== 'undefined') {
      clearMarker(scope);
      return 'isolated';
    }
    const option = options.serviceWorker === undefined ? 'weed-sw.js' : options.serviceWorker;
    if (!option) return fail(null);
    if (scope.isSecureContext === false) return fail(ISOLATION_REASONS.insecure);
    const container = scope.navigator && scope.navigator.serviceWorker;
    if (!container) return fail(ISOLATION_REASONS.noServiceWorker);

    const pageUrl = scope.location.href;
    let swUrl;
    try {
      swUrl = new URL(option, scope.document.baseURI).href;
    } catch (err) {
      return fail(registerReason(err));
    }
    if (new URL(swUrl).origin !== new URL(pageUrl).origin) return fail(crossOriginReason(swUrl));
    // A service worker covers its own folder and below (and worker scripts by their own URL).
    if (!pageUrl.startsWith(swUrl.slice(0, swUrl.lastIndexOf('/') + 1))) return fail(folderReason(swUrl, pageUrl));

    const controller = container.controller;
    if (controller && controller.scriptURL === swUrl) {
      // Ours already answered this page load and it is still not isolated: a reload cannot help.
      return fail(scope.top !== scope.self ? ISOLATION_REASONS.embedded : ISOLATION_REASONS.notApplied);
    }
    if (controller) return fail(otherWorkerReason(controller.scriptURL));
    let registration = null;
    try {
      registration = (await container.getRegistration(pageUrl)) || null;
    } catch {
      registration = null;
    }
    const registered = registration && (registration.active || registration.waiting || registration.installing);
    if (registered && registered.scriptURL !== swUrl) return fail(otherWorkerReason(registered.scriptURL));

    const now = options.now ?? Date.now();
    const last = readMarker(scope);
    const recent = last !== null && now - last.t >= 0 && now - last.t < RELOAD_WINDOW_MS;
    if (recent && last.n >= MAX_RELOADS) return fail(ISOLATION_REASONS.reloadLoop);

    if (!registered) {
      try {
        registration = await container.register(swUrl);
      } catch (err) {
        return fail(registerReason(err));
      }
    }
    const state = await whenActivated(registration, scope, options.timeoutMs ?? ACTIVATE_TIMEOUT_MS);
    if (state !== 'activated') return fail(state === 'timeout' ? ISOLATION_REASONS.timeout : ISOLATION_REASONS.redundant);
    if (!writeMarker(scope, now, recent ? last.n + 1 : 1)) return fail(ISOLATION_REASONS.storage);
    await whenLoaded(scope);
    scope.location.reload();
    return 'reloading';
  } catch (err) {
    return fail(registerReason(err));
  }
}
