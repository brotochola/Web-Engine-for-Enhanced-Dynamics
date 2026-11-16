// E-387, wired: Pixi's entity batch on a scene whose SpriteRenderer and ShadowCaster live in the render-queue memory
// (packGpuSprites and sortSprites 'pixi', a lighting config that asks for the G-buffer), through
// updateSpritesFromRenderQueue. A frame drawn keyed takes each instance's G-buffer words from the keyed pack (the columns
// _writeEntitySprites hands the batch); a frame drawn split writes them in JavaScript as before (gbufWord.js
// writeGbufWords); either way they are writeGbufWords' words for the frame's rows in the painter's order, bit for bit,
// with zIndex bands while a sprite has a zIndex. On WebGL, by pose and by queue row, and on WebGPU.
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
import { ShadowCaster } from '../../src/components/shadowCaster.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Query } from '../../src/core/query.js';
import { createViews } from '../../src/render/renderQueueLayout.js';
import { GPU_GBUF_FLOATS } from '../../src/render/gpuQueueLayout.js';
import { GPU_KEYED_CHANGED } from '../../src/render/gpuPackClient.js';
import { writeGbufWords } from '../../src/render/gbufWord.js';
import { spriteYSortKey } from '../../src/util/sortIndexByKey.js';
import { WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';
import { PIXI_KEYED_HEADER as H, PIXI_KEYED_HEADER_WORDS } from '../../src/util/wasmMemoryMap.js';
import { loadWorker, quietly } from '../bench/workerHarness.mjs';

const MAX = 3000;
const ENTITIES = 7000;
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
Thing.components = [RigidBody, Collider, SpriteRenderer, ShadowCaster];

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
    nextComponentId: 5,
    registeredClasses: [{ class: Thing, count: ENTITIES, startIndex: 0, entityType: 0, components: Thing.components }],
    componentPools: {
      Transform: { ComponentClass: Transform },
      RigidBody: { ComponentClass: RigidBody },
      Collider: { ComponentClass: Collider },
      SpriteRenderer: { ComponentClass: SpriteRenderer },
      ShadowCaster: { ComponentClass: ShadowCaster },
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

/** Pixi bound as its init binds it, its config's lighting asking for the G-buffer (gbufWanted: emissive sprites). */
async function bindPixi(px, scene, webgpu, byRow) {
  const m = scene.renderQueueMemory;
  const data = { renderQueueMemory: m.memory, renderQueueLayout: m.layout };
  px.config = { ...scene.config, lighting: { ...scene.config.lighting, enabled: true, emissive: true } };
  px._ySort = true;
  px._packGpuSpritesOn = 'pixi';
  px._queueInterp = false;
  px._lightGlowAdd = false;
  px._useWebGpu = webgpu;
  px._keyedPosesByRow = byRow;
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
  // A statics helper that keeps nothing: this test reads the words alone.
  px._gpuRecordTexture = () => ({
    maxSize: 16384,
    make: (bits, width, height, label) => new TextureSource({ width, height, label }),
    upload() {},
    scatter() {},
  });
  if (webgpu) {
    px.pixiApp = { renderer: { gpu: { device: { limits: { maxStorageBufferBindingSize: 1 << 27 } } } } };
    px._scatterStaticsGpu = () => {};
  }
  await px._bindPixiGpuPack(data);
  await px._bindPainterRadix(data);
  px.createEntitiesInstancedBatch(MAX);
  const batch = px.entitiesBatch;
  for (const x of [...batch._buffers, ...(batch._staticBuffers || []), ...(batch._slotBuffers || []), ...(batch._gbufBuffers || [])]) {
    x.update = () => {};
  }
  px._bindPixiPackWriters();
}

const COLUMNS = ['x', 'y', 'scaleX', 'scaleY', 'rotC', 'rotS', 'alpha', 'tint', 'textureId', 'anchorX', 'anchorY', 'type', 'key', 'sortKey'];

/**
 * Queue frame `frame`'s first n rows as the emit writes them: row k entity 2k (a row in 17 a particle, without a key),
 * every sprite moved, every key marked when the frame's marks count from no frame (E-312). Returns the buffer.
 */
function emitFrame(px, m, w, frame, n) {
  for (let k = 0; k < MAX; k++) {
    w.x[k] += 1;
    w.sortKey[k] = spriteYSortKey(w.y[k], 128);
  }
  const h = new Uint32Array(m.buffer, m.layout.emit.keyHeaderByte, PIXI_KEYED_HEADER_WORDS);
  const drawn = Atomics.load(h, H.DRAWN);
  const since = drawn < frame ? drawn : 0;
  const b = (frame - 1) & 1;
  const q = px.renderQueueBuffers[b];
  q.count[0] = n;
  for (const c of COLUMNS) q[c].set(w[c].subarray(0, n));
  if (since === 0) for (let k = 0; k < n; k++) if (w.key[k] !== KEY_NONE) q.key[k] = (w.key[k] | GPU_KEYED_CHANGED) >>> 0;
  Atomics.store(h, H.SINCE0 + b, since);
  return { b, h };
}

/** The committed words against writeGbufWords' for the same rows, bit for bit; the entity rows and the top band. */
function assertWords(label, got, n, order, keys, flags, self, z) {
  const want = new Float32Array(n * GPU_GBUF_FLOATS);
  writeGbufWords(want, n, order, null, null, keys, flags.length, flags, self, z);
  const g = new Uint32Array(got.buffer, got.byteOffset, n * GPU_GBUF_FLOATS);
  const w = new Uint32Array(want.buffer, 0, n * GPU_GBUF_FLOATS);
  for (let i = 0; i < w.length; i++) {
    if (g[i] !== w[i]) assert.fail(`${label}: slot ${i >> 1} ${i & 1 ? 'band' : 'word'} ${got[i]}, not ${want[i]}`);
  }
  let words = 0;
  let bands = 0;
  for (let k = 0; k < n; k++) {
    if (want[2 * k] !== 0) words++;
    if (want[2 * k + 1] > bands) bands = want[2 * k + 1];
  }
  return { words, bands };
}

for (const [backend, byRow] of [['webgl', false], ['webgl', true], ['webgpu', false]]) {
  test(`Pixi's keyed frames commit the pack's G-buffer words, a frame drawn split writes the same (${backend}${byRow ? ', by row' : ''})`, async () => {
    const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
    const scene = await quietly(() => pixiScene(backend));
    const m = scene.renderQueueMemory;
    // The columns the words read live in the render-queue memory, beside the queue, where the pack reads them.
    for (const [name, col] of [['gbufFlags', SpriteRenderer.gbufFlags], ['zIndex', SpriteRenderer.zIndex], ['selfShadow', ShadowCaster.selfShadow]]) {
      assert.equal(col.buffer, m.buffer, `${name} is in the render-queue memory`);
      assert.equal(col.length, ENTITIES, `${name}: an entity each`);
    }
    await quietly(() => bindPixi(px, scene, backend === 'webgpu', byRow));
    const batch = px.entitiesBatch;
    assert.equal(batch.keyed, true, 'the entity batch goes keyed');
    assert.equal(batch.gbuf, true, 'with the G-buffer words');
    assert.equal(batch.posesByRow, byRow);
    assert.equal(batch.packedGbuf.buffer, px._pixiGpuPack.buffer, 'the pack writes the words in its memory');
    const r = rng(388);
    for (let e = 0; e < ENTITIES; e++) {
      SpriteRenderer.gbufFlags[e] = (r() * 64) | 0;
      ShadowCaster.selfShadow[e] = (r() * 3) | 0;
      SpriteRenderer.zIndex[e] = (r() * 4) | 0;
    }
    const w = {
      x: new Float32Array(MAX), y: new Float32Array(MAX), scaleX: new Float32Array(MAX).fill(1), scaleY: new Float32Array(MAX).fill(1),
      rotC: new Float32Array(MAX).fill(1), rotS: new Float32Array(MAX), alpha: new Float32Array(MAX).fill(1), tint: new Uint32Array(MAX),
      textureId: new Uint16Array(MAX), anchorX: new Float32Array(MAX), anchorY: new Float32Array(MAX), type: new Uint8Array(MAX),
      key: new Uint32Array(MAX), sortKey: new Float32Array(MAX),
    };
    for (let k = 0; k < MAX; k++) {
      w.type[k] = k % 17 === 0 ? 1 : 0;
      w.key[k] = w.type[k] === 1 ? KEY_NONE : k * 2;
      w.x[k] = r() * 4000;
      w.y[k] = r() * 4000;
    }
    let order = null;
    px._pixiEntityPack.afterSprites = (n, idx) => {
      order = idx ? Uint32Array.from(idx.subarray(0, n)) : null;
    };
    const zUsers = SpriteRenderer._zIndexUsers;
    try {
      for (let f = 1; f <= 5; f++) {
        const n = MAX - 50 * f;
        const { b, h } = emitFrame(px, m, w, f, n);
        // Frame 3 drawn split: a pause of the keyed frames, from a buffer that holds every row's statics.
        const split = f === 3;
        if (split) {
          batch._keyPause = 1;
          Atomics.store(h, H.COMPLETE0 + b, 1);
        }
        // zIndex bands on frames 2 and 3 (a sprite has a zIndex).
        const bands = f === 2 || f === 3;
        Atomics.store(zUsers, 0, bands ? 1 : 0);
        px.lastReadFrame = f;
        px._setReadBuffer(b);
        batch.gbufData.fill(-9);
        px.updateSpritesFromRenderQueue();
        assert.equal(px.visibleEntityCount, n, `frame ${f}: every row drawn`);
        assert.equal(batch.mesh.shader === batch.shader, split, `frame ${f}: drawn ${split ? 'split' : 'keyed'}`);
        assert.equal(batch.gbufPacked, !split, `frame ${f}: the words ${split ? 'in JavaScript' : 'from the pack'}`);
        assert.ok(order && order.length === n, `frame ${f}: the painter's order`);
        const q = px.renderQueueBuffers[b];
        const seen = assertWords(`frame ${f}`, batch.gbufData, n, order, q.key, SpriteRenderer.gbufFlags, ShadowCaster.selfShadow,
          bands ? SpriteRenderer.zIndex : null);
        assert.ok(seen.words > n * 0.9 && seen.words < n, `frame ${f}: the sprites' words, 0 for the particles (${seen.words})`);
        assert.equal(seen.bands > 0, bands, `frame ${f}: bands while a sprite has a zIndex`);
      }
    } finally {
      Atomics.store(zUsers, 0, 0);
    }
  });
}
