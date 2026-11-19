/**
 * N-315: a command's export (body_set_transform and the other setters through export_slot_state) of a dynamic body the
 * command leaves asleep keeps its sleeping flag set. b2ExportBodyState clears the flag, and bodies_apply_accelerations
 * wakes only a body flagged asleep, so an acceleration given in the frame of a teleport was lost.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateBox2dWasm } from '../helpers/box2dWasmInstance.mjs';

const BODY_DYNAMIC = 1;
const CH_X = 0;
const N = 2;

function setup() {
  const { memory, fn } = instantiateBox2dWasm(['bodies_apply_accelerations', 'body_set_transform', 'malloc']);
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
  // malloc's memory is not zeroed (see bodyAccelerationsWake.wasm.test.js).
  col(bytes.ax).fill(0);
  col(bytes.ay).fill(0);
  col(bytes.aa).fill(0);
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

test('N-315: a sleeping body a command teleports stays flagged asleep', () => {
  const w = setup();
  for (let f = 0; f < 120; f++) {
    w.apply();
    w.step();
  }
  assert.equal(w.sleeping(0), 1, 'asleep after two still seconds');
  w.fn('body_set_transform')(0, 3, 0, 1, 0);
  assert.equal(w.state(CH_X, 0), 3, 'the teleport is exported');
  assert.equal(w.sleeping(0), 1, 'and the body, still asleep, keeps its flag');
});

test('N-315: an acceleration given in the frame of a teleport wakes the body and moves it', () => {
  const w = setup();
  for (let f = 0; f < 120; f++) {
    w.apply();
    w.step();
  }
  w.fn('body_set_transform')(0, 3, 0, 1, 0);
  w.col(w.bytes.ax)[0] = 3;
  w.apply();
  w.step();
  assert.equal(w.sleeping(0), 0, 'the pushed body woke');
  assert.ok(w.state(CH_X, 0) > 3, 'and moved along x from where the command put it');
  assert.equal(w.sleeping(1), 1, 'a body with nothing to apply stays asleep');
});
