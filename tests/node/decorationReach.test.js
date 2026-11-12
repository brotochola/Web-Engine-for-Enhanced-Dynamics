// N-141: the decorations' screen test read one point a decoration (its position against the view plus the culling
// margin), so a large one drawn from its foot (a tree, a wall piece) went missing at the bottom edge with its top still
// on screen. The pool now keeps the largest reach any decoration has from its position to the far corner of its sprite
// (DecorationPool.noteReach, at spawn and on a change of scale, anchor, texture or offset), and the particle worker
// pads the decorations' test with it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateCameraScreenBounds } from '../../src/util/utils.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { PoolSlotArray } from '../../src/util/poolSlotWidth.js';
import { setupSwayKernel } from '../bench/decorationSwayWasmMicrobench.mjs';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { Decoration } from '../../src/core/decoration.js';

/** A texture 200 x 600 px for every id (the test's bigAtlas). */
function withTextureSize(fn) {
  const size = DecorationPool._textureSize;
  DecorationPool._textureSize = () => ({ w: 200, h: 600 });
  return Promise.resolve(fn()).finally(() => {
    DecorationPool._textureSize = size;
  });
}

async function scene() {
  const { worker, n } = await setupSwayKernel({ n: 2000, listCounters: true });
  if (!worker.cameraData) worker.cameraData = new Float32Array(16);
  const SlotArray = PoolSlotArray(n + 8);
  worker.visibleDecorationsData = new SlotArray(new SharedArrayBuffer((n + 9) * SlotArray.BYTES_PER_ELEMENT));
  // The view 5100 x 5000 at the origin, no culling margin.
  calculateCameraScreenBounds(1, 0, 0, 5100, 5000, 0, worker._cameraBounds, 0);
  // The setup fills the pool with grass: free two slots for the test's own.
  DecorationPool.despawn(0);
  DecorationPool.despawn(1);
  const frame = () => {
    worker._frameCamValid = true;
    worker.refreshActiveDecorationSnapshot();
    worker.resolveAttachedDecorations(0);
    worker.updateDecorationScreen();
    const v = worker.visibleDecorationsData;
    return Array.from(v.subarray(1, 1 + v[0]));
  };
  return { worker, n, frame };
}

test('N-141: a decoration\'s reach is its sprite\'s far corner from its anchor, plus its draw offset', () =>
  withTextureSize(async () => {
    await scene();
    const i = 5;
    DecorationComponent.textureId[i] = 3;
    DecorationComponent.anchorX[i] = 0.5;
    DecorationComponent.anchorY[i] = 1;
    DecorationComponent.scaleX[i] = -2; // a flip reaches as far
    DecorationComponent.scaleY[i] = 2;
    DecorationComponent.offsetX[i] = 3;
    DecorationComponent.offsetY[i] = 4;
    assert.equal(DecorationPool.decorationReach(i), Math.sqrt(200 * 200 + 1200 * 1200) + 5);
  }));

test('N-141: a tall decoration whose foot is below the view is drawn while its top shows; one past its reach is not', () =>
  withTextureSize(async () => {
    const { frame } = await scene();
    // Anchored at its foot (the default), 600 px tall: at y 5300 its top is 300 px into the view (bottom 5000); at 6000 it
    // is past its reach (sqrt(100² + 600²) ≈ 608).
    const tree = DecorationPool.spawn({ x: 1000, y: 5300, sway: false });
    const far = DecorationPool.spawn({ x: 1000, y: 6000, sway: false });
    assert.ok(tree >= 0 && far >= 0);
    assert.equal(DecorationPool.maxReach(), Math.ceil(Math.sqrt(100 * 100 + 600 * 600)));
    const got = frame();
    assert.ok(got.includes(tree), 'the tree whose top shows');
    assert.ok(!got.includes(far), 'not the one past its reach');
  }));

test('N-141: growing a decoration raises the pad, and the screen test runs again', () =>
  withTextureSize(async () => {
    const { frame } = await scene();
    const tree = DecorationPool.spawn({ x: 1000, y: 5900, sway: false });
    assert.ok(!frame().includes(tree), 'past its reach at scale 1');
    Decoration.get(tree).scaleY = 2; // 1 200 px tall: its top at 4 700
    assert.ok(DecorationPool.maxReach() >= 1200);
    assert.ok(frame().includes(tree), 'drawn once it reaches into the view');
    DecorationPool.despawnAll();
    assert.equal(DecorationPool.maxReach(), 0, 'no decoration, no reach');
  }));
