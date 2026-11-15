import { gpuStageF, gpuStageVF } from './pixiMeshWgsl.js';

export function instancedSpriteShadowGpuProgram(GpuProgram, source, name) {
  if (!source) {
    throw new Error('WeedJS: Shadow sprite WGSL was not loaded before GpuProgram creation.');
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
      2: { uTexture: 0, uSampler: 1, uTexLut: 2, uniforms: 3 },
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
      ],
    ],
  });
}

/**
 * E-220: the keyed shadow programs (spriteIndexed.js spriteIndexedWgsl with `shadow`): the shadow program's bindings and
 * the statics as group 2's binding 4, a read-only storage buffer.
 */
export function instancedSpriteShadowIndexedGpuProgram(GpuProgram, source, name) {
  if (!source) {
    throw new Error('WeedJS: Shadow sprite WGSL was not loaded before GpuProgram creation.');
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
      2: { uTexture: 0, uSampler: 1, uTexLut: 2, uniforms: 3, uStatics: 4 },
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
        { binding: 4, visibility: vf, buffer: { type: 'read-only-storage' } },
      ],
    ],
  });
}

/** DX-MAPS: the atlas's twin page as group 2's binding 5, read by textureLoad in the fragment (the face pass). */
function mapsBinding(f) {
  return { binding: 5, visibility: f, texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false } };
}

/**
 * The sprite program. With `maps`, the face pass's form (faceMap.js faceMapWgsl): the atlas's twin page as group 2's
 * binding 5, which an explicit layout must name or the pipeline fails its validation.
 */
export function instancedSpriteGpuProgram(GpuProgram, source, fragEntry, name, { maps = false } = {}) {
  if (!source) {
    throw new Error(
      'WeedJS: Instanced sprite WGSL was not loaded before GpuProgram creation.'
    );
  }
  const vf = gpuStageVF();
  const f = gpuStageF();
  const group2 = { uTexture: 0, uSampler: 1, uTexLut: 2, uniforms: 3 };
  if (maps) group2.uMaps = 5;
  return GpuProgram.from({
    name,
    vertex: { source, entryPoint: 'mainVert' },
    fragment: { source, entryPoint: fragEntry },
    layout: {
      0: { globalUniforms: 0 },
      1: { localUniforms: 0 },
      2: group2,
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
        ...(maps ? [mapsBinding(f)] : []),
      ],
    ],
  });
}

/**
 * E-162: the indexed sprite program (spriteIndexed.js spriteIndexedWgsl), the sprite program's bindings and the
 * statics as group 2's binding 4, a read-only storage buffer; with `maps` the atlas's twin page as binding 5.
 */
export function instancedSpriteIndexedGpuProgram(GpuProgram, source, fragEntry, name, { maps = false } = {}) {
  if (!source) {
    throw new Error('WeedJS: Instanced sprite WGSL was not loaded before GpuProgram creation.');
  }
  const vf = gpuStageVF();
  const f = gpuStageF();
  const group2 = { uTexture: 0, uSampler: 1, uTexLut: 2, uniforms: 3, uStatics: 4 };
  if (maps) group2.uMaps = 5;
  return GpuProgram.from({
    name,
    vertex: { source, entryPoint: 'mainVert' },
    fragment: { source, entryPoint: fragEntry },
    layout: {
      0: { globalUniforms: 0 },
      1: { localUniforms: 0 },
      2: group2,
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
        { binding: 4, visibility: vf, buffer: { type: 'read-only-storage' } },
        ...(maps ? [mapsBinding(f)] : []),
      ],
    ],
  });
}
