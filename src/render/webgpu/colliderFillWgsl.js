import { gpuStageF, gpuStageVF } from './pixiMeshWgsl.js';

export function colliderFillGpuProgram(GpuProgram, source, name) {
  if (!source) {
    throw new Error(
      'WeedJS: Collider fill WGSL was not loaded before GpuProgram creation.'
    );
  }
  const vf = gpuStageVF();
  const f = gpuStageF();
  return GpuProgram.from({
    name,
    vertex: { source, entryPoint: 'mainVert' },
    fragment: { source, entryPoint: 'mainFrag' },
    layout: {
      0: { globalUniforms: 0 },
      1: { localUniforms: 0 },
      2: { uTexture: 0, uSampler: 1, uTexLut: 2 },
    },
    gpuLayout: [
      [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
      [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
      [
        { binding: 0, visibility: f, texture: { sampleType: 'float', viewDimension: '2d', multisampled: false } },
        { binding: 1, visibility: f, sampler: { type: 'filtering' } },
        {
          binding: 2,
          visibility: vf,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false },
        },
      ],
    ],
  });
}

export function colliderFillLitGpuProgram(GpuProgram, source, name) {
  if (!source) {
    throw new Error(
      'WeedJS: Collider fill lit WGSL was not loaded before GpuProgram creation.'
    );
  }
  const vf = gpuStageVF();
  const f = gpuStageF();
  return GpuProgram.from({
    name,
    vertex: { source, entryPoint: 'mainVert' },
    fragment: { source, entryPoint: 'mainFrag' },
    layout: {
      0: { globalUniforms: 0 },
      1: { localUniforms: 0 },
      2: {
        uTexture: 0,
        uSampler: 1,
        uTexLut: 2,
        uniforms: 3,
        uNormalMap: 4,
        uLightData: 5,
      },
    },
    gpuLayout: [
      [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
      [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
      [
        { binding: 0, visibility: f, texture: { sampleType: 'float', viewDimension: '2d', multisampled: false } },
        { binding: 1, visibility: f, sampler: { type: 'filtering' } },
        {
          binding: 2,
          visibility: vf,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false },
        },
        { binding: 3, visibility: vf, buffer: { type: 'uniform' } },
        { binding: 4, visibility: f, texture: { sampleType: 'float', viewDimension: '2d', multisampled: false } },
        {
          binding: 5,
          visibility: f,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false },
        },
      ],
    ],
  });
}
