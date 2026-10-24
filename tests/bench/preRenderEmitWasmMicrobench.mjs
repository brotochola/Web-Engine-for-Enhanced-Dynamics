#!/usr/bin/env node
/**
 * Kernel (E-76 W4a, E-112): pre-render's full emit of sprite rows (type 0) and decoration rows (type 2)
 * in WASM (wasm/preRenderEmit.c, src/workers/preRenderEmit.wasm) against the shipped
 * PreRenderWorker.emitSpriteQueue, on a real worker with Predator's mix.
 *
 *   js    PreRenderWorker.emitSpriteQueue (shipped), as buildRenderQueue calls it on a frame its
 *         persist check missed: Y-sort on, the collect's poses already in the queue columns (E-98d)
 *   wasm  emit_rows, one call per frame; then the JS acts on the play-once ends, the warnings and
 *         the tiled flag it returns, as a product wrapper would
 *
 * The emit reads SpriteRenderer, ShadowCaster and DecorationComponent columns, pre-render's animation
 * state and collector, and the texture metadata; the kernel needs all of them in the memory it
 * imports. The render queue lives in a WebAssembly.Memory already (W9), so the bench builds one with
 * both queue buffers and room after them, moves every column the emit reads there and points the
 * views at it, as W4a would: the JS and the kernel read the same bytes. The kernel's texture tables
 * are flat copies of the worker's metadata (proxyToGlobalAnim[sheet][state], animationFrameCount and
 * animationFrameStart, the frame sizes).
 *
 * Predator's mix (counts of 2026-10-23): 13 500 of 17 600 entities on screen, people on seven proxy
 * sheets of civil1.json's 54 animations (2–13 frames, speed 0.15, 2 % play-once), the rest one-frame
 * props; 10 200 of 20 000 grass blades after them; shadow casters on every sprite; Y-sort on.
 *
 * One variant per process, through runKernelVariants.mjs, which rejects a variant whose checksum
 * differs. The checksum covers every queue column of every written row and the animation state
 * (frame, clock, last texture, bounds) after each of 45 frames.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/preRenderEmitWasmMicrobench.mjs --variants js,wasm --rounds 5
 *   node tests/bench/preRenderEmitWasmMicrobench.mjs --variant wasm [--scale 0.1] [--output path]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { ShadowCaster } from '../../src/components/shadowCaster.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { computeBufferSize, RENDER_QUEUE_CAMERA_BYTES } from '../../src/render/renderQueueLayout.js';
import { DECORATION_Y_SORT_SCALE } from '../../src/util/configDefaults.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { layoutRegions, NULL_GUARD_BYTES } from '../../src/util/wasmMemoryMap.js';
import { isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { bindPoseColumns, coreComponentData, initWorker, loadWorker } from './workerHarness.mjs';
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';
import { EMIT_SLOTS } from '../../src/workers/preRenderEmitClient.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const KERNEL_URL = pathToFileURL(path.join(repoRoot, 'src/workers/preRenderEmit.wasm'));

// --scale shrinks every count (a cache-resident population, a diagnostic; the verdict is at 1).
const ARGS = parseArgs();
const SCALE = Number(ARGS.scale ?? 1);
const N = Math.round(17600 * SCALE);
const PEOPLE = Math.round(16000 * SCALE);
const DECOS = Math.round(20000 * SCALE);
const SPRITES_ON_SCREEN = 13500 / 17600;
const DECOS_ON_SCREEN = 10200 / 20000;
// The queue's capacity: Predator's auto value (computeAutoMaxVisibleRenderables: 42 601 entity slots,
// 10 000 particles, 20 000 decorations, 2 × 2 048 bullet rows, 42 601 glow slots). --max-items
// changes it; a power of two spaces the float columns a multiple of 4 KB apart, and they alias.
const MAX_ITEMS = Number(ARGS['max-items'] ?? Math.max(1024, Math.round(119298 * SCALE)));
const WORLD_W = 12000;
const WORLD_H = 8000;
const DT = 1000 / 60;
const FRAMES = 45;
const SHEETS = 7;
const PROPS = [[128, 160], [192, 160], [48, 40], [32, 40]];
const GRASS = 4;
const PROXY_STATES = 256;
const DECLINED = 0xffffffff;

/** preRenderEmit.c's table, slot for slot. */
const SLOTS = EMIT_SLOTS;
const F_SORT_KEY = 1;
const F_Y_SORT = 2;
const F_TILES_DIRTY = 4;
const F_BOUNDS = 8;

