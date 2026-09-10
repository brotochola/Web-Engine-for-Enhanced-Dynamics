/**
 * Pixi v8 Mesh GPU bind groups 0/1. Required on every custom GpuProgram
 * even when the shader does not read them (mesh pipe always binds them).
 */
export const PIXI_MESH_GPU_UNIFORMS = `
struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
}
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;

struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
}
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
`;

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
 * Fullscreen NDC quad. WebGPU clip Y-up; Pixi RT UV y=0 is top.
 * Flip V so look samples match stage sprites (else density sits on the ceiling).
 */
export const FULLSCREEN_LOOK_VERTEX = `${PIXI_MESH_GPU_UNIFORMS}

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vTextureCoord: vec2<f32>,
}

@vertex
fn mainVert(
  @location(0) aPosition: vec2<f32>,
  @location(1) aUV: vec2<f32>,
) -> VertexOut {
  var out: VertexOut;
  out.position = vec4<f32>(aPosition, 0.0, 1.0);
  out.vTextureCoord = vec2<f32>(aUV.x, 1.0 - aUV.y);
  return out;
}
`;

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

export function lookGpuProgram(GpuProgram, source, name) {
  const vf = gpuStageVF();
  const f = gpuStageF();
  return GpuProgram.from({
    name,
    vertex: { source: FULLSCREEN_LOOK_VERTEX, entryPoint: 'mainVert' },
    fragment: { source, entryPoint: 'mainFrag' },
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
