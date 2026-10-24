// Every light's self-lit fills and transmit wedges in one draw (E-96b): the light's terms are vertex
// attributes, constant over its triangles, where the per-light self-lit pass had them as uniforms.
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
  uCameraRot: vec2<f32>,
}
@group(2) @binding(0) var<uniform> uniforms: VisUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vWorldPos: vec2<f32>,
  @location(1) vCenter: vec2<f32>,
  @location(2) vRadius: f32,
  @location(3) @interpolate(flat) vLight: vec4<f32>,
  @location(4) @interpolate(flat) vColor: vec4<f32>,
}

fn weedWorldToScreen(world: vec2<f32>) -> vec2<f32> {
  let focus = uniforms.uCameraPos + uniforms.uCanvasSize / (2.0 * uniforms.uZoom);
  let d = world - focus;
  let rot = uniforms.uCameraRot;
  return uniforms.uCanvasSize * 0.5 + vec2<f32>(
    rot.x * d.x - rot.y * d.y,
    rot.x * d.y + rot.y * d.x,
  ) * uniforms.uZoom;
}

@vertex
fn mainVert(
  @location(0) aPosition: vec2<f32>,
  @location(1) aLight: vec4<f32>,
  @location(2) aColor: vec4<f32>,
  @location(3) aCenterRadius: vec3<f32>,
) -> VertexOut {
  var out: VertexOut;
  out.vWorldPos = aPosition;
  out.vCenter = aCenterRadius.xy;
  out.vRadius = aCenterRadius.z;
  out.vLight = aLight;
  out.vColor = aColor;
  let screenPos = weedWorldToScreen(aPosition);
  let clipPos = (screenPos / uniforms.uCanvasSize) * 2.0 - 1.0;
  out.position = vec4<f32>(clipPos.x, -clipPos.y, 0.0, 1.0);
  return out;
}

// A wedge vertex carries a radius past any light's distance, so its facing term is 1.
fn facingMask(world: vec2<f32>, center: vec2<f32>, bodyR: f32, lightPos: vec2<f32>) -> f32 {
  let toLight = lightPos - center;
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
  let delta = in.vWorldPos - in.vLight.xy;
  let dist = length(delta);
  let radial = 1.0 - smoothstep(in.vLight.w * 0.96, in.vLight.w, dist);
  if (radial <= 0.0) {
    discard;
  }
  let DISTANCE_SCALE = 1.0 / 1024.0;
  let deltaScaled = delta * DISTANCE_SCALE;
  let d2Scaled = dot(deltaScaled, deltaScaled);
  let intensityScaled = in.vLight.z * DISTANCE_SCALE * DISTANCE_SCALE;
  var attenuation = intensityScaled / (intensityScaled + d2Scaled);
  attenuation *= radial * in.vColor.w * facingMask(in.vWorldPos, in.vCenter, in.vRadius, in.vLight.xy);
  return vec4<f32>(in.vColor.rgb * attenuation, 1.0);
}
