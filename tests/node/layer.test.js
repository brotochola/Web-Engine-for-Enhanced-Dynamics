import test from 'node:test';
import assert from 'node:assert/strict';

import { Layer } from '../../src/core/Layer.js';

const BUILT_IN_LAYERS = {
  BACKGROUND: {},
  DECALS: {},
  CASTED_SHADOWS: {},
  ENTITIES: {},
  LIGHTING: {},
};

test('background commands are only posted for Layer.BACKGROUND', async () => {
  const previousWarn = console.warn;
  const warnings = [];
  const posted = [];

  console.warn = (message) => warnings.push(String(message));

  try {
    Layer.reset();
    Layer.initializeFromConfig({}, BUILT_IN_LAYERS, true);
    Layer._postToRenderer = (msg) => posted.push(msg);

    Layer.BACKGROUND.setStaticBackground('sky');
    Layer.BACKGROUND.setTilingBackground('clouds', 0.5);
    const pendingBackgroundPromise = Layer.BACKGROUND.setTilemapBackground('roads', { scale: 1 });
    Layer.BACKGROUND.clearBackground();

    Layer.ENTITIES.setStaticBackground('bad');
    Layer.ENTITIES.setTilingBackground('bad', 2);
    await Layer.ENTITIES.setTilemapBackground('bad-map', { scale: 3 });
    Layer.ENTITIES.clearBackground();

    assert.equal(posted.length, 4);
    assert.ok(pendingBackgroundPromise instanceof Promise);
    assert.deepEqual(
      posted.map((msg) => ({ type: msg.type, layerId: msg.layerId })),
      [
        { type: 'static', layerId: Layer.BACKGROUND.id },
        { type: 'tiling', layerId: Layer.BACKGROUND.id },
        { type: 'tilemap', layerId: Layer.BACKGROUND.id },
        { type: 'none', layerId: Layer.BACKGROUND.id },
      ]
    );
    assert.equal(warnings.length, 4);
    assert.ok(warnings.every((message) => message.includes('Layer.BACKGROUND')));
  } finally {
    console.warn = previousWarn;
    Layer.reset();
  }
});
