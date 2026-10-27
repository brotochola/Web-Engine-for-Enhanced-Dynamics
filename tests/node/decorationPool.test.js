import test from 'node:test';
import assert from 'node:assert/strict';

import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { Decoration } from '../../src/core/decoration.js';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { DecorationSpatial } from '../../src/core/decorationSpatial.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';

function assertApprox(actual, expected, epsilon = 0.00001) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be close to ${expected}`);
}

function setupDecorationPool(count, spatial = { cellSize: 100, gridWidth: 10, gridHeight: 10 }) {
  const previousComponentState = {};
  for (const key of Object.keys(DecorationComponent.ARRAY_SCHEMA)) {
    previousComponentState[key] = DecorationComponent[key];
  }
  previousComponentState.decorationCount = DecorationComponent.decorationCount;

  const componentBuffer = new SharedArrayBuffer(DecorationComponent.getBufferSize(count));
  DecorationComponent.initializeArrays(componentBuffer, count);
  DecorationComponent.decorationCount = count;

  // Treiber-stack free list: links buffer + [head, count] header
  const freeListBuffer = new SharedArrayBuffer(count * Uint16Array.BYTES_PER_ELEMENT);
  const freeList = new Uint16Array(freeListBuffer);

  const freeListTopBuffer = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
  resetFreeList(new Int32Array(freeListTopBuffer), freeList, count, 1);

  const activeListBuffer = new SharedArrayBuffer((1 + count) * Uint16Array.BYTES_PER_ELEMENT);
  const activeListLockBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);

  const totalCells = spatial.gridWidth * spatial.gridHeight;
  const headBuf = new SharedArrayBuffer(totalCells * Uint16Array.BYTES_PER_ELEMENT);
  const nextBuf = new SharedArrayBuffer(count * Uint16Array.BYTES_PER_ELEMENT);
  const prevBuf = new SharedArrayBuffer(count * Uint16Array.BYTES_PER_ELEMENT);
  const cellOfBuf = new SharedArrayBuffer(count * Int32Array.BYTES_PER_ELEMENT);
  const lockBuf = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);

  DecorationPool.reset();
  DecorationPool.initialize(count);
  DecorationPool.initializeFreeList(freeListBuffer, freeListTopBuffer);
  DecorationPool.initializeActiveList(activeListBuffer, activeListLockBuffer);
  DecorationSpatial.initialize(
    { head: headBuf, next: nextBuf, prev: prevBuf, cellOf: cellOfBuf, lock: lockBuf },
    { ...spatial, maxDecorations: count },
    true
  );

  return () => {
    DecorationPool.reset();
    for (const [key, value] of Object.entries(previousComponentState)) {
      DecorationComponent[key] = value;
    }
  };
}

function queryContains(out, count, index) {
  for (let i = 0; i < count; i++) {
    if (out[i] === index) return true;
  }
  return false;
}

test('DecorationPool publishes stable active-list snapshots', { concurrency: false }, () => {
  const restore = setupDecorationPool(3);
  const snapshot = new Uint16Array(3);

  try {
    const first = DecorationPool.spawn({});
    const second = DecorationPool.spawn({});

    assert.equal(DecorationPool.copyActiveSnapshot(snapshot), 2);
    assert.deepEqual(Array.from(snapshot.subarray(0, 2)), [first, second]);

    DecorationPool.despawn(first);

    assert.equal(DecorationPool.copyActiveSnapshot(snapshot), 1);
    assert.deepEqual(Array.from(snapshot.subarray(0, 1)), [second]);
  } finally {
    restore();
  }
});

test('stale Decoration facades cannot mutate recycled decoration slots', { concurrency: false }, () => {
  const restore = setupDecorationPool(1);

  try {
    const firstIndex = DecorationPool.spawn({ alpha: 0.8 });
    const staleFacade = Decoration.get(firstIndex);
    assert.equal(staleFacade.active, true);
    assertApprox(staleFacade.alpha, 0.8);

    DecorationPool.despawn(firstIndex);
    const recycledIndex = DecorationPool.spawn({ alpha: 0.4 });
    const currentFacade = Decoration.get(recycledIndex);

    assert.equal(recycledIndex, firstIndex);
    assert.equal(staleFacade.active, false);
    staleFacade.alpha = 0.1;

    assert.equal(currentFacade.active, true);
    assertApprox(currentFacade.alpha, 0.4);
    assertApprox(DecorationComponent.alpha[recycledIndex], 0.4);
  } finally {
    restore();
  }
});

test('Decoration.queryCircle finds world spawn and loses it after despawn', { concurrency: false }, () => {
  const restore = setupDecorationPool(4);
  const out = new Uint16Array(8);

  try {
    const idx = DecorationPool.spawn({ x: 150, y: 150 });
    assert.ok(idx >= 0);

    let n = Decoration.queryCircle(150, 150, 10, out);
    assert.equal(n, 1);
    assert.equal(out[0], idx);

    DecorationPool.despawn(idx);
    n = Decoration.queryCircle(150, 150, 10, out);
    assert.equal(n, 0);
  } finally {
    restore();
  }
});

test('parented decorations are not in the spatial hash', { concurrency: false }, () => {
  const restore = setupDecorationPool(4);
  const out = new Uint16Array(8);

  try {
    const idx = DecorationPool.spawn({ parent: 0, localX: 10, localY: 10, x: 200, y: 200 });
    assert.ok(idx >= 0);

    const n = Decoration.queryCircle(0, 0, 500, out);
    assert.equal(n, 0);
    assert.equal(DecorationSpatial.cellOf[idx], -1);
  } finally {
    restore();
  }
});

test('setPosition moves decoration across cells for queryCircle', { concurrency: false }, () => {
  const restore = setupDecorationPool(4);
  const out = new Uint16Array(8);

  try {
    const idx = DecorationPool.spawn({ x: 50, y: 50 });
    const deco = Decoration.get(idx);

    let n = Decoration.queryCircle(50, 50, 5, out);
    assert.equal(n, 1);
    assert.equal(out[0], idx);

    deco.setPosition(550, 550);
    assertApprox(deco.x, 550);
    assertApprox(deco.y, 550);

    n = Decoration.queryCircle(50, 50, 5, out);
    assert.equal(n, 0);

    n = Decoration.queryCircle(550, 550, 5, out);
    assert.equal(n, 1);
    assert.equal(out[0], idx);
  } finally {
    restore();
  }
});

test('queryCircle caps results to out.length', { concurrency: false }, () => {
  const restore = setupDecorationPool(8);
  const out = new Uint16Array(2);

  try {
    const a = DecorationPool.spawn({ x: 100, y: 100 });
    const b = DecorationPool.spawn({ x: 105, y: 100 });
    const c = DecorationPool.spawn({ x: 110, y: 100 });
    assert.ok(a >= 0 && b >= 0 && c >= 0);

    const n = Decoration.queryCircle(105, 100, 50, out);
    assert.equal(n, 2);
    assert.ok(queryContains(out, n, a) || queryContains(out, n, b) || queryContains(out, n, c));
  } finally {
    restore();
  }
});

test('Decoration.spawn and DecorationPool.spawn share the same pool indices', { concurrency: false }, () => {
  const restore = setupDecorationPool(4);
  try {
    const viaFacade = Decoration.spawn({ x: 10, y: 20 });
    const viaPool = DecorationPool.spawn({ x: 30, y: 40 });
    assert.ok(viaFacade >= 0);
    assert.ok(viaPool >= 0);
    assert.notEqual(viaFacade, viaPool);
    Decoration.despawn(viaFacade);
    const recycled = Decoration.spawn({ x: 1, y: 1 });
    assert.equal(recycled, viaFacade);
  } finally {
    restore();
  }
});

test('spawnMany takes one value per decoration from arrays, and reports their pool indices', { concurrency: false }, () => {
  const restore = setupDecorationPool(4);
  SpriteSheetRegistry.register('bigAtlas', { animations: { rock: ['rock'], grass1: ['grass1'], grass2: ['grass2'] } });
  const C = DecorationComponent;
  try {
    const out = new Int32Array(3).fill(-1);
    const spawned = Decoration.spawnMany({
      x: [10, 50, 90],
      y: new Float64Array([40, 42, 44]),
      texture: ['grass2', 'rock', 'grass2'],
      scaleX: [1, 1.5, 0.5],
      scaleY: 2,
      rotation: [0, Math.PI / 2, 0],
      alpha: [1, 0.5, 0.25],
      tint: [0xff0000, 0x00ff00, 0x0000ff],
      anchorY: 1,
      out,
    });
    assert.equal(spawned, 3, 'count defaults to the arrays’ length');
    const read = (i) => [C.x[i], C.y[i], C.textureId[i], C.scaleX[i], C.scaleY[i], C.alpha[i], C.tint[i], C.anchorY[i]];
    assert.deepEqual(read(out[0]), [10, 40, 2, 1, 2, 1, 0xff0000, 1]);
    assert.deepEqual(read(out[1]), [50, 42, 0, 1.5, 2, 0.5, 0x00ff00, 1]);
    assert.deepEqual(read(out[2]), [90, 44, 2, 0.5, 2, 0.25, 0x0000ff, 1]);
    assertApprox(C.rotS[out[1]], 1);
    assert.equal(new Set(out).size, 3);

    const more = new Int32Array(3).fill(-1);
    assert.equal(DecorationPool.spawnMany({ x: [1, 2, 3], y: [1, 2, 3], out: more }), 1, 'the pool had room for one');
    assert.ok(more[0] >= 0);
    assert.deepEqual([...more.subarray(1)], [-1, -1], 'out has only the spawned ones');
    assert.equal(DecorationPool.spawnMany({ count: 2, x: 5, y: 5 }), 0, 'and the plain path still stops at a full pool');
  } finally {
    SpriteSheetRegistry.spritesheets.delete('bigAtlas');
    restore();
  }
});
