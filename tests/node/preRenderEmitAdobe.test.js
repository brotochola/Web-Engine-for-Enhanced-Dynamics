// W27: preRenderEmit.wasm expands Adobe Animate roots (type 6) into their pieces. On a real pre-render worker,
// the render-queue memory laid out with the emit's Adobe regions, emitSpriteQueue with the kernel bound must leave
// the queue, the animation state and the persist state as the JS loop leaves them (_emitAdobePieces and
// _resolveAdobeFrameIndex for the roots), bit for bit, frame after frame, with sprites, decorations and rows of
// other types around the roots (those after a root move down). The mix: synthetic assets with and without
// prebaked piece rotations, clip bounds shorter than the clips (the asset bounds then, doubles), empty frames,
// clips with no frames or no frame rate, unregistered asset ids; roots flipped on one axis or both, turned,
// zero-scaled, with clocks before, inside and past their clip, looping or not; shadow casters on the roots, a
// tiled sprite (the tile columns dirty after it), sort keys with and without an order, Y-sort on and off, a
// queue that overflows in the middle of a root. The demo's own asset (willian) is one of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { ShadowCaster } from '../../src/components/shadowCaster.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { BulletComponent } from '../../src/components/bulletComponent.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { AdobeAnimComponent } from '../../src/components/adobeAnimComponent.js';
import { AdobeAnimRegistry } from '../../src/core/adobeAnimRegistry.js';
import { AdobeAnimCompiler } from '../../src/util/adobeAnimCompiler.js';
import { computeBufferSize, RENDER_QUEUE_CAMERA_BYTES } from '../../src/render/renderQueueLayout.js';
import { computeGpuQueueBufferSize, gpuQueueCaps } from '../../src/render/gpuQueueLayout.js';
import { createRenderQueueMemory } from '../../src/util/renderQueueMemory.js';
import { EMIT_ADOBE_ASSET_BYTES } from '../../src/util/wasmMemoryMap.js';
import { EMIT_ADOBE_IN, EMIT_ADOBE_JS, EMIT_ADOBE_NONE, EMIT_DECLINED } from '../../src/workers/preRenderEmitClient.js';
import { bindPoseColumns, coreComponentData, initWorker, loadWorker } from '../bench/workerHarness.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const N = 500;
const ROOTS = 200; // entities 0 … 199 carry AdobeAnimComponent, the rest sprites
const DECOS = 120;
const POOL = 64;
const DT = 1000 / 60;
const FRAMES = 12;

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

/** Sheets 1-2 with 1-, 3- and 8-frame animations, then the builtin textures the other rows use. */
function textureMetadata() {
  const animationFrameStart = [];
  const animationFrameCount = [];
  const widths = [];
  const heights = [];
  const proxyToGlobalAnim = {};
  let offset = 0;
  for (let sheet = 1; sheet <= 2; sheet++) {
    proxyToGlobalAnim[sheet] = {};
    [1, 3, 8].forEach((frames, local) => {
      proxyToGlobalAnim[sheet][local] = animationFrameStart.length;
      animationFrameStart.push(offset);
      animationFrameCount.push(frames);
      for (let f = 0; f < frames; f++) {
        widths.push(16 + ((sheet * 7 + f * 5) % 40));
        heights.push(20 + ((sheet * 11 + f * 3) % 30));
      }
      offset += frames;
    });
  }
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
    animationFrameStart, animationFrameCount, proxyToGlobalAnim, animationNameToIndex, totalFrames: offset,
    frameWidth: Uint16Array.from(widths), frameHeight: Uint16Array.from(heights),
  };
}

/**
 * An asset shaped as AdobeAnimCompiler shapes one, from `clips` ([frames, frame rate] each). prebaked false
 * leaves pieceRotC/pieceRotS out (the JS then takes Math.cos/Math.sin of pieceRotation); shortBounds gives the
 * clip bounds two entries fewer than the clips (the last clips fall back to the asset bounds).
 */
