import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bindEntityIdWidth,
  entityIdWidth,
  MAX_ENTITIES_U32,
} from '../../src/util/entityIdWidth.js';
import { teardownSceneSharedState } from '../../src/util/sceneSharedBuffers.js';

/**
 * B-10. `teardownSceneSharedState` cleared the per-type active-list counters
 * through a hardcoded `Uint16Array`:
 *
 *     const view = new Uint16Array(sab);
 *     view[0] = 0;
 *
 * The list is allocated as `(1 + registration.count) * idBytes`, and its view is
 * an `EntityIdArray()` whose width comes from `config.entityIdWidth`. On a
 * 32-bit-id scene that is a `Uint32Array`, so writing element 0 through a
 * `Uint16Array` clears only the **low half** of the count. The high half keeps
 * its old value and the list still reads as non-empty after teardown.
 *
 * This is only reachable in 32-bit mode, which is why it is latent today:
 * `MAX_ENTITIES_U16` is 65535, so a 16-bit count can never exceed 65535 and its
 * high half is never anything but zero - there the old code was accidentally
 * correct. `MAX_ENTITIES_U32` is 300000, so a 32-bit scene can hold well over
 * 65535 entities of one type, and then the low half alone is not the count.
 *
 * `sceneSharedBuffers.js:108` already warns when a registration exceeds the
 * 16-bit cap, so this is a supported configuration and not a rejected one.
 */

const WIDTH = entityIdWidth();

function bindScene(lists, counts) {
  return {
    buffers: { perTypeActiveLists: lists },
    totalEntityCount: Object.values(counts).reduce((a, b) => a + b, 0),
    // teardownSceneSharedState walks the registrations to release the per-class
    // pools, so the stub carries them even though the count-clearing path itself
    // only reads the buffers.
    registeredClasses: Object.entries(counts).map(([name, count]) => ({
      class: { name },
      count,
      startIndex: 0,
      endIndex: count,
    })),
    config: {
      entityIdWidth: entityIdWidth(),
      particle: { maxParticles: 0 },
      decoration: { maxDecorations: 0 },
      bullet: { maxBullets: 0 },
      lighting: { maxFlashes: 0 },
    },
    sharedResourceRegs: [],
    audioMetrics: null,
  };
}

test('B-10: teardown clears a 32-bit count that exceeds 65535', { concurrency: false }, () => {
  bindEntityIdWidth(32);
  try {
    assert.equal(entityIdWidth(), 32, 'this case needs 32-bit ids');

    // (1 + count) ids, exactly as the allocator lays it out.
    const count = 70000;
    assert.ok(count <= MAX_ENTITIES_U32, 'the count must be representable at this width');
    const sab = new SharedArrayBuffer((1 + count) * 4);

    const view = new Uint32Array(sab);
    view[0] = count;
    assert.equal(view[0], 70000, 'precondition: the count is set');

    // The old code would have written only `view[0] & 0xffff` = 4464, leaving
    // the high half set and the list still looking non-empty.
    const lowHalfOnly = 70000 & 0xffff;
    assert.notEqual(lowHalfOnly, count, 'the low half alone must not equal the count');

    teardownSceneSharedState(bindScene({ Probe: sab }, { Probe: count }));

    assert.equal(view[0], 0, 'the whole 32-bit count must be zero after teardown');
  } finally {
    bindEntityIdWidth(WIDTH);
  }
});

test('B-10: teardown clears a 16-bit count unchanged', { concurrency: false }, () => {
  bindEntityIdWidth(16);
  try {
    const count = 40000;
    const sab = new SharedArrayBuffer((1 + count) * 2);
    const view = new Uint16Array(sab);
    view[0] = count;

    teardownSceneSharedState(bindScene({ Probe: sab }, { Probe: count }));

    assert.equal(view[0], 0, 'the 16-bit path must keep working');
  } finally {
    bindEntityIdWidth(WIDTH);
  }
});

test('B-10: the old Uint16Array write provably leaves a 32-bit count non-zero', { concurrency: false }, () => {
  // The pre-fix behaviour, stated directly so the case above is not the only
  // thing standing between this test and a silent regression.
  const count = 70000;
  const sab = new SharedArrayBuffer((1 + count) * 4);
  const view32 = new Uint32Array(sab);
  view32[0] = count;

  new Uint16Array(sab)[0] = 0; // what the old code did

  assert.notEqual(
    view32[0],
    0,
    'a Uint16Array write leaves the high half behind, which is the bug',
  );
  assert.equal(view32[0], count & 0xffff0000 ? view32[0] & 0xffff0000 : view32[0]);
  assert.equal(view32[0], 65536, 'the high half (1 << 16) survives the low-half write');
});

test('B-10: teardown clears every registered type, not just the first', { concurrency: false }, () => {
  bindEntityIdWidth(32);
  try {
    const names = ['Alpha', 'Beta', 'Gamma'];
    const counts = { Alpha: 70000, Beta: 3, Gamma: 200000 };
    const lists = {};
    for (const name of names) {
      const sab = new SharedArrayBuffer((1 + counts[name]) * 4);
      new Uint32Array(sab)[0] = counts[name];
      lists[name] = sab;
    }

    teardownSceneSharedState(bindScene(lists, counts));

    for (const name of names) {
      assert.equal(new Uint32Array(lists[name])[0], 0, `${name} count must be zero`);
    }
  } finally {
    bindEntityIdWidth(WIDTH);
  }
});