/**
 * DX-UNSHADED (was DX-EMISSIVE v2, plan §6.9, F10): two colours per pixel. The entities draw their colour as always (the
 * lit colour, which the light multiplies: the lighting layer); the unshaded pass draws them again into a target the
 * canvas's size, an unshaded pixel's colour, any other black with its alpha (faceMap.js faceUnshadedFragment), so whoever
 * passes in front of a flame covers it in proportion to its alpha. This layer, right above the lighting layer, adds the
 * unshaded colour where the light is short of it:
 *   final = lit · light + unshaded · (1 - light).
 * An unshaded pixel keeps its own colour whatever the light; by day (light 1) it looks as drawn. Both targets are sampled
 * as a sprite of either would be (the lighting layer shows its target so).
 *
 * The mesh is a quad over the canvas in screen px, drawn with additive blending.
 */

import { gpuStageF, gpuStageVF, pixiGroupsGpuLayout, pixiGroupsLayout } from './webgpu/pixiMeshWgsl.js';
import { PIXI_GROUPS_WGSL } from './shaderChunks.js';

export const UNSHADED_COMPOSITE_VERT = `in vec2 aPosition;
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

export const UNSHADED_COMPOSITE_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uUnshaded;
uniform sampler2D uLight;
uniform vec4 uColor; // DBG-3: the group colour, premultiplied: its alpha is the lighting layer's (the worker sets it)
out vec4 finalColor;

// DX-UNSHADED: the unshaded colour where the light is short of it (unshadedComposite.js), added. E-509: none here adds
// nothing, so the pixel reads no light and blends nothing (the light read at level 0: the target has no other).
void main() {
  vec3 unshaded = texture(uUnshaded, vUV).rgb;
  if (unshaded.r + unshaded.g + unshaded.b <= 0.0) discard;
  vec3 light = textureLod(uLight, vUV, 0.0).rgb;
  finalColor = vec4(unshaded * (vec3(1.0) - min(light, vec3(1.0))) * uColor.a, 0.0);
}
`;

export const UNSHADED_COMPOSITE_WGSL = `${PIXI_GROUPS_WGSL}

@group(2) @binding(0) var uUnshaded: texture_2d<f32>;
@group(2) @binding(1) var uUnshadedSampler: sampler;
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

// DX-UNSHADED: the unshaded colour where the light is short of it (unshadedComposite.js), added.
@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let unshaded = textureSample(uUnshaded, uUnshadedSampler, in.vUV).rgb;
  // E-509: none here adds nothing (the GLSL's twin); the light read at level 0 after the discard.
  if (unshaded.r + unshaded.g + unshaded.b <= 0.0) {
    discard;
  }
  let light = textureSampleLevel(uLight, uLightSampler, in.vUV, 0.0).rgb;
  return vec4<f32>(unshaded * (vec3<f32>(1.0) - min(light, vec3<f32>(1.0))) * localUniforms.uColor.a, 0.0);
}
`;

/** The unshaded layer's WebGPU program: Pixi's mesh groups and the two targets with their samplers in group 2. */
export function unshadedCompositeGpuProgram(GpuProgram, name = 'weed-unshaded') {
  const vf = gpuStageVF();
  const f = gpuStageF();
  const tex = { sampleType: 'float', viewDimension: '2d', multisampled: false };
  return GpuProgram.from({
    name,
    vertex: { source: UNSHADED_COMPOSITE_WGSL, entryPoint: 'mainVert' },
    fragment: { source: UNSHADED_COMPOSITE_WGSL, entryPoint: 'mainFrag' },
    layout: pixiGroupsLayout({ uUnshaded: 0, uUnshadedSampler: 1, uLight: 2, uLightSampler: 3 }),
    gpuLayout: [
      ...pixiGroupsGpuLayout(),
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
export function unshadedQuadPositions(out, width, height) {
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
