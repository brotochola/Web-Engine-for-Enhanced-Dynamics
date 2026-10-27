// A world the editor holds (VISUAL_EDITOR_PLAN.md ED-71): Time.held, a second slot of the shared clock, set by edit
// mode beside a scale of 0. The logic worker then runs no entity ticks (at dt 0 they only redo their last frame:
// littleCity's 8,000 people cost 3.6 ms a frame), while spawns, list updates and messages go on, as the editor's
// respawns need them. A game's own pause (a scale of 0 alone) still ticks.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { Time, TIME_HELD_INDEX } from '../../src/core/timeScale.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';

test('Time.held: the clock’s second slot; a clock with one slot is never held', () => {
  Time.bind(new SharedArrayBuffer(8));
  try {
    assert.equal(Time.held, false);
    Time.held = true;
    assert.equal(Time.held, true);
    assert.equal(Time.view[TIME_HELD_INDEX], 1);
    Time.scale = 0.5;
    assert.equal(Time.held, true, 'the scale is its own slot');
    Time.held = false;
    assert.equal(Time.held, false);
    Time.bind(new SharedArrayBuffer(4));
    Time.held = true;
    assert.equal(Time.held, false, 'an old one-slot clock: no hold, no write past it');
  } finally {
    Time.unbind();
  }
});

test('held, the logic worker ticks no entity but takes its spawns and list updates; released, it ticks again', async () => {
  const N = 4;
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  const w = await loadWorker('logicWorker.js', 'logicWorker');
  const ticked = [];
  const tickedAll = [];
  class Walker {
    constructor(index) {
      this.index = index;
    }
    tick() {
      ticked.push(this.index);
    }
  }
  class Flock {
    static tickAll(indices, n) {
      tickedAll.push(n);
    }
  }
  w.gameObjects = [new Walker(0), new Walker(1), new Walker(2)];
  for (let i = 0; i < 3; i++) Transform.active[i] = 1;
  w.nonDecimatedTypes = [{ activeList: new Uint16Array([3, 0, 1, 2]), needsScreenCallbacks: false, entityType: 0 }];
  w.decimatedTypes = [];
  w.tickAllTypes = [{ EntityClass: Flock, activeList: new Uint16Array([1, 3]), entityType: 1 }];
  w.totalLogicWorkers = 1;
  w.workerIndex = 0;
  const frame = [];
  w._drainSpawnCommandRing = () => frame.push('spawns');
  w.processListUpdates = () => frame.push('lists');
  w._latchDisplayPose = () => {};
  w.sendListUpdatesToLogic0 = () => {};
  w._runTickAllTypes = function () {
    Flock.tickAll(null, 1);
    return 1;
  };
  Time.bind(new SharedArrayBuffer(8));
  try {
    w.update(16.67, 1, false);
    assert.deepEqual([ticked, tickedAll, w.activeEntityCount], [[0, 1, 2], [1], 4]);

    Time.scale = 0;
    Time.held = true;
    ticked.length = 0;
    tickedAll.length = 0;
    frame.length = 0;
    w.update(16.67, 0, false);
    w.update(16.67, 0, false);
    assert.deepEqual(ticked, [], 'no entity ticks while held');
    assert.deepEqual(tickedAll, [], 'nor a type’s tickAll');
    assert.deepEqual(frame, ['spawns', 'lists', 'spawns', 'lists'], 'the editor’s respawns still go through');
    assert.equal(w.activeEntityCount, 4, 'the count of the last frame that ticked');

    Time.held = false;
    w.update(16.67, 0, false);
    assert.deepEqual(ticked, [0, 1, 2], 'a scale of 0 alone (a game’s pause) still ticks');
  } finally {
    Time.unbind();
  }
});
