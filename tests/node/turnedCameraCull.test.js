import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { bindCollect, collectMemory } from '../bench/preRenderCollectKernel.mjs';
import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { viewWorldToScreen } from '../../src/util/viewBounds.js';

// E-51. With the camera turned, pre-render culled with the box around the
// turned view (about 2x the view at 45 degrees on 16:9) and queued everything
// in it. The turned path tests each sprite in view space. Kept: exactly the
// sprites whose turned screen position is within the canvas, plus the culling
// margin and the sprite's own extent, as viewWorldToScreen puts them. The collect is the shipped one, its kernel
// (preRenderCollect.wasm) on a memory with every column it reads.

const N = 60 * 40;
const CW = 1280;
const CH = 720;

/** The sprites and camera; returns the entities the collect queued, in order. */
async function setup(pre, rot, zoom) {
  const m = collectMemory(pre, N, N, { mask: false });
  Transform.active.fill(1);
  SpriteRenderer.active.fill(1);
  SpriteRenderer.renderVisible.fill(1);
  SpriteRenderer.spritesheetId.fill(1);
  for (let i = 0; i < N; i++) {
    Transform.x[i] = (i % 60) * 40 - 200;
    Transform.y[i] = ((i / 60) | 0) * 40 - 300;
    SpriteRenderer.boundsHalfW[i] = 4 + (i % 5) * 3;
    SpriteRenderer.boundsHalfH[i] = 6;
  }
  pre.globalEntityCount = N;
  pre.cameraData = {};
  pre._querySpriteRenderer = null;
  pre.canvasWidth = CW;
  pre.canvasHeight = CH;
  pre.cullingRatio = 0.05;
  pre.skipCull = false;
  pre._frameCameraZoom = zoom;
  pre._frameCameraX = 300;
  pre._frameCameraY = 150;
  pre._frameCameraRot = rot;
  pre.visibleEntitiesCount = 0;
  pre.renderQueueEnabled = true;
  pre._entitySortY = false;
  pre._poseX = null;
  pre._rbActive = null;
  pre._renderableCount = 0;
  pre._collectEntityGlow = () => {};
  pre._collectWasm = await bindCollect(m);
  return () => Array.from(m.views.oIndex.subarray(0, pre._renderableCount));
}

function expected(rot, zoom) {
  const marginScale = zoom < 1 ? zoom : 1;
  const mx = CW * 0.05 * marginScale;
  const my = CH * 0.05 * marginScale;
  const out = { x: 0, y: 0 };
  const keep = [];
  for (let i = 0; i < N; i++) {
    viewWorldToScreen(300, 150, zoom, rot, CW, CH, Transform.x[i], Transform.y[i], out);
    const ext = Math.max(SpriteRenderer.boundsHalfW[i], SpriteRenderer.boundsHalfH[i]) * zoom;
    // Float32 positions: allow a hair for the different operation order.
    const eps = 1e-3;
    if (out.x >= -mx - ext - eps && out.x <= CW + mx + ext + eps && out.y >= -my - ext - eps && out.y <= CH + my + ext + eps) {
      keep.push(i);
    }
  }
  return keep;
}

test('a turned camera queues exactly the sprites in the turned view', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  for (const [rot, zoom] of [[Math.PI / 4, 1], [0.3, 0.7], [-1.1, 1.6], [Math.PI, 1]]) {
    const queued = await setup(pre, rot, zoom);
    pre.collectVisibleEntities();
    const want = expected(rot, zoom);
    assert.deepEqual(queued(), want, `rot ${rot} zoom ${zoom}`);
    assert.equal(pre.visibleEntitiesCount, want.length);
  }
});

test('at 45 degrees the turned view keeps about half of the box around it', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const queued = await setup(pre, Math.PI / 4, 1);
  pre.collectVisibleEntities();
  const turned = queued();
  // The box the old cull used, with the same margin and extents.
  const c = Math.SQRT1_2;
  const boxHalf = (CW * 0.5 * c + CH * 0.5 * c);
  let inBox = 0;
  for (let i = 0; i < N; i++) {
    const sx = (Transform.x[i] - 300) - CW * 0.5;
    const sy = (Transform.y[i] - 150) - CH * 0.5;
    const ext = Math.max(SpriteRenderer.boundsHalfW[i], SpriteRenderer.boundsHalfH[i]);
    const lim = boxHalf + CW * 0.05 + ext;
    const limY = boxHalf + CH * 0.05 + ext;
    if (Math.abs(sx) <= lim && Math.abs(sy) <= limY) inBox++;
  }
  assert.ok(turned.length > 0);
  assert.ok(turned.length < inBox * 0.65, `turned ${turned.length} of box ${inBox}`);
});

test('rotation 0 keeps the screen box as before', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const queued = await setup(pre, 0, 1);
  pre.collectVisibleEntities();
  assert.deepEqual(queued(), expected(0, 1));
});
