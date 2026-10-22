/**
 * The Box2D impulse exports the physics host calls for applyImpulse /
 * applyAngularImpulse (DX 2): the change in velocity is impulse / mass, a
 * point impulse also spins the body by r × J / I, and two in one step add up.
 * Not a speed claim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateBox2dWasm as instantiateShared } from '../helpers/box2dWasmInstance.mjs';

const BODY_DYNAMIC = 1;
const CH_VX = 3;
const CH_VY = 4;
const CH_W = 5;

const instantiateBox2dWasm = () =>
  instantiateShared([
    'create_body_box',
    'body_apply_linear_impulse',
    'body_apply_linear_impulse_center',
    'body_apply_angular_impulse',
  ]);

function makeWorld(fn, memory) {
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(fn('bind_game_buffers')(64), 'bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, 0);
  const stateByte = fn('get_state_byte_offset')();
  const cap = fn('get_body_capacity')();
  const ch = (c) => (slot) => new Float32Array(memory.buffer)[(stateByte >> 2) + c * cap + slot];
  return { worldId, vx: ch(CH_VX), vy: ch(CH_VY), w: ch(CH_W) };
}

// A 1 × 1 box (half extents 0.5) of density 2: mass 2, inertia m(w² + h²)/12 = 1/3.
function createBox(fn, worldId, x) {
  const slot = fn('create_body_box')(
    worldId, BODY_DYNAMIC, x, 0, 0, 0.5, 0.5, 0, 0, 2, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, -1,
  );
  assert.ok(slot >= 0, `create_body_box failed: ${slot}`);
  return slot;
}

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-3, `${msg}: ${a} vs ${b}`);

test('a centre impulse changes velocity by impulse / mass; two add up', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const { worldId, vx, vy, w } = makeWorld(fn, memory);
  const a = createBox(fn, worldId, -10);
  fn('body_apply_linear_impulse_center')(a, 4, 0, 1);
  fn('body_apply_linear_impulse_center')(a, 2, -6, 1);
  fn('step_world')(worldId, 1 / 60, 4);
  near(vx(a), 3, 'vx = (4 + 2) / 2');
  near(vy(a), -3, 'vy = -6 / 2');
  near(w(a), 0, 'no spin');
});

test('a point impulse also spins the body by r × J / I; the angular one by J / I', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const { worldId, vy, w } = makeWorld(fn, memory);
  const b = createBox(fn, worldId, 10);
  // 0.5 to the right of the centre, pushing +y: torque arm 0.5 × 2 = 1, ω = 1 / (1/3) = 3
  fn('body_apply_linear_impulse')(b, 0, 2, 10.5, 0, 1);
  fn('step_world')(worldId, 1 / 60, 4);
  near(vy(b), 1, 'vy = 2 / 2');
  near(w(b), 3, 'ω = r × J / I');
  fn('body_apply_angular_impulse')(b, -1, 1);
  fn('step_world')(worldId, 1 / 60, 4);
  near(w(b), 0, 'ω = 3 - 1 / (1/3)');
});
