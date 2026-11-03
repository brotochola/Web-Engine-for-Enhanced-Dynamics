// DX-DECOSORT: a decoration's sortOffsetY moves the y it sorts at (its own, or its parent's when attached), not the
// y it is drawn or culled at. A house in Conurbano-weed is one entity whose wall is attached pieces: each piece is
// culled at its centre and sorted at its column's base. With the column's default, 0, every key is the one the
// collect wrote before the column existed.
import test from 'node:test';
import assert from 'node:assert/strict';

import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { Transform } from '../../src/components/transform.js';
import { Decoration } from '../../src/core/decoration.js';
import { DecorationPool, decorationNoParent } from '../../src/core/decorationPool.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Layer } from '../../src/core/layer.js';
import { DECORATION_Y_SORT_SCALE } from '../../src/util/configDefaults.js';
import { PoolSlotArray } from '../../src/util/poolSlotWidth.js';
import { spriteYSortKey } from '../../src/util/sortIndexByKey.js';
import { calculateCameraScreenBounds } from '../../src/util/utils.js';
import { setupDecorationCollect } from '../bench/decorationCollectMicrobench.mjs';
import { setupSwayKernel } from '../bench/decorationSwayWasmMicrobench.mjs';
import { loadWorker } from '../bench/workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';

const D = DecorationComponent;
const K = DECORATION_Y_SORT_SCALE;

/** The key pre-render's collect wrote for decoration `i` (its rows are in the visible list's order). */
function keyOf(pre, i) {
  for (let k = 0; k < pre._renderableCount; k++) if (pre._renderableIndex[k] === i) return pre._renderableY[k];
  throw new Error(`decoration ${i} was not collected`);
}

/** The drawn y pre-render's collect stashed for decoration `i`. */
function drawnYOf(pre, i) {
  for (let k = 0; k < pre._renderableCount; k++) if (pre._renderableIndex[k] === i) return pre._collectPy[k];
  throw new Error(`decoration ${i} was not collected`);
}

test('spawn, spawnMany, addDecoration and the facade keep sortOffsetY; it is 0 by default', () => {
  buildPoolScene({ decorations: 64, maxAttached: 4 });
  const plain = DecorationPool.spawn({ x: 10, y: 20 });
  assert.equal(D.sortOffsetY[plain], 0);
  const world = Decoration.spawn({ x: 10, y: 20, sortOffsetY: 12.5 });
  assert.equal(D.sortOffsetY[world], 12.5);
  const kid = DecorationPool.spawn({ parent: 3, localY: -300, sortOffsetY: 300 });
  assert.equal(D.sortOffsetY[kid], 300);
  assert.equal(D.y[kid], 0, 'an attached decoration still waits for its parent to place it');

  // spawnMany: one value for all of them, or one per decoration.
  const each = new Int32Array(3).fill(-1);
  assert.equal(Decoration.spawnMany({ x: [1, 2, 3], y: [4, 5, 6], sortOffsetY: [5, -5, 0.5], out: each }), 3);
  assert.deepEqual([...each].map((i) => D.sortOffsetY[i]), [5, -5, 0.5]);
  const same = new Int32Array(2).fill(-1);
  assert.equal(Decoration.spawnMany({ x: [1, 2], y: [1, 2], sortOffsetY: 7, out: same }), 2);
  assert.deepEqual([...same].map((i) => D.sortOffsetY[i]), [7, 7]);

  // addDecoration hands its extra fields to spawn.
  const piece = GameObject.prototype.addDecoration.call({ index: 5 }, null, 0, -300, 1, 1, 0, { sortOffsetY: 300 });
  assert.ok(piece >= 0);
  assert.equal(D.sortOffsetY[piece], 300);
  assert.equal(D.localY[piece], -300);
  assert.equal(DecorationPool.getAttachedCount(5), 1);

  // The facade reads and writes it; one kept past a despawn leaves the slot's next decoration alone.
  const facade = Decoration.get(world);
  assert.equal(facade.sortOffsetY, 12.5);
  facade.sortOffsetY = -9;
  assert.equal(D.sortOffsetY[world], -9);
  Decoration.despawn(world);
  assert.equal(facade.sortOffsetY, 0);
  const next = DecorationPool.spawn({ x: 1, y: 1 });
  assert.equal(next, world, 'the free list hands the slot back');
  facade.sortOffsetY = 99;
  assert.equal(D.sortOffsetY[next], 0);
});

