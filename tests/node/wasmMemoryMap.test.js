import test from 'node:test';
import assert from 'node:assert/strict';

import { CACHE_LINE_BYTES, layoutRegions, spatialPublishRegions } from '../../src/util/wasmMemoryMap.js';
import { createSpatialPublishMemory } from '../../src/util/spatialPublishMemory.js';

// E-76 T9: every region of a kernel memory comes from the map, starts on a 64-byte line and
// overlaps no other, so regions written by different workers never share a cache line.

function assertLaidOut(layout) {
  const list = Object.entries(layout.regions).sort((a, b) => a[1].byte - b[1].byte);
  let end = 0;
  for (const [name, r] of list) {
    assert.equal(r.byte % CACHE_LINE_BYTES, 0, `${name} starts on a line`);
    assert.ok(r.byte >= end, `${name} starts after the region before it`);
    end = r.byte + r.bytes;
  }
  assert.ok(layout.bytes >= end, 'the memory holds the last region');
  assert.ok(layout.pages * 65536 >= layout.bytes, 'the pages hold the memory');
}

test('layoutRegions puts each region on its own line, in order', () => {
  const layout = layoutRegions([
    { name: 'a', owner: 'w0', bytes: 3 },
    { name: 'b', owner: 'w1', bytes: 0 },
    { name: 'c', owner: 'w1', bytes: 65 },
  ]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(layout.regions).map(([k, r]) => [k, r.byte])),
    { a: 0, b: 64, c: 64 },
  );
  assert.equal(layout.bytes, 192);
  assertLaidOut(layout);
  assert.throws(() => layoutRegions([{ name: 'a', owner: '', bytes: 1 }, { name: 'a', owner: '', bytes: 1 }]), /twice/);
  assert.throws(() => layoutRegions([{ name: 'a', owner: '', bytes: 1.5 }]), /bytes/);
});

test('the spatial publish memory is laid out by the map, one list slice per worker', () => {
  for (const [count, maxN, workers] of [[4096, 1024, 1], [16500, 1024, 3], [1001, 7, 4], [3, 0, 2]]) {
    const layout = spatialPublishRegions(count, maxN, workers);
    assertLaidOut(layout);
    assert.equal(layout.regions.guard.byte, 0, 'the guard sits at address 0');
    assert.ok(layout.regions.pos.byte > 0, 'no data region at address 0');
    assert.equal(layout.listStride % CACHE_LINE_BYTES, 0, 'each worker list starts on a line');
    assert.ok(layout.listStride >= count * 2);
    assert.equal(layout.regions.lists.bytes, workers * layout.listStride);

    const mem = createSpatialPublishMemory(count, maxN, workers);
    assert.ok(mem);
    assert.equal(mem.memory.buffer.byteLength, layout.pages * 65536);
    assert.deepEqual(
      [mem.posByte, mem.rangeByte, mem.neighborByte, mem.candByte, mem.listByte, mem.listStride],
      [layout.regions.pos.byte, layout.regions.range.byte, layout.regions.rows.byte, layout.regions.cand.byte, layout.regions.lists.byte, layout.listStride],
    );
  }
});
