import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getPortTransferables,
  postWorkerInitMessage,
  setupWorkerCommunication,
} from '../../src/core/utils.js';

test('setupWorkerCommunication wires bidirectional ports per connection', () => {
  const ports = setupWorkerCommunication([
    { from: 'logic0', to: 'renderer' },
    { from: 'logic1', to: 'logic0' },
  ]);

  assert.ok(ports.logic0.renderer);
  assert.ok(ports.renderer.logic0);
  assert.ok(ports.logic1.logic0);
  assert.ok(ports.logic0.logic1);
  assert.notStrictEqual(ports.logic0.renderer, ports.renderer.logic0);
  assert.notStrictEqual(ports.logic1.logic0, ports.logic0.logic1);
});

test('getPortTransferables returns ports or an empty array', () => {
  const ports = setupWorkerCommunication([{ from: 'logic0', to: 'renderer' }]);

  assert.deepEqual(getPortTransferables(null), []);
  assert.deepEqual(getPortTransferables(undefined), []);
  assert.deepEqual(getPortTransferables(ports.logic0), [ports.logic0.renderer]);
});

test('postWorkerInitMessage merges base and extra init payloads', () => {
  const calls = [];
  const worker = {
    postMessage(message, transferables) {
      calls.push({ message, transferables });
    },
  };
  const transferables = [{ id: 'portA' }];

  postWorkerInitMessage(
    worker,
    {
      shared: true,
      frameRateIndex: 1,
      nested: { keep: 'base' },
    },
    {
      frameRateIndex: 7,
      workerIndex: 2,
    },
    transferables
  );

  assert.deepEqual(calls, [
    {
      message: {
        shared: true,
        frameRateIndex: 7,
        nested: { keep: 'base' },
        workerIndex: 2,
      },
      transferables,
    },
  ]);
});
