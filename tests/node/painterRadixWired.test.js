// E-76 W10, wired: the painter sort through the workers' real paths, two ways each: the switch off (no painter
// regions: the JS sort on arrays of the worker's own) and the kernel (painterRadix.wasm on the worker's painter
// state in the render-queue memory, the slot lists there too).
// - Pre-render (sortSprites 'preRender', the painter stress scenes): packSpriteAndShadowQueues on queues it
//   writes in the memory, A and B in turn, with the pack kernel (gpuPack.wasm) on both runs.
// - Pixi (sortSprites 'pixi', Predator): updateSpritesFromRenderQueue on the same queues, with its own sprite
//   rows in the memory (W9d) and the glow rows split into their batch.
// The frames walk every way the order is made: the first rebuild, keys that move (reinsert, a few slots to
// most), ties, keys above the world origin, runs of one key (an Adobe character's pieces), a count change and a
// type change at the same count (rebuilds), a frame with every key the same, one with two rows. Every frame the
// sprite order, the glow order, and the rows each batch would upload must be the same, word for word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Query } from '../../src/core/query.js';
import { computeBufferSize, createViews, RENDER_QUEUE_CAMERA_BYTES } from '../../src/render/renderQueueLayout.js';
import {
  computeGpuQueueBufferSize, GPU_FLAG_SORTED, GPU_HDR_FLAGS, GPU_HDR_GLOW, GPU_HDR_SPRITE, GPU_SPRITE_FLOATS, gpuQueueCaps,
} from '../../src/render/gpuQueueLayout.js';
import { INSTANCED_SPRITE_FLOATS, POSE_STATIC_FLOATS, SPLIT_POSE_FLOATS } from '../../src/render/instancedSpriteBatch.js';
import { radixSortIndicesBySortKey, spriteYSortKey } from '../../src/util/sortIndexByKey.js';
import { WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createRenderQueueMemory } from '../../src/util/renderQueueMemory.js';
import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';
import { coreComponentData, initWorker, loadWorker, quietly } from '../bench/workerHarness.mjs';

const MAX = 6000;
const FRAMES = 36;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The frames both runs draw: each a queue of `n` rows (pose, type, sort key). */
function makeFrames(seed) {
  const r = rng(seed);
  const baseY = new Float64Array(MAX);
  for (let i = 0; i < MAX; i++) baseY[i] = r() * 4000 - 600;
  const y = Float64Array.from(baseY);
  const frames = [];
  for (let f = 0; f < FRAMES; f++) {
    // The row count changes now and then (a rebuild), and once to two rows; the type mix shifts at frame 20.
    const n = f === 30 ? 2 : f < 8 ? 5200 : f < 16 ? MAX : 5900;
    const glowEvery = f < 20 ? 11 : 13;
    // Who moves: none (frame 1), a few, most; frame 24 sends every key to one value, frame 25 back.
    const share = f === 1 ? 0 : f % 5 === 0 ? 0.6 : f % 3 === 0 ? 0.002 : 0.08;
    for (let i = 0; i < MAX; i++) if (r() < share) y[i] = baseY[i] + (r() * 2 - 1) * 40;
    const x = new Float32Array(n);
    const yy = new Float32Array(n);
    const type = new Uint8Array(n);
    const key = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = (i % 97) * 30 + r() * 4;
      yy[i] = y[i];
      type[i] = i % glowEvery === 0 ? 3 : i % 7 === 0 ? 1 : 0;
      key[i] = spriteYSortKey(y[i], 128);
    }
    // Runs: from frame 10, slots 3000-3999 come in runs of 8 under one key (Adobe pieces).
    if (f >= 10 && n > 4000) for (let i = 3000; i < 4000; i++) key[i] = key[i & ~7];
    // Ties onto other rows' keys.
    for (let k = 0; k < 40; k++) key[(r() * n) | 0] = key[(r() * n) | 0];
    if (f === 24) key.fill(256 * 128);
    frames.push({ n, x, y: yy, type, key });
  }
  return frames;
}

