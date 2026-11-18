// E-76 W2b: pre-render's visibility pass with each light's neighbour gather in visibilityGather.wasm, on a real
// worker initialized through its own init path with every column the gather reads in one memory (as Phase 4 lays
// them in Box2D's block: tests/helpers/visibilityWired.mjs bootPreRenderGather), against the same worker with
// wasm.visibilityGather false (the JS gather, on the same memory). The scene: lights among rotated boxes,
// circles, convex polygons, half-blocking occluders, offset colliders and compound rings (W1 rasters those from
// the kernel's events), over several frames. The kernel packs what the JS packs, in the same order, and names each
// packed occluder with the code the JS works out (OL-12), so every lamp's row (OL-15: all the worker publishes) must
// be the JS gather's bit for bit: the same lamps with a row, the same polygon, the same wall on every edge.
import test from 'node:test';
import assert from 'node:assert/strict';

import { bootPreRenderGather, compareRows, makeScene, rowWalls, runFrame, writeFrame } from '../helpers/visibilityWired.mjs';
import { collectSolidJs } from '../reference/visibilitySweepJs.mjs';

const TIMES = [0, 0.35, 0.9, 1.6, 2.75, 4.2];

/** Run the frames on a boot: each frame's rows. */
function frames(boot, scene) {
  const out = [];
  for (const t of TIMES) {
    writeFrame(boot, t, { scene });
    out.push(runFrame(boot));
  }
  return out;
}

function countGather(pre) {
  const g = pre._visGather;
  const calls = { n: 0 };
  for (const key of ['gather16', 'gather32']) {
    const fn = g[key];
    g[key] = (...a) => {
      calls.n++;
      return fn(...a);
    };
  }
  return calls;
}

/** The kernel's rows are the JS gather's, bit for bit; the rows and the walls they name, counted. */
function sameFrames(js, k, label) {
  assert.equal(k.length, js.length);
  let rows = 0;
  let walls = 0;
  for (let f = 0; f < js.length; f++) {
    assert.deepEqual(compareRows(js[f], k[f]), [], `${label} frame ${f}`);
    rows += js[f].lamps.length;
    for (let r = 0; r < js[f].lamps.length; r++) walls += rowWalls(js[f], r).size;
  }
  return { rows, walls };
}

async function compare(seed, sceneOpts, bootOpts, label, rasterJs = false) {
  const scene = makeScene(seed, sceneOpts);
  // The JS gather: the worker's own loop with no gather kernel, on the same placed memory.
  const jsBoot = await bootPreRenderGather(scene, bootOpts);
  assert.ok(jsBoot.pre._visGather, `${label}: the kernel is bound`);
  jsBoot.pre._visGather = null;
  if (rasterJs) jsBoot.pre._visCollectSolid = collectSolidJs;
  assert.equal(jsBoot.pre._visMemory, jsBoot.memory, `${label}: the visibility memory is placed in the shared memory`);
  const js = frames(jsBoot, scene);
  const kBoot = await bootPreRenderGather(scene, bootOpts);
  if (rasterJs) kBoot.pre._visCollectSolid = collectSolidJs;
  assert.ok(kBoot.pre._visGather, `${label}: the kernel is bound`);
  assert.equal(kBoot.pre._visMemory, kBoot.memory);
  const calls = countGather(kBoot.pre);
  const k = frames(kBoot, scene);
  const n = sameFrames(js, k, label);
  // A light that casts no shadow (castShadows 0) gathers nothing: only the others call the kernel, each once a
  // frame, whether or not it finds a wall (a lamp with nothing in reach has no row).
  n.lights = scene.ents.filter((e) => e.kind === 'light' && e.casts !== 0).length * TIMES.length;
  assert.equal(calls.n, n.lights, `${label}: ${calls.n} kernel calls for ${n.lights} lights`);
  assert.ok(n.rows <= n.lights, `${label}: ${n.rows} rows for ${n.lights} lights`);
  return n;
}

test('W2b: the gather kernel publishes the JS gather\'s rows, bit for bit', async () => {
  const n = await compare(0x2b2b, {}, {}, 'mixed scene');
  assert.ok(n.lights >= 200 && n.rows >= 200 && n.walls > 1000, `${n.lights} lights, ${n.rows} rows naming ${n.walls} walls compared`);
});

test('W2b: a scene with no compound solid (the bins never cleared) matches too', async () => {
  const n = await compare(0x2b2d, { rings: 0 }, {}, 'no compound solid');
  assert.ok(n.rows >= 200 && n.walls > 1000, `${n.rows} rows naming ${n.walls} walls compared`);
});

test('W2b: with the JS raster in place of W1, the compound solids the kernel sends back raster in JS and match', async () => {
  const n = await compare(0x2b2e, { rings: 6 }, {}, 'the JS raster', true);
  assert.ok(n.rows >= 200 && n.walls > 1000, `${n.rows} rows naming ${n.walls} walls compared`);
});
