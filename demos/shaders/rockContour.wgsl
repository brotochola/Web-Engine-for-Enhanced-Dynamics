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
  uRimWidth: f32,
  uRimColor: vec3<f32>,
  uRimAlpha: f32,
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
  let c = textureSample(uTexture, uSampler, in.vTextureCoord);
  if (c.a < customUniforms.uCutoff) {
    discard;
  }
  let aL = textureSample(uTexture, uSampler, in.vTextureCoord + vec2<f32>(-customUniforms.uRimWidth, 0.0)).a;
  let aR = textureSample(uTexture, uSampler, in.vTextureCoord + vec2<f32>(customUniforms.uRimWidth, 0.0)).a;
  let aT = textureSample(uTexture, uSampler, in.vTextureCoord + vec2<f32>(0.0, -customUniforms.uRimWidth)).a;
  let aB = textureSample(uTexture, uSampler, in.vTextureCoord + vec2<f32>(0.0, customUniforms.uRimWidth)).a;
  let edge = step(aL, customUniforms.uCutoff) + step(aR, customUniforms.uCutoff)
    + step(aT, customUniforms.uCutoff) + step(aB, customUniforms.uCutoff);
  let rgb = mix(c.rgb, customUniforms.uRimColor, min(edge, 1.0) * customUniforms.uRimAlpha);
  return vec4<f32>(rgb, c.a);
}
