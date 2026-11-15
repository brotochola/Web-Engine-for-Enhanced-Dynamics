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

/**
 * The light pass (lightingBasic.wgsl). `faces`: the face map at binding 4 (DX-FACES, DX-MAPS); `sunMap`: the sun's shadow
 * map at binding 5 (DX-SHADOW3D), both read with textureLoad.
 */
export function lightingGpuProgram(GpuProgram, source, name, faces = false, sunMap = false, lampMap = false, ids = false) {
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
        uLightData: 0,
        uniforms: 1,
        uShadowMap: 2,
        uShadowSampler: 3,
        ...(faces ? { uFaceMap: 4 } : {}),
        ...(sunMap ? { uSunMap: 5 } : {}),
        // DX-SHADOW3D (F7): the lamps' shadow map.
        ...(lampMap ? { uLampMap: 6 } : {}),
        // DX-GBUF: the G-buffer's entity ids map (faceMap.js FACE_IDS_SELF), with the faces.
        ...(faces && ids ? { uFaceIds: 7 } : {}),
      },
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
        { binding: 2, visibility: f, texture: { sampleType: 'float', viewDimension: '2d', multisampled: false } },
        { binding: 3, visibility: f, sampler: { type: 'filtering' } },
        ...(faces
          ? [{ binding: 4, visibility: f, texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false } }]
          : []),
        ...(sunMap
          ? [{ binding: 5, visibility: f, texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false } }]
          : []),
        ...(lampMap
          ? [{ binding: 6, visibility: f, texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false } }]
          : []),
        ...(faces && ids
          ? [{ binding: 7, visibility: f, texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false } }]
          : []),
      ],
    ],
  });
}

/**
 * @param {boolean} [scene] DX-POST: a SCREEN pass that reads uScene too, at binding 3 of group 2 (wgslPrelude)
 */
export function lookGpuProgram(GpuProgram, fragmentSource, name, vertexSource, scene = false) {
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
      2: scene ? { customUniforms: 0, uTexture: 1, uSampler: 2, uScene: 3 } : { customUniforms: 0, uTexture: 1, uSampler: 2 },
    },
    gpuLayout: [
      ...meshUniformGroups(vf),
      [
        { binding: 0, visibility: vf, buffer: { type: 'uniform' } },
        { binding: 1, visibility: f, texture: { sampleType: 'float', viewDimension: '2d', multisampled: false } },
        { binding: 2, visibility: f, sampler: { type: 'filtering' } },
        ...(scene ? [{ binding: 3, visibility: f, texture: { sampleType: 'float', viewDimension: '2d', multisampled: false } }] : []),
      ],
    ],
  });
}
