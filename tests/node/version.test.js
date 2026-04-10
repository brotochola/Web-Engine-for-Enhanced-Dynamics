import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('WEED.VERSION matches package.json version', { concurrency: false }, async () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  );
  const { default: WEED } = await import('../../src/index.js');

  assert.equal(WEED.VERSION, packageJson.version);
});
