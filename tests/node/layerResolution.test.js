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

test('E-404: lighting.lightGlowResolution is the lightGlows layer\'s resolution, half the canvas unless a scene says', async () => {
  const { lightGlowResolutionOf, LIGHTING_DEFAULTS } = await import('../../src/util/configDefaults.js');
  const { initializeSceneLayers } = await import('../../src/util/sceneSharedBuffers.js');
  assert.equal(LIGHTING_DEFAULTS.lightGlowResolution, 0.5);
  assert.equal(lightGlowResolutionOf(undefined), 0.5);
  assert.equal(lightGlowResolutionOf({ lightGlowResolution: 0.25 }), 0.25);
  assert.equal(lightGlowResolutionOf({ lightGlowResolution: 2 }), 1, 'never past the canvas');
  assert.equal(lightGlowResolutionOf({ lightGlowResolution: 0.001 }), 1 / 16);
  for (const bad of [0, -1, NaN, 'x', null]) assert.equal(lightGlowResolutionOf({ lightGlowResolution: bad }), 0.5);
  try {
    Layer.reset();
    initializeSceneLayers({ config: { lighting: { lightGlowResolution: 0.25 }, layers: {} }, numberOfLogicWorkers: 1 });
    assert.equal(Layer.get('lightGlows').resolution, 0.25);
    Layer.reset();
    initializeSceneLayers({ config: { layers: {} }, numberOfLogicWorkers: 1 });
    assert.equal(Layer.get('lightGlows').resolution, 0.5);
    assert.equal(Layer.get('entities').resolution, 1, 'the other built-in layers keep theirs');
  } finally {
    Layer.reset();
  }
});

test('E-404: the glows go into their target when there are some, the canvas onto the target and the sprite back over it', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig({}, { ...DEFAULT_LAYERS, lightGlows: { ...DEFAULT_LAYERS.lightGlows, resolution: 0.5 } }, true);
    const renders = [];
    const resized = [];
    const sprite = { renderable: false, scale: { set(x, y) { this.x = x; this.y = y; } } };
    const ctx = {
      _glowLayerSprite: sprite,
      _glowLayerHost: { label: 'host' },
      _glowLayerRT: { label: 'rt' },
      _glowLayerRes: 0.5,
      _glowLayerTransform: { a: 0, b: 0, c: 0, d: 0, tx: 0, ty: 0 },
      _rtRenderOpts: { container: null, target: null, clear: false, clearColor: null, transform: null },
      _clearTransparent: [0, 0, 0, 0],
      _gpuPassesThisFrame: 0,
      spriteGlowMesh: { visible: false },
      canvasWidth: 1920,
      canvasHeight: 1080,
      _lightGlowLayerResolution: PixiRenderer.prototype._lightGlowLayerResolution,
      _resizeGlowLayerTarget(resolution, w, h) {
        resized.push([resolution, w, h]);
        this._glowLayerRes = resolution;
      },
      _submitRender(o) {
        renders.push({ ...o, transform: { ...o.transform } });
        return true;
      },
    };
    const draw = () => PixiRenderer.prototype.drawFrameGlowLayer.call(ctx);
    draw();
    assert.equal(renders.length, 0, 'no glows: no pass');
    assert.equal(sprite.renderable, false, 'and no sprite over the frame');
    ctx.spriteGlowMesh.visible = true;
    draw();
    assert.equal(renders.length, 1);
    assert.equal(renders[0].container, ctx._glowLayerHost);
    assert.equal(renders[0].target, ctx._glowLayerRT);
    assert.equal(renders[0].clear, true);
    assert.equal(sprite.renderable, true);
    assert.equal(ctx._rtRenderOpts.transform, null, 'the shared options lose the transform again');
    assert.deepEqual(resized, []);
    // Layer.get('lightGlows').resolution set at run time: the target is made again, once.
    Layer.get('lightGlows').resolution = 0.25;
    draw();
    draw();
    assert.deepEqual(resized, [[0.25, 1920, 1080]]);
    // The canvas's px onto the target's and the sprite back over the canvas (480 x 270 at 0.25 of 1920 x 1080).
    PixiRenderer.prototype._fitGlowLayerTarget.call(ctx, 480, 270, 1920, 1080);
    assert.deepEqual([sprite.scale.x, sprite.scale.y], [4, 4]);
    assert.deepEqual([ctx._glowLayerTransform.a, ctx._glowLayerTransform.d, ctx._glowLayerTransform.tx], [0.25, 0.25, 0]);
  } finally {
    Layer.reset();
  }
});
