#version 300 es
precision highp float;
// ES 3.0 for its explicit-LOD reads: a texture read with gradients inside a branch of a loop that leaves per pixel makes
// ANGLE's D3D11 flatten the branch (both sides run), so no early out (a lamp's reach, its cosine) saved anything on WebGL
// (E-365). Every input is a render target without mipmaps: textureLod at level 0 reads what texture() did.
out vec4 finalColor;

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
// The light data's rows, read by texelFetch (E-373: an integer texel, the same as the WGSL's textureLoad, a Load on
// ANGLE's D3D11 where a textureLod at a normalized coordinate was a sampled read): 0 position and I', 1 colour and
// height, 2 a cone, 3 x a lamp's map shadow fade at the cut of maxShadowCastingLights (N-212; 1 for a light not fading).

// DX-SPOT: how far inside its cone a point at floor offset delta from the light is: 1 inside, 0 outside, smooth across
// the soft edge. At the light itself, 1.
float coneFactor(vec2 delta, vec4 cone) {
  float len2 = dot(delta, delta);
  float cosA = len2 > 0.0 ? dot(delta, cone.xy) * inversesqrt(len2) : 1.0;
  float t = clamp((cosA - cone.z) * cone.w, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// A light ends at its radius (I' = (radius / 10)² + h², h its height): its falloff times (1 - (d / radius)⁴)², d on the
// floor, 1 at the light and nearly 1 halfway, 0 at the radius and past it, as Unreal's and Godot's lights end at theirs. Its
// shadows fade out with it: near its radius there is little of its light left to take out.
float reachWindow(float floorD2, float iPrime, float h) {
  float q = floorD2 / (100.0 * max(iPrime - h * h, 1e-6));
  float w = clamp(1.0 - q * q, 0.0, 1.0);
  return w * w;
}

// A world point's place on the canvas, 0..1 (weedScreenToWorld's inverse).
vec2 weedWorldToNorm(vec2 world) {
  vec2 focus = uCameraPos + uFullCanvasSize / (2.0 * uZoom);
  vec2 d = (world - focus) * uZoom;
  vec2 sxy = vec2(uCameraRot.x * d.x - uCameraRot.y * d.y, uCameraRot.y * d.x + uCameraRot.x * d.y);
  return (sxy + uFullCanvasSize * 0.5) / uFullCanvasSize;
}

// DX-GBUF: the entity id a shadow map's texel keeps (its highest caster's, B·256 + A; 0 none) and whether it is the
// pixel's own (selfId: the G-buffer's id there, 0 none): a caster's own shadow never paints its own sprite.
bool ownTexel(vec4 m, float selfId) {
  return selfId > 0.5 && abs(floor(m.b * 255.0 + 0.5) * 256.0 + floor(m.a * 255.0 + 0.5) - selfId) < 0.5;
}

// #if SUNMAP
// DX-SHADOW3D: the sun's shadow map (sunShadowMap.js), laid out on the screen as the sprite shadows' layer is.
uniform sampler2D uSunMap;
uniform vec4 uSunMapK; // kx, ky (a px of height's landing shift on the floor), groundScaleY, the shadow's opacity

// One tap of the sun's map: 1 lit, under a higher caster that is not the pixel's own entity (selfId) what its opacity
// (G, DX-CASTER) leaves.
float sunTap(vec2 uv, float above, float selfId) {
  vec4 m = textureLod(uSunMap, uv, 0.0);
  return m.r * 512.0 > above && !ownTexel(m, selfId) ? 1.0 - m.g : 1.0;
}

// How much of the sun reaches floor point p (x, y on the floor, z up): 1 lit, 1 - opacity in the shade, five taps. The
// shade of the pixel's own entity (selfId, 0 for none) does not count.
float sunVisibility(vec3 p, float selfId) {
  vec2 land = p.xy - p.z * uSunMapK.xy;
  vec2 uv = weedWorldToNorm(vec2(land.x, land.y * uSunMapK.z));
  vec2 texel = 1.0 / uViewport;
  // N-192: a floor point (z 0) takes no bias: the floor casts nothing, so its only shade is other casters', and with
  // the bias their bottom 4 px cast none (each shadow stood 4 |k| px off its caster's base). A pixel above the floor keeps it.
  // N-210: a pixel of an entity (its id known) skips its own entity's texels (ownTexel), so it keeps only the map's
  // height step (2 px) towards lit: 4 px and more erased the shade of a caster just behind it (a person by the barn's
  // wall, the sun's ray from their head meeting the wall 5 px higher). A pixel of no entity keeps the old bias.
  float bias = p.z > 0.0 ? (selfId > 0.5 ? 2.0 : 4.0 + p.z * 0.03) : 0.0;
  float above = p.z + bias;
  float lit = sunTap(uv, above, selfId);
// #if PIXELART
  // DX-PIXELSHADOW: one tap at the art pixel's centre (main snapped the point), so the shade is crisp on the art's grid.
  return 1.0 - uSunMapK.w * (1.0 - lit);
// #endif PIXELART
// #if !PIXELART
  lit += sunTap(uv + vec2(texel.x, 0.0), above, selfId);
  lit += sunTap(uv - vec2(texel.x, 0.0), above, selfId);
  lit += sunTap(uv + vec2(0.0, texel.y), above, selfId);
  lit += sunTap(uv - vec2(0.0, texel.y), above, selfId);
  return 1.0 - uSunMapK.w * (1.0 - lit * 0.2);
// #endif !PIXELART
}
// #endif SUNMAP

// #if LAMPMAP
// DX-SHADOW3D (F7): the lamps' shadow map (lampShadowMap.js): a tile a lamp in an atlas, each texel the height of the
// highest caster point whose ray from that lamp lands there. DX-LAMPPANO: a tile is two halves of uLampAtlas.y texels a
// side, the floor's (what is lower than the lamp) and the ceiling's (what is higher, mirrored in the lamp's height: there
// a texel keeps the lowest caster point), each landing compressed into its half out to the horizon (lampPanoUv). A light with a tile carries -(tile + 1) in its first row's w
// (its range's square otherwise, which this pass does not read); its tile reaches its radius, which its intensity and
// height give back (I' = (radius / 10)² + h²). DX-GBUF: with the ids map the tag is -(tile + 1 + 256 · the lamp's entity
// id): tiles under 256, and a pixel of the lamp's own entity does not step towards it (lampOwner).
uniform sampler2D uLampMap;
uniform vec4 uLampAtlas; // tiles a row, a tile's texels, the atlas's width and height in texels

// A lamp's tile from its tag.
float lampTile(float tag) {
// #if IDS
  return mod(-tag - 1.0, 256.0);
// #endif IDS
// #if !IDS
  return -tag - 1.0;
// #endif !IDS
}

// A lamp's entity id from its tag (0 none).
float lampOwner(float tag) {
// #if IDS
  return tag < 0.0 ? floor((-tag - 1.0) / 256.0) : 0.0;
// #endif IDS
// #if !IDS
  return 0.0;
// #endif !IDS
}

// DX-LAMPPANO: a landing (its offset from the lamp on the floor) into its half tile, 0..1 (lampShadowMap.js lampPanoUv:
// linearly to 0.8 of the half's radius within the reach, the rest of the world beyond it, the horizon at the edge).
vec2 lampPanoUv(vec2 v, float reach) {
  float r = length(v);
  float q = r / reach;
  float c = q <= 1.0 ? 0.80 * q : 0.80 + 0.20 * (1.0 - 1.0 / q);
  return vec2(0.5) + (r > 1e-4 ? v * (0.5 * c / r) : vec2(0.0));
}

// One tap: a point is shaded under a caster nearer the lamp on its ray than `bound` (N-211: a texel keeps the place along
// the ray, lampShadowMap.js lampRayDepth: more is nearer; an empty texel, 0, holds none).
float lampTap(vec2 cell, vec2 uv, float h, vec2 toAtlas, float bound, float selfId) {
  vec4 m = textureLod(uLampMap, (cell + clamp(uv, h, 1.0 - h)) * toAtlas, 0.0);
  return m.r > bound && !ownTexel(m, selfId) ? 1.0 - m.g : 1.0;
}

// How much of the light at floor point l, height e reaches point p (x, y on the floor, z up): 1 lit, 0 in its shadow,
// five taps. tag: the light's first row's w; intensity: its I'; selfId: the pixel's entity (its own shade skipped); li: its
// column in the light data, whose fourth row holds its fade at the cut (N-212: the shade lightens as it fades, read only
// for a point the lamp's map covers).
float lampVisibility(vec3 p, vec2 l, float e, float tag, float intensity, float selfId, int li) {
  if (tag >= 0.0 || e <= 0.0) return 1.0;
  float reach = 10.0 * sqrt(max(intensity - e * e, 0.0));
  // DX-LAMPPANO: past the reach on the floor the lamp gives no light (reachWindow), so nothing to read.
  vec2 fromLamp = p.xy - l;
  if (reach <= 0.0 || dot(fromLamp, fromLamp) >= reach * reach) return 1.0;
  float fade = texelFetch(uLightData, ivec2(li, 3), 0).x;
  if (fade <= 0.0) return 1.0;
  // DX-LAMPPANO: a point higher than the lamp reads the ceiling's half, landing as its mirror (2E - z) does.
  bool upper = p.z > e;
  float room = max(abs(e - p.z), e / 64.0);
  vec2 uv = lampPanoUv(fromLamp * (e / room), reach);
  float tile = lampTile(tag);
  vec2 cell = vec2(mod(tile, uLampAtlas.x) * 2.0 + (upper ? 1.0 : 0.0), floor(tile / uLampAtlas.x));
  vec2 toAtlas = vec2(uLampAtlas.y) / uLampAtlas.zw;
  float h = 0.5 / uLampAtlas.y;
  // N-192: a floor point (z 0) takes no bias: the floor casts nothing, so its only shade is other casters', and with
  // the bias their bottom 4 px cast none (each shadow stood 4 |k| px off its caster's base). A pixel above the floor keeps
  // one towards lit (on the floor's half over its height, on the ceiling's under it): 1 px and 4 floor px along its ray
  // in height. A fixed 4 px erased under a low lamp, whose rays are nearly level, the shade of anything near the point
  // (a person's on the wall behind them: 3 px of height between them on the ray).
  // N-211: against the point's own place along the ray (1 / (1 + |E - z| / E)), plus the texels' step and a half for a
  // pixel of an entity (its own texels skipped) or four steps for one of no entity.
  float bound = 1.0 / (1.0 + abs(e - p.z) / e) + (p.z > 0.0 ? (selfId > 0.5 ? 1.5 : 4.0) : 0.5) / 255.0;
  float lit = lampTap(cell, uv, h, toAtlas, bound, selfId);
// #if PIXELART
  // DX-PIXELSHADOW: one tap at the art pixel's centre, crisp on the art's grid.
  return 1.0 - (1.0 - lit) * fade;
// #endif PIXELART
// #if !PIXELART
  lit += lampTap(cell, uv + vec2(2.0 * h, 0.0), h, toAtlas, bound, selfId);
  lit += lampTap(cell, uv - vec2(2.0 * h, 0.0), h, toAtlas, bound, selfId);
  lit += lampTap(cell, uv + vec2(0.0, 2.0 * h), h, toAtlas, bound, selfId);
  lit += lampTap(cell, uv - vec2(0.0, 2.0 * h), h, toAtlas, bound, selfId);
  return 1.0 - (1.0 - lit * 0.2) * fade;
// #endif !PIXELART
}

// DX-LAMPPANO: lampVisibility for a floor point (z 0, the flat path): always under the lamp, on the floor's half, no bias.
// Its own small body: with the full lookup inlined at the flat path's two loops too, ANGLE's D3D11 compiler failed to link
// the light pass (2.9 s, no log); so it links in about the time the stretch-capped map's pass did.
float lampVisibilityFloor(vec2 p, vec2 l, float e, float tag, float intensity, int li) {
  if (tag >= 0.0 || e <= 0.0) return 1.0;
  float reach = 10.0 * sqrt(max(intensity - e * e, 0.0));
  vec2 fromLamp = p - l;
  if (reach <= 0.0 || dot(fromLamp, fromLamp) >= reach * reach) return 1.0;
  // N-212: its fade at the cut (lampVisibility says how).
  float fade = texelFetch(uLightData, ivec2(li, 3), 0).x;
  if (fade <= 0.0) return 1.0;
  vec2 uv = lampPanoUv(fromLamp, reach);
  float tile = lampTile(tag);
  vec2 cell = vec2(mod(tile, uLampAtlas.x) * 2.0, floor(tile / uLampAtlas.x));
  vec2 toAtlas = vec2(uLampAtlas.y) / uLampAtlas.zw;
  float h = 0.5 / uLampAtlas.y;
  float lit = lampTap(cell, uv, h, toAtlas, 0.5 + 0.5 / 255.0, 0.0);
// #if PIXELART
  return 1.0 - (1.0 - lit) * fade;
// #endif PIXELART
// #if !PIXELART
  lit += lampTap(cell, uv + vec2(2.0 * h, 0.0), h, toAtlas, 0.5 + 0.5 / 255.0, 0.0);
  lit += lampTap(cell, uv - vec2(2.0 * h, 0.0), h, toAtlas, 0.5 + 0.5 / 255.0, 0.0);
  lit += lampTap(cell, uv + vec2(0.0, 2.0 * h), h, toAtlas, 0.5 + 0.5 / 255.0, 0.0);
  lit += lampTap(cell, uv - vec2(0.0, 2.0 * h), h, toAtlas, 0.5 + 0.5 / 255.0, 0.0);
  return 1.0 - (1.0 - lit * 0.2) * fade;
// #endif !PIXELART
}
// #endif LAMPMAP

// #if FACES
// DX-FACES: this pixel's face, in the face map, drawn at this pass's size.
uniform sampler2D uFaceMap;
uniform vec4 uFaceLight; // heightScaleY, wrap, gain, sunDirect
uniform vec4 uFaceSun; // towards the sun in the floor's space; w: 1 / its height, so a flat surface reads as the floor
// #if IDS
// DX-GBUF (plan §6.4): the G-buffer's entity ids (faceMap.js FACE_IDS_SELF), drawn with the face map.
uniform sampler2D uFaceIds;
// #endif IDS
// #if SELFSHADOW
// DX-SELFSHADOW: steps towards the sun over the face map's heights (screen space, as the light bench's relief did): a
// surface that rises above the ray shades this pixel from the sun. x: a step's length (floor px), y: steps, z: bias (px).
uniform vec4 uSelfShadow;

// A face map texel's height (px): 15 bits in eighths of a px, the top bit a sprite's own normal (faceMap.js FACE_K_BIT).
float faceHeight(vec4 face) {
  return mod(floor(face.b * 255.0 + 0.5) * 256.0 + floor(face.a * 255.0 + 0.5), 32768.0) / 8.0;
}

// The first step skips the pixel's own neighbours, and the bias grows with the distance: the map is at the light pass's
// resolution, so a steep surface's own texels next door read a few px higher (the bench's freckles).
// Towards unit direction l, no further than reach (a lamp's distance; the sun's is unbounded). DX-GBUF: with the ids
// map, only the heights of the pixel's own entity (selfId) count; a pixel of no entity counts every height.
float selfShadowToward(vec3 p, vec3 l, float reach, float selfId) {
  float s = 1.0 / uGroundInvScaleY;
  for (int i = 2; i <= 9; i++) {
    if (float(i) > uSelfShadow.y + 1.0) break;
    float t = float(i) * uSelfShadow.x;
    if (t >= reach) break;
    vec3 q = p + l * t;
    vec2 nc = weedWorldToNorm(vec2(q.x, q.y * s - q.z * uFaceLight.x));
    vec2 fc = vec2(nc.x, uFlipY > 0.5 ? 1.0 - nc.y : nc.y);
    vec4 f = textureLod(uFaceMap, fc, 0.0);
// #if IDS
    if (selfId > 0.5) {
      vec4 g = textureLod(uFaceIds, fc, 0.0);
      if (abs(floor(g.r * 255.0 + 0.5) * 256.0 + floor(g.g * 255.0 + 0.5) - selfId) > 0.5) continue;
    }
// #endif IDS
    if (f.r > 0.0 && faceHeight(f) > q.z + uSelfShadow.z + t * 0.25) return 0.0;
  }
  return 1.0;
}

float selfShadow(vec3 p, float selfId) {
  return selfShadowToward(p, normalize(uFaceSun.xyz), 1e9, selfId);
}
// #endif SELFSHADOW

// DX-GBUF (plan §5.4): a pixel with a face's normal is lit by it (DX-FACES, as always); a FLAT one (faceMap.js
// FACE_FLAT_CODE: a standing card, normals 'flat') as drawn, every light at full cosine, at its place in 3D; a sprite's
// own normal (its height's FACE_K_BIT) shows as much as the lamps' share of its light, k = lamps / (lamps + ambient + sun),
// worked out from the flat light: by day the sprite looks as drawn, at night by a lamp its normals show.
vec3 faceLight(vec2 world, vec4 face, float selfId, bool selfOn) {
  float q = floor(face.b * 255.0 + 0.5) * 256.0 + floor(face.a * 255.0 + 0.5);
  bool kRule = q >= 32768.0;
  bool isFlat = face.r > 253.5 / 255.0 && face.g > 253.5 / 255.0;
  bool both = kRule || isFlat;
  vec2 f = (face.rg * 255.0 - 127.0) / 126.0;
  vec3 n = vec3(f, 1.0 - abs(f.x) - abs(f.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  n = normalize(n);
  float z = (kRule ? q - 32768.0 : q) / 8.0;
  vec3 p = vec3(world.x, (world.y + z * uFaceLight.x) * uGroundInvScaleY, z);
  float sunDirect = min(max(dot(n, uFaceSun.xyz), 0.0) * uFaceSun.w, 1.6);
  // The sun on a pixel lit as drawn: the floor's, its map's shade and its own shade.
  float sunFlat = 1.0;
// #if SUNMAP
  float sunVis = sunVisibility(p, selfId);
  sunDirect *= sunVis;
  // N-208: a face the sun does not reach, on an entity that shades itself (a closed volume: a render with a footprint), is
  // in its own shade, where no other caster's shadow shows (by day it looks as drawn): the map's shade fades out across
  // the terminator. The map keeps the highest caster on a ray and a pixel skips its own entity's, so a tree beyond the barn
  // shaded the barn's far wall through the barn. A FLAT pixel (a card) has no side turned away, and an entity that does not
  // shade itself (a person, a thin sprite whose normals come from its height map) takes another's shadow whole: a person
  // with their back to the sun stood lit in the barn's shadow.
  sunFlat = (isFlat || !selfOn) ? sunVis : mix(1.0, sunVis, smoothstep(0.0, 0.15, dot(n, uFaceSun.xyz)));
// #endif SUNMAP
// #if SELFSHADOW
  // Faded out at the terminator, where the cosine already shades and a step either way flips the test. A FLAT pixel has
  // no shape of its own to shade itself with.
  // A face turned away from the light steps into its own body and always reads shaded: only a face the light reaches
  // takes its own shade (by day a sprite looks as drawn; the bench's barn walls went black and freckled with kRule here).
  float selfSun = (selfOn && !isFlat && sunDirect > 0.05) ? selfShadow(p, selfId) : 1.0;
  if (sunDirect > 0.05) sunDirect *= mix(1.0, selfSun, smoothstep(0.05, 0.3, sunDirect));
  sunFlat *= selfSun;
// #endif SELFSHADOW
  vec3 total = vec3(uBaseAmbient) + vec3(uNightR, uNightG, uNightB);
  total += vec3(uSunR, uSunG, uSunB) * uSunIntensity * (1.0 - uFaceLight.w + uFaceLight.w * sunDirect);
  // The lamps lit as drawn (cosine 1), for FLAT pixels and the normals' strength.
  vec3 lampFlat = vec3(0.0);
  const float DISTANCE_SCALE = 1.0 / 1024.0;
  // The cones first, then every other light as before.
  int coneCount = int(uConeCount);
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= coneCount) break;
    vec4 posInt = texelFetch(uLightData, ivec2(i, 0), 0);
    if (posInt.z <= 0.0) continue;
    vec4 col = texelFetch(uLightData, ivec2(i, 1), 0);
    vec3 toLight = vec3(posInt.xy, col.a) - p;
    float d = length(toLight);
    float cosine = (dot(n, toLight) / max(d, 0.001) + uFaceLight.y) / (1.0 + uFaceLight.y);
    if (cosine <= 0.0 && !both) continue;
    float scaled = DISTANCE_SCALE * DISTANCE_SCALE;
    float intensityScaled = posInt.z * scaled;
    float cone = coneFactor(p.xy - posInt.xy, texelFetch(uLightData, ivec2(i, 2), 0))
      * reachWindow(dot(toLight.xy, toLight.xy), posInt.z, col.a);
// #if LAMPMAP
    cone *= lampVisibility(p, posInt.xy, col.a, posInt.w, posInt.z, selfId, i);
// #endif LAMPMAP
    if (cosine > 0.0) {
      total += col.rgb * cosine * uFaceLight.z * cone * intensityScaled
        / (intensityScaled + (d * d - col.a * col.a) * scaled);
    }
    if (both) lampFlat += col.rgb * uFaceLight.z * cone * intensityScaled / (intensityScaled + (d * d - col.a * col.a) * scaled);
  }
  for (int j = 0; j < MAX_LIGHTS; j++) {
    int i = j + coneCount;
    if (i >= uLightCount) break;
    vec4 posInt = texelFetch(uLightData, ivec2(i, 0), 0);
    if (posInt.z <= 0.0) continue;
    vec4 col = texelFetch(uLightData, ivec2(i, 1), 0);
    vec3 toLight = vec3(posInt.xy, col.a) - p;
    float d = length(toLight);
    float cosine = (dot(n, toLight) / max(d, 0.001) + uFaceLight.y) / (1.0 + uFaceLight.y);
    if (cosine <= 0.0 && !both) continue;
    // The source's height is folded into I' and the colour (I' = I + h²): I / (I + d²) = k I' / (I' - h² + d²).
    float scaled = DISTANCE_SCALE * DISTANCE_SCALE;
    float intensityScaled = posInt.z * scaled;
    float lampVis = 1.0;
    float lampSelf = 1.0;
// #if LAMPMAP
    lampVis = lampVisibility(p, posInt.xy, col.a, posInt.w, posInt.z, selfId, i);
    cosine *= lampVis;
// #if SELFSHADOW
    // DX-SELFSHADOW (F8): a lamp with a tile in the lamps' map steps over the face map towards it too, unless the pixel is
    // of the lamp's own entity (a lamp post's own top, a car's own headlights).
    bool lampOwn = selfId > 0.5 && abs(lampOwner(posInt.w) - selfId) < 0.5;
    // Only inside the lamp's radius (its tile's reach: I' = (radius / 10)² + h²): past it the lamp gives under
    // 1 % of its light and its map casts nothing, while the steps cost what they cost near it (E-365: with 32 lamps they were
    // 96 % of the pass).
    vec2 fromLamp = p.xy - posInt.xy;
    bool lampNear = dot(fromLamp, fromLamp) < 100.0 * max(posInt.z - col.a * col.a, 0.0);
    if (posInt.w < 0.0 && selfOn && !lampOwn && !isFlat && lampNear && cosine > 0.05) {
      lampSelf = selfShadowToward(p, toLight / max(d, 0.001), d, selfId);
    }
    if (cosine > 0.05) cosine *= lampSelf;
// #endif SELFSHADOW
// #endif LAMPMAP
    // The light ends at its radius (reachWindow), and its shadows fade out with it.
    float win = reachWindow(dot(toLight.xy, toLight.xy), posInt.z, col.a);
    if (cosine > 0.0) {
      total += col.rgb * cosine * win * uFaceLight.z * intensityScaled
        / (intensityScaled + (d * d - col.a * col.a) * scaled);
    }
    if (both) lampFlat += col.rgb * (lampVis * lampSelf * win) * uFaceLight.z * intensityScaled / (intensityScaled + (d * d - col.a * col.a) * scaled);
  }
  if (!both) return total;
  vec3 totalFlat = vec3(uBaseAmbient) + vec3(uNightR, uNightG, uNightB) + vec3(uSunR, uSunG, uSunB) * uSunIntensity * sunFlat
    + lampFlat;
  if (isFlat) return totalFlat;
  float k = clamp(dot(lampFlat, vec3(1.0)) / max(dot(totalFlat, vec3(1.0)), 0.0001), 0.0, 1.0);
  return mix(totalFlat, total, k);
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
// #if PIXELART
  // DX-PIXELSHADOW (lighting.pixelArt): every term at the art pixel's centre, so a pixel of the world is lit or shaded
  // whole and the shadows follow the art's grid, as a pixel-art picture scaled up with nearest is.
  fragWorld = floor(fragWorld) + 0.5;
// #endif PIXELART
// #if FACES
  vec4 face = textureLod(uFaceMap, gl_FragCoord.xy / uViewport, 0.0);
  // DX-EMISSIVE (F10): a glowing pixel keeps its own colour (the face pass's (1/255, 0)).
  if (face.r > 0.0 && face.g < 0.5 / 255.0) {
    finalColor = vec4(1.0);
    return;
  }
  if (face.r > 0.0) {
    // DX-GBUF: the pixel's entity and whether it shades itself (a pixel of no entity does, as every height did before).
    float selfId = 0.0;
    bool selfOn = true;
// #if IDS
    vec4 ids = textureLod(uFaceIds, gl_FragCoord.xy / uViewport, 0.0);
    selfId = floor(ids.r * 255.0 + 0.5) * 256.0 + floor(ids.g * 255.0 + 0.5);
    selfOn = selfId < 0.5 || mod(floor(ids.b * 255.0 + 0.5), 2.0) > 0.5;
// #endif IDS
    finalColor = vec4(min(faceLight(fragWorld, face, selfId, selfOn), vec3(1.0)), 1.0);
    return;
  }
// #endif FACES
  fragWorld.y *= uGroundInvScaleY;
  vec3 totalLight = vec3(uBaseAmbient);
  vec3 sunColor = vec3(uSunR, uSunG, uSunB);
// #if SUNMAP
  totalLight += sunColor * uSunIntensity * sunVisibility(vec3(fragWorld, 0.0), 0.0);
// #endif SUNMAP
// #if !SUNMAP
  totalLight += sunColor * uSunIntensity;
// #endif !SUNMAP
  totalLight += vec3(uNightR, uNightG, uNightB);

  // The cones first (each times its cone), then every other light as before.
  int coneCount = int(uConeCount);
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= coneCount) break;
    vec4 posInt = texelFetch(uLightData, ivec2(i, 0), 0);
    if (posInt.z <= 0.0) continue;
    vec4 col = texelFetch(uLightData, ivec2(i, 1), 0);
    vec4 cone = texelFetch(uLightData, ivec2(i, 2), 0);
    const float DISTANCE_SCALE = 1.0 / 1024.0;
    vec2 deltaScaled = (fragWorld - posInt.xy) * DISTANCE_SCALE;
    float d2Scaled = dot(deltaScaled, deltaScaled);
    float intensityScaled = posInt.z * DISTANCE_SCALE * DISTANCE_SCALE;
    float attenuation = intensityScaled / (intensityScaled + d2Scaled)
      * reachWindow(dot(fragWorld - posInt.xy, fragWorld - posInt.xy), posInt.z, col.a);
// #if LAMPMAP
    attenuation *= lampVisibilityFloor(fragWorld, posInt.xy, col.a, posInt.w, posInt.z, i);
// #endif LAMPMAP
    totalLight += col.rgb * attenuation * coneFactor(deltaScaled, cone);
  }

  for (int j = 0; j < MAX_LIGHTS; j++) {
    int i = j + coneCount;
    if (i >= uLightCount) break;

    vec4 posInt = texelFetch(uLightData, ivec2(i, 0), 0);
    vec4 col = texelFetch(uLightData, ivec2(i, 1), 0);

    vec2 lightWorld = posInt.xy;
    float intensity = posInt.z;
    vec3 color = col.rgb;

    if (intensity > 0.0) {
      const float DISTANCE_SCALE = 1.0 / 1024.0;
      vec2 deltaScaled = (fragWorld - lightWorld) * DISTANCE_SCALE;
      float d2Scaled = dot(deltaScaled, deltaScaled);
      float intensityScaled = intensity * DISTANCE_SCALE * DISTANCE_SCALE;
      float attenuation = intensityScaled / (intensityScaled + d2Scaled)
        * reachWindow(dot(fragWorld - lightWorld, fragWorld - lightWorld), intensity, col.a);
// #if LAMPMAP
      attenuation *= lampVisibilityFloor(fragWorld, lightWorld, col.a, posInt.w, intensity, i);
// #endif LAMPMAP
      totalLight += color * attenuation;
    }
  }

  if (uShadowComposite > 0.5) {
    vec4 sh = textureLod(uShadowMap, normCoord, 0.0);
    totalLight *= (1.0 - sh.a);
  }
  totalLight = min(totalLight, vec3(1.0));
  finalColor = vec4(totalLight, 1.0);
}
