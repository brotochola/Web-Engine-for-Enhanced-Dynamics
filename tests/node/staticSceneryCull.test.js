import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { bindCollect, collectMemory } from '../bench/preRenderCollectKernel.mjs';
import { collectVisibleEntitiesJs } from '../reference/preRenderCollectJs.mjs';
import { Query } from '../../src/core/query.js';
import { Layer } from '../../src/core/layer.js';
import { Transform } from '../../src/components/transform.js';
import {
  bindStaticSceneryGen,
  bindStaticTypes,
  staticSceneryChanged,
  staticSceneryChangedAt,
  staticSceneryGen,
} from '../../src/core/staticScenery.js';

// E-127. Static scenery culled through pre-render's grid (staticSceneryGrid.js) must leave the collectors exactly as
// the linear cull leaves them: the same sprites, in the same order, with the same rows, through the JS collect and
// the kernel, at every zoom and rotation. The grid only chooses which static entities the collect tests.

const N = 3000;
// Two moving types and two static ones; the ranges do not start or end on a 32-entity word.
const CLASSES = [
  { entityType: 0, startIndex: 0, endIndex: 1200, isStatic: false },
  { entityType: 1, startIndex: 1200, endIndex: 2000, isStatic: true },
  { entityType: 2, startIndex: 2000, endIndex: 2013, isStatic: false },
  { entityType: 3, startIndex: 2013, endIndex: 3000, isStatic: true },
];
const WORLD = { worldWidth: 4000, worldHeight: 2600 };

function fill(m, seed) {
  const rng = mulberry32(seed);
  const v = m.views;
  for (let i = 0; i < N; i++) {
    v.tActive[i] = rng() < 0.92 ? 1 : 0;
    // Some outside the world on every side: the grid keeps them in its edge cells.
    v.x[i] = (rng() - 0.15) * WORLD.worldWidth * 1.3;
    v.y[i] = (rng() - 0.15) * WORLD.worldHeight * 1.3;
    v.rotC[i] = Math.cos(rng() * 6.3);
    v.rotS[i] = Math.sin(rng() * 6.3);
    v.sActive[i] = rng() < 0.95 ? 1 : 0;
    v.sVisible[i] = rng() < 0.95 ? 1 : 0;
    // A few large ones, a few with no bounds (their visual range is the extent), most small.
    const big = rng() < 0.02;
    v.halfW[i] = rng() < 0.05 ? 0 : big ? 300 + rng() * 300 : rng() * 40;
    v.halfH[i] = rng() < 0.05 ? 0 : big ? 200 : rng() * 40;
    v.sheet[i] = rng() < 0.03 ? 0 : 1 + ((rng() * 3) | 0);
    if (v.visualRange) v.visualRange[i] = rng() < 0.5 ? 0 : rng() * 150;
    v.anchorX[i] = 0.5;
    v.anchorY[i] = 0.5;
    v.scaleX[i] = 1;
    v.scaleY[i] = 1;
    if (v.mask) v.mask[i] = 0;
    v.rb[i] = 0;
  }
  // The collect's memory has no entity types; the counter's per-entity check reads them.
  Transform.entityType = new Uint8Array(N);
  for (const c of CLASSES) for (let i = c.startIndex; i < c.endIndex; i++) Transform.entityType[i] = c.entityType;
}

function camera(pre, { x, y, zoom, rot }) {
  pre.cameraData = {};
  pre._querySpriteRenderer = null;
  pre.canvasWidth = 1280;
  pre.canvasHeight = 720;
  pre.cullingRatio = 0.05;
  pre.skipCull = false;
  pre._frameCameraZoom = zoom;
  pre._frameCameraX = x;
  pre._frameCameraY = y;
  pre._frameCameraRot = rot;
  pre.renderQueueEnabled = true;
  pre._entitySortY = false;
  pre._collectEntityGlow = () => {};
  pre._poseX = null;
  pre._rbActive = null;
  pre.config = { ...WORLD };
}

function reset(pre, m) {
  m.views.oY.fill(0);
  m.views.oType.fill(0);
  m.views.oIndex.fill(0);
  for (const a of [m.views.oX, m.views.oPy, m.views.oRc, m.views.oRs]) a.fill(0);
  pre._renderableCount = 0;
  pre.visibleEntitiesCount = 0;
  pre._renderQueueOverflowWarned = false;
  pre._customLayerCollectors = {};
}

function snapshot(pre, m) {
  const n = pre._renderableCount;
  const bits = (a) => Array.from(new Uint32Array(a.buffer, a.byteOffset, n));
  const v = m.views;
  return {
    n,
    visible: pre.visibleEntitiesCount,
    index: Array.from(v.oIndex.subarray(0, n)),
    y: bits(v.oY), x: bits(v.oX), py: bits(v.oPy), rc: bits(v.oRc), rs: bits(v.oRs),
  };
}

const CAMERAS = [
  { name: 'the middle, zoom 1', x: 1800, y: 1200, zoom: 1, rot: 0 },
  { name: 'zoomed out', x: 2000, y: 1300, zoom: 0.3, rot: 0 },
  { name: 'zoomed in', x: 700, y: 400, zoom: 2.5, rot: 0 },
  { name: 'turned', x: 1500, y: 900, zoom: 0.8, rot: 0.6 },
  { name: 'turned the other way, zoomed out', x: 2600, y: 1700, zoom: 0.45, rot: 2.2 },
  { name: 'past the world\'s corner', x: -900, y: -700, zoom: 1, rot: 0 },
  { name: 'far from everything', x: 90000, y: 90000, zoom: 1, rot: 0 },
];

