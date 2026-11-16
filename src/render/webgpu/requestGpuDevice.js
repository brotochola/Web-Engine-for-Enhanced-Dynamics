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
  const device = await adapter.requestDevice({
    requiredFeatures,
    requiredLimits: {
      maxSampledTexturesPerShaderStage: adapter.limits.maxSampledTexturesPerShaderStage,
      maxSamplersPerShaderStage: adapter.limits.maxSamplersPerShaderStage,
    },
  });
  return {
    adapter,
    device,
    timestampQuery: device.features.has('timestamp-query'),
    timestampsInsidePasses: device.features.has(TIMESTAMPS_INSIDE_PASSES),
  };
}
