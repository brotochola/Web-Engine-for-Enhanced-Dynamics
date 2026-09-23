import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePreRenderInterpolation } from '../../src/util/configDefaults.js';
import {
  poseDisplayAlpha,
  poseLerp,
  writePosePrev,
  POSE_PREV_OFFSET,
} from '../../src/render/poseQueueInterp.js';
import {
  INSTANCED_SPRITE_FLOATS,
  INSTANCED_SPRITE_POSE_FLOATS,
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

test('pose prev floats sit after the 15-float record', () => {
  assert.equal(INSTANCED_SPRITE_FLOATS, 15);
  assert.equal(INSTANCED_SPRITE_POSE_FLOATS, 17);
  assert.equal(POSE_PREV_OFFSET, 15);
  const data = new Float32Array(17);
  data[0] = 4;
  data[1] = 6;
  writePosePrev(data, 0, 1, 2);
  assert.equal(data[0], 4);
  assert.equal(data[1], 6);
  assert.equal(data[15], 1);
  assert.equal(data[16], 2);
  assert.equal(poseLerp(data[15], data[0], 0), 1);
  assert.equal(poseLerp(data[15], data[0], 1), 4);
  assert.equal(poseLerp(data[16], data[1], 0.5), 4);
});

test('flag off keeps the 15-float upload; pose pack is a separate method', () => {
  assert.match(batchSrc, /if \(this\.poseInterp\) return this\._uploadPose/);
  assert.match(batchSrc, /_finishUpload\(out, INSTANCED_SPRITE_STRIDE\)/);
  assert.match(batchSrc, /_finishUpload\(out, INSTANCED_SPRITE_POSE_STRIDE\)/);
  assert.match(batchSrc, /writePosePrev\(data, base, px, py\)/);
  assert.match(batchSrc, /uniforms\.uPoseAlpha = alpha/);
  assert.match(batchSrc, /group\.update\(\)/);
  assert.doesNotMatch(
    batchSrc.slice(batchSrc.indexOf('upload(q, opts)'), batchSrc.indexOf('_uploadPose')),
    /writePosePrev/
  );
});
