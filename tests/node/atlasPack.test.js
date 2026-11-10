import test from 'node:test';
import assert from 'node:assert/strict';

import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { MaxRectsPackerReference } from '../reference/maxRectsPacker.mjs';
import { loadAtlasRects, packAtlasRects } from '../bench/atlasPackMicrobench.mjs';
import { checksumInts } from '../bench/microbenchHelpers.mjs';

const Packer = SpriteSheetRegistry.MaxRectsPacker;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    s = Math.imul(s ^ (s >>> 13), 3266489909) >>> 0;
    return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
  };
}

test("the packer places the Buenos Aires demo's 4386 frames where the full prune placed them", () => {
  // 3981242099: the placements of the packer that compared every pair of free rectangles (40f5d2f3), in Node and in Chrome.
  const data = loadAtlasRects();
  const { placed } = packAtlasRects(Packer, data);
  assert.equal(data.count, 4386);
  assert.ok(placed.every((v) => v >= 0), 'every frame fits');
  assert.equal(checksumInts(placed), 3981242099);
});

test('random packs: each rectangle where the reference puts it, and the same free list in the same order', () => {
  for (const heuristic of ['best-short-side', 'best-long-side', 'best-area', 'bottom-left']) {
    for (let seed = 1; seed <= 6; seed++) {
      const r = rng(seed * 7919);
      const padding = seed % 3;
      const a = new Packer(1024, 768, padding);
      const b = new MaxRectsPackerReference(1024, 768, padding);
      for (let i = 0; i < 260; i++) {
        // Mostly small frames, some large ones, and many of one size (duplicates in the free list).
        const kind = r();
        const w = kind < 0.25 ? 32 : kind < 0.9 ? 4 + ((r() * 60) | 0) : 40 + ((r() * 200) | 0);
        const h = kind < 0.25 ? 48 : kind < 0.9 ? 4 + ((r() * 60) | 0) : 30 + ((r() * 160) | 0);
        const got = a.insert(w, h, heuristic);
        const want = b.insert(w, h, heuristic);
        assert.deepEqual(got, want, `${heuristic} seed ${seed} rectangle ${i} (${w}x${h})`);
        assert.deepEqual(a.freeRects, b.freeRects, `${heuristic} seed ${seed} free list after rectangle ${i}`);
      }
    }
  }
});
