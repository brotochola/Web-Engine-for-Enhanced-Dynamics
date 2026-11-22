// OL-4: the sweep kernel says, for each vertex of a light's polygon, what its ray hit (the table's outOcc): the occluder's
// index in the light's list, or -1 for a free ray. lampWallRow.js makes a lamp's row of it, so the light pass knows whose
// wall each edge of the polygon is. Here the shipped kernel (engine.wasm) on a memory laid out as pre-render's, with
// occluders packed by hand: every vertex that names an occluder lies on that occluder's outline.
import test from 'node:test';
import assert from 'node:assert/strict';

import { OCC_CIRCLE, OCC_POLY, writeOrientedBoxVerts } from '../../src/render/visibility/angularSweep.js';
import { bindVisibilitySweep } from '../../src/render/visibility/visibilitySweepClient.js';
import { createVisibilityMemory, visibilityMemoryOpts } from '../../src/util/visibilityMemory.js';

const RADIUS = 300;
const CIRCLE = { x: 150, y: 20, r: 30 };
const BOX = { x: -110, y: -90, w: 60, h: 40 };

async function boot() {
  const vm = createVisibilityMemory(visibilityMemoryOpts({ maxVerts: 128, entities: 64, fixtures: 0 }));
  assert.ok(vm, 'the visibility memory');
  const sweep = await bindVisibilitySweep(vm, { maxVerts: 128 });
  return { vm, sweep };
}

/** A circle and a box around a light at the origin, as the gather packs them. Returns the occluder count. */
function pack(views) {
  views.kind[0] = OCC_CIRCLE;
  views.cx[0] = CIRCLE.x;
  views.cy[0] = CIRCLE.y;
  views.cr[0] = CIRCLE.r;
  views.vertStart[0] = 0;
  views.vertCount[0] = 0;
  views.kind[1] = OCC_POLY;
  views.vertStart[1] = 0;
  writeOrientedBoxVerts(views.vertsX, views.vertsY, 0, BOX.x, BOX.y, BOX.w, BOX.h, 1, 0, 0, 0);
  views.vertCount[1] = 4;
  return 2;
}

/** A point's distance to the box's outline (axis-aligned, centred on BOX). */
function distToBox(x, y) {
  const dx = Math.abs(x - BOX.x) - BOX.w / 2;
  const dy = Math.abs(y - BOX.y) - BOX.h / 2;
  if (dx > 0 || dy > 0) return Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2);
  return Math.min(-dx, -dy);
}

test('each vertex names the occluder its ray hit, and a free ray names none', async () => {
  const { vm, sweep } = await boot();
  const v = vm.views;
  const occluders = pack(v);
  v.outOcc.fill(77);
  sweep.args[0] = 0;
  sweep.args[1] = 0;
  sweep.args[2] = RADIUS;
  const n = sweep.sweep(sweep.tableByte, occluders, 0);
  assert.ok(n >= 8 && n <= 128, `a polygon (${n} vertices)`);
  const seen = { free: 0, circle: 0, box: 0 };
  for (let i = 0; i < n; i++) {
    const x = v.outX[i];
    const y = v.outY[i];
    const occ = v.outOcc[i];
    const dist = Math.sqrt(x * x + y * y);
    if (occ === -1) {
      seen.free++;
      assert.ok(dist > RADIUS, `vertex ${i} is free and lies past the radius (${dist})`);
    } else if (occ === 0) {
      seen.circle++;
      const d = Math.sqrt((x - CIRCLE.x) ** 2 + (y - CIRCLE.y) ** 2);
      assert.ok(Math.abs(d - CIRCLE.r) < 0.05, `vertex ${i} is on the circle (${d})`);
    } else if (occ === 1) {
      seen.box++;
      assert.ok(distToBox(x, y) < 0.05, `vertex ${i} is on the box (${distToBox(x, y)})`);
    } else {
      assert.fail(`vertex ${i} names occluder ${occ}`);
    }
  }
  assert.ok(seen.free >= 4 && seen.circle >= 2 && seen.box >= 2, `free rays, the circle and the box all show: ${JSON.stringify(seen)}`);
  assert.equal(v.outOcc[n], 77, 'nothing is written past the polygon');
});

test('a light with nothing around it gets the full circle, every vertex free', async () => {
  const { vm, sweep } = await boot();
  vm.views.outOcc.fill(77);
  sweep.args[0] = 40;
  sweep.args[1] = -15;
  sweep.args[2] = RADIUS;
  const n = sweep.sweep(sweep.tableByte, 0, 0);
  assert.equal(n, 32);
  for (let i = 0; i < n; i++) assert.equal(vm.views.outOcc[i], -1, `vertex ${i}`);
});
