// Close-out group B: Pixi's glow batch (pixi pack mode) and its custom sprite layers' batches pack through gpuPack.wasm.
// Their rows are regions of the render-queue memory (the glow batch's in pixi pack mode, each custom layer's next to
// its queues) and Pixi's pack scratch is there in either pack mode, with a column table for every queue buffer it
// packs; before, both batches packed in JS. The kernel's glow rows are the JS packer's.
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
import { BATCH_SPACE, InstancedSpriteBatch, INSTANCED_SPRITE_FLOATS } from '../../src/render/instancedSpriteBatch.js';
import { GPU_PACK_TABLE_SLOTS } from '../../src/util/renderQueueMemory.js';
import { WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';
import { loadWorker } from '../bench/workerHarness.mjs';

const MAX = 2000;
const shaderDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/shaders');
const readShader = (f) => fs.readFileSync(path.join(shaderDir, f), 'utf8');
const GPU_SHADERS = { sprite: readShader('instancedSprite.wgsl'), spritePose: readShader('instancedSpritePose.wgsl') };

class Thing extends GameObject {}
Thing.components = [RigidBody, Collider, SpriteRenderer];

function scene(pack, layers = {}) {
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
      lighting: { enabled: true, maxLights: 10, shadowsEnabled: false, maxFlashes: 0, raycasted: false },
      logic: { staggeredUpdates: false },
      debug: { maxDebugDrawEntries: 1 },
      navigation: { enabled: false },
      renderer: { maxVisibleRenderables: MAX, ySort: false },
      preRender: { packGpuSprites: pack, sortSprites: 'none' },
      layers,
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

test('Pixi\'s pack scratch is in the memory in either pack mode, with a table per custom layer buffer; its glow rows in pixi mode', () => {
  const pre = scene('preRender', { fx: {}, sparks: {} });
  const L = pre.renderQueueMemory.layout;
  assert.ok(L.pixiTableByte > 0 && L.pixiIndexByte > 0 && L.pixiParticlesByte > 0, 'the scratch, pre-render pack mode');
  assert.equal(L.pixiInstanceRows, 0, 'no entity rows: pre-render packs those');
  assert.equal(L.pixiTableSlots, GPU_PACK_TABLE_SLOTS + 4, 'two tables per custom layer');
  assert.equal(L.pixiGlowByte, -1, 'pre-render packs the glows');
  for (const q of Object.values(pre.customLayerRenderQueues)) {
    assert.ok(q.rowsByte > 0 && q.rowsByte % 64 === 0, `${q.layerName}: its rows on a line of the memory`);
  }
  const pixi = scene('pixi');
  const P = pixi.renderQueueMemory.layout;
  assert.equal(P.pixiInstanceRows, MAX, 'pixi pack mode: the entity rows');
  assert.equal(P.pixiGlowRows, MAX, 'and the glow batch\'s');
  assert.ok(P.pixiGlowByte > 0);
});

test('in pixi pack mode the glow batch packs the glow rows through the kernel, the rows the JS packs', async () => {
  const s = scene('pixi');
  const m = s.renderQueueMemory;
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  px.config = s.config;
  px._ySort = false;
  px._packGpuSpritesOn = 'pixi';
  px._queueInterp = false;
  px._lightGlowAdd = true;
  px._useWebGpu = true;
  px._engineShaders = GPU_SHADERS;
  px.renderQueueEnabled = true;
  px.renderQueueMaxItems = MAX;
  await px._bindPixiGpuPack({ renderQueueMemory: m.memory, renderQueueLayout: m.layout });
  assert.ok(px._pixiGpuPack, 'Pixi bound its pack');
  px.createEntitiesInstancedBatch(MAX);
  const glow = px.entitiesGlowBatch;
  assert.equal(glow._gpuPack, px._pixiGpuPack, 'the glow batch packs through it');
  assert.equal(glow._sharedRows.buffer, m.buffer, 'into its rows of the memory');

  // The main queue: sprites and glow rows (type 3), anywhere.
  const q = createViews(m.buffer, MAX, m.layout.queueAByte);
  let seed = 0x6107;
  const r = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const n = 1500;
  for (let i = 0; i < n; i++) {
    q.x[i] = (r() - 0.5) * 6000;
    q.y[i] = (r() - 0.5) * 6000;
    q.scaleX[i] = q.scaleY[i] = 0.2 + r() * 3;
    q.rotC[i] = 1;
    q.alpha[i] = r();
    q.tint[i] = (r() * 0xffffff) >>> 0;
    q.textureId[i] = (r() * 300) | 0;
    q.anchorX[i] = q.anchorY[i] = 0.5;
    q.type[i] = i % 4 === 0 ? 3 : 0;
  }
  q.count[0] = n;
  const bq = { ...q, count: n };
  let general = 0;
  const realGeneral = px._pixiGpuPack.spritesGeneral;
  px._pixiGpuPack.spritesGeneral = (...a) => {
    general++;
    return realGeneral(...a);
  };
  const opts = { space: BATCH_SPACE.WORLD, type: q.type, includeType: 3, depthDenom: MAX };
  for (const b of glow._buffers) b.update = () => {};
  const nKernel = glow.upload(bq, { ...opts });
  const js = new InstancedSpriteBatch({ capacity: MAX, label: 'glow-js', useWebGpu: true, shaders: GPU_SHADERS, blendMode: 'add', premultiplyAlpha: false });
  for (const b of js._buffers) b.update = () => {};
  const nJs = js.upload(bq, { ...opts });
  px._pixiGpuPack.spritesGeneral = realGeneral;
  assert.equal(general, 1, 'the kernel packed the glow rows');
  assert.equal(nKernel, nJs, 'the same rows');
  assert.equal(nJs, n / 4, 'every glow row and none else');
  const a = new Uint32Array(glow.data.buffer, glow.data.byteOffset, nJs * INSTANCED_SPRITE_FLOATS);
  const b = new Uint32Array(js.data.buffer, js.data.byteOffset, nJs * INSTANCED_SPRITE_FLOATS);
  assert.equal(a.findIndex((w, k) => w !== b[k]), -1, 'bit for bit');
});
