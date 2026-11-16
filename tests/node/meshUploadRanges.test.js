// WebGL's buffer system holds one pending range and sends it when the mesh binds. A layer that skips a draw, a hidden one
// or a sunProjected one at night, would lose every range but the last, so each goes out when it is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { ColliderFillBatch } from '../../src/render/colliderFillBatch.js';
import { MeshUvFillBatch } from '../../src/render/meshUvFillBatch.js';

const wgsl = (name) => fs.readFileSync(new URL(`../../src/shaders/${name}.wgsl`, import.meta.url), 'utf8');
const shaders = { colliderFill: wgsl('colliderFill'), meshUvFill: wgsl('meshUvFill') };
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
