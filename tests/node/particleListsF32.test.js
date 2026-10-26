// E-76 W13, float32: the float32 list builds of wasm/particleLists.c (build_lists_f32x4 / build_lists_turned_f32x4)
// against its double builds (build_lists / build_lists_turned), which particleListsWasm.test.js ties to the JS
// build. Called through the shipped wrapper (buildParticleListsWasm) on a 12 007-slot pool (full, empty and
// partial 16-slot blocks, a tail of 7), positions over and past the
// world, NaN, infinite and past float32's range, under box cameras zoomed out, at 1 and at 2.5, and turned ones
// at 0.785, 2.4 and -1.1 rad. Some particles are planted on the box's edges (within a few float32 steps of them
// in double) and some 5e-3 px inside and outside. Each float32 build must give, by compareListBuilds
// (particleListsWasmMicrobench.mjs):
// - the same active list;
// - the same isItOnScreen byte for every slot, except a live particle whose double screen coordinate is within
//   listFlipSlack of an edge: four times a first-order bound on the float32 rounding of x * zoom - offX (and of
//   the turned view's rotation) and of the bound, 2e-3 to 8e-3 px at these coordinates; the particles that do
//   change sides are within 5 % of it, a float32 step or so. The box is the view plus the cull margin
//   (10 % of the canvas), so a particle that changes sides there is off the canvas either way: nothing drawn
//   changes. How many can change sides is the number of live particles that close to an edge, which the test
//   counts (none of the random ones, a share of the planted ones);
// - a visible list that is its flags in active-list order.
// A mutant (the camera offset 0.01 px off) must fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { createParticleMemory } from '../../src/util/particleMemory.js';
import { buildParticleListsWasm } from '../../src/workers/particleListsClient.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import {
  bindListKernels,
  caseCamera,
  compareListBuilds,
  listFlipSlack,
  LISTS_F32_EXPORTS,
  snapshotLists,
} from '../bench/particleListsWasmMicrobench.mjs';

const N = 12007;
const pc = ParticleComponent;
const mem = createParticleMemory(N, pc.getBufferSize(N));
pc.initializeArrays(mem.buffer, N);
const activeData = new Uint16Array(mem.buffer, mem.layout.activeListByte, N + 1);
const visibleData = new Uint16Array(mem.buffer, mem.layout.visibleListByte, N + 1);
const kernelsPromise = bindListKernels(mem.memory, mem.layout, pc);

const CAMERAS = {
  stress: caseCamera(0.3, 0, 0, 0),
  zoomed: caseCamera(1, 2000, 1500, 0),
  close: caseCamera(2.5, 1234.5, 987.25, 0),
  turned: caseCamera(0.6, 2000, 1500, 0.785),
  steep: caseCamera(1.7, 2500, 1200, 2.4),
  backwards: caseCamera(0.45, 800, 600, -1.1),
};

/** Full, empty and partial blocks; positions over the world and past it, and a few odd values. */
function populate(r) {
  for (let b = 0; b < N; b += 16) {
    const u = r();
    for (let i = b; i < Math.min(b + 16, N); i++) pc.active[i] = u < 0.4 ? 1 : u < 0.6 ? 0 : r() < 0.6 ? 1 : 0;
  }
  for (let i = 0; i < N; i++) {
    const u = r();
    if (u < 0.01) {
      pc.x[i] = [NaN, Infinity, -Infinity, 3e38, -0][Math.floor(r() * 5)];
      pc.y[i] = r() * 3000;
    } else {
      pc.x[i] = r() * 5000 - 500;
      pc.y[i] = r() * 4000 - 500;
    }
  }
}

