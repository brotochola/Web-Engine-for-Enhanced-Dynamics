/**
 * E-182: the solver's finalize exports each awake body's state, and the glue exports a moved body again only when its
 * move event's pose differs from what that export wrote: continuous collision moves a fast body back to its time of
 * impact after the finalize. The state channels must hold that final pose, not the one past the wall.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateBox2dWasm as instantiateShared } from '../helpers/box2dWasmInstance.mjs';

const BODY_STATIC = 0;
const BODY_DYNAMIC = 1;
const CH_X = 0;

test('a fast body stopped by continuous collision exports the pose it stopped at', () => {
  const { memory, fn } = instantiateShared(['create_body_box', 'create_body_circle']);
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(fn('bind_game_buffers')(64), 'bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, 0);
  // A thin static wall at x = 10, a small fast ball at x = 0 heading at it: 20 units a step, so a step past the wall.
  fn('create_body_box')(worldId, BODY_STATIC, 10, 0, 0, 0.05, 5, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, 1);
  const ball = fn('create_body_circle')(
    worldId, BODY_DYNAMIC, 0, 0, 0, 0.25, 0, 0, 1, 0, 0, 0, 0, 0, 1200, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, 2,
  );
  assert.ok(ball >= 0, 'create_body_circle failed');
  const x = () => new Float32Array(memory.buffer)[(fn('get_state_byte_offset')() >> 2) + CH_X * fn('get_body_capacity')() + ball];
  for (let i = 0; i < 3; i++) fn('step_world')(worldId, 1 / 60, 4);
  assert.ok(x() < 10, `the ball's exported x stays this side of the wall: ${x()}`);
});
