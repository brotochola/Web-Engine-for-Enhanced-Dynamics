import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { createMessageInbox, drainMessages, pushMessage } from '../../src/util/messageRing.js';
import { Messages } from '../../src/core/messages.js';
import { loadWorker, postedMessages } from '../bench/workerHarness.mjs';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';

// DX 4.1. Entities had no way to talk to each other except shared component
// fields. sendTo(other, name, a, b, c, d) → other.onMessage(name, from, …) on
// the worker that owns `other`, next frame, before its tick.

function views(sab) {
  return [new Int32Array(sab), new Float64Array(sab)];
}

test('ring: messages come out in order with their four numbers', () => {
  const [i32, f64] = views(createMessageInbox(16));
  pushMessage(i32, f64, 5, 2, 1, 7, 1.5, -2, 3e9, 0.25);
  pushMessage(i32, f64, 6, -1, 0, 0, 0, 0, 0, 0);
  const got = [];
  drainMessages(i32, f64, (...m) => got.push(m));
  assert.deepEqual(got, [
    [5, 2, 1, 7, 1.5, -2, 3e9, 0.25],
    [6, -1, 0, 0, 0, 0, 0, 0],
  ]);
  assert.equal(drainMessages(i32, f64, () => assert.fail('drained twice')), 0);
});

test('ring: a full inbox refuses; a message sent while delivering waits for the next drain', () => {
  const [i32, f64] = views(createMessageInbox(16));
  for (let k = 0; k < 16; k++) assert.equal(pushMessage(i32, f64, k, 0, 0, 0, 0, 0, 0, 0), true);
  assert.equal(pushMessage(i32, f64, 99, 0, 0, 0, 0, 0, 0, 0), false);
  let first = 0;
  drainMessages(i32, f64, () => {
    first++;
    pushMessage(i32, f64, 1, 0, 0, 0, 0, 0, 0, 0); // a reply
  });
  assert.equal(first, 16, 'only what was there when the drain began');
  let second = 0;
  drainMessages(i32, f64, () => second++);
  assert.equal(second, 16, 'the replies arrive on the next drain');
});

