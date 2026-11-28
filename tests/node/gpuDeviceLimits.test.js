import test from 'node:test';
import assert from 'node:assert/strict';

import { requestWeedGpu } from '../../src/render/webgpu/requestGpuDevice.js';

// N-464: the engine's WebGPU device (requestWeedGpu, which the Pixi worker hands Pixi) asks the adapter's own buffer limits
// as well as its sampler ones: without them a device keeps WebGPU's defaults (256 MiB a buffer, 128 MiB a storage binding),
// whatever the GPU holds. Never more than the adapter offers: each limit asked is the adapter's value, and one the adapter
// does not report is not asked.

const MIB = 1024 * 1024;

/** A GPUSupportedLimits stand-in: its limits are getters on the prototype, as a browser's are (no own keys to list). */
function supportedLimits(values) {
  const proto = {};
  for (const name of Object.keys(values)) Object.defineProperty(proto, name, { get: () => values[name], enumerable: false });
  return Object.create(proto);
}

/** A navigator.gpu whose adapter has `limits`; it records each device request and gives a device with what was asked. */
function fakeGpu(limits) {
  const asked = [];
  const adapter = {
    features: new Set(['timestamp-query']),
    limits: supportedLimits(limits),
    async requestDevice(desc) {
      asked.push(desc);
      for (const [name, value] of Object.entries(desc.requiredLimits || {})) {
        assert.equal(typeof value, 'number', `${name}: a number`);
        assert.ok(value <= limits[name], `${name}: ${value} asked, the adapter offers ${limits[name]}`);
      }
      return { features: new Set(desc.requiredFeatures), limits: { ...desc.requiredLimits } };
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

test('the device asks the adapter\'s buffer size and storage binding size, as the adapter offers them', async () => {
  // A desktop GPU's adapter in Chrome: far over the defaults.
  const limits = {
    maxSampledTexturesPerShaderStage: 48,
    maxSamplersPerShaderStage: 48,
    maxBufferSize: 4096 * MIB,
    maxStorageBufferBindingSize: 2048 * MIB - 4,
    maxComputeWorkgroupSizeX: 1024,
  };
  const { gpu, asked } = fakeGpu(limits);
  const weed = await withNavigatorGpu(gpu, () => requestWeedGpu());
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].requiredLimits, {
    maxSampledTexturesPerShaderStage: 48,
    maxSamplersPerShaderStage: 48,
    maxBufferSize: 4096 * MIB,
    maxStorageBufferBindingSize: 2048 * MIB - 4,
  }, 'the four, each the adapter\'s, and no other');
  // What the Pixi worker reads for the indexed sprites' statics (pixiWorker: the entities batch's maxStorageBytes).
  assert.equal(weed.device.limits.maxStorageBufferBindingSize, 2048 * MIB - 4);
});

test('an adapter at the defaults is asked the defaults; a limit it does not report is not asked', async () => {
  const defaults = { maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 16, maxBufferSize: 256 * MIB, maxStorageBufferBindingSize: 128 * MIB };
  const a = fakeGpu(defaults);
  await withNavigatorGpu(a.gpu, () => requestWeedGpu());
  assert.deepEqual(a.asked[0].requiredLimits, defaults);

  const b = fakeGpu({ maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 16 });
  await withNavigatorGpu(b.gpu, () => requestWeedGpu());
  assert.deepEqual(b.asked[0].requiredLimits, { maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 16 },
    'no undefined limit in the request');
});
