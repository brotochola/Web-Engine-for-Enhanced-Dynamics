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

struct LightingUniforms {
  uCameraPos: vec2<f32>,
  uZoom: f32,
  uViewport: vec2<f32>,
  uFullCanvasSize: vec2<f32>,
  uInvResolution: f32,
  uLightTexWidth: f32,
  uLightCount: i32,
  uBaseAmbient: f32,
  uSunIntensity: f32,
  uSunR: f32,
  uSunG: f32,
  uSunB: f32,
}
@group(2) @binding(0) var uLightData: texture_2d<f32>;
@group(2) @binding(1) var<uniform> uniforms: LightingUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
}

@vertex
fn mainVert(@location(0) aPosition: vec2<f32>) -> VertexOut {
  var out: VertexOut;
  out.position = vec4<f32>(aPosition, 0.0, 1.0);
  return out;
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  // Framebuffer origin is top-left (WebGPU + Pixi Y-down). Same as GLSL
  // gl_FragCoord / uViewport — do not invert Y (that mirrors lights).
  let vp = uniforms.uViewport;
  let normCoord = in.position.xy / vp;
  let screenPos = normCoord * uniforms.uFullCanvasSize;
  let fragWorld = (screenPos / uniforms.uZoom) + uniforms.uCameraPos;
  var totalLight = vec3<f32>(uniforms.uBaseAmbient);
  totalLight += vec3<f32>(uniforms.uSunR, uniforms.uSunG, uniforms.uSunB) * uniforms.uSunIntensity;
  let nLights = uniforms.uLightCount;
  let texW = i32(uniforms.uLightTexWidth);
  for (var i = 0; i < MAX_LIGHTS; i++) {
    if (i >= nLights || i >= texW) { break; }
    let posInt = textureLoad(uLightData, vec2<i32>(i, 0), 0);
    let col = textureLoad(uLightData, vec2<i32>(i, 1), 0);
    let lightWorld = posInt.xy;
    let intensity = posInt.z;
    let DISTANCE_SCALE = 1.0 / 1024.0;
    if (intensity > 0.0) {
      let deltaScaled = (fragWorld - lightWorld) * DISTANCE_SCALE;
      let d2Scaled = dot(deltaScaled, deltaScaled);
      let intensityScaled = intensity * DISTANCE_SCALE * DISTANCE_SCALE;
      let attenuation = intensityScaled / (intensityScaled + d2Scaled);
      totalLight += col.rgb * attenuation;
    }
  }
  totalLight = min(totalLight, vec3<f32>(1.0));
  return vec4<f32>(totalLight, 1.0);
}
