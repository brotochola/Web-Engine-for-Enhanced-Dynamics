/**
 * N-97: a body's collision mask of 0 collides with nothing, as in Box2D. The glue used to read 0 as the default mask
 * (every layer), so `collider.collisionMask = 0` collided with everything. Collider.collisionMask starts at 0xFFFFFFFF;
 * a query's mask of 0 still asks for the default.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateBox2dWasm as instantiateShared } from '../helpers/box2dWasmInstance.mjs';

const BODY_DYNAMIC = 1;
const CH_VX = 3;
const ALL = 0xffffffff;

const instantiateBox2dWasm = () => instantiateShared(['create_body_box', 'body_set_filter', 'overlap_circle']);

function makeWorld(fn, memory) {
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(fn('bind_game_buffers')(64), 'bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, 0);
  const stateByte = fn('get_state_byte_offset')();
  const cap = fn('get_body_capacity')();
  const vx = (slot) => new Float32Array(memory.buffer)[(stateByte >> 2) + CH_VX * cap + slot];
  return { worldId, vx };
}

/** A 1 × 1 dynamic box at (x, 0), category 1. */
function box(fn, worldId, x, maskBits) {
  const slot = fn('create_body_box')(
    worldId, BODY_DYNAMIC, x, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 1, maskBits, 0, 0, -1,
  );
  assert.ok(slot >= 0, `create_body_box failed: ${slot}`);
  return slot;
}

/** Two boxes overlapping by 0.4, stepped a few times: the solver pushes them apart only if they collide. */
function pushApart(maskA, { filterA = null } = {}) {
  const { memory, fn } = instantiateBox2dWasm();
  const { worldId, vx } = makeWorld(fn, memory);
  const a = box(fn, worldId, 0, maskA);
  const b = box(fn, worldId, 0.6, ALL);
  if (filterA !== null) fn('body_set_filter')(a, 1, filterA, 0);
  for (let i = 0; i < 4; i++) fn('step_world')(worldId, 1 / 60, 4);
  return { va: vx(a), vb: vx(b) };
}

test('two overlapping boxes push apart; with a mask of 0 they pass through each other', () => {
  const both = pushApart(ALL);
  assert.ok(both.va < -0.01 && both.vb > 0.01, `default masks collide: ${both.va}, ${both.vb}`);
  const none = pushApart(0);
  assert.equal(none.va, 0, 'mask 0 at creation: no contact');
  assert.equal(none.vb, 0);
});

test('body_set_filter with a mask of 0 stops the collision too', () => {
  const none = pushApart(ALL, { filterA: 0 });
  assert.equal(none.va, 0);
  assert.equal(none.vb, 0);
});

test('a query with a mask of 0 still asks for the default mask', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const { worldId } = makeWorld(fn, memory);
  box(fn, worldId, -3, ALL);
  box(fn, worldId, 3, ALL);
  assert.equal(fn('overlap_circle')(worldId, 0, 0, 10, 1, 0), 2);
});
