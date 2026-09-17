import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION } from '../../src/version.js';
import { SharedAtomicPool } from '../../src/core/sharedAtomicPool.js';
import { DEBUG_SELECTED_ENTITY_OFFSET } from '../../src/core/debug/debugFlags.js';

test('WEED namespace keeps version and bullet APIs aligned', { concurrency: false }, async () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  );
  const { default: WEED } = await import('../../src/index.js');

  assert.equal(WEED.VERSION, packageJson.version);
  assert.equal(VERSION, packageJson.version);
  assert.ok(SharedAtomicPool);
  assert.equal(WEED.enums.DEBUG_SELECTED_ENTITY_OFFSET, DEBUG_SELECTED_ENTITY_OFFSET);
  assert.ok(WEED.BulletPool);
  assert.ok(WEED.BulletComponent);
});
