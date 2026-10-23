import test from 'node:test';
import assert from 'node:assert/strict';

import { GameEngine } from '../../src/core/gameEngine.js';
import { Scene } from '../../src/core/scene.js';
import { ISOLATION_REASONS, SHARED_ARRAY_BUFFER_MISSING } from '../../src/util/crossOriginIsolation.js';

// DX-SW, SW-1. On a page that is not cross-origin isolated the browser does not define
// SharedArrayBuffer. new GameEngine() made one for its presenting flag and threw a ReferenceError,
// so the message Scene.init shows for exactly this case (and DEPLOY.md promises) never appeared.

/** The page objects the constructor touches, and nothing more. documentElement keeps its children. */
function fakePage() {
  const element = () => ({ style: {}, parentNode: null, addEventListener() {}, removeEventListener() {} });
  const listeners = { addEventListener() {}, removeEventListener() {} };
  const documentElement = {
    children: [],
    appendChild(el) {
      el.parentNode = this;
      this.children.push(el);
      return el;
    },
    removeChild(el) {
      this.children = this.children.filter((c) => c !== el);
      el.parentNode = null;
      return el;
    },
  };
  return {
    window: { ...listeners, innerWidth: 640, innerHeight: 360 },
    document: {
      ...listeners,
      visibilityState: 'visible',
      fullscreenElement: null,
      createElement: element,
      documentElement,
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
  };
}

/**
 * Runs fn on a fake page whose global scope has no SharedArrayBuffer, then puts everything back.
 * `globals` adds or replaces more of the page's globals (navigator, location, …) for the run.
 */
async function withoutIsolation(fn, globals = {}) {
  const page = fakePage();
  const replaced = { window: page.window, document: page.document, ...globals };
  const saved = { SharedArrayBuffer: Object.getOwnPropertyDescriptor(globalThis, 'SharedArrayBuffer') };
  for (const key of Object.keys(replaced)) saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  delete globalThis.SharedArrayBuffer;
  for (const [key, value] of Object.entries(replaced)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  try {
    return await fn(page);
  } finally {
    for (const [key, desc] of Object.entries(saved)) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  }
}

const CONFIG = { injectStyles: false, autoResize: false, canvasWidth: 640, canvasHeight: 360 };

/** Scene.init on a fresh scene of `game`: the message it rejects with, and the overlays it showed. */
async function initMessage(game) {
  const scene = new Scene(game);
  const shown = [];
  scene._showFatalErrorMessage = (where, title, message) => shown.push({ where, title, message });
  let message = null;
  await scene.init().catch((err) => {
    message = err.message;
  });
  return { message, shown };
}

test('the engine is constructed without SharedArrayBuffer, and the scene says why it cannot start', async () => {
  await withoutIsolation(async () => {
    assert.equal(typeof SharedArrayBuffer, 'undefined');
    // The isolation service worker off (DX-SW): today's message about the headers.
    const game = new GameEngine({ ...CONFIG, isolationServiceWorker: false });
    assert.equal(Atomics.load(game._presentingFlag, 0), 1, 'the presenting flag still works');
    assert.equal(await game._isolation, 'failed');
    const { message, shown } = await initMessage(game);
    assert.equal(message, SHARED_ARRAY_BUFFER_MISSING);
    assert.deepEqual(shown, [{ where: 'page', title: 'SharedArrayBuffer unavailable', message: SHARED_ARRAY_BUFFER_MISSING }]);
  });
  assert.equal(typeof SharedArrayBuffer, 'function', 'restored');
});

test('by default the gate runs first, and its reason leads the message (here: no service workers)', async () => {
  await withoutIsolation(async () => {
    const game = new GameEngine(CONFIG);
    assert.equal(await game._isolation, 'failed');
    const { message } = await initMessage(game);
    assert.equal(message, `${ISOLATION_REASONS.noServiceWorker} ${SHARED_ARRAY_BUFFER_MISSING}`);
  });
});

test('loadScene never settles while the page reloads into an isolated one', async () => {
  await withoutIsolation(async () => {
    const game = new GameEngine({ ...CONFIG, isolationServiceWorker: false });
    game._isolation = Promise.resolve('reloading');
    const outcome = await Promise.race([
      game.loadScene(Scene).then(() => 'settled', () => 'rejected'),
      new Promise((r) => setTimeout(() => r('pending'), 50)),
    ]);
    assert.equal(outcome, 'pending');
    assert.equal(game.currentScene, null, 'no scene was created');
  });
});

test('on an isolated page the presenting flag is shared', async () => {
  const page = fakePage();
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.window = page.window;
  globalThis.document = page.document;
  try {
    const game = new GameEngine({ injectStyles: false, autoResize: false, canvasWidth: 640, canvasHeight: 360 });
    assert.ok(game._presentingFlag.buffer instanceof SharedArrayBuffer);
  } finally {
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
    else delete globalThis.window;
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
    else delete globalThis.document;
  }
});

// DX-SW. While the gate works on a page that is not isolated, a black veil covers what the page
// draws (a menu, the debug bar): a first visit reloads, and that content would flash and vanish.

const veils = (page) => page.document.documentElement.children.filter((el) => el.id === 'weed-isolation-veil');

test('the veil covers the page while the gate works, and comes off when it fails', async () => {
  await withoutIsolation(async (page) => {
    const game = new GameEngine(CONFIG);
    assert.equal(veils(page).length, 1, 'up from the constructor on');
    assert.match(veils(page)[0].style.cssText, /position:fixed;inset:0/);
    assert.match(veils(page)[0].style.cssText, /background:#000/);
    assert.equal(await game._isolation, 'failed');
    assert.equal(veils(page).length, 0, 'off, so the error shows');
  });
});

test('no veil when the service worker is off', async () => {
  await withoutIsolation(async (page) => {
    const game = new GameEngine({ ...CONFIG, isolationServiceWorker: false });
    assert.equal(veils(page).length, 0);
    assert.equal(await game._isolation, 'failed');
  });
});

test('the veil stays up while the page reloads into an isolated one', async () => {
  const active = { scriptURL: 'https://game.test/weed-sw.js', state: 'activated' };
  const store = new Map();
  let reloads = 0;
  await withoutIsolation(async (page) => {
    page.document.baseURI = 'https://game.test/index.html';
    const game = new GameEngine(CONFIG);
    assert.equal(await game._isolation, 'reloading');
    assert.equal(reloads, 1);
    assert.equal(veils(page).length, 1);
  }, {
    isSecureContext: true,
    location: { href: 'https://game.test/index.html', reload: () => reloads++ },
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    navigator: { serviceWorker: { controller: null, getRegistration: async () => ({ active }), register: async () => ({ active }) } },
  });
});
