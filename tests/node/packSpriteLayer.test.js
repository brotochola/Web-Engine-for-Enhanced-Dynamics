import test from 'node:test';
import assert from 'node:assert/strict';
import { packSpriteLayer } from '../../src/render/packSpriteLayer.js';
import { kernelPainter } from '../helpers/painterKernel.mjs';

function opts() {
  return { indices: null, indexCount: 0, sortKey: 1, includeType: -1 };
}

test('packSpriteLayer pulls glow type 3 out of the sprite list', () => {
  const type = new Uint8Array([0, 3, 1, 3, 2]);
  const idxE = new Uint32Array(8);
  const idxG = new Uint32Array(8);
  const calls = [];
  const result = packSpriteLayer({
    count: 5,
    type,
    opts: opts(),
    splitGlow: true,
    idxEntity: idxE,
    idxGlow: idxG,
    glowCapacity: 8,
    writeSprites(o) {
      calls.push(['sprites', o.indexCount, Array.from(o.indices.subarray(0, o.indexCount))]);
      return o.indexCount;
    },
    writeGlow(o) {
      calls.push(['glow', o.indexCount, Array.from(o.indices.subarray(0, o.indexCount))]);
      return o.indexCount;
    },
  });
  assert.deepEqual(calls[0], ['sprites', 3, [0, 2, 4]]);
  assert.deepEqual(calls[1], ['glow', 2, [1, 3]]);
  assert.equal(result.splitParticles, 1);
  assert.equal(result.sprite, 3);
  assert.equal(result.glow, 2);
});

test('packSpriteLayer skips the glow write when that destination has no room', () => {
  const type = new Uint8Array([3, 0]);
  let glowWrites = 0;
  const result = packSpriteLayer({
    count: 2,
    type,
    opts: opts(),
    splitGlow: true,
    idxEntity: new Uint32Array(4),
    idxGlow: new Uint32Array(4),
    glowCapacity: 0,
    writeSprites() { return 1; },
    writeGlow() { glowWrites++; return 1; },
  });
  assert.equal(glowWrites, 0);
  assert.equal(result.glow, 0);
  assert.equal(result.sprite, 1);
});

test('packSpriteLayer orders a dense layer by sort key', async () => {
  const { state: painter, keysU32: keys } = await kernelPainter(4);
  keys.set([30, 10, 20]);
  let seen = [];
  const result = packSpriteLayer({
    count: 3,
    opts: opts(),
    dense: true,
    painter,
    keysU32: keys,
    sortedFlag: 1,
    writeSprites(o) {
      seen = Array.from(o.indices.subarray(0, o.indexCount));
      return o.indexCount;
    },
  });
  assert.deepEqual(seen, [1, 2, 0]);
  assert.equal(result.flags, 1);
  assert.equal(result.sprite, 3);
});

// Close-out group B: a layer with a painter and fewer than two rows is in painter order already, so it says so
// (sortedFlag); Pixi otherwise packed such a frame itself under Y-sort. With no painter it says nothing.
test('packSpriteLayer flags fewer than two rows as sorted when it has a painter', async () => {
  const SORTED = 4;
  for (const [count, painter, want] of [[1, true, SORTED], [0, true, SORTED], [1, false, 0], [2, true, SORTED]]) {
    const k = await kernelPainter(4);
    const result = packSpriteLayer({
      count,
      type: new Uint8Array(4),
      opts: opts(),
      painter: painter ? k.state : null,
      keysU32: k.keysU32,
      sortedFlag: SORTED,
      // As pre-render's pack asks: every row, through its slot list (in the memory, as the kernel reads it).
      fillAll: true,
      idxEntity: k.idx,
      writeSprites(o) { return o.indexCount; },
    });
    assert.equal(result.flags & SORTED, want, `${count} rows, painter ${painter}`);
  }
});

// E-456: the glow split's one pass writes the lists and the particle count the two filtered fills and the counting
// loop wrote, and lists of different lengths keep each filter's own cap.
test('splitGlowQueueIndices matches the two filtered fills and the particle count', async () => {
  const { fillQueueIndices, splitGlowQueueIndices } = await import('../../src/render/gpuQueueLayout.js');
  let seed = 0x456;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const rows = 5000;
  const type = new Uint8Array(rows);
  for (let i = 0; i < rows; i++) {
    const r = rnd();
    type[i] = r < 0.05 ? 3 : r < 0.25 ? 1 : r < 0.3 ? 2 : 0;
  }
  const cases = [
    { count: rows, lenE: rows, lenG: rows },
    { count: 1234, lenE: rows, lenG: rows },
    { count: rows, lenE: 3000, lenG: 3000 },
    { count: rows, lenE: rows, lenG: 700 },
    { count: rows, lenE: 2000, lenG: rows },
  ];
  for (const c of cases) {
    const refE = new Uint32Array(c.lenE);
    const refG = new Uint32Array(c.lenG);
    const ne = fillQueueIndices(type, c.count, -1, 3, refE);
    const ng = fillQueueIndices(type, c.count, 3, -1, refG);
    let np = 0;
    for (let k = 0; k < ne; k++) if (type[refE[k]] === 1) np++;
    const idxE = new Uint32Array(c.lenE);
    const idxG = new Uint32Array(c.lenG);
    const out = new Int32Array(3);
    assert.equal(splitGlowQueueIndices(type, c.count, idxE, idxG, out), ne, JSON.stringify(c));
    assert.deepEqual(Array.from(out), [ne, ng, np], JSON.stringify(c));
    assert.deepEqual(Array.from(idxE.subarray(0, ne)), Array.from(refE.subarray(0, ne)), JSON.stringify(c));
    assert.deepEqual(Array.from(idxG.subarray(0, ng)), Array.from(refG.subarray(0, ng)), JSON.stringify(c));
  }
});
