import test from 'node:test';
import assert from 'node:assert/strict';

import { GameEngine } from '../../src/core/gameEngine.js';
import { Scene } from '../../src/core/scene.js';
import { SHARED_ARRAY_BUFFER_MISSING } from '../../src/util/crossOriginIsolation.js';

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

test('the engine is constructed without SharedArrayBuffer, and the scene says why it cannot start', async () => {
  await withoutIsolation(async () => {
    assert.equal(typeof SharedArrayBuffer, 'undefined');
    const game = new GameEngine({ injectStyles: false, autoResize: false, canvasWidth: 640, canvasHeight: 360 });
    assert.equal(Atomics.load(game._presentingFlag, 0), 1, 'the presenting flag still works');

    const scene = new Scene(game);
    const shown = [];
    scene._showFatalErrorMessage = (where, title, message) => shown.push({ where, title, message });
    await assert.rejects(scene.init(), (err) => err.message === SHARED_ARRAY_BUFFER_MISSING);
    assert.deepEqual(shown, [{ where: 'page', title: 'SharedArrayBuffer unavailable', message: SHARED_ARRAY_BUFFER_MISSING }]);
  });
  assert.equal(typeof SharedArrayBuffer, 'function', 'restored');
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
