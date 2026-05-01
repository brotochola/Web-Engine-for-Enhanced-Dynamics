import test from 'node:test';
import assert from 'node:assert/strict';

import { DecorationComponent } from '../../src/components/DecorationComponent.js';
import { Decoration } from '../../src/core/Decoration.js';
import { DecorationPool } from '../../src/core/DecorationPool.js';

function assertApprox(actual, expected, epsilon = 0.00001) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be close to ${expected}`);
}

function setupDecorationPool(count) {
  const previousComponentState = {};
  for (const key of Object.keys(DecorationComponent.ARRAY_SCHEMA)) {
    previousComponentState[key] = DecorationComponent[key];
  }
  previousComponentState.decorationCount = DecorationComponent.decorationCount;

  const componentBuffer = new SharedArrayBuffer(DecorationComponent.getBufferSize(count));
  DecorationComponent.initializeArrays(componentBuffer, count);
  DecorationComponent.decorationCount = count;

  const freeListBuffer = new SharedArrayBuffer(count * Uint16Array.BYTES_PER_ELEMENT);
  const freeList = new Uint16Array(freeListBuffer);
  for (let i = 0; i < count; i++) freeList[i] = i;

  const freeListTopBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  new Int32Array(freeListTopBuffer)[0] = count;

  const activeListBuffer = new SharedArrayBuffer((1 + count) * Uint16Array.BYTES_PER_ELEMENT);
  const activeListLockBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);

  DecorationPool.reset();
  DecorationPool.initialize(count);
  DecorationPool.initializeFreeList(freeListBuffer, freeListTopBuffer);
  DecorationPool.initializeActiveList(activeListBuffer, activeListLockBuffer);

  return () => {
    DecorationPool.reset();
    for (const [key, value] of Object.entries(previousComponentState)) {
      DecorationComponent[key] = value;
    }
  };
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
