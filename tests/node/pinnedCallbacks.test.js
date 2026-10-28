import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { Messages } from '../../src/core/messages.js';
import { drainMessages } from '../../src/util/messageRing.js';
import {
  createContactRingSab,
  bindContactRing,
  publishContactEvent,
  initialContactCursor,
  BOX2D_CONTACT_KIND,
} from '../../src/box2d/box2dContactRing.js';

// A class pinned to a logic worker (forceProcessOnLogicWorker) runs its tick
// there, so a SharedResource it writes has one writer. Its collision callbacks
// ran on worker min(a, b) % workers and its messages on index % workers, so a
// second worker wrote too. Now they follow the pin; unpinned entities as before.

const N = 8;
Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);

/** Entity 5 pinned to logic1; the rest not pinned. */
function pinFive() {
  const pins = new Int16Array(N).fill(-1);
  pins[5] = 1;
  GameObject.forceProcessOnLogicWorker = pins;
  return pins;
}

test('a message to a pinned entity goes to its worker\'s inbox', () => {
  Messages.bind(Messages.createBuffers(2, 16, N), ['hit']);
  Messages.pins = pinFive();
  try {
    Messages.send(5, 'hit', -1, 1); // 5 % 2 is logic1 anyway; pin it elsewhere below
    Messages.pins[5] = 0;
    Messages.send(5, 'hit', -1, 2);
    Messages.send(3, 'hit', -1, 3); // not pinned: 3 % 2 = logic1
    const got = [0, 1].map((w) => {
      const out = [];
      drainMessages(Messages.inboxI32[w], Messages.inboxF64[w], (target, from, id, gen, a) => out.push(`${target}:${a}`));
      return out;
    });
    assert.deepEqual(got, [['5:2'], ['5:1', '3:3']]);
  } finally {
    Messages.unbind();
    Messages.pins = null;
  }
});

test('collision callbacks run each entity on its pinned worker; an unpinned pair stays on min % workers', async () => {
  const w = await loadWorker('logicWorker.js', 'logicWorker');
  pinFive();
  Transform.active.fill(1);
  Transform.entityType.fill(0);
  const log = [];
  class Body {
    constructor(index) {
      this.index = index;
    }
    onCollisionEnter(o) { log.push(`${this.index}>enter ${o}`); }
    onCollisionStay(o) { log.push(`${this.index}>stay ${o}`); }
    onCollisionExit(o) { log.push(`${this.index}>exit ${o}`); }
    onCollisionHit(o) { log.push(`${this.index}>hit ${o}`); }
  }
  w.gameObjects = Array.from({ length: N }, (_, i) => new Body(i));
  w.collisionListenerByType = Uint8Array.of(1);
  w.collisionStayByType = Uint8Array.of(1); // the class defines onCollisionStay
  w.totalLogicWorkers = 2;
  w.bodyGeneration = null;
  w.useBox2dContacts = true;

  const frames = (workerIndex) => {
    w.workerIndex = workerIndex;
    w._clearContactState(null);
    const sab = createContactRingSab(64);
    bindContactRing(sab);
    w.box2dContactRingI32 = new Int32Array(sab);
    w.box2dContactCursor = initialContactCursor(w.box2dContactRingI32);
    log.length = 0;
    const K = BOX2D_CONTACT_KIND;
    publishContactEvent(K.CONTACT_BEGIN, 5, 2, 0, 0); // 2 unpinned (2 % 2 = logic0), 5 pinned to logic1
    publishContactEvent(K.CONTACT_BEGIN, 4, 2, 0, 0); // unpinned pair: logic0 runs both
    w._processBox2dCollisionCallbacks();
    w._processBox2dCollisionCallbacks(); // a frame of stay
    publishContactEvent(K.CONTACT_END, 5, 2, 0, 0);
    w._processBox2dCollisionCallbacks();
    w._onHitRingEvent(2, 5, 0, 0, 0, 0, 1, 0, 100);
    return log.slice();
  };

  assert.deepEqual(frames(0), [
    '2>enter 5',
    '4>enter 2', '2>enter 4', // enter follows the event's order (4, 2)
    '2>stay 5',
    '2>stay 4', '4>stay 2',
    '2>exit 5',
    '2>stay 4', '4>stay 2',
    '2>hit 5',
  ]);
  assert.deepEqual(frames(1), ['5>enter 2', '5>stay 2', '5>exit 2', '5>hit 2']);
  bindContactRing(null);
  GameObject.forceProcessOnLogicWorker = null;
});
