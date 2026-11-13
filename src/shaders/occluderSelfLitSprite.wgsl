// Every light's self-lit fills of occluders masked by their sprite in one draw per texture source (E-260): the light's
// and the body's terms are vertex attributes, constant over a quad, where the pass per light had them as uniforms.
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
  uCameraRot: vec2<f32>,
  // 1 / config.lighting.groundScaleY: distances to the light are measured on the floor.
  uGroundInvScaleY: f32,
}
@group(2) @binding(0) var<uniform> uniforms: SelfLitUniforms;
@group(2) @binding(1) var uTexture: texture_2d<f32>;
@group(2) @binding(2) var uSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vWorldPos: vec2<f32>,
  @location(1) vUV: vec2<f32>,
  // The light's x, y, intensity; the body's radius.
  @location(2) @interpolate(flat) vLight: vec4<f32>,
  // The light's r, g, b; the attenuation scale.
  @location(3) @interpolate(flat) vColor: vec4<f32>,
  // The body's centre.
  @location(4) @interpolate(flat) vBody: vec2<f32>,
  // DX-SPOT: the light's cone (its direction on the floor, the cosine of its half aperture, 1 / its soft edge); z -2: none.
  @location(5) @interpolate(flat) vCone: vec4<f32>,
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
  @location(1) aUV: vec2<f32>,
  @location(2) aLight: vec4<f32>,
  @location(3) aColor: vec4<f32>,
  @location(4) aBody: vec2<f32>,
  @location(5) aCone: vec4<f32>,
) -> VertexOut {
  var out: VertexOut;
  out.vWorldPos = aPosition;
  out.vUV = aUV;
  out.vLight = aLight;
  out.vColor = aColor;
  out.vBody = aBody;
  out.vCone = aCone;
  let screenPos = weedWorldToScreen(aPosition);
  let clipPos = (screenPos / uniforms.uCanvasSize) * 2.0 - 1.0;
  out.position = vec4<f32>(clipPos.x, -clipPos.y, 0.0, 1.0);
  return out;
}

// As lightingBasic's: 1 inside the cone, 0 outside, smooth across its soft edge; 1 at the light itself.
fn coneFactor(delta: vec2<f32>, cone: vec4<f32>) -> f32 {
  let len2 = dot(delta, delta);
  let cosA = select(1.0, dot(delta, cone.xy) * inverseSqrt(len2), len2 > 0.0);
  let t = clamp((cosA - cone.z) * cone.w, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let a = textureSample(uTexture, uSampler, in.vUV).a;
  if (a < 0.01) {
    discard;
  }
  var delta = in.vWorldPos - in.vLight.xy;
  delta.y *= uniforms.uGroundInvScaleY;
  let DISTANCE_SCALE = 1.0 / 1024.0;
  let deltaScaled = delta * DISTANCE_SCALE;
  let d2Scaled = dot(deltaScaled, deltaScaled);
  let intensityScaled = in.vLight.z * DISTANCE_SCALE * DISTANCE_SCALE;
  let attenuation = intensityScaled / (intensityScaled + d2Scaled);
  let toLight = in.vLight.xy - in.vBody;
  let distL = length(toLight);
  var mask = 1.0;
  if (distL > in.vLight.w && distL > 0.0001) {
    let nL = toLight / distL;
    let toPix = in.vWorldPos - in.vBody;
    let pixLen = length(toPix);
    let nP = select(nL, toPix / pixLen, pixLen > 0.0001);
    mask = smoothstep(-0.15, 0.45, dot(nP, nL));
  }
  var rgb = in.vColor.rgb * attenuation * in.vColor.w * mask * a;
  if (in.vCone.z > -1.0) {
    rgb *= coneFactor(delta, in.vCone);
  }
  return vec4<f32>(rgb, a);
}
