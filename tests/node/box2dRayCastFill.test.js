import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillRayCastHit } from '../../src/box2d/box2dRayCast.js';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('fillRayCastHit mutates the same out object', () => {
  const out = { hit: true, entityIndex: 9, fraction: 1, hitX: 1, hitY: 1 };
  const miss = fillRayCastHit(0, [1, 0.5, 3, 4], out);
  assert.equal(miss, out);
  assert.equal(out.hit, false);
  assert.equal(out.entityIndex, -1);
  assert.equal(out.fraction, 0);
  assert.equal(out.hitX, 0);
  assert.equal(out.hitY, 0);

  const hits = [17, 0.25, 8, 9];
  const hit = fillRayCastHit(1, hits, out);
  assert.equal(hit, out);
  assert.equal(out.hit, true);
  assert.equal(out.entityIndex, 17);
  assert.equal(out.fraction, 0.25);
  assert.equal(out.hitX, 8);
  assert.equal(out.hitY, 9);
});

test('serviceRayCast uses hoisted bits + returned scratch', () => {
  const post = fs.readFileSync(path.join(root, 'src/box2d/weedjsPost.js'), 'utf8');
  assert.match(post, /function serviceRayCastClosest\(/);
  assert.match(post, /castRayClosestBits/);
  assert.match(post, /rayHitScratch/);
  assert.match(post, /fillRayCastHit/);
  assert.doesNotMatch(post, /var castFn = function/);
  const api = fs.readFileSync(path.join(root, 'src/box2d/physicsApi.js'), 'utf8');
  assert.match(api, /castRayClosestBits\(/);
  const ring = fs.readFileSync(path.join(root, 'src/box2d/box2dRayCastImpl.js'), 'utf8');
  assert.match(ring, /var r = castFn\(ox, oy, dx, dy, cat, mask\) \|\| \{\}/);
});
