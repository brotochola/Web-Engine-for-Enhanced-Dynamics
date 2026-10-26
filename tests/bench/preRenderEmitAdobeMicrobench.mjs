#!/usr/bin/env node
/**
 * Kernel (W27): pre-render's emit of Adobe Animate characters, the shipped PreRenderWorker methods on a real
 * worker with or without preRenderEmit.wasm bound, on the Adobe Animate demo at its minimum zoom (Q1b: pre-render
 * saturated, _emitAdobePieces 27.1 % of it): 10 000 characters of willian's Argen1_Piel2 clip on screen, every one
 * a type-6 row of the collector, poses in the stash, Y-sorted, in the scene's render-queue memory
 * (createRenderQueueMemory with the emit's Adobe regions, as sceneSharedBuffers lays it out).
 *
 *   emit     emitSpriteQueue as buildRenderQueue calls it (the persist check misses on the first Adobe root):
 *            every root expanded into its pieces, about 14 queue rows each
 *   advance  advanceAdobeAnimations over the same 10 000 clocks (looping clips, playback rates 1 to 2)
 *
 *   js    the shipped methods with no kernel bound (emitSpriteQueue's loop and _emitAdobePieces)
 *   wasm  the same with the kernel bound, as initialize binds it; a frame the kernel declines runs the JS
 *         (kernelFrames in the report counts the frames it took)
 *
 * The asset is the demo's (demos/fla/willian/willian2), compiled by AdobeAnimCompiler as the scene compiles it,
 * with texture ids of its own (no atlas here). The checksum covers every queue column of every written row and
 * AdobeAnimComponent's clocks after each of 45 frames (an advance then an emit).
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/preRenderEmitAdobeMicrobench.mjs --variants js,wasm --rounds 5
 *   node tests/bench/preRenderEmitAdobeMicrobench.mjs --variant wasm [--scale 0.1] [--output path]
 */
import fs from 'node:fs';
import path from 'node:path';

