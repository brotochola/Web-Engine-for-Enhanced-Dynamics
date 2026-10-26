// E-76 W2b: pre-render's visibility pass with each light's neighbour gather in visibilityGather.wasm, on a real
// worker initialized through its own init path with every column the gather reads in one memory (as Phase 4 lays
// them in Box2D's block: tests/helpers/visibilityWired.mjs bootPreRenderGather), against the same worker with
// wasm.visibilityGather false (the JS gather, on the same memory). The scene: lights among rotated boxes,
// circles, convex polygons, half-blocking occluders, offset colliders and compound rings (W1 rasters those from
// the kernel's events), over several frames. The kernel packs what the JS packs, in the same order, so every
// light's polygon and the self-lit list must be the JS's bit for bit; and with a small self-lit cap too.
import test from 'node:test';
import assert from 'node:assert/strict';

import { bootPreRenderGather, makeScene, runFrame, writeFrame } from '../helpers/visibilityWired.mjs';
import { collectSolidJs } from '../reference/visibilitySweepJs.mjs';

const TIMES = [0, 0.35, 0.9, 1.6, 2.75, 4.2];

/** Run the frames on a boot; with the kernel, count its calls. */
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

function sameFrames(js, k, label) {
  assert.equal(k.length, js.length);
  let lights = 0;
  let selfLit = 0;
  for (let f = 0; f < js.length; f++) {
    assert.equal(k[f].lights.length, js[f].lights.length, `${label} frame ${f}: lights`);
    for (let l = 0; l < js[f].lights.length; l++) {
      const a = js[f].lights[l];
      const b = k[f].lights[l];
      assert.equal(b.idx, a.idx, `${label} frame ${f} light ${l}: index`);
      assert.equal(b.n, a.n, `${label} frame ${f} light ${a.idx}: vertex count`);
      assert.deepEqual(Array.from(b.x), Array.from(a.x), `${label} frame ${f} light ${a.idx}: x`);
      assert.deepEqual(Array.from(b.y), Array.from(a.y), `${label} frame ${f} light ${a.idx}: y`);
      lights++;
    }
    assert.deepEqual(k[f].selfLit, js[f].selfLit, `${label} frame ${f}: self-lit list`);
    selfLit += js[f].selfLit.length;
  }
  return { lights, selfLit };
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
  assert.ok(calls.n >= n.lights, `${label}: ${calls.n} kernel calls for ${n.lights} lights`);
  return n;
}

test('W2b: the gather kernel publishes the JS gather\'s polygons and self-lit lists, bit for bit', async () => {
  const n = await compare(0x2b2b, {}, {}, 'mixed scene');
  assert.ok(n.lights >= 200 && n.selfLit > 1000, `${n.lights} lights, ${n.selfLit} self-lit items compared`);
});

test('W2b: a small self-lit cap fills as the JS fills it', async () => {
  const n = await compare(0x2b2c, { rings: 4 }, { selfLit: 40 }, 'self-lit cap 40');
  assert.ok(n.selfLit >= 6 * 40, `the cap filled every frame (${n.selfLit} items)`);
});

test('W2b: a scene with no compound solid (the bins never cleared) matches too', async () => {
  await compare(0x2b2d, { rings: 0 }, {}, 'no compound solid');
});

test('W2b: with the JS raster in place of W1, the compound solids the kernel sends back raster in JS and match', async () => {
  await compare(0x2b2e, { rings: 6 }, {}, 'the JS raster', true);
});
