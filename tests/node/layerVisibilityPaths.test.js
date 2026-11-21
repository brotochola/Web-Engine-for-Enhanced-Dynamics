/**
 * DBG-1: the Layers panel's Vis box hides everything a layer draws, on every render path. The real Pixi worker in Node
 * (workerHarness), its GPU passes stubbed:
 *   - castedShadows hidden in shadow-map mode clears the sun's and the lamps' maps once (the light pass samples them),
 *     and the first frame shown again draws them whatever shadowUpdateInterval is;
 *   - a hidden entities layer casts nothing: its sun, stamp and cookie rows are left out;
 *   - a hidden lighting layer hides the unshaded composite;
 *   - a MESH layer's textured rows (the uvFill mesh on the stage) follow the layer's visibility.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { Layer } from '../../src/core/layer.js';
import { GPU_HDR_COOKIE, GPU_HDR_STAMP, GPU_HDR_SUN, GPU_HEADER_INTS } from '../../src/render/gpuQueueLayout.js';

const IDS = { entities: 0, castedShadows: 1, lighting: 2, floor: 3 };

/** Layer's statics as a scene with these layers sets them, `hidden` names hidden; put back by the returned function. */
function withLayers(hidden) {
  const saved = { byName: Layer._byName, byId: Layer._byId, visible: Layer._visible, count: Layer.count, entitiesId: Layer.entitiesId };
  const byName = {};
  const byId = [];
  for (const [name, id] of Object.entries(IDS)) {
    byName[name] = { id, name };
    byId[id] = byName[name];
  }
  Layer._byName = byName;
  Layer._byId = byId;
  Layer._visible = new Uint8Array(Layer.MAX_LAYERS).fill(1);
  for (const name of hidden) Layer._visible[IDS[name]] = 0;
  Layer.count = Object.keys(IDS).length;
  Layer.entitiesId = IDS.entities;
  return {
    show(name) { Layer._visible[IDS[name]] = 1; },
    restore() {
      Layer._byName = saved.byName;
      Layer._byId = saved.byId;
      Layer._visible = saved.visible;
      Layer.count = saved.count;
      Layer.entitiesId = saved.entitiesId;
    },
  };
}

/** The worker's own copy for one test: the harness hands out one instance, and a stub put on it would outlive the test. */
async function pixi() {
  const shared = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const px = Object.assign(Object.create(Object.getPrototypeOf(shared)), shared);
  px.submits = [];
  px._submitRender = function submit(opts) { this.submits.push(opts.target); };
  return px;
}

test('castedShadows hidden in map mode: the sun and lamp maps cleared once, drawn again the first frame shown', async () => {
  const px = await pixi();
  const draws = [];
  px.shadowSpritesEnabled = true;
  px.shadowBatch = {};
  px.shadowRT = { name: 'shadowRT' };
  px.sunMapRT = { name: 'sunMap' };
  px.lampMapRT = { name: 'lampMap' };
  px._sunMapOn = true;
  px._lampMapOn = true;
  px.shadowUpdateInterval = 3;
  px._shadowUpdateTick = 2;
  px._drawGpuCasterShadows = function draw() {
    draws.push(this._shadowUpdateTick - 1);
    // What a drawn frame leaves: the maps hold shadows again.
    this._sunMapDrew = true;
    this._sunMapClear = false;
    this._lampMapClear = false;
  };
  const layers = withLayers(['castedShadows']);
  try {
    px.updateShadowSprites();
    px.updateShadowSprites();
    assert.deepEqual(px.submits.map((t) => t.name), ['sunMap', 'lampMap'], 'cleared once, not every frame');
    assert.deepEqual(draws, []);
    layers.show('castedShadows');
    px.updateShadowSprites();
    assert.deepEqual(draws, [0], 'the first frame shown draws, though the interval is 3');
  } finally {
    layers.restore();
  }
});

