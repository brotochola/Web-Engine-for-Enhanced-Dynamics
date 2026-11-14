/**
 * E-288: bodies_apply_accelerations binds logic's accelerations and the solver's first substep adds them to the awake
 * bodies' forces; the batch itself only wakes a sleeping body that has something to apply, as the per-body
 * b2Body_ApplyForceToCenter / b2Body_ApplyTorque calls did with wake set. A body that fell asleep, or that
 * body_set_awake put to sleep, moves in the very step its acceleration is applied; one with no acceleration stays asleep.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateBox2dWasm } from '../helpers/box2dWasmInstance.mjs';

const BODY_DYNAMIC = 1;
const CH_VX = 3;
const CH_W = 5;
const N = 3;

function setup() {
  const { memory, fn } = instantiateBox2dWasm(['bodies_apply_accelerations', 'body_set_awake', 'malloc']);
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(fn('bind_game_buffers')(64), 'bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, 1);
  for (let i = 0; i < N; i++) {
    const slot = fn('create_body_box')(
      worldId, BODY_DYNAMIC, i * 10, 0, 0, 0.5, 0.5, 0, 0, 2, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, i,
    );
    assert.equal(slot, i);
  }
  const malloc = fn('malloc');
  const listByte = malloc(N * 2);
  const bytes = { ax: malloc(N * 4), ay: malloc(N * 4), aa: malloc(N * 4), mass: malloc(N * 4), inertia: malloc(N * 4) };
  const staticByte = malloc(N);
  const fixedByte = malloc(N);
  const col = (byte) => new Float32Array(memory.buffer, byte, N);
  const list = new Uint16Array(memory.buffer, listByte, N);
  for (let i = 0; i < N; i++) list[i] = i;
  col(bytes.mass).fill(2);
  col(bytes.inertia).fill(0.4);
  new Uint8Array(memory.buffer, staticByte, N).fill(0);
  new Uint8Array(memory.buffer, fixedByte, N).fill(0);
  const stateByte = fn('get_state_byte_offset')();
  const sleepingByte = fn('get_sleeping_byte_offset')();
  const cap = fn('get_body_capacity')();
  const state = (ch, i) => new Float32Array(memory.buffer)[(stateByte >> 2) + ch * cap + i];
  const sleeping = (i) => new Uint8Array(memory.buffer, sleepingByte, cap)[i];
  const apply = () =>
    fn('bodies_apply_accelerations')(listByte, N, bytes.ax, bytes.ay, bytes.aa, bytes.mass, bytes.inertia, staticByte, fixedByte);
  const step = () => fn('step_world')(worldId, 1 / 60, 4);
  return { fn, col, bytes, state, sleeping, apply, step };
}

test('E-288: a body that fell asleep wakes and moves in the step its acceleration is applied', () => {
  const w = setup();
  for (let f = 0; f < 120; f++) {
    w.apply();
    w.step();
  }
  for (let i = 0; i < N; i++) assert.equal(w.sleeping(i), 1, `body ${i} asleep after two still seconds`);
  w.col(w.bytes.ax)[0] = 3;
  w.col(w.bytes.aa)[1] = 2;
  w.apply();
  w.step();
  assert.equal(w.sleeping(0), 0, 'the pushed body woke');
  assert.ok(w.state(CH_VX, 0) > 0, 'and moved along x in that step');
  assert.equal(w.sleeping(1), 0, 'the spun body woke');
  assert.ok(w.state(CH_W, 1) > 0, 'and turned in that step');
  assert.equal(w.sleeping(2), 1, 'a body with nothing to apply stays asleep');
});

test('E-288: a body body_set_awake put to sleep wakes again for its acceleration', () => {
  const w = setup();
  w.apply();
  w.step();
  assert.equal(w.sleeping(2), 0, 'awake after one step');
  w.fn('body_set_awake')(2, 0);
  assert.equal(w.sleeping(2), 1, 'the sleeping paint follows body_set_awake');
  w.col(w.bytes.ax)[2] = -4;
  w.apply();
  w.step();
  assert.equal(w.sleeping(2), 0, 'woken by its acceleration');
  assert.ok(w.state(CH_VX, 2) < 0, 'and moved along -x in that step');
});