import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { ShadowCaster } from '../../src/components/shadowCaster.js';
import { AdobeAnimComponent } from '../../src/components/adobeAnimComponent.js';
import { AdobeAnimRegistry } from '../../src/core/adobeAnimRegistry.js';
import { AdobeAnimCompiler } from '../../src/util/adobeAnimCompiler.js';
import { computeBufferSize, RENDER_QUEUE_CAMERA_BYTES } from '../../src/render/renderQueueLayout.js';
import { computeGpuQueueBufferSize, gpuQueueCaps } from '../../src/render/gpuQueueLayout.js';
import { createRenderQueueMemory } from '../../src/util/renderQueueMemory.js';
import { isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { bindPoseColumns, coreComponentData, initWorker, loadWorker, quietly } from './workerHarness.mjs';
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';
import { installEmitJs } from '../reference/preRenderEmitJs.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const ARGS = parseArgs();
const SCALE = Number(ARGS.scale ?? 1);
// The demo: a pool of 20 000 characters, 10 000 spawned on a 100 x 100 grid 50 px apart, a 350 000-row queue.
const CHARACTERS = Math.max(64, Math.round(10000 * SCALE));
const ENTITIES = Math.max(CHARACTERS, Math.round(20000 * SCALE));
const MAX_ITEMS = Math.max(4096, Math.round(350000 * SCALE));
const WORLD_W = 20600;
const WORLD_H = 15000;
const DT = 1000 / 60;
const FRAMES = 45;
const ASSET = 'willian';
const CLIP = 'Argen1_Piel2';

/** The demo's asset, compiled as Scene.prepareAdobeAnimateAssets compiles it; texture ids of the bench's own. */
function compileAsset() {
  const dir = path.join(repoRoot, 'demos/fla/willian/willian2');
  const read = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').replace(/^﻿/, ''));
  const asset = AdobeAnimCompiler.compile(ASSET, read('Animation.json'), read('spritemap1.json'));
  for (let p = 0; p < asset.pieceTextureId.length; p++) asset.pieceTextureId[p] = 1 + ((p * 7) % 997);
  return asset;
}

export async function setupAdobeEmit(seed = 0xad0be) {
  const caps = gpuQueueCaps(MAX_ITEMS, { enabled: false });
  const m = createRenderQueueMemory(MAX_ITEMS, computeBufferSize(MAX_ITEMS), computeGpuQueueBufferSize(caps), {
    entities: ENTITIES,
    spriteBytes: SpriteRenderer.getBufferSize(ENTITIES),
    casterBytes: 0,
    decorationBytes: 0,
    adobe: { animBytes: AdobeAnimComponent.getBufferSize(ENTITIES), tableBytes: 4 * 1048576 },
  });
  if (!m) throw new Error('the render-queue memory did not fit');
  const e = m.layout.emit;
  if (!(e.adobeAnimByte > 0)) throw new Error('the memory has no Adobe regions');

  AdobeAnimRegistry.clearForSceneUnload();
  const asset = compileAsset();
  const assetId = AdobeAnimRegistry.register(ASSET, asset);
  const clipId = asset.clipNameToId[CLIP];
  const frameCount = asset.clipFrameCount[clipId];
  const duration = frameCount / asset.clipFrameRate[clipId];

  for (const C of [SpriteRenderer, ShadowCaster, AdobeAnimComponent]) C.clearArrays();
  const buffers = {
    componentData: { ...coreComponentData(ENTITIES), SpriteRenderer: m.buffer, AdobeAnimComponent: m.buffer },
    componentDataByte: { SpriteRenderer: e.spriteRendererByte, AdobeAnimComponent: e.adobeAnimByte },
  };
  const worker = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  // The JS emit the kernel replaced, for the runs with _emitWasm null (tests/reference).
  installEmitJs(worker);
  await initWorker(worker, {
    config: {
      worldWidth: WORLD_W,
      worldHeight: WORLD_H,
      canvasWidth: 1920,
      canvasHeight: 1080,
      preRender: { interpolation: false, skipCull: false },
      renderer: { ySort: true },
      debug: { collectDetailedStats: false },
    },
    globalEntityCount: ENTITIES,
    buffers,
    extra: {
      textureMetadata: {
        animationFrameStart: [0, 1, 2],
        animationFrameCount: [1, 1, 1],
        proxyToGlobalAnim: {},
        animationNameToIndex: { _lightGradient: 0, _whiteCircle: 1, _bulletTrail: 2 },
        totalFrames: 3,
        frameWidth: Uint16Array.of(64, 64, 64),
        frameHeight: Uint16Array.of(64, 64, 64),
      },
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
  bindPoseColumns(ENTITIES);
  if (AdobeAnimComponent.active.buffer !== m.buffer) throw new Error('AdobeAnimComponent is not in the memory');
  if (worker._renderablePx.buffer !== m.buffer) throw new Error('the pose stash is not in the memory');
  const bound = worker._emitWasm;
  if (!bound) throw new Error('the worker did not bind preRenderEmit.wasm');

  // The demo's characters (AdobeAnimateCharacter.onSpawned): the clip looping, playback rates 1 + i / 1000.
  const rng = mulberry32(seed);
  const a = AdobeAnimComponent;
  const cols = Math.round(Math.sqrt(CHARACTERS));
  const ids = new Uint16Array(CHARACTERS);
  const pose = Float64Array.of(0, 0, 1, 0);
  const cType = worker._renderableType;
  const cIndex = worker._renderableIndex;
  const cY = worker._renderableY;
  for (let i = 0; i < CHARACTERS; i++) {
    ids[i] = i;
    Transform.active[i] = 1;
    a.active[i] = 1;
    a.assetId[i] = assetId;
    a.clipId[i] = clipId;
    a.time[i] = rng() * duration;
    a.playbackRate[i] = 1 + i * 0.001;
    a.loop[i] = 1;
    a.playing[i] = 1;
    a.scaleX[i] = 0.25;
    a.scaleY[i] = 0.25;
    a.anchorX[i] = 0.5;
    a.anchorY[i] = 1;
    a.rotC[i] = 1;
    a.rotS[i] = 0;
    a.alpha[i] = 1;
    a.tint[i] = 0xffffff;
    a.renderVisible[i] = 1;
    AdobeAnimComponent.applyClipBounds(i);
    // On screen, posed by their (fixed-rotation) bodies: the collect's stash, then its Y-sort key.
    pose[0] = WORLD_W * 0.5 + (i % cols) * 50 + (rng() - 0.5) * 4;
    pose[1] = WORLD_H * 0.5 + Math.floor(i / cols) * 50 + (rng() - 0.5) * 4;
    cType[i] = 6;
    cIndex[i] = i;
    worker._renderablePx[i] = pose[0];
    worker._renderablePy[i] = pose[1];
    worker._renderableRotC[i] = 1;
    worker._renderableRotS[i] = 0;
    worker._storeEntitySortY(6, i, pose, cY, i);
  }
  worker._frameAdobeEntities = ids;
  const source = (rows = CHARACTERS) => worker._fillEmitSource(rows, MAX_ITEMS, cY, cType, cIndex,
    worker._renderablePx, worker._renderablePy, worker._renderableRotC, worker._renderableRotS, true, true, true);

  const use = (kernel) => { worker._emitWasm = kernel ? bound : null; };
  const emit = (rows = CHARACTERS) => worker.emitSpriteQueue(DT, source(rows));
  const advance = (rows = CHARACTERS) => {
    worker._frameAdobeEntities = rows === CHARACTERS ? ids : ids.subarray(0, rows);
    worker.advanceAdobeAnimations(DT);
  };
  const columns = [
    'renderQueueX', 'renderQueueY', 'renderQueueScaleX', 'renderQueueScaleY', 'renderQueueRotC', 'renderQueueRotS',
    'renderQueueAlpha', 'renderQueueTint', 'renderQueueTextureId', 'renderQueueAnchorX', 'renderQueueAnchorY',
    'renderQueueType', 'renderQueueSortKey', 'renderQueueShadowH', 'renderQueueShadowOffX', 'renderQueueShadowOffY',
  ];
  const hashFrame = (h, written) => {
    for (const c of columns) {
      const v = worker[c];
      h = hashBytes(h, new Uint8Array(v.buffer, v.byteOffset, written * v.BYTES_PER_ELEMENT));
    }
    for (const v of [a.time, a.playing]) h = hashBytes(h, new Uint8Array(v.buffer, v.byteOffset, CHARACTERS * v.BYTES_PER_ELEMENT));
    return h;
  };
  // The state both variants start from, put back before each run.
  const clocks = { time: a.time.slice(), playing: a.playing.slice() };
  const reset = () => {
    a.time.set(clocks.time);
    a.playing.set(clocks.playing);
    worker._persistCount = [0, 0];
  };
  return { worker, bound, use, emit, advance, hashFrame, reset, pieces: asset.pieceX.length };
}

function hashBytes(h, bytes) {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
  return h;
}

async function main() {
  const variant = String(ARGS.variant || 'js');
  if (!['js', 'wasm'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const k = await quietly(() => setupAdobeEmit(Number(ARGS.seed ?? 0xad0be)));
  k.use(variant === 'wasm');

  // 45 frames from the fixture's state, each an advance then an emit; the frames the kernel took, counted.
  let kernelFrames = 0;
  const realRows = k.bound.emitRows;
  k.bound.emitRows = (...args) => {
    const got = realRows(...args);
    if (got !== -1) kernelFrames++;
    return got;
  };
  let checksum = 2166136261;
  let written = 0;
  for (let f = 0; f < FRAMES; f++) {
    k.advance();
    written = k.emit();
    checksum = Math.imul(checksum ^ written, 16777619) >>> 0;
    checksum = k.hashFrame(checksum, written);
  }
  k.bound.emitRows = realRows;
  k.reset();

  // Normal compiles, not OSR: short calls over the first 64 characters.
  let tier = null;
  if (variant === 'wasm') {
    tier = await warmWasm(k.bound.emitRows, () => k.emit(64));
    if (typeof k.bound.adobeAdvance === 'function') await warmWasm(k.bound.adobeAdvance, () => k.advance(64));
    else warmNormalCompile(() => k.advance(64));
  } else {
    warmNormalCompile(() => k.emit(64));
    warmNormalCompile(() => k.advance(64));
  }
  k.reset();
  const cases = {
    emit: timeIt(`preRender Adobe emit ${variant} (${written} rows)`, () => k.emit(), { iterations: 20, warmup: 10 }),
    advance: timeIt(`preRender Adobe advance ${variant}`, () => k.advance(), { iterations: 200, warmup: 50 }),
  };
  const report = {
    feature: 'preRender-emit-adobe',
    variant,
    functions: ['PreRenderWorker.emitSpriteQueue', 'PreRenderWorker._emitAdobePieces', 'PreRenderWorker.advanceAdobeAnimations',
      'preRenderEmit.emit_rows', 'preRenderEmit.adobe_advance'],
    characters: CHARACTERS,
    rows: written,
    pieces: k.pieces,
    checksum,
    kernelFrames,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (ARGS.output) writeReport(String(ARGS.output), report);
  else {
    console.log(`checksum ${checksum} rows ${written} kernel frames ${kernelFrames}/${FRAMES}${tier ? ` tier ${tier}` : ''}`);
    for (const [name, c] of Object.entries(cases)) console.log(`  ${name}: ${c.opsPerSec.toFixed(1)} ops/s`);
  }
}

if (isCli(import.meta.url)) await main();
