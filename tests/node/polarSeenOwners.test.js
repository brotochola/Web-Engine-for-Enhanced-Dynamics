import test from 'node:test';
import assert from 'node:assert/strict';

import { OCC_POLY, writeOrientedBoxVerts } from '../../src/render/visibility/angularSweep.js';
import {
  buildVisibilityPolygon,
  clearPolarBins,
  clipVisibilityToPolar,
  dropUnseenJs,
  markSeenPolarOwners,
  rasterBoundarySegment,
  sweepSawOccluder,
} from '../reference/visibilitySweepJs.mjs';

// N-19. A compound solid (terrain chunk) used to be drawn self-lit whenever one
// of its segments was in the light's range, so rock deep behind other rock lit
// up. The polar bins now remember who stamped each nearest hit, and a solid is
// seen only when one of its bins is on the polygon.

const R = 1000;
const MAX = 512;

function sweepThenClip(simple) {
  const outX = new Float32Array(MAX);
  const outY = new Float32Array(MAX);
  const kind = new Uint8Array(4);
  const cx = new Float32Array(4);
  const cy = new Float32Array(4);
  const cr = new Float32Array(4);
  const vertStart = new Int32Array(4);
  const vertCount = new Uint8Array(4);
  const vx = new Float32Array(64);
  const vy = new Float32Array(64);
  let occ = 0;
  for (const [x, y, w, h] of simple) {
    kind[occ] = OCC_POLY;
    vertStart[occ] = occ * 4;
    writeOrientedBoxVerts(vx, vy, occ * 4, x, y, w, h, 1, 0, 0, 0);
    vertCount[occ] = 4;
    occ++;
  }
  const n = buildVisibilityPolygon(0, 0, R, kind, cx, cy, cr, vertStart, vertCount, vx, vy, occ, outX, outY, MAX);
  return clipVisibilityToPolar(0, 0, outX, outY, n, outX, outY, MAX);
}

function sweepThenClipMany(boxes) {
  const n = boxes.length;
  const kind = new Uint8Array(n).fill(OCC_POLY);
  const f = new Float32Array(n);
  const vertStart = new Int32Array(n);
  const vertCount = new Uint8Array(n).fill(4);
  const vx = new Float32Array(n * 4);
  const vy = new Float32Array(n * 4);
  boxes.forEach(([x, y, w, h], i) => {
    vertStart[i] = i * 4;
    writeOrientedBoxVerts(vx, vy, i * 4, x, y, w, h, 1, 0, 0, 0);
  });
  const outX = new Float32Array(MAX);
  const outY = new Float32Array(MAX);
  return buildVisibilityPolygon(0, 0, R * 10, kind, f, f, f, vertStart, vertCount, vx, vy, n, outX, outY, MAX);
}

function stampWalls() {
  clearPolarBins(R);
  rasterBoundarySegment(100, -50, 100, 50, 0, 0, 7); // near wall, facing the light at x = 100
  rasterBoundarySegment(200, -40, 200, 40, 0, 0, 8); // farther and narrower: wholly behind 7
  rasterBoundarySegment(-300, 50, -300, -50, 0, 0, 9); // on the other side of the light
}

test('a solid wholly behind another solid is not seen; the ones in front are', () => {
  stampWalls();
  assert.ok(sweepThenClip([]) > 0);
  const seen = new Uint32Array(16);
  assert.ok(markSeenPolarOwners(seen, 3) > 0);
  assert.equal(seen[7], 3, 'the near wall');
  assert.equal(seen[9], 3, 'the wall behind the light');
  assert.equal(seen[8], 0, 'the wall in the near wall\'s shadow');
});

test('a simple occluder in front of a solid hides it', () => {
  stampWalls();
  // A tall box at x = -150 covers wall 9's whole arc from the light.
  sweepThenClip([[-150, 0, 20, 400]]);
  const seen = new Uint32Array(16);
  markSeenPolarOwners(seen, 1);
  assert.equal(seen[9], 0, 'wall 9 is behind the box');
  assert.equal(seen[7], 1, 'wall 7 is still seen');
});

