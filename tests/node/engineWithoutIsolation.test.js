import test from 'node:test';
import assert from 'node:assert/strict';

import { GameEngine } from '../../src/core/gameEngine.js';
import { Scene } from '../../src/core/scene.js';
import { ISOLATION_REASONS, SHARED_ARRAY_BUFFER_MISSING } from '../../src/util/crossOriginIsolation.js';

// DX-SW, SW-1. On a page that is not cross-origin isolated the browser does not define
// SharedArrayBuffer. new GameEngine() made one for its presenting flag and threw a ReferenceError,
// so the message Scene.init shows for exactly this case (and DEPLOY.md promises) never appeared.

/** The page objects the constructor touches, and nothing more. */
function fakePage() {
  const element = () => ({ style: {}, addEventListener() {}, removeEventListener() {} });
  const listeners = { addEventListener() {}, removeEventListener() {} };
  return {
    window: { ...listeners, innerWidth: 640, innerHeight: 360 },
    document: {
      ...listeners,
      visibilityState: 'visible',
      fullscreenElement: null,
      createElement: element,
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
  };
}

/** Runs fn on a fake page whose global scope has no SharedArrayBuffer, then puts everything back. */
async function withoutIsolation(fn) {
  const saved = {
    SharedArrayBuffer: Object.getOwnPropertyDescriptor(globalThis, 'SharedArrayBuffer'),
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  };
  const page = fakePage();
  delete globalThis.SharedArrayBuffer;
  globalThis.window = page.window;
  globalThis.document = page.document;
  try {
    return await fn();
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
