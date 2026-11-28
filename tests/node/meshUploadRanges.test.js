// WebGL's buffer system holds one pending range and sends it when the mesh binds. A layer that skips a draw, a hidden one
// or a sunProjected one at night, would lose every range but the last, so each goes out when it is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ColliderFillBatch } from '../../src/render/colliderFillBatch.js';
import { MeshUvFillBatch } from '../../src/render/meshUvFillBatch.js';
import { readEngineShader } from './engineShaderSources.mjs';

const wgsl = (name) => readEngineShader(`${name}.wgsl`);
const shaders = { colliderFill: wgsl('colliderFill'), meshUvFill: wgsl('meshUvFill') };
const glsl = {
  colliderFillVert: readEngineShader('colliderFill.vert.glsl'),
  colliderFillFrag: readEngineShader('colliderFill.frag.glsl'),
  meshUvFillVert: readEngineShader('meshUvFill.vert.glsl'),
  meshUvFillFrag: readEngineShader('meshUvFill.frag.glsl'),
};
// GlProgram.from probes shader precision on a canvas; Node has none, and a context of null is enough.
globalThis.document ??= { createElement: () => ({ getContext: () => null }) };
const ROWS = 8;

test("a MESH layer's fill batch sends each range as it writes it", () => {
  const sent = [];
  const bufferSystem = {
    updateBuffer(buffer) {
      sent.push([buffer._updateOffset, buffer._updateSize]);
    },
  };
  const batch = new ColliderFillBatch({ capacity: ROWS, useWebGpu: true, shaders, bufferSystem });
  const stride = batch.data.byteLength / ROWS;

  batch.upload(ROWS);
  batch.uploadRange(1, 2);
  batch.uploadRange(6, 8);
  assert.deepEqual(sent, [
    [0, ROWS * stride],
    [stride, stride],
    [6 * stride, 2 * stride],
  ]);
});

test('an empty fill upload sends nothing, and a batch with no renderer still works', () => {
  const sent = [];
  const batch = new ColliderFillBatch({ capacity: ROWS, useWebGpu: true, shaders, bufferSystem: { updateBuffer: (b) => sent.push(b) } });
  batch.upload(0);
  assert.deepEqual(sent, []);
  assert.equal(new ColliderFillBatch({ capacity: ROWS, useWebGpu: true, shaders }).upload(ROWS), ROWS);
});

// E-453: the UV batch draws vertex records through an index buffer: both go out as they are written.
test("a MESH layer's UV batch sends its records and indices, and each range, as it writes them", () => {
  const sent = [];
  let batch = null;
  const bufferSystem = {
    updateBuffer(buffer) {
      sent.push([buffer === batch.indexBuffer ? 'indices' : 'records', buffer._updateOffset, buffer._updateSize]);
    },
  };
  batch = new MeshUvFillBatch({ capacity: ROWS, indexCapacity: 12, useWebGpu: true, shaders, bufferSystem });
  const stride = batch.data.byteLength / ROWS;
  batch.indices.set([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);

  assert.equal(batch.upload(ROWS, 12), 12);
  batch.uploadRange(1, 2);
  batch.uploadRange(6, 8);
  batch.uploadIndexRange(3, 6);
  assert.deepEqual(sent, [
    ['records', 0, ROWS * stride],
    ['indices', 0, 12 * 4],
    ['records', stride, stride],
    ['records', 6 * stride, 2 * stride],
    ['indices', 3 * 4, 3 * 4],
  ]);
});

test('an empty UV upload sends nothing, and a batch with no renderer still works', () => {
  const sent = [];
  const batch = new MeshUvFillBatch({ capacity: ROWS, useWebGpu: true, shaders, bufferSystem: { updateBuffer: (b) => sent.push(b) } });
  batch.upload(0, 0);
  assert.deepEqual(sent, []);
  const alone = new MeshUvFillBatch({ capacity: ROWS, useWebGpu: true, shaders });
  alone.indices.set([0, 1, 2, 0, 2, 3]);
  assert.equal(alone.upload(ROWS, 6), 6);
});

// E-477: ANGLE copies a STATIC buffer whole when it changed, so on WebGL the vertex buffer is as long as what is drawn,
// not the batch's capacity (the renderer's whole mesh budget): a view of the batch's array, grown by half again and never
// shrunk. WebGPU writes only the range sent, and keeps the whole array.
const CAP = 100;

function fitTrace(batch, uploads) {
  const lengths = [];
  for (const n of uploads) {
    if (batch instanceof MeshUvFillBatch) batch.upload(n, 3);
    else batch.upload(n);
    lengths.push(batch.buffer.data.length / (batch.data.length / CAP));
  }
  return lengths;
}

test("on WebGL a fill batch's vertex buffer holds the rows drawn, grown by half again, never shrunk", () => {
  const sent = [];
  const bufferSystem = { updateBuffer: (b) => sent.push([b.data.length, b._updateOffset, b._updateSize]) };
  const gl = new ColliderFillBatch({ capacity: CAP, useWebGpu: false, shaders: glsl, bufferSystem });
  assert.deepEqual(fitTrace(gl, [10, 11, 4, 90, 95]), [10, 15, 15, 90, CAP]);
  assert.equal(gl.buffer.data, gl.data);
  const floats = gl.data.length / CAP;
  gl.uploadRange(3, 5);
  assert.deepEqual(sent.at(-1), [CAP * floats, 3 * floats * 4, 2 * floats * 4]);

  const gpu = new ColliderFillBatch({ capacity: CAP, useWebGpu: true, shaders });
  assert.deepEqual(fitTrace(gpu, [10, 11]), [CAP, CAP]);
});

test("on WebGL a UV batch's vertex buffer holds the records drawn; its index buffer the indices drawn", () => {
  const gl = new MeshUvFillBatch({ capacity: CAP, indexCapacity: 30, useWebGpu: false, shaders: glsl });
  assert.deepEqual(fitTrace(gl, [6, 7, 2, CAP]), [6, 9, 9, CAP]);
  assert.equal(gl.indexBuffer.data.length, 3);

  const gpu = new MeshUvFillBatch({ capacity: CAP, indexCapacity: 30, useWebGpu: true, shaders });
  assert.deepEqual(fitTrace(gpu, [6, 7]), [CAP, CAP]);
});
