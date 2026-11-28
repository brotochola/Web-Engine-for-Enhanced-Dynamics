/**
 * Own the WebGPU device so Weed can request timestamp-query.
 * Pixi 8.20 accepts { gpu: { adapter, device } } on Application.init.
 */

const EXTRA_FEATURES = [
  'texture-compression-bc',
  'texture-compression-astc',
  'texture-compression-etc2',
  'indirect-first-instance',
];

/**
 * N-464: the limits the device asks, each at the adapter's own value (never more than it offers; one it does not report
 * is not asked): the samplers' two, and the buffers' size and storage binding size, which a device otherwise keeps at
 * WebGPU's defaults (256 MiB and 128 MiB) whatever the GPU holds. The buffers' two bound the indexed sprites' statics (a
 * storage buffer the entities batch checks against device.limits.maxStorageBufferBindingSize), a compute layer's storage
 * buffers and every vertex buffer. Pixi's own requestDevice asks them too after 8.23 (upstream 8ee5e44).
 */
const ADAPTER_LIMITS = ['maxSampledTexturesPerShaderStage', 'maxSamplersPerShaderStage', 'maxBufferSize', 'maxStorageBufferBindingSize'];

/** The device's requiredLimits: each of ADAPTER_LIMITS the adapter's limits report, at its value. */
function requiredLimitsOf(limits) {
  const out = {};
  for (let i = 0; i < ADAPTER_LIMITS.length; i++) {
    const name = ADAPTER_LIMITS[i];
    const value = limits[name];
    if (typeof value === 'number' && value > 0) out[name] = value;
  }
  return out;
}

/**
 * Chrome's feature for writeTimestamp inside a pass. Experimental: Chrome exposes it behind flags (157 does not with
 * --enable-webgpu-developer-features alone, which only turns the timestamps' quantization off).
 */
export const TIMESTAMPS_INSIDE_PASSES = 'chromium-experimental-timestamp-query-inside-passes';

let timestampsInsidePasses = false;

/**
 * config.debug.gpuTimestampsInsidePasses (off by default), set from each worker's config at init (abstractWorker.js)
 * before the Pixi worker asks for its device: the device then also requests TIMESTAMPS_INSIDE_PASSES when the adapter
 * has it, so a GPU profiler (tests/bench/webgpuFrameRecorder.mjs) can write a timestamp around each draw and dispatch.
 */
export function setGpuTimestampsInsidePasses(on) {
  timestampsInsidePasses = !!on;
}

export function isGpuTimestampsInsidePasses() {
  return timestampsInsidePasses;
}

export async function requestWeedGpu(powerPreference = 'high-performance') {
  const navGpu = globalThis.navigator?.gpu;
  if (!navGpu || typeof navGpu.requestAdapter !== 'function') return null;
  const adapter = await navGpu.requestAdapter({ powerPreference });
  if (!adapter) return null;
  const wanted = ['timestamp-query', ...EXTRA_FEATURES];
  if (timestampsInsidePasses) wanted.push(TIMESTAMPS_INSIDE_PASSES);
  const requiredFeatures = wanted.filter((name) => adapter.features.has(name));
  const device = await adapter.requestDevice({ requiredFeatures, requiredLimits: requiredLimitsOf(adapter.limits) });
  return {
    adapter,
    device,
    timestampQuery: device.features.has('timestamp-query'),
    timestampsInsidePasses: device.features.has(TIMESTAMPS_INSIDE_PASSES),
  };
}
