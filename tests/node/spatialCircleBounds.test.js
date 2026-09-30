import test from 'node:test';
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { getColliderBounds } from '../../src/util/colliderUtils.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';

// rebuildOwnedRows inlines the circle case of getColliderBounds. The position
// and extent it latches for every circle must be the ones getColliderBounds
// returns, offsets included.
test('rebuild latches getColliderBounds for circle colliders', async () => {
  const k = await setupSpatialKernel({ n: 2000, seed: 0xb0b5 });
  for (let i = 0; i < k.n; i += 3) {
    Collider.offsetX[i] = (i % 7) - 3;
    Collider.offsetY[i] = (i % 5) - 2;
  }
  k.frame();
  const pos = k.workers[0].entityPosData;
  const out = { posX: 0, posY: 0, halfW: 0, halfH: 0 };
  let checked = 0;
  for (let i = 0; i < k.n; i++) {
    if (Collider.shapeType[i] !== ShapeType.Circle) continue;
    getColliderBounds(i, out);
    assert.equal(pos[i * 4], Math.fround(out.posX), `x ${i}`);
    assert.equal(pos[i * 4 + 1], Math.fround(out.posY), `y ${i}`);
    assert.equal(pos[i * 4 + 2], Math.fround(Math.max(out.halfW, out.halfH)), `extent ${i}`);
    checked++;
  }
  assert.ok(checked > 1000);
});
