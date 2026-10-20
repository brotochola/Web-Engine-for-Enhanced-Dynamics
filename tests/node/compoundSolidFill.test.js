import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureCompoundSolid } from '../../src/render/visibility/angularSweep.js';
import { MAX_POLYGON_VERTICES } from '../../src/util/configDefaults.js';

// Review D1. ensureCompoundSolid builds an outline (seg) and a triangle fan
// (fill). Pre-render reads only the outline, pixi both, and each worker keeps
// its own cache, so pre-render rebuilt a fan nobody read after every fixture
// change. It now asks for the outline only.

const NONE = 0xffff;

/** A 10x10 square as two triangles sharing the diagonal. */
function square() {
  const vx = new Float32Array(2 * MAX_POLYGON_VERTICES);
  const vy = new Float32Array(2 * MAX_POLYGON_VERTICES);
  const tri = (f, pts) => pts.forEach(([x, y], i) => { vx[f * MAX_POLYGON_VERTICES + i] = x; vy[f * MAX_POLYGON_VERTICES + i] = y; });
  tri(0, [[0, 0], [10, 0], [10, 10]]);
  tri(1, [[0, 0], [10, 10], [0, 10]]);
  return {
    head: new Uint16Array([0]),
    next: new Uint16Array([1, NONE]),
    active: new Uint8Array([1, 1]),
    vertCount: new Uint8Array([3, 3]),
    vx,
    vy,
  };
}

const build = (entity, revision, wantFill) => {
  const f = square();
  return ensureCompoundSolid(entity, revision, f.head, f.next, f.active, f.vertCount, f.vx, f.vy, 0, 2, wantFill);
};

test('without the fill the outline is the same and no fan is built', () => {
  const s = build(1, 7, false);
  assert.equal(s.segCount, 4, 'the shared diagonal is interior');
  assert.equal(s.fillVerts, 0);
  assert.equal(s.hasFill, false);
});

test('asking for the fill at the same revision rebuilds with it', () => {
  build(2, 7, false);
  const s = build(2, 7, true);
  assert.equal(s.segCount, 4);
  assert.equal(s.fillVerts, 6);
  assert.equal(s.hasFill, true);
});

test('a solid built with its fill serves an outline-only request as is', () => {
  const a = build(3, 7, true);
  const b = build(3, 7, false);
  assert.equal(b, a);
  assert.equal(b.fillVerts, 6);
});
