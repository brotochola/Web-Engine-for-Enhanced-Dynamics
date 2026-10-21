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

/** A box body at (x, 0) with two more box shapes beside it: one body, three shapes. */
function compound(fn, worldId, x, entityIndex) {
  const slot = createBox(fn, worldId, x, 0, entityIndex);
  fn('body_add_shape_box')(slot, 5, 5, 20, 0);
  fn('body_add_shape_box')(slot, 5, 5, 40, 0);
  return slot;
}

function querySlots(memory, fn, n) {
  const off = fn('get_query_slots_byte_offset')();
  return [...new Int32Array(memory.buffer, off, fn('get_query_capacity')()).subarray(0, n)];
}

const QUERY_FNS = ['overlap_aabb', 'overlap_circle', 'overlap_box', 'get_query_slots_byte_offset', 'get_query_capacity', 'body_add_shape_box'];

test('a body with three shapes is listed once by every overlap query (N-22)', () => {
  // The C collect callback used to write one slot per shape: [11, 11, 11, 22].
  const { memory, fn } = instantiateShared(QUERY_FNS);
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(fn('bind_game_buffers')(64), 'bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, 0);
  compound(fn, worldId, 0, 11);
  createBox(fn, worldId, 200, 0, 22);

  const aabb = fn('overlap_aabb')(worldId, -100, -100, 300, 100, 1, 0xffffffff);
  assert.deepEqual(querySlots(memory, fn, aabb).sort((x, y) => x - y), [11, 22]);
  const circle = fn('overlap_circle')(worldId, 20, 0, 60, 1, 0xffffffff);
  assert.deepEqual(querySlots(memory, fn, circle), [11]);
  const box = fn('overlap_box')(worldId, 100, 0, 150, 50, 0, 1, 0xffffffff);
  assert.deepEqual(querySlots(memory, fn, box).sort((x, y) => x - y), [11, 22]);

  // Physics still passes results through copyUniqueSlots; it now has nothing to drop.
  const slots = new Int32Array(querySlots(memory, fn, aabb));
  const results = new Int32Array(8);
  assert.equal(copyUniqueSlots(slots, aabb, results, 8, 'queryAABB'), 2);
});

test('each overlap query starts with a fresh stamp: the next one lists the same bodies', () => {
  const { memory, fn } = instantiateShared(QUERY_FNS);
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(fn('bind_game_buffers')(64), 'bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, 0);
  compound(fn, worldId, 0, 11);
  compound(fn, worldId, 100, 22);
  for (let k = 0; k < 3; k++) {
    const n = fn('overlap_aabb')(worldId, -100, -100, 300, 100, 1, 0xffffffff);
    assert.deepEqual(querySlots(memory, fn, n).sort((x, y) => x - y), [11, 22], `query ${k}`);
  }
});

test('past the buffer an overlap query holds that many distinct bodies, not copies', () => {
  // 600 three-shape bodies: before N-22 the 512 slots filled with ~171 bodies, three times each.
  const { memory, fn } = instantiateShared(QUERY_FNS);
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(fn('bind_game_buffers')(1024), 'bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, 0);
  for (let i = 0; i < 600; i++) compound(fn, worldId, i * 100, i);
  const cap = fn('get_query_capacity')();
  const n = fn('overlap_aabb')(worldId, -100, -100, 600 * 100 + 100, 100, 1, 0xffffffff);
  assert.equal(n, cap);
  const ids = querySlots(memory, fn, n);
  assert.equal(new Set(ids).size, cap);
  for (const id of ids) assert.ok(id >= 0 && id < 600, `id ${id}`);
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
