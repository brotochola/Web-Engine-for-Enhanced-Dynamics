#!/usr/bin/env node
/**
 * Kernel: shipped PreRenderWorker.emitSpriteQueue on a real worker instance.
 * Collector order is cell order (not entity order), which is what pre-render
 * writes. persist is false so every call takes the type-0 column reads the
 * trace attributes to emitSpriteQueue, not the pose-only persist shortcut.
 *
 *   node tests/bench/preRenderWorkerMicrobench.mjs
 *   node tests/bench/preRenderWorkerMicrobench.mjs --variant base --output tests/results/kernels/preRenderWorker-smoke.json
 */
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { ShadowCaster } from '../../src/components/shadowCaster.js';
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { BulletComponent } from '../../src/components/bulletComponent.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { CAMERA_TYPES } from '../../src/util/configDefaults.js';
import { computeBufferSize, RENDER_QUEUE_CAMERA_BYTES } from '../../src/render/renderQueueLayout.js';
import { checksumInts, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { bindPoseColumns, coreComponentData, initWorker, loadWorker, quietly } from './workerHarness.mjs';
import { variantClass } from './methodVariant.mjs';

const WORLD_W = 10000;
const WORLD_H = 5000;
const CELL = 128;

const INVALID_TEXTURE_ID = 0xFFFF;

export const SCOPE = {
  Transform,
  SpriteRenderer,
  ShadowCaster,
  ParticleComponent,
  DecorationComponent,
  BulletComponent,
  LightEmitter,
  CAMERA_TYPES,
  INVALID_TEXTURE_ID,
};

const VARIANTS = {
  base: (Base) => Base,
  base2: (Base) => Base,
  // R3: walk the collector in entity-index order. Output row order changes.
  // Checksum is per entity, not per slot. Sort cost is inside the timed call.
  r3: (Base) => variantClass(Base, [{
    method: 'emitSpriteQueue',
    edits: [[
      'for (let i = 0; i < count && writeCount < maxItems; i++) {\n            const type = collectorType[i];\n            const idx = collectorIndex[i];\n            const yKey = collectorY[i];',
      `if (!this._r3Order || this._r3Order.length < count) this._r3Order = new Int32Array(count);
        for (let i = 0; i < count; i++) this._r3Order[i] = i;
        const r3Order = this._r3Order;
        r3Order.subarray(0, count).sort((a, b) => collectorIndex[a] - collectorIndex[b]);
        for (let k = 0; k < count && writeCount < maxItems; k++) {
            const i = r3Order[k];
            const type = collectorType[i];
            const idx = collectorIndex[i];
            const yKey = collectorY[i];`,
    ]],
  }], SCOPE),
  // H11: ShadowCaster columns resolved once on the existing emit ref.
  h11: (Base) => variantClass(Base, [
    {
      method: 'emitSpriteQueue',
      edits: [[
        'ref.shadowH = this.renderQueueShadowH;\n        ref.shadowOffX = this.renderQueueShadowOffX;\n        ref.shadowOffY = this.renderQueueShadowOffY;',
        `ref.shadowH = this.renderQueueShadowH;
        ref.shadowOffX = this.renderQueueShadowOffX;
        ref.shadowOffY = this.renderQueueShadowOffY;
        ref.scActive = ShadowCaster.active;
        ref.scH = ShadowCaster.heightMultiplier;
        ref.scOx = ShadowCaster.anchorOffsetX;
        ref.scOy = ShadowCaster.anchorOffsetY;`,
      ]],
    },
    {
      method: '_writeQueueShadow',
      edits: [[
        `const shadowH = (ref && ref.shadowH) || this.renderQueueShadowH;
        if (!shadowH) return;
        const i = entityIndex | 0;
        const cast = ShadowCaster.active && ShadowCaster.active[i];
        shadowH[out] = cast ? (ShadowCaster.heightMultiplier[i] || 0) : 0;
        const offX = (ref && ref.shadowOffX) || this.renderQueueShadowOffX;
        const offY = (ref && ref.shadowOffY) || this.renderQueueShadowOffY;
        if (offX) offX[out] = cast ? (ShadowCaster.anchorOffsetX[i] || 0) : 0;
        if (offY) offY[out] = cast ? (ShadowCaster.anchorOffsetY[i] || 0) : 0;`,
        `const shadowH = (ref && ref.shadowH) || this.renderQueueShadowH;
        if (!shadowH) return;
        const i = entityIndex | 0;
        const scActive = (ref && ref.scActive) || ShadowCaster.active;
        const scH = (ref && ref.scH) || ShadowCaster.heightMultiplier;
        const scOx = (ref && ref.scOx) || ShadowCaster.anchorOffsetX;
        const scOy = (ref && ref.scOy) || ShadowCaster.anchorOffsetY;
        const cast = scActive && scActive[i];
        shadowH[out] = cast ? (scH[i] || 0) : 0;
        const offX = (ref && ref.shadowOffX) || this.renderQueueShadowOffX;
        const offY = (ref && ref.shadowOffY) || this.renderQueueShadowOffY;
        if (offX) offX[out] = cast ? (scOx[i] || 0) : 0;
        if (offY) offY[out] = cast ? (scOy[i] || 0) : 0;`,
      ]],
    },
  ], SCOPE),
};

function renderQueuePayload(maxItems) {
  const bytes = computeBufferSize(maxItems);
  const camera = () => new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES);
  return {
    maxItems,
    sync: new SharedArrayBuffer(8),
    dataA: new SharedArrayBuffer(bytes),
    dataB: new SharedArrayBuffer(bytes),
    cameraA: camera(),
    cameraB: camera(),
    entityTextureData: new SharedArrayBuffer(maxItems * 2),
  };
}

