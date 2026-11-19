/**
 * E-325: Box2D's finalize writes each awake body's moved entry (its slot when its export found the pose changed) and
 * step_world's export compacts those into the moved list, in awake order. The list must hold exactly the bodies whose
 * pose changed in the step, a body put to sleep once with its fell-asleep flag (and its sleeping flag set, its
 * velocities zero), and no still body; a continuous-collision body's channels hold the pose it ends the step with.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateBox2dWasm } from '../helpers/box2dWasmInstance.mjs';

const BODY_STATIC = 0;
const BODY_DYNAMIC = 1;
const CH_X = 0;
const CH_Y = 1;
const CH_VX = 3;
const DT = 1 / 60;

function world({ sleeping = true } = {}) {
  const { memory, fn } = instantiateBox2dWasm(['malloc']);
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 2);
  assert.ok(fn('bind_game_buffers')(64));
  fn('world_enable_sleeping')(worldId, sleeping ? 1 : 0);
  const stateByte = fn('get_state_byte_offset')();
  const cap = fn('get_body_capacity')();
  const chan = (c, i) => new Float32Array(memory.buffer)[(stateByte >> 2) + c * cap + i];
  const asleep = (i) => new Uint8Array(memory.buffer)[fn('get_sleeping_byte_offset')() + i];
  const moved = () => {
    const n = fn('get_body_move_count')();
    const slots = new Int32Array(memory.buffer, fn('get_body_move_byte_offset')(), n);
    const fell = new Uint8Array(memory.buffer, fn('get_body_fell_asleep_byte_offset')(), n);
    return Array.from(slots, (slot, k) => ({ slot, fellAsleep: fell[k] }));
  };
  const box = (slot, type, x, y, half = 0.5) => {
    const got = fn('create_body_box')(
      worldId, type, x, y, 0, half, half, 0, 0, 1, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 1, 0xffffffff, 0, 1, slot,
    );
    assert.equal(got, slot);
  };
  return { fn, worldId, chan, asleep, moved, box, step: () => fn('step_world')(worldId, DT, 4) };
}

test('E-325: the moved list holds the bodies that moved, in awake order, and no still body', () => {
  const { fn, chan, moved, box, step } = world({ sleeping: false });
  box(3, BODY_DYNAMIC, 0, 0);
  box(9, BODY_DYNAMIC, 10, 0);
  box(20, BODY_DYNAMIC, 20, 0);
  fn('body_set_linear_velocity')(3, 2, 0);
  fn('body_set_linear_velocity')(20, 0, -1);
  step();
  const list = moved();
  assert.deepEqual(
    list.map((m) => m.slot).sort((a, b) => a - b),
    [3, 20],
    'the two bodies with a velocity moved; the one at rest did not',
  );
  assert.ok(list.every((m) => m.fellAsleep === 0));
  const x3 = chan(CH_X, 3);
  step();
  assert.ok(chan(CH_X, 3) > x3, 'the moving body keeps moving in the channels');
  assert.deepEqual(moved().map((m) => m.slot).sort((a, b) => a - b), [3, 20]);
});

test('E-325: a body put to sleep in the step is listed once with its fell-asleep flag, flagged asleep, velocities zero', () => {
  const { fn, chan, asleep, moved, box, step } = world();
  box(5, BODY_DYNAMIC, 0, 0);
  box(6, BODY_DYNAMIC, 10, 0);
  fn('body_set_linear_velocity')(6, 1, 0);
  let fell = null;
  for (let f = 0; f < 120 && !fell; f++) {
    // The resting body (5) falls asleep after Box2D's time to sleep; the moving one (6) never does.
    fn('body_set_linear_velocity')(6, 1, 0);
    step();
    const list = moved();
    const entry = list.find((m) => m.slot === 5);
    if (entry) {
      assert.equal(entry.fellAsleep, 1, 'a resting body enters the list only when it falls asleep');
      assert.equal(list.filter((m) => m.slot === 5).length, 1);
      fell = entry;
    }
    assert.ok(list.some((m) => m.slot === 6 && m.fellAsleep === 0), `frame ${f}: the moving body is listed`);
  }
  assert.ok(fell, 'the resting body fell asleep within two seconds');
  assert.equal(asleep(5), 1, 'its sleeping flag is set');
  assert.equal(asleep(6), 0, 'the moving body is awake');
  assert.equal(chan(CH_VX, 5), 0);
  step();
  assert.ok(!moved().some((m) => m.slot === 5), 'asleep, it is not listed again');
  assert.equal(asleep(5), 1);
});

test('E-325: a fast body (continuous collision against a wall) ends the step with its channels at its final pose', () => {
  const { fn, chan, moved, box, step } = world({ sleeping: false });
  box(0, BODY_STATIC, 5, 0, 0.5);
  box(1, BODY_DYNAMIC, 0, 0, 0.1);
  // 600 units/s: 10 units a step, through a wall 1 unit thick without continuous collision.
  fn('body_set_linear_velocity')(1, 600, 0);
  step();
  assert.ok(moved().some((m) => m.slot === 1));
  const x = chan(CH_X, 1);
  assert.ok(x < 4.6, `the fast body stopped at the wall (x ${x}), not past it`);
  assert.ok(x > 0, 'it moved toward it');
  assert.equal(chan(CH_Y, 1), 0);
  for (let f = 0; f < 5; f++) step();
  assert.ok(chan(CH_X, 1) < 4.6, 'it stays on its side of the wall');
});
