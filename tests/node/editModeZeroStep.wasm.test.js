/**
 * Edit mode freezes the world with Time.scale 0 (VISUAL_EDITOR_PLAN.md D5, ED-6): the physics host scales each
 * frame's dt by it, so every step it could take is a step of 0 s. A step of 0 s moves no Box2D body: not its
 * position, angle or velocity, falling and spinning as it is. Not a speed claim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiateBox2dWasm as instantiateShared } from '../helpers/box2dWasmInstance.mjs';

const BODY_STATIC = 0;
const BODY_DYNAMIC = 1;
const CHANNELS = ['x', 'y', 'angle', 'vx', 'vy', 'w'];

const instantiateBox2dWasm = () => instantiateShared(['create_body_box']);

const host = readFileSync(new URL('../../src/box2d/physicsHostImpl.js', import.meta.url), 'utf8');
const split = host.slice(host.indexOf('// b7-split-start'), host.indexOf('// b7-split-end'));
const splitFrameDt = new Function(`${split}\nreturn splitFrameDt;`)();

// create_body_box(world, type, x, y, angle, hx, hy, offsetX, offsetY, density, friction, restitution, linearDamp,
// angularDamp, gravityScale, vx, vy, angularVel, isSensor, hitEvents, category, mask, group, fixedRotation, entity)
function createBox(fn, worldId, type, x, y, hx, hy, vx, vy, w) {
  const slot = fn('create_body_box')(
    worldId, type, x, y, 0, hx, hy, 0, 0, 1, 0.6, 0, 0, 0, 1, vx, vy, w, 0, 0, 1, 0xffffffff, 0, 0, -1,
  );
  assert.ok(slot >= 0, `create_body_box failed: ${slot}`);
  return slot;
}

test('at Time.scale 0 the host steps 0 s, and a step of 0 s moves no body', () => {
  const frame = splitFrameDt((1 / 60) * 0);
  assert.equal(frame.dt, 0, 'the step the host would take');

  const { memory, fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 1000, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(fn('bind_game_buffers')(64), 'bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, 0);
  const stateFloat = fn('get_state_byte_offset')() >> 2;
  const cap = fn('get_body_capacity')();
  const pose = (slot) => {
    const heap = new Float32Array(memory.buffer);
    return Object.fromEntries(CHANNELS.map((name, c) => [name, heap[stateFloat + c * cap + slot]]));
  };

  createBox(fn, worldId, BODY_STATIC, 0, 200, 400, 20, 0, 0, 0);
  const box = createBox(fn, worldId, BODY_DYNAMIC, 0, 100, 10, 10, 50, -80, 2);
  fn('step_world')(worldId, 1 / 60, 4); // in flight: falling, moving right, spinning
  const before = pose(box);
  assert.ok(before.vx !== 0 && before.vy !== 0 && before.w !== 0, JSON.stringify(before));

  for (let i = 0; i < 30; i++) fn('step_world')(worldId, frame.dt, 4);
  assert.deepEqual(pose(box), before);

  fn('step_world')(worldId, 1 / 60, 4);
  assert.notDeepEqual(pose(box), before, 'and a real step still moves it');
});