/** The frame's rows into queue `q`; with `order`, row k is the frame's row order[k] (E-138's presorted queue). */
function writeQueue(q, fr, order = null) {
  const n = fr.n;
  q.count[0] = n;
  for (let k = 0; k < n; k++) {
    const i = order ? order[k] : k;
    q.x[k] = fr.x[i];
    q.y[k] = fr.y[i];
    q.scaleX[k] = 1 + (i % 3) * 0.25;
    q.scaleY[k] = 1;
    q.rotC[k] = 1;
    q.rotS[k] = 0;
    q.alpha[k] = 1;
    q.tint[k] = 0xffffff;
    q.textureId[k] = i % 5;
    q.anchorX[k] = 0.5;
    q.anchorY[k] = 0.5;
    q.type[k] = fr.type[i];
    q.sortKey[k] = fr.key[i];
  }
}

const copyU32 = (view, words) => (view ? Uint32Array.from(new Uint32Array(view.buffer, view.byteOffset, words)) : new Uint32Array(0));

function firstDiff(a, b) {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function sameFrames(off, on, label) {
  assert.equal(on.length, off.length);
  let sorted = 0;
  for (let f = 0; f < off.length; f++) {
    for (const part of ['sprites', 'glow', 'spriteOrder', 'glowOrder']) {
      const at = firstDiff(on[f][part], off[f][part]);
      assert.equal(at, -1, `${label} frame ${f}: ${part} differ at word ${at} (${on[f][part].length} vs ${off[f][part].length} words)`);
    }
    if (off[f].spriteOrder.length > 1) sorted++;
  }
  assert.ok(sorted >= FRAMES - 2, `${label}: ${sorted} frames sorted`);
}

/** Count the kernel's calls on a painter state (rebuilds, reinserts, radixes). */
function countKernel(state) {
  const k = state.kernel;
  const calls = { order: 0, reinsert: 0, radix: 0 };
  state.kernel = {
    ...k,
    painterOrder: (...a) => (calls.order++, k.painterOrder(...a)),
    reinsert: (...a) => (calls.reinsert++, k.reinsert(...a)),
    radix: (...a) => (calls.radix++, k.radix(...a)),
  };
  return calls;
}

// ---- pre-render ----

async function preRenderRun(pre, frames, painterRadix) {
  const caps = gpuQueueCaps(MAX, { enabled: true });
  const m = createRenderQueueMemory(MAX, computeBufferSize(MAX), computeGpuQueueBufferSize(caps), null, null, null, false, null,
    painterRadix ? { preRender: true, pixi: false } : null);
  await initWorker(pre, {
    config: {
      worldWidth: 4000,
      worldHeight: 4000,
      renderer: { ySort: true },
      preRender: { packGpuSprites: 'preRender', sortSprites: 'preRender' },
      lighting: { enabled: false },
      wasm: { ...WASM_DEFAULTS, painterRadix },
    },
    globalEntityCount: 64,
    buffers: { componentData: coreComponentData(64) },
    extra: {
      renderQueueMemory: m.memory,
      renderQueueLayout: m.layout,
      renderQueue: {
        maxItems: MAX,
        sync: new SharedArrayBuffer(8),
        dataA: m.buffer,
        dataAByte: m.layout.queueAByte,
        dataB: m.buffer,
        dataBByte: m.layout.queueBByte,
        cameraA: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
        cameraB: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
      },
      gpuQueue: { dataA: m.buffer, dataB: m.buffer, dataAByte: m.layout.gpuAByte, dataBByte: m.layout.gpuBByte, caps },
    },
  });
  const painter = pre._gpuPainter;
  assert.ok(painter, 'pre-render has its painter');
  assert.ok(pre._gpuPackWasm, 'both runs pack through gpuPack.wasm');
  let calls = null;
  if (painterRadix) {
    assert.ok(painter.kernel, 'the kernel sorts');
    assert.equal(painter.order.buffer, m.buffer, 'the state is in the memory');
    assert.equal(painter.order.byteOffset, m.layout.preRenderPainter.orderByte);
    assert.equal(pre._gpuIdxEntity.buffer, m.buffer, 'the slot lists too');
    assert.equal(pre._gpuIdxEntity.byteOffset, m.layout.preRenderPainter.idxEntityByte);
    assert.equal(pre._gpuIdxGlow.byteOffset, m.layout.preRenderPainter.idxGlowByte);
    calls = countKernel(painter);
  } else {
    assert.equal(m.layout.preRenderPainter, null, 'switched off: no painter regions');
    assert.equal(painter.kernel, null, 'the JS sorts');
    assert.ok(!(painter.order.buffer instanceof SharedArrayBuffer), 'on arrays of its own');
    assert.ok(!(pre._gpuIdxEntity.buffer instanceof SharedArrayBuffer));
  }
  pre._bindGpuPackWriters();
  let spriteOrder = null;
  let glowOrder = null;
  pre._gpuPackSpec.afterSprites = (n, idx) => {
    spriteOrder = idx ? Uint32Array.from(idx.subarray(0, n)) : new Uint32Array(0);
  };
  pre._gpuPackSpec.afterGlow = (n, idx) => {
    glowOrder = idx ? Uint32Array.from(idx.subarray(0, n)) : new Uint32Array(0);
  };
  const out = [];
  for (const fr of frames) {
    pre.selectWriteBuffers();
    writeQueue(pre.renderQueueBuffers[pre._queueBuf], fr);
    pre._emitWriteCount = 0;
    spriteOrder = new Uint32Array(0);
    glowOrder = new Uint32Array(0);
    pre.packSpriteAndShadowQueues();
    const dst = pre.gpuQueueBuffers[pre._queueBuf];
    const nS = dst.header[GPU_HDR_SPRITE] | 0;
    const nG = dst.header[GPU_HDR_GLOW] | 0;
    out.push({
      sprites: copyU32(dst.sprites, nS * GPU_SPRITE_FLOATS),
      glow: copyU32(dst.glow, nG * GPU_SPRITE_FLOATS),
      spriteOrder,
      glowOrder,
    });
    pre.publishFrame();
  }
  return { out, calls };
}

// E-138: a queue already in painter order (the collector sorted before the emit) is packed as it is, with no painter,
// to the rows the painter's full sort packs from the same queue in emit order (the painter rebuilt every frame: its
// reinsert of moved keys puts them after the unmoved ones among equal keys, which a stable sort does not), the glow
// rows split and in order too, and the frame says it is sorted. Every frame of makeFrames: rebuilds, runs of one key,
// ties, every key the same, two rows. Then the same frames with no glow rows: the presorted queue packs every row with
// no slot list (nothing to split out), to the same rows.
test('E-138: pre-render packs a presorted queue as it is, to the rows the painter packs from the queue in emit order', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const frames = makeFrames(0xe138);
  const caps = gpuQueueCaps(MAX, { enabled: true });
  const m = createRenderQueueMemory(MAX, computeBufferSize(MAX), computeGpuQueueBufferSize(caps), null, null, null, false, null,
    { preRender: true, pixi: false });
  await initWorker(pre, {
    config: {
      worldWidth: 4000,
      worldHeight: 4000,
      renderer: { ySort: true },
      preRender: { packGpuSprites: 'preRender', sortSprites: 'preRender' },
      lighting: { enabled: false },
      wasm: { ...WASM_DEFAULTS },
    },
    globalEntityCount: 64,
    buffers: { componentData: coreComponentData(64) },
    extra: {
      renderQueueMemory: m.memory,
      renderQueueLayout: m.layout,
      renderQueue: {
        maxItems: MAX,
        sync: new SharedArrayBuffer(8),
        dataA: m.buffer,
        dataAByte: m.layout.queueAByte,
        dataB: m.buffer,
        dataBByte: m.layout.queueBByte,
        cameraA: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
        cameraB: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
      },
      gpuQueue: { dataA: m.buffer, dataB: m.buffer, dataAByte: m.layout.gpuAByte, dataBByte: m.layout.gpuBByte, caps },
    },
  });
  const painter = pre._gpuPainter;
  assert.ok(painter && painter.kernel && pre._gpuPackWasm, 'the painter and the pack in WASM');
  let listed = null;
  pre._bindGpuPackWriters();
  pre._gpuPackSpec.afterSprites = (n, idx) => {
    listed = idx !== null && idx !== undefined;
  };
  const pack = (fr, order) => {
    writeQueue(pre.renderQueueBuffers[pre._queueBuf], fr, order);
    pre._emitWriteCount = 0;
    pre._queuePresorted = order !== null;
    pre._presortGlowRows = fr.type.reduce((n, t) => n + (t === 3 ? 1 : 0), 0);
    painter.ready = false;
    pre.packSpriteAndShadowQueues();
    pre._queuePresorted = false;
    const dst = pre.gpuQueueBuffers[pre._queueBuf];
    const nS = dst.header[GPU_HDR_SPRITE] | 0;
    const nG = dst.header[GPU_HDR_GLOW] | 0;
    return {
      sprites: copyU32(dst.sprites, nS * GPU_SPRITE_FLOATS),
      pose: copyU32(dst.spritePose, nS * SPLIT_POSE_FLOATS),
      statics: copyU32(dst.spriteStatic, nS * POSE_STATIC_FLOATS),
      glow: copyU32(dst.glow, nG * GPU_SPRITE_FLOATS),
      counts: [nS, nG],
      sorted: (dst.header[GPU_HDR_FLAGS] & GPU_FLAG_SORTED) !== 0,
      listed,
    };
  };
  let moved = 0;
  frames.forEach((fr, f) => {
    pre.selectWriteBuffers();
    const want = pack(fr, null);
    const order = Uint32Array.from({ length: fr.n }, (_, i) => i);
    radixSortIndicesBySortKey(order, fr.n, new Uint32Array(fr.key.buffer), new Uint32Array(fr.n), new Uint32Array(256));
    for (let k = 0; k < fr.n; k++) if (order[k] !== k) moved++;
    const got = pack(fr, order);
    assert.deepEqual(got.counts, want.counts, `frame ${f}: rows`);
    for (const part of ['sprites', 'pose', 'statics', 'glow']) {
      const at = firstDiff(got[part], want[part]);
      assert.equal(at, -1, `frame ${f}: ${part} differ at word ${at}`);
    }
    // Sorted, always (the painter leaves the flag off under two sprite rows: frame 30's one, and a glow).
    assert.ok(got.sorted, `frame ${f}: sorted`);
    pre.publishFrame();
  });
  assert.ok(moved > FRAMES * 1000, `the frames were out of order (${moved} rows moved)`);

  // No glow rows: the presorted frames pack with no list, to the painter's rows.
  frames.forEach((fr0, f) => {
    const fr = { ...fr0, type: fr0.type.map((t) => (t === 3 ? 0 : t)) };
    pre.selectWriteBuffers();
    const want = pack(fr, null);
    const order = Uint32Array.from({ length: fr.n }, (_, i) => i);
    radixSortIndicesBySortKey(order, fr.n, new Uint32Array(fr.key.buffer), new Uint32Array(fr.n), new Uint32Array(256));
    const got = pack(fr, order);
    assert.deepEqual(got.counts, want.counts, `no glows, frame ${f}: rows`);
    assert.equal(got.counts[1], 0, `no glows, frame ${f}: no glow rows`);
    for (const part of ['sprites', 'pose', 'statics']) {
      const at = firstDiff(got[part], want[part]);
      assert.equal(at, -1, `no glows, frame ${f}: ${part} differ at word ${at}`);
    }
    if (fr.n > 1) assert.equal(got.listed, false, `no glows, frame ${f}: packed with no slot list`);
    assert.ok(got.sorted, `no glows, frame ${f}: sorted`);
    pre.publishFrame();
  });
});

