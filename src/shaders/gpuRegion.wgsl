// A GPU particle look layer's region among the entities (gpuParticleChunks.js): gpuRegion.vert.glsl's twin.
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

@group(2) @binding(0) var uTexture: texture_2d<f32>;
@group(2) @binding(1) var uSampler: sampler;

// World px to the target's UV (screen px / canvas), the camera's this frame (RegionQuads.setView).
struct RegionUniforms {
  uUvX: vec4<f32>,
  uUvY: vec4<f32>,
}
@group(2) @binding(2) var<uniform> uniforms: RegionUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUV: vec2<f32>,
}

@vertex
fn mainVert(@location(0) aPosition: vec2<f32>) -> VertexOut {
  var out: VertexOut;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let world = vec3<f32>(aPosition, 1.0);
  let clip = mvp * world;
  out.position = vec4<f32>(clip.xy, 0.0, 1.0);
  out.vUV = vec2<f32>(dot(uniforms.uUvX.xyz, world), dot(uniforms.uUvY.xyz, world));
  return out;
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  return textureSample(uTexture, uSampler, in.vUV) * localUniforms.uColor.a;
}
