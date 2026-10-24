// E-112 (W4a): the emit kernel (preRenderEmit.wasm, through preRenderEmitClient.js) against the shipped
// PreRenderWorker.emitSpriteQueue on a real worker, every column in the render-queue memory as the scene
// lays it out. Both sides start from the same state and run 30 frames; for every frame the kernel's sprite
// and decoration rows, the animation state (frame, clock, last texture, bounds), the play-once ends and
// the missing-texture warnings must be what the JS made, and the rows of other types must be listed and
// left alone. The mix covers what the kernel copies from the JS: tiled sprites (world and local) and the
// tiles-dirty frames after them, sprites without an animation or a first frame, play-once ends, zIndex,
// Y-sort on and off, NaN and -0 shadow terms, decorations with and without a texture, and a collector
// longer than the queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { ShadowCaster } from '../../src/components/shadowCaster.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { BulletComponent } from '../../src/components/bulletComponent.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { Layer } from '../../src/core/layer.js';
import { computeBufferSize, RENDER_QUEUE_CAMERA_BYTES } from '../../src/render/renderQueueLayout.js';
import { computeGpuQueueBufferSize, gpuQueueCaps } from '../../src/render/gpuQueueLayout.js';
import { createRenderQueueMemory } from '../../src/util/renderQueueMemory.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import {
  bindPreRenderEmit,
  EMIT_BOUNDS,
  EMIT_DECLINED,
  EMIT_PERSIST_MISS,
  EMIT_SORT_KEY,
  EMIT_TILES_DIRTY,
  EMIT_WARN_DECO_START,
  EMIT_WARN_NO_ANIM,
  EMIT_WARN_NO_START,
  EMIT_Y_SORT,
  writeEmitColumns,
  writeEmitTextures,
  writePersistColumns,
} from '../../src/workers/preRenderEmitClient.js';
import { bindPoseColumns, coreComponentData, initWorker, loadWorker } from '../bench/workerHarness.mjs';

const N = 700;
const DECOS = 300;
const MAX = 900;
const DT = 1000 / 60;
const FRAMES = 30;
const POOL = 64;

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

/** Sheets 1-3 with 1-, 2-, 5- and 13-frame animations, frame sizes that change from frame to frame. */
function textureMetadata() {
  const animationFrameStart = [];
  const animationFrameCount = [];
  const widths = [];
  const heights = [];
  const proxyToGlobalAnim = {};
  let offset = 0;
  for (let sheet = 1; sheet <= 3; sheet++) {
    proxyToGlobalAnim[sheet] = {};
    [1, 2, 5, 13].forEach((frames, local) => {
      proxyToGlobalAnim[sheet][local] = animationFrameStart.length;
      animationFrameStart.push(offset);
      animationFrameCount.push(frames);
      for (let f = 0; f < frames; f++) {
        widths.push(16 + ((sheet * 7 + local * 3 + f * 5) % 50));
        heights.push(20 + ((sheet * 11 + f * 3) % 40));
      }
      offset += frames;
    });
  }
  // Sheet 4: state 0 maps past the last animation (no first frame), state 1 to nothing at all.
  proxyToGlobalAnim[4] = { 0: animationFrameStart.length + 5 };
  const animationNameToIndex = {};
  for (const name of ['_lightGradient', '_whiteCircle', '_bulletTrail']) {
    animationNameToIndex[name] = animationFrameStart.length;
    animationFrameStart.push(offset);
    animationFrameCount.push(1);
    widths.push(64);
    heights.push(64);
    offset += 1;
  }
  return {
    animationFrameStart,
    animationFrameCount,
    proxyToGlobalAnim,
    animationNameToIndex,
    totalFrames: offset,
    frameWidth: Uint16Array.from(widths),
    frameHeight: Uint16Array.from(heights),
  };
}

