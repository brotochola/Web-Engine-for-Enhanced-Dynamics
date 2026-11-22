// E-514, wired: pre-render's indexed frames list the statics rows that changed (gpuPack.c diff_indexed_statics), and
// Pixi's indexed batch sends those alone into its statics texture instead of every row. Pre-render packs real frames
// into its two GPU queue buffers in turn; a real InstancedSpriteBatch takes them through commitIndexed with a stand-in
// texture that keeps its texels (upload copies the rows it is given, scatter applies the updates in order). After every
// frame Pixi takes, the texture holds that frame's statics bit for bit, whether Pixi takes every frame, every other one
// (the lists are also relative to the buffer two frames back) or skips two (no base: every row goes up). A texture that
// changed alone goes as a texture update; a row that changed and changed back is listed; rows that come and go, a frame
// whose changes overflow the lists and a split frame between indexed ones fall back or recover as they must.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TextureSource } from '../../src/vendor/pixi.min.js';
import { InstancedSpriteBatch } from '../../src/render/instancedSpriteBatch.js';
import { computeBufferSize, RENDER_QUEUE_CAMERA_BYTES } from '../../src/render/renderQueueLayout.js';
import {
  GPU_FLAG_INDEXED,
  GPU_HDR_FLAGS,
  GPU_HDR_INDEXED_ROWS,
  GPU_HDR_IXUP,
  GPU_HDR_IXUP_GEN_A,
  GPU_HDR_IXUP_GEN_B,
  GPU_HDR_IXUP_ROWS_A,
  GPU_HDR_IXUP_ROWS_B,
  GPU_HDR_IXUP_TEX,
  GPU_HDR_SLOTS_GEN,
  GPU_HDR_SPRITE,
  GPU_HDR_STATIC_GEN,
  GPU_INDEXED_STATIC_FLOATS,
  GPU_INDEXED_TEX_WORD,
  computeGpuQueueBufferSize,
  gpuIndexedUpdateRows,
  gpuQueueCaps,
} from '../../src/render/gpuQueueLayout.js';
import { GPU_KEYED_KEY_WORD, GPU_KEYED_ROW_WORDS, GPU_KEYED_TEX_WORDS } from '../../src/render/gpuPackClient.js';
import { WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { spriteYSortKey } from '../../src/util/sortIndexByKey.js';
import { createRenderQueueMemory } from '../../src/util/renderQueueMemory.js';
import { coreComponentData, emitSpec, emitSpriteBuffers, initWorker, loadWorker } from '../bench/workerHarness.mjs';
import { readEngineShader, spriteGlslShaders } from './engineShaderSources.mjs';

// GlProgram.from probes shader precision on a canvas; Node has none, and a context of null is enough.
globalThis.document ??= { createElement: () => ({ getContext: () => null }) };
// With a document, sceneParams reads location.search (the workers' harness loads it).
globalThis.location ??= { search: '' };
const read = readEngineShader;
const shaders = {
  ...spriteGlslShaders(),
  shadowVert: read('instancedSpriteShadow.vert.glsl'),
};

// Past SCATTER_MIN_ROWS, which the indexed kernel needs.
const MAX = 6000;
const W = GPU_INDEXED_STATIC_FLOATS;
// Each frame: the rows, the queue's statics generation, and what changes. Every frame moves a few textures (rows
// i % 50 == 0: texture updates), row 7's texture flips each frame (it changes back), rows i % 333 == 0 change their
// scale (updates); `all` moves every row's scale (past the lists' room), `split` packs the frame split.
const FRAMES = [];
for (let f = 0; f < 24; f++) {
  FRAMES.push({
    n: f === 9 || f === 10 ? 4990 : 5000,
    gen: f === 5 ? 5 : f + 1,
    all: f === 12,
    split: f === 16,
  });
}

function writeQueue(q, fr, f) {
  q.count[0] = fr.n;
  q.staticGen[0] = fr.gen;
  // Frame 5 repeats frame 4's statics under its generation (the buffer that holds it writes none).
  const s = f === 5 ? 4 : f;
  for (let i = 0; i < fr.n; i++) {
    q.x[i] = (i % 97) * 30 + f * 1.5;
    q.y[i] = ((i * 37) % 3000) - f * ((i % 3) + 1);
    q.scaleX[i] = 1 + (i % 3) * 0.25 + (i % 333 === 0 ? s * 0.01 : 0) + (fr.all ? 0.5 : 0);
    q.scaleY[i] = 1;
    q.rotC[i] = 1;
    q.rotS[i] = 0;
    q.alpha[i] = 1;
    q.tint[i] = 0xffffff;
    q.textureId[i] = i === 7 ? 1 + (s & 1) : (i % 5) + (i % 50 === 0 ? s : 0);
    q.anchorX[i] = 0.5;
    q.anchorY[i] = 0.5;
    q.type[i] = i % 7 === 0 ? 1 : 0;
    q.sortKey[i] = spriteYSortKey(q.y[i], 128);
  }
}

async function preRender() {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const caps = gpuQueueCaps(MAX, { enabled: false }, true);
  const m = createRenderQueueMemory(MAX, computeBufferSize(MAX), computeGpuQueueBufferSize(caps), emitSpec(64), null, null, false, null,
    { preRender: true, pixi: false });
  await initWorker(pre, {
    config: {
      worldWidth: 4000,
      worldHeight: 4000,
      renderer: { ySort: true, backend: 'webgl', indexedSprites: true },
      preRender: { packGpuSprites: 'preRender', sortSprites: 'preRender' },
      lighting: { enabled: false },
      wasm: { ...WASM_DEFAULTS },
    },
    globalEntityCount: 64,
    buffers: { componentData: { ...coreComponentData(64), ...emitSpriteBuffers(m).componentData }, componentDataByte: emitSpriteBuffers(m).componentDataByte },
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
  assert.equal(pre._gpuIndexed, true, 'the queue has room for indexed frames');
  return { pre, caps };
}

/** Pixi's indexed batch over a stand-in statics texture that keeps its texels. */
function pixiBatch() {
  const tex = { texels: null, width: 0, uploads: 0, scatters: 0, updates: 0, texUpdates: 0 };
  const ops = {
    maxSize: 16384,
    make(bits, width, height, label) {
      tex.width = width;
      tex.texels = new Uint32Array(width * height * 4);
      return new TextureSource({ width, height, label });
    },
    upload(source, bits, width, height, y0, rows) {
      const from = y0 * width * 4;
      tex.texels.set(bits.subarray(from, from + rows * width * 4), from);
      tex.uploads++;
    },
    scatter(source, updates, count, width, height, texUpdates, texCount) {
      assert.ok(!(updates.buffer instanceof SharedArrayBuffer), 'the scatter reads a private copy');
      for (let u = 0; u < count; u++) {
        const at = u * GPU_KEYED_ROW_WORDS;
        tex.texels.set(updates.subarray(at, at + W), updates[at + GPU_KEYED_KEY_WORD] * W);
      }
      for (let u = 0; u < texCount; u++) {
        const at = u * GPU_KEYED_TEX_WORDS;
        tex.texels[texUpdates[at] * W + GPU_INDEXED_TEX_WORD] = texUpdates[at + 1];
      }
      tex.scatters++;
      tex.updates += count;
      tex.texUpdates += texCount;
    },
  };
  const batch = new InstancedSpriteBatch({
    capacity: MAX, label: 'e514', useWebGpu: false, shaders, gpuPack: null, split: true, statics: ops,
    data: new Float32Array(MAX * 15),
  });
  assert.equal(batch.indexed, true);
  for (const x of [...batch._buffers, ...(batch._staticBuffers || []), ...(batch._slotBuffers || [])]) x.update = () => {};
  return { batch, tex };
}

/** Pre-render packs every frame; Pixi takes the frames `takes` says, and its texture must hold each one's statics. */
async function run(takes) {
  const { pre, caps } = await preRender();
  const { batch, tex } = pixiBatch();
  const ix = { updates: null, texUpdates: null, count: -1, texCount: 0, genA: 0, rowsA: 0, genB: 0, rowsB: 0 };
  const lists = [];
  FRAMES.forEach((fr, f) => {
    pre._gpuIndexed = !fr.split;
    pre.selectWriteBuffers();
    writeQueue(pre.renderQueueBuffers[pre._queueBuf], fr, f);
    pre._emitWriteCount = 0;
    const dst = pre.gpuQueueBuffers[pre._queueBuf];
    pre.packSpriteAndShadowQueues();
    const h = dst.header;
    const indexed = (h[GPU_HDR_FLAGS] & GPU_FLAG_INDEXED) !== 0;
    assert.equal(indexed, !fr.split, `frame ${f}: indexed`);
    lists.push(indexed ? [h[GPU_HDR_IXUP], h[GPU_HDR_IXUP_TEX]] : null);
    if (indexed && takes(f)) {
      ix.updates = dst.spriteIxUpdates;
      ix.texUpdates = dst.spriteIxTexUpdates;
      ix.count = h[GPU_HDR_IXUP];
      ix.texCount = h[GPU_HDR_IXUP_TEX];
      ix.genA = h[GPU_HDR_IXUP_GEN_A];
      ix.rowsA = h[GPU_HDR_IXUP_ROWS_A];
      ix.genB = h[GPU_HDR_IXUP_GEN_B];
      ix.rowsB = h[GPU_HDR_IXUP_ROWS_B];
      const n = h[GPU_HDR_SPRITE] | 0;
      batch.commitIndexed(dst.spritePose, dst.spriteSlots, dst.spriteRowStatics, n, h[GPU_HDR_INDEXED_ROWS],
        h[GPU_HDR_STATIC_GEN], h[GPU_HDR_SLOTS_GEN], ix);
      const want = new Uint32Array(dst.spriteRowStatics.buffer, dst.spriteRowStatics.byteOffset, fr.n * W);
      const have = tex.texels.subarray(0, fr.n * W);
      for (let i = 0; i < fr.n * W; i++) {
        if (have[i] !== want[i]) assert.fail(`frame ${f}: row ${Math.floor(i / W)} word ${i % W}: ${have[i]} not ${want[i]}`);
      }
    }
    pre.publishFrame();
  });
  return { lists, batch, tex };
}

test('every frame taken: the texture holds each frame\'s statics, mostly through the lists', async () => {
  const { lists, batch, tex } = await run(() => true);
  // Frame 0 has no base; frame 5 repeats frame 4's generation in a buffer that lacks it (frame 3's): its statics are
  // written with the lists against both; frame 12 overflows, and frame 13 changes every row back (overflows too).
  assert.equal(lists[0][0], -1, 'frame 0: no base, no lists');
  assert.deepEqual(lists[5], [16, 100], 'frame 5: nothing changed since frame 4, but the lists also cover frame 3 (its buffer)');
  assert.equal(lists[12][0], -1, 'frame 12: every row changed, past the lists\x27 room');
  assert.equal(lists[13][0], -1, 'frame 13: and back');
  // An ordinary frame: 100 textures moved (rows i % 50, row 0 among them) and row 7's: texture updates; the 16 rows
  // i % 333 changed their scale (row 0's is both: an update): updates.
  assert.deepEqual(lists[3], [16, 100], 'frame 3: 16 updates and 100 texture updates');
  assert.ok(lists[3][0] + lists[3][1] <= gpuIndexedUpdateRows(MAX));
  assert.ok(batch._ixScattered >= 17, `frames through the lists: ${batch._ixScattered}`);
  assert.ok(tex.texUpdates > 1000, 'most of the changes went as texture updates');
});

test('every other frame taken: the lists are relative to the buffer two frames back too', async () => {
  const { batch } = await run((f) => f % 2 === 0 || f >= 17);
  assert.ok(batch._ixScattered >= 10, `frames through the lists: ${batch._ixScattered}`);
});

test('two frames skipped: no base, every row goes up, and the next frames list again', async () => {
  const { batch } = await run((f) => f % 3 === 0 || f >= 19);
  assert.ok(batch._ixWhole >= 6, `frames sent whole: ${batch._ixWhole}`);
  assert.ok(batch._ixScattered >= 3, `frames through the lists after: ${batch._ixScattered}`);
});
