/**
 * E-308: the step's export writes a moved body's rotation (the angle, rotC, rotS) only when its rotation changed; a
 * command still exports the whole state. The rotation channels must stay what Box2D holds: a body moving without
 * turning keeps its angle and cos/sin; a spinning one gets a new angle every step; and after a command that set the
 * rotation while the channels already held its cos and sin (setRotationCS writes them before the command), the angle
 * follows on the command's export, before any step.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateBox2dWasm } from '../helpers/box2dWasmInstance.mjs';

const BODY_DYNAMIC = 1;
const CH_X = 0;
const CH_ROT = 2;
const CH_ROT_C = 6;
const CH_ROT_S = 7;
const DT = 1 / 60;
// Box2D's b2Atan2 is an approximation (a few 1e-5 rad here), so the angle is compared with Math.atan2 within this.
const ATAN2_TOL = 2e-4;

function world() {
  const { memory, fn } = instantiateBox2dWasm(['malloc']);
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(fn('bind_game_buffers')(64));
  fn('world_enable_sleeping')(worldId, 0);
  const stateByte = fn('get_state_byte_offset')();
  const cap = fn('get_body_capacity')();
  const f32 = () => new Float32Array(memory.buffer);
  const chan = (c, i) => f32()[(stateByte >> 2) + c * cap + i];
  const setChan = (c, i, v) => {
    f32()[(stateByte >> 2) + c * cap + i] = v;
  };
  const box = (slot, x, angle) => {
    const got = fn('create_body_box')(
      worldId, BODY_DYNAMIC, x, 0, angle, 0.5, 0.5, 0, 0, 2, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, slot,
    );
    assert.equal(got, slot);
  };
  return { fn, worldId, chan, setChan, box, step: () => fn('step_world')(worldId, DT, 4) };
}

test('E-308: a body moving without turning keeps its rotation channels; a spinning one updates them', () => {
  const { fn, chan, box, step } = world();
  box(0, 0, 0.7);
  box(1, 10, 0.3);
  fn('body_set_fixed_rotation')(0, 1);
  fn('body_set_linear_velocity')(0, 2, 0);
  fn('body_set_angular_velocity')(1, 3);
  step();
  const rot0 = chan(CH_ROT, 0);
  const c0 = chan(CH_ROT_C, 0);
  const s0 = chan(CH_ROT_S, 0);
  assert.ok(Math.abs(rot0 - Math.atan2(s0, c0)) < ATAN2_TOL, `angle ${rot0} is the atan2 of (${c0}, ${s0})`);
  let x = chan(CH_X, 0);
  let rot1 = chan(CH_ROT, 1);
  for (let f = 0; f < 5; f++) {
    step();
    const nx = chan(CH_X, 0);
    assert.ok(nx > x, `frame ${f}: the fixed-rotation box moved (${x} -> ${nx})`);
    x = nx;
    assert.equal(chan(CH_ROT, 0), rot0, `frame ${f}: its angle kept`);
    assert.equal(chan(CH_ROT_C, 0), c0, `frame ${f}: its cos kept`);
    assert.equal(chan(CH_ROT_S, 0), s0, `frame ${f}: its sin kept`);
    const nr = chan(CH_ROT, 1);
    assert.ok(nr > rot1, `frame ${f}: the spinning box turned (${rot1} -> ${nr})`);
    rot1 = nr;
    const c1 = chan(CH_ROT_C, 1);
    const s1 = chan(CH_ROT_S, 1);
    assert.ok(Math.abs(nr - Math.atan2(s1, c1)) < ATAN2_TOL, `frame ${f}: the spinning angle is the atan2 of its cos and sin`);
  }
});

test('E-308: after setRotationCS (cos and sin written first, then the command) the angle follows at once and stays', () => {
  const { fn, chan, setChan, box, step } = world();
  box(0, 0, 0);
  fn('body_set_linear_velocity')(0, 1, 0);
  step();
  assert.equal(chan(CH_ROT, 0), 0);
  // GameObject.setRotationCS on a body: the columns first, then the command physics runs (body_set_transform).
  const a = 1.1;
  const c = Math.fround(Math.cos(a));
  const s = Math.fround(Math.sin(a));
  setChan(CH_ROT_C, 0, c);
  setChan(CH_ROT_S, 0, s);
  fn('body_set_transform')(0, chan(CH_X, 0), 0, c, s);
  const rot = chan(CH_ROT, 0);
  assert.ok(Math.abs(rot - a) < ATAN2_TOL, `the angle follows the command: ${rot} for ${a}`);
  for (let f = 0; f < 3; f++) {
    step();
    assert.ok(Math.abs(chan(CH_ROT, 0) - Math.atan2(chan(CH_ROT_S, 0), chan(CH_ROT_C, 0))) < ATAN2_TOL, `frame ${f}: angle and cos/sin agree`);
  }
});