/** Live particles on the camera's edges (`off` px from them, in double) at random points along them. */
function plant(r, cam, count, off) {
  const b = cam.bounds;
  const z = b.zoom;
  for (let n = 0; n < count; n++) {
    const i = Math.floor(r() * N);
    pc.active[i] = 1;
    const side = Math.floor(r() * 4);
    const sign = r() < 0.5 ? -1 : 1;
    const along = r();
    if (!cam.rotation) {
      const sx = side === 0 ? b.minX : side === 1 ? b.maxX : b.minX + along * (b.maxX - b.minX);
      const sy = side === 2 ? b.minY : side === 3 ? b.maxY : b.minY + along * (b.maxY - b.minY);
      const dx = side < 2 ? sign * off : 0;
      const dy = side >= 2 ? sign * off : 0;
      pc.x[i] = (sx + dx + b.cameraOffsetX) / z;
      pc.y[i] = (sy + dy + b.cameraOffsetY) / z;
    } else {
      const u = side === 0 ? -cam.limW : side === 1 ? cam.limW : (along * 2 - 1) * cam.limW;
      const v = side === 2 ? -cam.limH : side === 3 ? cam.limH : (along * 2 - 1) * cam.limH;
      const uu = u + (side < 2 ? sign * off : 0);
      const vv = v + (side >= 2 ? sign * off : 0);
      // (u, v) = R (dx, dy) with R = [rc -rs; rs rc]: back by R's transpose.
      const dx = cam.rc * uu + cam.rs * vv;
      const dy = -cam.rs * uu + cam.rc * vv;
      pc.x[i] = (dx + cam.w * 0.5 + b.cameraOffsetX) / z;
      pc.y[i] = (dy + cam.h * 0.5 + b.cameraOffsetY) / z;
    }
  }
}

function build(k, cam) {
  pc.isItOnScreen.fill(0);
  buildParticleListsWasm(k, N, cam.bounds, cam.rotation, cam.w, cam.h, cam.cull);
  return snapshotLists(activeData, visibleData, pc.isItOnScreen, N);
}

test('float32 list builds give the shipped lists, flags only changing within a float32 rounding of an edge', async (t) => {
  const kernels = await kernelsPromise;
  const r = mulberry32(0x11575);
  populate(r);
  let flips = 0;
  for (const [name, cam] of Object.entries(CAMERAS)) {
    plant(r, cam, 120, 0);
    plant(r, cam, 60, 5e-3);
    let near = 0;
    let slack = 0;
    for (let i = 0; i < N; i++) {
      const s = pc.active[i] ? listFlipSlack(pc.x[i], pc.y[i], cam) : null;
      if (s) {
        near++;
        slack = Math.max(slack, s.slack);
      }
    }
    const ref = build(kernels.wasm, cam);
    const outs = {};
    for (const v of Object.keys(LISTS_F32_EXPORTS)) {
      const stats = { flips: 0, worst: 0 };
      outs[v] = build(kernels[v], cam);
      assert.equal(compareListBuilds(ref, outs[v], pc.x, pc.y, cam, stats), null, `${name} ${v}`);
      assert.ok(stats.flips <= near, `${name} ${v}: ${stats.flips} flips, ${near} particles near an edge`);
      if (v === 'wasm-f32x4') {
        flips += stats.flips;
        t.diagnostic(`${name}: ${ref.active[0]} live, ${ref.visible[0]} visible, ${near} within the slack of an edge (up to ${slack.toExponential(1)} px), ${stats.flips} on the other side (the farthest at ${(stats.worst * 100).toFixed(0)} % of its slack)`);
      }
    }
  }
  assert.ok(flips > 0, 'some planted particle changed sides (the test reaches the edge case)');
});

test('the comparison catches a camera offset 0.01 px off', async () => {
  const kernels = await kernelsPromise;
  const r = mulberry32(0x11576);
  populate(r);
  const cam = CAMERAS.zoomed;
  plant(r, cam, 60, 5e-3);
  const ref = build(kernels.wasm, cam);
  const shifted = { ...cam, bounds: { ...cam.bounds, cameraOffsetX: cam.bounds.cameraOffsetX + 0.01 } };
  for (const v of Object.keys(LISTS_F32_EXPORTS)) {
    pc.isItOnScreen.fill(0);
    buildParticleListsWasm(kernels[v], N, shifted.bounds, 0, cam.w, cam.h, cam.cull);
    const got = snapshotLists(activeData, visibleData, pc.isItOnScreen, N);
    assert.match(String(compareListBuilds(ref, got, pc.x, pc.y, cam)), /no edge within the slack/, v);
  }
});
