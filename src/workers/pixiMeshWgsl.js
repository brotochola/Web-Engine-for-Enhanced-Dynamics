/**
 * Pixi v8 Mesh GPU bind groups 0/1. Required on every custom GpuProgram
 * even when the shader does not read them (mesh pipe always binds them).
 */

export function isWgslSource(source) {
  return typeof source === 'string' && /@(vertex|fragment|compute)\b/.test(source);
}

export function gpuProgramFromWgsl(GpuProgram, source, name, fragEntry = 'mainFrag') {
  return GpuProgram.from({
    name,
    vertex: { source, entryPoint: 'mainVert' },
    fragment: { source, entryPoint: fragEntry },
  });
}

/** Pixi 8.20 layout is VERTEX|FRAGMENT but still sampleType float. Override for rgba32float LUT. */
export function gpuStageVF() {
  const S = globalThis.GPUShaderStage;
  return S ? S.VERTEX | S.FRAGMENT : 3;
}
export function gpuStageF() {
  const S = globalThis.GPUShaderStage;
  return S ? S.FRAGMENT : 2;
}

function meshUniformGroups(vf) {
  return [
    [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
    [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
  ];
}

export function lightingGpuProgram(GpuProgram, source, name) {
  const vf = gpuStageVF();
  const f = gpuStageF();
  return GpuProgram.from({
    name,
    vertex: { source, entryPoint: 'mainVert' },
    fragment: { source, entryPoint: 'mainFrag' },
    layout: {
      0: { globalUniforms: 0 },
      1: { localUniforms: 0 },
      2: { uLightData: 0, uniforms: 1 },
    },
    gpuLayout: [
      ...meshUniformGroups(vf),
      [
        {
          binding: 0,
          visibility: f,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false },
        },
        { binding: 1, visibility: vf, buffer: { type: 'uniform' } },
      ],
    ],
  });
}

export function lookGpuProgram(GpuProgram, fragmentSource, name, vertexSource) {
  if (!vertexSource) {
    throw new Error(
      'WeedJS: Fullscreen look vertex WGSL was not loaded before look program creation.'
    );
  }
  const vf = gpuStageVF();
  const f = gpuStageF();
  return GpuProgram.from({
    name,
    vertex: { source: vertexSource, entryPoint: 'mainVert' },
    fragment: { source: fragmentSource, entryPoint: 'mainFrag' },
    layout: {
      0: { globalUniforms: 0 },
      1: { localUniforms: 0 },
      2: { customUniforms: 0, uTexture: 1, uSampler: 2 },
    },
    gpuLayout: [
      ...meshUniformGroups(vf),
      [
        { binding: 0, visibility: vf, buffer: { type: 'uniform' } },
        { binding: 1, visibility: f, texture: { sampleType: 'float', viewDimension: '2d', multisampled: false } },
        { binding: 2, visibility: f, sampler: { type: 'filtering' } },
      ],
    ],
  });
}
