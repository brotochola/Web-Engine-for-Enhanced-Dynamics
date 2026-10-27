import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GpuParticles } from '../../src/core/gpuParticles.js';
import { Layer } from '../../src/core/layer.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { CLOCK_BYTES, Time } from '../../src/core/timeScale.js';
import { DECORATION_Y_SORT_SCALE, LAYER_KIND } from '../../src/util/configDefaults.js';
import { orderSortKey, spriteYSortKey, zSortBand } from '../../src/util/sortIndexByKey.js';
import { seededRandom } from '../../src/util/utils.js';
import { PROXY, PROXY_KIND, ProxyCollector, localProxyHalf } from '../../src/render/gpuParticleProxies.js';
import { EntityChunks, RegionQuads } from '../../src/render/gpuParticleChunks.js';
import { GpuParticleLayerBatch } from '../../src/render/gpuParticleBatch.js';
import { Container, Matrix, Texture } from '../../src/vendor/pixi.min.js';

// The Pixi worker's side of the y-sort proxies: the entries of the frame it draws put the groups' meshes between
// chunks of the entities batch under the entities root, a hidden layer's groups are left out, and the layers go
// back to their zIndex when the entities stop y-sorting. A look layer's regions blend as its composite does. The real methods (the prototype's) on a small context.

const previousSelf = globalThis.self;
const previousPostMessage = globalThis.postMessage;
globalThis.self = globalThis;
globalThis.postMessage = () => {};
await import('../../src/workers/pixiWorker.js');
const Pixi = globalThis.pixiRenderer.constructor.prototype;
test.after(() => {
  globalThis.self = previousSelf;
  globalThis.postMessage = previousPostMessage;
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WGSL = fs.readFileSync(path.join(root, 'src/shaders/gpuParticle.wgsl'), 'utf8');
const REGION_WGSL = fs.readFileSync(path.join(root, 'src/shaders/gpuRegion.wgsl'), 'utf8');
const BAND = zSortBand(720);

function setup() {
  const layers = { smoke: { kind: LAYER_KIND.GPU_PARTICLES, maxParticles: 64 * 3, sortWithEntities: true } };
  Layer.reset();
  Layer.initializeFromConfig(layers, { decals: {}, castedShadows: {}, entities: {}, lighting: {} });
  GpuParticles.initializeFromConfig(layers, 1);
  GpuParticles.writerSlot = 0;
  const clock = new SharedArrayBuffer(CLOCK_BYTES);
  new Float32Array(clock, 0, 1)[0] = 1;
  Time.bind(clock);
  globalThis.rng = seededRandom(5, 'gpu-proxies-pixi');
  const newBatch = () => new GpuParticleLayerBatch({
    info: GpuParticles.layerOf('smoke'),
    useWebGpu: true,
    shaders: { gpuParticle: WGSL },
    atlasSource: Texture.WHITE.source,
    lutSource: Texture.WHITE.source,
    animStartSource: Texture.WHITE.source,
    blendMode: 'normal',
  });
  const batch = newBatch();
  // The entities batch: another batch's mesh stands in (a real Mesh with instance attributes).
  const standIn = newBatch();
  const entitiesMesh = standIn.rings[0].meshes[0];
  entitiesMesh.visible = true;
  entitiesMesh.geometry.instanceCount = 3;
  const entitiesBatch = { mesh: entitiesMesh };
  const entitiesRoot = new Container();
  entitiesRoot.addChild(entitiesMesh);
  const layerId = Layer.get('smoke').id;
  const displaySprite = new Container();
  const pl = { layerId, cl: { displaySprite, rtOut: null }, batch, regions: null };
  const ctx = Object.assign(Object.create(Pixi), {
    entitiesBatch,
    _entitiesRoot: entitiesRoot,
    _entityChunks: new EntityChunks({ batch: entitiesBatch, root: entitiesRoot }),
    _proxyLayers: [],
    _proxyLayerList: [pl],
    _proxyHalves: null,
    _proxyReadHalf: 0,
    _proxyLocal: localProxyHalf(),
    _proxyCollector: new ProxyCollector(),
    _proxyView: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    _proxyBand: BAND,
    _proxyApplyHalf: null,
    _proxyDrawEntry: null,
    _proxyMatrix: new Matrix(),
    _proxiesOn: false,
    _painter: {},
    _renderCameraX: 0,
    _renderCameraY: 0,
    _renderZoom: 1,
    _renderCameraRot: 0,
    canvasWidth: 1280,
    canvasHeight: 720,
    renderQueueSortKey: null,
    ySort: true,
    _entityYSort() {
      return this.ySort;
    },
  });
  ctx._proxyLayers[layerId] = pl;
  ctx._proxyDrawEntry = (w, out) => Pixi._drawProxyEntry.call(ctx, w, out);
  return {
    ctx,
    batch,
    layerId,
    displaySprite,
    entitiesMesh,
    entitiesRoot,
    restore() {
      batch.destroy();
      standIn.destroy();
      GpuParticles.reset();
      Layer.reset();
      Time.unbind();
    },
  };
}

test('Pixi puts each group between the entities it sorts between, under the entities root', { concurrency: false }, () => {
  const { ctx, batch, entitiesMesh, entitiesRoot, restore } = setup();
  try {
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 4, x: 0, y: 0, lifespan: 5000, sortY: 200 });
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 4, x: 0, y: 0, lifespan: 5000, sortY: 400 });
    const rows = [100, 300, 500];
    ctx.renderQueueSortKey = Float32Array.from(rows, (y) => orderSortKey(spriteYSortKey(y, DECORATION_Y_SORT_SCALE), 0, true, BAND));
    Pixi._syncProxiesOn.call(ctx);
    assert.equal(batch.sorted, true);
    batch.update(Time.simNowMs);
    Pixi._applyLocalProxies.call(ctx, null, 3);
    const kids = entitiesRoot.children;
    assert.equal(kids.length, 5, 'chunk, group, chunk, group, chunk');
    assert.deepEqual([kids[0].geometry.weedFirstInstance, kids[0].geometry.instanceCount], [0, 1]);
    assert.equal(kids[1], batch.rings[0].pool[0]);
    assert.deepEqual([kids[1].geometry.weedFirstInstance, kids[1].geometry.instanceCount], [0, 4], 'the first group\'s slots');
    assert.deepEqual([kids[2].geometry.weedFirstInstance, kids[2].geometry.instanceCount], [1, 1]);
    assert.deepEqual([kids[3].geometry.weedFirstInstance, kids[3].geometry.instanceCount], [4, 4]);
    assert.deepEqual([kids[4].geometry.weedFirstInstance, kids[4].geometry.instanceCount], [2, 1]);
    assert.ok(!kids.includes(entitiesMesh), 'the batch\'s own mesh is replaced by its chunks');
  } finally {
    restore();
  }
});

