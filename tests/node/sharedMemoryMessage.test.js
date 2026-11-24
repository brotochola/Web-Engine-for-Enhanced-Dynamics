// N-451: in WebKit a worker gets a shared WebAssembly.Memory and its buffer as two objects, and a memory named twice as
// two memories. A packed message carries each memory once and references in place of the rest. The clone that splits is
// played here by hand: a real clone, then every memory and every buffer replaced by another object.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel, Worker } from 'node:worker_threads';

import { cloneSplitsMemories, packSharedMemories, unpackSharedMemories } from '../../src/util/sharedMemoryMessage.js';
import { postWorkerInitMessage } from '../../src/util/utils.js';

const memoryOf = (pages = 1) => new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });

function initMessage() {
  const queue = memoryOf(2);
  const particles = memoryOf(1);
  const plain = new SharedArrayBuffer(64);
  return {
    queue,
    particles,
    plain,
    message: {
      msg: 'init',
      config: { worldWidth: 4000, layers: ['a', 'b'], nothing: null, missing: undefined },
      renderQueueMemory: queue,
      particleMemory: particles,
      // The same memory twice, as the scene's engine block is for three systems.
      spatialPublishMemory: queue,
      layout: { xByte: 64 },
      buffers: {
        componentData: { Transform: queue.buffer, ParticleComponent: particles.buffer },
        list: [queue.buffer, plain, 7],
        stats: plain,
      },
      view: new Float32Array(queue.buffer, 128, 16),
      words: new DataView(particles.buffer, 32, 8),
      plainView: new Int32Array(plain, 4, 2),
      meshGeom: { memory: particles, data: particles.buffer },
    },
  };
}

test('a packed message names each memory once and holds no other mention of it', () => {
  const { message, queue, particles, plain } = initMessage();
  const packed = packSharedMemories(message);
  assert.deepEqual(packed.sharedMemories, [queue, particles]);
  const seen = [];
  const look = (value) => {
    if (value === null || typeof value !== 'object') return;
    if (value instanceof WebAssembly.Memory || value instanceof SharedArrayBuffer) seen.push(value);
    else if (ArrayBuffer.isView(value)) seen.push(value.buffer);
    else Object.values(value).forEach(look);
  };
  const { sharedMemories, ...rest } = packed;
  assert.equal(sharedMemories.length, 2);
  look(rest);
  assert.ok(seen.every((b) => b === plain), 'only the buffer of no memory is left as it was');
  // The sender's own message is untouched.
  assert.equal(message.buffers.componentData.Transform, queue.buffer);
  assert.equal(message.sharedMemories, undefined);
  assert.equal(packed.config, message.config, 'what holds no memory is not copied');
});

test('unpacked, every buffer and view is of the one memory object its field names', async () => {
  const { message, plain } = initMessage();
  const { port1, port2 } = new MessageChannel();
  const got = await new Promise((resolve) => {
    port2.once('message', resolve);
    port1.postMessage(packSharedMemories(message));
  });
  port1.close();
  // As WebKit hands it over: the memories are objects of their own, whatever else the message holds.
  const data = unpackSharedMemories(got);
  assert.equal(data.sharedMemories, undefined);
  assert.ok(data.renderQueueMemory instanceof WebAssembly.Memory);
  assert.equal(data.spatialPublishMemory, data.renderQueueMemory);
  assert.notEqual(data.particleMemory, data.renderQueueMemory);
  assert.equal(data.meshGeom.memory, data.particleMemory);
  assert.equal(data.buffers.componentData.Transform, data.renderQueueMemory.buffer);
  assert.equal(data.buffers.list[0], data.renderQueueMemory.buffer);
  assert.equal(data.buffers.componentData.ParticleComponent, data.particleMemory.buffer);
  assert.equal(data.meshGeom.data, data.particleMemory.buffer);
  assert.equal(data.view.buffer, data.renderQueueMemory.buffer);
  assert.ok(data.view instanceof Float32Array);
  assert.deepEqual([data.view.byteOffset, data.view.length], [128, 16]);
  assert.ok(data.words instanceof DataView);
  assert.deepEqual([data.words.buffer, data.words.byteOffset, data.words.byteLength], [data.particleMemory.buffer, 32, 8]);
  assert.equal(data.plainView.buffer, data.buffers.stats);
  assert.equal(data.buffers.list[1], data.buffers.stats);
  assert.deepEqual(data.config, message.config);
  // The same memory as the sender's.
  new Float32Array(message.renderQueueMemory.buffer, 128, 1)[0] = 2.5;
  assert.equal(data.view[0], 2.5);
  new Int32Array(plain)[1] = 9;
  assert.equal(data.plainView[0], 9);
});

test('a message without memories, and one that was not packed, pass as they are', () => {
  const message = { msg: 'init', buffers: { a: new SharedArrayBuffer(8) }, config: { x: 1 } };
  assert.equal(packSharedMemories(message), message);
  assert.equal(unpackSharedMemories(message), message);
  assert.equal(unpackSharedMemories(undefined), undefined);
  const { message: whole, queue } = initMessage();
  assert.equal(unpackSharedMemories(whole).buffers.componentData.Transform, queue.buffer);
});

test('a message that names itself is packed and unpacked', () => {
  const memory = memoryOf();
  const message = { memory, buffer: memory.buffer };
  message.self = message;
  const data = unpackSharedMemories(packSharedMemories(message));
  assert.equal(data.buffer, data.memory.buffer);
  assert.equal(data.self.buffer, memory.buffer);
});

test('this V8 keeps a memory and its buffer one object, so nothing is packed here', async () => {
  assert.equal(cloneSplitsMemories(), false);
  const worker = new Worker(
    `const { parentPort } = require('node:worker_threads');
    parentPort.once('message', (d) => parentPort.postMessage({ same: d.renderQueueMemory.buffer === d.buffers.x, packed: 'sharedMemories' in d }));`,
    { eval: true },
  );
  const memory = memoryOf();
  const got = new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  postWorkerInitMessage(worker, { renderQueueMemory: memory, buffers: { x: memory.buffer } });
  assert.deepEqual(await got, { same: true, packed: false });
  await worker.terminate();
});