function publishedList(v) {
  // The published sprite query: every active entity, ascending.
  const ids = [];
  for (let i = 0; i < N; i++) if (v.tActive[i]) ids.push(i);
  return Uint16Array.from(ids);
}

test('static scenery through the grid leaves the collectors as the linear cull does', async () => {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const realQuery = Query.queryActiveEntities;
  const warn = console.warn;
  console.warn = () => {};
  const genSab = new SharedArrayBuffer(4);
  try {
    const m = collectMemory(pre, N, N);
    fill(m, 2026);
    const ids = publishedList(m.views);
    Query.queryActiveEntities = () => ids;
    const kernel = await bindCollect(m);
    // The shipped collect on the kernel, or the JS one it replaced.
    const collect = (wasm) => {
      if (!wasm) return collectVisibleEntitiesJs(pre);
      pre._collectWasm = kernel;
      pre.collectVisibleEntities();
      pre._collectWasm = null;
    };
    bindStaticSceneryGen(genSab);
    bindStaticTypes(CLASSES);
    staticSceneryChanged();

    // The length of the walk the grid gave the collect, -1 when the collect walked the published list.
    let walked = -1;
    const run = (cam, grid, wasm) => {
      camera(pre, cam);
      pre._staticGrid.bindTypes(grid ? CLASSES : [], N);
      const walk = pre._staticGrid.walk;
      walked = -1;
      pre._staticGrid.walk = function spy(...a) {
        walked = walk.apply(this, a);
        return walked;
      };
      reset(pre, m);
      collect(wasm);
      return snapshot(pre, m);
    };

    let shown = 0;
    for (const cam of CAMERAS) {
      for (const wasm of [false, true]) {
        const linear = run(cam, false, wasm);
        assert.equal(walked, -1, 'no static type: the published list');
        const grid = run(cam, true, wasm);
        assert.ok(walked >= 0, `${cam.name}: the collect walked the grid's list`);
        // The view box is widened by the largest static half extent (600 here), so the share it keeps is larger
        // than the view's; still some static entities are left out wherever the view is.
        if (cam.zoom >= 1) assert.ok(walked < ids.length, `${cam.name}: static entities left out (${walked} of ${ids.length})`);
        assert.deepEqual(grid, linear, `${cam.name} (${wasm ? 'kernel' : 'JS'})`);
        shown += linear.n;
      }
    }
    assert.ok(shown > 500, `the cameras show sprites (${shown})`);

    // A static entity moved through the setters' counter is binned again where it went.
    const s = 1500;
    m.views.tActive[s] = 1;
    m.views.sActive[s] = 1;
    m.views.sVisible[s] = 1;
    m.views.sheet[s] = 1;
    m.views.halfW[s] = 10;
    m.views.halfH[s] = 10;
    const cam = CAMERAS[0];
    m.views.x[s] = 90000;
    m.views.y[s] = 90000;
    staticSceneryChangedAt(s);
    run(cam, true, false);
    m.views.x[s] = cam.x;
    m.views.y[s] = cam.y;
    staticSceneryChangedAt(s);
    const ids2 = publishedList(m.views);
    Query.queryActiveEntities = () => ids2;
    for (const wasm of [false, true]) {
      const linear = run(cam, false, wasm);
      // bindTypes forgets the cells: bin them, then move the entity and bump, as the setter would.
      pre._staticGrid.bindTypes(CLASSES, N);
      camera(pre, cam);
      m.views.x[s] = 90000;
      staticSceneryChangedAt(s);
      reset(pre, m);
      collect(false);
      m.views.x[s] = cam.x;
      staticSceneryChangedAt(s);
      reset(pre, m);
      collect(wasm);
      const moved = snapshot(pre, m);
      assert.ok(linear.index.includes(s), 'the moved entity is in view');
      assert.deepEqual(moved, linear, `a moved static entity (${wasm ? 'kernel' : 'JS'})`);
    }
  } finally {
    Query.queryActiveEntities = realQuery;
    console.warn = warn;
    bindStaticSceneryGen(null);
    bindStaticTypes(null);
    Layer.reset();
  }
});

test('the static counter moves for static entities only', () => {
  const sab = new SharedArrayBuffer(4);
  bindStaticSceneryGen(sab);
  bindStaticTypes([{ entityType: 0, isStatic: false }, { entityType: 1, class: { isStatic: true } }]);
  Transform.entityType = new Uint8Array([0, 1, 1, 0]);
  try {
    const g0 = staticSceneryGen();
    staticSceneryChangedAt(0);
    staticSceneryChangedAt(3);
    assert.equal(staticSceneryGen(), g0, 'moving types do not move it');
    staticSceneryChangedAt(1);
    staticSceneryChangedAt(2);
    assert.equal(staticSceneryGen(), g0 + 2, 'static ones do');
    bindStaticTypes([{ entityType: 0 }, { entityType: 1 }]);
    staticSceneryChangedAt(1);
    assert.equal(staticSceneryGen(), g0 + 2, 'a scene with no static type never moves it');
  } finally {
    bindStaticSceneryGen(null);
    bindStaticTypes(null);
  }
});
