// E-162, wired: pre-render's GPU queue as indexed frames, through its real pack path on queues it writes in the
// render-queue memory, A and B in turn. With caps.indexedSprites a painter-sorted frame (its keys move every frame)
// says GPU_FLAG_INDEXED, the queue's rows and the queue's statics generation; at each draw slot the pose and the slot
// pair (a row, a depth) give back, with that row's statics, the 15-float row the same frame packs unsplit; and a GPU
// queue buffer's statics are rewritten only when it does not hold the queue's generation for the same rows: the
// painter's order moves none of them. A split frame in between lies over a buffer's statics, and the next indexed
// frame in that buffer writes them again.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeBufferSize, RENDER_QUEUE_CAMERA_BYTES } from '../../src/render/renderQueueLayout.js';
import {
  GPU_FLAG_INDEXED,
  GPU_FLAG_SPLIT,
  GPU_HDR_FLAGS,
  GPU_HDR_INDEXED_ROWS,
  GPU_HDR_SPRITE,
  GPU_HDR_STATIC_GEN,
  GPU_INDEXED_SLOT_FLOATS,
  GPU_INDEXED_STATIC_FLOATS,
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

// Past SCATTER_MIN_ROWS, which the indexed kernel needs.
const MAX = 6000;
const POSE_FROM_ROW = [0, 1, 6, 7];
const STATIC_FROM_ROW = [2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14];
const DEPTH = 4; // the depth among the statics
const POISON = 0x7fc0dead;

// Each frame: the rows' count, the queue's staticGen, whether its statics changed (a scale moves), and whether
// pre-render packs it split (indexed frames off for it).
const FRAMES = [
  { n: 5000, gen: 7 }, { n: 5000, gen: 7 }, { n: 5000, gen: 7 }, { n: 5000, gen: 7 }, { n: 5000, gen: 7 },
  { n: 5000, gen: 8, scale: 2 }, { n: 5000, gen: 8 }, { n: 5000, gen: 8 }, { n: 4900, gen: 8 }, { n: 4900, gen: 8 },
  { n: 4900, gen: 8 }, { n: 4900, gen: 0 }, { n: 4900, gen: 0 }, { n: 4900, gen: 9 }, { n: 4900, gen: 9 },
  { n: 4900, gen: 9, split: true }, { n: 4900, gen: 9 }, { n: 4900, gen: 9 }, { n: 4900, gen: 9 },
];

function writeQueue(q, fr, f, ySort) {
  q.count[0] = fr.n;
  q.staticGen[0] = fr.gen;
  for (let i = 0; i < fr.n; i++) {
    q.x[i] = (i % 97) * 30 + f * 1.5;
    q.y[i] = ((i * 37) % 3000) - f * ((i % 3) + 1);
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

const words = (v, k) => Uint32Array.from(new Uint32Array(v.buffer, v.byteOffset, k));

async function run(pre, indexed, ySort = true) {
  const caps = gpuQueueCaps(MAX, { enabled: false }, true);
  const m = createRenderQueueMemory(MAX, computeBufferSize(MAX), computeGpuQueueBufferSize(caps), emitSpec(64), null, null, false, null,
    ySort ? { preRender: true, pixi: false } : null);
  await initWorker(pre, {
    config: {
      worldWidth: 4000,
      worldHeight: 4000,
      renderer: { ySort, backend: 'webgl', indexedSprites: true },
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
  // The reference run: the same frames as 15-float rows.
  if (!indexed) {
    pre._gpuSplit = false;
    pre._gpuIndexed = false;
  }
  const out = [];
  FRAMES.forEach((fr, f) => {
    if (indexed) pre._gpuIndexed = !fr.split;
    pre.selectWriteBuffers();
    writeQueue(pre.renderQueueBuffers[pre._queueBuf], fr, f, ySort);
    pre._emitWriteCount = 0;
    const dst = pre.gpuQueueBuffers[pre._queueBuf];
    new Uint32Array(dst.spriteRowStatics.buffer, dst.spriteRowStatics.byteOffset, dst.spriteRowStatics.length).fill(POISON);
    pre.packSpriteAndShadowQueues();
    const n = dst.header[GPU_HDR_SPRITE] | 0;
    out.push({
      n,
      flags: dst.header[GPU_HDR_FLAGS] | 0,
      gen: dst.header[GPU_HDR_STATIC_GEN] >>> 0,
      indexedRows: dst.header[GPU_HDR_INDEXED_ROWS] | 0,
      rows: words(dst.sprites, n * GPU_SPRITE_FLOATS),
      pose: words(dst.spritePose, n * GPU_POSE_FLOATS),
      slots: Float32Array.from(dst.spriteSlots.subarray(0, n * GPU_INDEXED_SLOT_FLOATS)),
      slotWords: words(dst.spriteSlots, n * GPU_INDEXED_SLOT_FLOATS),
      stat: words(dst.spriteRowStatics, fr.n * GPU_INDEXED_STATIC_FLOATS),
    });
    pre.publishFrame();
  });
  return out;
}

test('pre-render sends a painter-sorted frame indexed: each slot\'s pose and row give back the 15-float row, and a buffer\'s statics are rewritten only when it lacks their generation', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const off = await run(pre, false);
  const on = await run(pre, true);
  const rewrote = [];
  for (let f = 0; f < FRAMES.length; f++) {
    const a = off[f];
    const b = on[f];
    const fr = FRAMES[f];
    assert.equal(b.n, a.n, `frame ${f}: rows`);
    assert.equal(a.flags & (GPU_FLAG_SPLIT | GPU_FLAG_INDEXED), 0, `frame ${f}: the reference writes 15-float rows`);
    if (fr.split) {
      assert.equal(b.flags & (GPU_FLAG_SPLIT | GPU_FLAG_INDEXED), GPU_FLAG_SPLIT, `frame ${f}: split`);
      assert.equal(b.indexedRows, 0, `frame ${f}: no indexed rows`);
      rewrote.push('split');
      continue;
    }
    assert.equal(b.flags & (GPU_FLAG_SPLIT | GPU_FLAG_INDEXED), GPU_FLAG_INDEXED, `frame ${f}: indexed`);
    assert.equal(b.indexedRows, fr.n, `frame ${f}: the statics cover every queue row`);
    assert.equal(b.gen, fr.gen, `frame ${f}: the queue's own generation, whatever the order`);
    const poisoned = b.stat.every((w) => w === POISON);
    const seen = new Uint8Array(fr.n);
    for (let k = 0; k < a.n; k++) {
      for (let j = 0; j < GPU_POSE_FLOATS; j++) {
        if (b.pose[k * GPU_POSE_FLOATS + j] !== a.rows[k * GPU_SPRITE_FLOATS + POSE_FROM_ROW[j]]) {
          assert.fail(`frame ${f} slot ${k}: pose ${j}`);
        }
      }
      const row = b.slots[k * GPU_INDEXED_SLOT_FLOATS];
      if (!Number.isInteger(row) || row < 0 || row >= fr.n || seen[row]) assert.fail(`frame ${f} slot ${k}: row ${row}`);
      seen[row] = 1;
      if (b.slotWords[k * GPU_INDEXED_SLOT_FLOATS + 1] !== a.rows[k * GPU_SPRITE_FLOATS + STATIC_FROM_ROW[DEPTH]]) {
        assert.fail(`frame ${f} slot ${k}: depth`);
      }
      if (poisoned) continue;
      for (let j = 0; j < GPU_STATIC_FLOATS; j++) {
        const want = j === DEPTH ? 0 : a.rows[k * GPU_SPRITE_FLOATS + STATIC_FROM_ROW[j]];
        if (b.stat[row * GPU_INDEXED_STATIC_FLOATS + j] !== want) assert.fail(`frame ${f} slot ${k} (row ${row}): static ${j}`);
      }
    }
    rewrote.push(!poisoned);
  }
  // Buffers alternate: each needs the generation once; a row count or generation change, or generation 0, again.
  // The keys move every frame and rewrite nothing. After the split frame its buffer needs them again; the other not.
  assert.deepEqual(rewrote, [
    true, true, false, false, false,
    true, true, false, true, true,
    false, true, true, true, true,
    'split', false, true, false,
  ]);
});

test('an unsorted frame stays split with indexed frames on', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const on = await run(pre, true, false);
  for (let f = 0; f < FRAMES.length; f++) {
    assert.equal(on[f].flags & (GPU_FLAG_SPLIT | GPU_FLAG_INDEXED), GPU_FLAG_SPLIT, `frame ${f}: split`);
    assert.equal(on[f].indexedRows, 0, `frame ${f}: no indexed rows`);
  }
});
