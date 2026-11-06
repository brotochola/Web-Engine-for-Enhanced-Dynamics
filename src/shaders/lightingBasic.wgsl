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
  uCameraRot: vec2<f32>,
  uInvResolution: f32,
  uLightTexWidth: f32,
  uLightCount: i32,
  uBaseAmbient: f32,
  uSunIntensity: f32,
  uSunR: f32,
  uSunG: f32,
  uSunB: f32,
  uFlipY: f32,
  uShadowComposite: f32,
  // 1 / config.lighting.groundScaleY: the lights' y arrive in floor units, the fragment's is scaled here once.
  uGroundInvScaleY: f32,
  // The night light, color already multiplied by its strength and Sun.nightFactor.
  uNightR: f32,
  uNightG: f32,
  uNightB: f32,
// #if FACES
  uFaceLight: vec4<f32>, // heightScaleY, wrap, gain, sunDirect
  uFaceSun: vec4<f32>, // towards the sun in the floor's space; w: 1 / its height, so a flat surface reads as the floor
// #endif FACES
}
@group(2) @binding(0) var uLightData: texture_2d<f32>;
@group(2) @binding(1) var<uniform> uniforms: LightingUniforms;
@group(2) @binding(2) var uShadowMap: texture_2d<f32>;
@group(2) @binding(3) var uShadowSampler: sampler;
// #if FACES
// DX-FACES: this pixel's face, in the face map, drawn at this pass's size.
@group(2) @binding(4) var uFaceMap: texture_2d<f32>;
// #endif FACES

struct VertexOut {
  @builtin(position) position: vec4<f32>,
}

@vertex
fn mainVert(@location(0) aPosition: vec2<f32>) -> VertexOut {
  var out: VertexOut;
  out.position = vec4<f32>(aPosition, 0.0, 1.0);
  return out;
}

fn weedScreenToWorld(screenPos: vec2<f32>) -> vec2<f32> {
  let focus = uniforms.uCameraPos + uniforms.uFullCanvasSize / (2.0 * uniforms.uZoom);
  let sxy = screenPos - uniforms.uFullCanvasSize * 0.5;
  let rot = uniforms.uCameraRot;
  return focus + vec2<f32>(
    rot.x * sxy.x + rot.y * sxy.y,
    -rot.y * sxy.x + rot.x * sxy.y,
  ) / uniforms.uZoom;
}

// #if FACES
fn faceLight(world: vec2<f32>, face: vec4<f32>) -> vec3<f32> {
  let f = (face.rg * 255.0 - 127.0) / 126.0;
  var n = vec3<f32>(f, 1.0 - abs(f.x) - abs(f.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  n = normalize(n);
  let z = (floor(face.b * 255.0 + 0.5) * 256.0 + floor(face.a * 255.0 + 0.5)) / 8.0;
  let lit = uniforms.uFaceLight;
  let p = vec3<f32>(world.x, (world.y + z * lit.x) * uniforms.uGroundInvScaleY, z);
  let sunDirect = min(max(dot(n, uniforms.uFaceSun.xyz), 0.0) * uniforms.uFaceSun.w, 1.6);
  var total = vec3<f32>(uniforms.uBaseAmbient) + vec3<f32>(uniforms.uNightR, uniforms.uNightG, uniforms.uNightB);
  total += vec3<f32>(uniforms.uSunR, uniforms.uSunG, uniforms.uSunB) * uniforms.uSunIntensity * (1.0 - lit.w + lit.w * sunDirect);
  let nLights = uniforms.uLightCount;
  let texW = i32(uniforms.uLightTexWidth);
  let DISTANCE_SCALE = 1.0 / 1024.0;
  for (var i = 0; i < MAX_LIGHTS; i++) {
    if (i >= nLights || i >= texW) { break; }
    let posInt = textureLoad(uLightData, vec2<i32>(i, 0), 0);
    if (posInt.z <= 0.0) { continue; }
    let col = textureLoad(uLightData, vec2<i32>(i, 1), 0);
    let toLight = vec3<f32>(posInt.xy, col.a) - p;
    let d = length(toLight);
    let cosine = (dot(n, toLight) / max(d, 0.001) + lit.y) / (1.0 + lit.y);
    if (cosine <= 0.0) { continue; }
    // The source's height is folded into I' and the colour (I' = I + h²): I / (I + d²) = k I' / (I' - h² + d²).
    let scaled = DISTANCE_SCALE * DISTANCE_SCALE;
    let intensityScaled = posInt.z * scaled;
    total += col.rgb * cosine * lit.z * intensityScaled / (intensityScaled + (d * d - col.a * col.a) * scaled);
  }
  return total;
}
// #endif FACES

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  // Framebuffer origin is top-left (WebGPU + Pixi Y-down). Same as GLSL
  // gl_FragCoord / uViewport — do not invert Y (that mirrors lights).
  let vp = uniforms.uViewport;
  var y = in.position.y;
  if (uniforms.uFlipY > 0.5) { y = vp.y - y; }
  let normCoord = vec2<f32>(in.position.x, y) / vp;
  let screenPos = normCoord * uniforms.uFullCanvasSize;
  var fragWorld = weedScreenToWorld(screenPos);
// #if FACES
  let face = textureLoad(uFaceMap, vec2<i32>(in.position.xy), 0);
  if (face.r > 0.0) {
    return vec4<f32>(min(faceLight(fragWorld, face), vec3<f32>(1.0)), 1.0);
  }
// #endif FACES
  fragWorld.y *= uniforms.uGroundInvScaleY;
  var totalLight = vec3<f32>(uniforms.uBaseAmbient);
  totalLight += vec3<f32>(uniforms.uSunR, uniforms.uSunG, uniforms.uSunB) * uniforms.uSunIntensity;
  totalLight += vec3<f32>(uniforms.uNightR, uniforms.uNightG, uniforms.uNightB);
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
  if (uniforms.uShadowComposite > 0.5) {
    // Level, not textureSample: with faces this line is past a branch on a pixel's value (WGSL's uniform control flow).
    let sh = textureSampleLevel(uShadowMap, uShadowSampler, normCoord, 0.0);
    totalLight *= (1.0 - sh.a);
  }
  totalLight = min(totalLight, vec3<f32>(1.0));
  return vec4<f32>(totalLight, 1.0);
}
