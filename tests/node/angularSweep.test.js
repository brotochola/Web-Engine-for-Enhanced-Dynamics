import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVisibilityPolygon,
  OCC_CIRCLE,
  OCC_POLY,
  writeOrientedBoxVerts,
  writePolygonVerts,
} from '../../src/render/visibility/angularSweep.js';
import {
  LightOccluder,
  LIGHT_OCCLUDER_MASK_COLLIDER,
  LIGHT_OCCLUDER_MASK_SPRITE,
} from '../../src/components/lightOccluder.js';

test('LightOccluder schema has maskMode, no radius', () => {
  assert.ok(LightOccluder.ARRAY_SCHEMA.active);
  assert.ok(LightOccluder.ARRAY_SCHEMA.maskMode);
  assert.equal(LightOccluder.ARRAY_SCHEMA.radius, undefined);
  assert.equal(LIGHT_OCCLUDER_MASK_COLLIDER, 0);
  assert.equal(LIGHT_OCCLUDER_MASK_SPRITE, 1);
});

test('AngularSweep: no occluders yields full circle', () => {
  const outX = new Float32Array(64);
  const outY = new Float32Array(64);
  const kind = new Uint8Array(0);
  const cx = new Float32Array(0);
  const cy = new Float32Array(0);
  const cr = new Float32Array(0);
  const vertStart = new Int32Array(0);
  const vertCount = new Uint8Array(0);
  const vertsX = new Float32Array(0);
  const vertsY = new Float32Array(0);

  const n = buildVisibilityPolygon(
    0, 0, 100,
    kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
    0, outX, outY, 64
  );
  assert.ok(n >= 8);
  for (let i = 0; i < n; i++) {
    assert.ok(Number.isFinite(outX[i]));
    assert.ok(Number.isFinite(outY[i]));
  }
});

test('AngularSweep: circle occluder carves umbra, finite verts', () => {
  const outX = new Float32Array(128);
  const outY = new Float32Array(128);
  const kind = new Uint8Array([OCC_CIRCLE]);
  const cx = new Float32Array([50]);
  const cy = new Float32Array([0]);
  const cr = new Float32Array([10]);
  const vertStart = new Int32Array([0]);
  const vertCount = new Uint8Array([0]);
  const vertsX = new Float32Array(0);
  const vertsY = new Float32Array(0);

  const n = buildVisibilityPolygon(
    0, 0, 200,
    kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
    1, outX, outY, 128
  );
  assert.ok(n >= 3);
  for (let i = 0; i < n; i++) {
    assert.ok(Number.isFinite(outX[i]), `outX[${i}]`);
    assert.ok(Number.isFinite(outY[i]), `outY[${i}]`);
  }
});

test('AngularSweep: free arcs stay sparse (no 22.5° densify ladder)', () => {
  const outX = new Float32Array(128);
  const outY = new Float32Array(128);
  const kind = new Uint8Array([OCC_CIRCLE]);
  const cx = new Float32Array([50]);
  const cy = new Float32Array([0]);
  const cr = new Float32Array([10]);
  const vertStart = new Int32Array([0]);
  const vertCount = new Uint8Array([0]);
  const vertsX = new Float32Array(0);
  const vertsY = new Float32Array(0);

  const n = buildVisibilityPolygon(
    0, 0, 200,
    kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
    1, outX, outY, 128
  );
  // Old densify ≈ 2π/(π/16) rim samples; sparse path ≪ that
  assert.ok(n < 24, `expected sparse polygon, got ${n} verts`);
  // Free-sky verts overshoot radius (FREE_OVERSIZE); occluder hits stay nearer
  let maxR = 0;
  for (let i = 0; i < n; i++) {
    const r = Math.hypot(outX[i], outY[i]);
    if (r > maxR) maxR = r;
  }
  assert.ok(maxR > 200, `free verts should oversize past maxRadius, maxR=${maxR}`);
});

