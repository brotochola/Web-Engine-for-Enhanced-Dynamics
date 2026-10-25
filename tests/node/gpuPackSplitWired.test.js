// E-82b, wired: pre-render's GPU queue in two streams, through its real pack path on queues it writes in the
// render-queue memory, A and B in turn. Every frame the pose and static streams hold, word for word, the 15-float
// rows the same frames pack unsplit (a run with the worker's _gpuSplit off, the plain kernel pack); the header says
// GPU_FLAG_SPLIT and the statics' generation;
// and a GPU queue buffer's statics are rewritten only when it does not hold the queue's generation for the
// same rows (a poisoned static stream stays poisoned on the frames that skip it).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeBufferSize, RENDER_QUEUE_CAMERA_BYTES } from '../../src/render/renderQueueLayout.js';
import {
  GPU_FLAG_SPLIT,
  GPU_HDR_FLAGS,
  GPU_HDR_SPRITE,
  GPU_HDR_STATIC_GEN,
  GPU_POSE_FLOATS,
  GPU_SPRITE_FLOATS,
  GPU_STATIC_FLOATS,
  computeGpuQueueBufferSize,
  gpuQueueCaps,
} from '../../src/render/gpuQueueLayout.js';
import { WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { spriteYSortKey } from '../../src/util/sortIndexByKey.js';
import { createRenderQueueMemory } from '../../src/util/renderQueueMemory.js';
import { coreComponentData, emitSpec, emitSpriteBuffers, initWorker, loadWorker } from '../bench/workerHarness.mjs';

const MAX = 5000;
const POSE_FROM_ROW = [0, 1, 6, 7];
const STATIC_FROM_ROW = [2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14];
const POISON = 0x7fc0dead;

// Each frame: the rows' count, the queue's staticGen, and whether its statics changed (a scale moves).
const FRAMES = [
  { n: 4000, gen: 7 }, { n: 4000, gen: 7 }, { n: 4000, gen: 7 }, { n: 4000, gen: 7 }, { n: 4000, gen: 7 },
  { n: 4000, gen: 8, scale: 2 }, { n: 4000, gen: 8 }, { n: 4000, gen: 8 }, { n: 3900, gen: 8 }, { n: 3900, gen: 8 },
  { n: 3900, gen: 8 }, { n: 3900, gen: 0 }, { n: 3900, gen: 0 }, { n: 3900, gen: 9 }, { n: 3900, gen: 9 },
];

function writeQueue(q, fr, f, ySort) {
  q.count[0] = fr.n;
  q.staticGen[0] = fr.gen;
  for (let i = 0; i < fr.n; i++) {
    q.x[i] = (i % 97) * 30 + f * 1.5;
    q.y[i] = ((i * 37) % 3000) - f;
    q.scaleX[i] = 1 + (i % 3) * 0.25 + (fr.scale || 0);
    q.scaleY[i] = 1;
    q.rotC[i] = 1;
    q.rotS[i] = 0;
    q.alpha[i] = 1;
    q.tint[i] = 0xffffff;
    q.textureId[i] = i % 5;
    q.anchorX[i] = 0.5;
    q.anchorY[i] = 0.5;
    q.type[i] = i % 7 === 0 ? 1 : 0;
    if (ySort) q.sortKey[i] = spriteYSortKey(q.y[i], 128);
  }
}

async function run(pre, split, ySort = false) {
  const caps = gpuQueueCaps(MAX, { enabled: false });
  const m = createRenderQueueMemory(MAX, computeBufferSize(MAX), computeGpuQueueBufferSize(caps), emitSpec(64));
  await initWorker(pre, {
    config: {
      worldWidth: 4000,
      worldHeight: 4000,
      renderer: { ySort },
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
  assert.ok(pre._gpuPackWasm, 'pre-render packs through gpuPack.wasm');
  assert.equal(pre._gpuSplit, true, 'pre-render splits (a linear atlas)');
  // The unsplit run: the same frames as 15-float rows, the reference the streams are compared with.
  pre._gpuSplit = split;
  const out = [];
  FRAMES.forEach((fr, f) => {
    pre.selectWriteBuffers();
    writeQueue(pre.renderQueueBuffers[pre._queueBuf], fr, f, ySort);
    pre._emitWriteCount = 0;
    const dst = pre.gpuQueueBuffers[pre._queueBuf];
    new Uint32Array(dst.spriteStatic.buffer, dst.spriteStatic.byteOffset, dst.spriteStatic.length).fill(POISON);
    pre.packSpriteAndShadowQueues();
    const n = dst.header[GPU_HDR_SPRITE] | 0;
    const words = (v, k) => Uint32Array.from(new Uint32Array(v.buffer, v.byteOffset, k));
    out.push({
      n,
      flags: dst.header[GPU_HDR_FLAGS] | 0,
      gen: dst.header[GPU_HDR_STATIC_GEN] >>> 0,
      rows: words(dst.sprites, n * GPU_SPRITE_FLOATS),
      pose: words(dst.spritePose, n * GPU_POSE_FLOATS),
      stat: words(dst.spriteStatic, n * GPU_STATIC_FLOATS),
    });
    pre.publishFrame();
  });
  return out;
}

function compare(off, on, ySort) {
  const rewrote = [];
  for (let f = 0; f < FRAMES.length; f++) {
    const a = off[f];
    const b = on[f];
    assert.equal(b.n, a.n, `frame ${f}: rows`);
    assert.equal(a.flags & GPU_FLAG_SPLIT, 0, `frame ${f}: off writes 15-float rows`);
    assert.equal(b.flags & GPU_FLAG_SPLIT, GPU_FLAG_SPLIT, `frame ${f}: on says split`);
    assert.equal(b.gen, ySort ? 0 : FRAMES[f].gen, `frame ${f}: the statics' generation`);
    for (let k = 0; k < a.n; k++) {
      for (let j = 0; j < GPU_POSE_FLOATS; j++) {
        if (b.pose[k * GPU_POSE_FLOATS + j] !== a.rows[k * GPU_SPRITE_FLOATS + POSE_FROM_ROW[j]]) {
          assert.fail(`frame ${f} row ${k}: pose ${j}`);
        }
      }
    }
    const poisoned = b.stat.every((w) => w === POISON);
    if (!poisoned) {
      for (let k = 0; k < a.n; k++) {
        for (let j = 0; j < GPU_STATIC_FLOATS; j++) {
          if (b.stat[k * GPU_STATIC_FLOATS + j] !== a.rows[k * GPU_SPRITE_FLOATS + STATIC_FROM_ROW[j]]) {
            assert.fail(`frame ${f} row ${k}: static ${j}`);
          }
        }
      }
    }
    rewrote.push(!poisoned);
  }
  return rewrote;
}

test('pre-render writes the GPU queue in two streams, the statics only when a buffer lacks their generation', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const rewrote = compare(await run(pre, false), await run(pre, true), false);
  // Buffers alternate: each needs the generation once; a row count or generation change, or generation 0, again.
  assert.deepEqual(rewrote, [
    true, true, false, false, false,
    true, true, false, true, true,
    false, true, true, true, true,
  ]);
});

test('a painter-sorted frame writes both streams every time, with the terms of the 15-float rows', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const rewrote = compare(await run(pre, false, true), await run(pre, true, true), true);
  assert.ok(rewrote.every(Boolean), 'the order may move with the poses: no frame skips the statics');
});
