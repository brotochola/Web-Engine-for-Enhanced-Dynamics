// E-177, wired: Pixi's entity batch on a Predator-shaped scene (packGpuSprites and sortSprites 'pixi', WebGL), through
// updateSpritesFromRenderQueue. The scene lays out the keyed regions, Pixi's batch goes keyed with them, and every frame
// draws with the indexed program: each slot's pose is its queue row's in the painter's order, and its key's row of the
// statics texture, after the frame's scatter, holds that row's statics; rows without an entity take the slots past the
// entities. A frame changes few statics, so few go up. On WebGPU the batch stays split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TextureSource } from '../../src/vendor/pixi.min.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Query } from '../../src/core/query.js';
import { createViews } from '../../src/render/renderQueueLayout.js';
import { GPU_INDEXED_SLOT_FLOATS, GPU_INDEXED_STATIC_FLOATS, gpuIndexedStaticRows } from '../../src/render/gpuQueueLayout.js';
import { GPU_KEYED_KEY_WORD, GPU_KEYED_ROW_WORDS } from '../../src/render/gpuPackClient.js';
import { SPLIT_POSE_FLOATS } from '../../src/render/instancedSpriteBatch.js';
import { spriteYSortKey } from '../../src/util/sortIndexByKey.js';
import { WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';
import { loadWorker, quietly } from '../bench/workerHarness.mjs';

const MAX = 4000;
const ENTITIES = 9000;
const KEY_NONE = 0xffffffff;

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
Thing.components = [RigidBody, Collider, SpriteRenderer];

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

function pixiScene(backend) {
  Query.reset();
  const scene = {
    totalEntityCount: ENTITIES,
    nextComponentId: 4,
    registeredClasses: [{ class: Thing, count: ENTITIES, startIndex: 0, entityType: 0, components: Thing.components }],
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
      renderer: { maxVisibleRenderables: MAX, ySort: true, backend },
      preRender: { packGpuSprites: 'pixi', sortSprites: 'pixi' },
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
  createSceneSharedBuffers(scene);
  return scene;
}

/** Pixi bound to the scene's render queues as its init binds them; on WebGL a statics texture that keeps its texels. */
async function bindPixi(px, scene, webgpu) {
  const m = scene.renderQueueMemory;
  const data = { renderQueueMemory: m.memory, renderQueueLayout: m.layout };
  px.config = scene.config;
  px._ySort = true;
  px._packGpuSpritesOn = 'pixi';
  px._queueInterp = false;
  px._lightGlowAdd = false;
  px._useWebGpu = webgpu;
  px._engineShaders = webgpu ? GPU_SHADERS : GL_SHADERS;
  px.atlasScaleMode = 'linear';
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
  const tex = { made: [], texels: null, scattered: 0, uploads: 0 };
  px._gpuRecordTexture = () => ({
    maxSize: 16384,
    make(bits, width, height, label) {
      tex.made.push({ width, height, label });
      tex.texels = Uint32Array.from(bits.subarray(0, width * height * 4));
      return new TextureSource({ width, height, label });
    },
    upload(source, bits, width, height, y0, rows) {
      tex.texels.set(bits.subarray(y0 * width * 4, (y0 + rows) * width * 4), y0 * width * 4);
      tex.uploads++;
    },
    scatter(source, updates, count) {
      for (let u = 0; u < count; u++) {
        const at = u * GPU_KEYED_ROW_WORDS;
        tex.texels.set(updates.subarray(at, at + GPU_INDEXED_STATIC_FLOATS), updates[at + GPU_KEYED_KEY_WORD] * GPU_INDEXED_STATIC_FLOATS);
      }
      tex.scattered += count;
    },
  });
  await px._bindPixiGpuPack(data);
  await px._bindPainterRadix(data);
  px.createEntitiesInstancedBatch(MAX);
  const batch = px.entitiesBatch;
  for (const buf of [...batch._buffers, ...(batch._staticBuffers || []), ...(batch._slotBuffers || [])]) buf.update = () => {};
  px._bindPixiPackWriters();
  return tex;
}

const COLUMNS = ['x', 'y', 'scaleX', 'scaleY', 'rotC', 'rotS', 'alpha', 'tint', 'textureId', 'anchorX', 'anchorY', 'type', 'key', 'sortKey'];

/** The scene's sprites, row k entity 2k (a row in 17 a particle, without one): what pre-render writes either buffer. */
function makeWorld(r) {
  const w = {
    x: new Float32Array(MAX), y: new Float32Array(MAX), scaleX: new Float32Array(MAX), scaleY: new Float32Array(MAX),
    rotC: new Float32Array(MAX).fill(1), rotS: new Float32Array(MAX), alpha: new Float32Array(MAX), tint: new Uint32Array(MAX),
    textureId: new Uint16Array(MAX), anchorX: new Float32Array(MAX), anchorY: new Float32Array(MAX), type: new Uint8Array(MAX),
    key: new Uint32Array(MAX), sortKey: new Float32Array(MAX),
  };
  for (let k = 0; k < MAX; k++) {
    w.type[k] = k % 17 === 0 ? 1 : 0;
    w.key[k] = w.type[k] === 1 ? KEY_NONE : k * 2;
    w.x[k] = r() * 4000;
    w.y[k] = r() * 4000;
    w.sortKey[k] = spriteYSortKey(w.y[k], 128);
    restyle(w, k, r);
  }
  return w;
}

function restyle(w, k, r) {
  w.scaleX[k] = 0.5 + r();
  w.scaleY[k] = 0.5 + r();
  w.alpha[k] = r();
  w.tint[k] = (r() * 0xffffff) >>> 0;
  w.textureId[k] = (r() * 64) | 0;
  w.anchorX[k] = r();
  w.anchorY[k] = r();
}

/** A frame: every sprite moves, a twentieth change a static; its first n rows go into queue buffer q. */
function writeQueue(q, w, n, r) {
  for (let k = 0; k < MAX; k++) {
    w.x[k] += 1;
    if (r() < 0.05) restyle(w, k, r);
  }
  q.count[0] = n;
  for (const c of COLUMNS) q[c].set(w[c].subarray(0, n));
}

/**
 * What pre-render's emit does after writing the queue (preRenderEmit.c key_store): each sprite's statics into its
 * entity's row of the store, a change rung, the head stored after the frame's pushes.
 */
function emitStore(m, q, n, st) {
  const L = m.layout.emit;
  const store = new Uint32Array(m.buffer, L.keyStoreByte, ENTITIES * 12);
  const ring = new Uint32Array(m.buffer, L.keyRingByte, L.keyRingEntries);
  for (let i = 0; i < n; i++) {
    const e = q.key[i];
    if (e >= ENTITIES) continue;
    const row = rowStatics(q, i);
    let same = true;
    for (let j = 0; j < 12; j++) if (store[e * 12 + j] !== row[j]) same = false;
    if (same) continue;
    store.set(row, e * 12);
    ring[st.head & (L.keyRingEntries - 1)] = e;
    st.head = (st.head + 1) >>> 0;
  }
  Atomics.store(new Uint32Array(m.buffer, L.keyRingHeadByte, 1), 0, st.head);
}

/** The statics words gpuPack.c sprite_static writes for queue row i, in the indexed layout (depth 0, a zero). */
function rowStatics(q, i) {
  const f = new Float32Array(GPU_INDEXED_STATIC_FLOATS);
  const u = new Uint32Array(f.buffer);
  f[0] = q.scaleX[i];
  f[1] = q.scaleY[i];
  f[2] = q.anchorX[i];
  f[3] = q.anchorY[i];
  let a = q.alpha[i];
  if (!(a >= 0)) a = 0;
  else if (a > 1) a = 1;
  u[5] = ((((a * 255 + 0.5) | 0) & 255) << 24 | (q.tint[i] & 0xffffff)) >>> 0;
  f[6] = q.textureId[i];
  f[7] = q.tileMulX[i];
  f[8] = q.tileMulY[i];
  f[9] = q.tileOffsetU[i] * (1 / 65535);
  f[10] = q.tileOffsetV[i] * (1 / 65535);
  return u;
}

test('Pixi draws a WebGL scene\'s sprites as keyed frames: poses in the painter\'s order, statics by key', async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const scene = await quietly(() => pixiScene('webgl'));
  const layout = scene.renderQueueMemory.layout;
  assert.equal(layout.pixiKeyBase, ENTITIES, 'the scene lays out the keyed regions');
  assert.equal(layout.pixiKeyRows, gpuIndexedStaticRows(ENTITIES + MAX));
  const tex = await quietly(() => bindPixi(px, scene, false));
  const batch = px.entitiesBatch;
  assert.equal(batch.keyed, true, 'the entity batch goes keyed');
  assert.equal(tex.made.length, 1, 'one statics texture');
  assert.equal(tex.made[0].height, layout.pixiKeyRows / 1024, 'a row for every key');
  let order = null;
  px._pixiEntityPack.afterSprites = (n, idx) => {
    order = idx ? Uint32Array.from(idx.subarray(0, n)) : null;
  };
  const r = rng(177);
  const world = makeWorld(r);
  const scattered = [];
  const emit = { head: 0 };
  for (let f = 0; f < 8; f++) {
    const b = f & 1;
    const q = px.renderQueueBuffers[b];
    writeQueue(q, world, f < 6 ? MAX - 100 : MAX - 300, r);
    emitStore(scene.renderQueueMemory, q, q.count[0], emit);
    px._setReadBuffer(b);
    const before = tex.scattered;
    px.updateSpritesFromRenderQueue();
    scattered.push(tex.scattered - before);
    const n = px.visibleEntityCount | 0;
    assert.equal(n, q.count[0], `frame ${f}: every row drawn`);
    assert.equal(batch.mesh.shader, batch._indexedShader, `frame ${f}: the indexed program`);
    assert.ok(order && order.length === n, `frame ${f}: the painter's order`);
    const taken = new Set();
    for (let k = 0; k < n; k++) {
      const i = order[k];
      if (batch.data[k * SPLIT_POSE_FLOATS] !== q.x[i] || batch.data[k * SPLIT_POSE_FLOATS + 1] !== q.y[i]) {
        assert.fail(`frame ${f}: slot ${k}'s pose is not row ${i}'s`);
      }
      const row = batch._slotData[k * GPU_INDEXED_SLOT_FLOATS];
      const key = q.key[i];
      if (key !== KEY_NONE && row !== key) assert.fail(`frame ${f}: slot ${k} takes row ${row}, its key is ${key}`);
      if (key === KEY_NONE && row !== ENTITIES + k) assert.fail(`frame ${f}: a row without a key takes ${row}`);
      assert.ok(!taken.has(row));
      taken.add(row);
      const want = rowStatics(q, i);
      for (let j = 0; j < GPU_INDEXED_STATIC_FLOATS; j++) {
        if (tex.texels[row * GPU_INDEXED_STATIC_FLOATS + j] !== want[j]) assert.fail(`frame ${f}: slot ${k} static ${j}`);
      }
    }
  }
  // The first frame sends the whole store; every frame scatters the rows without a key and the sprites whose statics
  // changed (a twentieth).
  assert.equal(tex.uploads, 1, 'the store went up once');
  for (let f = 1; f < 8; f++) assert.ok(scattered[f] < MAX / 5, `frame ${f}: ${scattered[f]} scattered`);
});

test('on WebGPU the entity batch stays split', async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const scene = await quietly(() => pixiScene('webgpu'));
  assert.equal(scene.renderQueueMemory.layout.pixiKeyRows, 0, 'no keyed regions');
  px.pixiApp = { renderer: { gpu: { device: { limits: { maxStorageBufferBindingSize: 1 << 27 } } } } };
  await quietly(() => bindPixi(px, scene, true));
  assert.equal(px.entitiesBatch.keyed, false);
  assert.equal(px.entitiesBatch.split, true);
});
