// E-114 (W23): the shadow stamp kernel (shadowStamp.wasm, through shadowStampClient.js) against the shipped
// stampLightRange, in the scene's memory layout: the sun rows and the stamp output on the GPU queue's region
// of the render-queue memory, the scratch in the stamp regions. Random frames, built to reach every branch:
// clustered and wide-spread casters (past the grid's 128 × 128 cells the full scan runs), NaN, infinite and
// far casters (Math.floor(..) | 0 past 2^31), empty light slots, lights with no range, no intensity or a
// NaN range, per-light budgets, maxShadowsPerLight and maxShadowsPerEntity on and off, a stride and a begin,
// and stamps that fill up. Each frame: the same cursor, every stamp row and every light index bit for bit.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeGpuQueueBufferSize, gpuQueueCaps } from '../../src/render/gpuQueueLayout.js';
import { computeBufferSize } from '../../src/render/renderQueueLayout.js';
import { stampLightRange } from '../reference/shadowStamp.mjs';
import { createRenderQueueMemory } from '../../src/util/renderQueueMemory.js';
import { stampLightRangeWasm } from '../../src/render/shadowStampClient.js';
import { LIGHTS, MAX, PER_ENTITY, frame, rng, setup, specFor } from '../helpers/shadowStampFrames.mjs';

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

test('a call the regions cannot hold is an error', async () => {
  const { caps, dst, b, scratch } = await setup();
  const r = rng(7);
  const f = frame(r, 1, caps, dst);
  const spec = specFor(f, dst, scratch);
  assert.throws(() => stampLightRangeWasm(b, { ...spec, maxPerEntity: PER_ENTITY + 1 }), /shadows per entity/, 'more slots per entity');
  assert.throws(() => stampLightRangeWasm(b, { ...spec, lights: new Array(LIGHTS + 1).fill(null), lightEnd: LIGHTS + 1 }), /lights, the regions hold/, 'more lights');
  assert.throws(() => stampLightRangeWasm(b, { ...spec, stamp: new Float32Array(dst.stamp.length) }), /outside the render-queue memory/, 'stamp rows outside the memory');
  assert.throws(() => stampLightRangeWasm(b, { ...spec, sunN: caps.maxSun + 1 }), /sun casters, the regions hold/, 'more casters than the scratch holds');
  assert.equal(stampLightRangeWasm(b, { ...spec, sunN: 0 }), spec.stampBase | 0, 'no casters: the early return');
});

test('pre-render binds the stamp kernel and its stamp is the one the JS made', async () => {
  const { RENDER_QUEUE_CAMERA_BYTES } = await import('../../src/render/renderQueueLayout.js');
  const { ShadowCaster } = await import('../../src/components/shadowCaster.js');
  const { coreComponentData, emitSpec, emitSpriteBuffers, initWorker, loadWorker } = await import('../bench/workerHarness.mjs');
  const N = 2000;
  const lighting = { enabled: true, shadowsEnabled: true, maxShadowCastingLights: LIGHTS, maxShadowsPerLight: 64, maxShadowsPerEntity: PER_ENTITY, maxLights: 64 };
  const caps = gpuQueueCaps(MAX, lighting);
  const m = createRenderQueueMemory(MAX, computeBufferSize(MAX), computeGpuQueueBufferSize(caps), emitSpec(N),
    { maxSun: caps.maxSun, maxPerEntity: PER_ENTITY, maxLights: LIGHTS });
  const buffers = {
    componentData: { ...coreComponentData(N), ...emitSpriteBuffers(m).componentData, ShadowCaster: new SharedArrayBuffer(ShadowCaster.getBufferSize(N)) },
    componentDataByte: emitSpriteBuffers(m).componentDataByte,
  };
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
    // The JS stamp the engine shipped, on the spec pre-render builds, in place of its kernel call.
    worker._stampRange = (spec, sunN, stampBase) => ((sunN | 0) > 0 ? stampLightRange(spec) : stampBase);
    stampBytes.fill(0xa5);
    const js = worker._stampAgainstSun(dst, dst.sun, f.nSun, 0, 0, 1);
    const jsBytes = stampBytes.slice();
    delete worker._stampRange;
    let calls = 0;
    worker._stampWasm = { ...bound, stampRange: (...a) => { calls++; return bound.stampRange(...a); } };
    stampBytes.fill(0xa5);
    const wasm = worker._stampAgainstSun(dst, dst.sun, f.nSun, 0, 0, 1);
    if (f.nSun > 0 && f.lights.length > 0) assert.equal(calls, 1, `frame ${k}: the kernel stamped it`);
    assert.equal(wasm, js, `frame ${k}: cursor`);
    assert.equal(stampBytes.findIndex((x, i) => x !== jsBytes[i]), -1, `frame ${k}: stamp rows`);
  }
});
