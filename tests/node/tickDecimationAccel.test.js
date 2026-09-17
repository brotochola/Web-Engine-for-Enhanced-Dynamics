import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const weedjsPost = readFileSync(join(root, 'src/box2d/weedjsPost.js'), 'utf8');
const logicWorker = readFileSync(join(root, 'src/workers/logicWorker.js'), 'utf8');

test('Box2D keeps dynamic ax after ApplyForce; static still zeros', () => {
  const start = weedjsPost.indexOf('function applyForcesAndTorque()');
  assert.ok(start >= 0, 'applyForcesAndTorque missing');
  const end = weedjsPost.indexOf('function entityGen(', start);
  assert.ok(end > start, 'entityGen should follow applyForcesAndTorque');
  const fn = weedjsPost.slice(start, end);
  const applyIdx = fn.indexOf('bodyApplyForceCenterFn');
  assert.ok(applyIdx > 0, 'ApplyForce missing');
  assert.match(fn.slice(0, applyIdx), /views\.ax\[i\] = 0/);
  assert.doesNotMatch(fn.slice(applyIdx), /views\.ax\[i\] = 0/);
});

test('logicWorker replaces ax on tick and does not scale by tickInterval', () => {
  assert.doesNotMatch(logicWorker, /rbAx\[entityIndex\] \*= tickInterval/);
  assert.doesNotMatch(logicWorker, /rbAy\[entityIndex\] \*= tickInterval/);
  assert.match(logicWorker, /rbAx\[entityIndex\] = 0;/);
});
