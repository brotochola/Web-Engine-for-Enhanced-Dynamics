precision highp float;

uniform vec2 uCameraPos;
uniform float uZoom;
uniform vec2 uViewport;
uniform vec2 uFullCanvasSize;
uniform vec2 uCameraRot;

uniform sampler2D uLightData;
uniform float uLightTexWidth;
uniform int uLightCount;
// DX-SPOT: the first uConeCount lights are cones, with a third row (direction on the floor, cos of the half aperture,
// 1 / the soft edge's width); they loop apart, so a point light runs the loop it always ran.
uniform float uConeCount;
uniform float uBaseAmbient;
uniform float uSunIntensity;
uniform float uSunR;
uniform float uSunG;
uniform float uSunB;
uniform float uFlipY;
uniform sampler2D uShadowMap;
uniform float uShadowComposite;
// 1 / config.lighting.groundScaleY: the lights' y arrive in floor units, the fragment's is scaled here once.
uniform float uGroundInvScaleY;
// The night light, color already multiplied by its strength and Sun.nightFactor.
uniform float uNightR;
uniform float uNightG;
uniform float uNightB;

// The light data texture's rows (3 texels tall, sampled at their centres).
const float ROW0 = 1.0 / 6.0;
const float ROW1 = 0.5;
const float ROW2 = 5.0 / 6.0;

