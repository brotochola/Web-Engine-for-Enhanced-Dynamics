import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOverlapCircleSab,
  bindOverlapCircleSab,
  servicePendingOverlapCircle,
} from '../../src/box2d/box2dOverlapCircle.js';
import {
  createCastRayAllSab,
  bindCastRayAllSab,
  servicePendingCastRayAll,
} from '../../src/box2d/box2dCastRayAll.js';

const HDR_STATUS = 0;
const HDR_COUNT = 1;
const STATUS_DONE = 2;
const RESULTS_I32 = 12;
const RESULTS_F32 = 12;

test('overlapCircle service fills entity ids', { concurrency: false }, () => {
  const sab = createOverlapCircleSab(8);
  bindOverlapCircleSab(sab);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);
  Atomics.store(i32, HDR_STATUS, 1);
  f32[8] = 10;
  f32[9] = 20;
  f32[10] = 30;
  const serviced = servicePendingOverlapCircle((cx, cy, radius, _cat, _mask, results, cap) => {
    assert.equal(cx, 10);
    assert.equal(cy, 20);
    assert.equal(radius, 30);
    assert.ok(cap >= 8);
    results[0] = 7;
    results[1] = 9;
    return 2;
  });
  assert.equal(serviced, true);
  assert.equal(Atomics.load(i32, HDR_STATUS), STATUS_DONE);
  assert.equal(Atomics.load(i32, HDR_COUNT), 2);
  assert.equal(i32[RESULTS_I32], 7);
  assert.equal(i32[RESULTS_I32 + 1], 9);
  bindOverlapCircleSab(null);
});

test('castRayAll service fills hit records', { concurrency: false }, () => {
  const sab = createCastRayAllSab(8);
  bindCastRayAllSab(sab);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);
  Atomics.store(i32, HDR_STATUS, 1);
  f32[8] = 1;
  f32[9] = 2;
  f32[10] = 3;
  f32[11] = 4;
  const serviced = servicePendingCastRayAll((ox, oy, dx, dy, _cat, _mask, hits, cap) => {
    assert.equal(ox, 1);
    assert.equal(oy, 2);
    assert.equal(dx, 3);
    assert.equal(dy, 4);
    assert.ok(cap >= 8);
    hits[0] = 11;
    hits[1] = 0.5;
    hits[2] = 8;
    hits[3] = 9;
    return 1;
  });
  assert.equal(serviced, true);
  assert.equal(Atomics.load(i32, HDR_STATUS), STATUS_DONE);
  assert.equal(Atomics.load(i32, HDR_COUNT), 1);
  assert.equal(f32[RESULTS_F32] | 0, 11);
  assert.equal(f32[RESULTS_F32 + 1], 0.5);
  assert.equal(f32[RESULTS_F32 + 2], 8);
  assert.equal(f32[RESULTS_F32 + 3], 9);
  bindCastRayAllSab(null);
});
