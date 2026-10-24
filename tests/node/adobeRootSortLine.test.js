import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { spriteYSortKey } from '../../src/util/sortIndexByKey.js';
import { Layer } from '../../src/core/layer.js';
import { DECORATION_Y_SORT_SCALE } from '../../src/util/configDefaults.js';

// B22. An Adobe root (queue type 6) went through the sprite sort line. With no
// SpriteRenderer its anchors are 0, so it missed the feet-anchored fast path
// and resolved a sprite texture it does not have. The miss is not cached, so
// it repeated every frame for every Adobe root. With no frame size the line
// is the pose itself, which is what an Adobe root should sort on.

const N = 4;

async function setup() {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Transform.rotC = new Float32Array(N).fill(1);
  Transform.rotS = new Float32Array(N);
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(N)), N);
  pre._poseX = null;
  pre._rbActive = null;
  pre._customLayerCollectors = null;
  // One worker instance for every test: rebind the sort line to this test's component arrays.
  pre._spriteSortArrays = null;
  pre.renderQueueMaxItems = 8;
  pre._renderableY = new Float32Array(8);
  pre._renderableType = new Uint8Array(8);
  pre._renderableIndex = new Int32Array(8);
  pre._renderablePx = new Float32Array(8);
  pre._renderablePy = new Float32Array(8);
  pre._renderableRotC = new Float32Array(8);
  pre._renderableRotS = new Float32Array(8);
  // As update() does before the collect (E-98d): no queue bound here, so poses go to the stash.
  pre._frameAdobeEntities = null;
  pre._bindCollectPoses();
  pre.entityLastTextureId = new Uint16Array(N).fill(0xffff);
  let resolves = 0;
  const resolve = pre._resolveEntitySpriteTextureId;
  pre._resolveEntitySpriteTextureId = function (i) {
    resolves++;
    return resolve.call(this, i);
  };
  return { pre, resolves: () => resolves };
}

test('an Adobe root sorts on its pose and never resolves a sprite texture', async () => {
  const { pre, resolves } = await setup();
  Transform.y[1] = 123.25;
  for (let frame = 0; frame < 3; frame++) {
    pre._renderableCount = 0;
    pre._writeRenderable(6, 1, 0);
  }
  assert.equal(resolves(), 0, 'no texture lookups');
  assert.equal(pre._renderableY[0], spriteYSortKey(123.25, DECORATION_Y_SORT_SCALE));
  assert.equal(pre._renderableType[0], 6);
});

test('a sprite still sorts on its foot line', async () => {
  const { pre } = await setup();
  Transform.y[2] = 50;
  SpriteRenderer.anchorX[2] = 0.5;
  SpriteRenderer.anchorY[2] = 1;
  pre._entitySortY = true;
  pre._renderableCount = 0;
  pre._writeRenderable(0, 2, 0);
  assert.equal(pre._renderableY[0], spriteYSortKey(50, DECORATION_Y_SORT_SCALE));
});

// E-98. Without Y-sort a sprite's key is its zIndex (orderSortKey ignores the Y), so the sort
// line is not computed: no frame lookup for a sprite that is not feet-anchored. An Adobe root's
// key still is (its pieces write it), which the first test above runs with Y-sort off.
test('without Y-sort a sprite computes no sort line and resolves no frame', async () => {
  const { pre, resolves } = await setup();
  Transform.x[2] = 7;
  Transform.y[2] = 50;
  SpriteRenderer.anchorX[2] = 0.5;
  SpriteRenderer.anchorY[2] = 0.5; // not feet-anchored: its sort line needs the frame
  pre._entitySortY = false;
  pre._renderableCount = 0;
  pre._writeRenderable(0, 2, 0);
  assert.equal(resolves(), 0);
  assert.equal(pre._renderablePx[0], 7, 'the pose is still stashed for the emit');
  assert.equal(pre._renderablePy[0], 50);
  assert.equal(pre._renderableType[0], 0);

  pre._entitySortY = true;
  pre._renderableCount = 0;
  pre._writeRenderable(0, 2, 0);
  assert.ok(resolves() > 0, 'under Y-sort the line resolves the frame');
});

test('each frame reads whether the entities layer is Y-sorted', async () => {
  const { pre } = await setup();
  const saved = [Layer._ySorting, Layer.entitiesId];
  pre.cameraData = null;
  try {
    Layer._ySorting = new Uint8Array(4);
    Layer.entitiesId = 1;
    pre.resetFrameCounters();
    assert.equal(pre._entitySortY, false);
    Layer._ySorting[1] = 1;
    pre.resetFrameCounters();
    assert.equal(pre._entitySortY, true);
  } finally {
    [Layer._ySorting, Layer.entitiesId] = saved;
  }
});
