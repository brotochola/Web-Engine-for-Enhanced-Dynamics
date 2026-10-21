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
const implSource = readFileSync(join(root, 'src/box2d/physicsConfigImpl.js'), 'utf8');

// N-15. The physics host and utils.js had one validatePhysicsConfig each, and
// they had drifted. Both now use physicsConfigImpl.js. Evaluated here the way
// importScripts loads it into the host: a classic script on its own global.
function classicPhysicsConfig() {
  const global = {};
  new Function('globalThis', 'self', implSource)(global, global);
  return global.WeedPhysicsConfig;
}

test('the physics host clamps the worker count and accepts the old key', () => {
  const { physicsWorkerCount, BOX2D_MAX_WORKERS: hostMax } = classicPhysicsConfig();
  assert.equal(hostMax, BOX2D_MAX_WORKERS, 'one B2_MAX_WORKERS');
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
});

test('the host and the main side share one validator and one set of defaults', async () => {
  const { PHYSICS_DEFAULTS } = await import('../../src/util/configDefaults.js');
  const classic = classicPhysicsConfig();
  // Every simulation default the host uses is the one configDefaults documents.
  const flat = (o, p = '') =>
    Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));
  for (const [key, value] of flat(classic.PHYSICS_SIM_DEFAULTS)) {
    assert.deepEqual(flat(PHYSICS_DEFAULTS).find(([k]) => k === key)?.[1], value, `PHYSICS_DEFAULTS.${key}`);
  }
  // The same input gives the same settings on both sides, clamps included.
  const input = { contactHertz: -5, gravity: { y: 980 }, contactRingCapacity: 10, hitEventThreshold: Number.NaN, liquidFun: { maxCount: 1e9 } };
  assert.deepEqual(classic.validatePhysicsConfig(null, input), validatePhysicsConfig(null, input));
  const merged = validatePhysicsConfig(null, input);
  assert.equal(merged.contactHertz, 0);
  assert.deepEqual(merged.gravity, { x: 0, y: 980 });
  assert.equal(merged.contactRingCapacity, 256);
  assert.equal(merged.hitEventThreshold, 0);
  assert.equal(merged.sleeping, true);
  assert.equal(merged.liquidFun.maxCount, 65535);
  // A partial update keeps the other gravity axis (the host's copy zeroed it).
  assert.deepEqual(validatePhysicsConfig(merged, { gravity: { x: 5 } }).gravity, { x: 5, y: 980 });
  // The host keeps no copy of its own.
  assert.doesNotMatch(host, /function validatePhysicsConfig|var PHYSICS_DEFAULTS = \{/);
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
