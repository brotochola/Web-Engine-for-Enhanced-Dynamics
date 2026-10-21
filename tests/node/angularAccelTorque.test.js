import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// N-4. The physics host applied RigidBody.angularAccel as a torque of
// angularAccel × mass, so it was not an angular acceleration: the car and the
// tree branch each multiplied by inertia / mass to get the rotation they wanted.
// The host now multiplies by the body's rotational inertia (the mass only for a
// body without one), and the demos ask for the acceleration itself.

const post = readFileSync(new URL('../../src/box2d/weedjsPost.js', import.meta.url), 'utf8');

function hostAngularMass() {
  const start = post.indexOf('// angular-mass-start');
  const end = post.indexOf('// angular-mass-end');
  assert.ok(start > 0 && end > start, 'angular mass block missing in weedjsPost.js');
  return new Function(`${post.slice(start, end)}\nreturn angularMass;`)();
}

test('angularAccel is turned into torque with the body\'s inertia', () => {
  const angularMass = hostAngularMass();
  const inertia = Float32Array.of(0, 7.5);
  assert.equal(angularMass(inertia, 1, 3), 7.5);
  assert.equal(angularMass(inertia, 0, 3), 3, 'no inertia: the mass, as before');
  assert.equal(angularMass(null, 0, 3), 3, 'no inertia view: the mass');
  assert.match(post, /bodyApplyTorqueFn\(i, aa \* angularMass\(views\.inertia, i, mass\), 1\)/);
});

