/**
 * E-322: physics.awakeReorderInterval reaches Box2D's world. Every that many steps, at the start of the step, Box2D puts
 * its awake bodies back in body id order and its contacts in body order (b2World_SetAwakeReorderInterval, exported as
 * world_set_awake_reorder_interval). These run the shipped module, physicsApi.js, the physics host's config update
 * (physicsHostImpl.js applyPhysicsConfig) and weedjsPost.js's weedjsApplyConfig as shipped. The reorder shows in the
 * moved list, which Box2D writes in its awake order.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiateBox2dWasm } from '../helpers/box2dWasmInstance.mjs';
import { validatePhysicsConfig, PHYSICS_SIM_DEFAULTS } from '../../src/box2d/physicsConfig.js';
import { PHYSICS_DEFAULTS } from '../../src/util/configDefaults.js';

const BODY_DYNAMIC = 1;
const apiSource = readFileSync(new URL('../../src/box2d/physicsApi.js', import.meta.url), 'utf8');
const hostSource = readFileSync(new URL('../../src/box2d/physicsHostImpl.js', import.meta.url), 'utf8');
const postSource = readFileSync(new URL('../../src/box2d/weedjsPost.js', import.meta.url), 'utf8');

/** The source of `function <name>(...) { ... }` in a shipped file, braces matched. */
function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is missing`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} has no end`);
}

test('physics.awakeReorderInterval defaults to 0 and takes whole steps of 1 or more', () => {
  assert.equal(PHYSICS_SIM_DEFAULTS.awakeReorderInterval, 0);
  assert.equal(PHYSICS_DEFAULTS.awakeReorderInterval, 0);
  assert.equal(validatePhysicsConfig(null, {}).awakeReorderInterval, 0);
  assert.equal(validatePhysicsConfig(null, { awakeReorderInterval: 30 }).awakeReorderInterval, 30);
  assert.equal(validatePhysicsConfig(null, { awakeReorderInterval: 120.9 }).awakeReorderInterval, 120);
  for (const bad of [0, 0.5, -30, NaN, Infinity, '30', null]) {
    assert.equal(validatePhysicsConfig(null, { awakeReorderInterval: bad }).awakeReorderInterval, 0, String(bad));
  }
  const set = validatePhysicsConfig(null, { awakeReorderInterval: 30 });
  assert.equal(validatePhysicsConfig(set, { subStepCount: 2 }).awakeReorderInterval, 30, 'an update without the key keeps it');
  assert.equal(validatePhysicsConfig(set, { awakeReorderInterval: 0 }).awakeReorderInterval, 0, 'and 0 turns it off');
});

/** The shipped module behind physicsApi.js's PhysicsWorld, with ten boxes moving and the awake order scrambled. */
function scrambledWorld() {
  const { memory, fn } = instantiateBox2dWasm(['world_set_awake_reorder_interval', 'get_body_move_byte_offset']);
  const Module = { cwrap: (name) => (...args) => fn(name)(...args) };
  const { PhysicsWorld } = new Function('Module', `${apiSource}\nreturn createPhysicsApi(Module);`)(Module);
  const world = new PhysicsWorld(0, 0, { lengthUnitsPerMeter: 1, numberOfPhysicsWorkers: 1 });
  world.enableSleeping(false);
  // PhysicsWorld.bindBuffers also binds the query views, which need the glue's heap views: the export does the tables.
  assert.equal(fn('bind_game_buffers')(64, 0), 1);
  const box = (entity, x) => {
    const slot = fn('create_body_box')(
      world.worldId, BODY_DYNAMIC, x, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, entity,
    );
    assert.equal(slot, entity);
    fn('body_set_linear_velocity')(entity, 60, 0);
  };
  for (let entity = 0; entity < 10; entity++) box(entity, entity * 10);
  // Entity 2's body leaves: the last awake body (entity 9) takes its place in Box2D's awake set, and entity 10's new
  // body takes entity 2's body id and the end of the awake set.
  fn('destroy_body')(2);
  box(10, 20);
  const step = () => {
    fn('step_world')(world.worldId, 1 / 60, 4);
    const moved = new Int32Array(memory.buffer, fn('get_body_move_byte_offset')(), fn('get_body_move_count')());
    return Array.from(moved);
  };
  return { world, step };
}

test('without the setting the moved list keeps the awake order a removal and a creation left', () => {
  const { step } = scrambledWorld();
  assert.deepEqual(step(), [0, 1, 9, 3, 4, 5, 6, 7, 8, 10]);
  assert.deepEqual(step(), [0, 1, 9, 3, 4, 5, 6, 7, 8, 10]);
});

test('PhysicsWorld.setAwakeReorderInterval reaches the world: the bodies come back in body id order', () => {
  const { world, step } = scrambledWorld();
  world.setAwakeReorderInterval(1);
  // Entity 10's body has entity 2's old body id: id order puts it third.
  assert.deepEqual(step(), [0, 1, 10, 3, 4, 5, 6, 7, 8, 9]);
});

test('a config update reaches the world: applyPhysicsConfig, then weedjsApplyConfig, as shipped', () => {
  const calls = [];
  const fakeWorld = {
    setAwakeReorderInterval: (steps) => calls.push(steps),
    enableSleeping() {},
    setHitEventThreshold() {},
  };
  const weedjsApplyConfig = new Function(
    'world',
    `let sleepingEnabled = true, hostSubSteps = 4, hostEntityCount = 0, publishContactRing = true;
    ${functionSource(postSource, 'weedjsApplyConfig')}
    return weedjsApplyConfig;`,
  )(fakeWorld);
  const state = { config: { physics: {} }, settings: null, box2dReady: true, sleepingEnabled: true };
  const applyPhysicsConfig = new Function(
    'state', 'validatePhysicsConfig', 'PHYSICS_DEFAULTS', 'weedjsApplyConfig',
    `${functionSource(hostSource, 'applyPhysicsConfig')}\nreturn applyPhysicsConfig;`,
  )(state, validatePhysicsConfig, PHYSICS_SIM_DEFAULTS, weedjsApplyConfig);

  applyPhysicsConfig({ awakeReorderInterval: 30 });
  applyPhysicsConfig({ subStepCount: 2 });
  applyPhysicsConfig({ awakeReorderInterval: 0 });
  assert.deepEqual(calls, [30, 30, 0]);
});

test('the world starts with the scene\'s interval: the host sends it in WEEDJS_INIT and handleInit sets it', () => {
  // handleInit and the init payload need a whole physics worker; their two lines are checked where they are.
  const init = functionSource(postSource, 'handleInit');
  assert.match(init, /world\.setStepSpin\([^)]*\);\s*\/\/[^\n]*\n\s*world\.setAwakeReorderInterval\(data\.awakeReorderInterval \| 0\);/);
  assert.match(hostSource, /type: 'WEEDJS_INIT',[\s\S]*?awakeReorderInterval: s\.awakeReorderInterval,[\s\S]*?maxBodies:/);
});
