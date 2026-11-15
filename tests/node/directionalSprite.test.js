// DX-DIRSPRITE on real code: a sheet's direction table (names, degrees, the count form, mirrored sides, the
// <name>_<direction> sheets), the direction picked for a facing and its margin, and what the component draws: the
// animation and flip of the direction its facing (manual, velocity, rotation) is nearest, a pinned animation, the
// name a finished play-once animation is heard by, and the logic worker's pass with onDirectionChanged.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildDirectionTable, detectDirectionGroups, pickDirection } from '../../src/core/spriteDirections.js';
import { DirectionalSprite, FACING_FROM, NO_DIRECTION } from '../../src/components/directionalSprite.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Transform } from '../../src/components/transform.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { GameObject } from '../../src/core/gameObject.js';
import { resetWarnOnce } from '../../src/util/dxWarn.js';
import { collectComponents } from '../../src/util/utils.js';

const DEG = Math.PI / 180;
const N = 8;
const LPC = ['walk_up', 'walk_left', 'walk_down', 'walk_right', 'idle_up', 'idle_left', 'idle_down', 'idle_right', 'slash_left', 'die'];

function bind() {
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(N)), N);
  DirectionalSprite.initializeArrays(new SharedArrayBuffer(DirectionalSprite.getBufferSize(N)), N);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  for (const k of ['x', 'y', 'rotC', 'rotS']) Transform[k] = new Float32Array(N);
  for (const k of ['vx', 'vy']) RigidBody[k] = new Float32Array(N);
  Transform.rotC.fill(1);
  LightEmitter.clearArrays();
  DirectionalSprite._tables = [];
}

/** A proxy sheet as the scene installs it: its animations by index and its table. */
function sheet(name, animations, spec) {
  const indexToName = {};
  const anims = {};
  animations.forEach((n, k) => {
    indexToName[k] = n;
    anims[n] = { originalName: n, index: k };
  });
  const directions = buildDirectionTable(name, spec, animations);
  SpriteSheetRegistry.registerProxy(name, { isProxy: true, targetSheet: 'bigAtlas', prefix: `${name}_`, animations: anims, indexToName, directions });
  SpriteSheetRegistry.frameDimensions.set(name, new Map());
  return SpriteSheetRegistry.getSpritesheetId(name);
}

function entity(i, sheetId, { from = FACING_FROM.MANUAL, facing = Math.PI / 2 } = {}) {
  SpriteRenderer.active[i] = 1;
  SpriteRenderer.scaleX[i] = 1;
  SpriteRenderer.scaleY[i] = 1;
  SpriteRenderer.spritesheetId[i] = sheetId;
  SpriteRenderer.animationState[i] = 255;
  DirectionalSprite.resetRow(i);
  DirectionalSprite.facingFrom[i] = from;
  DirectionalSprite.facing[i] = facing;
  const ds = Object.create(DirectionalSprite.prototype);
  Object.defineProperty(ds, 'index', { value: i });
  return ds;
}

const animOf = (i) => SpriteSheetRegistry.getAnimationName(SpriteSheetRegistry.getSpritesheetName(SpriteRenderer.spritesheetId[i]), SpriteRenderer.animationState[i]);

beforeEach(() => {
  SpriteSheetRegistry.clearForSceneUnload();
  resetWarnOnce();
  bind();
});

test('a sheet named <name>_<direction> gives one group per name, with the directions it has', () => {
  assert.deepEqual(detectDirectionGroups(LPC), {
    walk: { up: 'walk_up', left: 'walk_left', down: 'walk_down', right: 'walk_right' },
    idle: { up: 'idle_up', left: 'idle_left', down: 'idle_down', right: 'idle_right' },
    slash: { left: 'slash_left' },
  });
  const t = buildDirectionTable('civil', undefined, LPC);
  assert.deepEqual(t.groups, ['walk', 'idle', 'slash']);
  assert.deepEqual(t.names, ['right', 'down', 'left', 'up']);
  assert.equal(t.count, 4);
  assert.equal(t.uniform, true);
  // slash has only its left: every direction draws it.
  assert.deepEqual(t.anim.slice(8, 12), [8, 8, 8, 8]);
  assert.equal(t.groupOfAnim[LPC.indexOf('walk_down')], 0);
  assert.equal(t.groupOfAnim[LPC.indexOf('die')], -1);
  assert.equal(buildDirectionTable('civil', false, LPC), null);
  assert.equal(buildDirectionTable('rock', undefined, ['rock']), null);
});

