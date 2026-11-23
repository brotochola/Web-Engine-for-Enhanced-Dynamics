import test from 'node:test';
import assert from 'node:assert/strict';

import { Layer } from '../../src/core/layer.js';
import { DEFAULT_LAYERS } from '../../src/util/configDefaults.js';
import { PixiGlowLayer } from '../../src/render/pixi/glowLayer.js';

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
      // N-256 PW-3: the custom layers' list and their targets' resize.
      customLayers: {
        list: [smoke, fx],
        resizeRTs(cl, width, height) {
          resized.push([cl.layerName, width, height, cl.resolution]);
        },
      },
      canvasWidth: 1280,
      canvasHeight: 800,
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
    // The lightGlows layer is 'add''s ('sorted', the default, makes none).
    initializeSceneLayers({ config: { lighting: { lightGlow: 'add', lightGlowResolution: 0.25 }, layers: {} }, numberOfLogicWorkers: 1 });
    assert.equal(Layer.get('lightGlows').resolution, 0.25);
    Layer.reset();
    initializeSceneLayers({ config: { lighting: { lightGlow: 'add' }, layers: {} }, numberOfLogicWorkers: 1 });
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
    const sprite = { renderable: false, scale: { set(x, y) { this.x = x; this.y = y; } }, position: { set(x, y) { this.x = x; this.y = y; } } };
    // N-256 PW-9: the glow layer (src/render/pixi/glowLayer.js) over a worker with what its draw reads.
    const worker = {
      _rtRenderOpts: { container: null, target: null, clear: false, clearColor: null, transform: null },
      _clearTransparent: [0, 0, 0, 0],
      _gpuPassesThisFrame: 0,
      spriteGlowMesh: { visible: false },
      canvasWidth: 1920,
      canvasHeight: 1080,
      _submitRender(o) {
        renders.push({ ...o, transform: { ...o.transform } });
        return true;
      },
    };
    const glow = new PixiGlowLayer(worker);
    Object.assign(glow, {
      sprite,
      host: { label: 'host' },
      rt: { label: 'rt' },
      res: 0.5,
      transform: { a: 0, b: 0, c: 0, d: 0, tx: 0, ty: 0 },
      screenBounds: () => true,
      fitPart() {},
      resizeTarget(resolution, w, h) {
        resized.push([resolution, w, h]);
        this.res = resolution;
      },
    });
    const draw = () => glow.draw();
    draw();
    assert.equal(renders.length, 0, 'no glows: no pass');
    assert.equal(sprite.renderable, false, 'and no sprite over the frame');
    worker.spriteGlowMesh.visible = true;
    draw();
    assert.equal(renders.length, 1);
    assert.equal(renders[0].container, glow.host);
    assert.equal(renders[0].target, glow.rt);
    assert.equal(renders[0].clear, true);
    assert.equal(sprite.renderable, true);
    assert.equal(worker._rtRenderOpts.transform, null, 'the shared options lose the transform again');
    assert.deepEqual(resized, []);
    // Layer.get('lightGlows').resolution set at run time: the target is made again, once.
    Layer.get('lightGlows').resolution = 0.25;
    draw();
    draw();
    assert.deepEqual(resized, [[0.25, 1920, 1080]]);
    // The canvas's px onto the target's and the sprite back over the canvas (480 x 270 at 0.25 of 1920 x 1080).
    glow._fitTarget(480, 270, 1920, 1080);
    assert.deepEqual([sprite.scale.x, sprite.scale.y], [4, 4]);
    assert.deepEqual([glow.transform.a, glow.transform.d, glow.transform.tx], [0.25, 0.25, 0]);
  } finally {
    Layer.reset();
  }
});

test("E-404: the glows' composite covers the canvas rect their quads reach, on the target's grid, a texel more each side", () => {
  // Two glows (rows as InstancedSpriteBatch lays them: x, y, scale, anchor, cos, sin, depth, tint, texture id, ...) of a
  // 100 x 80 frame trimmed to 10..90 x 0..80, anchored at its centre: one at (200, 100) at scale 1, one at (500, 300) at
  // scale 0.5; the camera at zoom 2 from (100, 50).
  const lut = new Float32Array(12);
  lut.set([100, 80, 0, 0, 1, 1, 10, 0, 80, 80, 0, 0]);
  const row = (x, y, scale) => [x, y, scale, scale, 0.5, 0.5, 1, 0, 0, 0, 0, 0, 0, 0, 0];
  const data = new Float32Array([...row(200, 100, 1), ...row(500, 300, 0.5)]);
  const mesh = {
    geometry: { instanceCount: 2 },
    localTransform: { a: 2, b: 0, c: 0, d: 2, tx: -200, ty: -100 },
    updateLocalTransform() {},
  };
  const frame = { x: 0, y: 0, width: 960, height: 540 };
  let updates = 0;
  // N-256 PW-9: the glow layer over a worker with the glow batch's rows, the texture table and the canvas.
  const glow = new PixiGlowLayer({ entitiesGlowBatch: { data }, assets: { texLut: lut }, canvasWidth: 1920, canvasHeight: 1080 });
  Object.assign(glow, {
    rt: { width: 960, height: 540 },
    texture: { frame, update() { updates++; } },
    sprite: { position: { set(x, y) { this.x = x; this.y = y; } } },
  });
  assert.equal(glow.screenBounds(mesh), true);
  // World: x 160..240 and 480..520 (the trim around the 50 px anchor, the second at half scale), y 60..140 and 280..320: on the canvas,
  // (world - camera) * 2.
  assert.deepEqual(Array.from(glow.bounds), [120, 20, 840, 540]);
  glow.fitPart();
  assert.deepEqual([frame.x, frame.y, frame.width, frame.height], [59, 9, 362, 262]);
  assert.equal(updates, 1);
  assert.deepEqual([glow.sprite.position.x, glow.sprite.position.y], [118, 18]);
  glow.fitPart();
  assert.equal(updates, 1, 'the same part: the texture is not touched');
  // Off the canvas: no composite at all.
  mesh.localTransform.tx = -5000;
  assert.equal(glow.screenBounds(mesh), false);
  // A sheared quad (cos past 1): the whole canvas.
  data[6] = 1.6;
  mesh.localTransform.tx = -200;
  assert.equal(glow.screenBounds(mesh), true);
  assert.deepEqual(Array.from(glow.bounds), [0, 0, 1920, 1080]);
});
