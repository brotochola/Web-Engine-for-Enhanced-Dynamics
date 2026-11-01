/**
 * W28: bodies_apply_accelerations (Box2D's wasm_wrapper.c) does in one call what weedjsPost.js's
 * applyForcesAndTorque did a call per body: the same bodies get the same forces and torques, so after a
 * step every velocity is bit for bit the per-body path's. Bodies cover the branches: static (its
 * accelerations cleared, no force), a mass of 0 (taken as 1), no inertia (the mass), a fixed rotation (no
 * torque), no acceleration at all (no call).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateBox2dWasm } from '../helpers/box2dWasmInstance.mjs';

const BODY_DYNAMIC = 1;
const CH_VX = 3;
const CH_VY = 4;
const CH_W = 5;
const N = 6;

// Per body: ax, ay, angularAccel, mass, inertia, static, fixedRotation.
const BODIES = [
  [3.5, -1.25, 0.75, 2, 0.4, 0, 0],
  [0, 0, 0, 2, 0.4, 0, 0],
  [1, 2, 3, 0, 0, 0, 0],
  [-4, 0.5, 2.5, 3, 0, 0, 0],
  [2, 2, 9, 1.5, 0.2, 0, 1],
  [7, 7, 7, 2, 0.4, 1, 0],
];

function world(fn, memory) {
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(fn('bind_game_buffers')(64), 'bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, 0);
  for (let i = 0; i < N; i++) {
    const slot = fn('create_body_box')(
      worldId, BODY_DYNAMIC, i * 4, 0, 0, 0.5, 0.5, 0, 0, 2, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, i,
    );
    assert.equal(slot, i, `create_body_box gave slot ${slot}`);
  }
  const stateByte = fn('get_state_byte_offset')();
  const cap = fn('get_body_capacity')();
  const read = () => {
    const f = new Float32Array(memory.buffer);
    const out = [];
    for (let i = 0; i < N; i++) {
      for (const c of [CH_VX, CH_VY, CH_W]) out.push(f[(stateByte >> 2) + c * cap + i]);
    }
    return out;
  };
  return { worldId, read };
}

test('the batch applies what the per-body calls applied, column for column', () => {
  // The per-body path: applyForcesAndTorque's arithmetic in JS (products in double, rounded at the call).
  let perBody;
  let accelAfterPerBody;
  {
    const { memory, fn } = instantiateBox2dWasm(['body_apply_force_center', 'body_apply_torque']);
    const { worldId, read } = world(fn, memory);
    const accel = BODIES.map((b) => b.slice(0, 3));
    for (let i = 0; i < N; i++) {
      const [ax, ay, aa, m, inertia, isStatic, fixed] = BODIES[i];
      if (isStatic) {
        accel[i] = [0, 0, 0];
        continue;
      }
      const mass = Math.fround(m) > 0 ? Math.fround(m) : 1;
      if (ax !== 0 || ay !== 0) fn('body_apply_force_center')(i, Math.fround(ax) * mass, Math.fround(ay) * mass, 1);
      if (aa !== 0 && !fixed) {
        const am = Math.fround(inertia) > 0 ? Math.fround(inertia) : mass;
        fn('body_apply_torque')(i, Math.fround(aa) * am, 1);
      }
    }
    fn('step_world')(worldId, 1 / 60, 4);
    perBody = read();
    accelAfterPerBody = accel.flat();
  }

  // The batch, on columns in Box2D's memory.
  const { memory, fn } = instantiateBox2dWasm(['bodies_apply_accelerations', 'malloc']);
  const { worldId, read } = world(fn, memory);
  const malloc = fn('malloc');
  const listByte = malloc(N * 2);
  const f32 = () => malloc(N * 4);
  const axByte = f32();
  const ayByte = f32();
  const aaByte = f32();
  const massByte = f32();
  const inertiaByte = f32();
  const staticByte = malloc(N);
  const fixedByte = malloc(N);
  const list = new Uint16Array(memory.buffer, listByte, N);
  const col = (byte) => new Float32Array(memory.buffer, byte, N);
  const ax = col(axByte);
  const ay = col(ayByte);
  const aa = col(aaByte);
  const mass = col(massByte);
  const inertia = col(inertiaByte);
  const isStatic = new Uint8Array(memory.buffer, staticByte, N);
  const fixed = new Uint8Array(memory.buffer, fixedByte, N);
  for (let i = 0; i < N; i++) {
    list[i] = N - 1 - i; // any order
    [ax[i], ay[i], aa[i], mass[i], inertia[i], isStatic[i], fixed[i]] = BODIES[i];
  }
  fn('bodies_apply_accelerations')(listByte, N, axByte, ayByte, aaByte, massByte, inertiaByte, staticByte, fixedByte);
  fn('step_world')(worldId, 1 / 60, 4);
  assert.deepEqual(read(), perBody, 'velocities after the step');
  const accelAfter = [];
  for (let i = 0; i < N; i++) accelAfter.push(ax[i], ay[i], aa[i]);
  assert.deepEqual(accelAfter, accelAfterPerBody.map(Math.fround), 'a static body\'s accelerations cleared, the rest kept');
  assert.ok(perBody.some((v) => v !== 0), 'forces were applied');
});

test('absent inertia and fixed-rotation columns (0) read as none', () => {
  const { memory, fn } = instantiateBox2dWasm(['bodies_apply_accelerations', 'malloc']);
  const { worldId, read } = world(fn, memory);
  const malloc = fn('malloc');
  const listByte = malloc(2);
  const cols = [malloc(4), malloc(4), malloc(4), malloc(4)];
  const staticByte = malloc(1);
  new Uint16Array(memory.buffer, listByte, 1)[0] = 0;
  new Float32Array(memory.buffer, cols[0], 1)[0] = 1;
  new Float32Array(memory.buffer, cols[2], 1)[0] = 2;
  new Float32Array(memory.buffer, cols[3], 1)[0] = 2;
  new Uint8Array(memory.buffer, staticByte, 1)[0] = 0;
  fn('bodies_apply_accelerations')(listByte, 1, cols[0], cols[1], cols[2], cols[3], 0, staticByte, 0);
  fn('step_world')(worldId, 1 / 60, 4);
  const v = read();
  assert.ok(v[0] > 0, 'pushed along x');
  assert.ok(v[2] > 0, 'spun by angularAccel times the mass');
});
