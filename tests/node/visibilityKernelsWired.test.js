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
//
// W1, the compound raster in solidSegments.wasm (on by default with the sweep): the same frames with it on
// and off publish the same polygons and self-lit lists bit for bit (a bin it stamps holds the JS's distance
// and owner; it can differ only where a solid's end lies within ~1e-15 rad of a bin edge), also across a
// remesh (a new fixture revision, one outline grown, one moved); the client's copies of the outlines start
// over when their region fills and a solid larger than the region rasters in JS, on the same bins.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POLAR_BINS,
  bindPolarBins,
  clearPolarBins,
  ensureCompoundSolid,
  polarBinArrays,
  polarBinsActive,
} from '../../src/render/visibility/angularSweep.js';
import {
  SOLID_ARGS,
  bindSolidSegments,
  collectSolidJs,
  collectSolidWasm,
  solidSegmentsStats,
} from '../../src/render/visibility/solidSegmentsClient.js';
import { MAX_POLYGON_VERTICES, WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createVisibilityMemory } from '../../src/util/visibilityMemory.js';
import {
  MAX_FLIP_SHARE,
  bootPreRender,
  compareFrames,
  makeScene,
  ringTriangles,
  runFrame,
  writeFrame,
} from '../helpers/visibilityWired.mjs';

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

// ---- W1: the compound raster ----------------------------------------------------------------------------

/** Every light's polygon and the self-lit list, bit for bit. */
function assertBitForBit(a, b, label) {
  a.forEach((frame, f) => {
    const c = compareFrames(frame, b[f]);
    assert.deepEqual(c.bad, [], `${label}, frame ${f}`);
    assert.deepEqual(c.flips, [], `${label}, frame ${f}`);
    assert.equal(c.exact, c.lights, `${label}, frame ${f}: every polygon bit for bit`);
  });
}

/** Lights whose polygon is the polar merge's (a vertex per bin at the 512 cap). */
const polarLights = (frames) => frames.reduce((n, f) => n + f.lights.filter((L) => L.n === POLAR_BINS).length, 0);

test('W1: compound solids raster in solidSegments.wasm, and the polygons are the JS raster\'s, bit for bit', async (t) => {
  assert.equal(WASM_DEFAULTS.solidSegments, true);
  const scene = makeScene(0x5011d, {
    lights: 20, boxes: 40, circles: 10, polygons: 10, rings: 28, ringSegments: [64, 18, 40], radius: [250, 700],
  });
  const off = await bootPreRender(scene, { wasm: { solidSegments: false } });
  assert.equal(off.pre._visCollectSolid, collectSolidJs, 'solidSegments false: the JS raster in the swept loop');
  const js = framesOf(off);
  const boot = await bootPreRender(scene);
  assert.equal(boot.pre._visCollectSolid, collectSolidWasm, 'the kernel by default');
  let calls = 0;
  boot.pre._visCollectSolid = (solid, owner) => {
    calls++;
    return collectSolidWasm(solid, owner);
  };
  const k = framesOf(boot);
  assertBitForBit(js, k, 'W1');
  const stats = solidSegmentsStats();
  assert.equal(stats.fallbacks, 0, 'every outline fits');
  assert.ok(stats.copies <= 28, `each solid copied once (${stats.copies})`);
  assert.ok(calls > 200, `${calls} (light, solid) calls`);
  assert.ok(polarLights(js) > 30, `${polarLights(js)} lights merged with their bins`);
  t.diagnostic(`${calls} calls, ${stats.copies} outline copies, ${polarLights(js)} polar lights`);
});

test('W1: a remesh (a new fixture revision) copies the outlines again, grown or moved, and still matches', async () => {
  const scene = makeScene(0x7e5, { lights: 16, boxes: 30, circles: 8, polygons: 8, rings: 12, ringSegments: 18, radius: [250, 600] });
  const first = scene.ents.findIndex((e) => e.kind === 'ring');
  const remeshed = { ...scene, ents: scene.ents.map((e) => ({ ...e })) };
  remeshed.ents[first].tris = ringTriangles(30, 80, 32); // 36 outline edges -> 60: a new slot
  remeshed.ents[first + 1].tris = ringTriangles(18, 70, 40); // the same count, moved: its own slot again
  const plan = [[0, scene, 7], [0.5, scene, 7], [1, remeshed, 8], [1.5, remeshed, 8], [2, scene, 9]];
  const run = async (opts) => {
    const boot = await bootPreRender(scene, { ...opts, fixtureSlack: 40 });
    return plan.map(([t, s, revision]) => {
      writeFrame(boot, t, { scene: s, revision });
      return runFrame(boot);
    });
  };
  const js = await run({ wasm: { solidSegments: false } });
  const k = await run({});
  assertBitForBit(js, k, 'remesh');
  const stats = solidSegmentsStats();
  // Three revisions: a lit solid is copied once in each, not once a frame.
  assert.ok(stats.copies > 12 && stats.copies <= 36, `${stats.copies} outline copies over three revisions`);
  assert.ok(polarLights(js) > 10);
});

