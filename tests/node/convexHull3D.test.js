import test from 'node:test';
import assert from 'node:assert/strict';

import { convexHull3D } from '../../src/render/convexHull3D.js';

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Each triangle looks away from the hull, no point lies past any face, and the surface closes. */
function assertHull(x, y, z, n, triangles) {
  assert.equal(triangles.length % 3, 0);
  const edges = new Map();
  for (let t = 0; t < triangles.length; t += 3) {
    const [i, j, k] = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const ax = x[j] - x[i];
    const ay = y[j] - y[i];
    const az = z[j] - z[i];
    const bx = x[k] - x[i];
    const by = y[k] - y[i];
    const bz = z[k] - z[i];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    assert.ok(length > 0, `triangle ${t / 3} has an area`);
    for (let p = 0; p < n; p++) {
      const past = (nx * (x[p] - x[i]) + ny * (y[p] - y[i]) + nz * (z[p] - z[i])) / length;
      assert.ok(past <= 1e-3, `point ${p} is ${past} past triangle ${t / 3}`);
    }
    for (const [from, to] of [[i, j], [j, k], [k, i]]) {
      const key = `${from},${to}`;
      assert.equal(edges.has(key), false, `edge ${key} twice`);
      edges.set(key, true);
    }
  }
  for (const key of edges.keys()) {
    const [from, to] = key.split(',');
    assert.ok(edges.has(`${to},${from}`), `edge ${key} has no other side`);
  }
}

test('a box: its eight corners, twelve triangles', () => {
  const x = [0, 10, 10, 0, 0, 10, 10, 0];
  const y = [0, 0, 5, 5, 0, 0, 5, 5];
  const z = [0, 0, 0, 0, 7, 7, 7, 7];
  const triangles = convexHull3D(x, y, z, 8);
  assert.equal(triangles.length, 36);
  assertHull(x, y, z, 8, triangles);
  assert.equal(new Set(triangles).size, 8);
});

test('points inside the hull are left out', () => {
  const x = [0, 10, 0, 0, 1, 2];
  const y = [0, 0, 10, 0, 1, 2];
  const z = [0, 0, 0, 10, 1, 2];
  const triangles = convexHull3D(x, y, z, 6);
  assertHull(x, y, z, 6, triangles);
  assert.equal(new Set(triangles).size, 4);
});

test('random clouds close and hold every point', () => {
  const r = seeded(0x51ab);
  for (let round = 0; round < 40; round++) {
    const n = 4 + ((r() * 60) | 0);
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const z = new Float64Array(n);
    for (let p = 0; p < n; p++) {
      x[p] = r() * 300 - 150;
      y[p] = r() * 200 - 100;
      z[p] = r() * 120;
    }
    const triangles = convexHull3D(x, y, z, n);
    assert.ok(triangles, `round ${round}`);
    assertHull(x, y, z, n, triangles);
  }
});

test('a house of stacked boxes: points on one plane do not break it', () => {
  // The game's shape: corners repeated at two heights, many on one wall's plane.
  const x = [0, 1.2, 152.4, 217, 216.2, 151.2, 217, 216.2, 0, 1.2, 152.4, 151.2];
  const y = [0, -3.8, -3.8, -3.2, -0.5, 0, -3.2, -0.5, 0, -3.8, -3.8, 0];
  const z = [0, 0, 0, 0, 0, 0, 90, 90, 90, 90, 90, 90];
  const triangles = convexHull3D(x, y, z, 12);
  assertHull(x, y, z, 12, triangles);
});

test('points that enclose nothing give no hull', () => {
  assert.equal(convexHull3D([0, 1, 2], [0, 1, 2], [0, 1, 2], 3), null, 'too few');
  assert.equal(convexHull3D([0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], 4), null, 'one point');
  assert.equal(convexHull3D([0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3], 4), null, 'a line');
  assert.equal(convexHull3D([0, 1, 1, 0], [0, 0, 1, 1], [0, 0, 0, 0], 4), null, 'a plane');
});
