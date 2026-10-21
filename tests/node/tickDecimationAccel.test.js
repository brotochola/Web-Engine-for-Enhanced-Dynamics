import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const weedjsPost = readFileSync(join(root, 'src/box2d/weedjsPost.js'), 'utf8');
const logicWorker = readFileSync(join(root, 'src/workers/logicWorker.js'), 'utf8');

// M8: the host's force pass, run (not read). angularMass (N-4) and the pass
// are sliced out of weedjsPost.js and given fake views and recording WASM calls.
function hostForcePass() {
  const massStart = weedjsPost.indexOf('// angular-mass-start');
  const massEnd = weedjsPost.indexOf('// angular-mass-end');
  const start = weedjsPost.indexOf('function applyForcesAndTorque()');
  const end = weedjsPost.indexOf('function entityGen(', start);
  assert.ok(massStart > 0 && massEnd > massStart && start > 0 && end > start, 'force pass not found in weedjsPost.js');
  return new Function(
    'denseList', 'views', 'bodyApplyForceCenterFn', 'bodyApplyTorqueFn',
    `let denseCount = denseList.length;
    function isFixedRotation(i) { return !!(views.fixedRotation && views.fixedRotation[i]); }
    ${weedjsPost.slice(massStart, massEnd)}
    ${weedjsPost.slice(start, end)}
    return applyForcesAndTorque;`,
  );
}

test('Box2D keeps dynamic ax after ApplyForce; static still zeros', () => {
  // Body 0 static, 1 dynamic, 2 dynamic with fixed rotation.
  const views = {
    rbStatic: Uint8Array.of(1, 0, 0),
    fixedRotation: Uint8Array.of(0, 0, 1),
    mass: Float32Array.of(5, 2, 3),
    inertia: Float32Array.of(0, 7, 4),
    ax: Float32Array.of(9, 3, 1),
    ay: Float32Array.of(9, -1, 0),
    angularAccel: Float32Array.of(9, 0.5, 2),
  };
  const forces = [];
  const torques = [];
  const pass = hostForcePass()(
    [0, 1, 2],
    views,
    (i, fx, fy) => forces.push([i, fx, fy]),
    (i, t) => torques.push([i, t]),
  );
  pass();
  assert.deepEqual([views.ax[0], views.ay[0], views.angularAccel[0]], [0, 0, 0], 'a static body is zeroed');
  assert.deepEqual(forces, [[1, 6, -2], [2, 3, 0]], 'force = a × mass, nothing for the static body');
  assert.deepEqual(torques, [[1, 3.5]], 'torque = angularAccel × inertia (N-4); none with fixed rotation');
  assert.deepEqual(Array.from(views.ax), [0, 3, 1], 'dynamic ax is kept for the next step');
});

test('logicWorker replaces ax on tick and does not scale by tickInterval', () => {
  assert.doesNotMatch(logicWorker, /rbAx\[entityIndex\] \*= tickInterval/);
  assert.doesNotMatch(logicWorker, /rbAy\[entityIndex\] \*= tickInterval/);
  assert.match(logicWorker, /rbAx\[entityIndex\] = 0;/);
});