function synthAsset(name, seed, clips, { prebaked = true, shortBounds = false } = {}) {
  const r = rng(seed);
  const clipFrameStart = [];
  const framePieceStart = [];
  const framePieceCount = [];
  const p = { x: [], y: [], sx: [], sy: [], rot: [], alpha: [], ax: [], ay: [], tex: [] };
  clips.forEach(([frames]) => {
    clipFrameStart.push(framePieceStart.length);
    for (let f = 0; f < frames; f++) {
      const n = f % 5 === 3 ? 0 : 1 + Math.floor(r() * 9);
      framePieceStart.push(p.x.length);
      framePieceCount.push(n);
      // Every third frame its pieces on one line: on an unturned root they tie for the feet (the last one wins).
      const line = f % 3 === 1 ? (r() - 0.8) * 300 : null;
      for (let k = 0; k < n; k++) {
        p.x.push((r() - 0.5) * 200);
        p.y.push(line !== null ? line : (r() - 0.8) * 300);
        p.sx.push(r() < 0.1 ? -(0.5 + r()) : 0.5 + r());
        p.sy.push(0.5 + r());
        p.rot.push((r() - 0.5) * 6);
        p.alpha.push(r());
        p.ax.push(r());
        p.ay.push(r());
        p.tex.push(1 + Math.floor(r() * 500));
      }
    }
  });
  const bounds = clips.length - (shortBounds ? 2 : 0);
  const rand = (n, lo, hi) => Float32Array.from({ length: n }, () => lo + r() * (hi - lo));
  const asset = {
    name,
    clipNames: clips.map((_, k) => `clip${k}`),
    clipNameToId: Object.fromEntries(clips.map((_, k) => [`clip${k}`, k])),
    clipFrameStart: Uint32Array.from(clipFrameStart),
    clipFrameCount: Uint16Array.from(clips.map(([frames]) => frames)),
    clipFrameRate: Float32Array.from(clips.map(([, rate]) => rate)),
    // Doubles, not floats: the JS reads them as they are.
    assetBoundsMinX: -101.123456789,
    assetBoundsMinY: -250.987654321,
    assetBoundsMaxX: 99.3333333333,
    assetBoundsMaxY: 12.7777777777,
    clipBoundsMinX: rand(bounds, -120, -40),
    clipBoundsMinY: rand(bounds, -260, -150),
    clipBoundsMaxX: rand(bounds, 40, 120),
    clipBoundsMaxY: rand(bounds, 0, 30),
    framePieceStart: Uint32Array.from(framePieceStart),
    framePieceCount: Uint16Array.from(framePieceCount),
    pieceTextureId: Uint16Array.from(p.tex),
    pieceX: Float32Array.from(p.x),
    pieceY: Float32Array.from(p.y),
    pieceRotation: Float32Array.from(p.rot),
    pieceScaleX: Float32Array.from(p.sx),
    pieceScaleY: Float32Array.from(p.sy),
    pieceAlpha: Float32Array.from(p.alpha),
    pieceAnchorX: Float32Array.from(p.ax),
    pieceAnchorY: Float32Array.from(p.ay),
  };
  if (prebaked) {
    asset.pieceRotC = Float32Array.from(p.rot, Math.cos);
    asset.pieceRotS = Float32Array.from(p.rot, Math.sin);
  }
  return asset;
}

let willianAsset = null;
/** The Adobe Animate demo's asset, compiled as the scene compiles it, texture ids of the test's own. */
function willian() {
  if (willianAsset) return willianAsset;
  const dir = path.join(repoRoot, 'demos/fla/willian/willian2');
  const read = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').replace(/^﻿/, ''));
  willianAsset = AdobeAnimCompiler.compile('willian', read('Animation.json'), read('spritemap1.json'));
  for (let q = 0; q < willianAsset.pieceTextureId.length; q++) willianAsset.pieceTextureId[q] = 1 + ((q * 13) % 900);
  return willianAsset;
}

