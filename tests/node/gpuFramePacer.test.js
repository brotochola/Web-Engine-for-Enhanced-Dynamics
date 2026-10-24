import test from 'node:test';
import assert from 'node:assert/strict';

import { GpuFramePacer } from '../../src/render/gpuFramePacer.js';

// E-97. Pixi submits a frame only when the GPU has finished the frame before last.
// Fake WebGL2 contexts whose fences, and WebGPU devices whose queues, the test completes by hand.

function fakeGl() {
  return {
    SYNC_STATUS: 0x9114,
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    lost: false,
    fences: [],
    deleted: 0,
    fenceSync(condition, flags) {
      assert.equal(condition, 0x9117);
      assert.equal(flags, 0);
      if (this.lost) return null;
      const f = { done: false };
      this.fences.push(f);
      return f;
    },
    getSyncParameter(f, pname) {
      assert.equal(pname, 0x9114);
      if (this.lost) return null;
      return f.done ? 0x9119 : 0x9118;
    },
    deleteSync() {
      this.deleted++;
    },
  };
}

/** One display tick: draws unless the pacer says the GPU is busy. Returns whether it drew. */
function tick(pacer) {
  if (pacer.busy()) return false;
  pacer.submitted();
  return true;
}

function glPacer(gl) {
  const pacer = new GpuFramePacer();
  pacer.bindGl(gl);
  return pacer;
}

test('a GPU that keeps up is never waited on', () => {
  const gl = fakeGl();
  const pacer = glPacer(gl);
  for (let i = 0; i < 10; i++) {
    assert.equal(tick(pacer), true);
    gl.fences[i].done = true; // finished within the vsync
  }
  assert.equal(pacer.skipped, 0);
  assert.equal(gl.deleted, 8, 'every fence read two frames later is freed');
});

test('two frames in flight: the third waits for the first, not the second', () => {
  const gl = fakeGl();
  const pacer = glPacer(gl);
  assert.equal(tick(pacer), true); // frame 0
  assert.equal(tick(pacer), true); // frame 1, frame 0 still on the GPU
  assert.equal(tick(pacer), false, 'frame 0 unfinished: nothing submitted');
  assert.equal(tick(pacer), false);
  gl.fences[0].done = true;
  assert.equal(tick(pacer), true, 'frame 2 goes once frame 0 is done, with frame 1 still running');
  assert.equal(gl.fences.length, 3);
  assert.equal(pacer.skipped, 2);
  assert.equal(tick(pacer), false, 'frame 3 waits for frame 1');
  gl.fences[1].done = true;
  assert.equal(tick(pacer), true);
});

test('a lost context is not a reason to wait', () => {
  const gl = fakeGl();
  const pacer = glPacer(gl);
  tick(pacer);
  tick(pacer);
  gl.lost = true; // getSyncParameter answers null, fenceSync null
  for (let i = 0; i < 5; i++) assert.equal(tick(pacer), true);
});

test('a fence that never signals stops the waiting after eight ticks', () => {
  const gl = fakeGl();
  const pacer = glPacer(gl);
  tick(pacer);
  tick(pacer);
  let skipped = 0;
  while (!tick(pacer)) skipped++;
  assert.equal(skipped, 8);
});

test('reset forgets the fences of a context that is gone', () => {
  const gl = fakeGl();
  const pacer = glPacer(gl);
  tick(pacer);
  tick(pacer);
  assert.equal(pacer.busy(), true);
  pacer.reset();
  assert.equal(pacer.busy(), false);
  assert.equal(pacer.busy(), false);
});

// E-97b. A WebGPU queue: each onSubmittedWorkDone() resolves when the test says, in order.
function fakeDevice() {
  const resolvers = [];
  return {
    resolvers,
    queue: {
      onSubmittedWorkDone() {
        return new Promise((resolve) => resolvers.push(resolve));
      },
    },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

test('WebGPU: two frames in flight, the third waits for the first', async () => {
  const device = fakeDevice();
  const pacer = new GpuFramePacer();
  pacer.bindDevice(device);
  assert.equal(pacer.enabled, true);
  assert.equal(tick(pacer), true);
  assert.equal(tick(pacer), true);
  assert.equal(tick(pacer), false, 'frame 0 unfinished');
  device.resolvers[0]();
  await settle();
  assert.equal(tick(pacer), true, 'frame 2 goes once frame 0 is done');
  assert.equal(tick(pacer), false, 'frame 3 waits for frame 1');
  device.resolvers[1]();
  device.resolvers[2]();
  await settle();
  assert.equal(tick(pacer), true);
  assert.equal(pacer.skipped, 2);
});

test('WebGPU: a queue that never reports stops the waiting after eight ticks', () => {
  const pacer = new GpuFramePacer();
  pacer.bindDevice(fakeDevice());
  tick(pacer);
  tick(pacer);
  let skipped = 0;
  while (!tick(pacer)) skipped++;
  assert.equal(skipped, 8);
});

test('WebGPU: completions from before a reset do not loosen the pacing', async () => {
  const device = fakeDevice();
  const pacer = new GpuFramePacer();
  pacer.bindDevice(device);
  tick(pacer);
  tick(pacer);
  pacer.reset();
  device.resolvers[0]();
  device.resolvers[1]();
  await settle();
  assert.equal(tick(pacer), true);
  assert.equal(tick(pacer), true);
  assert.equal(tick(pacer), false, 'the two new frames are both still in flight');
});

test('nothing to pace: no fenceSync, no device', () => {
  const pacer = new GpuFramePacer();
  assert.equal(pacer.enabled, false);
  pacer.bindGl({});
  assert.equal(pacer.enabled, false);
  pacer.bindDevice(undefined);
  assert.equal(pacer.enabled, false);
  assert.equal(tick(pacer), true);
});
