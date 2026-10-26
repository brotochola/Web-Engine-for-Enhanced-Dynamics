import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePreRenderInterpolation } from '../../src/util/configDefaults.js';
import { poseDisplayAlpha, poseLerp } from '../../src/render/poseQueueInterp.js';
import {
  INSTANCED_SPRITE_FLOATS,
  POSE_DYN_FLOATS,
  POSE_STATIC_FLOATS,
} from '../../src/render/instancedSpriteBatch.js';

const dir = dirname(fileURLToPath(import.meta.url));
const batchSrc = readFileSync(join(dir, '../../src/render/instancedSpriteBatch.js'), 'utf8');

test('preRender.interpolation is a boolean', () => {
  assert.equal(resolvePreRenderInterpolation(false), false);
  assert.equal(resolvePreRenderInterpolation(undefined), false);
  assert.equal(resolvePreRenderInterpolation(null), false);
  assert.equal(resolvePreRenderInterpolation(true), true);
});

test('pose alpha snaps when queue counts differ', () => {
  assert.equal(poseDisplayAlpha(4, 4, 0.25), 0.25);
  assert.equal(poseDisplayAlpha(4, 5, 0.25), 1);
  assert.equal(poseDisplayAlpha(0, 3, 0), 1);
});

test('pose lerp is prev at 0, cur at 1, midpoint at 0.5', () => {
  assert.equal(poseLerp(10, 30, 0), 10);
  assert.equal(poseLerp(10, 30, 1), 30);
  assert.equal(poseLerp(10, 30, 0.5), 20);
  assert.equal(poseLerp(0, 8, 0.25), 2);
});

test('a pose instance is the 15-float record and the previous xy, in two streams (E-82)', () => {
  assert.equal(INSTANCED_SPRITE_FLOATS, 15);
  // Pose stream: x, y, rotC, rotS, prevX, prevY. Statics: the other 11 terms.
  assert.equal(POSE_DYN_FLOATS, 6);
  assert.equal(POSE_STATIC_FLOATS, 11);
  assert.equal(POSE_DYN_FLOATS + POSE_STATIC_FLOATS, INSTANCED_SPRITE_FLOATS + 2);
});

test('flag off keeps the 16-float upload; pose pack is a separate method', () => {
  assert.match(batchSrc, /if \(this\.poseInterp\) return this\._uploadPose/);
  assert.match(batchSrc, /_finishUpload\(out, this\._strideBytes\)/);
  assert.match(batchSrc, /_finishUpload\(out, POSE_DYN_FLOATS \* 4\)/);
  assert.match(batchSrc, /uniforms\.uPoseAlpha = alpha/);
  assert.match(batchSrc, /group\.update\(\)/);
  assert.doesNotMatch(
    batchSrc.slice(batchSrc.indexOf('upload(q, opts)'), batchSrc.indexOf('_uploadPose')),
    /POSE_DYN_FLOATS/
  );
});
