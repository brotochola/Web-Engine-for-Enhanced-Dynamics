/**
 * E-508: the lamps' volumes' cache's plan (src/render/lampVolumeCache.js): which tiles draw their volumes directly, which
 * are copied from the cache, when the cache is painted again, and the lists the draws read (the tiles' texture's row 2).
 * That the copy draws what the volumes drew is the browser's (the barrio's captures with lighting.lampMapCache on and off).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LAMP_CACHE_HOLD_FRAMES,
  LAMP_CACHE_REPAINT_GAP,
  LAMP_TILE_LIST_ROW,
  LAMP_TILE_ROWS,
  createLampVolumeCache,
  lampCacheLayout,
  lampCachePays,
  planLampVolumeCache,
  writeDirectLampList,
} from '../../src/render/lampVolumeCache.js';
import { lampGridRects, writeLampTile, writeLampTileOwner } from '../../src/render/lampShadowMap.js';

const WIDTH = 16;
const PER_ROW = 4;
const SLOTS = 8;
const SLOTS_PER_ROW = 4;
/** E-551: the tiles' side and their rects, the grid of PER_ROW a row (lampGridRects). */
const SIDE = 256;
const RECTS = new Float32Array(WIDTH * 3);
lampGridRects(RECTS, WIDTH, PER_ROW, SIDE);

/** The tiles' texture for lamps [{ id, x, y, e, r }], one a tile in order. */
function tilesFor(lamps) {
  const data = new Float32Array(WIDTH * 4 * LAMP_TILE_ROWS);
  const ids = new Uint32Array(WIDTH);
  lamps.forEach((l, t) => {
    ids[t] = l.id;
    writeLampTile(data, t, l.x, l.y, l.e ?? 50, l.r ?? 600);
    writeLampTileOwner(data, WIDTH, t, l.id);
  });
  return { data, ids, n: lamps.length };
}

/** The list's entries [tile, column, row] from `from`, `count` of them. */
function entries(data, from, count) {
  const out = [];
  for (let k = from; k < from + count; k++) {
    const i = (LAMP_TILE_LIST_ROW * WIDTH + k) * 4;
    out.push([data[i], data[i + 1], data[i + 2]]);
  }
  return out;
}

function plan(c, lamps, epoch = 1, slots = SLOTS) {
  const { data, ids, n } = tilesFor(lamps);
  planLampVolumeCache(c, ids, data, WIDTH, n, RECTS, slots, SLOTS_PER_ROW, SIDE, epoch);
  return { data, direct: c.direct, cached: c.cached, paint: c.paint };
}

const STILL = [
  { id: 10, x: 100, y: 100 },
  { id: 11, x: 400, y: 120 },
  { id: 12, x: 800, y: 300 },
];

test('the direct list is every tile into its own floor half, as the draw read the instance before the lists', () => {
  const data = new Float32Array(WIDTH * 4 * LAMP_TILE_ROWS);
  writeDirectLampList(data, WIDTH, 6, RECTS);
  assert.deepEqual(entries(data, 0, 6), [[0, 0, 0], [1, 2, 0], [2, 4, 0], [3, 6, 0], [4, 0, 1], [5, 2, 1]]);
  assert.deepEqual(lampCacheLayout(8, 512, 4096), { perRow: 8, width: 4096, height: 512 });
  assert.deepEqual(lampCacheLayout(16, 1024, 4096), { perRow: 4, width: 4096, height: 4096 });
});

test('still lamps draw directly while they settle, are painted once, then copied without painting', () => {
  const c = createLampVolumeCache();
  for (let f = 0; f < LAMP_CACHE_HOLD_FRAMES; f++) {
    const p = plan(c, STILL);
    assert.deepEqual([p.direct, p.cached, p.paint], [3, 0, false], `frame ${f}: settling`);
    assert.deepEqual(entries(p.data, 0, 3), [[0, 0, 0], [1, 2, 0], [2, 4, 0]]);
  }
  const painted = plan(c, STILL);
  assert.deepEqual([painted.direct, painted.cached, painted.paint], [0, 3, true]);
  assert.deepEqual(entries(painted.data, 0, 3), [[0, 0, 0], [1, 1, 0], [2, 2, 0]], 'each tile with its slot');
  for (let f = 0; f < 5; f++) {
    const p = plan(c, STILL);
    assert.deepEqual([p.direct, p.cached, p.paint], [0, 3, false], `frame ${f}: copied`);
  }
});