test('a hidden layer\'s groups are left out; its alpha goes on their meshes', { concurrency: false }, () => {
  const { ctx, batch, layerId, entitiesMesh, entitiesRoot, restore } = setup();
  try {
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 4, x: 0, y: 0, lifespan: 5000, sortY: 200 });
    ctx.renderQueueSortKey = new Float32Array(3);
    entitiesMesh.geometry.instanceCount = 0;
    Pixi._syncProxiesOn.call(ctx);
    Layer._alpha[layerId] = 0.25;
    Pixi._applyLocalProxies.call(ctx, null, 0);
    assert.equal(entitiesRoot.children.length, 1);
    assert.equal(entitiesRoot.children[0].alpha, 0.25);
    Layer._visible[layerId] = 0;
    Pixi._applyLocalProxies.call(ctx, null, 0);
    assert.equal(entitiesRoot.children.length, 0, 'no entities packed, the group hidden');
    assert.equal(batch.rings[0].poolUsed, 0);
  } finally {
    restore();
  }
});

test('without the entities\' y-sort the layers draw at their zIndex again', { concurrency: false }, () => {
  const { ctx, batch, displaySprite, entitiesMesh, entitiesRoot, restore } = setup();
  try {
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 4, x: 0, y: 0, lifespan: 5000, sortY: 200 });
    ctx.renderQueueSortKey = new Float32Array(3);
    Pixi._syncProxiesOn.call(ctx);
    assert.equal(displaySprite.renderable, false, 'a look layer\'s composite gives way to its regions');
    Pixi._applyLocalProxies.call(ctx, null, 3);
    assert.notDeepEqual(entitiesRoot.children, [entitiesMesh]);
    ctx.ySort = false;
    Pixi._syncProxiesOn.call(ctx);
    assert.equal(batch.sorted, false);
    assert.equal(displaySprite.renderable, true);
    assert.deepEqual(entitiesRoot.children, [entitiesMesh]);
    batch.update(Time.simNowMs);
    assert.equal(batch.rings[0].meshes[0].visible, true, 'the rings draw again');
  } finally {
    restore();
  }
});

test('a look layer\'s region blends as its full-screen composite, and samples where the camera puts it', { concurrency: false }, () => {
  const { ctx, layerId, displaySprite, entitiesMesh, entitiesRoot, restore } = setup();
  const regions = new RegionQuads({
    useWebGpu: true,
    shaders: { gpuRegion: REGION_WGSL },
    texture: Texture.WHITE,
    blendMode: 'normal',
  });
  try {
    const pl = ctx._proxyLayers[layerId];
    pl.regions = regions;
    pl.cl.rtOut = Texture.WHITE;
    displaySprite.blendMode = 'screen'; // the layer's blendMode, as _applyLayerPresentation sets it
    entitiesMesh.geometry.instanceCount = 2;
    ctx._renderZoom = 2;
    ctx._renderCameraX = 100;
    ctx._renderCameraY = 50;
    const half = localProxyHalf();
    half.ints[PROXY.INDEX] = 1;
    half.ints[PROXY.KIND_LAYER] = (PROXY_KIND.REGION << 8) | layerId;
    half.floats[PROXY.MIN_X_F] = 100;
    half.floats[PROXY.MIN_Y_F] = 50;
    half.floats[PROXY.MAX_X_F] = 740;
    half.floats[PROXY.MAX_Y_F] = 410;
    half.header[0] = 1;
    Pixi._applyProxies.call(ctx, half);
    const kids = entitiesRoot.children;
    assert.equal(kids.length, 3, 'chunk, region, chunk');
    const quad = kids[1];
    assert.equal(regions.blendMode, 'screen');
    assert.equal(quad.blendMode, 'screen', 'not the containerBlend its particles were summed with');
    const uv = Array.from(regions.pool[0].uvs.data);
    assert.deepEqual(uv, [0, 0, 1, 0, 1, 1, 0, 1], 'world (100, 50)-(740, 410) at zoom 2 fills the 1280x720 canvas');
  } finally {
    regions.destroy();
    restore();
  }
});
