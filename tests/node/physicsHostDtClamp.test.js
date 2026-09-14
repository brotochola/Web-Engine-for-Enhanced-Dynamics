import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// physics_host.impl.js is a classic IIFE worker script (no import/export,
// guarded by `typeof weedjsEnableHostMode !== 'function'` early-return at the
// top) - not directly instantiable in a Node test the way ES-module workers
// like AbstractWorker.js are. Source-text assertion matches the existing
// convention for this exact situation (see gpuSortKeyNoCpuSort.test.js).
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const physicsHost = readFileSync(join(root, 'src/box2d/physicsHostImpl.js'), 'utf8');

test('physics_host gameLoop uses constant dt when fixedFps is set', () => {
  assert.match(
    physicsHost,
    /dt = 1 \/ state\.fixedFps/,
    'fixedFps must step with constant 1/fixedFps, not wall-clock dt',
  );
  assert.match(
    physicsHost,
    /var maxDt = 1 \/ 20;/,
    'variable-dt path still caps at 1/20 when fixedFps is off',
  );
  assert.doesNotMatch(
    physicsHost,
    /var maxDt = state\.fixedFps > 0 \? 1 \/ state\.fixedFps : 1 \/ 20;/,
    'fixedFps must not only cap wall dt; it must replace it',
  );
});
