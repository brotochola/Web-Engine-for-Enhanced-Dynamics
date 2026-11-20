import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { GameObject } from '../../src/core/gameObject.js';
import { setupSetters, resetSetters } from '../bench/setterMicrobench.mjs';

// N-237: setterMicrobench set its columns up again for its second case, binding new arrays to the components' statics,
// which deoptimized every setter compiled against the first ones (12 dependent-code deopts a run): the "same" case timed
// other code. The columns are bound once now and each case starts from resetSetters, the same arrays at setup's values.
test("resetSetters puts setup's values back in the same arrays", () => {
  const entities = setupSetters(GameObject, 64);
  const bound = [Transform.x, Transform.rotC, RigidBody.vx, SpriteRenderer.alpha, SpriteRenderer.renderDirty];
  for (let i = 0; i < 64; i++) {
    entities[i].x = i + 0.5;
    entities[i].setVelocity(1, 2);
    entities[i].alpha = 0.25;
  }
  resetSetters();
  assert.deepEqual([Transform.x, Transform.rotC, RigidBody.vx, SpriteRenderer.alpha, SpriteRenderer.renderDirty], bound, 'no array rebound');
  assert.ok(Transform.x.every((v) => v === 0) && RigidBody.vx.every((v) => v === 0));
  assert.ok(Transform.rotC.every((v) => v === 1) && SpriteRenderer.alpha.every((v) => v === 1));
  assert.ok(SpriteRenderer.renderDirty.every((v) => v === 0) && SpriteRenderer.keyedDirty.every((v) => v === 0));
});
