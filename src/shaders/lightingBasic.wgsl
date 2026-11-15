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
  // DX-SPOT: the first uConeCount lights are cones, with a third row (direction on the floor, cos of the half aperture,
  // 1 / the soft edge's width); they loop apart, so a point light runs the loop it always ran. A float (see pixiWorker).
  uConeCount: f32,
// #if FACES
  uFaceLight: vec4<f32>, // heightScaleY, wrap, gain, sunDirect
  uFaceSun: vec4<f32>, // towards the sun in the floor's space; w: 1 / its height, so a flat surface reads as the floor
// #endif FACES
// #if SUNMAP
  uSunMapK: vec4<f32>, // kx, ky (a px of height's landing shift on the floor), groundScaleY, the shadow's opacity
// #endif SUNMAP
// #if SELFSHADOW
  uSelfShadow: vec4<f32>, // a step's length (floor px), steps, bias (px)
// #endif SELFSHADOW
// #if LAMPMAP
  uLampAtlas: vec4<f32>, // tiles a row, a tile's texels, the atlas's width and height in texels
// #endif LAMPMAP
}
@group(2) @binding(0) var uLightData: texture_2d<f32>;
@group(2) @binding(1) var<uniform> uniforms: LightingUniforms;
@group(2) @binding(2) var uShadowMap: texture_2d<f32>;
@group(2) @binding(3) var uShadowSampler: sampler;
// #if FACES
// DX-FACES: this pixel's face, in the face map, drawn at this pass's size.
@group(2) @binding(4) var uFaceMap: texture_2d<f32>;
// #endif FACES
// #if SUNMAP
// DX-SHADOW3D: the sun's shadow map (sunShadowMap.js), laid out on the screen as the sprite shadows' layer is.
@group(2) @binding(5) var uSunMap: texture_2d<f32>;
// #endif SUNMAP
// #if LAMPMAP
// DX-SHADOW3D (F7): the lamps' shadow map (lampShadowMap.js), a tile a lamp.
@group(2) @binding(6) var uLampMap: texture_2d<f32>;
// #endif LAMPMAP
// #if IDS
// DX-GBUF (plan §6.4): the G-buffer's entity ids (faceMap.js FACE_IDS_SELF), drawn with the face map.
@group(2) @binding(7) var uFaceIds: texture_2d<f32>;
// #endif IDS

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

