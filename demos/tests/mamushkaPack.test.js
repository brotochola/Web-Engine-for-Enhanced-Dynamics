import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertPackCoversSolid,
  packMamushkaRoots,
} from '../../demos/mamushkaDigScene/mamushkaPack.js';

test('packMamushkaRoots tessellates solid cells without overlap or hollow cover', () => {
  const cols = 8;
  const rows = 8;
  const solid = new Uint8Array(cols * rows);
  const materials = new Uint8Array(cols * rows);
  for (let gy = 2; gy < 6; gy++) {
    for (let gx = 1; gx < 7; gx++) {
      const i = gy * cols + gx;
      solid[i] = 1;
      materials[i] = gx < 4 ? 0 : 1;
    }
  }
  const roots = packMamushkaRoots(solid, materials, cols, rows, 6);
  assert.ok(roots.length > 0);
  assertPackCoversSolid(solid, materials, cols, rows, roots);
  for (let i = 0; i < roots.length; i++) {
    assert.equal(roots[i].level, 1 + Math.log2(roots[i].sideCells));
    assert.ok(roots[i].level >= 1);
  }
});

test('packMamushkaRoots finest intact is order 1 (one order-1 cell)', () => {
  const cols = 2;
  const rows = 2;
  const solid = new Uint8Array([1, 0, 0, 0]);
  const materials = new Uint8Array([0, 0, 0, 0]);
  const roots = packMamushkaRoots(solid, materials, cols, rows, 6);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].level, 1);
  assert.equal(roots[0].sideCells, 1);
  assertPackCoversSolid(solid, materials, cols, rows, roots);
});
