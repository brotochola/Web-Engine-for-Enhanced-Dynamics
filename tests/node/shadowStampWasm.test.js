// E-114 (W23): the shadow stamp kernel (shadowStamp.wasm, through shadowStampClient.js) against the shipped
// stampLightRange, in the scene's memory layout: the sun rows and the stamp output on the GPU queue's region
// of the render-queue memory, the scratch in the stamp regions. Random frames, built to reach every branch:
// clustered and wide-spread casters (past the grid's 128 × 128 cells the full scan runs), NaN, infinite and
// far casters (Math.floor(..) | 0 past 2^31), empty light slots, lights with no range, no intensity or a
// NaN range, per-light budgets, maxShadowsPerLight and maxShadowsPerEntity on and off, a stride and a begin,
// and stamps that fill up. Each frame: the same cursor, every stamp row and every light index bit for bit.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GPU_CASTER_FLOATS, computeGpuQueueBufferSize, createGpuQueueViews, gpuQueueCaps } from '../../src/render/gpuQueueLayout.js';
import { computeBufferSize } from '../../src/render/renderQueueLayout.js';
import { stampLightRange } from '../../src/render/gpuShadowCasters.js';
import { createRenderQueueMemory } from '../../src/util/renderQueueMemory.js';
import { bindShadowStamp, stampLightRangeWasm } from '../../src/render/shadowStampClient.js';

const MAX = 3000;
const LIGHTS = 24;
const PER_ENTITY = 3;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function setup() {
  const lighting = { enabled: true, shadowsEnabled: true, maxShadowCastingLights: LIGHTS, maxShadowsPerLight: 64, maxShadowsPerEntity: PER_ENTITY, maxLights: 64 };
  const caps = gpuQueueCaps(MAX, lighting);
  const m = createRenderQueueMemory(MAX, computeBufferSize(MAX), computeGpuQueueBufferSize(caps), null,
    { maxSun: caps.maxSun, maxPerEntity: PER_ENTITY, maxLights: LIGHTS });
  assert.ok(m?.layout.stamp);
  const dst = createGpuQueueViews(m.buffer, caps, m.layout.gpuAByte);
  const b = await bindShadowStamp(m.memory, m.layout.stamp);
  // The JS scratch as pre-render sizes it (_ensureStampScratch and the init's caps).
  const scratch = {
    tmpIdx: new Uint32Array(MAX),
    dist: new Float32Array(MAX),
    order: new Uint32Array(MAX),
    keepIdx: new Uint32Array(MAX),
    gridCounts: new Int32Array(128 * 128),
    gridStarts: new Int32Array(128 * 128 + 1),
    gridItems: new Uint32Array(MAX),
    lightVec: new Float32Array(4),
  };
  return { m, caps, dst, b, scratch };
}

