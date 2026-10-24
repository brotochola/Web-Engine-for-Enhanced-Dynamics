// E-76 W2a: pre-render's visibility pass with its sweep in visibilitySweep.wasm, on a real worker initialized
// through its own init path (tests/helpers/visibilityWired.mjs), against the same worker on the JS path.
//
// The gate is the sweep kernel's (tests/node/visibilitySweepWasm.test.js, comparePolygons): each light's
// polygon with the same vertex count and every vertex within H-06's 1e-4 world units plus a float32 ulp
// (wasm.visibilitySweepF32 false, the double SIMD sweep) or 1e-4 of its distance from the light plus that ulp
// (the float32 sweep, the default). The self-lit list (N-19 solids, N-39 simple occluders) must be the JS's,
// item for item, and the lights the same, in the same slots. The scene: lights among rotated boxes, circles,
// convex polygons, half-blocking occluders, offset colliders and compound rings (whose polar bins the JS
// raster stamps into the memory and the kernel merges), over several frames; a small vertex cap (bins merged
// in groups); and a light past the active cap, which gives up as the JS does, with the JS's warning once.
import test from 'node:test';
import assert from 'node:assert/strict';

import { polarBinArrays } from '../../src/render/visibility/angularSweep.js';
import { WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { MAX_FLIP_SHARE, bootPreRender, compareFrames, makeScene, runFrame, writeFrame } from '../helpers/visibilityWired.mjs';

const FRAMES = [0, 0.7, 1.4, 2.1];

/** console.warn's messages while fn runs. */
async function warnings(fn) {
  const seen = [];
  const warn = console.warn;
  console.warn = (...a) => seen.push(a.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.warn = warn;
  }
  return seen;
}

/** Count the kernel's calls (the bound export, wrapped). */
function countCalls(pre) {
  const bound = pre._visSweep;
  const fn = bound.sweep;
  const counter = { calls: 0 };
  bound.sweep = (...a) => {
    counter.calls++;
    return fn(...a);
  };
  return counter;
}

function framesOf(boot) {
  return FRAMES.map((t) => {
    writeFrame(boot, t);
    return runFrame(boot);
  });
}

/** Every frame within the gate, and flips at most MAX_FLIP_SHARE of the lights. */
function assertSame(js, k, label, opts) {
  let lights = 0;
  let vertices = 0;
  let exact = 0;
  const flips = [];
  js.forEach((frame, f) => {
    const c = compareFrames(frame, k[f], opts);
    assert.deepEqual(c.bad, [], `${label}, frame ${f}`);
    lights += c.lights;
    vertices += c.vertices;
    exact += c.exact;
    flips.push(...c.flips.map((s) => `frame ${f} ${s}`));
  });
  assert.ok(flips.length <= MAX_FLIP_SHARE * lights, `${label}: ${flips.length} flips in ${lights} lights (${flips.join('; ')})`);
  return { lights, vertices, exact, flips };
}

test('the active cap: the kernel gives up on the light as the JS does, with the JS sweep\'s warning once', async () => {
  // 300 small circles in a row from the light: every one is open at once past -pi's seeding, over the
  // sweep's 256. A second light among a few of them sweeps normally.
  const ents = [
    { kind: 'light', x: 1200, y: 900, sqrtI: 60, vx: 0, vy: 0 },
    { kind: 'light', x: 600, y: 300, sqrtI: 20, vx: 0, vy: 0 },
  ];
  for (let i = 0; i < 300; i++) {
    ents.push({ kind: 'circle', x: 1230 + i * 1.8, y: 900 + 0.4 * Math.sin(i), r: 3, angle: 0, spin: 0, vx: 0, vy: 0, block: 1, offX: 0, offY: 0 });
  }
  for (let i = 0; i < 6; i++) {
    ents.push({ kind: 'box', x: 560 + i * 25, y: 380, w: 12, h: 20, angle: 0.3 * i, spin: 0, vx: 0, vy: 0, block: 1, offX: 0, offY: 0 });
  }
  const scene = { ents, lights: 2, entities: ents.length, fixtures: 0 };

  let wasm;
  let calls;
  const kernelWarnings = await warnings(async () => {
    const boot = await bootPreRender(scene, { maxNeighbors: 512 });
    calls = countCalls(boot.pre);
    writeFrame(boot, 0);
    wasm = [runFrame(boot), runFrame(boot)];
  });
  const capWarnings = kernelWarnings.filter((m) => m.includes('[AngularSweep] Active occluder cap exceeded (256 max simultaneous)'));
  assert.equal(capWarnings.length, 1, `one warning over two frames (${kernelWarnings.join(' | ')})`);
  assert.equal(calls.calls, 4, 'both lights swept by the kernel, both frames');
  assert.equal(wasm[0].lights[0].n, 32, 'the light past the cap is the full circle');
  assert.ok(wasm[0].lights[1].n > 4, 'the other light has its polygon');

  let js;
  const jsWarnings = await warnings(async () => {
    const boot = await bootPreRender(scene, { maxNeighbors: 512, wasm: { visibilitySweep: false } });
    writeFrame(boot, 0);
    js = [runFrame(boot)];
  });
  assert.equal(jsWarnings.filter((m) => m.includes('Active occluder cap')).length, 0, 'the warning is the JS sweep\'s own, given once');
  const c = compareFrames(js[0], wasm[0], { relative: true });
  assert.deepEqual(c.bad, [], 'a sweep that gives up hides nobody: every circle in range stays self-lit');
  assert.deepEqual(c.flips, []);
  assert.ok(js[0].selfLit.length >= 300, `${js[0].selfLit.length} self-lit items`);
});

test('a scene on the JS path binds what it bound before the visibility kernels', async () => {
  const scene = makeScene(0x0b1d, { lights: 6, boxes: 30, circles: 10, polygons: 5, rings: 1 });
  // A kernel scene first: its memory and bins must not outlive it.
  const on = await bootPreRender(scene);
  assert.ok(on.pre._visSweep, 'the kernel scene binds the sweep');
  assert.equal(polarBinArrays().own, false);

  const { pre } = await bootPreRender(scene, { wasm: { visibilitySweep: false } });
  assert.equal(pre._visSweep, null, 'no sweep kernel');
  assert.equal(pre._visMemory, null, 'no visibility memory');
  const bins = polarBinArrays();
  assert.ok(bins.own, 'the polar bins are angularSweep.js\' own arrays again');
  assert.ok(!(bins.dist.buffer instanceof SharedArrayBuffer));
  const plain = [
    ['_vpOccKind', Uint8Array, 1024], ['_vpCircleX', Float32Array, 1024], ['_vpCircleY', Float32Array, 1024],
    ['_vpCircleR', Float32Array, 1024], ['_vpVertStart', Int32Array, 1024], ['_vpVertCount', Uint8Array, 1024],
    ['_vpVertsX', Float32Array, 1024 * 8], ['_vpVertsY', Float32Array, 1024 * 8],
    ['_vpOutX', Float32Array, 512], ['_vpOutY', Float32Array, 512], ['_selfLitSeen', Uint32Array, scene.entities],
  ];
  for (const [field, Ctor, length] of plain) {
    const a = pre[field];
    assert.ok(a instanceof Ctor, `${field} is a ${Ctor.name}`);
    assert.equal(a.length, length, `${field}'s length`);
    assert.ok(!(a.buffer instanceof SharedArrayBuffer) && a.byteOffset === 0 && a.buffer.byteLength === a.byteLength, `${field} is an array of its own`);
  }
  let swept = 0;
  pre._buildVisibilityPolygonsSwept = () => {
    swept++;
  };
  writeFrame({ pre, scene, maxNeighbors: 256 }, 0);
  pre.buildVisibilityPolygons();
  delete pre._buildVisibilityPolygonsSwept;
  assert.equal(swept, 0, 'the JS light loop ran');
  assert.ok(pre._vpWriteBuffer.header[0] > 0, 'and published polygons');

  // Without raycasted lighting there is no visibility pass and no memory, whatever the switches say.
  const dark = await bootPreRender(scene, { raycasted: false });
  assert.equal(dark.pre._visSweep, null);
  assert.equal(dark.pre._visMemory, null);
  assert.ok(polarBinArrays().own);
});

test('with wasm.visibilitySweep (default), the scratch, the bins and the seen stamps are views on the visibility memory', async () => {
  assert.equal(WASM_DEFAULTS.visibilitySweep, true);
  assert.equal(WASM_DEFAULTS.visibilitySweepF32, true);
  const scene = makeScene(0x5eed, { lights: 4, boxes: 10, circles: 4, polygons: 2, rings: 1 });
  const { pre } = await bootPreRender(scene);
  const k = pre._visSweep;
  assert.ok(k, 'the sweep kernel is bound');
  assert.equal(k.variant, 'f32', 'the float32 export by default');
  const buffer = pre._visMemory.buffer;
  for (const field of ['_vpOccKind', '_vpCircleX', '_vpCircleY', '_vpCircleR', '_vpVertStart', '_vpVertCount',
    '_vpVertsX', '_vpVertsY', '_vpOutX', '_vpOutY', '_selfLitSeen']) {
    assert.equal(pre[field].buffer, buffer, `${field} is in the memory`);
  }
  assert.equal(pre._vpOutX.length, 512, 'the polygon cap');
  assert.equal(pre._selfLitSeen.length, scene.entities, 'a seen stamp per entity');
  const bins = polarBinArrays();
  assert.ok(!bins.own && bins.dist.buffer === buffer && bins.owner.buffer === buffer, 'the polar bins are in the memory');

  const simd = await bootPreRender(scene, { wasm: { visibilitySweepF32: false } });
  assert.equal(simd.pre._visSweep.variant, 'simd', 'visibilitySweepF32 false: the double SIMD export');
});

for (const [name, wasm, relative] of [
  ['the float32 sweep (default)', {}, true],
  ['the double SIMD sweep (visibilitySweepF32 false)', { visibilitySweepF32: false }, false],
]) {
  test(`${name}: every light's polygon and the self-lit list are the JS's, frame after frame`, async (t) => {
    const scene = makeScene(0x2a2a);
    const js = framesOf(await bootPreRender(scene, { wasm: { visibilitySweep: false } }));
    const boot = await bootPreRender(scene, { wasm });
    const calls = countCalls(boot.pre);
    const k = framesOf(boot);
    const lit = js.reduce((n, f) => n + f.lights.length, 0);
    assert.equal(calls.calls, lit, 'one kernel call per light');
    const r = assertSame(js, k, name, { relative });
    assert.ok(r.vertices > lit * 20, `real polygons (${r.vertices} vertices over ${lit} lights)`);
    const solids = js.reduce((n, f) => n + f.selfLit.length, 0);
    assert.ok(solids > 200, `self-lit items to tell apart (${solids})`);
    t.diagnostic(`${r.lights} lights, ${r.vertices} vertices, ${r.exact} polygons bit for bit, ${r.flips.length} flips (${r.flips.join('; ')}), ${solids} self-lit items`);
  });
}

test('a small vertex cap: the polar merge groups bins as the JS does', async (t) => {
  const scene = makeScene(0x128, { lights: 24, boxes: 120, circles: 40, polygons: 30, rings: 10 });
  for (const maxVerts of [128, 17]) {
    const js = framesOf(await bootPreRender(scene, { maxVerts, wasm: { visibilitySweep: false } }));
    const k = framesOf(await bootPreRender(scene, { maxVerts }));
    const r = assertSame(js, k, `maxVerts ${maxVerts}`, { relative: true });
    t.diagnostic(`maxVerts ${maxVerts}: ${r.lights} lights, ${r.exact} bit for bit, ${r.flips.length} flips`);
  }
});
