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

struct SelfLitUniforms {
  uCameraPos: vec2<f32>,
  uZoom: f32,
  uCanvasSize: vec2<f32>,
  uLightPos: vec2<f32>,
  uLightIntensity: f32,
  uLightColor: vec3<f32>,
  uBodyCenter: vec2<f32>,
  uBodyRadius: f32,
  uAttenScale: f32,
}
@group(2) @binding(0) var<uniform> uniforms: SelfLitUniforms;
@group(2) @binding(1) var uTexture: texture_2d<f32>;
@group(2) @binding(2) var uSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vWorldPos: vec2<f32>,
  @location(1) vUV: vec2<f32>,
}

@vertex
fn mainVert(
  @location(0) aPosition: vec2<f32>,
  @location(1) aUV: vec2<f32>,
) -> VertexOut {
  var out: VertexOut;
  out.vWorldPos = aPosition;
  out.vUV = aUV;
  let screenPos = (aPosition - uniforms.uCameraPos) * uniforms.uZoom;
  let clipPos = (screenPos / uniforms.uCanvasSize) * 2.0 - 1.0;
  out.position = vec4<f32>(clipPos.x, -clipPos.y, 0.0, 1.0);
  return out;
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let a = textureSample(uTexture, uSampler, in.vUV).a;
  if (a < 0.01) {
    discard;
  }
  let delta = in.vWorldPos - uniforms.uLightPos;
  let DISTANCE_SCALE = 1.0 / 1024.0;
  let deltaScaled = delta * DISTANCE_SCALE;
  let d2Scaled = dot(deltaScaled, deltaScaled);
  let intensityScaled = uniforms.uLightIntensity * DISTANCE_SCALE * DISTANCE_SCALE;
  let attenuation = intensityScaled / (intensityScaled + d2Scaled);
  let toLight = uniforms.uLightPos - uniforms.uBodyCenter;
  let distL = length(toLight);
  var mask = 1.0;
  if (distL > uniforms.uBodyRadius && distL > 0.0001) {
    let nL = toLight / distL;
    let toPix = in.vWorldPos - uniforms.uBodyCenter;
    let pixLen = length(toPix);
    let nP = select(nL, toPix / pixLen, pixLen > 0.0001);
    mask = smoothstep(-0.15, 0.45, dot(nP, nL));
  }
  let rgb = uniforms.uLightColor * attenuation * uniforms.uAttenScale * mask * a;
  return vec4<f32>(rgb, a);
}
