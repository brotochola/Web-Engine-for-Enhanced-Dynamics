// DX-DECOSORT: a decoration's sortOffsetY moves the y it sorts at, not the y it is drawn or culled at. A house in
// Conurbano-weed is one entity whose wall is attached pieces: each piece is culled at its centre and sorted at its
// column's base. N-110: under Y-sort an attached decoration sorts at its parent's own key (the parent sprite's foot
// line on the drawn pose, rounded, in its zIndex band), so its innerZ orders it against its parent's body; a
// world-owned one's key, with the column's default 0, is the one the collect wrote before the column existed.
import test from 'node:test';
import assert from 'node:assert/strict';

import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { Decoration } from '../../src/core/decoration.js';
import { DecorationPool, decorationNoParent } from '../../src/core/decorationPool.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Layer } from '../../src/core/layer.js';
import { DECORATION_Y_SORT_SCALE } from '../../src/util/configDefaults.js';
import { PoolSlotArray } from '../../src/util/poolSlotWidth.js';
import { spriteYSortKey, zSortBand } from '../../src/util/sortIndexByKey.js';
import { calculateCameraScreenBounds } from '../../src/util/utils.js';
import { setupDecorationCollect } from '../bench/decorationCollectMicrobench.mjs';
import { setupSwayKernel } from '../bench/decorationSwayWasmMicrobench.mjs';
import { loadWorker } from '../bench/workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';

const D = DecorationComponent;
const K = DECORATION_Y_SORT_SCALE;
// setupDecorationCollect's world, whose height gives the zIndex band.
const BAND = zSortBand(5000);

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

/** Labels sorted by their keys, as the painter orders the queue (larger in front). */
function queueOrder(rows) {
  return rows.slice().sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map((row) => row[0]);
}

/** Decoration i attached to parent p at local (0, localY), innerZ and sortOffsetY given, nothing else set. */
function attach(i, p, innerZ, sortOffsetY = 0, localY = -100) {
  D.parentEntityIndex[i] = p;
  D.innerZ[i] = innerZ;
  D.sortOffsetY[i] = sortOffsetY;
  D.localX[i] = 0;
  D.localY[i] = localY;
  D.offsetY[i] = 0;
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
  const s = await setupDecorationCollect({ n: 8, parents: 2, ySort: true });
  const { pre } = s;
  // Parent 1: a feet-anchored sprite, zIndex 0, standing still at y 500.
  Transform.y[1] = 500;
  attach(0, 1, 0, 40);
  attach(1, 1, 0, -40);
  // World-owned at 520, sorted at 490.
  D.parentEntityIndex[2] = decorationNoParent();
  D.innerZ[2] = 0;
  D.sortOffsetY[2] = -30;
  D.y[2] = 520;
  D.offsetY[2] = 0;
  s.visible[0] = 3;
  s.visible.set([0, 1, 2], 1);
  assert.equal(s.frame(), 3);

  assert.equal(keyOf(pre, 0), (500 + 40) * K);
  assert.equal(keyOf(pre, 1), (500 - 40) * K);
  assert.equal(keyOf(pre, 2), (520 - 30) * K);
  // The queue's order: an entity standing at the parent's y (the sprite collect's key) between the pieces.
  const order = queueOrder([['+40', keyOf(pre, 0)], ['-40', keyOf(pre, 1)], ['entity', spriteYSortKey(500, K)], ['world', keyOf(pre, 2)]]);
  assert.deepEqual(order, ['-40', 'world', 'entity', '+40']);
  // Where they are drawn did not move: the parent plus localY, the world-owned one at its y.
  assert.equal(drawnYOf(pre, 0), 400);
  assert.equal(drawnYOf(pre, 1), 400);
  assert.equal(drawnYOf(pre, 2), 520);
});

test('with sortOffsetY 0 a world-owned key is the one written before; an attached one is its parent\'s key plus innerZ', async () => {
  const s = await setupDecorationCollect({ n: 4000, parents: 64, ySort: true });
  const { pre } = s;
  // Parent and decoration ys a key could round on: -0, halves, far ones (the first half is attached, the rest not).
  Transform.y[1] = -0;
  Transform.y[2] = 0.5;
  Transform.y[3] = 1e6 + 0.3;
  Transform.y[5] = -2.5;
  D.y[3000] = -0;
  D.y[3001] = 2.5;
  D.y[3002] = 123456.789;
  D.y[3003] = -0.5;
  assert.equal(s.frame(), s.n);
  const noParent = decorationNoParent();
  const pose = new Float64Array(4);
  const yKey = new Float64Array(1);
  let attached = 0;
  for (let k = 0; k < s.n; k++) {
    const i = pre._renderableIndex[k];
    assert.equal(D.sortOffsetY[i], 0);
    const p = D.parentEntityIndex[i];
    if (p !== noParent && Transform.active[p]) {
      attached++;
      // The parent sprite's key as the sprite collect makes it: its line on the drawn pose, then its zIndex band.
      pre._displayPose(p, pose);
      pre._storeEntitySortY(0, p, pose, yKey, 0);
      const parent = pre._orderKey(0, p, yKey[0], true);
      assert.ok(Object.is(pre._renderableY[k], Math.fround(parent + D.innerZ[i])), `row ${k} (decoration ${i}, parent ${p})`);
    } else {
      const before = D.y[i] * K + D.innerZ[i];
      assert.ok(Object.is(pre._renderableY[k], Math.fround(before)), `row ${k} (decoration ${i}): ${pre._renderableY[k]} vs ${before}`);
    }
  }
  assert.equal(attached, s.attached);
});

