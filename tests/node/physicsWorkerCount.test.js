import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { validatePhysicsConfig } from '../../src/util/utils.js';
import { BOX2D_MAX_WORKERS } from '../../src/util/configDefaults.js';

// B27. a585e598 renamed physics.box2dWorkerCount to numberOfPhysicsWorkers with
// no alias: the old key was silently ignored (the bundle test page still set
// it, so its worker option did nothing). The physics host also passed the count
// to Box2D unclamped. It is now clamped to 1..B2_MAX_WORKERS, and the old key
// still works, with a warning.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const host = readFileSync(join(root, 'src/box2d/physicsHostImpl.js'), 'utf8');

function hostWorkerCount() {
  const start = host.indexOf('// worker-count-start');
  const end = host.indexOf('// worker-count-end');
  assert.ok(start >= 0 && end > start, 'worker count block missing in physicsHostImpl.js');
  return new Function(`${host.slice(start, end)}\nreturn { physicsWorkerCount, BOX2D_MAX_WORKERS };`)();
}

test('the physics host clamps the worker count and accepts the old key', () => {
  const { physicsWorkerCount, BOX2D_MAX_WORKERS: hostMax } = hostWorkerCount();
  assert.equal(hostMax, BOX2D_MAX_WORKERS, 'host mirror of B2_MAX_WORKERS');
  const base = { numberOfPhysicsWorkers: 4 };
  assert.equal(physicsWorkerCount({ numberOfPhysicsWorkers: 2 }, base), 2);
  assert.equal(physicsWorkerCount({ numberOfPhysicsWorkers: 99 }, base), BOX2D_MAX_WORKERS);
  assert.equal(physicsWorkerCount({ numberOfPhysicsWorkers: 0 }, base), 1);
  assert.equal(physicsWorkerCount({ numberOfPhysicsWorkers: 'x' }, base), 1);
  assert.equal(physicsWorkerCount({}, base), 4);

  const warn = console.warn;
  const warns = [];
  console.warn = (m) => warns.push(String(m));
  try {
    assert.equal(physicsWorkerCount({ box2dWorkerCount: 3 }, base), 3);
    assert.equal(physicsWorkerCount({ box2dWorkerCount: 5 }, base), 5);
    assert.equal(physicsWorkerCount({ numberOfPhysicsWorkers: 6, box2dWorkerCount: 3 }, base), 6, 'new key wins');
  } finally {
    console.warn = warn;
  }
  assert.equal(warns.length, 1, 'warned once');
  assert.match(warns[0], /box2dWorkerCount is now numberOfPhysicsWorkers/);
  assert.match(host, /numberOfPhysicsWorkers: physicsWorkerCount\(n, base\)/);
});

test('the main-side validator takes the old key too', () => {
  assert.equal(validatePhysicsConfig(null, { box2dWorkerCount: 2 }).numberOfPhysicsWorkers, 2);
  assert.equal(validatePhysicsConfig(null, { box2dWorkerCount: 99 }).numberOfPhysicsWorkers, BOX2D_MAX_WORKERS);
  assert.equal(validatePhysicsConfig(null, { numberOfPhysicsWorkers: 3, box2dWorkerCount: 2 }).numberOfPhysicsWorkers, 3);
});

test('the bundle test page sets the current key', () => {
  const page = readFileSync(join(root, 'scripts/bundle-test/index.html'), 'utf8');
  assert.ok(!/box2dWorkerCount/.test(page));
  assert.match(page, /numberOfPhysicsWorkers: box2dWorkers > 0 \? box2dWorkers : 4/);
});
