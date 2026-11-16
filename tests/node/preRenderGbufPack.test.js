// E-444, wired: pre-render's sprite G-buffer words through its real path (packSpriteAndShadowQueues on queues it writes
// in the render-queue memory, A and B in turn, gpuPack.wasm packing them). Where the split or indexed pack takes the
// columns it writes the words itself; every other frame gets writeGbufWords' as before. Either way the region holds, bit
// for bit, the words writeGbufWords writes for the frame's draw order from the collector's columns (pre-render's frame
// before E-444), GPU_FLAG_GBUF set; a frame whose queue rows are not the collector's sends none. The frames walk the
// pack's paths: unsorted (no list), the glow split's entity list, the painter's order through the gather (a short list),
// the split scatter and the indexed scatter (a long one), with zIndex bands and without, and the ones the kernel leaves
// to the JS: 15-float rows, selfShadow outside the memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ShadowCaster } from '../../src/components/shadowCaster.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { computeBufferSize, RENDER_QUEUE_CAMERA_BYTES } from '../../src/render/renderQueueLayout.js';
import {
  computeGpuQueueBufferSize, GPU_FLAG_GBUF, GPU_FLAG_INDEXED, GPU_FLAG_SORTED, GPU_FLAG_SPLIT, GPU_GBUF_FLOATS, GPU_HDR_FLAGS,
  GPU_HDR_SPRITE, gpuQueueCaps,
} from '../../src/render/gpuQueueLayout.js';
import { writeGbufWords } from '../../src/render/gbufWord.js';
import { spriteYSortKey } from '../../src/util/sortIndexByKey.js';
import { WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createRenderQueueMemory } from '../../src/util/renderQueueMemory.js';
import { coreComponentData, emitSpec, initWorker, loadWorker } from '../bench/workerHarness.mjs';

const MAX = 6000;
// Past 65535, so the ids wrap.
const ENTITIES = 70000;

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