test('a moving lamp draws directly every frame and the still ones stay cached; reordered tiles keep their slots', () => {
  const c = createLampVolumeCache();
  let p;
  for (let f = 0; f <= LAMP_CACHE_HOLD_FRAMES + 3; f++) {
    p = plan(c, [STILL[0], { id: 20, x: 200 + f, y: 50 }, STILL[1], STILL[2]]);
  }
  assert.deepEqual([p.direct, p.cached, p.paint], [1, 3, false]);
  assert.deepEqual(entries(p.data, 0, 1), [[1, 2, 0]], 'the headlight, into its own tile');
  assert.deepEqual(entries(p.data, 1, 3), [[0, 0, 0], [2, 1, 0], [3, 2, 0]]);
  // The headlight passes a lamp in the distance order: the lamps change tiles, not slots.
  p = plan(c, [{ id: 20, x: 300, y: 50 }, STILL[2], STILL[0], STILL[1]]);
  assert.deepEqual([p.direct, p.cached, p.paint], [1, 3, false]);
  assert.deepEqual(entries(p.data, 0, 1), [[0, 0, 0]]);
  assert.deepEqual(entries(p.data, 1, 3), [[1, 2, 0], [2, 0, 0], [3, 1, 0]]);
});

test('a lamp that moved leaves its slot; at rest again it waits for the repaint gap, drawn directly', () => {
  const c = createLampVolumeCache();
  for (let f = 0; f <= LAMP_CACHE_HOLD_FRAMES; f++) plan(c, STILL);
  const moved = [STILL[0], { ...STILL[1], x: 410 }, STILL[2]];
  let p = plan(c, moved);
  assert.deepEqual([p.direct, p.cached, p.paint], [1, 2, false], 'moved: drawn directly');
  let frames = 1;
  while (!p.paint && frames < LAMP_CACHE_REPAINT_GAP + 10) {
    p = plan(c, moved);
    frames++;
    if (!p.paint) assert.deepEqual([p.direct, p.cached], [1, 2]);
  }
  assert.equal(p.paint, true);
  assert.equal(frames, LAMP_CACHE_REPAINT_GAP, 'the next paint comes when the gap since the last one has gone');
  assert.deepEqual([p.direct, p.cached], [0, 3]);
});

test('a new volumes epoch empties the cache; it paints again once the epoch has held', () => {
  const c = createLampVolumeCache();
  for (let f = 0; f <= LAMP_CACHE_HOLD_FRAMES + LAMP_CACHE_REPAINT_GAP; f++) plan(c, STILL, 1);
  let p = plan(c, STILL, 2);
  assert.deepEqual([p.direct, p.cached, p.paint], [3, 0, false], 'the volumes moved: nothing cached holds');
  for (let f = 1; f < LAMP_CACHE_HOLD_FRAMES; f++) {
    p = plan(c, STILL, 2);
    assert.deepEqual([p.direct, p.cached, p.paint], [3, 0, false]);
  }
  p = plan(c, STILL, 2);
  assert.deepEqual([p.direct, p.cached, p.paint], [0, 3, true]);
  // Volumes that move every frame never paint.
  for (let f = 0; f < 50; f++) {
    p = plan(c, STILL, 100 + f);
    assert.deepEqual([p.direct, p.cached, p.paint], [3, 0, false]);
  }
});

test('a tile that casts nothing is in no list; lamps past the slots draw directly; no slots, no cache', () => {
  const c = createLampVolumeCache();
  const lamps = [STILL[0], { id: 13, x: 5, y: 5, e: 0 }, STILL[1], STILL[2]];
  let p;
  for (let f = 0; f <= LAMP_CACHE_HOLD_FRAMES; f++) p = plan(c, lamps, 1, 2);
  assert.deepEqual([p.direct, p.cached, p.paint], [1, 2, true]);
  assert.deepEqual(entries(p.data, 0, 3), [[3, 6, 0], [0, 0, 0], [2, 1, 0]]);
  const off = createLampVolumeCache();
  for (let f = 0; f < 6; f++) p = plan(off, lamps, 1, 0);
  assert.deepEqual([p.direct, p.cached, p.paint], [3, 0, false]);
});

test('the cache pays for volumes heavy for their tiles: the barrio houses, not a few blocks', () => {
  assert.equal(lampCachePays(274338, 512), true, 'the barrio: 274 000 indices a lamp, halves of 512');
  assert.equal(lampCachePays(9000, 256), false, 'lampShadowStressScene ?volumes=300');
  assert.equal(lampCachePays(90000, 256), true, '?volumes=3000');
  assert.equal(lampCachePays(0, 64), false);
});