/** A frame: casters into dst.sun, a light list, the stamp's parameters. */
function frame(r, k, caps, dst) {
  const mode = k % 7;
  const nSun = mode === 5 ? 1 + Math.floor(r() * 3) : Math.floor(r() * (caps.maxSun + 1));
  const sun = dst.sun;
  sun.fill(0, 0, (nSun + 1) * GPU_CASTER_FLOATS);
  const spread = mode === 1 ? 60000 : 4000;
  for (let c = 0; c < nSun; c++) {
    const b = c * GPU_CASTER_FLOATS;
    let x = (mode === 2 ? 1500 + r() * 300 : r() * spread) - 200;
    let y = (mode === 2 ? 1500 + r() * 300 : r() * spread) - 200;
    if (mode === 3 && c % 97 === 0) x = NaN;
    if (mode === 3 && c % 131 === 0) y = Infinity;
    if (mode === 4 && c % 53 === 0) x = (r() < 0.5 ? -1 : 1) * (1e12 + r() * 1e12);
    if (c % 7 === 0) x = Math.round(x); // exact ties in distance
    // Mode 6: casters on a few integer spots, so many share a distance to a light (the selection's ties).
    if (mode === 6) {
      x = 1000 + 16 * Math.floor(r() * 6);
      y = 1000 + 16 * Math.floor(r() * 6);
    }
    sun[b] = x;
    sun[b + 1] = y;
    for (let f = 2; f < GPU_CASTER_FLOATS; f++) sun[b + f] = r();
  }
  const lights = [];
  const n = Math.floor(r() * (LIGHTS + 1));
  for (let i = 0; i < n; i++) {
    if (r() < 0.05) {
      lights.push(null);
      continue;
    }
    const range = r() < 0.05 ? 0 : 50 + r() * 900;
    // Mode 6: lights in pairs and triples on one spot, so a caster is as near to several (the per-caster ties).
    if (mode === 6 && i > 0 && lights[i - 1] && r() < 0.6) {
      lights.push({ ...lights[i - 1] });
      continue;
    }
    if (mode === 6) {
      lights.push({ x: 1040 + 8 * Math.floor(r() * 4), y: 1040 + 8 * Math.floor(r() * 4), intensity: 1, rangeSq: 400 * 400, maxShadows: r() < 0.5 ? 1 + Math.floor(r() * 6) : 0 });
      continue;
    }
    lights.push({
      x: (mode === 2 ? 1600 : r() * spread) + (r() - 0.5) * 400,
      y: (mode === 2 ? 1600 : r() * spread) + (r() - 0.5) * 400,
      intensity: r() < 0.05 ? -1 : r() * 2,
      rangeSq: r() < 0.03 ? NaN : range * range,
      maxShadows: r() < 0.3 ? Math.floor(r() * 40) : 0,
    });
  }
  return {
    nSun,
    lights,
    maxPerLight: [0, 8, 64, 512][k % 4],
    maxPerEntity: k % 3 === 0 ? 0 : (k % 3 === 1 ? 1 : PER_ENTITY),
    lightBegin: k % 5 === 4 ? 1 : 0,
    lightStride: k % 7 === 6 ? 2 : 1,
    stampCap: k % 4 === 3 ? Math.floor(r() * 50) : caps.maxStamp,
    stampBase: k % 9 === 8 ? 3 : 0,
  };
}

function specFor(f, dst, scratch) {
  return {
    sun: dst.sun,
    sunN: f.nSun,
    sunFloats: GPU_CASTER_FLOATS,
    lights: f.lights,
    lightBegin: f.lightBegin,
    lightEnd: f.lights.length,
    lightStride: f.lightStride,
    maxPerLight: f.maxPerLight,
    maxPerEntity: f.maxPerEntity,
    used: null,
    ...scratch,
    stamp: dst.stamp,
    stampFloats: GPU_CASTER_FLOATS,
    stampCap: f.stampCap,
    stampBase: f.stampBase,
    stampLightIdx: dst.stampLightIdx,
  };
}

test('the stamp kernel writes what stampLightRange writes, frame after frame', async (t) => {
  const { caps, dst, b, scratch } = await setup();
  const r = rng(0x5ea1);
  const stampBytes = new Uint8Array(dst.stamp.buffer, dst.stamp.byteOffset, dst.stamp.byteLength);
  const idxBytes = new Uint8Array(dst.stampLightIdx.buffer, dst.stampLightIdx.byteOffset, dst.stampLightIdx.byteLength);
  let stamped = 0;
  let declined = 0;
  for (let k = 0; k < 240; k++) {
    const f = frame(r, k, caps, dst);
    const spec = specFor(f, dst, scratch);
    stampBytes.fill(0xa5);
    idxBytes.fill(0xa5);
    const jsCursor = stampLightRange(spec);
    const jsStamp = stampBytes.slice();
    const jsIdx = idxBytes.slice();
    stampBytes.fill(0xa5);
    idxBytes.fill(0xa5);
    const cursor = stampLightRangeWasm(b, spec);
    if (cursor < 0) {
      declined++;
      continue;
    }
    assert.equal(cursor, jsCursor, `frame ${k} (${f.nSun} casters, ${f.lights.length} lights): cursor`);
    const at = stampBytes.findIndex((x, i) => x !== jsStamp[i]);
    assert.equal(at, -1, `frame ${k}: stamp rows differ at byte ${at}`);
    const ai = idxBytes.findIndex((x, i) => x !== jsIdx[i]);
    assert.equal(ai, -1, `frame ${k}: light indices differ at byte ${ai}`);
    stamped += cursor;
  }
  assert.equal(declined, 0, 'every frame fits the regions');
  assert.ok(stamped > 10000, `the frames stamp something (${stamped} rows)`);
  t.diagnostic(`${stamped} stamp rows over 240 frames`);
});

