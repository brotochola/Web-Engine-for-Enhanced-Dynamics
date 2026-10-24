#!/usr/bin/env node
/**
 * Kernel (E-76 W4c): the entity queue's persist path in WASM (persist_check, persist_poses and
 * persist_remember in wasm/preRenderEmit.c) against the shipped PreRenderWorker._type0PersistHit,
 * _writeType0PosesOnly and _rememberType0Set, on a real worker with BunnyMark's queue: 250 000 sprites of
 * one texture, no animation, no shadow casters, no order, the collect's poses already in the queue (E-98d).
 *
 *   persist   a frame whose rows are the ones its buffer last held: the check, then the poses-only pass;
 *             the buffers alternate as pre-render's frames do (BunnyMark's every frame)
 *   remember  the rows a full emit leaves, remembered for the next check (a frame the check missed)
 *
 *   js        the shipped functions, as emitSpriteQueue calls them
 *   wasm      the kernel through preRenderEmitClient.js, as a product wrapper would call it: the column
 *             table written, the call, the counts and the play-once ends acted on in JS
 *   fused     E-116: persist_frame (wasm/test/preRenderPersistFrame.c, a test module), the check and the
 *             poses-only pass in one walk; the remember as wasm
 *   fused-nc  E-117 on top: the walk leaves the shadow terms when the scene has no ShadowCaster
 *
 * Every column is where the scene keeps it: the render-queue memory with the emit spec
 * (createRenderQueueMemory), the worker bound to it at init. The checksum covers both queue buffers'
 * rows, the animation state and the remembered rows after a fixed run of both cases.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/preRenderPersistWasmMicrobench.mjs --variants js,wasm,fused,fused-nc --rounds 5
 *   node tests/bench/preRenderPersistWasmMicrobench.mjs --variant wasm [--scale 0.1] [--output path]
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { ShadowCaster } from '../../src/components/shadowCaster.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { computeBufferSize, RENDER_QUEUE_CAMERA_BYTES } from '../../src/render/renderQueueLayout.js';
import { computeGpuQueueBufferSize, gpuQueueCaps } from '../../src/render/gpuQueueLayout.js';
import { createRenderQueueMemory } from '../../src/util/renderQueueMemory.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import {
  EMIT_BOUNDS,
  EMIT_PERSIST_MISS,
  EMIT_SORT_KEY,
  EMIT_Y_SORT,
  writeEmitColumns,
  writePersistColumns,
} from '../../src/workers/preRenderEmitClient.js';
import { isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { bindPoseColumns, coreComponentData, initWorker, loadWorker } from './workerHarness.mjs';
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';

// --scale shrinks the population (a cache-resident one, a diagnostic; the verdict is at 1).
const ARGS = parseArgs();
const SCALE = Number(ARGS.scale ?? 1);
const N = Math.max(1024, Math.round(250000 * SCALE));
const MAX_ITEMS = N;
const DT = 1000 / 60;
const FUSED_URL = pathToFileURL(path.resolve(import.meta.dirname, '../fixtures/wasm/preRenderPersistFrame.wasm'));
/** preRenderPersistFrame.c's F_NO_CASTERS. */
const F_NO_CASTERS = 16;

/** BunnyMark's metadata: sheet 1's state 0 is the one-frame 'bunny', then the builtin textures. */
function textureMetadata() {
  const animationNameToIndex = { bunny: 0 };
  const animationFrameStart = [0];
  const animationFrameCount = [1];
  for (const name of ['_lightGradient', '_whiteCircle', '_bulletTrail']) {
    animationNameToIndex[name] = animationFrameStart.length;
    animationFrameStart.push(animationFrameStart.length);
    animationFrameCount.push(1);
  }
  return {
    animationFrameStart,
    animationFrameCount,
    proxyToGlobalAnim: { 1: { 0: 0 } },
    animationNameToIndex,
    totalFrames: animationFrameStart.length,
    frameWidth: Uint16Array.from([26, 64, 64, 64]),
    frameHeight: Uint16Array.from([37, 64, 64, 64]),
  };
}

