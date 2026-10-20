import test from 'node:test';
import assert from 'node:assert/strict';

import { avoidTurnSign } from '../../demos/littleCity/avoidSteer.js';

// One steering step under the engine's convention: a positive turn adds to the body angle
// (Car.applyForces -> angularAccel), and forward is (cos θ, sin θ) (GameObject.forwardX/Y).
function angleOff(theta, dx, dy) {
  const fx = Math.cos(theta);
  const fy = Math.sin(theta);
  return Math.abs(Math.atan2(fx * dy - fy * dx, fx * dx + fy * dy));
}

test('avoidance turns a car away from an obstacle on either side, at any heading', () => {
  for (const theta of [0, 0.7, -2.1, Math.PI]) {
    for (const [ax, lat] of [[100, 20], [100, -20], [80, 5], [80, -5], [150, 60]]) {
      // Obstacle `ax` ahead and `lat` to the side, in the car's frame.
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      const dx = c * ax - s * lat;
      const dy = s * ax + c * lat;
      const sign = avoidTurnSign(c, s, dx, dy);
      const after = angleOff(theta + 0.05 * sign, dx, dy);
      const before = angleOff(theta, dx, dy);
      assert.ok(after > before, `theta ${theta}, offset (${ax}, ${lat}): ${before} -> ${after}`);
    }
  }
});

test('road-seek and avoidance use opposite signs for the same offset', () => {
  const fx = 1;
  const fy = 0;
  const seek = Math.sign(fx * 20 - fy * 100); // trafficCar's cross(f, target) for target (100, 20)
  assert.equal(avoidTurnSign(fx, fy, 100, 20), -seek);
});
