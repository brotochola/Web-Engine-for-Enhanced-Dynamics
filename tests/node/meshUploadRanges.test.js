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

for (const [name, Batch] of [['fill', ColliderFillBatch], ['UV', MeshUvFillBatch]]) {
  test(`a MESH layer's ${name} batch sends each range as it writes it`, () => {
    const sent = [];
    const bufferSystem = {
      updateBuffer(buffer) {
        sent.push([buffer._updateOffset, buffer._updateSize]);
      },
    };
    const batch = new Batch({ capacity: ROWS, useWebGpu: true, shaders, bufferSystem });
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

  test(`an empty ${name} upload sends nothing, and a batch with no renderer still works`, () => {
    const sent = [];
    const batch = new Batch({ capacity: ROWS, useWebGpu: true, shaders, bufferSystem: { updateBuffer: (b) => sent.push(b) } });
    batch.upload(0);
    assert.deepEqual(sent, []);
    assert.equal(new Batch({ capacity: ROWS, useWebGpu: true, shaders }).upload(ROWS), ROWS);
  });
}
