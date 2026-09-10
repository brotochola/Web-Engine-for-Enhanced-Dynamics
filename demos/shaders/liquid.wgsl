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

struct CustomUniforms {
  uCutoff: f32,
  uFoam: f32,
  uDepth: f32,
  uBodyAlpha: f32,
  uEdgeAlpha: f32,
}
@group(2) @binding(0) var<uniform> customUniforms: CustomUniforms;
@group(2) @binding(1) var uTexture: texture_2d<f32>;
@group(2) @binding(2) var uSampler: sampler;

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
  out.vTextureCoord = aUV;
  return out;
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let sample = textureSample(uTexture, uSampler, in.vTextureCoord);
  let dens = sample.a;
  if (dens < customUniforms.uCutoff) {
    discard;
  }
  if (dens < customUniforms.uFoam) {
    return vec4<f32>(1.0);
  }
  let depth = smoothstep(customUniforms.uFoam, customUniforms.uFoam + max(customUniforms.uDepth, 0.001), dens);
  let edgeCol = sample.rgb * vec3<f32>(0.85, 1.05, 1.35);
  let coreCol = sample.rgb * vec3<f32>(0.35, 0.55, 1.05);
  let col = mix(edgeCol, coreCol, depth);
  let a = mix(customUniforms.uEdgeAlpha, customUniforms.uBodyAlpha, depth);
  return vec4<f32>(col, a);
}