export async function setupPersistKernel(opts = {}) {
  const caps = gpuQueueCaps(MAX_ITEMS, { enabled: false });
  const m = createRenderQueueMemory(MAX_ITEMS, computeBufferSize(MAX_ITEMS), computeGpuQueueBufferSize(caps), {
    entities: N,
    spriteBytes: SpriteRenderer.getBufferSize(N),
    casterBytes: 0,
    decorationBytes: 0,
  });
  if (!m) throw new Error('the render-queue memory does not fit');
  const e = m.layout.emit;
  const worker = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  await initWorker(worker, {
    config: {
      worldWidth: 1920,
      worldHeight: 1080,
      canvasWidth: 1920,
      canvasHeight: 1080,
      preRender: { interpolation: false, skipCull: true },
      renderer: { ySort: false },
      debug: { collectDetailedStats: false },
    },
    globalEntityCount: N,
    buffers: {
      componentData: { ...coreComponentData(N), SpriteRenderer: m.buffer },
      componentDataByte: { SpriteRenderer: e.spriteRendererByte },
    },
    extra: {
      textureMetadata: textureMetadata(),
      renderQueueMemory: m.memory,
      renderQueueLayout: m.layout,
      renderQueue: {
        maxItems: MAX_ITEMS,
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
  const b = worker._emitWasm;
  if (!b || !b.texturesReady) throw new Error('the worker did not bind the emit kernel');
  if (SpriteRenderer.scaleX.buffer !== m.buffer) throw new Error('SpriteRenderer is not in the memory');
  if (worker._persistType[0].buffer !== m.buffer) throw new Error('the persist rows are not in the memory');
  const fused = opts.fused
    ? await loadWasmKernel('preRenderPersistFrame', FUSED_URL, m.memory, ['persist_frame'])
    : null;

  // BunnyMark's bunnies (Bunny.onSpawned): the one texture, a random tint, centred, unrotated.
  const rng = mulberry32(opts.seed ?? 0xb0b);
  const sr = SpriteRenderer;
  for (let i = 0; i < N; i++) {
    Transform.x[i] = 8 + rng() * 1904;
    Transform.y[i] = 8 + rng() * 1064;
    sr.active[i] = 1;
    sr.renderVisible[i] = 1;
    sr.scaleX[i] = 1;
    sr.scaleY[i] = 1;
    sr.alpha[i] = 1;
    sr.tint[i] = (rng() * 0xffffff) | 0;
    sr.anchorX[i] = 0.5;
    sr.anchorY[i] = 0.5;
    sr.inheritTransformRotation[i] = 1;
    sr.spriteRotC[i] = 1;
    sr.spriteRotS[i] = 0;
    sr.spritesheetId[i] = 1;
    sr.animationState[i] = 0;
    sr.isAnimated[i] = 0;
    sr.animationSpeed[i] = 1;
    sr.loop[i] = 1;
  }

  // The collector after the sprite collect (skipCull: every bunny, in index order), poses in each buffer.
  const cType = worker._renderableType;
  const cIndex = worker._renderableIndex;
  const cY = worker._renderableY;
  const count = N;
  for (let k = 0; k < count; k++) {
    cType[k] = 0;
    cIndex[k] = k;
    cY[k] = Transform.y[k];
  }
  for (const q of worker.renderQueueBuffers) {
    for (let k = 0; k < count; k++) {
      q.x[k] = Transform.x[k];
      q.y[k] = Transform.y[k];
      q.rotC[k] = 1;
      q.rotS[k] = 0;
    }
  }

  let frame = 0;
  /** Pre-render's next frame: the other queue buffer, its emit source as buildRenderQueue fills it. */
  const nextFrame = () => {
    const buf = frame++ & 1;
    worker._queueBuf = buf;
    worker._setWriteBuffer(buf);
    const hasOrder = worker._queueHasOrder();
    worker._fillEmitSource(count, MAX_ITEMS, cY, cType, cIndex, worker.renderQueueX, worker.renderQueueY,
      worker.renderQueueRotC, worker.renderQueueRotS, true, hasOrder, hasOrder && worker._entityYSort());
    return buf;
  };

  const persistJs = (rows = count) => {
    const buf = nextFrame();
    if (!worker._type0PersistHit(buf, rows, cType, cIndex)) throw new Error('the persist check missed');
    return worker._writeType0PosesOnly(rows, cType, cIndex, cY, worker.renderQueueX, worker.renderQueueY,
      worker.renderQueueRotC, worker.renderQueueRotS, DT);
  };
  const rememberJs = (rows = count) => {
    const buf = nextFrame();
    worker._rememberType0Set(buf, rows, cType, cIndex);
    return worker._persistCount[buf];
  };

  /** The column table for this frame's buffer, as the wiring writes it. */
  const table = (buf) => {
    if (!writeEmitColumns(b, worker, SpriteRenderer, ShadowCaster, DecorationComponent, worker._emitSource)
      || !writePersistColumns(b, worker, SpriteRenderer, buf)) {
      throw new Error('a column is not in the memory');
    }
  };
  const persistWasm = (rows = count) => {
    const buf = nextFrame();
    table(buf);
    if (worker._persistCount[buf] !== rows) throw new Error('the persist check missed');
    const repaired = b.persistCheck(b.tableByte, rows, MAX_ITEMS);
    if (repaired === EMIT_PERSIST_MISS) throw new Error('the persist check missed');
    worker._persistFramesRepaired = repaired;
    const sort = !!(worker.renderQueueSortKey && worker._queueHasOrder());
    const bounds = worker.frameWidth && worker.frameHeight && SpriteRenderer.boundsHalfW && SpriteRenderer.boundsHalfH;
    const flags = (sort ? EMIT_SORT_KEY : 0) | (sort && worker._entityYSort() ? EMIT_Y_SORT : 0) | (bounds ? EMIT_BOUNDS : 0);
    const others = b.persistPoses(b.tableByte, rows, MAX_ITEMS, flags, DT / 1000, worker._zBand);
    worker._persistFramesMoved = b.results[1];
    for (let k = 0, at = b.endsAt; k < b.results[0]; k++, at += 2) {
      const idx = b.u32[at];
      if (worker._animEndByType[Transform.entityType[idx]] === 1) worker._spriteAnimationEnded(idx, b.u32[at + 1]);
    }
    return others;
  };
  /** E-116 (and E-117 with noCasters): the check and the poses-only pass in one call. */
  const persistFused = (rows = count) => {
    const buf = nextFrame();
    table(buf);
    if (worker._persistCount[buf] !== rows) throw new Error('the persist check missed');
    const sort = !!(worker.renderQueueSortKey && worker._queueHasOrder());
    const bounds = worker.frameWidth && worker.frameHeight && SpriteRenderer.boundsHalfW && SpriteRenderer.boundsHalfH;
    const flags = (sort ? EMIT_SORT_KEY : 0) | (sort && worker._entityYSort() ? EMIT_Y_SORT : 0) | (bounds ? EMIT_BOUNDS : 0)
      | (opts.noCasters && !ShadowCaster.active ? F_NO_CASTERS : 0);
    const others = fused.persist_frame(b.tableByte, rows, MAX_ITEMS, flags, DT / 1000, worker._zBand);
    if (others === EMIT_PERSIST_MISS) throw new Error('the persist check missed');
    worker._persistFramesMoved = b.results[1];
    worker._persistFramesRepaired = b.results[2];
    for (let k = 0, at = b.endsAt; k < b.results[0]; k++, at += 2) {
      const idx = b.u32[at];
      if (worker._animEndByType[Transform.entityType[idx]] === 1) worker._spriteAnimationEnded(idx, b.u32[at + 1]);
    }
    return others;
  };
  const rememberWasm = (rows = count) => {
    const buf = nextFrame();
    table(buf);
    const cleared = b.persistRemember(b.tableByte, rows, MAX_ITEMS);
    worker._persistCount[buf] = rows;
    if (cleared) worker._persistCount[buf ^ 1] = -1;
    return worker._persistCount[buf];
  };

  const queueBytes = computeBufferSize(MAX_ITEMS);
  const hashed = [
    new Uint8Array(m.buffer, m.layout.queueAByte, queueBytes),
    new Uint8Array(m.buffer, m.layout.queueBByte, queueBytes),
    ...[worker.entityFrameIndex, worker.entityFrameAccumulator, worker.entityLastTextureId, sr.boundsHalfW, sr.boundsHalfH,
      sr.renderDirty, ...worker._persistType, ...worker._persistEntity, ...worker._persistFrame, ...worker._persistAnim]
      .map((a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)),
  ];
  const hashState = (h) => {
    for (const bytes of hashed) h = hashBytes(h, bytes);
    return h;
  };
  return { worker, count, persistJs, rememberJs, persistWasm, persistFused, rememberWasm, hashState, kernel: b, fused };
}

function hashBytes(h, bytes) {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
  return h;
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'js');
  if (!['js', 'wasm', 'fused', 'fused-nc'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const isFused = variant.startsWith('fused');
  const k = await setupPersistKernel({ seed: Number(args.seed ?? 0xb0b), fused: isFused, noCasters: variant === 'fused-nc' });
  const persist = isFused ? k.persistFused : variant === 'wasm' ? k.persistWasm : k.persistJs;
  const remember = variant === 'js' ? k.rememberJs : k.rememberWasm;

  // Both buffers remembered (the two frames a scene's first emit misses), then six persist frames.
  let checksum = 2166136261;
  for (let f = 0; f < 2; f++) checksum = Math.imul(checksum ^ remember(), 16777619) >>> 0;
  for (let f = 0; f < 6; f++) checksum = Math.imul(checksum ^ persist(), 16777619) >>> 0;
  checksum = k.hashState(checksum);

  // Normal compiles, not OSR: short calls over the first 64 rows. A 64-row remember leaves 64 as the
  // buffers' count, so both are remembered at full size again before the timed calls.
  let tier = null;
  if (variant !== 'js') {
    for (let f = 0; f < 2; f++) remember(64);
    tier = await warmWasm(isFused ? k.fused.persist_frame : k.kernel.persistCheck, () => persist(64));
    await warmWasm(k.kernel.persistRemember, () => remember(64));
  } else {
    for (let f = 0; f < 2; f++) remember(64);
    warmNormalCompile(() => persist(64));
    warmNormalCompile(() => remember(64));
  }
  for (let f = 0; f < 2; f++) remember();
  const cases = {
    persist: timeIt(`preRender persist ${variant} (${k.count} sprites)`, () => persist(), { iterations: 40, warmup: 10 }),
    remember: timeIt(`preRender remember ${variant} (${k.count} rows)`, () => remember(), { iterations: 40, warmup: 10 }),
  };
  const report = {
    feature: 'preRender-persist-wasm',
    variant,
    functions: ['PreRenderWorker._type0PersistHit', 'PreRenderWorker._writeType0PosesOnly', 'PreRenderWorker._rememberType0Set',
      'preRenderEmit.persist_check', 'preRenderEmit.persist_poses', 'preRenderEmit.persist_remember',
      'preRenderPersistFrame.persist_frame'],
    rows: k.count,
    checksum,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum} rows ${k.count}${tier ? ` tier ${tier}` : ''} persist ${cases.persist.opsPerSec.toFixed(1)} ops/s remember ${cases.remember.opsPerSec.toFixed(1)} ops/s`);
}

if (isCli(import.meta.url)) await main();
