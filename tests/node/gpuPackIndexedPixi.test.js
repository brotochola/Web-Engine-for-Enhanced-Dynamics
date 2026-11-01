// E-162, wired: Pixi's entity batch taking pre-render's indexed frames (renderer.indexedSprites), through
// updateSpritesFromRenderQueue. On WebGL an indexed frame commits its poses and slot pairs every frame and the statics
// rows to the statics texture only when their generation or the rows moved, drawn by the indexed program; a split frame
// between them draws with the split program again, its statics its own; the chunks of the y-sort painter's proxies draw
// with the batch's program of the frame; and a batch made without the texture refuses an indexed frame, saying why. On
// WebGPU the statics go to a storage buffer the same way, and a device that cannot bind it stops the batch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BufferUsage, Container, TextureSource } from '../../src/vendor/pixi.min.js';
import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Query } from '../../src/core/query.js';
import { createViews } from '../../src/render/renderQueueLayout.js';
import {
  GPU_FLAG_INDEXED,
  GPU_FLAG_SPLIT,
  GPU_INDEXED_SLOT_FLOATS,
  GPU_INDEXED_STATIC_FLOATS,
  GPU_POSE_FLOATS,
  GPU_STATIC_FLOATS,
  createGpuQueueViews,
  writeGpuQueueHeader,
} from '../../src/render/gpuQueueLayout.js';
import { EntityChunks } from '../../src/render/gpuParticleChunks.js';
import { PROXY, PROXY_ENTRY_WORDS } from '../../src/render/gpuParticleProxies.js';
import { STATICS_TEXELS_PER_ROW, STATICS_TEX_ROW } from '../../src/render/spriteIndexed.js';
import { WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';
import { loadWorker, quietly } from '../bench/workerHarness.mjs';

const MAX = 3000;

// GlProgram.from probes shader precision on a canvas (the worker's adapter makes an OffscreenCanvas); Node has none,
// and a context of null is enough.
globalThis.OffscreenCanvas ??= class {
  getContext() {
    return null;
  }
};
const shaderDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/shaders');
const readShader = (f) => fs.readFileSync(path.join(shaderDir, f), 'utf8');
const GL_SHADERS = {
  spriteVert: readShader('instancedSprite.vert.glsl'),
  spriteVertPose: readShader('instancedSpritePose.vert.glsl'),
  spriteFrag: readShader('instancedSprite.frag.glsl'),
  spriteFragBlend: readShader('instancedSpriteBlend.frag.glsl'),
  spriteFragAdd: readShader('instancedSpriteAdditive.frag.glsl'),
};
const GPU_SHADERS = { sprite: readShader('instancedSprite.wgsl'), spritePose: readShader('instancedSpritePose.wgsl') };

class Thing extends GameObject {}
Thing.components = [SpriteRenderer];

function scene(indexedSprites) {
  Query.reset();
  const s = {
    totalEntityCount: 64,
    nextComponentId: 2,
    registeredClasses: [{ class: Thing, count: 64, startIndex: 0, entityType: 0, components: Thing.components }],
    componentPools: {
      Transform: { ComponentClass: Transform },
      SpriteRenderer: { ComponentClass: SpriteRenderer },
    },
    config: {
      worldWidth: 4000,
      worldHeight: 4000,
      canvasWidth: 800,
      canvasHeight: 600,
      particle: { maxParticles: 0 },
      decoration: { maxDecorations: 0 },
      bullet: { maxBullets: 0 },
      physics: { maxJoints: 0 },
      spatial: { cellSize: 100, maxNeighbors: 8, maxEntitiesPerCell: 64, rowsPerBlock: 2, numberOfSpatialWorkers: 1 },
      lighting: { enabled: false, maxLights: 10, shadowsEnabled: false, maxFlashes: 0, raycasted: false },
      logic: { staggeredUpdates: false },
      debug: { maxDebugDrawEntries: 1 },
      navigation: { enabled: false },
      renderer: { maxVisibleRenderables: MAX, ySort: true, backend: 'webgl', indexedSprites },
      preRender: { packGpuSprites: 'preRender', sortSprites: 'preRender' },
      layers: {},
      wasm: { ...WASM_DEFAULTS },
    },
    buffers: { componentData: {} },
    views: {},
    camera: { zoom: 1, x: 0, y: 0 },
    inputBufferSize: 1,
    keyMap: {},
    updateKeyboardBuffer() {},
    preInitializeEntityTypeArrays() {},
    constructor: { queries: [] },
  };
  createSceneSharedBuffers(s);
  return s;
}

/**
 * Pixi on the scene's queues: on WebGL its texture helper a stand-in that records what is made and sent; on WebGPU a
 * device whose storage binding size is `maxStorageBytes`.
 */
async function bindPixi(px, s, { webgpu = false, maxStorageBytes = 1 << 27 } = {}) {
  const m = s.renderQueueMemory;
  const caps = s.gpuQueueCaps;
  px.config = s.config;
  px._ySort = false;
  px._packGpuSpritesOn = 'preRender';
  px._queueInterp = false;
  px._lightGlowAdd = false;
  px._useWebGpu = webgpu;
  px._engineShaders = webgpu ? GPU_SHADERS : GL_SHADERS;
  if (webgpu) px.pixiApp = { renderer: { gpu: { device: { limits: { maxStorageBufferBindingSize: maxStorageBytes } } } } };
  px.renderQueueEnabled = true;
  px.renderQueueMaxItems = MAX;
  px.atlasScaleMode = 'linear';
  px._newQueueThisFrame = 1;
  px.lastReadFrame = 1;
  for (const b of [0, 1]) {
    const views = createViews(m.buffer, MAX, b ? m.layout.queueBByte : m.layout.queueAByte);
    px.renderQueueBuffers[b] = views;
    px._sortKeyU32ByBuf[b] = views.sortKeyU32;
    px.renderQueueCameraBuffers[b] = null;
    px.renderQueuePoseReadyBuffers[b] = null;
  }
  px.gpuQueueBuffers = [
    createGpuQueueViews(m.buffer, caps, m.layout.gpuAByte),
    createGpuQueueViews(m.buffer, caps, m.layout.gpuBByte),
  ];
  const log = { made: [], uploads: [], statics: 0, slots: 0 };
  px._gpuRecordTexture = () => ({
    maxSize: 16384,
    make(bits, width, height, label) {
      log.made.push({ bits, width, height, label });
      return new TextureSource({ width, height, label });
    },
    upload(source, bits, width, height, y0, rows) {
      log.uploads.push([y0, rows]);
    },
  });
  px.createEntitiesInstancedBatch(MAX);
  const batch = px.entitiesBatch;
  for (const buf of batch._buffers) buf.update = () => {};
  for (const buf of batch._staticBuffers) buf.update = () => { log.statics++; };
  if (batch._slotBuffers) for (const buf of batch._slotBuffers) buf.update = () => { log.slots++; };
  return log;
}

/**
 * One indexed frame in buffer b: n slots over `rows` queue rows, the slots in an order from `orderSeed` (the frame's by
 * default), their generation `slotsGen` (0: none), the poses moving every frame, the statics the generation's. Returns
 * what the batch should hold: the poses, the slots and the statics.
 */
function writeIndexedFrame(px, b, n, rows, gen, frame, slotsGen = 0, orderSeed = frame) {
  const g = px.gpuQueueBuffers[b];
  const key = (i) => (i * 7919 + orderSeed * 31) % rows;
  const order = Array.from({ length: rows }, (_, i) => i).sort((a, c) => key(a) - key(c));
  const pose = new Float32Array(n * GPU_POSE_FLOATS);
  const slots = new Float32Array(n * GPU_INDEXED_SLOT_FLOATS);
  const stat = new Float32Array(rows * GPU_INDEXED_STATIC_FLOATS);
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < GPU_POSE_FLOATS; j++) pose[k * GPU_POSE_FLOATS + j] = k * 4 + j + frame * 0.5;
    slots[k * GPU_INDEXED_SLOT_FLOATS] = order[k];
    slots[k * GPU_INDEXED_SLOT_FLOATS + 1] = 1 - (k + 1) / (MAX + 2);
  }
  for (let r = 0; r < rows; r++) {
    for (let j = 0; j < GPU_STATIC_FLOATS; j++) stat[r * GPU_INDEXED_STATIC_FLOATS + j] = r + j * 0.01 + gen * 100;
  }
  g.spritePose.set(pose);
  g.spriteSlots.set(slots);
  g.spriteRowStatics.set(stat);
  writeGpuQueueHeader(g.header, { sprite: n, staticGen: gen, indexedRows: rows, slotsGen: slotsGen | 0 }, GPU_FLAG_INDEXED);
  px.renderQueueBuffers[b].count[0] = rows;
  return { pose, slots, stat };
}

