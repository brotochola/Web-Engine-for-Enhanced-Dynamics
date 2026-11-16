import test from 'node:test';
import assert from 'node:assert/strict';

import { coreComponentData, loadWorker, spatialPublishBuffers } from '../bench/workerHarness.mjs';
import {
  TIMESTAMPS_INSIDE_PASSES,
  isGpuTimestampsInsidePasses,
  requestWeedGpu,
  setGpuTimestampsInsidePasses,
} from '../../src/render/webgpu/requestGpuDevice.js';

// config.debug.gpuTimestampsInsidePasses (a GPU profiler's opt-in, off by default): a worker's init sets it, and the
// device the Pixi worker asks for then requests Chrome's inside-passes timestamps when the adapter has them.

/** A navigator.gpu whose adapter has `features`; it records what the device was asked for. */
function fakeGpu(features) {
  const asked = [];
  const adapter = {
    features: new Set(features),
    limits: { maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 16 },
    async requestDevice(desc) {
      asked.push(desc.requiredFeatures);
      return { features: new Set(desc.requiredFeatures) };
    },
  };
  return { gpu: { requestAdapter: async () => adapter }, asked };
}

async function withNavigatorGpu(gpu, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { gpu }, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
}

const N = 16;

function initPayload(debug) {
  const { buffers, gridMetadata, mem } = spatialPublishBuffers(
    { worldWidth: 1000, worldHeight: 1000, cellSize: 100, maxEntitiesPerCell: 8, maxNeighbors: 8 },
    N,
  );
  return {
    msg: 'init',
    pageOrigin: '',
    config: { seed: 123456, canvasWidth: 1280, canvasHeight: 720, worldWidth: 1000, worldHeight: 1000, debug },
    globalEntityCount: N,
    buffers: { ...buffers, componentData: coreComponentData(N) },
    gridMetadata,
    registeredClasses: [],
    componentPools: {},
    frameRateStride: 16,
    frameRateIndex: 0,
    spatialPublishMemory: mem.memory,
  };
}

test('the device asks for inside-pass timestamps only when the option is on and the adapter has them', async () => {
  const all = ['timestamp-query', TIMESTAMPS_INSIDE_PASSES, 'texture-compression-bc'];
  try {
    setGpuTimestampsInsidePasses(false);
    const off = fakeGpu(all);
    const a = await withNavigatorGpu(off.gpu, () => requestWeedGpu());
    assert.deepEqual(off.asked[0], ['timestamp-query', 'texture-compression-bc']);
    assert.equal(a.timestampsInsidePasses, false);

    setGpuTimestampsInsidePasses(true);
    const on = fakeGpu(all);
    const b = await withNavigatorGpu(on.gpu, () => requestWeedGpu());
    assert.deepEqual(on.asked[0], ['timestamp-query', 'texture-compression-bc', TIMESTAMPS_INSIDE_PASSES]);
    assert.equal(b.timestampQuery, true);
    assert.equal(b.timestampsInsidePasses, true);

    // An adapter without the feature (Chrome without --enable-webgpu-developer-features): not asked, no failure.
    const plain = fakeGpu(['timestamp-query']);
    const c = await withNavigatorGpu(plain.gpu, () => requestWeedGpu());
    assert.deepEqual(plain.asked[0], ['timestamp-query']);
    assert.equal(c.timestampsInsidePasses, false);
  } finally {
    setGpuTimestampsInsidePasses(false);
  }
});

test('a worker init sets the option from config.debug.gpuTimestampsInsidePasses, off by default', async () => {
  const w = await loadWorker('spatialWorker.js', 'spatialWorker');
  try {
    await w.handleMessage({ data: initPayload({ gpuTimestampsInsidePasses: true }) });
    assert.equal(isGpuTimestampsInsidePasses(), true);
    const on = fakeGpu(['timestamp-query', TIMESTAMPS_INSIDE_PASSES]);
    await withNavigatorGpu(on.gpu, () => requestWeedGpu());
    assert.ok(on.asked[0].includes(TIMESTAMPS_INSIDE_PASSES), 'the device did not ask for the feature');

    await w.handleMessage({ data: initPayload({}) });
    assert.equal(isGpuTimestampsInsidePasses(), false);
    const off = fakeGpu(['timestamp-query', TIMESTAMPS_INSIDE_PASSES]);
    await withNavigatorGpu(off.gpu, () => requestWeedGpu());
    assert.ok(!off.asked[0].includes(TIMESTAMPS_INSIDE_PASSES), 'the device asked for the feature with the option off');
  } finally {
    setGpuTimestampsInsidePasses(false);
  }
});
