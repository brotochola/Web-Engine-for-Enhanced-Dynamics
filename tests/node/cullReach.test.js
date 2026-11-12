import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { bindCollect, collectMemory } from '../bench/preRenderCollectKernel.mjs';
import { Query } from '../../src/core/query.js';
import { Layer } from '../../src/core/layer.js';
import { spriteCullReach } from '../../src/util/spriteCullReach.js';

// N-140: the cull padded the view with half a sprite's larger side around its pose, but a sprite is drawn from its
// anchor, by default its foot (0.5, 1): a house 293×262 px went missing while its top 44 px were still on screen,
// and trees anchored at 0.95 likewise. The pad is now the sprite's reach from its anchor to its farthest corner.

test('the reach from the anchor', () => {
  // Half bounds 146.5 × 131 (a 293 × 262 house), anchored at its foot: the far corner is 146.5 across, 262 up.
  assert.equal(spriteCullReach(146.5, 131, 0.5, 1, 0), Math.sqrt(146.5 * 146.5 + 262 * 262));
  // Centred: half the diagonal.
  assert.equal(spriteCullReach(30, 40, 0.5, 0.5, 0), 50);
  // A corner anchor reaches the whole diagonal; an anchor outside the sprite reaches farther.
  assert.equal(spriteCullReach(30, 40, 0, 1, 0), 100);
  assert.equal(spriteCullReach(30, 40, 1.5, 0.5, 0), Math.sqrt(90 * 90 + 40 * 40));
  // NaN anchors count as centred; no bounds, the visual range (never below 0).
  assert.equal(spriteCullReach(30, 40, NaN, NaN, 0), 50);
  assert.equal(spriteCullReach(0, 0, 0.5, 1, 120), 120);
  assert.equal(spriteCullReach(NaN, -1, 0.5, 1, -5), 0);
});

const N = 64;

async function collectFrame(place) {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const realQuery = Query.queryActiveEntities;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const m = collectMemory(pre, N, N);
    const v = m.views;
    const ids = [];
    for (const [i, s] of place.entries()) {
      v.tActive[i] = 1;
      v.sActive[i] = 1;
      v.sVisible[i] = 1;
      v.sheet[i] = 1;
      v.rotC[i] = 1;
      v.rotS[i] = 0;
      v.scaleX[i] = 1;
      v.scaleY[i] = 1;
      v.x[i] = s.x;
      v.y[i] = s.y;
      v.halfW[i] = s.halfW;
      v.halfH[i] = s.halfH;
      v.anchorX[i] = s.anchorX;
      v.anchorY[i] = s.anchorY;
      if (v.visualRange) v.visualRange[i] = 0;
      if (v.mask) v.mask[i] = 0;
      v.rb[i] = 0;
      ids.push(i);
    }
    Query.queryActiveEntities = () => Uint16Array.from(ids);
    // A 1280 × 720 view at (0, 0), zoom 1, the default 10 % margin: y up to 792 is in the padded view.
    pre.cameraData = {};
    pre._querySpriteRenderer = null;
    pre.canvasWidth = 1280;
    pre.canvasHeight = 720;
    pre.cullingRatio = 0.1;
    pre.skipCull = false;
    pre._frameCameraZoom = 1;
    pre._frameCameraX = 0;
    pre._frameCameraY = 0;
    pre._frameCameraRot = place.rot || 0;
    pre.renderQueueEnabled = true;
    pre._entitySortY = false;
    pre._collectEntityGlow = () => {};
    pre._poseX = null;
    pre._rbActive = null;
    pre.config = {};
    pre._renderableCount = 0;
    pre.visibleEntitiesCount = 0;
    pre._customLayerCollectors = {};
    pre._collectWasm = await bindCollect(m);
    pre.collectVisibleEntities();
    return Array.from(v.oIndex.subarray(0, pre._renderableCount));
  } finally {
    console.warn = warn;
    Query.queryActiveEntities = realQuery;
    Layer.reset();
  }
}

const house = (x, y) => ({ x, y, halfW: 146.5, halfH: 131, anchorX: 0.5, anchorY: 1 });

test('a house whose foot is below the view and whose top is still in it is collected', async () => {
  // Foot at 950: its top at 688, 32 px inside the 720 px view. The old pad (146.5) dropped it once its foot passed
  // 792 + 146.5 = 938.5; its reach (300.2) keeps it. Foot at 1200: its whole reach short of the padded view.
  const got = await collectFrame([house(640, 950), house(640, 1200), house(640, 400)]);
  assert.deepEqual(got.sort(), [0, 2]);
});

test('a tree anchored at 0.95, a turned camera: within its reach of the view, collected', async () => {
  // 120 × 300 at (0.45, 0.95): reach 292.5. Camera turned 0.3: the one at y 1200 sits 702 below the view's centre
  // line in view space, past the old pad (360 + 72 + 150 = 582) and inside the reach (724); the one at 1500 is not.
  const tree = (x, y) => ({ x, y, halfW: 60, halfH: 150, anchorX: 0.45, anchorY: 0.95 });
  const place = [tree(300, 1200), tree(300, 1500)];
  place.rot = 0.3;
  assert.deepEqual(await collectFrame(place), [0]);
});