/** One split frame in buffer b. */
function writeSplitFrame(px, b, n, gen, frame) {
  const g = px.gpuQueueBuffers[b];
  const pose = new Float32Array(n * GPU_POSE_FLOATS).map((_, i) => i + frame);
  const stat = new Float32Array(n * GPU_STATIC_FLOATS).map((_, i) => i * 0.5 + gen);
  g.spritePose.set(pose);
  g.spriteStatic.set(stat);
  writeGpuQueueHeader(g.header, { sprite: n, staticGen: gen }, GPU_FLAG_SPLIT);
  px.renderQueueBuffers[b].count[0] = n;
  return { pose, stat };
}

const same = (a, b, n, what) => {
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) assert.fail(`${what}: word ${i}, ${a[i]} vs ${b[i]}`);
};

test('Pixi commits an indexed frame: the poses and slots every frame, the statics texture when their generation moves', async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const s = await quietly(() => scene(true));
  assert.equal(s.gpuQueueCaps.indexedSprites, true, 'the scene lays out indexed frames');
  const log = await quietly(() => bindPixi(px, s));
  const batch = px.entitiesBatch;
  assert.equal(batch.indexed, true, 'a split batch on WebGL with the texture helper takes indexed frames');
  assert.equal(log.made.length, 1, 'one statics texture');
  assert.deepEqual([log.made[0].width, log.made[0].height], [STATICS_TEX_ROW * STATICS_TEXELS_PER_ROW, Math.ceil(MAX / STATICS_TEX_ROW)]);
  assert.equal(log.made[0].bits, batch._rowStaticsU32, 'made from the batch\'s own copy of the statics');
  const splitShader = batch.shader;
  const indexedShader = batch._indexedShader;
  assert.notEqual(indexedShader, splitShader);
  assert.equal(indexedShader.resources.uStatics, batch._staticsSource);
  assert.equal(indexedShader.resources.uniforms, splitShader.resources.uniforms, 'one uniform group for both programs');
  // Each layout draws from geometries of its own (Pixi warns of a geometry attribute its program lacks), over the same
  // pose buffers.
  batch._indexedGeometries.forEach((geometry, r) => {
    assert.deepEqual(Object.keys(geometry.attributes).sort(), ['aInstRotCS', 'aInstSlot', 'aInstXY', 'aQuad']);
    assert.equal(geometry.attributes.aInstSlot.buffer, batch._slotBuffers[r]);
    assert.equal(geometry.attributes.aInstXY.buffer, batch._geometries[r].attributes.aInstXY.buffer);
    assert.equal(batch._geometries[r].attributes.aInstSlot, undefined);
  });

  // [slots, queue rows, generation]
  const frames = [[2500, 2600, 5], [2500, 2600, 5], [2400, 2600, 5], [2400, 2600, 6], [2400, 2500, 6], [2400, 2500, 6]];
  const sent = [];
  frames.forEach(([n, rows, gen], f) => {
    const b = f & 1;
    const want = writeIndexedFrame(px, b, n, rows, gen, f);
    px._setReadBuffer(b);
    const uploads = log.uploads.length;
    px.updateSpritesFromRenderQueue();
    assert.equal(px.visibleEntityCount, n, `frame ${f}: slots`);
    assert.equal(batch.mesh.shader, indexedShader, `frame ${f}: the indexed program`);
    assert.ok(batch._indexedGeometries.includes(batch.mesh.geometry), `frame ${f}: an indexed geometry`);
    assert.equal(batch.mesh.visible, true);
    assert.equal(batch.mesh.geometry.instanceCount, n);
    same(batch.data, want.pose, n * GPU_POSE_FLOATS, `frame ${f} pose`);
    same(batch._slotData, want.slots, n * GPU_INDEXED_SLOT_FLOATS, `frame ${f} slots`);
    same(batch._rowStatics, want.stat, rows * GPU_INDEXED_STATIC_FLOATS, `frame ${f} statics`);
    sent.push(log.uploads.slice(uploads));
  });
  // The texture rows the statics fill (1024 statics rows each), only when the generation or the rows moved.
  assert.deepEqual(sent, [[[0, 3]], [], [], [[0, 3]], [[0, 3]], []]);
  assert.equal(log.slots, frames.length, 'the slot stream every frame');
  assert.equal(log.statics, 0, 'no static stream');

  // A split frame between them: the split program, its own statics; then an indexed frame of the same generation sends
  // no statics again.
  const split = writeSplitFrame(px, 0, 2400, 6, 10);
  px._setReadBuffer(0);
  px.updateSpritesFromRenderQueue();
  assert.equal(px.visibleEntityCount, 2400);
  assert.equal(batch.mesh.shader, splitShader, 'a split frame: the split program');
  assert.ok(batch._geometries.includes(batch.mesh.geometry), 'a split geometry');
  same(batch.data, split.pose, 2400 * GPU_POSE_FLOATS, 'split pose');
  same(batch.staticData, split.stat, 2400 * GPU_STATIC_FLOATS, 'split statics');
  assert.equal(log.statics, 1, 'the split statics go up');
  const uploads = log.uploads.length;
  writeIndexedFrame(px, 1, 2400, 2500, 6, 11);
  px._setReadBuffer(1);
  px.updateSpritesFromRenderQueue();
  assert.equal(batch.mesh.shader, indexedShader, 'back to the indexed program');
  assert.equal(log.uploads.length, uploads, 'the texture holds this generation already');

  // The y-sort painter's chunks draw with the frame's program.
  const root = new Container();
  root.addChild(batch.mesh);
  const chunks = new EntityChunks({ batch, root });
  const half = { ints: new Int32Array(PROXY_ENTRY_WORDS * 2) };
  half.ints[PROXY.INDEX] = 1000;
  const marks = new Container();
  const draw = (w, out, k) => {
    out[k] = marks;
    return k + 1;
  };
  chunks.apply(half, 1, 2400, draw);
  const meshes = () => chunks.children.slice(0, chunks.count).filter((c) => c !== marks && c.alpha === 1);
  assert.equal(meshes().length, 2, 'two chunks around the entry');
  for (const m of meshes()) assert.equal(m.shader, indexedShader, 'an indexed frame\'s chunks');
  writeSplitFrame(px, 0, 2400, 6, 12);
  px._setReadBuffer(0);
  px.updateSpritesFromRenderQueue();
  chunks.apply(half, 1, 2400, draw);
  for (const m of meshes()) assert.equal(m.shader, splitShader, 'a split frame\'s chunks');
  chunks.destroy();
});

