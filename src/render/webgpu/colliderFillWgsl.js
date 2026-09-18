import { gpuStageVF } from './pixiMeshWgsl.js';

export function colliderFillGpuProgram(GpuProgram, source, name) {
  if (!source) {
    throw new Error(
      'WeedJS: Collider fill WGSL was not loaded before GpuProgram creation.'
    );
  }
  const vf = gpuStageVF();
  return GpuProgram.from({
    name,
    vertex: { source, entryPoint: 'mainVert' },
    fragment: { source, entryPoint: 'mainFrag' },
    layout: {
      0: { globalUniforms: 0 },
      1: { localUniforms: 0 },
    },
    gpuLayout: [
      [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
      [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
    ],
  });
}
