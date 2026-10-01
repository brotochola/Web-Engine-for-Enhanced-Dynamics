import test from 'node:test';
import assert from 'node:assert/strict';

import { Grid } from '../../src/core/grid.js';
import { bindEntityIdWidth, entityIdBytes, EntityIdArray } from '../../src/util/entityIdWidth.js';
import { setupAccess } from '../bench/gameObjectAccessMicrobench.mjs';

// Reference: the per-entity view getNeighbor used to index.
function rowView(i) {
  const nd = Grid._neighborData;
  return new (EntityIdArray())(nd.buffer, nd.byteOffset + (i * Grid._stride + 1) * entityIdBytes(), Grid.maxNeighbors);
}

for (const width of [16, 32]) {
  test(`neighborCount / getNeighbor read the published row (entity id width ${width})`, () => {
    bindEntityIdWidth(width);
    try {
      const { objects, n } = setupAccess('base', 2048, 0x60ac, { maxNeighbors: 1024, maxCount: 120 });
      if (width === 32) Grid._neighborData[7 * Grid._stride + 1] = 70000;
      for (let i = 0; i < n; i++) {
        const o = objects[i];
        const view = rowView(i);
        assert.equal(o.neighborCount, Grid._neighborData[i * Grid._stride]);
        for (let k = 0; k < o.neighborCount; k++) assert.equal(o.getNeighbor(k), view[k], `entity ${i} neighbor ${k}`);
      }
      if (width === 32 && objects[7].neighborCount > 0) assert.equal(objects[7].getNeighbor(0), 70000);
      Grid.reset();
      assert.equal(objects[0].neighborCount, 0, 'no grid → no neighbors');
    } finally {
      bindEntityIdWidth(16);
    }
  });
}
