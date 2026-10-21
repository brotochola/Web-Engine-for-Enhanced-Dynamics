import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// B7. The physics host scaled a frame's dt by Time.scale and then capped it at
// 1/30 s, so Time.scale above 2 at 60 Hz ran at 2 and fixedFps under 30 ran
// slow. A long frame is now several ordinary steps: physics seconds follow
// game seconds up to 4 steps a frame, and each step is the one Box2D and
// LiquidFun are tuned for (no larger dt, no fewer collision checks).

const host = readFileSync(new URL('../../src/box2d/physicsHostImpl.js', import.meta.url), 'utf8');
const post = readFileSync(new URL('../../src/box2d/weedjsPost.js', import.meta.url), 'utf8');

function block(src, name) {
  const start = src.indexOf(`// ${name}-start`);
  const end = src.indexOf(`// ${name}-end`);
  assert.ok(start > 0 && end > start, `${name} block missing`);
  return src.slice(start, end);
}

const splitFrameDt = new Function(`${block(host, 'b7-split')}\nreturn splitFrameDt;`)();

test('Time.scale 3 at 60 Hz and fixedFps 20 keep physics seconds equal to game seconds', () => {
  const scaled = splitFrameDt((1 / 60) * 3);
  assert.equal(scaled.steps, 2);
  assert.ok(Math.abs(scaled.dt * scaled.steps - 3 / 60) < 1e-12);
  assert.ok(scaled.dt <= 1 / 30);
  const lockstep = splitFrameDt(1 / 20);
  assert.equal(lockstep.steps, 2);
  assert.ok(Math.abs(lockstep.dt - 1 / 40) < 1e-12);
});

test('an ordinary frame is one step of its own dt; a long hitch is cut at 4 stable steps', () => {
  assert.deepEqual({ ...splitFrameDt(1 / 60) }, { dt: 1 / 60, steps: 1 });
  assert.equal(splitFrameDt(1 / 30).steps, 1, 'exactly the stable step is one step');
  const hitch = splitFrameDt((1 / 20) * 4);
  assert.equal(hitch.steps, 4);
  assert.equal(hitch.dt, 1 / 30);
});

function hostStepLoop(steps, radialGravityAccel = 0) {
  const calls = [];
  const world = {
    step: (dt, sub) => calls.push(`step ${dt} ${sub}`),
    _getBodyMoveCount: () => world._moves.length,
    _bodyMoved: null,
    _bodyFellAsleep: null,
    _moves: [],
  };
  const fns = new Function(
    'world', 'calls', 'hostSteps', 'hostEntityCount', 'radialGravityAccel',
    `let gatherMovedSlots = null, gatherMovedAsleep = null, gatherMovedAt = null, gatherMovedCount = 0;
    function applyForcesAndTorque() { calls.push('forces'); }
    function cullLiquidFunOutsideWorld() { calls.push('cull'); }
    function applyRadialGravity(dt) { calls.push('radial ' + dt); }
    function publishContactRingFromWasm() { calls.push('contacts'); }
    function publishHitsFromWasm() { calls.push('hits'); }
    function publishJointBreaksFromWasm() { calls.push('joints'); }
    ${block(post, 'b7-steps')}
    return { stepWorld, gatherMovedFromStep, gathered: () => ({ count: gatherMovedCount, slots: gatherMovedSlots, asleep: gatherMovedAsleep }) };`,
  )(world, calls, steps, 16, radialGravityAccel);
  return { calls, world, ...fns };
}

test('each extra step gets its forces again and gives its events out; the last is left to afterStep', () => {
  const { calls, stepWorld } = hostStepLoop(3);
  stepWorld(0.025, 4);
  assert.deepEqual(calls, [
    'step 0.025 4', 'contacts', 'hits', 'joints',
    'forces', 'cull', 'step 0.025 4', 'contacts', 'hits', 'joints',
    'forces', 'cull', 'step 0.025 4',
  ]);
  const one = hostStepLoop(1);
  one.stepWorld(1 / 60, 4);
  assert.deepEqual(one.calls, [`step ${1 / 60} 4`], 'one step: exactly as before');
});

test('LiquidFun radial gravity (N-17) pulls before every step of the frame, the first included', () => {
  const { calls, stepWorld } = hostStepLoop(2, 1800);
  stepWorld(0.025, 4);
  assert.deepEqual(calls, [
    'radial 0.025', 'step 0.025 4', 'contacts', 'hits', 'joints',
    'forces', 'cull', 'radial 0.025', 'step 0.025 4',
  ]);
});

test('a body moved in any step is published once, with its latest asleep flag', () => {
  const t = hostStepLoop(2);
  t.world._bodyMoved = Int32Array.of(3, 7);
  t.world._bodyFellAsleep = Uint8Array.of(0, 0);
  t.world._moves = [3, 7];
  t.gatherMovedFromStep();
  t.world._bodyMoved = Int32Array.of(7, 9);
  t.world._bodyFellAsleep = Uint8Array.of(1, 0);
  t.world._moves = [7, 9];
  t.gatherMovedFromStep();
  const g = t.gathered();
  assert.equal(g.count, 3);
  assert.deepEqual(Array.from(g.slots.subarray(0, 3)), [3, 7, 9], 'body 3 moved only in the first step');
  assert.deepEqual(Array.from(g.asleep.subarray(0, 3)), [0, 1, 0], 'body 7 fell asleep in the second');
});
