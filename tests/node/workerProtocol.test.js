import test from 'node:test';
import assert from 'node:assert/strict';

import { AbstractWorker } from '../../src/workers/AbstractWorker.js';

test('sendDataToWorker returns success status and posts when port exists', { concurrency: false }, () => {
  const postedMessages = [];
  const previousWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(' '));

  try {
    const workerContext = {
      workerPorts: new Map([
        ['logic0', { postMessage: (data) => postedMessages.push(data) }],
      ]),
      constructor: { name: 'FakeWorker' },
    };

    const sent = AbstractWorker.prototype.sendDataToWorker.call(workerContext, 'logic0', {
      msg: 'listUpdates',
    });
    const missing = AbstractWorker.prototype.sendDataToWorker.call(workerContext, 'renderer', {
      msg: 'noop',
    });

    assert.equal(sent, true);
    assert.equal(missing, false);
    assert.deepEqual(postedMessages, [{ msg: 'listUpdates' }]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /No port to worker "renderer"/);
  } finally {
    console.warn = previousWarn;
  }
});

test('logic worker keeps pending list updates when forwarding to logic0 fails', { concurrency: false }, async () => {
  const previousSelf = globalThis.self;
  const previousWarn = console.warn;
  const warnings = [];

  globalThis.self = {
    postMessage() {},
    onmessage: null,
  };
  console.warn = (...args) => warnings.push(args.map(String).join(' '));

  try {
    const logicWorkerUrl = new URL('../../src/workers/logic_worker.js', import.meta.url);
    logicWorkerUrl.searchParams.set('workerProtocolTest', `${Date.now()}-${Math.random()}`);
    await import(logicWorkerUrl.href);

    const worker = globalThis.self.logicWorker;
    class SpawnEntity {}
    class DespawnEntity {}

    worker.pendingSpawnListUpdates.length = 0;
    worker.pendingDespawnListUpdates.length = 0;
    worker._spawnSerializedBuffer.length = 0;
    worker._despawnSerializedBuffer.length = 0;
    worker.workerPorts = new Map();

    worker.pendingSpawnListUpdates.push({
      entityIndex: 11,
      entityType: 2,
      EntityClass: SpawnEntity,
    });
    worker.pendingDespawnListUpdates.push({
      entityIndex: 17,
      entityType: 4,
      EntityClass: DespawnEntity,
    });

    const sent = worker.sendListUpdatesToLogic0();

    assert.equal(sent, false);
    assert.deepEqual(worker.pendingSpawnListUpdates, [
      {
        entityIndex: 11,
        entityType: 2,
        EntityClass: SpawnEntity,
      },
    ]);
    assert.deepEqual(worker.pendingDespawnListUpdates, [
      {
        entityIndex: 17,
        entityType: 4,
        EntityClass: DespawnEntity,
      },
    ]);
    assert.deepEqual(worker._spawnSerializedBuffer, [
      {
        entityIndex: 11,
        entityType: 2,
        className: 'SpawnEntity',
      },
    ]);
    assert.deepEqual(worker._despawnSerializedBuffer, [
      {
        entityIndex: 17,
        entityType: 4,
        className: 'DespawnEntity',
      },
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /No port to worker "logic0"/);
  } finally {
    console.warn = previousWarn;
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  }
});

test('initSeededRandom keeps the typo alias working', { concurrency: false }, () => {
  const previousSelf = globalThis.self;
  const previousRng = globalThis.rng;

  try {
    globalThis.self = {};

    const workerContext = {};
    AbstractWorker.prototype.initSeededRandom.call(workerContext, 12345);
    const first = globalThis.rng();

    AbstractWorker.prototype.initSeendedRandom.call(workerContext, 12345);
    const second = globalThis.rng();

    assert.equal(typeof globalThis.self.rng, 'function');
    assert.equal(typeof globalThis.rng, 'function');
    assert.equal(first, second);
  } finally {
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;

    if (previousRng === undefined) delete globalThis.rng;
    else globalThis.rng = previousRng;
  }
});
