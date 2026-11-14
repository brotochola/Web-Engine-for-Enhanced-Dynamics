/**
 * E-305: without LiquidFun the step's move export no longer reads each moved body's velocities back from Box2D; the
 * solver's finalize exported them already. The velocity channels must still hold the body's velocities: a box pushed
 * by an acceleration for one step, then coasting (no gravity, no damping), shows a*dt from that step on, in the steps
 * where it moves without a new force too; one spun the same way shows its angular velocity.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateBox2dWasm } from '../helpers/box2dWasmInstance.mjs';

const BODY_DYNAMIC = 1;
const CH_X = 0;
const CH_VX = 3;
const CH_VY = 4;
const CH_W = 5;
const DT = 1 / 60;

test('E-305: the velocity channels hold a moving body\'s velocities with no read-back', () => {
  const { memory, fn } = instantiateBox2dWasm(['bodies_apply_accelerations', 'malloc']);
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(fn('bind_game_buffers')(64));
  fn('world_enable_sleeping')(worldId, 0);
  for (let i = 0; i < 2; i++) {
    const slot = fn('create_body_box')(
      worldId, BODY_DYNAMIC, i * 10, 0, 0, 0.5, 0.5, 0, 0, 2, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, i,
    );
    assert.equal(slot, i);
  }
  const malloc = fn('malloc');
  const listByte = malloc(4);
  const b = { ax: malloc(8), ay: malloc(8), aa: malloc(8), mass: malloc(8), inertia: malloc(8), isStatic: malloc(2), fixed: malloc(2) };
  new Uint16Array(memory.buffer, listByte, 2).set([0, 1]);
  const col = (byte) => new Float32Array(memory.buffer, byte, 2);
  col(b.mass).fill(2);
  col(b.inertia).fill(0.4);
  new Uint8Array(memory.buffer, b.isStatic, 2).fill(0);
  new Uint8Array(memory.buffer, b.fixed, 2).fill(0);
  const stateByte = fn('get_state_byte_offset')();
  const cap = fn('get_body_capacity')();
  const chan = (c, i) => new Float32Array(memory.buffer)[(stateByte >> 2) + c * cap + i];
  const step = () => {
    fn('bodies_apply_accelerations')(listByte, 2, b.ax, b.ay, b.aa, b.mass, b.inertia, b.isStatic, b.fixed);
    fn('step_world')(worldId, DT, 4);
  };

  col(b.ax)[0] = 3;
  col(b.aa)[1] = 2;
  step();
  const vx = chan(CH_VX, 0);
  const w = chan(CH_W, 1);
  assert.ok(Math.abs(vx - 3 * DT) < 1e-6, `vx after the push ${vx}`);
  assert.ok(w > 0, `angular velocity after the spin ${w}`);
  col(b.ax)[0] = 0;
  col(b.aa)[1] = 0;
  let x = chan(CH_X, 0);
  for (let f = 0; f < 5; f++) {
    step();
    const nx = chan(CH_X, 0);
    assert.ok(nx > x, `frame ${f}: the box moved (${x} -> ${nx})`);
    x = nx;
    assert.equal(chan(CH_VX, 0), vx, `frame ${f}: vx kept`);
    assert.equal(chan(CH_VY, 0), 0, `frame ${f}: vy`);
    assert.equal(chan(CH_W, 1), w, `frame ${f}: w kept`);
  }
});