test('AngularSweep: tall box near light keeps free disc covered (not one-midpoint wedges)', () => {
  const outX = new Float32Array(128);
  const outY = new Float32Array(128);
  const vertsX = new Float32Array(4);
  const vertsY = new Float32Array(4);
  writeOrientedBoxVerts(vertsX, vertsY, 0, 0, 0, 63, 160, 1, 0, 0, 0);
  const lx = 80;
  const ly = 0;
  const R = 400;
  const kind = new Uint8Array([OCC_POLY]);
  const n = buildVisibilityPolygon(
    lx, ly, R,
    kind, new Float32Array(1), new Float32Array(1), new Float32Array(1),
    new Int32Array([0]), new Uint8Array([4]), vertsX, vertsY,
    1, outX, outY, 128
  );
  assert.ok(n >= 3 && n < 32, `sparse but complete, got ${n}`);

  const pointInFan = (px, py) => {
    for (let i = 0; i < n; i++) {
      const ax = outX[i] - lx;
      const ay = outY[i] - ly;
      const bx = outX[(i + 1) % n] - lx;
      const by = outY[(i + 1) % n] - ly;
      const vx = px - lx;
      const vy = py - ly;
      const den = ax * by - bx * ay;
      if (Math.abs(den) < 1e-12) continue;
      const a = (vx * by - bx * vy) / den;
      const b = (ax * vy - vx * ay) / den;
      if (a >= -1e-5 && b >= -1e-5 && a + b <= 1 + 1e-5) return true;
    }
    return false;
  };

  // Free side (toward +X through 0°): samples at 0.95R must stay inside fan
  for (let deg = -100; deg <= 100; deg += 10) {
    const rad = (deg * Math.PI) / 180;
    const px = lx + Math.cos(rad) * R * 0.95;
    const py = ly + Math.sin(rad) * R * 0.95;
    assert.ok(pointInFan(px, py), `free sample at ${deg}° should be lit`);
  }
  // Umbra side (behind box): samples must stay outside fan
  for (let deg = 140; deg <= 220; deg += 10) {
    const rad = (deg * Math.PI) / 180;
    const px = lx + Math.cos(rad) * R * 0.95;
    const py = ly + Math.sin(rad) * R * 0.95;
    assert.equal(pointInFan(px, py), false, `umbra sample at ${deg}° should be dark`);
  }
});

test('AngularSweep: oriented box occluder via OCC_POLY', () => {
  const outX = new Float32Array(128);
  const outY = new Float32Array(128);
  const vertsX = new Float32Array(4);
  const vertsY = new Float32Array(4);
  writeOrientedBoxVerts(vertsX, vertsY, 0, 80, 0, 40, 20, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), 0, 0);

  const kind = new Uint8Array([OCC_POLY]);
  const cx = new Float32Array([0]);
  const cy = new Float32Array([0]);
  const cr = new Float32Array([0]);
  const vertStart = new Int32Array([0]);
  const vertCount = new Uint8Array([4]);

  const n = buildVisibilityPolygon(
    0, 0, 300,
    kind, cx, cy, cr, vertStart, vertCount, vertsX, vertsY,
    1, outX, outY, 128
  );
  assert.ok(n >= 3);
  for (let i = 0; i < n; i++) {
    assert.ok(Number.isFinite(outX[i]));
    assert.ok(Number.isFinite(outY[i]));
  }

  // Box verts themselves are finite and form a rotated rectangle
  for (let i = 0; i < 4; i++) {
    assert.ok(Number.isFinite(vertsX[i]));
    assert.ok(Number.isFinite(vertsY[i]));
  }
});

test('writePolygonVerts transforms local verts', () => {
  const outX = new Float32Array(3);
  const outY = new Float32Array(3);
  const localX = new Float32Array([0, 10, 0]);
  const localY = new Float32Array([0, 0, 10]);
  writePolygonVerts(outX, outY, 0, 100, 200, 1, 0, 0, 0, localX, localY, 0, 3);
  assert.equal(outX[0], 100);
  assert.equal(outY[0], 200);
  assert.equal(outX[1], 110);
  assert.equal(outY[1], 200);
  assert.equal(outX[2], 100);
  assert.equal(outY[2], 210);
});