/** The columns of each component the emit reads, moved into the memory. */
const SPRITE_COLUMNS = {
  sScaleX: 'scaleX', sScaleY: 'scaleY', sAlpha: 'alpha', sTint: 'tint', sAnchorX: 'anchorX', sAnchorY: 'anchorY',
  sInherit: 'inheritTransformRotation', sRotC: 'spriteRotC', sRotS: 'spriteRotS', sRepeatX: 'repeatX',
  sRepeatY: 'repeatY', sTileMode: 'tileMode', sTileOffU: 'tileOffsetU', sTileOffV: 'tileOffsetV',
  sHalfW: 'boundsHalfW', sHalfH: 'boundsHalfH', sSheet: 'spritesheetId', sAnim: 'animationState',
  sAnimated: 'isAnimated', sSpeed: 'animationSpeed', sLoop: 'loop', sZ: 'zIndex',
};
const CASTER_COLUMNS = { scActive: 'active', scH: 'heightMultiplier', scOffX: 'anchorOffsetX', scOffY: 'anchorOffsetY' };
const DECO_COLUMNS = {
  dScaleX: 'scaleX', dScaleY: 'scaleY', dAlpha: 'alpha', dTint: 'tint', dTexture: 'textureId', dAnchorX: 'anchorX',
  dAnchorY: 'anchorY',
};
/** The emit's queue columns, by the worker's field. */
const QUEUE_COLUMNS = {
  qX: 'renderQueueX', qY: 'renderQueueY', qScaleX: 'renderQueueScaleX', qScaleY: 'renderQueueScaleY',
  qRotC: 'renderQueueRotC', qRotS: 'renderQueueRotS', qAlpha: 'renderQueueAlpha', qTint: 'renderQueueTint',
  qTexture: 'renderQueueTextureId', qAnchorX: 'renderQueueAnchorX', qAnchorY: 'renderQueueAnchorY',
  qType: 'renderQueueType', qSortKey: 'renderQueueSortKey', qRepeatX: 'renderQueueRepeatX',
  qRepeatY: 'renderQueueRepeatY', qTileMode: 'renderQueueTileMode', qTileOffU: 'renderQueueTileOffsetU',
  qTileOffV: 'renderQueueTileOffsetV', qTileMulX: 'renderQueueTileMulX', qTileMulY: 'renderQueueTileMulY',
  qShadowH: 'renderQueueShadowH', qShadowOffX: 'renderQueueShadowOffX', qShadowOffY: 'renderQueueShadowOffY',
};

/**
 * Texture metadata shaped as Scene builds it: sheets 1–7 proxy civil1.json (one global animation per
 * sheet and animation), sheet 8 the props, then the grass blades and the builtin textures.
 */
function textureMetadata() {
  const civil = JSON.parse(fs.readFileSync(path.join(repoRoot, 'demos/img/civil1.json'), 'utf8'));
  const names = Object.keys(civil.animations);
  const animationFrameStart = [];
  const animationFrameCount = [];
  const widths = [];
  const heights = [];
  let offset = 0;
  const add = (frames, w, h) => {
    const g = animationFrameStart.length;
    animationFrameStart.push(offset);
    animationFrameCount.push(frames);
    for (let f = 0; f < frames; f++) {
      widths.push(w);
      heights.push(h);
    }
    offset += frames;
    return g;
  };
  const proxyToGlobalAnim = {};
  for (let s = 1; s <= SHEETS; s++) {
    proxyToGlobalAnim[s] = {};
    names.forEach((name, local) => { proxyToGlobalAnim[s][local] = add(civil.animations[name].length, 64, 64); });
  }
  const propSheet = SHEETS + 1;
  proxyToGlobalAnim[propSheet] = {};
  PROPS.forEach(([w, h], local) => { proxyToGlobalAnim[propSheet][local] = add(1, w, h); });
  const grass = [];
  for (let k = 0; k < GRASS; k++) grass.push(add(1, 16, 24));
  const animationNameToIndex = {};
  for (const name of ['_lightGradient', '_whiteCircle', '_bulletTrail']) animationNameToIndex[name] = add(1, 64, 64);
  return {
    meta: {
      animationFrameStart,
      animationFrameCount,
      proxyToGlobalAnim,
      animationNameToIndex,
      totalFrames: offset,
      frameWidth: Uint16Array.from(widths),
      frameHeight: Uint16Array.from(heights),
    },
    names,
    propSheet,
    grass,
  };
}

