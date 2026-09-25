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

export async function requestWeedGpu(powerPreference = 'high-performance') {
  const navGpu = globalThis.navigator?.gpu;
  if (!navGpu || typeof navGpu.requestAdapter !== 'function') return null;
  const adapter = await navGpu.requestAdapter({ powerPreference });
  if (!adapter) return null;
  const requiredFeatures = ['timestamp-query', ...EXTRA_FEATURES].filter((name) =>
    adapter.features.has(name)
  );
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
  };
}