async function setup({ ySort, maxItems = MAX, count = MAX, seed = 0x5eed, persist = false }) {
  const caps = gpuQueueCaps(maxItems, { enabled: false });
  const m = createRenderQueueMemory(maxItems, computeBufferSize(maxItems), computeGpuQueueBufferSize(caps), {
    entities: N,
    spriteBytes: SpriteRenderer.getBufferSize(N),
    casterBytes: ShadowCaster.getBufferSize(N),
    decorationBytes: DecorationComponent.getBufferSize(DECOS),
  });
  const e = m.layout.emit;
  const buffers = {
    componentData: {
      ...coreComponentData(N),
      SpriteRenderer: m.buffer,
      ShadowCaster: m.buffer,
      DecorationComponent: m.buffer,
      // What the rows of other types read in the JS run (the kernel leaves those rows to it).
      LightEmitter: new SharedArrayBuffer(LightEmitter.getBufferSize(N)),
      ParticleComponent: new SharedArrayBuffer(ParticleComponent.getBufferSize(POOL)),
      BulletComponent: new SharedArrayBuffer(BulletComponent.getBufferSize(POOL)),
    },
    componentDataByte: { SpriteRenderer: e.spriteRendererByte, ShadowCaster: e.shadowCasterByte, DecorationComponent: e.decorationByte },
  };
  for (const C of [SpriteRenderer, ShadowCaster, DecorationComponent]) C.clearArrays();
  const meta = textureMetadata();
  const worker = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  await initWorker(worker, {
    config: { worldWidth: 4000, worldHeight: 3000, preRender: { interpolation: false }, renderer: { ySort } },
    globalEntityCount: N,
    buffers,
    extra: {
      maxDecorations: DECOS,
      maxParticles: POOL,
      maxBullets: POOL,
      textureMetadata: meta,
      renderQueueMemory: m.memory,
      renderQueueLayout: m.layout,
      renderQueue: {
        maxItems,
        sync: new SharedArrayBuffer(8),
        dataA: m.buffer,
        dataAByte: m.layout.queueAByte,
        dataB: m.buffer,
        dataBByte: m.layout.queueBByte,
        cameraA: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
        cameraB: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
        entityTextureData: m.buffer,
        entityTextureByte: e.lastTextureByte,
      },
    },
  });
  bindPoseColumns(N);
  assert.equal(SpriteRenderer.scaleX.buffer, m.buffer, 'SpriteRenderer is in the memory');
  assert.equal(worker._renderableType.buffer, m.buffer, 'the collector is in the memory');
  worker._decorationZoomAlpha = 0.75;
  worker._animEndByType = new Uint8Array(256).fill(1);

  const r = rng(seed);
  const sr = SpriteRenderer;
  for (let i = 0; i < N; i++) {
    sr.active[i] = 1;
    sr.scaleX[i] = i % 31 === 0 ? -1.25 : 0.5 + r();
    sr.scaleY[i] = i % 37 === 0 ? 0 : 0.5 + r();
    sr.alpha[i] = r();
    sr.tint[i] = (r() * 0xffffff) >>> 0;
    sr.anchorX[i] = r();
    sr.anchorY[i] = r();
    sr.inheritTransformRotation[i] = i % 3 === 0 ? 0 : 1;
    sr.spriteRotC[i] = Math.cos(i);
    sr.spriteRotS[i] = Math.sin(i);
    sr.zIndex[i] = (i % 5) - 2;
    // Tiled sprites, world and local; every other one is stretched.
    sr.repeatX[i] = i % 17 === 0 ? 32 : 0;
    sr.repeatY[i] = i % 23 === 0 ? 48 : 0;
    sr.tileMode[i] = i % 2 ? 2 : 1;
    sr.tileOffsetU[i] = (i * 977) & 0xffff;
    sr.tileOffsetV[i] = (i * 331) & 0xffff;
    sr.boundsHalfW[i] = 10 + (i % 40);
    sr.boundsHalfH[i] = 12 + (i % 30);
    // Sheets 1-3 with every state, sheet 4 (no first frame / no animation), sheet 0 (unset).
    sr.spritesheetId[i] = i % 41 === 0 ? 0 : i % 29 === 0 ? 4 : 1 + (i % 3);
    sr.animationState[i] = sr.spritesheetId[i] === 4 ? (i & 1) : i % 4;
    sr.isAnimated[i] = i % 7 === 0 ? 0 : 1;
    sr.animationSpeed[i] = 0.1 + r() * 0.9;
    sr.loop[i] = i % 11 === 0 ? 0 : 1;
    ShadowCaster.active[i] = i % 4 === 0 ? 0 : 1;
    ShadowCaster.heightMultiplier[i] = i % 13 === 0 ? NaN : i % 19 === 0 ? -0 : r() * 2;
    ShadowCaster.anchorOffsetX[i] = i % 9 === 0 ? -0 : r();
    ShadowCaster.anchorOffsetY[i] = i % 10 === 0 ? NaN : r();
    worker.entityFrameIndex[i] = (i * 7) % 15;
    worker.entityFrameAccumulator[i] = r() * 0.2;
  }
  const meta2 = meta;
  for (let d = 0; d < DECOS; d++) {
    DecorationComponent.scaleX[d] = r();
    DecorationComponent.scaleY[d] = r();
    DecorationComponent.alpha[d] = r();
    DecorationComponent.tint[d] = (r() * 0xffffff) >>> 0;
    DecorationComponent.textureId[d] = d % 47 === 0 ? meta2.animationFrameStart.length + 9 : d % 12;
    DecorationComponent.anchorX[d] = r();
    DecorationComponent.anchorY[d] = r();
  }

  // The collector: sprites, decorations and a few rows of other types, poses in the queue (E-98d).
  const types = [];
  const indices = [];
  for (let k = 0; k < count; k++) {
    const pick = r();
    if (pick < 0.62) { types.push(0); indices.push(Math.floor(r() * N)); }
    else if (pick < 0.92) { types.push(2); indices.push(Math.floor(r() * DECOS)); }
    else { types.push([1, 3, 4, 5][k % 4]); indices.push(k % POOL); }
  }
  const qViews = () => ({ x: worker.renderQueueX, y: worker.renderQueueY, rc: worker.renderQueueRotC, rs: worker.renderQueueRotS });
  const q = qViews();
  for (let k = 0; k < count; k++) {
    worker._renderableType[k] = types[k];
    worker._renderableIndex[k] = indices[k];
    worker._renderableY[k] = Math.round(r() * 3000) * 128 + (k % 3 === 0 ? -0 : 0);
    q.x[k] = r() * 4000;
    q.y[k] = r() * 3000;
    q.rc[k] = Math.cos(k);
    q.rs[k] = Math.sin(k);
  }
  const source = worker._fillEmitSource(count, maxItems, worker._renderableY, worker._renderableType, worker._renderableIndex,
    q.x, q.y, q.rc, q.rs, persist, true, ySort);

  // Everything either side writes, to put back between the two runs.
  const state = [
    worker.entityFrameIndex, worker.entityFrameAccumulator, worker.entityLastTextureId,
    SpriteRenderer.boundsHalfW, SpriteRenderer.boundsHalfH,
  ];
  const queueBytes = new Uint8Array(m.buffer, m.layout.queueAByte, computeBufferSize(maxItems));
  const snapshot = () => ({
    queue: queueBytes.slice(),
    state: state.map((a) => a.slice()),
    tiled: new Set(worker._tiledTileColumns),
  });
  const restore = (s) => {
    queueBytes.set(s.queue);
    state.forEach((a, k) => a.set(s.state[k]));
    worker._tiledTileColumns = new Set(s.tiled);
  };

  const b = await bindPreRenderEmit(m.memory, e);
  assert.ok(writeEmitTextures(b, meta), 'the metadata fits the tables');
  return { worker, m, b, source, types, count, maxItems, snapshot, restore, ySort };
}

