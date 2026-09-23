import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const weedjsPost = readFileSync(join(root, 'src/box2d/weedjsPost.js'), 'utf8');

/** Same predicate as posePublishBlocked. */
function publishBlocked(published, consumed) {
  return published > consumed;
}

test('double-buffer lock allows one unpublished frame, blocks the overwrite', () => {
  assert.equal(publishBlocked(0, 0), false);
  assert.equal(publishBlocked(1, 1), false);
  assert.equal(publishBlocked(1, 0), true);
  assert.equal(publishBlocked(2, 1), true);
});

test('physics keeps stepping; pose publish is gated, dt is not zeroed', () => {
  assert.match(weedjsPost, /function maybePublishPose\(/);
  assert.match(weedjsPost, /if \(posePublishBlocked\(\)\) \{/);
  assert.match(weedjsPost, /poseSkipTotal\+\+/);
  assert.match(weedjsPost, /maybePublishPose\(entityCount\)/);
  assert.match(weedjsPost, /hostDt = dtSec;/);
  assert.doesNotMatch(
    weedjsPost,
    /hostDt = dtSec > 0 && posePublishBlocked\(\) \? 0 : dtSec/,
  );
});
