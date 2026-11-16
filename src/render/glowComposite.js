/**
 * DX-EMISSIVE v2 (plan §6.9, F10): two colours per pixel. The entities draw their colour as always (the lit colour, which
 * the light multiplies: the lighting layer); the glow pass draws them again into a target the canvas's size, a glowing
 * pixel's colour times its glow, any other black with its alpha (faceMap.js faceGlowFragment), so whoever passes in front
 * of a flame covers its glow in proportion to its alpha. This layer, right above the lighting layer, adds the glow where the
 * light is short of it:
 *   final = lit · light + glow · (1 - light).
 * A glowing pixel (glow 1) keeps its own colour whatever the light; by day (light 1) it looks as drawn; a glow over 1 shows
 * at night. Both targets are sampled as a sprite of either would be (the lighting layer shows its target so).
 *
 * The mesh is a quad over the canvas in screen px, drawn with additive blending.
 */

import { gpuStageF, gpuStageVF } from './webgpu/pixiMeshWgsl.js';

export const GLOW_COMPOSITE_VERT = `in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vUV;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}
`;

export const GLOW_COMPOSITE_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uGlow;
uniform sampler2D uLight;
out vec4 finalColor;

// DX-EMISSIVE v2: the glow where the light is short of it (glowComposite.js), added.
void main() {
  vec3 glow = texture(uGlow, vUV).rgb;
  vec3 light = texture(uLight, vUV).rgb;
  finalColor = vec4(glow * (vec3(1.0) - min(light, vec3(1.0))), 0.0);
}
`;

export const GLOW_COMPOSITE_WGSL = `struct GlobalUniforms {
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

@group(2) @binding(0) var uGlow: texture_2d<f32>;
@group(2) @binding(1) var uGlowSampler: sampler;
@group(2) @binding(2) var uLight: texture_2d<f32>;
@group(2) @binding(3) var uLightSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUV: vec2<f32>,
}

@vertex
fn mainVert(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> VertexOut {
  var out: VertexOut;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  out.position = vec4<f32>((mvp * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0);
  out.vUV = aUV;
  return out;
}

// DX-EMISSIVE v2: the glow where the light is short of it (glowComposite.js), added.
@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let glow = textureSample(uGlow, uGlowSampler, in.vUV).rgb;
  let light = textureSample(uLight, uLightSampler, in.vUV).rgb;
  return vec4<f32>(glow * (vec3<f32>(1.0) - min(light, vec3<f32>(1.0))), 0.0);
}
`;

/** The glow layer's WebGPU program: Pixi's mesh groups and the two targets with their samplers in group 2. */
export function glowCompositeGpuProgram(GpuProgram, name = 'weed-glow') {
  const vf = gpuStageVF();
  const f = gpuStageF();
  const tex = { sampleType: 'float', viewDimension: '2d', multisampled: false };
  return GpuProgram.from({
    name,
    vertex: { source: GLOW_COMPOSITE_WGSL, entryPoint: 'mainVert' },
    fragment: { source: GLOW_COMPOSITE_WGSL, entryPoint: 'mainFrag' },
    layout: {
      0: { globalUniforms: 0 },
      1: { localUniforms: 0 },
      2: { uGlow: 0, uGlowSampler: 1, uLight: 2, uLightSampler: 3 },
    },
    gpuLayout: [
      [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
      [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
      [
        { binding: 0, visibility: f, texture: { ...tex } },
        { binding: 1, visibility: f, sampler: { type: 'filtering' } },
        { binding: 2, visibility: f, texture: { ...tex } },
        { binding: 3, visibility: f, sampler: { type: 'filtering' } },
      ],
    ],
  });
}

/** The quad's positions over a canvas of `width` × `height` screen px, into `out` (8 floats). */
export function glowQuadPositions(out, width, height) {
  out[0] = 0;
  out[1] = 0;
  out[2] = width;
  out[3] = 0;
  out[4] = width;
  out[5] = height;
  out[6] = 0;
  out[7] = height;
  return out;
}
