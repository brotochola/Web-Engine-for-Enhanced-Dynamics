// N-162: a raycasted light batch (the fans, the cone fans, the self-lit fills: _finishLightBatch) after a frame that
// drew nothing. Pixi draws the whole index buffer, so each frame zeroes what the last one used past its own end and
// uploads that range. A frame with no light hid the mesh, zeroed the tail on the CPU without uploading it, and set the
// used count to 0: the next frame uploaded only its own indices, and the GPU kept every earlier light's triangles past
// them (the owner's Headlights scene: despawn every lamp, spawn one, and all the old pools and shadows came back).
// Here the index buffer's upload copies into a GPU-side array, and that array is what the frame draws.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';

const VIS_FLOATS = 10;

/** A batch whose buffers copy what each update uploads (all of it when no size is given) into `gpu` arrays. */
function trackedBatch(idxCap) {
  const indices = new Uint32Array(idxCap);
  const gpuIndices = new Uint32Array(idxCap);
  const upload = (size) => {
    const words = size === undefined ? idxCap : size / 4;
    gpuIndices.set(indices.subarray(0, words));
  };
  return {
    data: new Float32Array(64 * VIS_FLOATS),
    cbuf: null,
    coneData: null,
    indices,
    gpuIndices,
    idxUsed: 0,
    gpuReady: true,
    vbuf: { update() {} },
    geometry: { indexBuffer: { update: upload } },
    mesh: { visible: false, parent: null },
    uniforms: { uCanvasSize: new Float32Array(2) },
  };
}

async function pixi() {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  px._stampLightCamera = () => {};
  px._visPolyContainer = { addChildAt() {}, addChild() {} };
  return px;
}

/** One frame of `count` indices, each its position plus `tag` (so frames are told apart). */
function frame(px, batch, count, tag) {
  for (let k = 0; k < count; k++) batch.indices[k] = tag + k;
  px._finishLightBatch(batch, count, count, VIS_FLOATS, true);
}

test('N-162: after a frame with no light, the next frame draws only its own triangles', async () => {
  const px = await pixi();
  const batch = trackedBatch(48);
  frame(px, batch, 24, 100); // four lights' worth
  assert.equal(batch.mesh.visible, true);
  frame(px, batch, 0, 0); // every light despawned, or out of view
  assert.equal(batch.mesh.visible, false);
  frame(px, batch, 6, 500); // one light again
  assert.equal(batch.mesh.visible, true);
  assert.deepEqual(Array.from(batch.gpuIndices.subarray(0, 6)), [500, 501, 502, 503, 504, 505]);
  assert.deepEqual(Array.from(batch.gpuIndices.subarray(6, 24)), new Array(18).fill(0), 'the earlier lights\' triangles are gone');
});

test('N-162: several empty frames in a row, then a frame that grows past the old count', async () => {
  const px = await pixi();
  const batch = trackedBatch(48);
  frame(px, batch, 18, 100);
  frame(px, batch, 0, 0);
  frame(px, batch, 0, 0);
  frame(px, batch, 30, 700);
  assert.deepEqual(Array.from(batch.gpuIndices.subarray(0, 30)), Array.from({ length: 30 }, (_, k) => 700 + k));
  frame(px, batch, 6, 900);
  assert.deepEqual(Array.from(batch.gpuIndices.subarray(6, 30)), new Array(24).fill(0));
});
