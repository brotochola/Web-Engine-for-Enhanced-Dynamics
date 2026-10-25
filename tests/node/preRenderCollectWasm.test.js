import test from 'node:test';
import assert from 'node:assert/strict';

import { customLayerCollector, loadWorker } from '../bench/workerHarness.mjs';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { bindCollect, collectMemory, useBodies, useSortY } from '../bench/preRenderCollectKernel.mjs';
import { Query } from '../../src/core/query.js';
import { Layer } from '../../src/core/layer.js';

// E-76 W4b, the sprite collect kernel (wasm/preRenderCollect.c). On the same bytes, the worker's collect through
// the kernel must leave the main collector, a custom layer's collector, the visible count and the overflow warning
// exactly as the shipped collectVisibleEntities leaves them: every sprite with no layer mask written by the
// kernel (with a body, its published pose; with Y-sort, its foot line), every masked one, and every one whose
// sort line needs a frame not resolved yet, through collectRenderable at its place in the walk.

const N = 3000;

function fill(m, seed, { masked }) {
  const rng = mulberry32(seed);
  const v = m.views;
  const odd = () => [0, -0, NaN][(rng() * 3) | 0];
  for (let i = 0; i < N; i++) {
    v.tActive[i] = rng() < 0.92 ? 1 : 0;
    v.x[i] = (rng() - 0.3) * 4000;
    v.y[i] = (rng() - 0.3) * 2600;
    v.rotC[i] = rng() < 0.05 ? odd() : Math.cos(rng() * 6.3);
    v.rotS[i] = rng() < 0.05 ? odd() : Math.sin(rng() * 6.3);
    v.sActive[i] = rng() < 0.95 ? 1 : 0;
    v.sVisible[i] = rng() < 0.95 ? 1 : 0;
    v.halfW[i] = rng() < 0.1 ? odd() : rng() * 60;
    v.halfH[i] = rng() < 0.1 ? odd() : rng() * 60;
    v.sheet[i] = rng() < 0.03 ? 0 : 1 + ((rng() * 3) | 0);
    if (v.visualRange) v.visualRange[i] = rng() < 0.3 ? odd() : rng() * 200;
    v.anchorX[i] = 0.5;
    v.anchorY[i] = 1;
    if (v.mask) v.mask[i] = 0;
  }
  // The bodies' two generations: unit rotations, a few never published (zeros), some unturned between them.
  const unit = (a) => [Math.cos(a), Math.sin(a)];
  for (let i = 0; i < N; i++) {
    v.rb[i] = rng() < 0.6 ? 1 : 0;
    const dead = rng() < 0.05;
    const [c, s] = unit(rng() * 6.3);
    v.px[i] = v.x[i] + (rng() - 0.5) * 8;
    v.py[i] = v.y[i] + (rng() - 0.5) * 8;
    v.pc[i] = dead ? 0 : c;
    v.ps[i] = dead ? 0 : s;
    const still = rng() < 0.3;
    const [c0, s0] = still ? [c, s] : unit(rng() * 6.3);
    const unborn = rng() < 0.05;
    v.qx[i] = v.px[i] + (rng() - 0.5) * 6;
    v.qy[i] = v.py[i] + (rng() - 0.5) * 6;
    v.qc[i] = unborn ? 0 : c0;
    v.qs[i] = unborn ? 0 : s0;
  }
  // The sort line: feet-anchored sprites and others, flipped ones, own facings, unresolved and unknown frames.
  const anchors = [[0.5, 1], [0.5, 0.5], [0.5, 0.98], [1, 0.5], [0, 0.66]];
  const frames = v.frameW.length;
  for (let f = 0; f < frames; f++) {
    v.frameW[f] = 1 + ((rng() * 200) | 0);
    v.frameH[f] = 1 + ((rng() * 200) | 0);
  }
  for (let i = 0; i < N; i++) {
    const [ax, ay] = anchors[(rng() * anchors.length) | 0];
    v.anchorX[i] = ax;
    v.anchorY[i] = ay;
    v.scaleX[i] = 0.3 + rng() * 2;
    v.scaleY[i] = (rng() < 0.2 ? -1 : 1) * (0.3 + rng() * 2);
    v.inherit[i] = rng() < 0.5 ? 1 : 0;
    const [fc, fs] = unit(rng() * 6.3);
    v.faceC[i] = fc;
    v.faceS[i] = fs;
    v.lastTexture[i] = rng() < 0.05 ? 0xFFFF : (rng() * (frames + 4)) | 0;
  }
  if (masked && v.mask) {
    for (let i = 0; i < N; i++) {
      if (rng() < 0.04) v.mask[i] = 1 << masked.fx;
      else if (rng() < 0.02) v.mask[i] = (1 << masked.fx) | Layer.entitiesMask();
    }
  }
}

function camera(pre, { skipCull, rot }) {
  pre.cameraData = {};
  pre._querySpriteRenderer = null;
  pre.canvasWidth = 1280;
  pre.canvasHeight = 720;
  pre.cullingRatio = 0.05;
  pre.skipCull = skipCull;
  pre._frameCameraZoom = 0.8;
  pre._frameCameraX = 600;
  pre._frameCameraY = 420;
  pre._frameCameraRot = rot;
  pre.renderQueueEnabled = true;
  pre._entitySortY = false;
  pre._collectEntityGlow = () => {};
  pre._poseX = null;
  pre._rbActive = null;
}

