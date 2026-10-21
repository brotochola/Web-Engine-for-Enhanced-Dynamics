import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('the bunny mark scene opts into skipCull', () => {
  const scene = readFileSync(fileURLToPath(new URL('../bunnyMarkScene/bunnyMarkScene.js', import.meta.url)), 'utf8');
  assert.match(scene, /skipCull:\s*true/);
});