test('pre-render packs the same rows in the same order with the switch off and through the kernel', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const frames = makeFrames(0x9a17);
  const off = await preRenderRun(pre, frames, false);
  const on = await preRenderRun(pre, frames, true);
  sameFrames(off.out, on.out, 'pre-render');
  assert.ok(on.calls.order >= 4, `the kernel rebuilt ${on.calls.order} times`);
  assert.ok(on.calls.reinsert >= 20, `and reinserted ${on.calls.reinsert} times`);
  assert.ok(on.calls.radix >= FRAMES - 2, `and sorted the glow rows ${on.calls.radix} times`);
  assert.ok(off.out[5].glowOrder.length > 300, 'the glow rows are split and sorted');
});

// ---- Pixi ----

// Pixi runs on the WebGPU program path, which builds in Node (the GL one probes a canvas); with no renderer,
// its uploads stop before the GPU.
const shaderDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/shaders');
const readShader = (f) => fs.readFileSync(path.join(shaderDir, f), 'utf8');
const GPU_SHADERS = {
  sprite: readShader('instancedSprite.wgsl'),
  spritePose: readShader('instancedSpritePose.wgsl'),
};

class Thing extends GameObject {}
Thing.components = [RigidBody, Collider, SpriteRenderer];

/** The main thread's buffers for a Predator-shaped pipeline: Pixi packs and sorts (W9d, W10). */
function pixiScene(painterRadix) {
  Query.reset();
  const scene = {
    totalEntityCount: 64,
    nextComponentId: 4,
    registeredClasses: [{ class: Thing, count: 64, startIndex: 0, entityType: 0, components: Thing.components }],
    componentPools: {
      Transform: { ComponentClass: Transform },
      RigidBody: { ComponentClass: RigidBody },
      Collider: { ComponentClass: Collider },
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
      renderer: { maxVisibleRenderables: MAX, ySort: true },
      preRender: { packGpuSprites: 'pixi', sortSprites: 'pixi' },
      layers: {},
      wasm: { ...WASM_DEFAULTS, painterRadix },
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
  createSceneSharedBuffers(scene);
  return scene;
}

/** Pixi bound to the scene's render queues as its init binds them, its ENTITIES batches made by its own code. */
async function bindPixi(px, scene) {
  const m = scene.renderQueueMemory;
  const data = { renderQueueMemory: m.memory, renderQueueLayout: m.layout };
  px.config = scene.config;
  px._ySort = true;
  px._packGpuSpritesOn = 'pixi';
  px._queueInterp = false;
  px._lightGlowAdd = true;
  px._useWebGpu = true;
  px._engineShaders = GPU_SHADERS;
  px.renderQueueEnabled = true;
  px.renderQueueMaxItems = MAX;
  px.gpuQueueBuffers = null;
  for (const b of [0, 1]) {
    const views = createViews(m.buffer, MAX, b ? m.layout.queueBByte : m.layout.queueAByte);
    px.renderQueueBuffers[b] = views;
    px._sortKeyU32ByBuf[b] = views.sortKeyU32;
    px.renderQueueCameraBuffers[b] = null;
    px.renderQueuePoseReadyBuffers[b] = null;
  }
  await px._bindPixiGpuPack(data);
  await px._bindPainterRadix(data);
  px.createEntitiesInstancedBatch(MAX);
  for (const batch of [px.entitiesBatch, px.entitiesGlowBatch]) for (const buf of batch._buffers) buf.update = () => {};
}

async function pixiRun(px, frames, painterRadix) {
  const scene = await quietly(() => pixiScene(painterRadix));
  const layout = scene.renderQueueMemory.layout;
  await quietly(() => bindPixi(px, scene));
  assert.ok(px._pixiGpuPack, 'both runs pack the sprite rows through gpuPack.wasm (W9d)');
  const painter = px._painter;
  assert.ok(px._rqIdxEntity instanceof Uint32Array && px._rqIdxGlow instanceof Uint32Array, 'u32 slot lists');
  let calls = null;
  if (painterRadix) {
    assert.ok(px._painterWasm && painter.kernel, 'the kernel sorts');
    assert.equal(painter.order.buffer, scene.renderQueueMemory.buffer, 'the state is in the memory');
    assert.equal(painter.order.byteOffset, layout.pixiPainter.orderByte);
    assert.equal(px._rqIdxEntity.byteOffset, layout.pixiPainter.idxEntityByte, 'the slot lists too');
    assert.equal(px._rqIdxGlow.byteOffset, layout.pixiPainter.idxGlowByte);
    calls = countKernel(painter);
  } else {
    assert.equal(layout.pixiPainter, null, 'switched off: no painter regions');
    assert.equal(painter.kernel, null, 'the JS sorts');
    assert.ok(!(px._rqIdxEntity.buffer instanceof SharedArrayBuffer), 'on lists of its own');
  }
  // E-123: what the batches upload are arrays of their own.
  assert.ok(!(px.entitiesBatch.data.buffer instanceof SharedArrayBuffer));
  px._bindPixiPackWriters();
  let spriteOrder = null;
  let glowOrder = null;
  px._pixiEntityPack.afterSprites = (n, idx) => {
    spriteOrder = idx ? Uint32Array.from(idx.subarray(0, n)) : new Uint32Array(0);
  };
  px._pixiEntityPack.afterGlow = (n, idx) => {
    glowOrder = idx ? Uint32Array.from(idx.subarray(0, n)) : new Uint32Array(0);
  };
  const out = [];
  frames.forEach((fr, f) => {
    const b = f & 1;
    writeQueue(px.renderQueueBuffers[b], fr);
    px._setReadBuffer(b);
    spriteOrder = new Uint32Array(0);
    glowOrder = new Uint32Array(0);
    px.updateSpritesFromRenderQueue();
    const nS = px.visibleEntityCount | 0;
    const nG = glowOrder.length;
    // A split batch (E-82b, wasm.gpuPackSplit) holds the rows as its pose stream and its static stream.
    const batch = px.entitiesBatch;
    const sprites = batch.split
      ? Uint32Array.from([...copyU32(batch.data, nS * SPLIT_POSE_FLOATS), ...copyU32(batch.staticData, nS * POSE_STATIC_FLOATS)])
      : copyU32(batch.data, nS * INSTANCED_SPRITE_FLOATS);
    out.push({
      sprites,
      glow: copyU32(px.entitiesGlowBatch.data, nG * INSTANCED_SPRITE_FLOATS),
      spriteOrder,
      glowOrder,
    });
  });
  return { out, calls };
}

test('Pixi uploads the same rows in the same order with the switch off and through the kernel', async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const frames = makeFrames(0x51c0);
  const off = await pixiRun(px, frames, false);
  const on = await pixiRun(px, frames, true);
  sameFrames(off.out, on.out, 'Pixi');
  assert.ok(on.calls.order >= 4, `the kernel rebuilt ${on.calls.order} times`);
  assert.ok(on.calls.reinsert >= 20, `and reinserted ${on.calls.reinsert} times`);
  assert.ok(on.calls.radix >= FRAMES - 2, `and sorted the glow rows ${on.calls.radix} times`);
  assert.ok(off.out[5].glowOrder.length > 300, 'the glow rows are split and sorted');
});