function reset(pre, m, fx) {
  m.views.oY.fill(0);
  m.views.oType.fill(0);
  m.views.oIndex.fill(0);
  for (const a of [m.views.oX, m.views.oPy, m.views.oRc, m.views.oRs]) a.fill(0);
  pre._renderableCount = 0;
  pre.visibleEntitiesCount = 0;
  pre._renderQueueOverflowWarned = false;
  pre._customLayerCollectors = {
    [fx]: customLayerCollector(N),
  };
}

function snapshot(pre, m, fx) {
  const n = pre._renderableCount;
  const bits = (a) => Array.from(new Uint32Array(a.buffer, a.byteOffset, n));
  const v = m.views;
  const c = pre._customLayerCollectors[fx];
  return {
    n,
    visible: pre.visibleEntitiesCount,
    warned: pre._renderQueueOverflowWarned,
    type: Array.from(v.oType.subarray(0, n)),
    index: Array.from(v.oIndex.subarray(0, n)),
    y: bits(v.oY), x: bits(v.oX), py: bits(v.oPy), rc: bits(v.oRc), rs: bits(v.oRs),
    fx: { count: c.count, index: Array.from(c.index.subarray(0, c.count)), y: Array.from(c.y.subarray(0, c.count)) },
  };
}

const CASES = [
  { name: 'cull, a straight camera', skipCull: false, rot: 0 },
  { name: 'skipCull (BunnyMark)', skipCull: true, rot: 0 },
  { name: 'a turned camera', skipCull: false, rot: 0.6 },
  { name: 'masked sprites through collectRenderable', skipCull: false, rot: 0, masked: true },
  { name: 'a full collector', skipCull: true, rot: 0, maxItems: 1000 },
  { name: 'the sprite query\'s list', skipCull: false, rot: 0.3, masked: true, list: true },
  { name: 'no layer mask and no visual range columns', skipCull: false, rot: 0, bare: true },
  { name: 'bodies, the latched pose', skipCull: false, rot: 0, bodies: {} },
  { name: 'bodies, interpolated', skipCull: false, rot: 0, bodies: { interpolate: true, alpha: 0.37 } },
  { name: 'bodies, the first publish', skipCull: false, rot: 0, bodies: { interpolate: true, alpha: 0.6, prev: false } },
  { name: 'Y-sort, with frames handed back', skipCull: false, rot: 0, sortY: true },
  { name: 'Y-sort and bodies, a turned camera', skipCull: false, rot: 0.6, sortY: true, bodies: { interpolate: true, alpha: 0.81 } },
  { name: 'Y-sort and bodies, the list, masked', skipCull: false, rot: 0, masked: true, list: true, sortY: true, bodies: {} },
  { name: 'Y-sort, a full collector', skipCull: true, rot: 0, maxItems: 1000, sortY: true },
  { name: 'Y-sort on halves and negative zeros (Math.round)', skipCull: true, rot: 0, sortY: true, halves: true },
];

// Feet-anchored sprites whose sort line is the pose itself, on the values Math.round treats apart.
const HALVES = [-0.5, -1.5, -2.5, -0.25, -0, 0, 0.5, 1.5, 2.5, -0.75, 8388607.5, -8388607.5, 1e-30, -1e-30];

function halves(m) {
  const v = m.views;
  for (let i = 0; i < N; i++) {
    if (i % 3) continue;
    v.y[i] = HALVES[(i / 3) % HALVES.length];
    v.anchorX[i] = 0.5;
    v.anchorY[i] = 1;
    v.rb[i] = 0;
  }
}

for (const c of CASES) {
  test(`the collect kernel leaves the collectors as the JS does: ${c.name}`, async () => {
    Layer.reset();
    Layer.initializeFromConfig({ fx: {} }, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
    const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
    const realQuery = Query.queryActiveEntities;
    try {
      const m = collectMemory(pre, N, c.maxItems ?? N, c.bare ? { mask: false, visualRange: false } : {});
      const fx = Layer.get('fx').id;
      fill(m, 1234 + CASES.indexOf(c), { masked: c.masked ? { fx } : null });
      camera(pre, c);
      if (c.bodies) useBodies(pre, m, c.bodies);
      if (c.sortY) useSortY(pre, m, (i) => (i * 7) % m.views.frameW.length);
      if (c.halves) halves(m);
      if (c.list) {
        const rng = mulberry32(99);
        const ids = Uint16Array.from({ length: N }, (_, i) => i).filter(() => rng() < 0.7).sort(() => rng() - 0.5);
        Query.queryActiveEntities = () => ids;
      }
      const kernel = await bindCollect(m);
      let calls = 0;
      const wrap = (fn) => (...a) => { calls++; return fn(...a); };
      kernel.collectSprites = wrap(kernel.collectSprites);
      kernel.collectSpritesTurned = wrap(kernel.collectSpritesTurned);

      reset(pre, m, fx);
      const warn = console.warn;
      console.warn = () => {};
      pre._collectWasm = null;
      pre.collectVisibleEntities();
      const js = snapshot(pre, m, fx);

      reset(pre, m, fx);
      pre._collectWasm = kernel;
      pre.collectVisibleEntities();
      pre._collectWasm = null;
      console.warn = warn;
      const wasm = snapshot(pre, m, fx);

      assert.ok(calls > 0, 'the collect took the kernel');
      if (c.sortY && !c.maxItems) assert.ok(calls > 3, `unresolved frames went back to the JS (${calls} calls)`);
      assert.ok(js.n > 100, `the case queues sprites (${js.n})`);
      if (c.masked) assert.ok(js.fx.count > 10, 'masked sprites reached the fx collector');
      if (c.maxItems) assert.equal(js.warned, true, 'the collector filled');
      assert.deepEqual(wasm, js);
    } finally {
      Query.queryActiveEntities = realQuery;
      Layer.reset();
    }
  });
}