test('ring: three producer threads, one consumer: nothing lost, each sender in order', async () => {
  const sab = createMessageInbox(1024);
  const [i32, f64] = views(sab);
  const url = new URL('../../src/util/messageRing.js', import.meta.url).href;
  const code = `
    const { workerData, parentPort } = require('node:worker_threads');
    import(workerData.url).then((m) => {
      const i32 = new Int32Array(workerData.sab);
      const f64 = new Float64Array(workerData.sab);
      for (let k = 0; k < 2000; k++) {
        while (!m.pushMessage(i32, f64, k, workerData.id, 0, 0, k, 0, 0, 0)) {}
      }
      parentPort.postMessage('done');
    });
  `;
  const workers = [0, 1, 2].map((id) => new Worker(code, { eval: true, workerData: { sab, url, id } }));
  const lastBySender = [-1, -1, -1];
  let received = 0;
  const finished = Promise.all(workers.map((w) => new Promise((r) => w.once('message', r))));
  let done = false;
  finished.then(() => (done = true));
  const deliver = (target, from, nameId, gen, a) => {
    assert.equal(a, lastBySender[from] + 1, `sender ${from} out of order`);
    lastBySender[from] = a;
    received++;
  };
  while (!done || received < 6000) {
    drainMessages(i32, f64, deliver);
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(received, 6000);
  assert.deepEqual(lastBySender, [1999, 1999, 1999]);
});

test('Messages: names map to ids, an unknown name says how to fix it, routing is target % workers', () => {
  const buffers = Messages.createBuffers(2, 64, 8);
  Messages.bind(buffers, ['hit', 'heal']);
  try {
    assert.equal(Messages.send(5, 'heal', 1, 10), true);
    assert.throws(() => Messages.send(5, 'boom', 1), /'boom' is not declared.*static messages = \['hit', 'heal', 'boom'\]/);
    const got = [];
    drainMessages(Messages.inboxI32[1], Messages.inboxF64[1], (...m) => got.push(m));
    assert.deepEqual(got, [[5, 1, 1, 0, 10, 0, 0, 0]], 'entity 5 belongs to logic1');
    Messages.bumpGeneration(5);
    Messages.send(5, 'hit', 0);
    drainMessages(Messages.inboxI32[1], Messages.inboxF64[1], (t, f, id, gen) => assert.equal(gen, 1));
  } finally {
    Messages.unbind();
  }
});

test('Messages: without a listener in the scene, sending warns once and returns false', () => {
  Messages.unbind();
  const original = console.warn;
  const lines = [];
  console.warn = (m) => lines.push(m);
  try {
    assert.equal(Messages.send(1, 'hit', 0), false);
    assert.equal(Messages.send(1, 'hit', 0), false);
  } finally {
    console.warn = original;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /no entity type in this scene defines onMessage/);
});

test('the logic worker delivers before tick, drops a recycled target, reports a throw', async () => {
  const N = 4;
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  const w = await loadWorker('logicWorker.js', 'logicWorker');
  const log = [];
  class Box {
    constructor(index) {
      this.index = index;
    }
    onMessage(name, from, a) {
      if (name === 'boom') throw new Error('box broke');
      log.push(`${this.index}:${name}:${from}:${a}`);
    }
    tick() {
      log.push(`${this.index}:tick`);
    }
  }
  w.gameObjects = [new Box(0), new Box(1), new Box(2)];
  for (let i = 0; i < 3; i++) Transform.active[i] = 1;
  w.messageListenerByType = Uint8Array.of(1);
  w.nonDecimatedTypes = [{ activeList: Uint16Array.of(3, 0, 1, 2), needsScreenCallbacks: false, entityType: 0 }];
  w.decimatedTypes = [];
  w.tickAllTypes = [];
  w.totalLogicWorkers = 1;
  w.workerIndex = 0;
  w._latchDisplayPose = () => {};
  w._drainSpawnCommandRing = () => {};
  w.processListUpdates = () => {};
  w.sendListUpdatesToLogic0 = () => {};
  Messages.bind(Messages.createBuffers(1, 64, N), ['hit', 'boom']);
  try {
    Messages.send(1, 'hit', 0, 7);
    Messages.send(2, 'hit', 0, 8);
    Messages.bumpGeneration(2); // entity 2 despawned and came back: its message is stale
    Messages.send(0, 'boom', 1);
    const before = postedMessages().length;
    const original = console.error;
    console.error = () => {};
    try {
      w.update(16.67, 1, false);
    } finally {
      console.error = original;
    }
    assert.deepEqual(log, ['1:hit:0:7', '0:tick', '1:tick', '2:tick']);
    const errs = postedMessages().slice(before).filter((m) => m.msg === 'entityError');
    assert.equal(errs.length, 1);
    assert.equal(errs[0].phase, 'onMessage');
    assert.equal(errs[0].entityIndex, 0);
  } finally {
    Messages.unbind();
  }
});

test('emit reaches scene.on listeners with the sender', async () => {
  const { Scene } = await import('../../src/core/scene.js');
  const { SceneBridge } = await import('../../src/core/sceneBridge.js');
  await loadWorker('particleWorker.js', 'particleWorker'); // a worker-like self
  const before = postedMessages().length;
  SceneBridge.emitToScene('died', { score: 40 }, { index: 3, constructor: { name: 'Player' } });
  const posted = postedMessages().slice(before);
  assert.equal(posted.length, 1);

  const scene = Object.create(Scene.prototype);
  scene._eventListeners = new Map();
  const heard = [];
  const off = scene.on('died', (data, index, className) => heard.push([data.score, index, className]));
  scene.handleMessageFromWorker({ data: posted[0], currentTarget: { name: 'logic0' } });
  off();
  scene.handleMessageFromWorker({ data: posted[0], currentTarget: { name: 'logic0' } });
  assert.deepEqual(heard, [[40, 3, 'Player']]);
});
