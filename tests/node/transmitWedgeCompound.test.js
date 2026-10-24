import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Transform } from '../../src/components/transform.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';
import { ShapeType, MAX_POLYGON_VERTICES } from '../../src/util/configDefaults.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import {
  ensureCompoundSolid,
  segmentDistSq,
  segmentFacesPoint,
} from '../../src/render/visibility/angularSweep.js';

// B26. Raycasted lighting lets a fraction of light through an occluder with
// block < 1 by adding a "transmit wedge" behind it. For a compound occluder it
// added one wedge per outline edge, and a ray behind a closed outline crosses
// it at least twice, so the transmitted light stacked: block 0.5 let all of
// it through. Only light-facing edges get a wedge now, like the single
// silhouette wedge of a plain shape.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const pixi = readFileSync(join(root, 'src/workers/pixiWorker.js'), 'utf8');

// The emitter reads its doubles from WEDGE_IN and hands each wedge's to _pushWedge the same way (E-96c).
const WEDGE_IN = new Float64Array(15);

function wedgeEmitter(wedges) {
  const start = pixi.indexOf('// transmit-wedge-start');
  const end = pixi.indexOf('// transmit-wedge-end');
  assert.ok(start >= 0 && end > start, 'transmit wedge method missing in pixiWorker.js');
  const Emitter = new Function(
    'Collider', 'ColliderFixture', 'ShapeType', 'MAX_POLYGON_VERTICES', 'VIS_REST',
    'ensureCompoundSolid', 'segmentDistSq', 'segmentFacesPoint', 'WEDGE_IN',
    `return class {
      constructor(out) {
        this._wedgeTan = new Float32Array(4);
        this._wedgePolyX = new Float32Array(MAX_POLYGON_VERTICES);
        this._wedgePolyY = new Float32Array(MAX_POLYGON_VERTICES);
        this.out = out;
      }
      _pushWedge() {
        const [lx, ly, lightR] = WEDGE_IN;
        const [scale, ax, ay, bx, by] = WEDGE_IN.subarray(10);
        this.out.push({ lx, ly, lightR, ax, ay, bx, by, scale });
      }
      ${pixi.slice(start, end)}
    };`,
  )(Collider, ColliderFixture, ShapeType, MAX_POLYGON_VERTICES, 0.67, ensureCompoundSolid, segmentDistSq, segmentFacesPoint, WEDGE_IN);
  return new Emitter(wedges);
}

/** The light, the occluder's pose and block, as the self-lit batch writes them before the call. */
function emit(px, entityIdx, lx, ly, lightR, ex, ey, c, s, ox, oy, block) {
  WEDGE_IN.set([lx, ly, lightR, ex, ey, c, s, ox, oy, block]);
  px._emitTransmitWedge(entityIdx);
}

function initPools(n = 2, maxFixtures = 8) {
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(n)), n);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(n)), n);
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(n)), n);
  Collider.active[0] = 1;
  ColliderFixture.initializeArrays(new SharedArrayBuffer(ColliderFixture.getBufferSize(maxFixtures, n)), maxFixtures, n);
  const freeList = new Uint16Array(new SharedArrayBuffer(maxFixtures * 2));
  const freeListTop = new Int32Array(new SharedArrayBuffer(8));
  resetFreeList(freeListTop, freeList, maxFixtures, 1);
  ColliderFixture.initialize(maxFixtures);
  ColliderFixture.initializeFreeList(freeList.buffer, freeListTop.buffer);
}

/** Point inside the wedge quad a, a', b', b (a' and b' pushed out to lightR). */
function covers(w, px, py) {
  const ext = (x, y) => {
    const dx = x - w.lx;
    const dy = y - w.ly;
    const l = Math.sqrt(dx * dx + dy * dy);
    return [w.lx + (dx / l) * w.lightR, w.ly + (dy / l) * w.lightR];
  };
  const q = [[w.ax, w.ay], ext(w.ax, w.ay), ext(w.bx, w.by), [w.bx, w.by]];
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = q[i];
    const [x1, y1] = q[(i + 1) % 4];
    const cross = (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);
    if (cross === 0) continue;
    const sgn = Math.sign(cross);
    if (sign === 0) sign = sgn;
    else if (sgn !== sign) return false;
  }
  return true;
}

test('a point behind a compound occluder is covered by one transmit wedge', () => {
  initPools();
  // Two 10x10 squares side by side (CCW): a 20x10 bar.
  const xy = new Float32Array([0, 0, 10, 0, 10, 10, 0, 10, 10, 0, 20, 0, 20, 10, 10, 10]);
  assert.equal(ColliderFixture.replaceForEntityFlat(0, xy, new Uint8Array([4, 4]), 2), true);
  const wedges = [];
  const px = wedgeEmitter(wedges);
  emit(px, 0, -50, 5, 300, 0, 0, 1, 0, 0, 0, 0.5);
  assert.ok(wedges.length >= 1);
  for (const [x, y] of [[40, 5], [30, 2], [60, 8]]) {
    const n = wedges.filter((w) => covers(w, x, y)).length;
    assert.equal(n, 1, `(${x}, ${y}) is under ${n} wedges`);
  }
  // In front of the bar: no wedge.
  assert.equal(wedges.filter((w) => covers(w, -20, 5)).length, 0);
});

test('segmentFacesPoint follows the CCW outward normal', () => {
  // Bottom edge of a CCW square, (0,0)->(10,0): outward is -y.
  assert.equal(segmentFacesPoint(0, 0, 10, 0, 5, -3), true);
  assert.equal(segmentFacesPoint(0, 0, 10, 0, 5, 3), false);
  assert.equal(segmentFacesPoint(0, 0, 10, 0, 20, 0), false, 'collinear is not facing');
});
