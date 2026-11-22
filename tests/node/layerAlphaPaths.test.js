/**
 * DBG-3: the Layers panel's alpha fades a layer on every render path, instead of acting as on or off.
 *   - The entities' opaque pass (E-448) draws solid pixels with blending off: it is not allowed while the entities layer
 *     fades (the real Pixi worker's frame, through workerHarness), so the batch blends every pixel.
 *   - The unshaded composite fades with the lighting layer, whose light it makes up for.
 *   - The light's meshes read the layer's alpha (uColor.a): the multiplied half mixes toward white, the added halves
 *     scale by it. A GPU blend, so their sources are checked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { Layer } from '../../src/core/layer.js';
import { lightEdgesGlsl, lightEdgesWgsl } from '../../src/render/lightEdges.js';
import { UNSHADED_COMPOSITE_FRAG, UNSHADED_COMPOSITE_WGSL } from '../../src/render/unshadedComposite.js';
import { readEngineShader } from './engineShaderSources.mjs';

/** The worker's own copy for one test: the harness hands out one instance, and a stub put on it would outlive the test. */
async function pixi() {
  const shared = await loadWorker('pixiWorker.js', 'pixiRenderer');
  return Object.assign(Object.create(Object.getPrototypeOf(shared)), shared);
}

/** One frame of updateSpritesFromRenderQueue up to the opaque pass's gate, with the entities layer at `alpha`. */
async function opaqueAllowedAt(alpha) {
  const px = await pixi();
  const allowed = [];
  px.renderQueueEnabled = true;
  px.renderQueueSync = null;
  px.renderQueueCount = null;
  px._gpuQueueRead = null;
  px._opaqueOn = true;
  px._entityChunksActive = false;
  px._screenLayersShown = () => false;
  px._refusePackedFrame = () => 0;
  px._proxiesOn = false;
  px.entitiesGlowBatch = null;
  px._entitiesRoot = { alpha };
  px.entitiesBatch = {
    setPixelDepthTerms() {},
    setOpaqueAllowed: (on) => allowed.push(on),
    setOpaqueView() {},
    hide() {},
  };
  px.updateSpritesFromRenderQueue();
  return allowed;
}

test('the entities\' opaque pass is allowed at layer alpha 1 and not while the layer fades', async () => {
  assert.deepEqual(await opaqueAllowedAt(1), [true]);
  assert.deepEqual(await opaqueAllowedAt(0.5), [false]);
  assert.deepEqual(await opaqueAllowedAt(0.999), [false]);
});

test('the lighting layer\'s alpha reaches the unshaded composite', async () => {
  const px = await pixi();
  const saved = { byId: Layer._byId, alpha: Layer._alpha, dirty: Layer._alphaDirty, count: Layer.count };
  Layer._byId = [{ id: 0, name: 'lighting' }];
  Layer._alpha = new Float32Array(Layer.MAX_LAYERS).fill(1);
  Layer._alphaDirty = new Int32Array(Layer.MAX_LAYERS);
  Layer.count = 1;
  px._layerRuntime = { lighting: { alpha: 1 } };
  px._customLayers = {};
  px._sunLayers = [];
  px._unshadedComposite = { alpha: 1 };
  try {
    Layer._alpha[0] = 0.25;
    Layer._alphaDirty[0] = 1;
    px.syncLayerAlphaFromSharedState();
    assert.equal(px._layerRuntime.lighting.alpha, 0.25);
    assert.equal(px._unshadedComposite.alpha, 0.25);
  } finally {
    Layer._byId = saved.byId;
    Layer._alpha = saved.alpha;
    Layer._alphaDirty = saved.dirty;
    Layer.count = saved.count;
  }
});

test('the light\'s meshes read the layer\'s alpha, GLSL and WGSL', () => {
  for (const kind of ['lightFloor', 'lightEntity']) {
    assert.match(lightEdgesGlsl(kind).fragment, /mix\(vec3\(1\.0\), edgeLight\(vUV\), uColor\.a\)/, kind);
    assert.match(lightEdgesWgsl(kind), /mix\(vec3<f32>\(1\.0\), light, localUniforms\.uColor\.a\)/, kind);
  }
  for (const kind of ['unshadedFloor', 'unshadedEntity']) {
    assert.match(lightEdgesGlsl(kind).fragment, /\* uColor\.a, 0\.0\)/, kind);
    assert.match(lightEdgesWgsl(kind), /\* localUniforms\.uColor\.a, 0\.0\)/, kind);
  }
  assert.match(UNSHADED_COMPOSITE_FRAG, /\* uColor\.a, 0\.0\)/);
  assert.match(UNSHADED_COMPOSITE_WGSL, /\* localUniforms\.uColor\.a, 0\.0\)/);
  const glsl = readEngineShader('lightingBasic.frag.glsl');
  const wgsl = readEngineShader('lightingBasic.wgsl');
  assert.match(glsl, /finalColor = vec4\(mix\(vec3\(1\.0\), totalLight, uColor\.a\), 1\.0\);/);
  assert.match(wgsl, /return vec4<f32>\(mix\(vec3<f32>\(1\.0\), totalLight, localUniforms\.uColor\.a\), 1\.0\);/);
});