/** The registry the cases use: ids 1, 2 synthetic (prebaked, not), 3 the demo's, 4 synthetic with plain arrays. */
function registerAssets({ plain = false } = {}) {
  AdobeAnimRegistry.clearForSceneUnload();
  const clips = [[12, 24], [1, 30], [0, 24], [5, 0], [7, 12.5], [9, 60]];
  AdobeAnimRegistry.register('synthA', synthAsset('synthA', 11, clips, { prebaked: true, shortBounds: true }));
  AdobeAnimRegistry.register('synthB', synthAsset('synthB', 22, clips, { prebaked: false }));
  AdobeAnimRegistry.register('willian', willian());
  if (plain) {
    // Plain arrays, as an asset built by hand might hold: the JS reads them as doubles, the kernel cannot.
    const a = synthAsset('plain', 33, clips);
    for (const k of Object.keys(a)) if (ArrayBuffer.isView(a[k])) a[k] = Array.from(a[k]);
    AdobeAnimRegistry.register('plain', a);
  }
}

async function setup({
  ySort = true, hasOrder = true, maxItems = 8000, count = 1200, seed = 0xad0, tablesBytes = 4 * 1048576,
  adobeOn = true, plain = false, shadows = true,
}) {
  registerAssets({ plain });
  const caps = gpuQueueCaps(maxItems, { enabled: false });
  const m = createRenderQueueMemory(maxItems, computeBufferSize(maxItems), computeGpuQueueBufferSize(caps), {
    entities: N,
    spriteBytes: SpriteRenderer.getBufferSize(N),
    casterBytes: ShadowCaster.getBufferSize(N),
    decorationBytes: DecorationComponent.getBufferSize(DECOS),
    adobe: { animBytes: AdobeAnimComponent.getBufferSize(N), tableBytes: tablesBytes },
  });
  const e = m.layout.emit;
  const buffers = {
    componentData: {
      ...coreComponentData(N),
      SpriteRenderer: m.buffer,
      ShadowCaster: m.buffer,
      DecorationComponent: m.buffer,
      AdobeAnimComponent: m.buffer,
      LightEmitter: new SharedArrayBuffer(LightEmitter.getBufferSize(N)),
      ParticleComponent: new SharedArrayBuffer(ParticleComponent.getBufferSize(POOL)),
      BulletComponent: new SharedArrayBuffer(BulletComponent.getBufferSize(POOL)),
    },
    componentDataByte: {
      SpriteRenderer: e.spriteRendererByte, ShadowCaster: e.shadowCasterByte, DecorationComponent: e.decorationByte,
      AdobeAnimComponent: e.adobeAnimByte,
    },
  };
  for (const C of [SpriteRenderer, ShadowCaster, DecorationComponent, AdobeAnimComponent]) C.clearArrays();
  const meta = textureMetadata();
  const worker = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const warned = [];
  const realWarn = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  try {
    await initWorker(worker, {
      config: {
        worldWidth: 4000, worldHeight: 3000, preRender: { interpolation: false }, renderer: { ySort },
        wasm: { preRenderEmitAdobe: adobeOn },
      },
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
  } finally {
    console.warn = realWarn;
  }
  bindPoseColumns(N);
  assert.equal(AdobeAnimComponent.scaleX.buffer, m.buffer, 'AdobeAnimComponent is in the memory');
  assert.equal(worker._renderablePx.buffer, m.buffer, 'the pose stash is in the memory');
  assert.ok(worker._emitWasm, 'the worker bound the kernel');
  worker._decorationZoomAlpha = 0.6;
  worker._animEndByType = new Uint8Array(256).fill(1);

  const r = rng(seed);
  const sr = SpriteRenderer;
  for (let i = 0; i < N; i++) {
    // zIndex on every entity: an Adobe root's sort key reads SpriteRenderer.zIndex too.
    sr.zIndex[i] = (i % 7) - 3;
    ShadowCaster.active[i] = shadows && i % 3 !== 0 ? 1 : 0;
    ShadowCaster.heightMultiplier[i] = i % 17 === 0 ? NaN : r() * 2;
    ShadowCaster.anchorOffsetX[i] = i % 11 === 0 ? -0 : r();
    ShadowCaster.anchorOffsetY[i] = r() - 0.5;
    if (i < ROOTS) continue;
    sr.active[i] = 1;
    sr.scaleX[i] = 0.5 + r();
    sr.scaleY[i] = 0.5 + r();
    sr.alpha[i] = r();
    sr.tint[i] = (r() * 0xffffff) >>> 0;
    sr.anchorX[i] = r();
    sr.anchorY[i] = r();
    sr.inheritTransformRotation[i] = i % 3 === 0 ? 0 : 1;
    sr.spriteRotC[i] = Math.cos(i);
    sr.spriteRotS[i] = Math.sin(i);
    // A few tiled sprites: from their first frame on, the other rows clear the tile columns.
    sr.repeatX[i] = i % 41 === 0 ? 32 : 0;
    sr.repeatY[i] = 0;
    sr.tileMode[i] = 1;
    sr.boundsHalfW[i] = 10 + (i % 40);
    sr.boundsHalfH[i] = 12 + (i % 30);
    sr.spritesheetId[i] = 1 + (i % 2);
    sr.animationState[i] = i % 3;
    sr.isAnimated[i] = 1;
    sr.animationSpeed[i] = 0.2 + r() * 0.8;
    sr.loop[i] = i % 13 === 0 ? 0 : 1;
    worker.entityFrameIndex[i] = i % 8;
    worker.entityFrameAccumulator[i] = r() * 0.1;
  }
  const a = AdobeAnimComponent;
  for (let i = 0; i < ROOTS; i++) {
    a.active[i] = 1;
    // Mostly the three assets, some with no asset (0), an id nothing registered (7), and with plain, id 4.
    const pick = i % 10;
    a.assetId[i] = pick < 3 ? 1 : pick < 6 ? 2 : pick < 8 ? 3 : pick === 8 ? (plain && i % 20 === 8 ? 4 : 0) : 7;
    const asset = AdobeAnimRegistry.getAsset(a.assetId[i]);
    const clips = asset ? asset.clipNames.length : 1;
    // Every clip, and now and then one past the last (no frames).
    a.clipId[i] = i % 23 === 0 ? clips + 1 : i % clips;
    const frames = AdobeAnimRegistry.getClipFrameCount(a.assetId[i], a.clipId[i]);
    const rate = AdobeAnimRegistry.getClipFrameRate(a.assetId[i], a.clipId[i]);
    const duration = rate > 0 ? frames / rate : 1;
    // Before, inside and past the clip.
    a.time[i] = i % 19 === 0 ? -0.3 : i % 17 === 0 ? duration * 2.5 : r() * duration;
    a.loop[i] = i % 4 === 0 ? 0 : 1;
    a.playing[i] = 1;
    a.playbackRate[i] = 0.5 + r();
    // Flipped on one axis (the mirror sign), on both, zero-scaled; turned by AdobeAnimComponent's rotation.
    const sx = 0.2 + r() * 0.5;
    const sy = 0.2 + r() * 0.5;
    a.scaleX[i] = i % 5 === 1 ? -sx : i % 5 === 2 ? -sx : sx;
    a.scaleY[i] = i % 5 === 2 ? -sy : i % 5 === 3 ? -sy : i % 29 === 0 ? 0 : sy;
    a.anchorX[i] = r();
    a.anchorY[i] = i % 2 ? 1 : r();
    // Unturned ones among the casters (i % 3 !== 0): their pieces on one line tie for the shadow.
    const turn = i % 6 === 1 ? 0 : (r() - 0.5) * 2;
    a.rotC[i] = Math.cos(turn);
    a.rotS[i] = Math.sin(turn);
    a.alpha[i] = r();
    a.tint[i] = (r() * 0xffffff) >>> 0;
  }
  for (let d = 0; d < DECOS; d++) {
    DecorationComponent.scaleX[d] = r();
    DecorationComponent.scaleY[d] = r();
    DecorationComponent.alpha[d] = r();
    DecorationComponent.tint[d] = (r() * 0xffffff) >>> 0;
    DecorationComponent.textureId[d] = d % 5;
    DecorationComponent.anchorX[d] = r();
    DecorationComponent.anchorY[d] = r();
  }

  // The collector: roots, sprites, decorations and rows of other types, poses in the stash (a frame with a root).
  const types = [];
  const indices = [];
  for (let q = 0; q < count; q++) {
    const pick = r();
    if (pick < 0.3) { types.push(6); indices.push(Math.floor(r() * ROOTS)); }
    else if (pick < 0.6) { types.push(0); indices.push(ROOTS + Math.floor(r() * (N - ROOTS))); }
    else if (pick < 0.85) { types.push(2); indices.push(Math.floor(r() * DECOS)); }
    else { types.push([1, 3, 4, 5][q % 4]); indices.push(q % POOL); }
  }
  // The first rows: a sprite, then a root, so the root's rows follow it, and rows of other types after it.
  types[0] = 0; indices[0] = ROOTS + 1;
  types[1] = 6; indices[1] = 4;
  types[2] = 1; types[3] = 3;
  for (let q = 0; q < count; q++) {
    worker._renderableType[q] = types[q];
    worker._renderableIndex[q] = indices[q];
    worker._renderableY[q] = Math.round(r() * 3000) * 128 + (q % 3 === 0 ? -0 : 0);
  }
  const stash = { x: worker._renderablePx, y: worker._renderablePy, rc: worker._renderableRotC, rs: worker._renderableRotS };
  const source = () => worker._fillEmitSource(count, maxItems, worker._renderableY, worker._renderableType,
    worker._renderableIndex, stash.x, stash.y, stash.rc, stash.rs, true, hasOrder, hasOrder && ySort);

  /** Frame f's poses and clocks, the same calls on both runs. */
  const prepare = (f) => {
    const fr = rng(seed * 1000 + f);
    for (let q = 0; q < count; q++) {
      stash.x[q] = fr() * 4000;
      stash.y[q] = fr() * 3000;
      const turn = q % 4 === 0 ? 0 : fr() * 6.3;
      stash.rc[q] = Math.cos(turn);
      stash.rs[q] = Math.sin(turn);
    }
    for (let i = 0; i < ROOTS; i++) a.time[i] += (DT / 1000) * a.playbackRate[i];
  };

  const queueBytes = new Uint8Array(m.buffer, m.layout.queueAByte, computeBufferSize(maxItems));
  // What either side may write, and what neither may: the collector, its stash, the persist rows.
  const state = [
    worker.entityFrameIndex, worker.entityFrameAccumulator, worker.entityLastTextureId,
    SpriteRenderer.boundsHalfW, SpriteRenderer.boundsHalfH, a.time, a.playing,
    worker._renderableType, worker._renderableIndex, worker._renderableY, stash.x, stash.y, stash.rc, stash.rs,
    ...worker._persistType, ...worker._persistEntity, ...worker._persistFrame, ...worker._persistAnim,
  ];
  const snapshot = () => ({ queue: queueBytes.slice(), state: state.map((v) => v.slice()) });
  const restore = (s) => {
    queueBytes.set(s.queue);
    state.forEach((v, k) => v.set(s.state[k]));
    worker._tiledTileColumns = new Set();
    worker._persistCount = [0, 0];
    worker._adobeRenderQueueOverflowWarned = false;
  };
  return { worker, m, source, prepare, snapshot, restore, types, count, maxItems, warnedAtInit: warned };
}

/**
 * The same frames through the JS loop and through the kernel, from the same start: everything they write must
 * be equal. Returns the kernel run's calls ([written or declined] per frame) and what each run warned.
 */
function compare(k, frames = FRAMES) {
  const { worker } = k;
  const bound = worker._emitWasm;
  const start = k.snapshot();
  const realEnded = worker._spriteAnimationEnded;
  const realMissing = worker._warnMissingTexture;
  const realWarn = console.warn;
  const calls = [];
  const realRows = bound.emitRows;
  bound.emitRows = (...args) => {
    const got = realRows(...args);
    calls.push(got);
    return got;
  };
  const run = (kernel) => {
    k.restore(start);
    worker._emitWasm = kernel ? bound : null;
    const out = [];
    const warned = [];
    console.warn = (msg) => warned.push(String(msg));
    for (let f = 0; f < frames; f++) {
      k.prepare(f);
      const ends = [];
      const missing = [];
      worker._spriteAnimationEnded = (idx, anim) => ends.push(`${idx}:${anim}`);
      worker._warnMissingTexture = (key) => missing.push(key);
      const written = worker.emitSpriteQueue(DT, k.source());
      out.push({
        written, snap: k.snapshot(), ends, missing: missing.sort(), tiled: worker._tiledTileColumns.size,
        counts: [...worker._persistCount], gen: worker._staticGen,
      });
    }
    console.warn = realWarn;
    worker._spriteAnimationEnded = realEnded;
    worker._warnMissingTexture = realMissing;
    return { out, warned };
  };
  const genStart = worker._staticGen;
  const js = run(false);
  worker._staticGen = genStart;
  calls.length = 0;
  const wasm = run(true);
  bound.emitRows = realRows;
  worker._emitWasm = bound;
  for (let f = 0; f < frames; f++) {
    const got = wasm.out[f];
    const want = js.out[f];
    assert.equal(got.written, want.written, `frame ${f}: rows written`);
    const at = got.snap.queue.findIndex((x, i) => x !== want.snap.queue[i]);
    if (at >= 0) assert.fail(`frame ${f}: the queue differs at byte ${at} (${describe(worker, k, at)})`);
    got.snap.state.forEach((v, s) => {
      assert.deepEqual(Buffer.from(v.buffer, v.byteOffset, v.byteLength),
        Buffer.from(want.snap.state[s].buffer, want.snap.state[s].byteOffset, want.snap.state[s].byteLength), `frame ${f}: state ${s}`);
    });
    assert.deepEqual(got.ends, want.ends, `frame ${f}: play-once ends, in order`);
    assert.deepEqual(got.missing, want.missing, `frame ${f}: missing textures`);
    assert.deepEqual({ tiled: got.tiled, counts: got.counts, gen: got.gen }, { tiled: want.tiled, counts: want.counts, gen: want.gen }, `frame ${f}`);
  }
  assert.deepEqual(wasm.warned, js.warned, 'the warnings');
  return { calls, js, wasm };
}

/** Which queue column and row a byte of queue A is. */
function describe(worker, k, at) {
  const base = k.m.layout.queueAByte;
  for (const [name, v] of Object.entries(worker.renderQueueBuffers[0])) {
    if (!ArrayBuffer.isView(v) || name === 'sortKeyU32') continue;
    const from = v.byteOffset - base;
    if (at >= from && at < from + v.byteLength) {
      const row = Math.floor((at - from) / v.BYTES_PER_ELEMENT);
      return `${name}[${row}]`;
    }
  }
  return 'outside the columns';
}

test('the kernel expands Adobe roots as _emitAdobePieces does, Y-sorted, with shadows', async (t) => {
  const k = await setup({ ySort: true, seed: 0xad1 });
  const { calls, js } = compare(k);
  assert.equal(calls.length, FRAMES);
  assert.ok(calls.every((c) => c !== EMIT_DECLINED), 'the kernel took every frame');
  const written = js.out[0].written;
  assert.ok(written > k.count, `the roots expanded (${written} rows from ${k.count})`);
  t.diagnostic(`${k.count} collector rows, ${k.types.filter((x) => x === 6).length} roots, ${written} queue rows`);
});

test('the kernel expands Adobe roots without Y-sort, and without an order (the roots\' keys are the collector\'s)', async () => {
  for (const [ySort, hasOrder, seed] of [[false, true, 0xad2], [true, false, 0xad3], [false, false, 0xad4]]) {
    const k = await setup({ ySort, hasOrder, seed, shadows: seed !== 0xad3 });
    const { calls } = compare(k, 6);
    assert.ok(calls.every((c) => c !== EMIT_DECLINED), `ySort ${ySort}, order ${hasOrder}: every frame`);
  }
});

test('a queue that fills in the middle of a root stops there, and warns once', async () => {
  const k = await setup({ maxItems: 700, count: 700, seed: 0xad5 });
  const { calls, js } = compare(k, 4);
  assert.ok(calls.every((c) => c === 700), 'the kernel filled the queue on every frame');
  assert.equal(js.out[0].written, 700);
  assert.equal(js.warned.filter((w) => w.includes('piece expansion exceeded')).length, 1, 'one warning');
  // The collector row the queue filled at: some rows were never reached.
  assert.equal(k.worker._adobeRenderQueueOverflowWarned, true);
});

test('the asset directory: every registered asset in the tables, as the kernel reads it', async () => {
  const k = await setup({ seed: 0xad6 });
  const b = k.worker._emitWasm;
  const e = k.m.layout.emit;
  const words = new Uint32Array(k.m.buffer, e.adobeAssetsByte, (4 * EMIT_ADOBE_ASSET_BYTES) / 4);
  const kind = (id) => words[(id * EMIT_ADOBE_ASSET_BYTES) / 4];
  assert.equal(b.adobeReady, true);
  assert.equal(b.adobeFrom, AdobeAnimRegistry.assetById);
  assert.deepEqual([kind(0), kind(1), kind(2), kind(3)], [EMIT_ADOBE_NONE, EMIT_ADOBE_IN, EMIT_ADOBE_IN, EMIT_ADOBE_IN]);
  // synthB has no pieceRotC: the rotation column holds Math.cos of pieceRotation, as doubles.
  const synthB = AdobeAnimRegistry.getAsset(2);
  const rec = (2 * EMIT_ADOBE_ASSET_BYTES) / 4;
  const pieces = words[rec + 18];
  const cos = new Float64Array(k.m.buffer, words[rec + 23], pieces);
  for (let p = 0; p < pieces; p++) assert.equal(cos[p], Math.cos(synthB.pieceRotation[p]));
  assert.ok(pieces > 0 && pieces <= synthB.pieceX.length);
});

test('a root whose asset is not in the tables declines the frame, and the JS emits it', async () => {
  // Plain arrays: not in the tables, no warning.
  const plain = await setup({ seed: 0xad7, plain: true });
  const words = new Uint32Array(plain.m.buffer, plain.m.layout.emit.adobeAssetsByte, (5 * EMIT_ADOBE_ASSET_BYTES) / 4);
  assert.equal(words[(4 * EMIT_ADOBE_ASSET_BYTES) / 4], EMIT_ADOBE_JS, 'the plain asset is marked for the JS');
  assert.equal(plain.warnedAtInit.length, 0);
  const one = compare(plain, 3);
  assert.ok(one.calls.every((c) => c === EMIT_DECLINED), 'declined: a root plays the plain asset');

  // No room for the demo's asset (the synthetic ones fit): one warning when the tables are written, then the
  // frames with one of its roots go to the JS.
  const small = await setup({ seed: 0xad8, tablesBytes: 4096 });
  assert.equal(small.warnedAtInit.filter((w) => w.includes('"willian"')).length, 1, small.warnedAtInit.join('\n'));
  const two = compare(small, 3);
  assert.ok(two.calls.every((c) => c === EMIT_DECLINED));

  // Switched off, the kernel declines every frame with a root.
  const off = await setup({ seed: 0xad9, adobeOn: false });
  assert.equal(off.worker._emitWasm.adobe, false);
  const three = compare(off, 2);
  assert.ok(three.calls.every((c) => c === EMIT_DECLINED));
});

test('frames without a root after the asset tables keep row i at queue row i', async () => {
  const k = await setup({ seed: 0xada });
  const cType = k.worker._renderableType;
  for (let q = 0; q < k.count; q++) {
    if (cType[q] === 6) cType[q] = 0;
    if (cType[q] === 0 && k.worker._renderableIndex[q] < ROOTS) k.worker._renderableIndex[q] += ROOTS;
  }
  const { calls } = compare(k, 4);
  assert.ok(calls.every((c) => c === k.count), 'one queue row per collector row');
});

test('a LiquidFun row still declines the frame', async () => {
  const k = await setup({ seed: 0xadb });
  const b = k.worker._emitWasm;
  k.worker._renderableType[50] = 7;
  assert.ok(k.worker._writeEmitTable(k.source()));
  assert.equal(b.emitRows(b.tableByte, k.count, k.maxItems, 0, DT / 1000, 1, k.worker._zBand), EMIT_DECLINED);
});

/**
 * advanceAdobeAnimations through adobe_advance and through its JS loop, from the same clocks: AdobeAnimComponent's
 * time and playing flags after every frame, and the ended clips in the order the JS reports them.
 */
function compareAdvance(k, frames) {
  const { worker } = k;
  const a = AdobeAnimComponent;
  const bound = worker._emitWasm;
  const ids = Uint16Array.from({ length: ROOTS }, (_, i) => (i * 7) % ROOTS);
  const start = { time: a.time.slice(), playing: a.playing.slice() };
  const realEnded = worker._adobeAnimationEnded;
  const calls = [];
  const realAdvance = bound.adobeAdvance;
  bound.adobeAdvance = (...args) => {
    const got = realAdvance(...args);
    calls.push(got);
    return got;
  };
  const run = (kernel) => {
    a.time.set(start.time);
    a.playing.set(start.playing);
    worker._emitWasm = kernel ? bound : null;
    const out = [];
    for (let f = 0; f < frames; f++) {
      const ended = [];
      worker._adobeAnimationEnded = (i) => ended.push(i);
      worker._frameAdobeEntities = ids;
      // Long and short frames, and one with no time at all (the JS returns before its loop).
      worker.advanceAdobeAnimations(f % 9 === 4 ? 0 : DT * (f % 5 === 2 ? 7 : 1));
      // A copy of the clocks' bytes (Buffer.from of a typed array copies; of its buffer it would be a view).
      out.push({ time: Buffer.from(new Uint8Array(a.time.buffer, a.time.byteOffset, a.time.byteLength)), playing: [...a.playing], ended });
    }
    worker._adobeAnimationEnded = realEnded;
    return out;
  };
  const js = run(false);
  calls.length = 0;
  const wasm = run(true);
  bound.adobeAdvance = realAdvance;
  worker._emitWasm = bound;
  for (let f = 0; f < frames; f++) {
    assert.deepEqual(wasm[f].time, js[f].time, `frame ${f}: the clocks`);
    assert.deepEqual(wasm[f].playing, js[f].playing, `frame ${f}: playing`);
    assert.deepEqual(wasm[f].ended, js[f].ended, `frame ${f}: the clips that ended, in order`);
  }
  return { calls, ended: js.reduce((s, x) => s + x.ended.length, 0) };
}

test('adobe_advance advances the clips as advanceAdobeAnimations does, the ended ones in order', async (t) => {
  const k = await setup({ seed: 0xadc });
  const a = AdobeAnimComponent;
  for (let i = 0; i < ROOTS; i++) {
    // Backwards now and then (a play-once clip then ends at 0), paused, inactive.
    if (i % 9 === 0) a.playbackRate[i] = -(0.5 + (i % 4));
    if (i % 13 === 0) a.playing[i] = 0;
    if (i % 31 === 0) a.active[i] = 0;
  }
  const { calls, ended } = compareAdvance(k, 40);
  assert.ok(calls.length > 0 && calls.every((c) => c !== EMIT_DECLINED), `the kernel took the frames (${calls.length})`);
  assert.ok(ended > 5, `clips ended (${ended})`);
  t.diagnostic(`${calls.length} frames through the kernel, ${ended} clips ended`);
});

test('adobe_advance declines a frame where a playing clock reads an asset the tables do not hold', async () => {
  const k = await setup({ seed: 0xadd, plain: true });
  const { calls } = compareAdvance(k, 6);
  assert.ok(calls.length > 0 && calls.every((c) => c === EMIT_DECLINED));
  // Paused, the plain asset's clocks are not read: the kernel takes the frame.
  for (let i = 0; i < ROOTS; i++) if (AdobeAnimComponent.assetId[i] === 4) AdobeAnimComponent.playing[i] = 0;
  const again = compareAdvance(k, 6);
  assert.ok(again.calls.length > 0 && again.calls.every((c) => c !== EMIT_DECLINED));
});
