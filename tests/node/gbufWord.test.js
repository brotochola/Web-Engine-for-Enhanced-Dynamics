/** DX-GBUF: the word each sprite instance carries to the G-buffer pass (src/render/gbufWord.js), on the real code. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMISSIVE_LEVEL_MAX,
  EMISSIVE_LEVEL_ON,
  GBUF_FLAGS,
  GBUF_MAX_BANDS,
  SPRITE_NORMALS,
  decodeGbufWord,
  emissiveLevel,
  emissiveValue,
  gbufEntityId,
  gbufWord,
  writeGbufWords,
} from '../../src/render/gbufWord.js';

test('a word holds its entity, flags and selfShadow, and every word is an exact float32', () => {
  for (const e of [0, 1, 65534, 65535, 70000, 1 << 20]) {
    for (const flags of [0, 1, 2, 3, GBUF_FLAGS.FLOOR, 7 << 3, 63]) {
      for (const self of [0, 1, 2]) {
        const w = gbufWord(e, flags, self);
        assert.equal(Math.fround(w), w, `${w} is a float32`);
        assert.ok(w < 2 ** 24);
        const d = decodeGbufWord(w);
        assert.equal(d.id, gbufEntityId(e));
        assert.ok(d.id >= 1 && d.id <= 65535, 'an entity never reads as none');
        assert.equal(d.normals, flags & 3);
        assert.equal(d.floor, (flags & GBUF_FLAGS.FLOOR) !== 0);
        assert.equal(d.emissive, (flags >> 3) & 7);
        assert.equal(d.selfShadow, self);
      }
    }
  }
  assert.equal(gbufWord(-1, 63, 2), 0, 'no entity, no word');
});

test('emissive: false is off, true the sprite\'s colour, a number a glow in quarters', () => {
  assert.equal(emissiveLevel(false), 0);
  assert.equal(emissiveLevel(0), 0);
  assert.equal(emissiveLevel(true), EMISSIVE_LEVEL_ON);
  assert.equal(emissiveLevel(1), EMISSIVE_LEVEL_ON);
  assert.equal(emissiveLevel(0.01), 1);
  assert.equal(emissiveLevel(9), EMISSIVE_LEVEL_MAX);
  assert.equal(emissiveValue(0), false);
  assert.equal(emissiveValue(EMISSIVE_LEVEL_ON), true);
  assert.equal(emissiveValue(6), 1.5);
});

test('the words follow the draw order, rows without an entity read 0, and zIndex bands count along it', () => {
  const rowType = Uint8Array.from([0, 2, 0, 0]);
  const rowEntity = Int32Array.from([5, 9, 7, 3]);
  const flags = new Uint8Array(10);
  flags[5] = SPRITE_NORMALS.HEIGHT;
  flags[7] = GBUF_FLAGS.FLOOR;
  const self = new Uint8Array(10);
  self[3] = 1;
  const z = new Int16Array(10);
  z[7] = 4;
  z[3] = 4;
  const out = new Float32Array(8);
  writeGbufWords(out, 4, Uint32Array.from([1, 0, 2, 3]), rowType, rowEntity, null, 10, flags, self, z);
  assert.equal(out[0], 0, 'a decoration row');
  assert.equal(out[2], gbufWord(5, SPRITE_NORMALS.HEIGHT, 0));
  assert.equal(out[4], gbufWord(7, GBUF_FLAGS.FLOOR, 0));
  assert.equal(out[6], gbufWord(3, 0, 1));
  assert.deepEqual([out[1], out[3], out[5], out[7]], [0, 0, 1, 1], 'zIndex 0, 0, 4, 4');
});

test('from the queue\'s keys: a key past the entities (a decoration\'s) is no entity, the flag bits are not the entity', () => {
  const keys = Uint32Array.from([0x80000000 | 4, 0xffffffff, 12, 2]);
  const flags = new Uint8Array(10).fill(SPRITE_NORMALS.FLAT);
  const out = new Float32Array(8);
  writeGbufWords(out, 4, null, null, null, keys, 10, flags, null, null);
  assert.equal(out[0], gbufWord(4, SPRITE_NORMALS.FLAT, 0));
  assert.equal(out[2], 0);
  assert.equal(out[4], 0);
  assert.equal(out[6], gbufWord(2, SPRITE_NORMALS.FLAT, 0));
});

// E-444: as from the keys, a collector row whose entity is at or past the entity count is no entity: the word 0 and zIndex
// 0 for the bands (the split and indexed packs read no column past the count, and write the same).
test('from the collector: a sprite row whose entity is at or past the entity count is no entity', () => {
  const rowType = Uint8Array.from([0, 0, 0, 0, 0]);
  const rowEntity = Int32Array.from([3, 10, 4, 12, -1]);
  const flags = new Uint8Array(10).fill(GBUF_FLAGS.FLOOR);
  const self = new Uint8Array(16).fill(1);
  const z = new Int16Array(16).fill(5);
  z[4] = 0;
  const out = new Float32Array(10);
  writeGbufWords(out, 5, null, rowType, rowEntity, null, 10, flags, self, z);
  assert.equal(out[0], gbufWord(3, GBUF_FLAGS.FLOOR, 1));
  assert.equal(out[2], 0, 'the entity count itself');
  assert.equal(out[4], gbufWord(4, GBUF_FLAGS.FLOOR, 1));
  assert.equal(out[6], 0, 'past the count, though the selfShadow and zIndex columns are longer');
  assert.equal(out[8], 0, 'a negative entity');
  assert.deepEqual([out[1], out[3], out[5], out[7], out[9]], [0, 1, 1, 1, 1], 'zIndex 5, 0, 0, 0, 0');
});

test('bands stop at the most the depth holds', () => {
  const n = GBUF_MAX_BANDS + 4;
  const rowType = new Uint8Array(n);
  const rowEntity = Int32Array.from({ length: n }, (_, i) => i);
  const z = Int16Array.from({ length: n }, (_, i) => i);
  const out = new Float32Array(2 * n);
  writeGbufWords(out, n, null, rowType, rowEntity, null, n, new Uint8Array(n), null, z);
  assert.equal(out[2 * (n - 1) + 1], GBUF_MAX_BANDS - 1);
});