test('a call the regions cannot hold is declined, so the JS stamps it', async () => {
  const { caps, dst, b, scratch } = await setup();
  const r = rng(7);
  const f = frame(r, 1, caps, dst);
  const spec = specFor(f, dst, scratch);
  assert.equal(stampLightRangeWasm(b, { ...spec, maxPerEntity: PER_ENTITY + 1 }), -1, 'more slots per entity');
  assert.equal(stampLightRangeWasm(b, { ...spec, lights: new Array(LIGHTS + 1).fill(null), lightEnd: LIGHTS + 1 }), -1, 'more lights');
  assert.equal(stampLightRangeWasm(b, { ...spec, stamp: new Float32Array(dst.stamp.length) }), -1, 'stamp rows outside the memory');
  assert.equal(stampLightRangeWasm(b, { ...spec, sunN: caps.maxSun + 1 }), -1, 'more casters than the scratch holds');
  assert.equal(stampLightRangeWasm(b, { ...spec, sunN: 0 }), spec.stampBase | 0, 'no casters: the JS early return');
});

test('pre-render binds the stamp kernel and its stamp is the JS one', async () => {
  const { RENDER_QUEUE_CAMERA_BYTES } = await import('../../src/render/renderQueueLayout.js');
  const { ShadowCaster } = await import('../../src/components/shadowCaster.js');
  const { coreComponentData, initWorker, loadWorker } = await import('../bench/workerHarness.mjs');
  const N = 2000;
  const lighting = { enabled: true, shadowsEnabled: true, maxShadowCastingLights: LIGHTS, maxShadowsPerLight: 64, maxShadowsPerEntity: PER_ENTITY, maxLights: 64 };
  const caps = gpuQueueCaps(MAX, lighting);
  const m = createRenderQueueMemory(MAX, computeBufferSize(MAX), computeGpuQueueBufferSize(caps), null,
    { maxSun: caps.maxSun, maxPerEntity: PER_ENTITY, maxLights: LIGHTS });
  const buffers = { componentData: { ...coreComponentData(N), ShadowCaster: new SharedArrayBuffer(ShadowCaster.getBufferSize(N)) } };
  const worker = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  await initWorker(worker, {
    config: { worldWidth: 4000, worldHeight: 3000, lighting },
    globalEntityCount: N,
    buffers,
    extra: {
      shadows: { enabled: true, maxShadowCastingLights: LIGHTS, maxShadowsPerLight: 64, maxShadowsPerEntity: PER_ENTITY },
      renderQueueMemory: m.memory,
      renderQueueLayout: m.layout,
      renderQueue: {
        maxItems: MAX,
        sync: new SharedArrayBuffer(8),
        dataA: m.buffer,
        dataAByte: m.layout.queueAByte,
        dataB: m.buffer,
        dataBByte: m.layout.queueBByte,
        cameraA: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
        cameraB: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
        entityTextureData: new SharedArrayBuffer(N * 2),
      },
      gpuQueue: { dataA: m.buffer, dataAByte: m.layout.gpuAByte, dataB: m.buffer, dataBByte: m.layout.gpuBByte, caps },
    },
  });
  const bound = worker._stampWasm;
  assert.ok(bound, 'the worker bound the stamp kernel');
  const dst = worker.gpuQueueBuffers[0];
  assert.equal(dst.sun.buffer, m.buffer, 'the sun rows are in the memory');
  const r = rng(0xfa11);
  for (let k = 0; k < 12; k++) {
    const f = frame(r, k, caps, dst);
    worker._collectStampLights = function collectTestLights() {
      this._stampLights = f.lights.map((L) => (L ? { ...L } : L));
      this._stampLightCount = f.lights.length;
    };
    const stampBytes = new Uint8Array(dst.stamp.buffer, dst.stamp.byteOffset, dst.stamp.byteLength);
    worker._stampWasm = null;
    stampBytes.fill(0xa5);
    const js = worker._stampAgainstSun(dst, dst.sun, f.nSun, 0, 0, 1);
    const jsBytes = stampBytes.slice();
    let calls = 0;
    worker._stampWasm = { ...bound, stampRange: (...a) => { calls++; return bound.stampRange(...a); } };
    stampBytes.fill(0xa5);
    const wasm = worker._stampAgainstSun(dst, dst.sun, f.nSun, 0, 0, 1);
    if (f.nSun > 0 && f.lights.length > 0) assert.equal(calls, 1, `frame ${k}: the kernel stamped it`);
    assert.equal(wasm, js, `frame ${k}: cursor`);
    assert.equal(stampBytes.findIndex((x, i) => x !== jsBytes[i]), -1, `frame ${k}: stamp rows`);
  }
});