test('N-110: innerZ puts an attached decoration in front of or behind its parent, whatever the parent\'s fraction, anchor, zIndex or interpolation', async () => {
  const s = await setupDecorationCollect({ n: 16, parents: 8, ySort: true });
  const { pre } = s;
  // Parent 1: feet-anchored, still, at a fraction past a quarter (the old key put innerZ -32 in front of it).
  Transform.y[1] = 100.3;
  // Parent 4: anchored at its centre on a 96-high frame (bindParentSprites), its foot 48 px below its y.
  Transform.y[4] = 200;
  // Parent 0: centred too, and zIndex 1.
  Transform.y[0] = 300;
  // Parent 2: a body between two physics steps, drawn half way from 150 to 170 while its Transform holds 170.
  Transform.y[2] = 170;
  const saved = {};
  for (const key of ['_poseX', '_poseY', '_poseRotC', '_poseRotS', '_prevPoseX', '_prevPoseY', '_prevPoseRotC', '_prevPoseRotS', '_rbActive', 'interpolatePhysicsPose', '_poseAlpha']) {
    saved[key] = pre[key];
  }
  const col = (fill) => new Float32Array(8).fill(fill);
  pre._poseX = col(0);
  pre._poseY = col(0);
  pre._poseY[2] = 170;
  pre._poseRotC = col(1);
  pre._poseRotS = col(0);
  pre._prevPoseX = col(0);
  pre._prevPoseY = col(0);
  pre._prevPoseY[2] = 150;
  pre._prevPoseRotC = col(1);
  pre._prevPoseRotS = col(0);
  pre._rbActive = new Uint8Array(8);
  pre._rbActive[2] = 1;
  pre.interpolatePhysicsPose = true;
  pre._poseAlpha = 0.5;
  try {
    // The parents' own keys: what their sprites sort at.
    const parentKey = { 1: 100 * K, 4: (200 + 48) * K, 0: BAND + (300 + 48) * K, 2: 160 * K };
    const cases = [[1, -32, 1], [4, -1, 1], [0, -1, 1], [2, -1, 1]];
    const list = [];
    cases.forEach(([p, behind, front], c) => {
      attach(2 * c, p, behind);
      attach(2 * c + 1, p, front);
      list.push(2 * c, 2 * c + 1);
    });
    s.visible[0] = list.length;
    s.visible.set(list, 1);
    assert.equal(s.frame(), list.length);
    cases.forEach(([p, behind, front], c) => {
      const back = keyOf(pre, 2 * c);
      const ahead = keyOf(pre, 2 * c + 1);
      assert.equal(back, parentKey[p] + behind, `parent ${p}: the one behind`);
      assert.equal(ahead, parentKey[p] + front, `parent ${p}: the one in front`);
      assert.deepEqual(queueOrder([['parent', parentKey[p]], ['behind', back], ['front', ahead]]), ['behind', 'parent', 'front'], `parent ${p}`);
    });
    // Drawn where the parent is drawn: the interpolated body's decorations at 160 - 100.
    assert.equal(drawnYOf(pre, 6), 60);

    // sortOffsetY moves the parent's key by the world px it holds, fraction and all.
    attach(0, 1, 0, 12.4);
    attach(1, 1, 0, -0.6);
    s.visible[0] = 2;
    s.visible.set([0, 1], 1);
    s.frame();
    assert.equal(keyOf(pre, 0), Math.fround(100 * K + Math.fround(12.4) * K));
    assert.equal(keyOf(pre, 1), Math.fround(100 * K + Math.fround(-0.6) * K));
  } finally {
    Object.assign(pre, saved);
  }
});

test('without a layer that y-sorts, decorations take one key and none is made; they are still placed', async () => {
  const s = await setupDecorationCollect({ n: 200, parents: 10 });
  const { pre } = s;
  assert.equal(Layer.anyYSorting(), false);
  assert.equal(s.frame(), s.n);
  for (let k = 0; k < s.n; k++) assert.ok(Object.is(pre._renderableY[k], 0), `row ${k}`);
  // World-owned ones at their y, attached ones at the parent's plus localY (the parents stand still, unturned).
  for (let k = 0; k < s.n; k++) {
    const i = pre._renderableIndex[k];
    const p = D.parentEntityIndex[i];
    const want = p !== decorationNoParent() ? Math.fround(Transform.y[p] + D.localY[i]) : D.y[i];
    assert.equal(pre._collectPy[k], want, `row ${k}`);
  }
});

test('a piece above an off-screen parent is culled at its centre: on screen, collected with its sort point\'s key', async () => {
  const { worker, n } = await setupSwayKernel({ n: 256 });
  if (!worker.cameraData) worker.cameraData = new Float32Array(16);
  const SlotArray = PoolSlotArray(n);
  worker.visibleDecorationsData = new SlotArray(new SharedArrayBuffer((n + 1) * SlotArray.BYTES_PER_ELEMENT));
  // The view: world x 0..5100, y 0..5000, no margin.
  calculateCameraScreenBounds(1, 0, 0, 5100, 5000, 0, worker._cameraBounds, 0);
  // The harness has no Transform: stand-in columns for the parent, 200 px below the view, and no sprite for it.
  for (const [key, Ctor] of [['active', Uint8Array], ['x', Float32Array], ['y', Float32Array], ['rotC', Float32Array], ['rotS', Float32Array]]) {
    Transform[key] = new Ctor(16);
  }
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(16)), 16);
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

    // Pre-render collects what the particle worker listed, the entities layer y-sorting: the piece's key is its sort
    // point's, 300 px below its parent and off screen, and it is drawn where it was culled.
    Layer.reset();
    Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: { ySorting: true }, lighting: {} }, true);
    const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
    pre.maxDecorations = n;
    pre.visibleDecorationsData = visible;
    pre.renderQueueEnabled = true;
    pre._decorationZoomAlpha = 1;
    pre._customLayerCollectors = null;
    pre._spriteSortArrays = null;
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