test('W1: outline copies start over when their region fills, and a solid past the region rasters in JS', async () => {
  const { buildSolid, trianglesCompound } = await import('../helpers/solidSegmentsKernel.mjs');
  // Four fixtures' worth: 4 x MAX_POLYGON_VERTICES edges = 640 bytes of copies.
  const vm = createVisibilityMemory({ maxOccluders: 4, poolVerts: 16, maxVerts: 64, entities: 16, fixtures: 4 });
  assert.equal(vm.layout.solidBytes, 4 * MAX_POLYGON_VERTICES * 20);
  bindPolarBins(vm.views.polarDist, vm.views.polarOwner);
  try {
    assert.ok(await bindSolidSegments(vm));
    const ring = (entity, segments) => buildSolid(entity, 1, trianglesCompound(ringTriangles(segments, 80, 32)));
    const a = ring(9001, 6); // 12 edges, 240 bytes
    const b = ring(9002, 6);
    const c = ring(9003, 8); // 16 edges, 320 bytes
    const big = ring(9004, 18); // 36 edges, 720 bytes: past the region
    const R = 400;
    const raster = (fn, solid, owner, pose) => {
      SOLID_ARGS.set([...pose, 20, -15, R * R]);
      clearPolarBins(R);
      const hit = fn(solid, owner);
      return { hit: hit > 0, active: polarBinsActive(), dist: Float32Array.from(vm.views.polarDist), owner: Int32Array.from(vm.views.polarOwner) };
    };
    const steps = [[a, [100, 40, 1, 0, 0, 0]], [b, [-120, 60, 0.8, 0.6, 5, 0]], [c, [30, -150, 0, 1, 0, -3]],
      [a, [110, 30, 1, 0, 0, 0]], [b, [-120, 70, 0.6, 0.8, 0, 0]], [big, [0, 200, 1, 0, 0, 0]], [c, [40, -140, 0, 1, 0, 0]]];
    steps.forEach(([solid, pose], i) => {
      const js = raster(collectSolidJs, solid, i + 1, pose);
      const wasm = raster(collectSolidWasm, solid, i + 1, pose);
      assert.ok(js.active, `step ${i}: the solid is lit`);
      assert.deepEqual(wasm, js, `step ${i}: the bins, the owners, hit and the active flag`);
    });
    const stats = solidSegmentsStats();
    assert.equal(stats.fallbacks, 1, 'the solid past the region rastered in JS');
    assert.equal(stats.resets, 2, 'the region started over twice');
    assert.equal(stats.copies, 6, 'a, b, c, then a and b again after the first restart, c after the second');
  } finally {
    bindPolarBins(null, null);
  }
});

test('W1: with wasm.solidSegments false or no fixture pool, the swept loop rasters solids in JS', async () => {
  const scene = makeScene(0x0ff, { lights: 4, boxes: 10, circles: 2, polygons: 2, rings: 2 });
  const off = await bootPreRender(scene, { wasm: { solidSegments: false } });
  assert.ok(off.pre._visSweep, 'the sweep kernel still');
  assert.equal(off.pre._visCollectSolid, collectSolidJs);
  assert.equal(solidSegmentsStats().bound, false);
  const on = await bootPreRender(scene);
  assert.equal(on.pre._visCollectSolid, collectSolidWasm);
  assert.equal(solidSegmentsStats().bound, true);
  const noPool = await bootPreRender(scene, { fixtures: false });
  assert.ok(noPool.pre._visSweep);
  assert.equal(noPool.pre._visCollectSolid, collectSolidJs, 'no fixture pool, no compound solid to raster');
  assert.equal(solidSegmentsStats().bound, false);
  const sweepOff = await bootPreRender(scene, { wasm: { visibilitySweep: false } });
  assert.equal(sweepOff.pre._visCollectSolid, collectSolidJs, 'solidSegments needs visibilitySweep');
  assert.equal(solidSegmentsStats().bound, false);
});