test('two pieces of one parent, at sortOffsetY -40 and +40, sort on either side of an entity at the parent\'s y', async () => {
  const s = await setupDecorationCollect({ n: 8, parents: 2 });
  const { pre } = s;
  Transform.y[0] = 500;
  const place = (i, parent, sortOffsetY, y) => {
    D.parentEntityIndex[i] = parent;
    D.innerZ[i] = 0;
    D.sortOffsetY[i] = sortOffsetY;
    D.x[i] = 100;
    D.y[i] = y;
    D.localX[i] = 0;
    D.localY[i] = -100;
    D.offsetY[i] = 0;
  };
  place(0, 0, 40, 0);
  place(1, 0, -40, 0);
  // World-owned at 520, sorted at 490.
  place(2, decorationNoParent(), -30, 520);
  s.visible[0] = 3;
  s.visible.set([0, 1, 2], 1);
  assert.equal(s.frame(), 3);

  assert.equal(keyOf(pre, 0), (500 + 40) * K);
  assert.equal(keyOf(pre, 1), (500 - 40) * K);
  assert.equal(keyOf(pre, 2), (520 - 30) * K);
  // The queue's order, by key: an entity standing at the parent's y (the sprite collect's key) between the pieces.
  const order = [['+40', keyOf(pre, 0)], ['-40', keyOf(pre, 1)], ['entity', spriteYSortKey(500, K)], ['world', keyOf(pre, 2)]]
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map((row) => row[0]);
  assert.deepEqual(order, ['-40', 'world', 'entity', '+40']);
  // Where they are drawn did not move: the parent plus localY, the world-owned one at its y.
  assert.equal(drawnYOf(pre, 0), 400);
  assert.equal(drawnYOf(pre, 1), 400);
  assert.equal(drawnYOf(pre, 2), 520);
});

test('with sortOffsetY 0 every key is the one the collect wrote before the column', async () => {
  const s = await setupDecorationCollect({ n: 4000, parents: 64 });
  const { pre } = s;
  // Parent and decoration ys a key could round on: -0, halves, far ones (the first half is attached, the rest not).
  Transform.y[1] = -0;
  Transform.y[2] = 0.5;
  Transform.y[3] = 1e6 + 0.3;
  Transform.y[4] = -2.5;
  D.y[3000] = -0;
  D.y[3001] = 2.5;
  D.y[3002] = 123456.789;
  D.y[3003] = -0.5;
  assert.equal(s.frame(), s.n);
  const noParent = decorationNoParent();
  let attached = 0;
  for (let k = 0; k < s.n; k++) {
    const i = pre._renderableIndex[k];
    assert.equal(D.sortOffsetY[i], 0);
    const p = D.parentEntityIndex[i];
    const parented = p !== noParent && Transform.active[p];
    if (parented) attached++;
    const before = parented ? Transform.y[p] * K + D.innerZ[i] : D.y[i] * K + D.innerZ[i];
    assert.ok(Object.is(pre._renderableY[k], Math.fround(before)), `row ${k} (decoration ${i}): ${pre._renderableY[k]} vs ${before}`);
  }
  assert.equal(attached, s.attached);
});

test('a piece above an off-screen parent is culled at its centre: on screen, collected with its sort point\'s key', async () => {
  const { worker, n } = await setupSwayKernel({ n: 256 });
  if (!worker.cameraData) worker.cameraData = new Float32Array(16);
  const SlotArray = PoolSlotArray(n);
  worker.visibleDecorationsData = new SlotArray(new SharedArrayBuffer((n + 1) * SlotArray.BYTES_PER_ELEMENT));
  // The view: world x 0..5100, y 0..5000, no margin.
  calculateCameraScreenBounds(1, 0, 0, 5100, 5000, 0, worker._cameraBounds, 0);
  // The harness has no Transform: stand-in columns for the parent, 200 px below the view.
  for (const [key, Ctor] of [['active', Uint8Array], ['x', Float32Array], ['y', Float32Array], ['rotC', Float32Array], ['rotS', Float32Array]]) {
    Transform[key] = new Ctor(16);
  }
  try {
    Transform.active[3] = 1;
    Transform.x[3] = 2600;
    Transform.y[3] = 5200;
    Transform.rotC[3] = 1;
    DecorationPool.despawn(0); // a free slot
    const piece = DecorationPool.spawn({ parent: 3, localY: -300, sortOffsetY: 300, sway: false });
    assert.ok(piece >= 0);

    worker._frameCamValid = true;
    worker.refreshActiveDecorationSnapshot();
    worker.resolveAttachedDecorations(0);
    worker.updateDecorationScreen();
    const visible = worker.visibleDecorationsData;
    assert.equal(D.y[piece], 4900, 'placed 300 px above its parent');
    assert.ok(Array.from(visible.subarray(1, 1 + visible[0])).includes(piece), 'on screen by its centre');
    assert.equal(D.isItOnScreen[piece], 1);

    // Pre-render collects what the particle worker listed: the piece's key is its sort point's, 300 px below its
    // parent and off screen, and it is drawn where it was culled.
    Layer.reset();
    Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
    const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
    pre.maxDecorations = n;
    pre.visibleDecorationsData = visible;
    pre.renderQueueEnabled = true;
    pre._decorationZoomAlpha = 1;
    pre._customLayerCollectors = null;
    pre.renderQueueMaxItems = n;
    pre._renderableY = new Float32Array(n);
    pre._renderableType = new Uint8Array(n);
    pre._renderableIndex = new Int32Array(n);
    pre._collectPx = new Float32Array(n);
    pre._collectPy = new Float32Array(n);
    pre._collectRotC = new Float32Array(n);
    pre._collectRotS = new Float32Array(n);
    pre._renderableCount = 0;
    pre.collectVisibleDecorations();
    assert.equal(keyOf(pre, piece), (5200 + 300) * K + D.innerZ[piece]);
    assert.equal(drawnYOf(pre, piece), 4900);
  } finally {
    for (const key of ['active', 'x', 'y', 'rotC', 'rotS']) Transform[key] = undefined;
    Layer.reset();
  }
});
