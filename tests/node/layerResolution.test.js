import test from 'node:test';
import assert from 'node:assert/strict';

import { Layer } from '../../src/core/layer.js';
import { DEFAULT_LAYERS } from '../../src/util/configDefaults.js';

// pixiWorker.js registers its instance on `self` rather than exporting it, and it reads `self` at module scope.
const previousSelf = globalThis.self;
const previousPostMessage = globalThis.postMessage;
globalThis.self = globalThis;
globalThis.postMessage = () => {};
await import('../../src/workers/pixiWorker.js');
const PixiRenderer = globalThis.pixiRenderer.constructor;
globalThis.self = previousSelf;
globalThis.postMessage = previousPostMessage;

const LAYERS = {
  smoke: { resolution: 0.25, shader: { fragment: 'f' } },
  fx: { zIndex: 8 },
};

test('Layer.resolution set at run time lands in the config SAB, for every worker', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(LAYERS, DEFAULT_LAYERS, true);
    const smoke = Layer.get('smoke');
    assert.equal(smoke.resolution, 0.25);
    smoke.resolution = 1 / 3;
    assert.equal(smoke.resolution, Math.fround(1 / 3));
    // Another worker's Layer, on the same buffers, reads the new value.
    const data = Layer.getSerializableData();
    Layer.reset();
    Layer.initializeFromBuffers(data);
    assert.equal(Layer.get('smoke').resolution, Math.fround(1 / 3));
  } finally {
    Layer.reset();
  }
});

test('Layer.resolution rejects what is not a finite number above 0 and keeps the old value', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(LAYERS, DEFAULT_LAYERS, true);
    const smoke = Layer.get('smoke');
    for (const bad of [0, -0.5, NaN, Infinity, undefined]) {
      assert.throws(() => (smoke.resolution = bad), /WeedJS: layer "smoke" resolution must be a finite number above 0/);
    }
    assert.equal(smoke.resolution, 0.25);
  } finally {
    Layer.reset();
  }
});

test('the renderer remakes a layer\'s render textures once per resolution change, at the canvas size', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(LAYERS, DEFAULT_LAYERS, true);
    const record = (name) => ({ layerId: Layer.getId(name), layerName: name, resolution: Layer.get(name).resolution });
    const smoke = record('smoke');
    const fx = record('fx');
    const resized = [];
    const ctx = {
      _customLayerList: [smoke, fx],
      canvasWidth: 1280,
      canvasHeight: 800,
      _resizeCustomLayerRTs(cl, width, height) {
        resized.push([cl.layerName, width, height, cl.resolution]);
      },
    };
    const sync = () => PixiRenderer.prototype.syncLayerResolutionFromSharedState.call(ctx);

    sync();
    assert.deepEqual(resized, [], 'nothing changed');

    Layer.get('smoke').resolution = 0.5;
    sync();
    assert.deepEqual(resized, [['smoke', 1280, 800, 0.5]]);
    assert.equal(smoke.resolution, 0.5);

    sync();
    assert.equal(resized.length, 1, 'a change is applied once');
  } finally {
    Layer.reset();
  }
});
