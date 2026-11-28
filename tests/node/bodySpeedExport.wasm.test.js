/**
 * E-353: Box2D writes RigidBody.speed, the state channel STATE_CHANNELS.SPEED, with each export of a body's velocities
 * when set_body_speed_export is on (the scene's physics.deriveSpeed): sqrt(vx * vx + vy * vy) of the velocity channels,
 * as the particle worker's pass computed it (in float32 here; that pass rounded a double into the float32 column, so
 * at most one ulp apart). A body that falls asleep reads 0; with the export off the channel stays 0.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateBox2dWasm } from '../helpers/box2dWasmInstance.mjs';
import { STATE_CHANNELS } from '../../src/box2d/box2dConstants.js';

const BODY_DYNAMIC = 1;
const N = 3;
const DT = 1 / 60;

function world(speedExport) {
  const { memory, fn } = instantiateBox2dWasm(['set_body_speed_export', 'body_set_linear_velocity', 'body_set_awake']);
  fn('set_body_speed_export')(speedExport ? 1 : 0);
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(fn('bind_game_buffers')(64, 0));
  fn('world_enable_sleeping')(worldId, 1);
  for (let i = 0; i < N; i++) {
    const slot = fn('create_body_box')(
      worldId, BODY_DYNAMIC, i * 10, 0, 0, 0.5, 0.5, 0, 0, 2, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, i,
    );
    assert.equal(slot, i);
  }
  const stateByte = fn('get_state_byte_offset')();
  const cap = fn('get_body_capacity')();
  const chan = (c, i) => new Float32Array(memory.buffer)[(stateByte >> 2) + fn('get_state_channel_offset')(c) + i];
  const speedOf = (i) => chan(STATE_CHANNELS.SPEED, i);
  const lengthOf = (i) => {
    const vx = chan(STATE_CHANNELS.VX, i);
    const vy = chan(STATE_CHANNELS.VY, i);
    return Math.sqrt(vx * vx + vy * vy);
  };
  const step = () => fn('step_world')(worldId, DT, 4);
  assert.ok(cap >= N);
  return { fn, step, speedOf, lengthOf, chan };
}

/** Within one float32 ulp of the double length the JS pass computed from the same channels. */
function assertSpeed(w, i, what) {
  const want = w.lengthOf(i);
  const got = w.speedOf(i);
  const ulp = Math.max(Math.abs(Math.fround(want) - Math.fround(want * (1 + 2 ** -23))), 2 ** -149);
  assert.ok(Math.abs(got - want) <= ulp, `${what}: speed ${got}, sqrt(vx² + vy²) ${want}`);
}

test('E-353: the speed channel holds sqrt(vx² + vy²) of each awake body, and 0 once it sleeps', () => {
  const w = world(true);
  w.fn('body_set_linear_velocity')(0, 3, -4);
  w.fn('body_set_linear_velocity')(1, 0.1, 0.7);
  // a command's export writes the speed at once
  assertSpeed(w, 0, 'after the command');
  assert.ok(Math.abs(w.speedOf(0) - 5) < 1e-6, `speed ${w.speedOf(0)} of (3, -4)`);
  for (let f = 0; f < 10; f++) {
    w.step();
    for (let i = 0; i < N; i++) assertSpeed(w, i, `frame ${f}, body ${i}`);
  }
  assert.ok(w.speedOf(0) > 4.9, `body 0 still moves: ${w.speedOf(0)}`);
  assert.equal(w.speedOf(2), 0, 'a body never pushed');

  // body 0 put to sleep by a command keeps the velocities it was exported with, and the speed of them
  w.fn('body_set_awake')(0, 0);
  assertSpeed(w, 0, 'asleep by command');

  // body 1 slows to a stop and falls asleep (no damping: stopped by hand), its velocities and speed exported as 0
  w.fn('body_set_linear_velocity')(1, 0, 0);
  for (let f = 0; f < 120; f++) w.step();
  assert.equal(w.chan(STATE_CHANNELS.VX, 1), 0);
  assert.equal(w.speedOf(1), 0, 'asleep');
  w.fn('body_set_linear_velocity')(1, -6, 8);
  w.step();
  assertSpeed(w, 1, 'woken');
  assert.ok(w.speedOf(1) > 9.9, `woken body's speed ${w.speedOf(1)}`);
});

test('E-353: with the speed export off the channel stays 0', () => {
  const w = world(false);
  w.fn('body_set_linear_velocity')(0, 3, -4);
  for (let f = 0; f < 3; f++) w.step();
  assert.ok(w.lengthOf(0) > 4.9);
  assert.equal(w.speedOf(0), 0);
});