test('a solid seen in one bin of a vertex group is seen', () => {
  stampWalls();
  // 128 vertices: 4 bins per vertex. A small far wall peeks out just past wall
  // 7's edge (26.6°): 26.9° to 27.9°, bins 294-295. Bin 293, in the same
  // group of 4, is 7's nearer hit and gives the vertex; 10's own bins are clear.
  rasterBoundarySegment(400, 203, 400, 212, 0, 0, 10);
  const outX = new Float32Array(128);
  const outY = new Float32Array(128);
  const none = new Uint8Array(1);
  const f = new Float32Array(1);
  const i = new Int32Array(1);
  const n = buildVisibilityPolygon(0, 0, R, none, f, f, f, i, none, f, f, 0, outX, outY, 128);
  assert.equal(clipVisibilityToPolar(0, 0, outX, outY, n, outX, outY, 128), 128);
  const seen = new Uint32Array(16);
  markSeenPolarOwners(seen, 5);
  assert.equal(seen[10], 5);
  assert.equal(seen[8], 0);
});

test('before any merge, the caller is told it cannot know', () => {
  clearPolarBins(R);
  rasterBoundarySegment(100, -50, 100, 50, 0, 0, 7);
  assert.equal(markSeenPolarOwners(new Uint32Array(16), 1), -1);
});

test('the JS light loop kept only the occluders a light sees, solids and simple ones (dropUnseenJs)', async () => {
  const { loadWorker } = await import('../bench/workerHarness.mjs');
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const itemBytes = 28;
  const sab = new SharedArrayBuffer(4 + 8 * itemBytes);
  const buf = { i32: new Int32Array(sab), f32: new Float32Array(sab), u8: new Uint8Array(sab) };
  pre._selfLitItemBytes = itemBytes;
  pre._selfLitSolid = new Uint8Array(8);
  pre._selfLitOcc = new Int32Array(8);
  pre._selfLitSeen = new Uint32Array(16);
  // Items 2..5 belong to this light: solid 7, a simple occluder 3 (sweep
  // occluder 0, a box up the y axis that the light sees), solid 8, solid 9.
  const items = [[1, 0], [2, 0], [7, 1], [3, 0], [8, 1], [9, 1]];
  items.forEach(([id, solid], q) => {
    const at = (4 + q * itemBytes) >> 2;
    buf.i32[at] = id;
    buf.f32[at + 2] = id * 10; // a payload that must move with its item
    pre._selfLitSolid[q] = solid;
    pre._selfLitOcc[q] = 0;
  });
  stampWalls();
  sweepThenClip([[0, 150, 40, 20]]);
  assert.equal(sweepSawOccluder(0), true);
  const kept = dropUnseenJs(pre, buf, 2, items.length, true);
  assert.equal(kept, 5);
  const ids = [];
  for (let q = 0; q < kept; q++) {
    const at = (4 + q * itemBytes) >> 2;
    ids.push(buf.i32[at]);
    assert.equal(buf.f32[at + 2], buf.i32[at] * 10, `item ${q} moved whole`);
  }
  assert.deepEqual(ids, [1, 2, 7, 3, 9], 'solid 8 is behind solid 7');
  // No bin stamped at all: no solid is seen, the seen simple occluder stays.
  assert.equal(dropUnseenJs(pre, buf, 2, kept, false), 3);
  assert.equal(buf.i32[(4 + 2 * itemBytes) >> 2], 3);
});

// N-39. Simple occluders (boxes, circles, polygons) went into the self-lit
// queue by range alone, as solids did before N-19. The sweep now records which
// occluder each of its vertices lands on.
test('a box wholly behind another box is not seen; the one in front is', () => {
  // Occluder 0: a tall box at x = 100. Occluder 1: a smaller one at x = 200,
  // inside 0's shadow. Occluder 2: a box behind the light, in the clear.
  sweepThenClip([[100, 0, 10, 120], [200, 0, 10, 40], [-150, 0, 10, 40]]);
  assert.equal(sweepSawOccluder(0), true, 'the near box');
  assert.equal(sweepSawOccluder(1), false, 'the box in its shadow');
  assert.equal(sweepSawOccluder(2), true, 'the box behind the light');
});

test('a sweep that gives up does not hide anyone', () => {
  // More events than the sweep holds: it falls back to a full circle and
  // cannot tell who was seen, so everyone counts (the old range behaviour).
  const many = [];
  for (let i = 0; i < 1100; i++) many.push([120 + (i % 30) * 12, ((i / 30) | 0) * 12 - 200, 4, 4]);
  const warn = console.warn;
  console.warn = () => {};
  try {
    sweepThenClipMany(many);
  } finally {
    console.warn = warn;
  }
  assert.equal(sweepSawOccluder(1000), true);
});
