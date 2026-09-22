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
  uAttenScale: f32,
}
@group(2) @binding(0) var<uniform> uniforms: VisUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vWorldPos: vec2<f32>,
  @location(1) vCenter: vec2<f32>,
  @location(2) vRadius: f32,
}

@vertex
fn mainVert(
  @location(0) aPosition: vec2<f32>,
  @location(1) aCenterRadius: vec3<f32>,
) -> VertexOut {
  var out: VertexOut;
  out.vWorldPos = aPosition;
  out.vCenter = aCenterRadius.xy;
  out.vRadius = aCenterRadius.z;
  let screenPos = (aPosition - uniforms.uCameraPos) * uniforms.uZoom;
  let clipPos = (screenPos / uniforms.uCanvasSize) * 2.0 - 1.0;
  out.position = vec4<f32>(clipPos.x, -clipPos.y, 0.0, 1.0);
  return out;
}

fn facingMask(world: vec2<f32>, center: vec2<f32>, bodyR: f32) -> f32 {
  let toLight = uniforms.uLightPos - center;
  let distL = length(toLight);
  if (distL <= bodyR || distL <= 0.0001) {
    return 1.0;
  }
  let nL = toLight / distL;
  let toPix = world - center;
  let pixLen = length(toPix);
  let nP = select(nL, toPix / pixLen, pixLen > 0.0001);
  let facing = dot(nP, nL);
  return smoothstep(-0.15, 0.45, facing);
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
  attenuation *= radial * uniforms.uAttenScale * facingMask(in.vWorldPos, in.vCenter, in.vRadius);
  return vec4<f32>(uniforms.uLightColor * attenuation, 1.0);
}
