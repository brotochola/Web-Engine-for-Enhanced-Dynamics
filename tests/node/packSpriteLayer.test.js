import test from 'node:test';
import assert from 'node:assert/strict';
import { packSpriteLayer } from '../../src/render/packSpriteLayer.js';
import { createPainterState } from '../../src/util/sortIndexByKey.js';

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

test('packSpriteLayer orders a dense layer by sort key', () => {
  const painter = createPainterState(4);
  const keys = new Uint32Array([30, 10, 20]);
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
