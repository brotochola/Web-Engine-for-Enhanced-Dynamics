/** DX-GBUF: the word each sprite instance carries to the G-buffer pass (src/render/gbufWord.js), on the real code. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GBUF_FLAGS,
  GBUF_MAX_BANDS,
  GBUF_UNSHADED_BIT,
  SPRITE_NORMALS,
  decodeGbufWord,
  gbufEntityId,
  gbufWanted,
  gbufWord,
  writeGbufWords, GBUF_FOOT_NONE } from '../../src/render/gbufWord.js';

test('a word holds its entity, flags and selfShadow, and every word is an exact float32', () => {
  for (const e of [0, 1, 65534, 65535, 70000, 1 << 20]) {
    for (const flags of [0, 1, 2, 3, GBUF_FLAGS.FLOOR, GBUF_FLAGS.UNSHADED, 63]) {
      for (const self of [0, 1, 2]) {
        const w = gbufWord(e, flags, self);
        assert.equal(Math.fround(w), w, `${w} is a float32`);
        assert.ok(w < 2 ** 24);
        const d = decodeGbufWord(w);
        assert.equal(d.id, gbufEntityId(e));
        assert.ok(d.id >= 1 && d.id <= 65535, 'an entity never reads as none');
        assert.equal(d.normals, flags & 3);
        assert.equal(d.floor, (flags & GBUF_FLAGS.FLOOR) !== 0);
        assert.equal(d.unshaded, (flags & GBUF_FLAGS.UNSHADED) !== 0);
        assert.equal(d.selfShadow, self);
      }
    }
  }
  assert.equal(gbufWord(-1, 63, 2), 0, 'no entity, no word');
});

// DX-UNSHADED: one bit, the word's GBUF_UNSHADED_BIT (the shaders read `(word >> 21u) & 1u`), where DX-EMISSIVE's level
// had its top bit: a saved `emissive = true` (level 4, flags 32) reads as unshaded.
test('unshaded is one bit of the flags, the top one of the old emissive level', () => {
  assert.equal(GBUF_FLAGS.UNSHADED, 4 << 3, 'emissive = true stored level 4 in bits 3-5');
  assert.equal(GBUF_UNSHADED_BIT, 16 + Math.log2(GBUF_FLAGS.UNSHADED));
  assert.equal(decodeGbufWord(gbufWord(3, GBUF_FLAGS.UNSHADED, 0)).unshaded, true);
  assert.equal(decodeGbufWord(gbufWord(3, 3 << 3, 0)).unshaded, false, 'bits 3-4 are free');
  for (const [lighting, atlas, want] of [
    [{ enabled: true, unshaded: true }, false, true],
    [{ enabled: true }, { maps: false, unshaded: true }, true],
    [{ enabled: true }, { maps: true }, true],
    [{ enabled: true }, false, false],
    [{ enabled: false, unshaded: true }, false, false],
  ]) {
    assert.equal(gbufWanted({ lighting }, atlas), want, JSON.stringify([lighting, atlas]));
  }
});

// OL-4: walls the light pass reads want the words (a wall's own pixels stay lit beyond its edge, so the pass must know
// whose each pixel is); the old fan pass (debug.lightFans: lighting.wallFans) reads none, whatever else asks for them.
test('walls want the words; the old fan pass wants none', () => {
  for (const [lighting, atlas, want] of [
    [{ enabled: true, walls: true, wallFans: false }, false, true],
    [{ enabled: false, walls: true }, false, false],
    [{ enabled: true, walls: false }, false, false],
    [{ enabled: true, walls: true, wallFans: true }, false, false],
    [{ enabled: true, unshaded: true, walls: true, wallFans: true }, { maps: true }, false],
    [{ enabled: true, sunShadows: 'map', lampShadows: 'map', walls: true, wallFans: true }, false, false],
    // A scene may still carry the retired key (it is told so, and it stays in its config): nothing reads it.
    [{ enabled: true, raycasted: true }, false, false],
    [{ enabled: true, unshaded: true, raycasted: true }, false, true],
  ]) {
    assert.equal(gbufWanted({ lighting }, atlas), want, JSON.stringify([lighting, atlas]));
  }
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
  const out = new Float32Array(12);
  writeGbufWords(out, 4, Uint32Array.from([1, 0, 2, 3]), rowType, rowEntity, null, 10, flags, self, z);
  assert.equal(out[0], 0, 'a decoration row');
  assert.equal(out[3], gbufWord(5, SPRITE_NORMALS.HEIGHT, 0));
  assert.equal(out[6], gbufWord(7, GBUF_FLAGS.FLOOR, 0));
  assert.equal(out[9], gbufWord(3, 0, 1));
  assert.deepEqual([out[1], out[4], out[7], out[10]], [0, 0, 1, 1], 'zIndex 0, 0, 4, 4');
  assert.deepEqual([out[2], out[5], out[8], out[11]], new Array(4).fill(GBUF_FOOT_NONE), 'N-275: every row on its own foot');
});

test('from the queue\'s keys: a key past the entities (a decoration\'s) is no entity, the flag bits are not the entity', () => {
  const keys = Uint32Array.from([0x80000000 | 4, 0xffffffff, 12, 2]);
  const flags = new Uint8Array(10).fill(SPRITE_NORMALS.FLAT);
  const out = new Float32Array(12);
  writeGbufWords(out, 4, null, null, null, keys, 10, flags, null, null);
  assert.equal(out[0], gbufWord(4, SPRITE_NORMALS.FLAT, 0));
  assert.equal(out[3], 0);
  assert.equal(out[6], 0);
  assert.equal(out[9], gbufWord(2, SPRITE_NORMALS.FLAT, 0));
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
  const out = new Float32Array(15);
  writeGbufWords(out, 5, null, rowType, rowEntity, null, 10, flags, self, z);
  assert.equal(out[0], gbufWord(3, GBUF_FLAGS.FLOOR, 1));
  assert.equal(out[3], 0, 'the entity count itself');
  assert.equal(out[6], gbufWord(4, GBUF_FLAGS.FLOOR, 1));
  assert.equal(out[9], 0, 'past the count, though the selfShadow and zIndex columns are longer');
  assert.equal(out[12], 0, 'a negative entity');
  assert.deepEqual([out[1], out[4], out[7], out[10], out[13]], [0, 1, 1, 1, 1], 'zIndex 5, 0, 0, 0, 0');
});

test('bands stop at the most the depth holds', () => {
  const n = GBUF_MAX_BANDS + 4;
  const rowType = new Uint8Array(n);
  const rowEntity = Int32Array.from({ length: n }, (_, i) => i);
  const z = Int16Array.from({ length: n }, (_, i) => i);
  const out = new Float32Array(3 * n);
  writeGbufWords(out, n, null, rowType, rowEntity, null, n, new Uint8Array(n), null, z);
  assert.equal(out[3 * (n - 1) + 1], GBUF_MAX_BANDS - 1);
});
