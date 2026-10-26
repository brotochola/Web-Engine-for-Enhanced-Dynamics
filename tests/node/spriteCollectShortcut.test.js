import test from 'node:test';
import assert from 'node:assert/strict';

import { customLayerCollector, loadWorker } from '../bench/workerHarness.mjs';
import { bindCollect, collectMemory, useBodies, useSortY } from '../bench/preRenderCollectKernel.mjs';
import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Layer } from '../../src/core/layer.js';

// E-98c, E-98e and E-98f, and W4b. The sprite collect (its kernel, preRenderCollect.wasm) sends a sprite with no
// layer mask straight to the entities collector, past collectRenderable's type dispatch and bit scan, writes its row
// itself instead of calling _writeRenderable, and reads a bodiless sprite's Transform pose itself. The collectors
// must come out as collectRenderable fills them for every sprite, bodies or not, and a masked sprite still goes
// through collectRenderable.

const N = 6;

/** The sprites in a memory with every column the collect kernel reads, the main collector there too. */
function setup(pre) {
  const m = collectMemory(pre, N, N);
  for (let i = 0; i < N; i++) {
    Transform.x[i] = 100 + i * 3.25;
    Transform.y[i] = 100 - i * 1.5;
    Transform.rotC[i] = Math.cos(i * 0.7);
    Transform.rotS[i] = Math.sin(i * 0.7);
  }
  Transform.active.fill(1);
  SpriteRenderer.active.fill(1);
  SpriteRenderer.renderVisible.fill(1);
  SpriteRenderer.spritesheetId.fill(1);
  SpriteRenderer.boundsHalfW.fill(4);
  SpriteRenderer.boundsHalfH.fill(4);
  SpriteRenderer.anchorX.fill(0.5);
  SpriteRenderer.anchorY.fill(1);
  pre.globalEntityCount = N;
  pre.cameraData = {};
  pre._querySpriteRenderer = null;
  pre.canvasWidth = 1280;
  pre.canvasHeight = 720;
  pre.cullingRatio = 0.05;
  pre.skipCull = true;
  pre._frameCameraZoom = 1;
  pre._frameCameraX = 640;
  pre._frameCameraY = 360;
  pre._frameCameraRot = 0;
  pre.visibleEntitiesCount = 0;
  pre.renderQueueEnabled = true;
  pre._spriteSortArrays = null;
  pre._collectEntityGlow = () => {};
  pre._poseX = null;
  pre._rbActive = null;
  pre.interpolatePhysicsPose = false;
  return m;
}

/** Sprites 1, 3 and 4 are bodies with a published pose; 4's rotation is not live, so it uses the Transform. */
function bodies(pre, m) {
  const v = m.views;
  v.rb.set([0, 1, 0, 1, 1, 0]);
  for (let i = 0; i < N; i++) {
    v.px[i] = 500 + i * 7.5;
    v.py[i] = 300 - i * 2.25;
    v.pc[i] = i === 4 ? 0 : Math.cos(i);
    v.ps[i] = i === 4 ? 0 : Math.sin(i);
  }
  useBodies(pre, m, { prev: false });
}

/** An empty main collector (the memory's) and fx collector. */
function emptyCollectors(pre, fx) {
  pre._renderableCount = 0;
  pre._customLayerCollectors = {
    [fx]: customLayerCollector(N),
  };
}

/** Empty main and fx collectors of their own, sized for the scene. */
function collectors(pre, fx) {
  pre._renderableY = new Float32Array(N);
  pre._renderableType = new Uint8Array(N);
  pre._renderableIndex = new Int32Array(N);
  pre._collectPx = new Float32Array(N);
  pre._collectPy = new Float32Array(N);
  pre._collectRotC = new Float32Array(N);
  pre._collectRotS = new Float32Array(N);
  pre._renderableCount = 0;
  pre.renderQueueMaxItems = N;
  pre._customLayerCollectors = {
    [fx]: customLayerCollector(N),
  };
}

function snapshot(pre, fx) {
  const n = pre._renderableCount;
  const rows = (a, k) => Array.from(a.subarray(0, k));
  const c = pre._customLayerCollectors[fx];
  return {
    main: {
      type: rows(pre._renderableType, n), index: rows(pre._renderableIndex, n), y: rows(pre._renderableY, n),
      px: rows(pre._collectPx, n), py: rows(pre._collectPy, n),
      rotC: rows(pre._collectRotC, n), rotS: rows(pre._collectRotS, n),
    },
    fx: { type: rows(c.type, c.count), index: rows(c.index, c.count), y: rows(c.y, c.count) },
  };
}

for (const [sortY, withBodies] of [[false, false], [true, false], [false, true], [true, true]]) {
  test(`the sprite collect fills the collectors as collectRenderable does (Y-sort ${sortY ? 'on' : 'off'}, ${withBodies ? 'bodies' : 'no bodies'})`, async () => {
    Layer.reset();
    Layer.initializeFromConfig({ fx: {} }, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
    const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
    const realCollect = pre.collectRenderable;
    try {
      const m = setup(pre);
      pre._entitySortY = false;
      if (sortY) useSortY(pre, m, () => 0);
      if (withBodies) bodies(pre, m);
      const fx = Layer.get('fx').id;
      SpriteRenderer.layerMask[2] = 1 << fx;
      SpriteRenderer.layerMask[4] = (1 << fx) | Layer.entitiesMask();

      emptyCollectors(pre, fx);
      pre._collectWasm = await bindCollect(m);
      const generic = [];
      pre.collectRenderable = (type, i) => {
        generic.push(i);
        realCollect.call(pre, type, i);
      };
      pre.collectVisibleEntities();
      pre._collectWasm = null;
      delete pre.collectRenderable;
      assert.deepEqual(generic, [2, 4], 'only the masked sprites take the generic path');
      const got = snapshot(pre, fx);
      assert.deepEqual(got.main.index, [0, 1, 3, 4, 5]);
      assert.deepEqual(got.fx.index, [2, 4]);

      // Every sprite through collectRenderable, in the loop's order.
      collectors(pre, fx);
      for (let i = 0; i < N; i++) realCollect.call(pre, 0, i);
      assert.deepEqual(got, snapshot(pre, fx));
    } finally {
      delete pre.collectRenderable;
      if (pre.collectRenderable !== realCollect) throw new Error('worker not restored');
      Layer.reset();
    }
  });
}