// DX-SPOT: how far inside its cone a point at floor offset delta from the light is: 1 inside, 0 outside, smooth across
// the soft edge. At the light itself, 1.
float coneFactor(vec2 delta, vec4 cone) {
  float len2 = dot(delta, delta);
  float cosA = len2 > 0.0 ? dot(delta, cone.xy) * inversesqrt(len2) : 1.0;
  float t = clamp((cosA - cone.z) * cone.w, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// A world point's place on the canvas, 0..1 (weedScreenToWorld's inverse).
vec2 weedWorldToNorm(vec2 world) {
  vec2 focus = uCameraPos + uFullCanvasSize / (2.0 * uZoom);
  vec2 d = (world - focus) * uZoom;
  vec2 sxy = vec2(uCameraRot.x * d.x - uCameraRot.y * d.y, uCameraRot.y * d.x + uCameraRot.x * d.y);
  return (sxy + uFullCanvasSize * 0.5) / uFullCanvasSize;
}

// #if SUNMAP
// DX-SHADOW3D: the sun's shadow map (sunShadowMap.js), laid out on the screen as the sprite shadows' layer is.
uniform sampler2D uSunMap;
uniform vec4 uSunMapK; // kx, ky (a px of height's landing shift on the floor), groundScaleY, the shadow's opacity

// How much of the sun reaches floor point p (x, y on the floor, z up): 1 lit, 1 - opacity in the shade, five taps.
float sunVisibility(vec3 p) {
  vec2 land = p.xy - p.z * uSunMapK.xy;
  vec2 uv = weedWorldToNorm(vec2(land.x, land.y * uSunMapK.z));
  vec2 texel = 1.0 / uViewport;
  float bias = 4.0 + p.z * 0.03;
  float lit = 0.0;
  lit += texture2D(uSunMap, uv).r * 512.0 > p.z + bias ? 0.0 : 1.0;
  lit += texture2D(uSunMap, uv + vec2(texel.x, 0.0)).r * 512.0 > p.z + bias ? 0.0 : 1.0;
  lit += texture2D(uSunMap, uv - vec2(texel.x, 0.0)).r * 512.0 > p.z + bias ? 0.0 : 1.0;
  lit += texture2D(uSunMap, uv + vec2(0.0, texel.y)).r * 512.0 > p.z + bias ? 0.0 : 1.0;
  lit += texture2D(uSunMap, uv - vec2(0.0, texel.y)).r * 512.0 > p.z + bias ? 0.0 : 1.0;
  return 1.0 - uSunMapK.w * (1.0 - lit * 0.2);
}
// #endif SUNMAP

// #if LAMPMAP
// DX-SHADOW3D (F7): the lamps' shadow map (lampShadowMap.js): a tile a lamp in an atlas, each texel the height of the
// highest caster point whose ray from that lamp lands there. A light with a tile carries -(tile + 1) in its first row's w
// (its range's square otherwise, which this pass does not read); its tile reaches its radius, which its intensity and
// height give back (I' = (radius / 10)² + h²).
uniform sampler2D uLampMap;
uniform vec4 uLampAtlas; // tiles a row, a tile's texels, the atlas's width and height in texels

float lampTap(vec2 cell, vec2 uv, float h, vec2 toAtlas, float above) {
  return texture2D(uLampMap, (cell + clamp(uv, h, 1.0 - h)) * toAtlas).r * 512.0 > above ? 0.0 : 1.0;
}

// How much of the light at floor point l, height e reaches point p (x, y on the floor, z up): 1 lit, 0 in its shadow,
// five taps. tag: the light's first row's w; intensity: its I'.
float lampVisibility(vec3 p, vec2 l, float e, float tag, float intensity) {
  if (tag >= 0.0 || e <= 0.0 || p.z >= e) return 1.0;
  float reach = 10.0 * sqrt(max(intensity - e * e, 0.0));
  if (reach <= 0.0) return 1.0;
  float room = e - p.z;
  float k = room > e * 0.125 ? e / room : 8.0;
  vec2 uv = (p.xy - l) * k / (2.0 * reach) + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return 1.0;
  float tile = -tag - 1.0;
  vec2 cell = vec2(mod(tile, uLampAtlas.x), floor(tile / uLampAtlas.x));
  vec2 toAtlas = vec2(uLampAtlas.y) / uLampAtlas.zw;
  float h = 0.5 / uLampAtlas.y;
  float above = p.z + 4.0 + p.z * 0.03;
  float lit = lampTap(cell, uv, h, toAtlas, above);
  lit += lampTap(cell, uv + vec2(2.0 * h, 0.0), h, toAtlas, above);
  lit += lampTap(cell, uv - vec2(2.0 * h, 0.0), h, toAtlas, above);
  lit += lampTap(cell, uv + vec2(0.0, 2.0 * h), h, toAtlas, above);
  lit += lampTap(cell, uv - vec2(0.0, 2.0 * h), h, toAtlas, above);
  return lit * 0.2;
}
// #endif LAMPMAP

// #if FACES
// DX-FACES: this pixel's face, in the face map, drawn at this pass's size.
uniform sampler2D uFaceMap;
uniform vec4 uFaceLight; // heightScaleY, wrap, gain, sunDirect
uniform vec4 uFaceSun; // towards the sun in the floor's space; w: 1 / its height, so a flat surface reads as the floor
// #if SELFSHADOW
// DX-SELFSHADOW: steps towards the sun over the face map's heights (screen space, as the light bench's relief did): a
// surface that rises above the ray shades this pixel from the sun. x: a step's length (floor px), y: steps, z: bias (px).
uniform vec4 uSelfShadow;

float faceHeight(vec4 face) {
  return (floor(face.b * 255.0 + 0.5) * 256.0 + floor(face.a * 255.0 + 0.5)) / 8.0;
}

// The first step skips the pixel's own neighbours, and the bias grows with the distance: the map is at the light pass's
// resolution, so a steep surface's own texels next door read a few px higher (the bench's freckles).
// Towards unit direction l, no further than reach (a lamp's distance; the sun's is unbounded).
float selfShadowToward(vec3 p, vec3 l, float reach) {
  float s = 1.0 / uGroundInvScaleY;
  for (int i = 2; i <= 9; i++) {
    if (float(i) > uSelfShadow.y + 1.0) break;
    float t = float(i) * uSelfShadow.x;
    if (t >= reach) break;
    vec3 q = p + l * t;
    vec2 nc = weedWorldToNorm(vec2(q.x, q.y * s - q.z * uFaceLight.x));
    vec4 f = texture2D(uFaceMap, vec2(nc.x, uFlipY > 0.5 ? 1.0 - nc.y : nc.y));
    if (f.r > 0.0 && faceHeight(f) > q.z + uSelfShadow.z + t * 0.25) return 0.0;
  }
  return 1.0;
}

float selfShadow(vec3 p) {
  return selfShadowToward(p, normalize(uFaceSun.xyz), 1e9);
}
// #endif SELFSHADOW

vec3 faceLight(vec2 world, vec4 face) {
  vec2 f = (face.rg * 255.0 - 127.0) / 126.0;
  vec3 n = vec3(f, 1.0 - abs(f.x) - abs(f.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  n = normalize(n);
  float z = (floor(face.b * 255.0 + 0.5) * 256.0 + floor(face.a * 255.0 + 0.5)) / 8.0;
  vec3 p = vec3(world.x, (world.y + z * uFaceLight.x) * uGroundInvScaleY, z);
  float sunDirect = min(max(dot(n, uFaceSun.xyz), 0.0) * uFaceSun.w, 1.6);
// #if SUNMAP
  sunDirect *= sunVisibility(p);
// #endif SUNMAP
// #if SELFSHADOW
  // Faded out at the terminator, where the cosine already shades and a step either way flips the test.
  if (sunDirect > 0.05) sunDirect *= mix(1.0, selfShadow(p), smoothstep(0.05, 0.3, sunDirect));
// #endif SELFSHADOW
  vec3 total = vec3(uBaseAmbient) + vec3(uNightR, uNightG, uNightB);
  total += vec3(uSunR, uSunG, uSunB) * uSunIntensity * (1.0 - uFaceLight.w + uFaceLight.w * sunDirect);
  const float DISTANCE_SCALE = 1.0 / 1024.0;
  // The cones first, then every other light as before.
  int coneCount = int(uConeCount);
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= coneCount) break;
    float u = (float(i) + 0.5) / uLightTexWidth;
    vec4 posInt = texture2D(uLightData, vec2(u, ROW0));
    if (posInt.z <= 0.0) continue;
    vec4 col = texture2D(uLightData, vec2(u, ROW1));
    vec3 toLight = vec3(posInt.xy, col.a) - p;
    float d = length(toLight);
    float cosine = (dot(n, toLight) / max(d, 0.001) + uFaceLight.y) / (1.0 + uFaceLight.y);
    if (cosine <= 0.0) continue;
    float scaled = DISTANCE_SCALE * DISTANCE_SCALE;
    float intensityScaled = posInt.z * scaled;
    float cone = coneFactor(p.xy - posInt.xy, texture2D(uLightData, vec2(u, ROW2)));
// #if LAMPMAP
    cone *= lampVisibility(p, posInt.xy, col.a, posInt.w, posInt.z);
// #endif LAMPMAP
    total += col.rgb * cosine * uFaceLight.z * cone * intensityScaled
      / (intensityScaled + (d * d - col.a * col.a) * scaled);
  }
  for (int j = 0; j < MAX_LIGHTS; j++) {
    int i = j + coneCount;
    if (i >= uLightCount) break;
    float u = (float(i) + 0.5) / uLightTexWidth;
    vec4 posInt = texture2D(uLightData, vec2(u, ROW0));
    if (posInt.z <= 0.0) continue;
    vec4 col = texture2D(uLightData, vec2(u, ROW1));
    vec3 toLight = vec3(posInt.xy, col.a) - p;
    float d = length(toLight);
    float cosine = (dot(n, toLight) / max(d, 0.001) + uFaceLight.y) / (1.0 + uFaceLight.y);
    if (cosine <= 0.0) continue;
    // The source's height is folded into I' and the colour (I' = I + h²): I / (I + d²) = k I' / (I' - h² + d²).
    float scaled = DISTANCE_SCALE * DISTANCE_SCALE;
    float intensityScaled = posInt.z * scaled;
// #if LAMPMAP
    cosine *= lampVisibility(p, posInt.xy, col.a, posInt.w, posInt.z);
// #if SELFSHADOW
    // DX-SELFSHADOW (F8): a lamp with a tile in the lamps' map steps over the face map towards it too.
    if (posInt.w < 0.0 && cosine > 0.05) cosine *= selfShadowToward(p, toLight / max(d, 0.001), d);
// #endif SELFSHADOW
// #endif LAMPMAP
    total += col.rgb * cosine * uFaceLight.z * intensityScaled
      / (intensityScaled + (d * d - col.a * col.a) * scaled);
  }
  return total;
}
// #endif FACES

vec2 weedScreenToWorld(vec2 screenPos) {
  vec2 focus = uCameraPos + uFullCanvasSize / (2.0 * uZoom);
  vec2 sxy = screenPos - uFullCanvasSize * 0.5;
  return focus + vec2(
    uCameraRot.x * sxy.x + uCameraRot.y * sxy.y,
    -uCameraRot.y * sxy.x + uCameraRot.x * sxy.y
  ) / uZoom;
}

void main() {
  float y = gl_FragCoord.y;
  if (uFlipY > 0.5) y = uViewport.y - y;
  vec2 normCoord = vec2(gl_FragCoord.x, y) / uViewport;
  vec2 screenPos = normCoord * uFullCanvasSize;
  vec2 fragWorld = weedScreenToWorld(screenPos);
// #if FACES
  vec4 face = texture2D(uFaceMap, gl_FragCoord.xy / uViewport);
  if (face.r > 0.0) {
    gl_FragColor = vec4(min(faceLight(fragWorld, face), vec3(1.0)), 1.0);
    return;
  }
// #endif FACES
  fragWorld.y *= uGroundInvScaleY;
  vec3 totalLight = vec3(uBaseAmbient);
  vec3 sunColor = vec3(uSunR, uSunG, uSunB);
// #if SUNMAP
  totalLight += sunColor * uSunIntensity * sunVisibility(vec3(fragWorld, 0.0));
// #endif SUNMAP
// #if !SUNMAP
  totalLight += sunColor * uSunIntensity;
// #endif !SUNMAP
  totalLight += vec3(uNightR, uNightG, uNightB);

  // The cones first (each times its cone), then every other light as before.
  int coneCount = int(uConeCount);
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= coneCount) break;
    float u = (float(i) + 0.5) / uLightTexWidth;
    vec4 posInt = texture2D(uLightData, vec2(u, ROW0));
    if (posInt.z <= 0.0) continue;
    vec4 col = texture2D(uLightData, vec2(u, ROW1));
    vec4 cone = texture2D(uLightData, vec2(u, ROW2));
    const float DISTANCE_SCALE = 1.0 / 1024.0;
    vec2 deltaScaled = (fragWorld - posInt.xy) * DISTANCE_SCALE;
    float d2Scaled = dot(deltaScaled, deltaScaled);
    float intensityScaled = posInt.z * DISTANCE_SCALE * DISTANCE_SCALE;
    float attenuation = intensityScaled / (intensityScaled + d2Scaled);
// #if LAMPMAP
    attenuation *= lampVisibility(vec3(fragWorld, 0.0), posInt.xy, col.a, posInt.w, posInt.z);
// #endif LAMPMAP
    totalLight += col.rgb * attenuation * coneFactor(deltaScaled, cone);
  }

  for (int j = 0; j < MAX_LIGHTS; j++) {
    int i = j + coneCount;
    if (i >= uLightCount) break;

    float u = (float(i) + 0.5) / uLightTexWidth;
    vec4 posInt = texture2D(uLightData, vec2(u, ROW0));
    vec4 col = texture2D(uLightData, vec2(u, ROW1));

    vec2 lightWorld = posInt.xy;
    float intensity = posInt.z;
    vec3 color = col.rgb;

    if (intensity > 0.0) {
      const float DISTANCE_SCALE = 1.0 / 1024.0;
      vec2 deltaScaled = (fragWorld - lightWorld) * DISTANCE_SCALE;
      float d2Scaled = dot(deltaScaled, deltaScaled);
      float intensityScaled = intensity * DISTANCE_SCALE * DISTANCE_SCALE;
      float attenuation = intensityScaled / (intensityScaled + d2Scaled);
// #if LAMPMAP
      attenuation *= lampVisibility(vec3(fragWorld, 0.0), lightWorld, col.a, posInt.w, intensity);
// #endif LAMPMAP
      totalLight += color * attenuation;
    }
  }

  if (uShadowComposite > 0.5) {
    vec4 sh = texture2D(uShadowMap, normCoord);
    totalLight *= (1.0 - sh.a);
  }
  totalLight = min(totalLight, vec3(1.0));
  gl_FragColor = vec4(totalLight, 1.0);
}