// DX-SPOT: how far inside its cone a point at floor offset delta from the light is: 1 inside, 0 outside, smooth across
// the soft edge. At the light itself, 1.
fn coneFactor(delta: vec2<f32>, cone: vec4<f32>) -> f32 {
  let len2 = dot(delta, delta);
  let cosA = select(1.0, dot(delta, cone.xy) * inverseSqrt(len2), len2 > 0.0);
  let t = clamp((cosA - cone.z) * cone.w, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// A world point's place on the canvas, 0..1 (weedScreenToWorld's inverse).
fn weedWorldToNorm(world: vec2<f32>) -> vec2<f32> {
  let focus = uniforms.uCameraPos + uniforms.uFullCanvasSize / (2.0 * uniforms.uZoom);
  let d = (world - focus) * uniforms.uZoom;
  let rot = uniforms.uCameraRot;
  let sxy = vec2<f32>(rot.x * d.x - rot.y * d.y, rot.y * d.x + rot.x * d.y);
  return (sxy + uniforms.uFullCanvasSize * 0.5) / uniforms.uFullCanvasSize;
}

// DX-GBUF: whether a shadow map's texel keeps the pixel's own entity (selfId, 0 none) as its highest caster
// (lightingBasic.frag.glsl ownTexel): a caster's own shadow never paints its own sprite.
fn ownTexel(m: vec4<f32>, selfId: f32) -> bool {
  return selfId > 0.5 && abs(floor(m.b * 255.0 + 0.5) * 256.0 + floor(m.a * 255.0 + 0.5) - selfId) < 0.5;
}

// #if SUNMAP
// How much of the sun reaches floor point p (x, y on the floor, z up): 1 lit, 1 - opacity in the shade, five taps
// (lightingBasic.frag.glsl's sunVisibility, the map read texel by texel); the pixel's own entity's shade skipped.
fn sunMapLit(c: vec2<i32>, size: vec2<i32>, above: f32, selfId: f32) -> f32 {
  let q = clamp(c, vec2<i32>(0), size - vec2<i32>(1));
  let m = textureLoad(uSunMap, q, 0);
  // Under a higher caster not its own: what the caster's opacity (G, DX-CASTER) leaves.
  return select(1.0, 1.0 - m.g, m.r * 512.0 > above && !ownTexel(m, selfId));
}

fn sunVisibility(p: vec3<f32>, selfId: f32) -> f32 {
  let k = uniforms.uSunMapK;
  let land = p.xy - p.z * k.xy;
  let uv = weedWorldToNorm(vec2<f32>(land.x, land.y * k.z));
  let size = vec2<i32>(textureDimensions(uSunMap, 0));
  let c = vec2<i32>(floor(uv * vec2<f32>(size)));
  let above = p.z + 4.0 + p.z * 0.03;
  var lit = sunMapLit(c, size, above, selfId);
  lit += sunMapLit(c + vec2<i32>(1, 0), size, above, selfId);
  lit += sunMapLit(c - vec2<i32>(1, 0), size, above, selfId);
  lit += sunMapLit(c + vec2<i32>(0, 1), size, above, selfId);
  lit += sunMapLit(c - vec2<i32>(0, 1), size, above, selfId);
  return 1.0 - k.w * (1.0 - lit * 0.2);
}
// #endif SUNMAP

// #if LAMPMAP
// DX-SHADOW3D (F7): the lamps' shadow map (lightingBasic.frag.glsl's lampVisibility, the atlas read texel by texel).
// DX-GBUF: with the ids map a tag is -(tile + 1 + 256 · the lamp's entity id) (lampTile, lampOwner).
fn lampTile(tag: f32) -> i32 {
// #if IDS
  return i32((-tag - 1.0) % 256.0 + 0.5);
// #endif IDS
// #if !IDS
  return i32(-tag - 1.0 + 0.5);
// #endif !IDS
}

fn lampOwner(tag: f32) -> f32 {
// #if IDS
  return select(0.0, floor((-tag - 1.0) / 256.0), tag < 0.0);
// #endif IDS
// #if !IDS
  return 0.0;
// #endif !IDS
}

fn lampTap(c: vec2<i32>, lo: vec2<i32>, hi: vec2<i32>, above: f32, selfId: f32) -> f32 {
  let m = textureLoad(uLampMap, clamp(c, lo, hi), 0);
  return select(1.0, 1.0 - m.g, m.r * 512.0 > above && !ownTexel(m, selfId));
}

fn lampVisibility(p: vec3<f32>, l: vec2<f32>, e: f32, tag: f32, intensity: f32, selfId: f32) -> f32 {
  if (tag >= 0.0 || e <= 0.0 || p.z >= e) { return 1.0; }
  let reach = 10.0 * sqrt(max(intensity - e * e, 0.0));
  if (reach <= 0.0) { return 1.0; }
  let room = e - p.z;
  let k = select(8.0, e / room, room > e * 0.125);
  let uv = (p.xy - l) * k / (2.0 * reach) + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x >= 1.0 || uv.y >= 1.0) { return 1.0; }
  let tile = lampTile(tag);
  let a = uniforms.uLampAtlas;
  let perRow = i32(a.x);
  let size = i32(a.y);
  let lo = vec2<i32>(tile % perRow, tile / perRow) * size;
  let hi = lo + vec2<i32>(size - 1);
  let c = lo + vec2<i32>(floor(uv * a.y));
  let above = p.z + 4.0 + p.z * 0.03;
  var lit = lampTap(c, lo, hi, above, selfId);
  lit += lampTap(c + vec2<i32>(1, 0), lo, hi, above, selfId);
  lit += lampTap(c - vec2<i32>(1, 0), lo, hi, above, selfId);
  lit += lampTap(c + vec2<i32>(0, 1), lo, hi, above, selfId);
  lit += lampTap(c - vec2<i32>(0, 1), lo, hi, above, selfId);
  return lit * 0.2;
}
// #endif LAMPMAP

// #if FACES
// #if SELFSHADOW
// DX-SELFSHADOW: steps towards the sun over the face map's heights (lightingBasic.frag.glsl's selfShadow): a surface
// that rises above the ray shades this pixel from the sun.
// A face map texel's height (px): 15 bits in eighths of a px, the top bit a sprite's own normal (faceMap.js FACE_K_BIT).
fn faceHeight(face: vec4<f32>) -> f32 {
  return ((floor(face.b * 255.0 + 0.5) * 256.0 + floor(face.a * 255.0 + 0.5)) % 32768.0) / 8.0;
}

// Towards unit direction l, no further than reach (a lamp's distance; the sun's is unbounded). DX-GBUF: with the ids
// map, only the heights of the pixel's own entity (selfId) count; a pixel of no entity counts every height.
fn selfShadowToward(p: vec3<f32>, l: vec3<f32>, reach: f32, selfId: f32) -> f32 {
  let s = 1.0 / uniforms.uGroundInvScaleY;
  let size = vec2<f32>(textureDimensions(uFaceMap, 0));
  for (var i = 2; i <= 9; i++) {
    if (f32(i) > uniforms.uSelfShadow.y + 1.0) { break; }
    let t = f32(i) * uniforms.uSelfShadow.x;
    if (t >= reach) { break; }
    let q = p + l * t;
    let nc = weedWorldToNorm(vec2<f32>(q.x, q.y * s - q.z * uniforms.uFaceLight.x));
    let fc = vec2<f32>(nc.x, select(nc.y, 1.0 - nc.y, uniforms.uFlipY > 0.5));
    if (any(fc < vec2<f32>(0.0)) || any(fc >= vec2<f32>(1.0))) { continue; }
    let f = textureLoad(uFaceMap, vec2<i32>(fc * size), 0);
// #if IDS
    if (selfId > 0.5) {
      let g = textureLoad(uFaceIds, vec2<i32>(fc * size), 0);
      if (abs(floor(g.r * 255.0 + 0.5) * 256.0 + floor(g.g * 255.0 + 0.5) - selfId) > 0.5) { continue; }
    }
// #endif IDS
    if (f.r > 0.0 && faceHeight(f) > q.z + uniforms.uSelfShadow.z + t * 0.25) { return 0.0; }
  }
  return 1.0;
}

fn selfShadow(p: vec3<f32>, selfId: f32) -> f32 {
  return selfShadowToward(p, normalize(uniforms.uFaceSun.xyz), 1e9, selfId);
}
// #endif SELFSHADOW

// DX-GBUF (plan §5.4): a face's normal, a FLAT pixel lit as drawn, a sprite's own normal by the lamps' share of its light
// (lightingBasic.frag.glsl's faceLight says how).
fn faceLight(world: vec2<f32>, face: vec4<f32>, selfId: f32, selfOn: bool) -> vec3<f32> {
  let q = floor(face.b * 255.0 + 0.5) * 256.0 + floor(face.a * 255.0 + 0.5);
  let kRule = q >= 32768.0;
  let isFlat = face.r > 253.5 / 255.0 && face.g > 253.5 / 255.0;
  let both = kRule || isFlat;
  let f = (face.rg * 255.0 - 127.0) / 126.0;
  var n = vec3<f32>(f, 1.0 - abs(f.x) - abs(f.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  n = normalize(n);
  let z = select(q, q - 32768.0, kRule) / 8.0;
  let lit = uniforms.uFaceLight;
  let p = vec3<f32>(world.x, (world.y + z * lit.x) * uniforms.uGroundInvScaleY, z);
  var sunDirect = min(max(dot(n, uniforms.uFaceSun.xyz), 0.0) * uniforms.uFaceSun.w, 1.6);
  // The sun on a pixel lit as drawn: the floor's, its map's shade and its own shade.
  var sunFlat = 1.0;
// #if SUNMAP
  let sunVis = sunVisibility(p, selfId);
  sunDirect *= sunVis;
  sunFlat = sunVis;
// #endif SUNMAP
// #if SELFSHADOW
  // Faded out at the terminator, where the cosine already shades and a step either way flips the test. A FLAT pixel has
  // no shape of its own to shade itself with.
  var selfSun = 1.0;
  // A face turned away from the light steps into its own body and always reads shaded: only a face the light reaches
  // takes its own shade (by day a sprite looks as drawn; the bench's barn walls went black and freckled with kRule here).
  if (selfOn && !isFlat && sunDirect > 0.05) { selfSun = selfShadow(p, selfId); }
  if (sunDirect > 0.05) { sunDirect *= mix(1.0, selfSun, smoothstep(0.05, 0.3, sunDirect)); }
  sunFlat *= selfSun;
// #endif SELFSHADOW
  var total = vec3<f32>(uniforms.uBaseAmbient) + vec3<f32>(uniforms.uNightR, uniforms.uNightG, uniforms.uNightB);
  total += vec3<f32>(uniforms.uSunR, uniforms.uSunG, uniforms.uSunB) * uniforms.uSunIntensity * (1.0 - lit.w + lit.w * sunDirect);
  // The lamps lit as drawn (cosine 1), for FLAT pixels and the normals' strength.
  var lampFlat = vec3<f32>(0.0);
  let nLights = uniforms.uLightCount;
  let nCones = i32(uniforms.uConeCount);
  let texW = i32(uniforms.uLightTexWidth);
  let DISTANCE_SCALE = 1.0 / 1024.0;
  // The cones first, then every other light as before.
  for (var i = 0; i < MAX_LIGHTS; i++) {
    if (i >= nCones || i >= texW) { break; }
    let posInt = textureLoad(uLightData, vec2<i32>(i, 0), 0);
    if (posInt.z <= 0.0) { continue; }
    let col = textureLoad(uLightData, vec2<i32>(i, 1), 0);
    let toLight = vec3<f32>(posInt.xy, col.a) - p;
    let d = length(toLight);
    let cosine = (dot(n, toLight) / max(d, 0.001) + lit.y) / (1.0 + lit.y);
    if (cosine <= 0.0 && !both) { continue; }
    let scaled = DISTANCE_SCALE * DISTANCE_SCALE;
    let intensityScaled = posInt.z * scaled;
    var cone = coneFactor(p.xy - posInt.xy, textureLoad(uLightData, vec2<i32>(i, 2), 0));
// #if LAMPMAP
    cone *= lampVisibility(p, posInt.xy, col.a, posInt.w, posInt.z, selfId);
// #endif LAMPMAP
    if (cosine > 0.0) {
      total += col.rgb * cosine * lit.z * cone * intensityScaled / (intensityScaled + (d * d - col.a * col.a) * scaled);
    }
    if (both) { lampFlat += col.rgb * lit.z * cone * intensityScaled / (intensityScaled + (d * d - col.a * col.a) * scaled); }
  }
  for (var j = 0; j < MAX_LIGHTS; j++) {
    let i = j + nCones;
    if (i >= nLights || i >= texW) { break; }
    let posInt = textureLoad(uLightData, vec2<i32>(i, 0), 0);
    if (posInt.z <= 0.0) { continue; }
    let col = textureLoad(uLightData, vec2<i32>(i, 1), 0);
    let toLight = vec3<f32>(posInt.xy, col.a) - p;
    let d = length(toLight);
    let cosine = (dot(n, toLight) / max(d, 0.001) + lit.y) / (1.0 + lit.y);
    if (cosine <= 0.0 && !both) { continue; }
    // The source's height is folded into I' and the colour (I' = I + h²): I / (I + d²) = k I' / (I' - h² + d²).
    let scaled = DISTANCE_SCALE * DISTANCE_SCALE;
    let intensityScaled = posInt.z * scaled;
    var shade = 1.0;
    var lampSelf = 1.0;
// #if LAMPMAP
    shade = lampVisibility(p, posInt.xy, col.a, posInt.w, posInt.z, selfId);
// #if SELFSHADOW
    // DX-SELFSHADOW (F8): a lamp with a tile in the lamps' map steps over the face map towards it too, unless the pixel is
    // of the lamp's own entity.
    let lampOwn = selfId > 0.5 && abs(lampOwner(posInt.w) - selfId) < 0.5;
    // Only inside the lamp's radius (its tile's reach: I' = (radius / 10)² + h²): past it the lamp gives under
    // 1 % of its light and its map casts nothing, while the steps cost what they cost near it (E-365: with 32 lamps they were
    // 96 % of the pass).
    let fromLamp = p.xy - posInt.xy;
    let lampNear = dot(fromLamp, fromLamp) < 100.0 * max(posInt.z - col.a * col.a, 0.0);
    if (posInt.w < 0.0 && selfOn && !lampOwn && !isFlat && lampNear && cosine * shade > 0.05) {
      lampSelf = selfShadowToward(p, toLight / max(d, 0.001), d, selfId);
    }
    let flatShade = shade * lampSelf;
    if (cosine * shade > 0.05) { shade *= lampSelf; }
// #endif SELFSHADOW
// #endif LAMPMAP
    if (cosine > 0.0) {
      total += col.rgb * cosine * shade * lit.z * intensityScaled / (intensityScaled + (d * d - col.a * col.a) * scaled);
    }
    if (both) {
      var lampShade = shade;
// #if LAMPMAP
// #if SELFSHADOW
      lampShade = flatShade;
// #endif SELFSHADOW
// #endif LAMPMAP
      lampFlat += col.rgb * lampShade * lit.z * intensityScaled / (intensityScaled + (d * d - col.a * col.a) * scaled);
    }
  }
  if (!both) { return total; }
  let totalFlat = vec3<f32>(uniforms.uBaseAmbient) + vec3<f32>(uniforms.uNightR, uniforms.uNightG, uniforms.uNightB)
    + vec3<f32>(uniforms.uSunR, uniforms.uSunG, uniforms.uSunB) * uniforms.uSunIntensity * sunFlat + lampFlat;
  if (isFlat) { return totalFlat; }
  let k = clamp(dot(lampFlat, vec3<f32>(1.0)) / max(dot(totalFlat, vec3<f32>(1.0)), 0.0001), 0.0, 1.0);
  return mix(totalFlat, total, k);
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
  // DX-EMISSIVE (F10): a glowing pixel keeps its own colour (the face pass's (1/255, 0)).
  if (face.r > 0.0 && face.g < 0.5 / 255.0) {
    return vec4<f32>(1.0);
  }
  if (face.r > 0.0) {
    // DX-GBUF: the pixel's entity and whether it shades itself (a pixel of no entity does, as every height did before).
    var selfId = 0.0;
    var selfOn = true;
// #if IDS
    let ids = textureLoad(uFaceIds, vec2<i32>(in.position.xy), 0);
    selfId = floor(ids.r * 255.0 + 0.5) * 256.0 + floor(ids.g * 255.0 + 0.5);
    selfOn = selfId < 0.5 || (floor(ids.b * 255.0 + 0.5) % 2.0) > 0.5;
// #endif IDS
    return vec4<f32>(min(faceLight(fragWorld, face, selfId, selfOn), vec3<f32>(1.0)), 1.0);
  }
// #endif FACES
  fragWorld.y *= uniforms.uGroundInvScaleY;
  var totalLight = vec3<f32>(uniforms.uBaseAmbient);
// #if SUNMAP
  totalLight += vec3<f32>(uniforms.uSunR, uniforms.uSunG, uniforms.uSunB) * uniforms.uSunIntensity * sunVisibility(vec3<f32>(fragWorld, 0.0), 0.0);
// #endif SUNMAP
// #if !SUNMAP
  totalLight += vec3<f32>(uniforms.uSunR, uniforms.uSunG, uniforms.uSunB) * uniforms.uSunIntensity;
// #endif !SUNMAP
  totalLight += vec3<f32>(uniforms.uNightR, uniforms.uNightG, uniforms.uNightB);
  let nLights = uniforms.uLightCount;
  let nCones = i32(uniforms.uConeCount);
  let texW = i32(uniforms.uLightTexWidth);
  // The cones first (each times its cone), then every other light as before.
  for (var i = 0; i < MAX_LIGHTS; i++) {
    if (i >= nCones || i >= texW) { break; }
    let posInt = textureLoad(uLightData, vec2<i32>(i, 0), 0);
    if (posInt.z <= 0.0) { continue; }
    let col = textureLoad(uLightData, vec2<i32>(i, 1), 0);
    let cone = textureLoad(uLightData, vec2<i32>(i, 2), 0);
    let DISTANCE_SCALE = 1.0 / 1024.0;
    let deltaScaled = (fragWorld - posInt.xy) * DISTANCE_SCALE;
    let d2Scaled = dot(deltaScaled, deltaScaled);
    let intensityScaled = posInt.z * DISTANCE_SCALE * DISTANCE_SCALE;
    var attenuation = intensityScaled / (intensityScaled + d2Scaled);
// #if LAMPMAP
    attenuation *= lampVisibility(vec3<f32>(fragWorld, 0.0), posInt.xy, col.a, posInt.w, posInt.z, 0.0);
// #endif LAMPMAP
    totalLight += col.rgb * attenuation * coneFactor(deltaScaled, cone);
  }
  for (var j = 0; j < MAX_LIGHTS; j++) {
    let i = j + nCones;
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
      var attenuation = intensityScaled / (intensityScaled + d2Scaled);
// #if LAMPMAP
      attenuation *= lampVisibility(vec3<f32>(fragWorld, 0.0), lightWorld, col.a, posInt.w, intensity, 0.0);
// #endif LAMPMAP
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