/** Every region of the memory, from constants: the queue buffers, the moved columns, the tables. */
function regionList(tex) {
  const queueBytes = computeBufferSize(MAX_ITEMS);
  const list = [
    { name: 'guard', bytes: NULL_GUARD_BYTES },
    { name: 'queueA', bytes: queueBytes },
    { name: 'queueB', bytes: queueBytes },
  ];
  const col = (slot, Ctor, count) => list.push({ name: slot, bytes: Ctor.BYTES_PER_ELEMENT * count });
  for (const [slot, f] of Object.entries(SPRITE_COLUMNS)) col(slot, SpriteRenderer.ARRAY_SCHEMA[f], N);
  for (const [slot, f] of Object.entries(CASTER_COLUMNS)) col(slot, ShadowCaster.ARRAY_SCHEMA[f], N);
  for (const [slot, f] of Object.entries(DECO_COLUMNS)) col(slot, DecorationComponent.ARRAY_SCHEMA[f], DECOS);
  col('aFrame', Uint16Array, N);
  col('aAccum', Float32Array, N);
  col('aLastTex', Uint16Array, N);
  col('cType', Uint8Array, MAX_ITEMS);
  col('cIndex', Int32Array, MAX_ITEMS);
  col('cY', Float32Array, MAX_ITEMS);
  const nAnims = tex.meta.animationFrameStart.length;
  col('tProxy', Int32Array, (tex.propSheet + 1) * PROXY_STATES);
  col('tFrameCount', Int32Array, nAnims);
  col('tFrameStart', Int32Array, nAnims);
  col('tFrameW', Uint16Array, tex.meta.totalFrames);
  col('tFrameH', Uint16Array, tex.meta.totalFrames);
  col('rEnds', Uint32Array, 2 * MAX_ITEMS);
  col('rWarns', Uint32Array, 2 * MAX_ITEMS);
  // [collector row, queue row] pairs (W27), and the kernel's eight counts.
  col('rForeign', Uint32Array, 2 * MAX_ITEMS);
  col('rCounts', Uint32Array, 8);
  col('table', Uint32Array, SLOTS.length);
  return list.map((r) => ({ ...r, owner: 'preRender' }));
}

/** A view of the same kind as `from` at region `name`, holding its first `count` values. */
function moved(buffer, regions, name, from, count) {
  const view = new from.constructor(buffer, regions[name].byte, count);
  view.set(from.subarray(0, count));
  return view;
}

