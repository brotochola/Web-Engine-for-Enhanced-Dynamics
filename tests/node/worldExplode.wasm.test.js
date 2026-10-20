/**
 * world_explode — two dynamic boxes must move apart after one step.
 * Not a speed claim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateBox2dWasm as instantiateShared } from '../helpers/box2dWasmInstance.mjs';

const BODY_DYNAMIC = 1;
const CH_X = 0;
const CH_VX = 3;

const instantiateBox2dWasm = () => instantiateShared(['world_explode', 'create_body_box']);

function makeWorld(fn, memory) {
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(fn('bind_game_buffers')(64), 'bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, 0);

  const stateByte = fn('get_state_byte_offset')();
  const cap = fn('get_body_capacity')();
  const heapF = () => new Float32Array(memory.buffer);
  const bodyX = (slot) => heapF()[(stateByte >> 2) + CH_X * cap + slot];
  const bodyVx = (slot) => heapF()[(stateByte >> 2) + CH_VX * cap + slot];
  return { worldId, bodyX, bodyVx };
}

function createBox(fn, worldId, opts) {
  const o = {
    type: BODY_DYNAMIC,
    x: 0,
    y: 0,
    angle: 0,
    hx: 0.5,
    hy: 0.5,
    offsetX: 0,
    offsetY: 0,
    density: 1,
    friction: 0,
    restitution: 0,
    linearDamp: 0,
    angularDamp: 0,
    gravityScale: 0,
    vx: 0,
    vy: 0,
    angularVel: 0,
    isSensor: 0,
    enableHitEvents: 0,
    categoryBits: 1,
    maskBits: 0xffffffff,
    groupIndex: 0,
    fixedRotation: 0,
    entityIndex: -1,
    ...opts,
  };
  const slot = fn('create_body_box')(
    worldId,
    o.type,
    o.x,
    o.y,
    o.angle,
    o.hx,
    o.hy,
    o.offsetX,
    o.offsetY,
    o.density,
    o.friction,
    o.restitution,
    o.linearDamp,
    o.angularDamp,
    o.gravityScale,
    o.vx,
    o.vy,
    o.angularVel,
    o.isSensor,
    o.enableHitEvents,
    o.categoryBits,
    o.maskBits,
    o.groupIndex,
    o.fixedRotation,
    o.entityIndex,
  );
  assert.ok(slot >= 0, `create_body_box failed: ${slot}`);
  return slot;
}

test('world_explode pushes two dynamic boxes apart', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const { worldId, bodyX, bodyVx } = makeWorld(fn, memory);

  const left = createBox(fn, worldId, { x: -4, y: 0, entityIndex: 0 });
  const right = createBox(fn, worldId, { x: 4, y: 0, entityIndex: 1 });
  const xL0 = bodyX(left);
  const xR0 = bodyX(right);

  // Same arg list as PhysicsWorld.explode: world, x, y, radius, falloff, impulse, mask, flags.
  fn('world_explode')(worldId, 0, 0, 20, 10, 12, 0xffffffff, 0);
  fn('step_world')(worldId, 1 / 60, 4);

  const xL1 = bodyX(left);
  const xR1 = bodyX(right);
  assert.ok(
    bodyVx(left) < -0.1 || xL1 < xL0 - 0.01,
    `left should be pushed −x (vx=${bodyVx(left)} x0=${xL0} x1=${xL1})`,
  );
  assert.ok(
    bodyVx(right) > 0.1 || xR1 > xR0 + 0.01,
    `right should be pushed +x (vx=${bodyVx(right)} x0=${xR0} x1=${xR1})`,
  );
});