export async function setupPreRenderKernel(opts = {}) {
  const n = opts.n ?? 13000;
  const seed = opts.seed ?? 0x5e1d;
  const variant = opts.variant || 'base';
  const make = opts.make || VARIANTS[variant];
  if (!make) throw new Error(`unknown variant ${variant}`);

  const buffers = { componentData: coreComponentData(n) };
  buffers.componentData.ShadowCaster = new SharedArrayBuffer(ShadowCaster.getBufferSize(n));
  const first = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const Ctor = make(first.constructor);
  const worker = Ctor === first.constructor ? first : await quietly(() => new Ctor(globalThis.self));

  await initWorker(worker, {
    config: {
      worldWidth: WORLD_W,
      worldHeight: WORLD_H,
      canvasWidth: 1280,
      canvasHeight: 720,
      preRender: { interpolation: false, skipCull: false },
      renderer: { ySort: false },
      debug: { collectDetailedStats: false },
    },
    globalEntityCount: n,
    buffers,
    extra: { renderQueue: renderQueuePayload(n) },
  });

  bindPoseColumns(n);
  const rng = mulberry32(seed);
  const collectorIndex = worker._renderableIndex;
  const collectorY = worker._renderableY;
  const collectorType = worker._renderableType;
  const stashX = worker._renderablePx;
  const stashY = worker._renderablePy;
  const stashRc = worker._renderableRotC;
  const stashRs = worker._renderableRotS;
  const slots = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const x = 8 + rng() * (WORLD_W - 16);
    const y = 8 + rng() * (WORLD_H - 16);
    Transform.x[i] = x;
    Transform.y[i] = y;
    Transform.rotC[i] = 1;
    Transform.rotS[i] = 0;
    SpriteRenderer.active[i] = 1;
    SpriteRenderer.scaleX[i] = 0.5 + rng();
    SpriteRenderer.scaleY[i] = 0.5 + rng();
    SpriteRenderer.alpha[i] = 0.4 + rng() * 0.6;
    SpriteRenderer.tint[i] = (rng() * 0xffffff) >>> 0;
    SpriteRenderer.anchorX[i] = rng();
    SpriteRenderer.anchorY[i] = rng();
    SpriteRenderer.inheritTransformRotation[i] = 1;
    SpriteRenderer.spritesheetId[i] = 0;
    SpriteRenderer.isAnimated[i] = 0;
    SpriteRenderer.repeatX[i] = 0;
    SpriteRenderer.repeatY[i] = 0;
    ShadowCaster.active[i] = 1;
    ShadowCaster.heightMultiplier[i] = 0.5 + rng();
    ShadowCaster.anchorOffsetX[i] = rng();
    ShadowCaster.anchorOffsetY[i] = rng();
    slots[i] = i;
  }
  // Cell order, the access pattern emit sees after collect.
  slots.sort((a, b) => {
    const row = ((Transform.y[a] / CELL) | 0) - ((Transform.y[b] / CELL) | 0);
    if (row) return row;
    const col = ((Transform.x[a] / CELL) | 0) - ((Transform.x[b] / CELL) | 0);
    if (col) return col;
    return a - b;
  });
  for (let i = 0; i < n; i++) {
    const id = slots[i];
    collectorIndex[i] = id;
    collectorType[i] = 0;
    collectorY[i] = Transform.y[id];
    stashX[i] = Transform.x[id];
    stashY[i] = Transform.y[id];
    stashRc[i] = 1;
    stashRs[i] = 0;
  }

  const source = worker._fillEmitSource(
    n, n, collectorY, collectorType, collectorIndex,
    stashX, stashY, stashRc, stashRs,
    false, false, false,
  );

  function frame() {
    worker.emitSpriteQueue(16.67, source);
  }

  const bits = new Uint32Array(1);
  const bitsF = new Float32Array(bits.buffer);
  function mix(h, v) {
    bitsF[0] = v;
    return Math.imul(h ^ bits[0], 16777619) >>> 0;
  }

  function checksum() {
    frame();
    const written = worker.renderQueueCount ? worker.renderQueueCount[0] : n;
    const acc = new Uint32Array(n);
    const rqX = worker.renderQueueX;
    const rqY = worker.renderQueueY;
    const rqSX = worker.renderQueueScaleX;
    const rqA = worker.renderQueueAlpha;
    const rqAX = worker.renderQueueAnchorX;
    const rqAY = worker.renderQueueAnchorY;
    const rqH = worker.renderQueueShadowH;
    const rqOY = worker.renderQueueShadowOffY;
    for (let s = 0; s < written; s++) {
      const id = collectorIndex[s];
      let h = 2166136261;
      h = mix(h, rqX[s]);
      h = mix(h, rqY[s]);
      h = mix(h, rqSX[s]);
      h = mix(h, rqA[s]);
      h = mix(h, rqAX[s]);
      h = mix(h, rqAY[s]);
      h = mix(h, rqH[s]);
      h = mix(h, rqOY[s]);
      acc[id] = h;
    }
    return checksumInts(acc, n);
  }

  return { n, worker, frame, checksum, seed };
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  const n = Number(args.n ?? 13000);
  const seed = Number(args.seed ?? 0x5e1d);
  const k = await setupPreRenderKernel({ n, seed, variant });
  const checksum = k.checksum();
  assert.equal(k.worker.renderQueueX.length >= n, true);
  const cases = {
    emit: timeIt(`preRender emitSpriteQueue ${variant} (n=${n})`, () => k.frame(), { iterations: 24, warmup: 8 }),
  };
  const report = {
    feature: 'preRender-worker-emit',
    variant,
    functions: ['PreRenderWorker.emitSpriteQueue', 'PreRenderWorker._writeQueueShadow'],
    n,
    seed,
    checksum,
    note: 'Real PreRenderWorker. Collector is cell order. Checksum is per entity id, so an emit reorder can match.',
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum} emit ${cases.emit.opsPerSec.toFixed(1)} ops/s`);
}

if (isCli(import.meta.url)) await main();
