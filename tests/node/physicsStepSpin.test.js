import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { stepSpinPays } from '../../src/box2d/physicsConfig.js';

// E-298 made Box2D's pool threads spin through a step instead of sleeping between its phases. On a 2-core / 4-thread
// laptop (13 engine threads in Predator) the spinners starved the other workers and the physics thread itself. The spin
// now stays only where every engine thread has a logical CPU of its own.

test('the step spin stays where every engine thread has a logical CPU', () => {
  assert.equal(stepSpinPays(16, 13), true); // Ryzen 7 4800H, Predator: 2 spatial, 4 logic, 3 others, 4 Box2D
  assert.equal(stepSpinPays(13, 13), true);
});

test('the step spin goes where the engine has more threads than logical CPUs', () => {
  assert.equal(stepSpinPays(4, 13), false); // i7-7500U laptop, Predator
  assert.equal(stepSpinPays(12, 13), false);
});

test('an unknown CPU count keeps the spin', () => {
  assert.equal(stepSpinPays(0, 13), true);
  assert.equal(stepSpinPays(undefined, 13), true);
});

test('the physics host gets the same rule as the ESM side (one classic script for both)', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const global = {};
  new Function('globalThis', 'self', readFileSync(join(root, 'src/box2d/physicsConfigImpl.js'), 'utf8'))(global, global);
  assert.equal(global.WeedPhysicsConfig.stepSpinPays(4, 13), false);
  assert.equal(global.WeedPhysicsConfig.stepSpinPays(16, 13), true);
});