/** Pre-render sorting (Y-sort, its painter state) on a render-queue memory with SpriteRenderer and ShadowCaster in it. */
async function initPreRender(pre) {
  const caps = gpuQueueCaps(MAX, { enabled: true }, true);
  const spec = emitSpec(ENTITIES, { casterBytes: ShadowCaster.getBufferSize(ENTITIES) });
  const m = createRenderQueueMemory(MAX, computeBufferSize(MAX), computeGpuQueueBufferSize(caps), spec, null, null, false, null,
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
    globalEntityCount: ENTITIES,
    buffers: {
      componentData: { ...coreComponentData(ENTITIES), SpriteRenderer: m.buffer },
      componentDataByte: { SpriteRenderer: m.layout.emit.spriteRendererByte },
    },
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
  // A lit scene's G-buffer (gbufWanted), and the casters' selfShadow column where the scene keeps it.
  pre._gbufOn = true;
  ShadowCaster.initializeArrays(m.buffer, ENTITIES, m.layout.emit.shadowCasterByte);
  return m;
}

/** A frame of `n` queue rows: pose, type (3 a glow), sort key, and the collector's row type and entity. */
function makeFrame(r, n, glowEvery) {
  const fr = {
    n, x: new Float32Array(n), y: new Float32Array(n), type: new Uint8Array(n), key: new Float32Array(n),
    rowType: new Uint8Array(n), rowEntity: new Int32Array(n),
  };
  let e = 0;
  for (let i = 0; i < n; i++) {
    fr.x[i] = r() * 4000;
    fr.y[i] = r() * 4000 - 600;
    fr.type[i] = glowEvery > 0 && i % glowEvery === 0 ? 3 : i % 17 === 0 ? 1 : 0;
    fr.key[i] = spriteYSortKey(fr.y[i], 128);
    // The collector: a sprite's entity, ascending with gaps, or another row (a decoration's, a particle's: no entity).
    e += 1 + ((r() * 12) | 0);
    if (fr.type[i] !== 0 || r() < 0.03) {
      fr.rowType[i] = 1 + ((r() * 3) | 0);
      fr.rowEntity[i] = (r() * 500) | 0;
    } else {
      fr.rowEntity[i] = e % ENTITIES;
    }
  }
  return fr;
}

function writeFrame(pre, fr) {
  const q = pre.renderQueueBuffers[pre._queueBuf];
  q.count[0] = fr.n;
  for (let i = 0; i < fr.n; i++) {
    q.x[i] = fr.x[i];
    q.y[i] = fr.y[i];
    q.scaleX[i] = 1;
    q.scaleY[i] = 1;
    q.rotC[i] = 1;
    q.rotS[i] = 0;
    q.alpha[i] = 1;
    q.tint[i] = 0xffffff;
    q.textureId[i] = i % 5;
    q.anchorX[i] = 0.5;
    q.anchorY[i] = 0.5;
    q.type[i] = fr.type[i];
    q.sortKey[i] = fr.key[i];
  }
  pre._renderableType.set(fr.rowType);
  pre._renderableIndex.set(fr.rowEntity);
  pre._collectedRows = fr.n;
  pre._emitWriteCount = 0;
  pre._frameGlowRows = fr.type.reduce((c, t) => c + (t === 3 ? 1 : 0), 0);
}

/** The exports of the pack binding that write the words, and the plain ones, counted. */
function countCalls(b) {
  const calls = {};
  for (const name of ['spritesSplit', 'spritesSplitScatter', 'spritesIndexedScatter', 'spritesSplitGbuf',
    'spritesSplitScatterGbuf', 'spritesIndexedScatterGbuf', 'sprites', 'spritesScatter']) {
    const real = b[name];
    calls[name] = 0;
    b[name] = (...args) => {
      calls[name]++;
      return real(...args);
    };
  }
  return calls;
}

test('E-444: pre-render\'s sprite G-buffer words, from the pack where it takes them and from writeGbufWords elsewhere, bit for bit', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const m = await initPreRender(pre);
  const r = rng(0xe444);
  assert.ok(pre._gpuPainter && pre._gpuPackWasm && pre._gpuIndexed, 'the painter, the pack and indexed frames');
  assert.equal(SpriteRenderer.gbufFlags.buffer, m.buffer, 'gbufFlags in the memory');
  assert.equal(ShadowCaster.selfShadow.buffer, m.buffer, 'selfShadow in the memory');
  const flags = SpriteRenderer.gbufFlags;
  const zIndex = SpriteRenderer.zIndex;
  const selfShadow = ShadowCaster.selfShadow;
  for (let e = 0; e < ENTITIES; e++) {
    flags[e] = (r() * 64) | 0;
    selfShadow[e] = (r() * 3) | 0;
    zIndex[e] = (r() * 4) | 0;
  }
  const calls = countCalls(pre._gpuPackWasm);
  pre._bindGpuPackWriters();
  let order = null;
  pre._gpuPackSpec.afterSprites = (n, idx) => {
    order = idx ? Uint32Array.from(idx.subarray(0, n)) : null;
  };
  const frames = [
    // [label, rows, glow every, sorted by the painter, indexed frames, zIndex users, the kernel writes the words]
    { what: 'unsorted, no list', n: MAX, glow: 0, sort: false, via: 'spritesSplitGbuf' },
    { what: 'unsorted, the glow split\'s list', n: MAX, glow: 11, sort: false, via: 'spritesSplitScatterGbuf' },
    { what: 'painter, a short list', n: 3000, glow: 0, sort: true, via: 'spritesSplitGbuf' },
    { what: 'painter, a short list, bands', n: 3000, glow: 13, sort: true, bands: true, via: 'spritesSplitGbuf' },
    { what: 'painter, indexed', n: MAX, glow: 0, sort: true, via: 'spritesIndexedScatterGbuf', flag: GPU_FLAG_INDEXED },
    { what: 'painter, indexed, bands', n: MAX, glow: 9, sort: true, bands: true, via: 'spritesIndexedScatterGbuf', flag: GPU_FLAG_INDEXED },
    { what: 'painter, split scatter', n: MAX, glow: 0, sort: true, indexed: false, via: 'spritesSplitScatterGbuf' },
    { what: 'painter, split scatter, bands', n: MAX, glow: 7, sort: true, indexed: false, bands: true, via: 'spritesSplitScatterGbuf' },
    { what: 'unsorted, bands asked but no order', n: MAX, glow: 0, sort: false, bands: true, via: 'spritesSplitGbuf' },
    { what: '15-float rows: the JS', n: MAX, glow: 0, sort: true, split: false, via: null },
    { what: 'selfShadow outside the memory: the JS', n: MAX, glow: 0, sort: true, selfOut: true, via: null },
    { what: 'queue rows not the collector\'s: no words', n: MAX, glow: 0, sort: true, notCollector: true, via: null },
  ];
  const zUsers = SpriteRenderer._zIndexUsers;
  const sortWas = pre._sortSprites;
  try {
    for (let round = 0; round < 2; round++) {
      for (const k of frames) {
        const label = `round ${round}, ${k.what}`;
        const fr = makeFrame(r, k.n, k.glow);
        pre.selectWriteBuffers();
        writeFrame(pre, fr);
        if (k.notCollector) pre._collectedRows = fr.n + 1;
        pre._sortSprites = k.sort ? sortWas : 'none';
        pre._gpuIndexed = k.indexed !== false;
        pre._gpuSplit = k.split !== false;
        if (k.selfOut) ShadowCaster.selfShadow = Uint8Array.from(selfShadow);
        Atomics.store(zUsers, 0, k.bands ? 1 : 0);
        const dst = pre.gpuQueueBuffers[pre._queueBuf];
        dst.spriteGbuf.fill(-7);
        for (const c of Object.keys(calls)) calls[c] = 0;
        order = null;
        pre.packSpriteAndShadowQueues();
        ShadowCaster.selfShadow = selfShadow;
        const n = dst.header[GPU_HDR_SPRITE] | 0;
        const hdr = dst.header[GPU_HDR_FLAGS] | 0;
        const glowRows = fr.type.reduce((c, t) => c + (t === 3 ? 1 : 0), 0);
        assert.equal(n, fr.n - glowRows, `${label}: the sprite rows`);
        if (k.flag) assert.ok(hdr & k.flag, `${label}: the frame's layout (0x${hdr.toString(16)})`);
        if (k.split !== false) assert.ok(hdr & (GPU_FLAG_SPLIT | GPU_FLAG_INDEXED), `${label}: split or indexed`);
        if (k.notCollector) {
          assert.equal(hdr & GPU_FLAG_GBUF, 0, `${label}: no GPU_FLAG_GBUF`);
          assert.ok(dst.spriteGbuf.subarray(0, 2 * n).every((v) => v === -7), `${label}: no words written`);
          continue;
        }
        assert.ok(hdr & GPU_FLAG_GBUF, `${label}: GPU_FLAG_GBUF`);
        const gbufCalls = calls.spritesSplitGbuf + calls.spritesSplitScatterGbuf + calls.spritesIndexedScatterGbuf;
        if (k.via) assert.ok(calls[k.via] > 0, `${label}: the words through ${k.via} (${JSON.stringify(calls)})`);
        else assert.equal(gbufCalls, 0, `${label}: no pack with the words (${JSON.stringify(calls)})`);
        const sorted = (hdr & GPU_FLAG_SORTED) !== 0 && k.bands === true;
        assert.equal((hdr & GPU_FLAG_SORTED) !== 0, k.sort, `${label}: sorted or not`);
        const want = new Float32Array(n * GPU_GBUF_FLOATS);
        writeGbufWords(want, n, order, fr.rowType, fr.rowEntity, null, flags.length, flags, selfShadow, sorted ? zIndex : null);
        const got = new Uint32Array(dst.spriteGbuf.buffer, dst.spriteGbuf.byteOffset, n * GPU_GBUF_FLOATS);
        const wantBits = new Uint32Array(want.buffer);
        for (let w = 0; w < n * GPU_GBUF_FLOATS; w++) {
          if (got[w] !== wantBits[w]) {
            assert.fail(`${label}: slot ${w >> 1} ${w & 1 ? 'band' : 'word'}: ${dst.spriteGbuf[w]}, not ${want[w]}`);
          }
        }
        if (sorted) assert.ok(want[2 * n - 1] > 0, `${label}: bands`);
        pre.publishFrame();
      }
    }
  } finally {
    Atomics.store(zUsers, 0, 0);
    pre._sortSprites = sortWas;
    pre._gpuIndexed = true;
    pre._gpuSplit = true;
    ShadowCaster.selfShadow = selfShadow;
  }
});
