// E-82b, wired: Pixi's entity batch on pre-render's GPU queue (packGpuSprites 'preRender'), through
// updateSpritesFromRenderQueue. A split frame commits its two streams, its statics only when their generation or
// the row count moved; a frame of 15-float rows is split into the batch; and a plain batch (the switch off) never
// takes a split frame for rows.
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
import { createViews } from '../../src/render/renderQueueLayout.js';
import {
  GPU_FLAG_SPLIT,
  GPU_POSE_FLOATS,
  GPU_SPRITE_FLOATS,
  GPU_STATIC_FLOATS,
  createGpuQueueViews,
  gpuQueueCaps,
  writeGpuQueueHeader,
} from '../../src/render/gpuQueueLayout.js';
import { WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';
import { loadWorker, quietly } from '../bench/workerHarness.mjs';

const MAX = 3000;

const shaderDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/shaders');
const readShader = (f) => fs.readFileSync(path.join(shaderDir, f), 'utf8');
const GPU_SHADERS = { sprite: readShader('instancedSprite.wgsl'), spritePose: readShader('instancedSpritePose.wgsl') };

class Thing extends GameObject {}
Thing.components = [RigidBody, Collider, SpriteRenderer];

function scene(split) {
  Query.reset();
  const s = {
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
      renderer: { maxVisibleRenderables: MAX, ySort: false },
      preRender: { packGpuSprites: 'preRender', sortSprites: 'preRender' },
      layers: {},
      wasm: { ...WASM_DEFAULTS, gpuPackSplit: split },
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

async function bindPixi(px, s) {
  const m = s.renderQueueMemory;
  const caps = gpuQueueCaps(MAX, s.config.lighting);
  px.config = s.config;
  px._ySort = false;
  px._packGpuSpritesOn = 'preRender';
  px._queueInterp = false;
  px._lightGlowAdd = false;
  px._useWebGpu = true;
  px._engineShaders = GPU_SHADERS;
  px.renderQueueEnabled = true;
  px.renderQueueMaxItems = MAX;
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
  px.createEntitiesInstancedBatch(MAX);
  const uploads = { statics: 0 };
  for (const buf of px.entitiesBatch._buffers) buf.update = () => {};
  if (px.entitiesBatch._staticBuffers) for (const buf of px.entitiesBatch._staticBuffers) buf.update = () => { uploads.statics++; };
  return uploads;
}

const POSE_WORDS = [0, 1, 6, 7];

/**
 * One frame of pre-render's GPU queue in buffer b: n rows, split (with a generation) or as 15-float rows. The
 * poses move every frame; the statics are one generation's (as pre-render keeps them while it holds).
 */
function writeGpuFrame(px, b, n, split, gen, frame) {
  const g = px.gpuQueueBuffers[b];
  const rows = new Float32Array(n * GPU_SPRITE_FLOATS);
  for (let i = 0; i < rows.length; i++) {
    const salt = POSE_WORDS.includes(i % 15) ? frame : split ? gen * 10 : 1000 + frame;
    rows[i] = ((i * 2654435761) % 1000) / 7 + salt;
  }
  if (split) {
    for (let k = 0; k < n; k++) {
      g.spritePose.set([rows[k * 15], rows[k * 15 + 1], rows[k * 15 + 6], rows[k * 15 + 7]], k * GPU_POSE_FLOATS);
      g.spriteStatic.set([2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14].map((j) => rows[k * 15 + j]), k * GPU_STATIC_FLOATS);
    }
  } else {
    g.sprites.set(rows);
  }
  writeGpuQueueHeader(g.header, { sprite: n, glow: 0, sun: 0, stamp: 0, cookie: 0, particle: 0, staticGen: split ? gen : 0 },
    split ? GPU_FLAG_SPLIT : 0);
  px.renderQueueBuffers[b].count[0] = n;
  return rows;
}

function batchRows(batch, n) {
  if (!batch.split) return Float32Array.from(batch.data.subarray(0, n * GPU_SPRITE_FLOATS));
  const rows = new Float32Array(n * GPU_SPRITE_FLOATS);
  for (let k = 0; k < n; k++) {
    [0, 1, 6, 7].forEach((j, t) => { rows[k * 15 + j] = batch.data[k * 4 + t]; });
    [2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14].forEach((j, t) => { rows[k * 15 + j] = batch.staticData[k * 11 + t]; });
  }
  return rows;
}

test('Pixi commits a split GPU queue in two streams, its statics when their generation moves', async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const s = await quietly(() => scene(true));
  const uploads = await quietly(() => bindPixi(px, s));
  const batch = px.entitiesBatch;
  assert.equal(batch.split, true, 'the switch on gives a split batch');
  // frame: [rows, split, generation]
  const frames = [[2500, true, 5], [2500, true, 5], [2500, true, 5], [2500, true, 5], [2500, true, 6], [2500, true, 6],
    [2400, true, 6], [2400, false, 0], [2400, true, 6], [2400, true, 6]];
  const versions = [];
  frames.forEach(([n, split, gen], f) => {
    const b = f & 1;
    const rows = writeGpuFrame(px, b, n, split, gen, f);
    px._setReadBuffer(b);
    px.updateSpritesFromRenderQueue();
    assert.equal(px.visibleEntityCount, n, `frame ${f}: rows`);
    const got = batchRows(batch, n);
    for (let k = 0; k < n * 15; k++) if (got[k] !== rows[k]) assert.fail(`frame ${f}: word ${k} ${got[k]} vs ${rows[k]}`);
    versions.push(batch._staticVersion);
  });
  // A copy per new generation, row count, or 15-float frame; a split frame right after rows copies again.
  const copies = versions.map((v, f) => (f === 0 ? 1 : v - versions[f - 1]));
  assert.deepEqual(copies, [1, 0, 0, 0, 1, 0, 1, 1, 1, 0]);
  assert.ok(uploads.statics >= 2 && uploads.statics <= 12, `${uploads.statics} static uploads`);
});

test('a plain batch (the switch off) leaves a split frame to the SoA path', async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const s = await quietly(() => scene(false));
  await quietly(() => bindPixi(px, s));
  assert.equal(px.entitiesBatch.split, false);
  const rows = writeGpuFrame(px, 0, 100, false, 0, 1);
  px._setReadBuffer(0);
  px.updateSpritesFromRenderQueue();
  assert.equal(px.visibleEntityCount, 100);
  assert.deepEqual(batchRows(px.entitiesBatch, 100), rows, '15-float rows commit as they are');
  let commits = 0;
  const commit = px._commitPackedBatch.bind(px);
  px._commitPackedBatch = (...a) => { commits++; return commit(...a); };
  writeGpuFrame(px, 1, 100, true, 3, 2);
  px._setReadBuffer(1);
  px.updateSpritesFromRenderQueue();
  assert.equal(commits, 0, 'a split frame is not read as rows');
});

// Close-out group B. On these frames Pixi packed the main queue itself (packSpriteLayer, in JS in pre-render pack
// mode): a frame of glow rows only (pre-render packed no sprite), and sprites with a zIndex under Y-sort off, where
// nobody sorts (Pixi had no painter either, so its own pack was the same unsorted rows). Both commit pre-render's.
test('a frame of glow rows only and zIndex sprites under Y-sort off commit pre-render\'s rows', async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const s = await quietly(() => scene(true));
  await quietly(() => bindPixi(px, s));
  assert.equal(px._sortSpritesOn, 'none', 'Y-sort off: nobody sorts');
  let ownPacks = 0;
  const upload = px.entitiesBatch.upload.bind(px.entitiesBatch);
  px.entitiesBatch.upload = (...a) => { ownPacks++; return upload(...a); };

  // zIndex users, Y-sort off.
  SpriteRenderer._zIndexUsers[0] = 3;
  const rows = writeGpuFrame(px, 0, 400, true, 2, 1);
  px._setReadBuffer(0);
  px.updateSpritesFromRenderQueue();
  SpriteRenderer._zIndexUsers[0] = 0;
  assert.equal(ownPacks, 0, 'zIndex under Y-sort off: no pack of Pixi\'s own');
  assert.equal(px.visibleEntityCount, 400);
  assert.deepEqual(batchRows(px.entitiesBatch, 400), rows, 'pre-render\'s rows');

  // Glow rows only: no sprite packed, the glows packed as glows.
  const g = px.gpuQueueBuffers[1];
  writeGpuQueueHeader(g.header, { sprite: 0, glow: 25, sun: 0, stamp: 0, cookie: 0, particle: 0, staticGen: 0 }, GPU_FLAG_SPLIT);
  px.renderQueueBuffers[1].count[0] = 25;
  px._setReadBuffer(1);
  px.updateSpritesFromRenderQueue();
  assert.equal(ownPacks, 0, 'glow rows only: no pack of Pixi\'s own');
  assert.equal(px.visibleEntityCount, 0, 'no sprite rows');
});
