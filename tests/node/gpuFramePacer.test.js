import test from 'node:test';
import assert from 'node:assert/strict';

import { GpuFramePacer } from '../../src/render/gpuFramePacer.js';

// E-97. Pixi submits a frame only when the GPU has finished the frame before last.
// A fake WebGL2 context whose fences the test signals by hand.

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
function tick(pacer, gl) {
  if (pacer.busy(gl)) return false;
  pacer.submitted(gl);
  return true;
}

test('a GPU that keeps up is never waited on', () => {
  const gl = fakeGl();
  const pacer = new GpuFramePacer();
  for (let i = 0; i < 10; i++) {
    assert.equal(tick(pacer, gl), true);
    gl.fences[i].done = true; // finished within the vsync
  }
  assert.equal(pacer.skipped, 0);
  assert.equal(gl.deleted, 8, 'every fence read two frames later is freed');
});

test('two frames in flight: the third waits for the first, not the second', () => {
  const gl = fakeGl();
  const pacer = new GpuFramePacer();
  assert.equal(tick(pacer, gl), true); // frame 0
  assert.equal(tick(pacer, gl), true); // frame 1, frame 0 still on the GPU
  assert.equal(tick(pacer, gl), false, 'frame 0 unfinished: nothing submitted');
  assert.equal(tick(pacer, gl), false);
  gl.fences[0].done = true;
  assert.equal(tick(pacer, gl), true, 'frame 2 goes once frame 0 is done, with frame 1 still running');
  assert.equal(gl.fences.length, 3);
  assert.equal(pacer.skipped, 2);
  assert.equal(tick(pacer, gl), false, 'frame 3 waits for frame 1');
  gl.fences[1].done = true;
  assert.equal(tick(pacer, gl), true);
});

test('a lost context is not a reason to wait', () => {
  const gl = fakeGl();
  const pacer = new GpuFramePacer();
  tick(pacer, gl);
  tick(pacer, gl);
  gl.lost = true; // getSyncParameter answers null, fenceSync null
  for (let i = 0; i < 5; i++) assert.equal(tick(pacer, gl), true);
});

test('a fence that never signals stops the waiting after eight ticks', () => {
  const gl = fakeGl();
  const pacer = new GpuFramePacer();
  tick(pacer, gl);
  tick(pacer, gl);
  let skipped = 0;
  while (!tick(pacer, gl)) skipped++;
  assert.equal(skipped, 8);
});

test('reset forgets the fences of a context that is gone', () => {
  const gl = fakeGl();
  const pacer = new GpuFramePacer();
  tick(pacer, gl);
  tick(pacer, gl);
  assert.equal(pacer.busy(gl), true);
  pacer.reset();
  assert.equal(pacer.busy(gl), false);
  assert.equal(pacer.busy(gl), false);
});
