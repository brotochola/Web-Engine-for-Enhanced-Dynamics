import test from 'node:test';
import assert from 'node:assert/strict';

import { computeBufferSize, createViews } from '../../src/render/renderQueueLayout.js';

// E-113: at a capacity that is a multiple of 1 024 the queue's float columns are a multiple of 4 KB apart.
// Each column starts a cache line past a line boundary, so row 0 of every column falls in its own L1 set
// (64 sets of 64 bytes in 4 KB). At other capacities the columns spread on their own and a set holds a few
// at most, within an 8-way L1. The views stay inside computeBufferSize from any 64-aligned base.

test('every column of the render queue starts in its own cache set, at capacities that alias and others', () => {
  for (const capacity of [1024, 8192, 32768, 65536, 33000, 119298]) {
    const bytes = computeBufferSize(capacity);
    for (const base of [0, 64 * 7]) {
      const views = createViews(new SharedArrayBuffer(base + bytes), capacity, base);
      const columns = Object.entries(views).filter(([name]) => name !== 'sortKeyU32');
      const perSet = new Map();
      for (const [name, v] of columns) {
        assert.ok(v.byteOffset + v.byteLength <= base + bytes, `${name} inside the buffer at ${capacity}`);
        const set = (v.byteOffset >> 6) & 63;
        perSet.set(set, (perSet.get(set) || 0) + 1);
      }
      const most = Math.max(...perSet.values());
      if (capacity % 1024 === 0) assert.equal(most, 1, `${capacity} rows from ${base}: one set per column`);
      else assert.ok(most <= 4, `${capacity} rows from ${base}: ${most} columns in one set`);
    }
  }
});