/** The queue columns a row has. */
const ROW_COLUMNS = [
  'renderQueueX', 'renderQueueY', 'renderQueueScaleX', 'renderQueueScaleY', 'renderQueueRotC', 'renderQueueRotS',
  'renderQueueAlpha', 'renderQueueTint', 'renderQueueTextureId', 'renderQueueAnchorX', 'renderQueueAnchorY',
  'renderQueueType', 'renderQueueSortKey', 'renderQueueRepeatX', 'renderQueueRepeatY', 'renderQueueTileMode',
  'renderQueueTileOffsetU', 'renderQueueTileOffsetV', 'renderQueueTileMulX', 'renderQueueTileMulY',
  'renderQueueShadowH', 'renderQueueShadowOffX', 'renderQueueShadowOffY',
];

function hex(bytes, at, n) {
  return [...bytes.subarray(at, at + n)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function runCase(t, opts) {
  const k = await setup(opts);
  const { worker, b, source, types, count, maxItems } = k;
  const n = Math.min(count, maxItems);
  const start = k.snapshot();

  // The JS: 30 frames, the queue and the state after each, the ends and warnings it made. The worker
  // bound the kernel at init; unbound, emitSpriteQueue is the JS loop.
  worker._emitWasm = null;
  const jsFrames = [];
  const ends = [];
  const warns = [];
  const realEnded = worker._spriteAnimationEnded;
  const realWarn = worker._warnMissingTexture;
  worker._spriteAnimationEnded = (idx, anim) => ends.push(`${idx}:${anim}`);
  worker._warnMissingTexture = (key) => warns.push(key);
  for (let f = 0; f < FRAMES; f++) {
    ends.length = 0;
    warns.length = 0;
    const written = worker.emitSpriteQueue(DT, source);
    assert.equal(written, n);
    jsFrames.push({ snap: k.snapshot(), ends: [...ends].sort(), warns: warns.filter((w) => !w.startsWith('name:')).sort() });
  }
  worker._spriteAnimationEnded = realEnded;
  worker._warnMissingTexture = realWarn;

  // The kernel from the same start. Rows of other types hold a marker it must not change.
  k.restore(start);
  const marker = 0x5a;
  for (let r = 0; r < n; r++) {
    if (types[r] === 0 || types[r] === 2) continue;
    for (const c of ROW_COLUMNS) {
      const v = worker[c];
      if (v) new Uint8Array(v.buffer, v.byteOffset + r * v.BYTES_PER_ELEMENT, v.BYTES_PER_ELEMENT).fill(marker);
    }
  }
  // L1: the regions the kernel must never write hold a canary through every frame.
  const L = k.m.layout;
  const queueSize = computeBufferSize(maxItems);
  const untouched = [
    ['guard', 0, L.queueAByte],
    ['queueB', L.queueBByte, queueSize],
    ['gpu queues and the pack scratch', L.gpuAByte, L.emit.spriteRendererByte - L.gpuAByte],
  ].map(([name, at, bytes]) => [name, new Uint8Array(k.m.buffer, at, bytes)]);
  for (const [, bytes] of untouched) bytes.fill(0xa5);
  const results = b.results;
  for (let f = 0; f < FRAMES; f++) {
    assert.ok(writeEmitColumns(b, worker, SpriteRenderer, ShadowCaster, DecorationComponent, source), 'every column is in the memory');
    const tilesDirty = worker.renderQueueTileMode !== null && worker._tiledTileColumns.has(worker.renderQueueTileMode);
    const flags = EMIT_SORT_KEY | (k.ySort ? EMIT_Y_SORT : 0) | (tilesDirty ? EMIT_TILES_DIRTY : 0) | EMIT_BOUNDS;
    const written = b.emitRows(b.tableByte, count, maxItems, flags, DT / 1000, worker._decorationZoomAlpha, worker._zBand);
    assert.notEqual(written, EMIT_DECLINED);
    assert.equal(written, n, `frame ${f}: rows written`);
    if (results[2] && worker.renderQueueTileMode !== null) worker._tiledTileColumns.add(worker.renderQueueTileMode);
    const js = jsFrames[f];
    // State: every entity, every frame.
    const now = k.snapshot();
    for (let s = 0; s < now.state.length; s++) {
      assert.deepEqual(Buffer.from(now.state[s].buffer, now.state[s].byteOffset, now.state[s].byteLength),
        Buffer.from(js.snap.state[s].buffer, js.snap.state[s].byteOffset, js.snap.state[s].byteLength), `frame ${f}: state ${s}`);
    }
    // Rows: sprites and decorations equal to the JS's, bit for bit; the others untouched and listed.
    const foreign = [];
    for (let r = 0; r < results[3]; r++) foreign.push(b.u32[b.foreignAt + r]);
    const expectForeign = [];
    for (let r = 0; r < n; r++) if (types[r] !== 0 && types[r] !== 2) expectForeign.push(r);
    assert.deepEqual(foreign, expectForeign, `frame ${f}: the rows left to the JS`);
    const qa = k.m.layout.queueAByte;
    for (let r = 0; r < n; r++) {
      const ours = types[r] === 0 || types[r] === 2;
      for (const c of ROW_COLUMNS) {
        const v = worker[c];
        if (!v) continue;
        const bpe = v.BYTES_PER_ELEMENT;
        const at = v.byteOffset - qa + r * bpe;
        for (let x = 0; x < bpe; x++) {
          const got = now.queue[at + x];
          if (ours && got !== js.snap.queue[at + x]) {
            assert.fail(`frame ${f} row ${r} (type ${types[r]}) ${c}: ${hex(now.queue, at, bpe)}, the JS wrote ${hex(js.snap.queue, at, bpe)}`);
          }
          if (!ours && got !== marker) assert.fail(`frame ${f} row ${r} (type ${types[r]}) ${c} was written`);
        }
      }
    }
    // Ends and warnings: the JS's, from the kernel's lists.
    const kEnds = [];
    for (let r = 0; r < results[0]; r++) kEnds.push(`${b.u32[b.endsAt + 2 * r]}:${b.u32[b.endsAt + 2 * r + 1]}`);
    assert.deepEqual(kEnds.sort(), js.ends, `frame ${f}: play-once ends`);
    const kWarns = [];
    for (let r = 0; r < results[1]; r++) {
      const idx = b.u32[b.warnsAt + 2 * r];
      const kind = b.u32[b.warnsAt + 2 * r + 1];
      kWarns.push(warnKey(worker, idx, kind));
    }
    assert.deepEqual(kWarns.sort(), js.warns, `frame ${f}: warnings`);
  }
  for (const [name, bytes] of untouched) {
    const at = bytes.findIndex((x) => x !== 0xa5);
    assert.equal(at, -1, `the kernel wrote ${name} (byte ${at})`);
  }
  t.diagnostic(`${n} rows, ${jsFrames.reduce((s, x) => s + x.ends.length, 0)} ends, ${jsFrames[0].warns.length} warnings a frame`);
}

/** The key the JS warns under, for a kernel warning. */
function warnKey(worker, idx, kind) {
  if (kind === EMIT_WARN_NO_ANIM) return `sprite:${SpriteRenderer.spritesheetId[idx]}:${SpriteRenderer.animationState[idx]}`;
  if (kind === EMIT_WARN_NO_START) {
    const g = worker.proxyToGlobalAnim[SpriteRenderer.spritesheetId[idx]][SpriteRenderer.animationState[idx]];
    return `animStart:${g}`;
  }
  if (kind === EMIT_WARN_DECO_START) return `frameStart:decoration:${DecorationComponent.textureId[idx]}`;
  return `kind ${kind}`;
}

test('the emit kernel writes what emitSpriteQueue writes, Y-sorted', async (t) => {
  await runCase(t, { ySort: true });
});

test('the emit kernel writes what emitSpriteQueue writes, without Y-sort', async (t) => {
  await runCase(t, { ySort: false, seed: 0xbeef });
});

test('the emit kernel fills a queue to its capacity', async (t) => {
  await runCase(t, { ySort: true, maxItems: 600, count: 600, seed: 0xfeed });
});

test('a frame with an Adobe root or a LiquidFun row is declined before anything is written', async () => {
  const k = await setup({ ySort: true });
  const { worker, b, source } = k;
  for (const type of [6, 7]) {
    worker._renderableType[17] = type;
    const before = k.snapshot();
    assert.ok(writeEmitColumns(b, worker, SpriteRenderer, ShadowCaster, DecorationComponent, source));
    const written = b.emitRows(b.tableByte, source.count, source.maxItems, EMIT_SORT_KEY | EMIT_Y_SORT | EMIT_BOUNDS, DT / 1000, 1, worker._zBand);
    assert.equal(written, EMIT_DECLINED, `type ${type}`);
    const after = k.snapshot();
    assert.deepEqual(Buffer.from(after.queue), Buffer.from(before.queue), 'the queue is untouched');
    after.state.forEach((a, s) => assert.deepEqual(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(before.state[s].buffer, before.state[s].byteOffset, before.state[s].byteLength)));
  }
});

test('a column outside the memory makes the table refuse, so the JS emits', async () => {
  const k = await setup({ ySort: true });
  const { worker, b, source } = k;
  const saved = SpriteRenderer.alpha;
  SpriteRenderer.alpha = new Float32Array(N);
  assert.equal(writeEmitColumns(b, worker, SpriteRenderer, ShadowCaster, DecorationComponent, source), false);
  SpriteRenderer.alpha = saved;
  assert.equal(writeEmitColumns(b, worker, SpriteRenderer, ShadowCaster, DecorationComponent, source), true);
});

test('emitSpriteQueue through the kernel writes every row the JS loop writes, other types included', async (t) => {
  for (const ySort of [true, false]) {
    const k = await setup({ ySort, seed: ySort ? 0xc0ffee : 0xdecade });
    const { worker, source } = k;
    const bound = worker._emitWasm;
    assert.ok(bound, 'the worker bound the kernel at init');
    assert.ok(bound.texturesReady, 'and wrote the metadata tables');
    let kernelCalls = 0;
    const realRows = bound.emitRows;
    bound.emitRows = (...args) => {
      kernelCalls++;
      return realRows(...args);
    };
    const start = k.snapshot();
    const realEnded = worker._spriteAnimationEnded;
    const realWarn = worker._warnMissingTexture;
    const run = (kernel) => {
      worker._emitWasm = kernel;
      const frames = [];
      for (let f = 0; f < FRAMES; f++) {
        const ends = [];
        const warns = [];
        worker._spriteAnimationEnded = (idx, anim) => ends.push(`${idx}:${anim}`);
        worker._warnMissingTexture = (key) => warns.push(key);
        const written = worker.emitSpriteQueue(DT, source);
        frames.push({ written, snap: k.snapshot(), ends, warns: warns.sort() });
      }
      worker._spriteAnimationEnded = realEnded;
      worker._warnMissingTexture = realWarn;
      return frames;
    };
    const js = run(null);
    k.restore(start);
    const wasm = run(bound);
    assert.equal(kernelCalls, FRAMES, 'the kernel took every frame');
    for (let f = 0; f < FRAMES; f++) {
      assert.equal(wasm[f].written, js[f].written, `frame ${f}: rows`);
      const a = wasm[f].snap.queue;
      const b = js[f].snap.queue;
      const at = a.findIndex((x, i) => x !== b[i]);
      assert.equal(at, -1, `frame ${f}: the queue differs at byte ${at}`);
      wasm[f].snap.state.forEach((v, s2) => {
        assert.deepEqual(Buffer.from(v.buffer, v.byteOffset, v.byteLength), Buffer.from(js[f].snap.state[s2].buffer, js[f].snap.state[s2].byteOffset, js[f].snap.state[s2].byteLength), `frame ${f}: state ${s2}`);
      });
      assert.deepEqual([...wasm[f].snap.tiled], [...js[f].snap.tiled], `frame ${f}: tiled columns`);
      assert.deepEqual(wasm[f].ends, js[f].ends, `frame ${f}: play-once ends, in order`);
      assert.deepEqual(wasm[f].warns, js[f].warns, `frame ${f}: warnings`);
    }
    t.diagnostic(`ySort ${ySort}: ${js[0].written} rows, ${k.types.filter((x) => x !== 0 && x !== 2).length} of other types`);
  }
});

// W4c: the persist path. Frame after frame on alternating queue buffers, the kernel's persist_check,
// persist_poses and persist_remember against the shipped _type0PersistHit, _writeType0PosesOnly and
// _rememberType0Set, with what makes a frame miss scheduled in: dirty sprites (and the other buffer's
// full emit they force), a changed animation, swapped collector rows, a frame past its animation's end
// (the repair misses) and an Adobe root. The full emit a miss leads to is left out on both sides.
const PERSIST_FRAMES = 40;

/** The regions the persist path writes, as [name, byte, bytes]. */
function persistRegions(m, maxItems) {
  const L = m.layout;
  const e = L.emit;
  const q = computeBufferSize(maxItems);
  const n = e.persistRows;
  return [
    ['queueA', L.queueAByte, q], ['queueB', L.queueBByte, q],
    ['spriteRenderer', e.spriteRendererByte, SpriteRenderer.getBufferSize(N)],
    ['frame', e.frameByte, N * 2], ['accum', e.accumByte, N * 4], ['lastTexture', e.lastTextureByte, N * 2],
    ['persistType', e.persistTypeByte, 2 * n], ['persistEntity', e.persistEntityByte, 8 * n],
    ['persistFrame', e.persistFrameByte, 4 * n], ['persistAnim', e.persistAnimByte, 4 * n],
  ];
}

/** Run fn with an order on the entity queue (a zIndex user, and Y-sort on the entities layer when ySort). */
async function withPersistOrder(ySort, fn) {
  // Sort keys on persist frames need an order: a zIndex user, and Y-sort on the entities layer.
  SpriteRenderer._zIndexUsers[0] = 1;
  const savedLayer = [Layer._ySorting, Layer.entitiesId];
  if (ySort) {
    Layer._ySorting = new Uint8Array(32);
    Layer.entitiesId = 0;
    Layer._ySorting[0] = 1;
  }
  try {
    await fn();
  } finally {
    [Layer._ySorting, Layer.entitiesId] = savedLayer;
  }
}

/**
 * The persist cases' frames: prepare(f) flips to buffer f & 1, writes the frame's poses into the stash
 * (the queue's own columns, E-98d, or the other buffer's), changes shadow casters with no dirty flag (the
 * persist frames must refresh their terms) and makes what misses on schedule: dirty sprites, a changed
 * animation, swapped collector rows, a frame past its animation's end and, with adobe, an Adobe root for
 * six frames. Some animated sprites get NaN clocks first (the persist path
 * advances them on every frame, !(clock < duration); the full emit never does). The same calls give the
 * same frames on both runs.
 */
function persistSchedule(k, { inQueue, seed, adobe }) {
  const { worker, count } = k;
  const cType = worker._renderableType;
  const cIndex = worker._renderableIndex;
  const sprites = [];
  for (let r = 0; r < count; r++) if (cType[r] === 0) sprites.push(r);
  for (const r of sprites.slice(0, 60)) if (SpriteRenderer.isAnimated[cIndex[r]]) SpriteRenderer.animationSpeed[cIndex[r]] = NaN;
  const animatedRow = sprites.find((r) => SpriteRenderer.isAnimated[cIndex[r]] && SpriteRenderer.spritesheetId[cIndex[r]] === 2
    && SpriteRenderer.animationState[cIndex[r]] === 3);
  assert.ok(animatedRow !== undefined, 'a sprite with a 13-frame animation');
  return (f) => {
    const buf = f & 1;
    worker._queueBuf = buf;
    worker._setWriteBuffer(buf);
    const o = worker.renderQueueBuffers[buf ^ 1];
    const st = inQueue
      ? { x: worker.renderQueueX, y: worker.renderQueueY, rc: worker.renderQueueRotC, rs: worker.renderQueueRotS }
      : { x: o.x, y: o.y, rc: o.rotC, rs: o.rotS };
    const r = rng(seed * 1000 + f);
    for (let i = 0; i < count; i++) {
      st.x[i] = r() * 4000;
      st.y[i] = r() * 3000;
      st.rc[i] = Math.cos(f + i);
      st.rs[i] = Math.sin(f + i);
    }
    if (f % 7 === 3) for (let j = 0; j < 5; j++) SpriteRenderer.renderDirty[cIndex[sprites[Math.floor(r() * sprites.length)]]] = 1;
    if (f % 11 === 5) {
      const idx = cIndex[sprites[Math.floor(r() * sprites.length)]];
      if (SpriteRenderer.spritesheetId[idx] !== 4) SpriteRenderer.animationState[idx] = (SpriteRenderer.animationState[idx] + 1) % 4;
    }
    if (f % 13 === 8) {
      const a = Math.floor(r() * count);
      const c = Math.floor(r() * count);
      [cType[a], cType[c]] = [cType[c], cType[a]];
      [cIndex[a], cIndex[c]] = [cIndex[c], cIndex[a]];
    }
    if (f === 17) worker.entityFrameIndex[cIndex[animatedRow]] = 99;
    // ShadowCaster columns change with no dirty flag: every persist frame refreshes the shadow terms.
    if (f % 5 === 2) {
      for (let j = 0; j < 8; j++) {
        const idx = cIndex[sprites[Math.floor(r() * sprites.length)]];
        ShadowCaster.heightMultiplier[idx] = r() * 2;
        ShadowCaster.active[idx] ^= 1;
      }
    }
    if (adobe && f === 20) cType[5] = 6;
    if (adobe && f === 26) cType[5] = k.types[5];
    return { buf, st };
  };
}

async function runPersistCase(t, { ySort, inQueue, seed }) {
  const k = await setup({ ySort, seed, persist: true });
  await withPersistOrder(ySort, () => persistFrames(t, k, { ySort, inQueue, seed }));
}

async function persistFrames(t, k, { ySort, inQueue, seed }) {
  const { worker, b, m, maxItems } = k;
  const count = k.count;
  assert.equal(worker._entityYSort(), ySort);
  assert.ok(worker._queueHasOrder());
  const all = new Uint8Array(m.buffer);
  const regions = persistRegions(m, maxItems);
  const cType = worker._renderableType;
  const cIndex = worker._renderableIndex;
  const cY = worker._renderableY;
  const prepare = persistSchedule(k, { inQueue, seed, adobe: true });
  const start = all.slice();

  const record = (hit, others, moved, repaired, ends) => ({
    hit, others, moved, repaired, ends, counts: [...worker._persistCount],
    mem: regions.map(([, at, bytes]) => all.slice(at, at + bytes)),
  });

  // The JS persist path.
  const realEnded = worker._spriteAnimationEnded;
  const js = [];
  for (let f = 0; f < PERSIST_FRAMES; f++) {
    const { buf, st } = prepare(f);
    const ends = [];
    worker._spriteAnimationEnded = (idx, anim) => ends.push(`${idx}:${anim}`);
    const hit = worker._type0PersistHit(buf, count, cType, cIndex);
    const others = hit ? worker._writeType0PosesOnly(count, cType, cIndex, cY, st.x, st.y, st.rc, st.rs, DT) : 0;
    if (!hit) worker._rememberType0Set(buf, count, cType, cIndex);
    js.push(record(hit, others, hit ? worker._persistFramesMoved : 0, hit ? worker._persistFramesRepaired : 0, ends));
  }
  worker._spriteAnimationEnded = realEnded;

  // The kernel, from the same start.
  all.set(start);
  worker._persistCount = [0, 0];
  const kinds = { hit: 0, repaired: 0, moved: 0, ends: 0 };
  for (let f = 0; f < PERSIST_FRAMES; f++) {
    const { buf, st } = prepare(f);
    const source = worker._fillEmitSource(count, maxItems, cY, cType, cIndex, st.x, st.y, st.rc, st.rs, true, true, ySort);
    assert.ok(writeEmitColumns(b, worker, SpriteRenderer, ShadowCaster, DecorationComponent, source), 'every column is in the memory');
    assert.ok(writePersistColumns(b, worker, SpriteRenderer, buf), 'and the persist rows');
    let hit = false;
    let repaired = 0;
    if (worker._persistCount[buf] === count) {
      const got = b.persistCheck(b.tableByte, count, maxItems);
      hit = got !== EMIT_PERSIST_MISS;
      if (hit) repaired = got;
    }
    let others = 0;
    let moved = 0;
    const ends = [];
    if (hit) {
      const sort = !!(worker.renderQueueSortKey && worker._queueHasOrder());
      const flags = (sort ? EMIT_SORT_KEY : 0) | (sort && worker._entityYSort() ? EMIT_Y_SORT : 0) | EMIT_BOUNDS;
      others = b.persistPoses(b.tableByte, count, maxItems, flags, DT / 1000, worker._zBand);
      moved = b.results[1];
      for (let e = 0, at = b.endsAt; e < b.results[0]; e++, at += 2) {
        if (worker._animEndByType[Transform.entityType[b.u32[at]]] === 1) ends.push(`${b.u32[at]}:${b.u32[at + 1]}`);
      }
    } else {
      const cleared = b.persistRemember(b.tableByte, count, maxItems);
      worker._persistCount[buf] = count;
      if (cleared) worker._persistCount[buf ^ 1] = -1;
    }
    const got = record(hit, others, moved, repaired, ends);
    const want = js[f];
    assert.deepEqual({ hit: got.hit, others: got.others, moved: got.moved, repaired: got.repaired, counts: got.counts },
      { hit: want.hit, others: want.others, moved: want.moved, repaired: want.repaired, counts: want.counts }, `frame ${f}`);
    assert.deepEqual(got.ends, want.ends, `frame ${f}: play-once ends, in order`);
    regions.forEach(([name], r) => {
      const at = got.mem[r].findIndex((x, i) => x !== want.mem[r][i]);
      assert.equal(at, -1, `frame ${f}: ${name} differs at byte ${at}`);
    });
    if (hit) kinds.hit++;
    kinds.repaired += repaired;
    kinds.moved += moved;
    kinds.ends += ends.length;
  }
  // The schedule must have reached every branch it is there for.
  assert.ok(kinds.hit >= 10 && kinds.hit <= PERSIST_FRAMES - 10, `hits ${kinds.hit}`);
  assert.ok(kinds.repaired > 0 && kinds.moved > 0 && kinds.ends > 0, JSON.stringify(kinds));
  t.diagnostic(`${count} rows: ${kinds.hit} persist frames of ${PERSIST_FRAMES}, ${kinds.repaired} repaired, ${kinds.moved} moved, ${kinds.ends} ends`);
}

test('the persist path in the kernel does what the JS persist path does, Y-sorted', async (t) => {
  await runPersistCase(t, { ySort: true, inQueue: true, seed: 0x9e1 });
});

test('the persist path in the kernel does what the JS persist path does, without Y-sort', async (t) => {
  await runPersistCase(t, { ySort: false, inQueue: true, seed: 0x9e2 });
});

test('the persist path in the kernel copies a stash that is not the queue', async (t) => {
  await runPersistCase(t, { ySort: true, inQueue: false, seed: 0x9e3 });
});

test('emitSpriteQueue through the kernel takes the persist frames the JS takes and writes what it writes', async (t) => {
  for (const ySort of [true, false]) {
    const seed = ySort ? 0xa11 : 0xa12;
    const k = await setup({ ySort, seed, persist: true });
    await withPersistOrder(ySort, async () => {
      const { worker, m, maxItems, count } = k;
      const bound = worker._emitWasm;
      assert.ok(bound && bound.texturesReady, 'the worker bound the kernel and wrote its tables');
      const calls = { persistCheck: 0, persistPoses: 0, persistRemember: 0, emitRows: 0 };
      for (const name of Object.keys(calls)) {
        const real = bound[name];
        bound[name] = (...args) => {
          calls[name]++;
          return real(...args);
        };
      }
      const all = new Uint8Array(m.buffer);
      const regions = persistRegions(m, maxItems);
      // No Adobe root here: the JS loop's Adobe branch needs AdobeAnimComponent (the kernel test has one).
      const prepare = persistSchedule(k, { inQueue: true, seed, adobe: false });
      const start = all.slice();
      const startGen = worker._staticGen;
      const realEnded = worker._spriteAnimationEnded;
      const realWarn = worker._warnMissingTexture;
      const run = (kernel) => {
        all.set(start);
        worker._persistCount = [0, 0];
        worker._tiledTileColumns = new Set();
        worker._staticGen = startGen;
        worker._emitWasm = kernel;
        const frames = [];
        for (let f = 0; f < PERSIST_FRAMES; f++) {
          const { st } = prepare(f);
          const ends = [];
          const warns = [];
          worker._spriteAnimationEnded = (idx, anim) => ends.push(`${idx}:${anim}`);
          worker._warnMissingTexture = (key) => warns.push(key);
          const hasOrder = worker._queueHasOrder();
          const source = worker._fillEmitSource(count, maxItems, worker._renderableY, worker._renderableType,
            worker._renderableIndex, st.x, st.y, st.rc, st.rs, true, hasOrder, hasOrder && worker._entityYSort());
          const written = worker.emitSpriteQueue(DT, source);
          frames.push({
            written, ends, warns: warns.sort(), counts: [...worker._persistCount], gen: worker._staticGen,
            tiled: [...worker._tiledTileColumns].length, mem: regions.map(([, at, bytes]) => all.slice(at, at + bytes)),
          });
        }
        worker._spriteAnimationEnded = realEnded;
        worker._warnMissingTexture = realWarn;
        return frames;
      };
      const js = run(null);
      assert.deepEqual(calls, { persistCheck: 0, persistPoses: 0, persistRemember: 0, emitRows: 0 }, 'the JS run called no kernel');
      const wasm = run(bound);
      for (let f = 0; f < PERSIST_FRAMES; f++) {
        const got = wasm[f];
        const want = js[f];
        assert.deepEqual({ written: got.written, counts: got.counts, gen: got.gen, tiled: got.tiled },
          { written: want.written, counts: want.counts, gen: want.gen, tiled: want.tiled }, `frame ${f}`);
        assert.deepEqual(got.ends, want.ends, `frame ${f}: play-once ends, in order`);
        assert.deepEqual(got.warns, want.warns, `frame ${f}: warnings`);
        regions.forEach(([name], r) => {
          const at = got.mem[r].findIndex((x, i) => x !== want.mem[r][i]);
          assert.equal(at, -1, `frame ${f}: ${name} differs at byte ${at}`);
        });
      }
      // Every frame went through the kernel: a check unless the count changed, the poses on a hit, the
      // full emit and the remember on a miss.
      assert.equal(calls.persistPoses + calls.persistRemember, PERSIST_FRAMES, JSON.stringify(calls));
      assert.equal(calls.emitRows, calls.persistRemember, JSON.stringify(calls));
      assert.ok(calls.persistPoses >= 10 && calls.persistRemember >= 10, JSON.stringify(calls));
      t.diagnostic(`ySort ${ySort}: ${JSON.stringify(calls)}`);
    });
  }
});

// E-116: persist_frame (wasm/test/preRenderPersistFrame.c) against the shipped two calls. A miss leaves
// pose writes behind it (the rows the walk passed), which the full emit after a miss rewrites; so both
// paths run that full emit (emit_rows) and the remember on a miss, and must then hold the same bytes.
const FUSED_URL = new URL('../fixtures/wasm/preRenderPersistFrame.wasm', import.meta.url);

test('the persist path in one walk (E-116) leaves what the two calls and the full emit leave', async (t) => {
  for (const ySort of [true, false]) {
    const seed = ySort ? 0xf11 : 0xf12;
    const k = await setup({ ySort, seed, persist: true });
    await withPersistOrder(ySort, async () => {
      const { worker, b, m, maxItems, count } = k;
      const fused = await loadWasmKernel('preRenderPersistFrame', FUSED_URL, m.memory, ['persist_frame']);
      const all = new Uint8Array(m.buffer);
      const regions = persistRegions(m, maxItems);
      // No Adobe root: emit_rows declines a frame with one, and the JS loop the worker then runs is not here.
      const prepare = persistSchedule(k, { inQueue: true, seed, adobe: false });
      const start = all.slice();
      const cType = worker._renderableType;
      const cIndex = worker._renderableIndex;
      const cY = worker._renderableY;
      const run = (oneWalk) => {
        all.set(start);
        worker._persistCount = [0, 0];
        worker._tiledTileColumns = new Set();
        const frames = [];
        for (let f = 0; f < PERSIST_FRAMES; f++) {
          const { buf, st } = prepare(f);
          const source = worker._fillEmitSource(count, maxItems, cY, cType, cIndex, st.x, st.y, st.rc, st.rs, true, true, ySort);
          assert.ok(writeEmitColumns(b, worker, SpriteRenderer, ShadowCaster, DecorationComponent, source));
          assert.ok(writePersistColumns(b, worker, SpriteRenderer, buf));
          const sort = !!(worker.renderQueueSortKey && worker._queueHasOrder());
          const flags = (sort ? EMIT_SORT_KEY : 0) | (sort && worker._entityYSort() ? EMIT_Y_SORT : 0) | EMIT_BOUNDS;
          let hit = false;
          let others = 0;
          let moved = 0;
          let repaired = 0;
          const ends = [];
          const takeEnds = () => {
            for (let e = 0, at = b.endsAt; e < b.results[0]; e++, at += 2) ends.push(`${b.u32[at]}:${b.u32[at + 1]}`);
          };
          if (worker._persistCount[buf] === count) {
            if (oneWalk) {
              const got = fused.persist_frame(b.tableByte, count, maxItems, flags, DT / 1000, worker._zBand);
              hit = got !== EMIT_PERSIST_MISS;
              if (hit) {
                others = got;
                moved = b.results[1];
                repaired = b.results[2];
                takeEnds();
              }
            } else {
              const got = b.persistCheck(b.tableByte, count, maxItems);
              hit = got !== EMIT_PERSIST_MISS;
              if (hit) {
                repaired = got;
                others = b.persistPoses(b.tableByte, count, maxItems, flags, DT / 1000, worker._zBand);
                moved = b.results[1];
                takeEnds();
              }
            }
          }
          if (!hit) {
            const tilesDirty = worker.renderQueueTileMode !== null && worker._tiledTileColumns.has(worker.renderQueueTileMode);
            const emitFlags = (sort ? EMIT_SORT_KEY : 0) | (sort && worker._entityYSort() ? EMIT_Y_SORT : 0) | EMIT_BOUNDS
              | (tilesDirty ? EMIT_TILES_DIRTY : 0);
            const written = b.emitRows(b.tableByte, count, maxItems, emitFlags, DT / 1000, worker._decorationZoomAlpha, worker._zBand);
            assert.notEqual(written, EMIT_DECLINED, `frame ${f}`);
            if (b.results[2] && worker.renderQueueTileMode !== null) worker._tiledTileColumns.add(worker.renderQueueTileMode);
            takeEnds();
            const cleared = b.persistRemember(b.tableByte, count, maxItems);
            worker._persistCount[buf] = count;
            if (cleared) worker._persistCount[buf ^ 1] = -1;
          }
          frames.push({ hit, others, moved, repaired, ends, counts: [...worker._persistCount], mem: regions.map(([, at, bytes]) => all.slice(at, at + bytes)) });
        }
        return frames;
      };
      const two = run(false);
      const one = run(true);
      let hits = 0;
      for (let f = 0; f < PERSIST_FRAMES; f++) {
        const got = one[f];
        const want = two[f];
        assert.deepEqual({ hit: got.hit, others: got.others, moved: got.moved, repaired: got.repaired, counts: got.counts, ends: got.ends },
          { hit: want.hit, others: want.others, moved: want.moved, repaired: want.repaired, counts: want.counts, ends: want.ends }, `frame ${f}`);
        regions.forEach(([name], r) => {
          const at = got.mem[r].findIndex((x, i) => x !== want.mem[r][i]);
          assert.equal(at, -1, `frame ${f}: ${name} differs at byte ${at}`);
        });
        if (got.hit) hits++;
      }
      assert.ok(hits >= 10 && hits <= PERSIST_FRAMES - 10, `hits ${hits}`);
      t.diagnostic(`ySort ${ySort}: ${hits} persist frames of ${PERSIST_FRAMES}`);
    });
  }
});
