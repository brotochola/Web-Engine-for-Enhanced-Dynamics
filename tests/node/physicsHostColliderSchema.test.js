import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Collider } from '../../src/components/collider.js';

test('physicsHostImpl COLLIDER_SCHEMA keys match Collider.ARRAY_SCHEMA', () => {
  const host = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../src/box2d/physicsHostImpl.js'),
    'utf8',
  );
  const start = host.indexOf('var COLLIDER_SCHEMA = {');
  assert.ok(start >= 0, 'missing COLLIDER_SCHEMA');
  const end = host.indexOf('\n  };', start);
  assert.ok(end > start, 'unclosed COLLIDER_SCHEMA');
  const block = host.slice(start, end);
  const keys = [...block.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(keys, Object.keys(Collider.ARRAY_SCHEMA));
});
