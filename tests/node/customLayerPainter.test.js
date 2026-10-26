// Close-out group B: a y-sorted custom layer's painter state is a region of the render-queue memory, next to its
// queues, and Pixi's layer sorts through painterRadix.wasm there (Pixi's entities kernel, or one bound for the layers);
// before, every custom layer sorted with a JS state (tests/reference/painterJs.mjs, the order compared with). Frame after frame, with rows moving, joining, leaving and tying,
// the kernel's order is the JS painter's, and the layer's upload takes it.
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
import { Layer } from '../../src/core/layer.js';
import { Query } from '../../src/core/query.js';
import { BATCH_SPACE } from '../../src/render/instancedSpriteBatch.js';
import { orderPainterSlotsWasm } from '../../src/render/painterRadixClient.js';
import { WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';

import { loadWorker, quietly } from '../bench/workerHarness.mjs';
import { createPainterState, orderPainterSlots } from '../reference/painterJs.mjs';

const MAX = 2000;
const YS_ROWS = 900;
const shaderDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/shaders');
const readShader = (f) => fs.readFileSync(path.join(shaderDir, f), 'utf8');
const GPU_SHADERS = { sprite: readShader('instancedSprite.wgsl'), spritePose: readShader('instancedSpritePose.wgsl') };

class Thing extends GameObject {}
Thing.components = [RigidBody, Collider, SpriteRenderer];

function scene(wasm = {}, sortSprites = 'none') {
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
      renderer: { maxVisibleRenderables: MAX, ySort: sortSprites !== 'none' },
      preRender: { packGpuSprites: 'pixi', sortSprites },
      layers: { ys: { ySorting: true, maxItems: YS_ROWS }, flat: { maxItems: 300 } },
      wasm: { ...WASM_DEFAULTS, ...wasm },
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

/** Pixi with the scene's render-queue memory and its pack bound, then its real init of the custom layers. */
async function initPixi(s, bindEntitiesPainter = false) {
  const m = s.renderQueueMemory;
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  px.config = s.config;
  px._useWebGpu = true;
  px._engineShaders = GPU_SHADERS;
  px._customLayerList = [];
  px.globalEntityCount = s.totalEntityCount;
  px.renderQueueEnabled = true;
  px.renderQueueMaxItems = MAX;
  px._packGpuSpritesOn = 'pixi';
  px.pixiApp = { stage: { addChild() {}, sortChildren() {} }, renderer: null };
  px._renderQueueMemory = m.memory;
  await px._bindPixiGpuPack({ renderQueueMemory: m.memory, renderQueueLayout: m.layout });
  if (bindEntitiesPainter) await px._bindPainterRadix({ renderQueueMemory: m.memory, renderQueueLayout: m.layout });
  await quietly(() => px.initializeCustomLayers({
    config: s.config,
    layerData: Layer.getSerializableData(),
    customLayerRenderQueues: s.customLayerRenderQueues,
  }));
  return px;
}

const layerNamed = (px, name) => px._customLayerList.find((l) => l.layerName === name);

test('a y-sorted custom layer has a painter state next to its queues; a layer in queue order has none', () => {
  const s = scene();
  const e = s.renderQueueMemory.layout.emit;
  const ys = e.customLayers.find((c) => c.layerId === Layer.get('ys').id);
  const flat = e.customLayers.find((c) => c.layerId === Layer.get('flat').id);
  assert.ok(ys.painter, 'the y-sorted layer\'s state');
  assert.equal(ys.painter.rows, YS_ROWS, 'one row per layer row');
  for (const k of ['orderByte', 'scratchByte', 'prevKeyByte', 'histByte', 'tableByte']) {
    assert.ok(ys.painter[k] > 0 && ys.painter[k] % 4 === 0, `${k} in the memory`);
  }
  assert.equal(flat.painter, null, 'no state for a layer drawn in queue order');
  assert.deepEqual(s.customLayerRenderQueues[ys.layerId].painter, ys.painter, 'the layer\'s queues carry it to Pixi');
  assert.equal(s.customLayerRenderQueues[flat.layerId].painter, null);
});

for (const [label, bindEntitiesPainter, sortSprites] of [
  ['a kernel bound for the layers', false, 'none'],
  ['Pixi\'s entities kernel', true, 'pixi'],
]) {
  test(`Pixi's y-sorted layer sorts through painterRadix.wasm (${label}), the JS painter's order frame after frame`, async () => {
    const s = scene({}, sortSprites);
    const m = s.renderQueueMemory;
    const px = await initPixi(s, bindEntitiesPainter);
    if (bindEntitiesPainter) assert.ok(px._painterWasm, 'Pixi sorts the entities');
    const cl = layerNamed(px, 'ys');
    assert.ok(cl.painter && cl.painter.kernel, 'the layer\'s state has a kernel');
    if (bindEntitiesPainter) assert.equal(cl.painter.kernel, px._painterWasm.kernel, 'the entities\' kernel');
    assert.equal(cl.painter.order.buffer, m.buffer, 'its arrays in the memory');
    assert.equal(cl.painter.table, m.layout.emit.customLayers.find((c) => c.layerId === cl.layerId).painter.tableByte);
    assert.equal(layerNamed(px, 'flat').painter, null, 'the flat layer has no painter');

    const keys = cl.sortKeyU32;
    assert.equal(keys.buffer, m.buffer, 'the keys pre-render writes, in the memory');
    const js = createPainterState(YS_ROWS);
    let seed = 0x5eed;
    const r = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const key = () => (0x80000000 + ((r() * 4000) | 0) * 128) >>> 0;
    let n = 700;
    for (let i = 0; i < YS_ROWS; i++) keys[i] = key();
    for (let f = 0; f < 40; f++) {
      if (f === 12) n = 820; // rows join
      if (f === 25) n = 640; // rows leave
      if (f > 0) {
        // Some rows move, some tie with a neighbour; frame 30 changes nothing.
        if (f !== 30) for (let k = 0; k < n; k++) if (r() < 0.08) keys[k] = r() < 0.2 ? keys[(k + 1) % n] : key();
      }
      const want = Array.from(orderPainterSlots(js, null, n, keys).subarray(0, n));
      const got = Array.from(orderPainterSlotsWasm(cl.painter, null, n, keys).subarray(0, n));
      assert.deepEqual(got, want, `frame ${f}: the order`);
    }

    // The layer's upload takes the kernel's order (Pixi's custom-layer path, _uploadSortedSprites).
    let calls = 0;
    const kernel = cl.painter.kernel;
    const wrapped = { ...kernel };
    for (const name of ['painterOrder', 'reinsert']) {
      wrapped[name] = (...a) => {
        calls++;
        return kernel[name](...a);
      };
    }
    cl.painter.kernel = wrapped;
    for (const b of cl.batch._buffers) b.update = () => {};
    const ref = cl.readRef;
    for (let i = 0; i < n; i++) {
      ref.x[i] = i * 3;
      ref.y[i] = i;
      ref.scaleX[i] = ref.scaleY[i] = 1;
      ref.rotC[i] = 1;
      ref.alpha[i] = 1;
      ref.anchorX[i] = ref.anchorY[i] = 0.5;
      ref.type[i] = 0;
      keys[i] = key();
    }
    ref.count[0] = n;
    const q = px._entityUploadQ;
    px._bindSpriteQueue(q, ref, n);
    const opts = px._entityUploadOpts;
    px._resetSpriteUploadOpts(opts);
    opts.depthDenom = cl.maxItems;
    opts.worldHeight = 4000;
    opts.type = ref.type;
    opts.space = BATCH_SPACE.WORLD;
    opts.zoom = 1;
    opts.cameraX = 0;
    opts.cameraY = 0;
    opts.resolution = 1;
    const drawn = px._uploadSortedSprites(cl.batch, q, opts, cl.painter, cl.sortKeyU32, null, n);
    assert.equal(drawn, n, 'every row drawn');
    assert.ok(calls > 0, 'the kernel ordered them');
    assert.equal(opts.indices, cl.painter.order, 'in the kernel\'s order');
  });
}