test('degrees, names, flips, the count form and mirrorX build the same kind of table', () => {
  const problems = [];
  const t = buildDirectionTable('gaucho', {
    walk: { down: 'walk_front', up: 'walk_back', right: 'walk_side', left: { anim: 'walk_side', flipX: true } },
  }, ['walk_front', 'walk_back', 'walk_side'], problems);
  assert.deepEqual(problems, []);
  assert.deepEqual(t.names, ['right', 'down', 'left', 'up']);
  assert.deepEqual(t.flip, [0, 0, 1, 0]);
  assert.equal(t.hasFlip, true);

  const car = buildDirectionTable('hatch', { drive: { count: 8, anims: 'd{i}' } }, ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
  assert.equal(car.count, 8);
  assert.deepEqual(car.names, ['0', '1', '2', '3', '4', '5', '6', '7']);
  assert.ok(Math.abs(car.angles[2] - Math.PI / 2) < 1e-12, 'clockwise on the screen: the third looks south');
  const ccw = buildDirectionTable('hatch', { drive: { count: 4, clockwise: false, anims: 'd{i}' } }, ['d0', 'd1', 'd2', 'd3']);
  assert.equal(ccw.anim[ccw.names.indexOf('1')], 1);
  assert.ok(Math.abs(ccw.angles[ccw.names.indexOf('1')] - 1.5 * Math.PI) < 1e-12, 'counter-clockwise: the second looks north');

  // Half a turn drawn, the rest mirrored: heading a looks like 180° - a.
  const half = buildDirectionTable('taxi', { drive: { 0: '0', 45: '45', 90: '90', 270: '270', 315: '315', mirrorX: true } },
    ['0', '45', '90', '270', '315']);
  assert.equal(half.count, 8);
  const at = (deg) => half.angles.findIndex((a) => Math.abs(a - deg * DEG) < 1e-9);
  assert.equal(half.anim[at(135)], 1);
  assert.equal(half.flip[at(135)], 1);
  assert.equal(half.anim[at(180)], 0);
  assert.equal(half.flip[at(180)], 1);
  assert.equal(half.flip[at(90)], 0, 'a drawn direction is not mirrored over itself');
});

test('a wrong spec names each mistake and keeps the rest', () => {
  const problems = [];
  const t = buildDirectionTable('s', { walk: { up: 'walk_up', sideways: 'walk_left', down: 'nope' }, idle: 'idle_down' }, LPC, problems);
  assert.deepEqual(t.groups, ['walk']);
  assert.equal(problems.length, 3);
  assert.match(problems.join('\n'), /directions\.walk\.sideways: not a direction/);
  assert.match(problems.join('\n'), /directions\.walk\.down: no animation "nope"/);
  assert.match(problems.join('\n'), /directions\.idle: an object of directions/);
});

test('the nearest direction, kept until the facing is past the border by the margin', () => {
  const t = buildDirectionTable('civil', undefined, LPC);
  const right = t.names.indexOf('right');
  const down = t.names.indexOf('down');
  assert.equal(pickDirection(t, 80 * DEG, NO_DIRECTION, 0), down);
  assert.equal(pickDirection(t, -10 * DEG, NO_DIRECTION, 0), right);
  assert.equal(pickDirection(t, 359 * DEG, NO_DIRECTION, 0), right);
  const margin = 9 * DEG;
  assert.equal(pickDirection(t, 47 * DEG, right, margin), right, 'past the border by 2°: within the margin');
  assert.equal(pickDirection(t, 50 * DEG, right, margin), down, 'past it by 5°: half the margin is spent on each side');
  // An uneven set takes the nearest the slow way.
  const odd = buildDirectionTable('odd', { walk: { 0: 'a', 100: 'b', 200: 'c' } }, ['a', 'b', 'c']);
  assert.equal(odd.uniform, false);
  assert.equal(pickDirection(odd, 160 * DEG, NO_DIRECTION, 0), odd.names.indexOf('200'));
});

test('the component draws the direction its manual facing is nearest, and the name of it', () => {
  const id = sheet('civil', LPC);
  const ds = entity(0, id);
  assert.equal(DirectionalSprite.setGroup(0, 'walk'), true);
  assert.equal(animOf(0), 'walk_down');
  assert.equal(ds.direction, 'down');
  ds.facing = Math.PI;
  assert.equal(animOf(0), 'walk_left');
  ds.lookAt(Transform.x[0], Transform.y[0] - 50);
  assert.equal(animOf(0), 'walk_up');
  assert.equal(ds.direction, 'up');
  assert.equal(DirectionalSprite.setGroup(0, 'idle'), true);
  assert.equal(animOf(0), 'idle_up', 'a new animation keeps the direction');
  assert.equal(DirectionalSprite.setGroup(0, 'walk_left'), false, 'a plain name is not a group');
  assert.deepEqual(ds.directions, ['right', 'down', 'left', 'up']);
  assert.ok(Math.abs(ds.turnMargin - 9 * DEG) < 1e-6, 'a tenth of the step');
});

test('velocity: a body faces where it moves and keeps the facing when it stops; without a body, the pose', () => {
  const id = sheet('civil', LPC);
  const ds = entity(0, id, { from: FACING_FROM.VELOCITY });
  RigidBody.active[0] = 1;
  DirectionalSprite.setGroup(0, 'walk');
  RigidBody.vx[0] = -30;
  RigidBody.vy[0] = 5;
  DirectionalSprite.resolve(0);
  assert.equal(ds.direction, 'left');
  RigidBody.vx[0] = 0.5;
  RigidBody.vy[0] = 0;
  DirectionalSprite.resolve(0);
  assert.equal(ds.direction, 'left', 'slower than 4 px/s keeps the facing');

  entity(1, id, { from: FACING_FROM.VELOCITY });
  DirectionalSprite.setGroup(1, 'walk');
  Transform.y[1] = 10;
  DirectionalSprite.resolve(1);
  assert.equal(DirectionalSprite.directionIndex[1], 1, 'moved 10 px south between two resolves');
});

test('rotation: the heading picks the frame, and the sprite does not turn', () => {
  const id = sheet('hatch', ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'], { drive: { count: 8, anims: 'd{i}' } });
  const ds = entity(0, id, { from: FACING_FROM.ROTATION });
  SpriteRenderer.inheritTransformRotation[0] = 1;
  DirectionalSprite.resetRow(0);
  assert.equal(SpriteRenderer.inheritTransformRotation[0], 0);
  DirectionalSprite.facingFrom[0] = FACING_FROM.ROTATION;
  DirectionalSprite.setGroup(0, 'drive');
  Transform.rotC[0] = Math.cos(100 * DEG);
  Transform.rotS[0] = Math.sin(100 * DEG);
  DirectionalSprite.resolve(0);
  assert.equal(animOf(0), 'd2');
  assert.equal(ds.direction, '2');
  assert.ok(Math.abs(ds.directionAngle - Math.PI / 2) < 1e-12, 'the angle of the frame drawn, not of the heading');
});

test('a mirrored direction flips the sprite, and a light that follows the flip', () => {
  const id = sheet('gaucho', ['walk_front', 'walk_back', 'walk_side'], {
    walk: { down: 'walk_front', up: 'walk_back', right: 'walk_side', left: { anim: 'walk_side', flipX: true } },
  });
  const ds = entity(0, id, { facing: 0 });
  DirectionalSprite.setGroup(0, 'walk');
  assert.equal(SpriteRenderer.flip[0] & 1, 0);
  ds.facing = Math.PI;
  assert.equal(animOf(0), 'walk_side');
  assert.equal(SpriteRenderer.flip[0] & 1, 1);
  assert.equal(SpriteRenderer.scaleX[0], -1);
  ds.facing = Math.PI / 2;
  assert.equal(SpriteRenderer.flip[0] & 1, 0);
  assert.equal(SpriteRenderer.scaleX[0], 1);
});

test('a plain animation is pinned until the next directionless one; an ended one is heard by its group', () => {
  const id = sheet('civil', LPC);
  const ds = entity(0, id, { facing: Math.PI });
  DirectionalSprite.setGroup(0, 'walk');
  DirectionalSprite.pin(0, LPC.indexOf('die'));
  assert.equal(animOf(0), 'die');
  ds.facing = 0;
  assert.equal(animOf(0), 'die', 'facing does not move a pinned animation');
  assert.equal(DirectionalSprite.groupOf(0, LPC.indexOf('die')), null);
  DirectionalSprite.setGroup(0, 'slash');
  assert.equal(animOf(0), 'slash_left');
  assert.equal(DirectionalSprite.groupOf(0, LPC.indexOf('slash_left')), 'slash');
});

class Walker extends GameObject {
  static components = [DirectionalSprite];
}
// Stand-ins for a long component list (only their identity counts to collectComponents).
class RigidBodyLike {}
class PlainA {}
class PlainB {}
class PlainC {}
class PlainD {}
class PlainE {}
class PlainF {}
class PlainG {}

test('setAnimation on a directional entity: a group plays in its direction, a plain name is pinned, a missing one is said', () => {
  const id = sheet('civil', LPC);
  entity(0, id, { facing: 0 });
  assert.ok(collectComponents(Walker).includes(SpriteRenderer), 'DirectionalSprite brings its sprite');
  // Just before it, where a class listing it would have its sprite: the getter stays one of the fast slots.
  class Crowd extends GameObject {
    static components = [RigidBodyLike, DirectionalSprite, PlainA, PlainB, PlainC, PlainD, PlainE, PlainF, PlainG];
  }
  const list = collectComponents(Crowd);
  assert.equal(list.indexOf(SpriteRenderer), list.indexOf(DirectionalSprite) - 1);
  assert.ok(list.indexOf(SpriteRenderer) < 8, 'among the first eight (gameObject.js COMPONENT_FIELDS)');
  const w = Object.create(Walker.prototype);
  w.index = 0;
  w._hasComponents = { SpriteRenderer: true, DirectionalSprite: true };
  w.setAnimation('walk');
  assert.equal(animOf(0), 'walk_right');
  w.setAnimation('slash', false);
  assert.equal(animOf(0), 'slash_left');
  assert.equal(SpriteRenderer.loop[0], 0);
  w.setAnimation('idle_up');
  assert.equal(animOf(0), 'idle_up');
  const seen = [];
  const warn = console.warn;
  console.warn = (m) => seen.push(String(m));
  try {
    w.setAnimation('run');
    w.setAnimation('run');
  } finally {
    console.warn = warn;
  }
  assert.equal(seen.length, 1);
  assert.match(seen[0], /Walker\.setAnimation\('run'\): "run" is not one of sheet "civil"'s directionless animations \(walk, idle, slash\)/);
  assert.equal(animOf(0), 'idle_up', 'a missing name changes nothing');
});

test('the logic worker resolves after the ticks and tells the entity once per change', async () => {
  const { loadWorker } = await import('../bench/workerHarness.mjs');
  const logic = await loadWorker('logicWorker.js', 'logicWorker');
  SpriteSheetRegistry.clearForSceneUnload();
  bind();
  const id = sheet('civil', LPC);
  for (let i = 0; i < 3; i++) {
    entity(i, id, { from: FACING_FROM.VELOCITY });
    RigidBody.active[i] = 1;
    DirectionalSprite.setGroup(i, 'walk');
  }
  Transform.active.fill(1, 0, 3);
  const heard = [];
  const list = new Int32Array([3, 0, 1, 2]);
  const fake = {
    directionalTypes: [{ activeList: list, entityType: 0, hook: true }],
    totalLogicWorkers: 1,
    workerIndex: 0,
    gameObjects: [0, 1, 2].map((i) => ({ directionalSprite: { get direction() { return ['right', 'down', 'left', 'up'][DirectionalSprite.directionIndex[i]]; } }, onDirectionChanged: (d) => heard.push([i, d]) })),
    _directionChanged: logic._directionChanged,
    _entityThrew: () => assert.fail('threw'),
  };
  logic._resolveDirections.call(fake);
  assert.deepEqual(heard, [[0, 'down'], [1, 'down'], [2, 'down']], 'the first direction drawn is heard too');
  heard.length = 0;
  RigidBody.vx[1] = 40;
  logic._resolveDirections.call(fake);
  assert.deepEqual(heard, [[1, 'right']]);
  logic._resolveDirections.call(fake);
  assert.deepEqual(heard, [[1, 'right']], 'nothing new, nothing heard');
  assert.equal(animOf(1), 'walk_right');
});
