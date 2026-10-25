#!/usr/bin/env node
/**
 * Kernel (E-76 W4d): pre-render's bullet and trail rows (types 4 and 5) written by the emit kernel against the JS
 * that writes them when emit_rows lists them (PreRenderWorker._emitForeignRows), through the shipped
 * emitSpriteQueue on a real worker, BulletComponent in the render-queue memory where the scene puts it (W19).
 *
 *   foreign  the bullet columns left out of the kernel's table: emit_rows lists the bullet and trail rows and
 *            _emitForeignRows writes them (the path before W4d)
 *   wasm     the bullet columns in the table (writeEmitBulletColumns): emit_rows writes them
 *
 * Cases (--case): bullets, bulletStressScene's frame (32 700 bullets on screen, no trails, 195 sprites among
 * them; 2026-10-25 profile), and trails (16 350 bullets with their trails: the same rows). One variant per
 * process, through runKernelVariants.mjs, which rejects a variant whose checksum differs: the queue's bytes after
 * one frame. --check prints the checksum only.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/preRenderEmitBulletMicrobench.mjs --variants foreign,wasm --rounds 5
 *   node tests/bench/preRenderEmitBulletMicrobench.mjs --variant wasm [--case bullets|trails] [--check] [--output path]
 */
import { BulletComponent } from '../../src/components/bulletComponent.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { ShadowCaster } from '../../src/components/shadowCaster.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { computeGpuQueueBufferSize, gpuQueueCaps } from '../../src/render/gpuQueueLayout.js';
import { computeBufferSize, RENDER_QUEUE_CAMERA_BYTES } from '../../src/render/renderQueueLayout.js';
import { createRenderQueueMemory } from '../../src/util/renderQueueMemory.js';
import { EMIT_SLOTS, writeEmitBulletColumns } from '../../src/workers/preRenderEmitClient.js';
import { isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { bindPoseColumns, coreComponentData, initWorker, loadWorker } from './workerHarness.mjs';
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';

const DT = 1000 / 60;
const N = 200;
const SPRITES = 195;
const POOL = 40000;
const MAX_ITEMS = 42000;
const ROWS = 32700 + SPRITES;

/** One sheet with a one-frame animation, the bullet's, and the builtins the emit looks up. */
function textureMetadata() {
  const animationFrameStart = [0, 1];
  const animationFrameCount = [1, 1];
  const animationNameToIndex = {};
  for (const name of ['_lightGradient', '_whiteCircle', '_bulletTrail']) {
    animationNameToIndex[name] = animationFrameStart.length;
    animationFrameStart.push(animationFrameStart.length);
    animationFrameCount.push(1);
  }
  const frames = animationFrameStart.length;
  return {
    animationFrameStart,
    animationFrameCount,
    proxyToGlobalAnim: { 1: { 0: 0 } },
    animationNameToIndex,
    totalFrames: frames,
    frameWidth: new Uint16Array(frames).fill(32),
    frameHeight: new Uint16Array(frames).fill(32),
  };
}

/** A pre-render worker on a render-queue memory holding BulletComponent, with one frame's collector. */
export async function setupBulletEmit({ trails = false, seed = 0xb011e7 } = {}) {
  const caps = gpuQueueCaps(MAX_ITEMS, { enabled: false });
  const collect = {
    entities: N,
    transformBytes: Transform.getBufferSize(N),
    colliderBytes: 0,
    rigidBodyBytes: 0,
    bullets: { bullets: POOL, entities: N, componentBytes: BulletComponent.getBufferSize(POOL), impacts: 256 },
    visibility: null,
  };
  const m = createRenderQueueMemory(MAX_ITEMS, computeBufferSize(MAX_ITEMS), computeGpuQueueBufferSize(caps), {
    entities: N,
    spriteBytes: SpriteRenderer.getBufferSize(N),
    casterBytes: ShadowCaster.getBufferSize(N),
    decorationBytes: DecorationComponent.getBufferSize(1),
  }, null, null, false, collect);
  const e = m.layout.emit;
  const buffers = {
    componentData: {
      ...coreComponentData(N),
      SpriteRenderer: m.buffer,
      ShadowCaster: m.buffer,
      DecorationComponent: m.buffer,
      BulletComponent: m.buffer,
    },
    componentDataByte: {
      SpriteRenderer: e.spriteRendererByte,
      ShadowCaster: e.shadowCasterByte,
      DecorationComponent: e.decorationByte,
      BulletComponent: m.layout.collect.bullets.componentByte,
    },
  };
  const worker = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  await initWorker(worker, {
    config: { worldWidth: 4000, worldHeight: 3000, preRender: { interpolation: false }, renderer: { ySort: true } },
    globalEntityCount: N,
    buffers,
    extra: {
      maxDecorations: 1,
      maxParticles: 1,
      maxBullets: POOL,
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
  if (BulletComponent.x.buffer !== m.buffer) throw new Error('BulletComponent is not in the memory');
  if (!worker._emitWasm) throw new Error('the worker did not bind the emit kernel');

  const rng = mulberry32(seed);
  const sr = SpriteRenderer;
  for (let i = 0; i < N; i++) {
    sr.active[i] = 1;
    sr.scaleX[i] = 1;
    sr.scaleY[i] = 1;
    sr.alpha[i] = 1;
    sr.tint[i] = 0xffffff;
    sr.anchorX[i] = 0.5;
    sr.anchorY[i] = 0.5;
    sr.spriteRotC[i] = 1;
    sr.inheritTransformRotation[i] = 1;
    sr.spritesheetId[i] = 1;
  }
  // The driver's bullets: straight, one texture, no muzzle offset; with trails, each one 2 wide behind it.
  const bc = BulletComponent;
  const bullets = trails ? (ROWS - SPRITES) >> 1 : ROWS - SPRITES;
  for (let s = 0; s < bullets; s++) {
    const a = rng() * Math.PI * 2;
    bc.active[s] = 1;
    bc.x[s] = rng() * 4000;
    bc.y[s] = rng() * 3000;
    bc.startX[s] = bc.x[s] - Math.cos(a) * 200 * rng();
    bc.startY[s] = bc.y[s] - Math.sin(a) * 200 * rng();
    bc.bulletRotC[s] = Math.cos(a);
    bc.bulletRotS[s] = Math.sin(a);
    bc.trailWidth[s] = trails ? 2 : 0;
    bc.textureId[s] = 1;
    bc.scale[s] = 1;
    bc.alpha[s] = 1;
    bc.tint[s] = 0xffffff;
    bc.anchorX[s] = 0.5;
    bc.anchorY[s] = 0.5;
  }
  // The collector: the sprites spread among the bullets (each with its trail row after it), poses in the queue
  // columns (E-98d).
  const spacing = Math.floor(bullets / SPRITES);
  let row = 0;
  let sprite = 0;
  for (let s = 0; s < bullets; s++) {
    if (s % spacing === 0 && sprite < SPRITES) {
      worker._renderableType[row] = 0;
      worker._renderableIndex[row] = sprite++;
      row++;
    }
    worker._renderableType[row] = 4;
    worker._renderableIndex[row] = s;
    row++;
    if (trails) {
      worker._renderableType[row] = 5;
      worker._renderableIndex[row] = s;
      row++;
    }
  }
  while (sprite < SPRITES) {
    worker._renderableType[row] = 0;
    worker._renderableIndex[row++] = sprite++;
  }
  const q = { x: worker.renderQueueX, y: worker.renderQueueY, rc: worker.renderQueueRotC, rs: worker.renderQueueRotS };
  for (let r = 0; r < row; r++) {
    worker._renderableY[r] = Math.round(rng() * 3000) * 128;
    q.x[r] = rng() * 4000;
    q.y[r] = rng() * 3000;
    q.rc[r] = 1;
    q.rs[r] = 0;
  }
  const source = worker._fillEmitSource(row, MAX_ITEMS, worker._renderableY, worker._renderableType, worker._renderableIndex,
    q.x, q.y, q.rc, q.rs, false, true, true);
  const queueWords = new Uint32Array(m.buffer, m.layout.queueAByte, computeBufferSize(MAX_ITEMS) >> 2);
  const hash = () => {
    let h = 2166136261;
    for (let k = 0; k < queueWords.length; k++) h = Math.imul(h ^ queueWords[k], 16777619) >>> 0;
    return h >>> 0;
  };
  return { worker, b: worker._emitWasm, source, rows: row, hash };
}

/** Put the variant on the worker's table: the bullet columns in it (wasm) or left out (foreign). */
export function useVariant(s, variant) {
  const { worker, b } = s;
  const write = worker._writeEmitTable.bind(worker);
  const bActive = EMIT_SLOTS.indexOf('bActive');
  const trail = worker._resolveBuiltinTextureId('_bulletTrail');
  worker._writeEmitTable = variant === 'wasm'
    ? (source, trailTexture) => write(source, trailTexture) && writeEmitBulletColumns(b, BulletComponent, trail)
    : (source, trailTexture) => {
        const ok = write(source, trailTexture);
        b.table[bActive] = 0;
        return ok;
      };
}

async function main() {
  const args = parseArgs();
  // The shipped path by default (W4d wires it); foreign is the path before it.
  const variant = String(args.variant || 'wasm');
  const caseName = String(args.case || 'bullets');
  if (!['foreign', 'wasm'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  if (!['bullets', 'trails'].includes(caseName)) throw new Error(`unknown case ${caseName}`);
  const s = await setupBulletEmit({ trails: caseName === 'trails' });
  useVariant(s, variant);
  const { worker, b, source } = s;
  const run = () => worker.emitSpriteQueue(DT, source);
  const written = run();
  if (written !== s.rows) throw new Error(`wrote ${written} of ${s.rows} rows`);
  // The variant took the path it names: rows listed for the JS, or none.
  const listed = b.results[3];
  if ((variant === 'foreign') !== (listed > 0)) throw new Error(`${variant}: emit_rows listed ${listed} rows for the JS`);
  const checksum = s.hash();
  if (args.check) {
    console.log(`checksum ${checksum} variant ${variant} case ${caseName} rows ${written} listed ${listed}`);
    return;
  }
  // Normal compiles, not OSR: short frames over the first rows (bullets and two sprites).
  const rows = source.count;
  source.count = 256;
  const tier = await warmWasm(b.emitRows, run);
  source.count = rows;
  const cases = {
    emit: timeIt(`emit ${variant} ${caseName} (${rows} rows)`, run, { iterations: 20, warmup: 5 }),
  };
  const report = {
    feature: 'pre-render-emit-bullets-wasm',
    variant,
    case: caseName,
    functions: ['PreRenderWorker.emitSpriteQueue', 'PreRenderWorker._emitForeignRows', 'preRenderEmit.emit_rows'],
    rows,
    listed,
    checksum,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum} tier ${tier} ${caseName} ${cases.emit.opsPerSec.toFixed(1)} ops/s`);
}

if (isCli(import.meta.url)) await main();