export async function setupEmitKernel(opts = {}) {
  const seed = opts.seed ?? 0x5e1d;
  const tex = textureMetadata();
  const layout = layoutRegions(regionList(tex));
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  const buffer = memory.buffer;
  const regions = layout.regions;

  const buffers = { componentData: coreComponentData(N) };
  buffers.componentData.ShadowCaster = new SharedArrayBuffer(ShadowCaster.getBufferSize(N));
  buffers.componentData.DecorationComponent = new SharedArrayBuffer(DecorationComponent.getBufferSize(DECOS));
  const worker = await loadWorker('preRenderWorker.js', 'preRenderWorker');
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
    globalEntityCount: N,
    buffers,
    extra: {
      maxDecorations: DECOS,
      textureMetadata: tex.meta,
      renderQueue: {
        maxItems: MAX_ITEMS,
        sync: new SharedArrayBuffer(8),
        dataA: buffer,
        dataAByte: regions.queueA.byte,
        dataB: buffer,
        dataBByte: regions.queueB.byte,
        cameraA: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
        cameraB: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
        entityTextureData: new SharedArrayBuffer(N * 2),
      },
    },
  });
  bindPoseColumns(N);
  if (worker.renderQueueX.buffer !== buffer) throw new Error('the queue is not in the kernel memory');

  // Move every column the emit reads; both variants read them there.
  for (const [slot, f] of Object.entries(SPRITE_COLUMNS)) SpriteRenderer[f] = moved(buffer, regions, slot, SpriteRenderer[f], N);
  for (const [slot, f] of Object.entries(CASTER_COLUMNS)) ShadowCaster[f] = moved(buffer, regions, slot, ShadowCaster[f], N);
  for (const [slot, f] of Object.entries(DECO_COLUMNS)) DecorationComponent[f] = moved(buffer, regions, slot, DecorationComponent[f], DECOS);
  worker.entityFrameIndex = moved(buffer, regions, 'aFrame', worker.entityFrameIndex, N);
  worker.entityFrameAccumulator = moved(buffer, regions, 'aAccum', worker.entityFrameAccumulator, N);
  worker.entityLastTextureId = moved(buffer, regions, 'aLastTex', worker.entityLastTextureId, N);
  worker._renderableType = moved(buffer, regions, 'cType', worker._renderableType, MAX_ITEMS);
  worker._renderableIndex = moved(buffer, regions, 'cIndex', worker._renderableIndex, MAX_ITEMS);
  worker._renderableY = moved(buffer, regions, 'cY', worker._renderableY, MAX_ITEMS);
  worker._decorationZoomAlpha = 0.85;

  // Predator's mix.
  const rng = mulberry32(seed);
  const sr = SpriteRenderer;
  const walk = ['walk_up', 'walk_left', 'walk_down', 'walk_right'].map((a) => tex.names.indexOf(a));
  const idle = ['idle_up', 'idle_left', 'idle_down', 'idle_right'].map((a) => tex.names.indexOf(a));
  const hurt = tex.names.indexOf('hurt');
  const frameIndex = worker.entityFrameIndex;
  const frameAccum = worker.entityFrameAccumulator;
  for (let i = 0; i < N; i++) {
    const person = i < PEOPLE;
    Transform.x[i] = 8 + rng() * (WORLD_W - 16);
    Transform.y[i] = 8 + rng() * (WORLD_H - 16);
    Transform.rotC[i] = 1;
    Transform.rotS[i] = 0;
    sr.active[i] = 1;
    sr.renderVisible[i] = 1;
    const s = person ? 0.9 + rng() * 0.2 : 0.6 + rng() * 0.8;
    sr.scaleX[i] = s;
    sr.scaleY[i] = s;
    sr.alpha[i] = 1;
    sr.tint[i] = person ? 0xffffff : 0xe8e8e8;
    sr.anchorX[i] = 0.5;
    sr.anchorY[i] = person ? 0.98 : 1;
    sr.inheritTransformRotation[i] = 1;
    sr.spriteRotC[i] = 1;
    sr.spriteRotS[i] = 0;
    if (person) {
      const r = rng();
      const playOnce = r < 0.02;
      const anim = playOnce ? hurt : r < 0.62 ? walk[i & 3] : r < 0.92 ? idle[i & 3] : Math.floor(rng() * tex.names.length);
      sr.spritesheetId[i] = 1 + (i % SHEETS);
      sr.animationState[i] = anim;
      sr.isAnimated[i] = 1;
      sr.animationSpeed[i] = 0.15;
      sr.loop[i] = playOnce ? 0 : 1;
      const frames = tex.meta.animationFrameCount[tex.meta.proxyToGlobalAnim[sr.spritesheetId[i]][anim]];
      frameIndex[i] = Math.floor(rng() * frames);
      frameAccum[i] = rng() * 0.1;
    } else {
      sr.spritesheetId[i] = tex.propSheet;
      sr.animationState[i] = i % PROPS.length;
      sr.isAnimated[i] = 0;
      sr.animationSpeed[i] = 0.2;
      sr.loop[i] = 1;
    }
    ShadowCaster.active[i] = 1;
    ShadowCaster.heightMultiplier[i] = 1;
    ShadowCaster.anchorOffsetX[i] = 0;
    ShadowCaster.anchorOffsetY[i] = 0;
  }
  const dc = DecorationComponent;
  for (let d = 0; d < DECOS; d++) {
    dc.active[d] = 1;
    dc.x[d] = rng() * WORLD_W;
    dc.y[d] = rng() * WORLD_H;
    const s = 0.12 + rng() * 0.18;
    dc.scaleX[d] = s;
    dc.scaleY[d] = s;
    const a = (rng() - 0.5) * 0.05;
    dc.rotC[d] = Math.cos(a);
    dc.rotS[d] = Math.sin(a);
    dc.alpha[d] = 1;
    dc.tint[d] = 0x9fdf7f;
    dc.textureId[d] = tex.grass[d % GRASS];
    dc.anchorX[d] = 0.5;
    dc.anchorY[d] = 1;
  }

  // The collector after collectVisibleEntities then collectVisibleDecorations, poses in the queue (E-98d).
  const cType = worker._renderableType;
  const cIndex = worker._renderableIndex;
  const cY = worker._renderableY;
  const qX = worker.renderQueueX;
  const qY = worker.renderQueueY;
  const qRotC = worker.renderQueueRotC;
  const qRotS = worker.renderQueueRotS;
  let count = 0;
  let sprites = 0;
  for (let i = 0; i < N; i++) {
    if (rng() >= SPRITES_ON_SCREEN) continue;
    cType[count] = 0;
    cIndex[count] = i;
    cY[count] = Math.round(Transform.y[i]) * DECORATION_Y_SORT_SCALE;
    qX[count] = Transform.x[i];
    qY[count] = Transform.y[i];
    qRotC[count] = Transform.rotC[i];
    qRotS[count] = Transform.rotS[i];
    count++;
    sprites++;
  }
  for (let d = 0; d < DECOS; d++) {
    if (rng() >= DECOS_ON_SCREEN) continue;
    cType[count] = 2;
    cIndex[count] = d;
    cY[count] = dc.y[d] * DECORATION_Y_SORT_SCALE;
    qX[count] = dc.x[d];
    qY[count] = dc.y[d];
    qRotC[count] = dc.rotC[d];
    qRotS[count] = dc.rotS[d];
    count++;
  }

  // The kernel's tables: flat copies of the worker's texture metadata.
  const meta = tex.meta;
  const nAnims = meta.animationFrameStart.length;
  const proxy = new Int32Array(buffer, regions.tProxy.byte, (tex.propSheet + 1) * PROXY_STATES).fill(-1);
  for (const [sheet, states] of Object.entries(meta.proxyToGlobalAnim)) {
    for (const [state, g] of Object.entries(states)) proxy[Number(sheet) * PROXY_STATES + Number(state)] = g;
  }
  new Int32Array(buffer, regions.tFrameCount.byte, nAnims).set(meta.animationFrameCount);
  new Int32Array(buffer, regions.tFrameStart.byte, nAnims).set(meta.animationFrameStart);
  new Uint16Array(buffer, regions.tFrameW.byte, meta.totalFrames).set(meta.frameWidth);
  new Uint16Array(buffer, regions.tFrameH.byte, meta.totalFrames).set(meta.frameHeight);

  const t = new Uint32Array(buffer, regions.table.byte, SLOTS.length);
  const at = (slot, value) => {
    const k = SLOTS.indexOf(slot);
    if (k < 0) throw new Error(`no slot ${slot}`);
    t[k] = value;
  };
  for (const name of ['cType', 'cIndex', 'cY', 'aFrame', 'aAccum', 'aLastTex', 'tProxy', 'tFrameCount', 'tFrameStart',
    'tFrameW', 'tFrameH', 'rEnds', 'rWarns', 'rForeign', 'rCounts', ...Object.keys(SPRITE_COLUMNS), ...Object.keys(CASTER_COLUMNS),
    ...Object.keys(DECO_COLUMNS)]) {
    at(name, regions[name].byte);
  }
  for (const [slot, field] of Object.entries(QUEUE_COLUMNS)) {
    const view = worker[field];
    at(slot, view && view.buffer === buffer ? view.byteOffset : 0);
  }
  at('stashX', qX.byteOffset);
  at('stashY', qY.byteOffset);
  at('stashRc', qRotC.byteOffset);
  at('stashRs', qRotS.byteOffset);
  at('tSheets', tex.propSheet + 1);
  at('tAnims', nAnims);
  at('tFrames', meta.totalFrames);

  const source = () => worker._fillEmitSource(count, MAX_ITEMS, cY, cType, cIndex, qX, qY, qRotC, qRotS, false, true, true);
  source();
  const emitJs = () => worker.emitSpriteQueue(DT, worker._emitSource);

  const { emit_rows: emitRows } = await loadWasmKernel('preRenderEmit', KERNEL_URL, memory, ['emit_rows']);
  const ends = new Uint32Array(buffer, regions.rEnds.byte, 2 * MAX_ITEMS);
  const results = new Uint32Array(buffer, regions.rCounts.byte, 4);
  const flags = () => F_SORT_KEY | F_Y_SORT | F_BOUNDS
    | (worker.renderQueueTileMode !== null && worker._tiledTileColumns.has(worker.renderQueueTileMode) ? F_TILES_DIRTY : 0);
  let declined = 0;
  /** What a product wrapper does around the kernel: the JS emit when declined, then the ends and warnings. */
  const emitWasm = (rows = count) => {
    const written = emitRows(regions.table.byte, rows, MAX_ITEMS, flags(), DT / 1000, worker._decorationZoomAlpha, worker._zBand) >>> 0;
    if (written === DECLINED) {
      declined++;
      return emitJs();
    }
    const endsCount = results[0];
    for (let k = 0; k < endsCount; k++) {
      const idx = ends[2 * k];
      if (worker._animEndByType[Transform.entityType[idx]] === 1) worker._spriteAnimationEnded(idx, ends[2 * k + 1]);
    }
    if (results[1] > 0) throw new Error(`${results[1]} missing textures in a fixture that has them all`);
    if (results[2] && worker.renderQueueTileMode !== null) worker._tiledTileColumns.add(worker.renderQueueTileMode);
    return written;
  };

  const hashed = [
    ...Object.values(QUEUE_COLUMNS).map((f) => worker[f]).filter(Boolean),
  ];
  const state = [frameIndex, frameAccum, worker.entityLastTextureId, sr.boundsHalfW, sr.boundsHalfH];
  function hashFrame(h, written) {
    for (const c of hashed) h = hashBytes(h, new Uint8Array(c.buffer, c.byteOffset, written * c.BYTES_PER_ELEMENT));
    for (const a of state) h = hashBytes(h, new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    return h;
  }

  return {
    worker, count, sprites, decorations: count - sprites, source, emitJs, emitWasm, emitRows, hashFrame,
    declined: () => declined, tableByte: regions.table.byte,
  };
}

