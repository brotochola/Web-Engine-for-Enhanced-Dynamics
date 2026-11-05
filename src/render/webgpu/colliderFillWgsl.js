import { gpuStageF, gpuStageVF } from './pixiMeshWgsl.js';

/** @param {boolean} [sunShadow] the UV batch's shader, which has one more uniform group entry (DX-SUNMESH) */
export function colliderFillGpuProgram(GpuProgram, source, name, sunShadow = false) {
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
      2: { uTexture: 0, uSampler: 1, uTexLut: 2, uPoseTable: 3, ...(sunShadow ? { sunShadow: 4 } : {}) },
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
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false } },
        {
          binding: 3,
          visibility: vf,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false } },
        ...(sunShadow ? [{ binding: 4, visibility: vf, buffer: { type: 'uniform' } }] : []),
      ],
    ],
  });
}
