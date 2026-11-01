/**
 * E-181: Box2D writes a move event for every awake body every step, moved or not. The glue leaves a body whose pose
 * is the one already exported out of the moved list (spatial rewrites the grid from it), unless it fell asleep, and
 * still writes its velocities.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateBox2dWasm as instantiateShared } from '../helpers/box2dWasmInstance.mjs';

const BODY_DYNAMIC = 1;
const CH_VX = 3;

const instantiateBox2dWasm = () =>
  instantiateShared(['create_body_box', 'get_body_move_count', 'get_body_move_byte_offset', 'body_set_linear_velocity']);

function makeWorld(fn, memory, sleeping) {
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(fn('bind_game_buffers')(64), 'bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, sleeping ? 1 : 0);
  const stateByte = fn('get_state_byte_offset')();
  const cap = fn('get_body_capacity')();
  const vx = (slot) => new Float32Array(memory.buffer)[(stateByte >> 2) + CH_VX * cap + slot];
  const moved = () => {
    const n = fn('get_body_move_count')();
    return [...new Int32Array(memory.buffer, fn('get_body_move_byte_offset')(), n)].sort((a, b) => a - b);
  };
  return { worldId, vx, moved };
}

/** A 1 x 1 dynamic box at (x, 0) for entity `entity`, far from the others. */
function box(fn, worldId, x, entity, vx = 0) {
  const slot = fn('create_body_box')(
    worldId, BODY_DYNAMIC, x, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0, 0, 0,
    vx, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, entity,
  );
  assert.ok(slot >= 0, `create_body_box failed: ${slot}`);
  return slot;
}

test('an awake body that did not move is not listed as moved; one that moved is', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const { worldId, vx, moved } = makeWorld(fn, memory, false);
  const still = box(fn, worldId, -50, 3);
  const mover = box(fn, worldId, 50, 4, 2);
  fn('step_world')(worldId, 1 / 60, 4);
  // The first step exports both poses (the channels held the creation's).
  fn('step_world')(worldId, 1 / 60, 4);
  assert.deepEqual(moved(), [mover], 'only the moving body');
  fn('body_set_linear_velocity')(still, 1, 0);
  fn('step_world')(worldId, 1 / 60, 4);
  assert.deepEqual(moved(), [still, mover].sort((a, b) => a - b), 'the still body moves once pushed');
  assert.ok(Math.abs(vx(still) - 1) < 1e-6, 'its velocity was exported');
});

test('a still body is listed once, on the step it falls asleep', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const { worldId, moved } = makeWorld(fn, memory, true);
  const slot = box(fn, worldId, 0, 7);
  fn('step_world')(worldId, 1 / 60, 4);
  // Box2D's time to sleep is half a second at rest; asleep, it gets no more move events.
  let listed = 0;
  for (let i = 0; i < 90; i++) {
    fn('step_world')(worldId, 1 / 60, 4);
    if (moved().includes(slot)) listed++;
  }
  assert.equal(listed, 1, 'listed on the step it fell asleep, and only then');
});