function hashBytes(h, bytes) {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
  return h;
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'js');
  if (!['js', 'wasm'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const k = await setupEmitKernel({ seed: Number(args.seed ?? 0x5e1d) });
  const emit = variant === 'wasm' ? () => k.emitWasm() : () => k.emitJs();

  // 45 frames from the fixture's state: the animation clocks advance, play-once sprites end.
  let checksum = 2166136261;
  let written = 0;
  for (let f = 0; f < FRAMES; f++) {
    written = emit();
    checksum = Math.imul(checksum ^ written, 16777619) >>> 0;
    checksum = k.hashFrame(checksum, written);
  }
  if (written !== k.count) throw new Error(`wrote ${written} of ${k.count} rows`);

  // Normal compiles, not OSR: short calls over the first 64 rows.
  let tier = null;
  if (variant === 'wasm') {
    tier = await warmWasm(k.emitRows, () => k.emitWasm(64));
  } else {
    k.worker._emitSource.count = 64;
    warmNormalCompile(() => k.emitJs());
    k.source();
  }
  const cases = {
    emit: timeIt(`preRender emit ${variant} (${k.sprites} sprites, ${k.decorations} decorations)`, emit, { iterations: 20, warmup: 10 }),
  };
  const report = {
    feature: 'preRender-emit-wasm',
    variant,
    functions: ['PreRenderWorker.emitSpriteQueue', 'preRenderEmit.emit_rows'],
    rows: { sprites: k.sprites, decorations: k.decorations },
    checksum,
    declined: k.declined(),
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum} rows ${k.count} (${k.sprites} sprites)${tier ? ` tier ${tier}` : ''} emit ${cases.emit.opsPerSec.toFixed(1)} ops/s`);
}

if (isCli(import.meta.url)) await main();