test('an entity batch without the statics texture refuses an indexed frame, and says why', async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const s = await quietly(() => scene(false));
  assert.equal(s.gpuQueueCaps.indexedSprites, false);
  const log = await quietly(() => bindPixi(px, s));
  assert.equal(px.entitiesBatch.indexed, false);
  assert.equal(log.made.length, 0, 'no statics texture');
  // The header alone: this queue has no room for an indexed frame's streams.
  writeGpuQueueHeader(px.gpuQueueBuffers[0].header, { sprite: 100, staticGen: 3, indexedRows: 100 }, GPU_FLAG_INDEXED);
  px.renderQueueBuffers[0].count[0] = 100;
  px._setReadBuffer(0);
  const errors = [];
  const error = console.error;
  console.error = (msg) => errors.push(String(msg));
  try {
    px.updateSpritesFromRenderQueue();
  } finally {
    console.error = error;
  }
  assert.equal(px.visibleEntityCount, 0);
  assert.equal(px.entitiesBatch.mesh.visible, false);
  assert.equal(errors.filter((e) => e.includes('an indexed frame for an entity batch that reads none')).length, 1);
});

test('on WebGPU the statics go to a storage buffer, sent when their generation or the rows move', async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const s = await quietly(() => scene(true));
  const log = await quietly(() => bindPixi(px, s, { webgpu: true }));
  const batch = px.entitiesBatch;
  assert.equal(batch.indexed, true, 'a split batch on WebGPU takes indexed frames');
  assert.equal(log.made.length, 0, 'no texture');
  const statics = batch._staticsSource;
  assert.ok((statics.descriptor.usage & BufferUsage.STORAGE) !== 0, 'a storage buffer');
  assert.equal(statics.data, batch._rowStatics, 'over the batch\'s own copy of the statics');
  assert.equal(batch._indexedShader.resources.uStatics, statics);
  assert.ok(batch._indexedShader.gpuProgram, 'a WGSL program');
  const sent = [];
  statics.update = (bytes) => sent.push(bytes);
  const frames = [[2500, 2600, 5], [2500, 2600, 5], [2400, 2500, 6], [2400, 2500, 6]];
  frames.forEach(([n, rows, gen], f) => {
    const b = f & 1;
    const want = writeIndexedFrame(px, b, n, rows, gen, f);
    px._setReadBuffer(b);
    px.updateSpritesFromRenderQueue();
    assert.equal(px.visibleEntityCount, n, `frame ${f}: slots`);
    assert.equal(batch.mesh.shader, batch._indexedShader, `frame ${f}: the indexed program`);
    assert.ok(batch._indexedGeometries.includes(batch.mesh.geometry), `frame ${f}: an indexed geometry`);
    same(batch._slotData, want.slots, n * GPU_INDEXED_SLOT_FLOATS, `frame ${f} slots`);
    same(batch._rowStatics, want.stat, rows * GPU_INDEXED_STATIC_FLOATS, `frame ${f} statics`);
  });
  assert.deepEqual(sent, [2600 * GPU_INDEXED_STATIC_FLOATS * 4, 2500 * GPU_INDEXED_STATIC_FLOATS * 4], 'the rows\' bytes, twice');
});

