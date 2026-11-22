// The debug overlay's scene switcher: the overlay loads after the page's code runs (SST-14: DebugUI.load imports it),
// so a list registered right after new GameEngine() found game.debugUI null and the Scene tab showed no scenes. The
// engine keeps the list and hands it to the overlay when it is in, or at once when it already is.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GameEngine } from '../../src/core/gameEngine.js';
import { DebugUI } from '../../src/core/debug/debugUi.js';

/** The page objects the constructor touches, and nothing more. */
function withFakePage(fn) {
  const element = () => ({ style: {}, parentNode: null, addEventListener() {}, removeEventListener() {} });
  const listeners = { addEventListener() {}, removeEventListener() {} };
  const page = {
    window: { ...listeners, innerWidth: 640, innerHeight: 360 },
    document: {
      ...listeners,
      visibilityState: 'visible',
      fullscreenElement: null,
      createElement: element,
      documentElement: { appendChild(el) { return el; }, removeChild(el) { return el; } },
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
  };
  const saved = {};
  for (const key of Object.keys(page)) saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  for (const [key, value] of Object.entries(page)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, desc] of Object.entries(saved)) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else delete globalThis[key];
      }
    });
}

const CONFIG = { injectStyles: false, autoResize: false, canvasWidth: 640, canvasHeight: 360 };
const SCENES = [{ name: 'A', url: '/a.js' }, { name: 'B', url: '/b.js', export: 'B' }];

function fakeOverlay() {
  return {
    got: null,
    registerScenes(scenes) {
      this.got = scenes;
    },
    destroy() {},
  };
}

test('scenes registered before the overlay loads reach it when it is in', async () => {
  const overlay = fakeOverlay();
  const load = DebugUI.load;
  DebugUI.load = () => Promise.resolve(overlay);
  try {
    await withFakePage(async () => {
      const game = new GameEngine({ ...CONFIG, debug: true });
      assert.equal(game.debugUI, null, 'the overlay is still loading');
      game.registerScenes(SCENES);
      await game._debugUILoad;
      assert.equal(game.debugUI, overlay);
      assert.equal(overlay.got, SCENES);
    });
  } finally {
    DebugUI.load = load;
  }
});

test('scenes registered after the overlay loaded go to it at once', async () => {
  const overlay = fakeOverlay();
  const load = DebugUI.load;
  DebugUI.load = () => Promise.resolve(overlay);
  try {
    await withFakePage(async () => {
      const game = new GameEngine({ ...CONFIG, debug: true });
      await game._debugUILoad;
      assert.deepEqual(overlay.got, [], 'the overlay starts with the (empty) list');
      game.registerScenes(SCENES);
      assert.equal(overlay.got, SCENES);
      assert.equal(game.registeredScenes, SCENES);
    });
  } finally {
    DebugUI.load = load;
  }
});

test('with debug off the list is kept and nothing is loaded', async () => {
  await withFakePage(async () => {
    const game = new GameEngine({ ...CONFIG, debug: false });
    game.registerScenes(SCENES);
    assert.equal(game.debugUI, null);
    assert.equal(game.registeredScenes, SCENES);
  });
});
