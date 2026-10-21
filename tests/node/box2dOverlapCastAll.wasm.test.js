/**
 * overlap_circle / cast_ray_all fill WASM query slots / hits (not count-only).
 * Query-hit stride is 8; first 4 floats match closest-hit layout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateBox2dWasm as instantiateShared } from '../helpers/box2dWasmInstance.mjs';
import { copyUniqueSlots } from '../../src/box2d/box2dQueryAabb.js';

const BODY_STATIC = 0;

const instantiateBox2dWasm = () => instantiateShared(['overlap_circle', 'cast_ray_all', 'get_query_slots_byte_offset', 'get_query_hits_byte_offset']);

function createBox(fn, worldId, x, y, entityIndex) {
  const slot = fn('create_body_box')(
    worldId,
    BODY_STATIC,
    x,
    y,
    0,
    20,
    20,
    0,
    0,
    1,
    0.3,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    0xffffffff,
    0,
    0,
    entityIndex,
  );
  assert.ok(slot >= 0, `create_body_box failed: ${slot}`);
  return slot;
}

test('overlap_circle writes entity ids into query slots', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(fn('bind_game_buffers')(64), 'bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, 0);

  createBox(fn, worldId, 0, 0, 11);
  createBox(fn, worldId, 10, 0, 22);

  const n = fn('overlap_circle')(worldId, 0, 0, 40, 1, 0xffffffff);
  assert.equal(n, 2);

  const slotsOff = fn('get_query_slots_byte_offset')() >> 2;
  const slots = new Int32Array(memory.buffer).subarray(slotsOff, slotsOff + n);
  const ids = new Set(slots);
  assert.ok(ids.has(11), `query slots missing 11: ${[...slots]}`);
  assert.ok(ids.has(22), `query slots missing 22: ${[...slots]}`);
});

test('a body with three shapes fills three query slots, and copyUniqueSlots keeps one (N-22)', () => {
  const { memory, fn } = instantiateShared(['overlap_aabb', 'get_query_slots_byte_offset', 'get_query_capacity', 'body_add_shape_box']);
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(fn('bind_game_buffers')(64), 'bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, 0);

  const slot = createBox(fn, worldId, 0, 0, 11);
  fn('body_add_shape_box')(slot, 5, 5, 20, 0);
  fn('body_add_shape_box')(slot, 5, 5, 40, 0);
  createBox(fn, worldId, 200, 0, 22);

  const n = fn('overlap_aabb')(worldId, -100, -100, 300, 100, 1, 0xffffffff);
  const slotsOff = fn('get_query_slots_byte_offset')() >> 2;
  const slots = new Int32Array(memory.buffer, slotsOff * 4, fn('get_query_capacity')());
  assert.deepEqual([...slots.subarray(0, n)].sort((a, b) => a - b), [11, 11, 11, 22]);

  const results = new Int32Array(8);
  const unique = copyUniqueSlots(slots, n, results, 8, 'queryAABB');
  assert.deepEqual([...results.subarray(0, unique)].sort((a, b) => a - b), [11, 22]);
});

test('cast_ray_all writes stride-8 hits; first 4 floats are entity/fraction/xy', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(fn('bind_game_buffers')(64), 'bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, 0);

  createBox(fn, worldId, 0, 0, 11);
  createBox(fn, worldId, 10, 0, 22);

  const stride = fn('get_query_hit_float_stride')();
  assert.equal(stride, 8);

  const n = fn('cast_ray_all')(worldId, -80, 0, 160, 0, 1, 0xffffffff);
  assert.equal(n, 2);

  const hitsOff = fn('get_query_hits_byte_offset')() >> 2;
  const hits = new Float32Array(memory.buffer).subarray(hitsOff, hitsOff + n * stride);
  const entities = [hits[0] | 0, hits[stride] | 0];
  assert.ok(entities.includes(11), `hits missing 11: ${entities}`);
  assert.ok(entities.includes(22), `hits missing 22: ${entities}`);
  assert.ok(hits[1] > 0 && hits[1] < 1, `fraction0 out of range: ${hits[1]}`);
  assert.ok(hits[stride + 1] > 0 && hits[stride + 1] < 1, `fraction1 out of range: ${hits[stride + 1]}`);
});