/** A Pixi worker whose shadow pass runs with lamp maps on and sun off, with these sun, stamp and cookie counts. */
async function shadowPass(counts) {
  const px = await pixi();
  const lampDraws = [];
  const header = new Int32Array(GPU_HEADER_INTS);
  header[GPU_HDR_SUN] = counts.sun;
  header[GPU_HDR_STAMP] = counts.stamp;
  header[GPU_HDR_COOKIE] = counts.cookie;
  px._gpuQueueRead = { header, sun: null, stamp: null, cookie: null };
  const uniforms = { uCam: [0, 0, 0], uSun: [0, 0, 0, 0], uLight: [0, 0, 0, 0], uSunK: [0, 0, 0, 0], uSunPerp: [0, 0] };
  px.gpuCasterBatch = {
    mesh: { shader: null, position: { set() {} }, scale: { set() {} }, geometry: {} },
    shadowShader: { resources: { uniforms: { uniforms } } },
    setTargetSpace() {},
  };
  px.shadowRT = { name: 'shadowRT' };
  px.lampMapRT = { name: 'lampMap' };
  px._lampMapOn = true;
  px._sunMapOn = false;
  px._lampTileCount = 0;
  px._ensureKeyedCasters = () => {};
  px._shadowPixelScale = () => 1;
  px._drawLampMap = (batch, gpu, n) => { lampDraws.push(n); return true; };
  return { px, lampDraws };
}

test('entities shown: their stamp rows go to the lamps\' map, and their counts are reported', async () => {
  const layers = withLayers([]);
  try {
    const { px, lampDraws } = await shadowPass({ sun: 40, stamp: 12, cookie: 3 });
    px._drawGpuCasterShadows();
    assert.deepEqual(lampDraws, [12]);
    assert.equal(px._gpuCastersThisFrame, 40);
    assert.equal(px._gpuShadowLightsThisFrame, 3);
  } finally {
    layers.restore();
  }
});

test('entities hidden: no caster row is drawn, and the lamps\' map is cleared instead', async () => {
  const layers = withLayers(['entities']);
  try {
    const { px, lampDraws } = await shadowPass({ sun: 40, stamp: 12, cookie: 3 });
    px._drawGpuCasterShadows();
    assert.deepEqual(lampDraws, []);
    assert.equal(px._gpuCastersThisFrame, 0);
    assert.equal(px._gpuShadowLightsThisFrame, 0);
    assert.ok(px.submits.some((t) => t && t.name === 'lampMap'), 'the lamps\' map cleared');
  } finally {
    layers.restore();
  }
});

test('lighting hidden: the unshaded composite is hidden with it', async () => {
  const px = await pixi();
  px.lightingRT = {};
  px.lightingMesh = {};
  px._unshadedOn = true;
  px._unshadedComposite = { visible: true };
  let unshadedRenders = 0;
  px._renderUnshaded = () => { unshadedRenders++; };
  const layers = withLayers(['lighting']);
  try {
    px.renderLightingToTexture();
    assert.equal(px._unshadedComposite.visible, false);
    assert.equal(unshadedRenders, 0);
  } finally {
    layers.restore();
  }
});

test('a MESH layer on the stage: its uvFill mesh follows Vis, and stays hidden while it has no triangles', async () => {
  const px = await pixi();
  const fill = { visible: true };
  const uvMesh = { visible: true, geometry: { instanceCount: 1 } };
  px._layerRuntime = { floor: fill };
  px._customLayers = { [IDS.floor]: { uvFillBatch: { mesh: uvMesh }, rt: null, meshLook: false } };
  const layers = withLayers(['floor']);
  try {
    px._applyLayerVisibility();
    assert.equal(fill.visible, false);
    assert.equal(uvMesh.visible, false, 'hidden with the layer');
    layers.show('floor');
    px._applyLayerVisibility();
    assert.equal(uvMesh.visible, true, 'shown again');
    uvMesh.geometry.instanceCount = 0;
    px._applyLayerVisibility();
    assert.equal(uvMesh.visible, false, 'an empty uvFill mesh stays hidden');
  } finally {
    layers.restore();
  }
});