test('on WebGPU a device that cannot bind the statics stops the entity batch, saying why', async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const s = await quietly(() => scene(true));
  await assert.rejects(() => quietly(() => bindPixi(px, s, { webgpu: true, maxStorageBytes: 1024 })), /storage buffer of \d+ bytes/);
});

test('the slot pairs go up only when their generation or the slots move', async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const s = await quietly(() => scene(true));
  const log = await quietly(() => bindPixi(px, s));
  const batch = px.entitiesBatch;
  // [slots, queue rows, statics generation, slots generation, the order's seed]
  const frames = [
    [2500, 2600, 5, 0x80000001, 1], [2500, 2600, 5, 0x80000001, 1], [2500, 2600, 5, 0x80000001, 1],
    [2500, 2600, 6, 0x80000001, 1], [2500, 2600, 6, 0x80000002, 2], [2400, 2600, 6, 0x80000002, 2],
    [2400, 2600, 6, 0x80000002, 2], [2400, 2600, 6, 0, 2],
  ];
  const copies = [];
  const sent = [];
  frames.forEach(([n, rows, gen, slotsGen, seed], f) => {
    const b = f & 1;
    const want = writeIndexedFrame(px, b, n, rows, gen, f, slotsGen, seed);
    px._setReadBuffer(b);
    const version = batch._slotsVersion;
    const uploads = log.slots;
    px.updateSpritesFromRenderQueue();
    assert.equal(px.visibleEntityCount, n, `frame ${f}: slots`);
    same(batch.data, want.pose, n * GPU_POSE_FLOATS, `frame ${f} pose`);
    same(batch._slotData, want.slots, n * GPU_INDEXED_SLOT_FLOATS, `frame ${f} slots`);
    copies.push(batch._slotsVersion - version);
    sent.push(log.slots - uploads);
  });
  // A copy for a new generation, fewer slots or generation 0; a ring slot's buffer goes up when it lacks the copy.
  assert.deepEqual(copies, [1, 0, 0, 0, 1, 1, 0, 1]);
  assert.deepEqual(sent, [1, 1, 0, 0, 1, 1, 1, 1]);
});
