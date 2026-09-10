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

struct VisUniforms {
  uCameraPos: vec2<f32>,
  uZoom: f32,
  uCanvasSize: vec2<f32>,
  uLightPos: vec2<f32>,
  uLightIntensity: f32,
  uLightRadius: f32,
  uLightColor: vec3<f32>,
}
@group(2) @binding(0) var<uniform> uniforms: VisUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vWorldPos: vec2<f32>,
}

@vertex
fn mainVert(@location(0) aPosition: vec2<f32>) -> VertexOut {
  var out: VertexOut;
  out.vWorldPos = aPosition;
  let screenPos = (aPosition - uniforms.uCameraPos) * uniforms.uZoom;
  let clipPos = (screenPos / uniforms.uCanvasSize) * 2.0 - 1.0;
  out.position = vec4<f32>(clipPos.x, -clipPos.y, 0.0, 1.0);
  return out;
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let delta = in.vWorldPos - uniforms.uLightPos;
  let dist = length(delta);
  let radial = 1.0 - smoothstep(uniforms.uLightRadius * 0.96, uniforms.uLightRadius, dist);
  if (radial <= 0.0) {
    discard;
  }
  let DISTANCE_SCALE = 1.0 / 1024.0;
  let deltaScaled = delta * DISTANCE_SCALE;
  let d2Scaled = dot(deltaScaled, deltaScaled);
  let intensityScaled = uniforms.uLightIntensity * DISTANCE_SCALE * DISTANCE_SCALE;
  var attenuation = intensityScaled / (intensityScaled + d2Scaled);
  attenuation *= radial;
  return vec4<f32>(uniforms.uLightColor * attenuation, 1.0);
}
