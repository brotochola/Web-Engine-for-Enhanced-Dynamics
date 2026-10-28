// GPU particles (LAYER_KIND.GPU_PARTICLES): every frame each particle is computed from its spawn record and its
// age, nothing is uploaded but new records. src/util/gpuParticleEval.js is the same math in JS; the record layout
// is src/util/gpuParticleLayout.js (GPU_REC).
in vec2 aQuad;      // corner, 0..1
in vec4 aMove;      // x0, y0, vx, vy                    (px, px/frame)
in vec4 aHeight;    // z0, vz, gravity, drag             (px, px/frame, px/frame^2, 1/frame)
in vec4 aTime;      // birth, life (ms on the ring's epoch), rotFrom, rotTo (rad)
in vec4 aScale;     // scaleX from, to, scaleY from, to
in vec4 aColor;     // alpha from, to, tint from, tint to (0xRRGGBB bits)
in vec4 aSpin;      // spin from, to (rad/ms), eases + flags (bits), frames 0-1 (bits)
in vec4 aFrames;    // frames 2-3, 4-5, 6-7 (bits), reserved

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;          // the mesh's group color, premultiplied: its alpha is the layer's
uniform sampler2D uTexLut;
uniform sampler2D uAnimStart;
uniform vec4 uGpuParticles; // x: now (ms on this ring's epoch), y: pixel snap

out vec2 vLocal;
out vec4 vColor;
out vec4 vAtlasUV;

float easeOf(float t, uint id) {
  if (t <= 0.0) return 0.0;
  if (t >= 1.0) return 1.0;
  if (id == 0u) return t;
  if (id == 1u) return t * t;
  if (id == 2u) return t * (2.0 - t);
  if (id == 3u) return t < 0.5 ? 2.0 * t * t : -1.0 + (4.0 - 2.0 * t) * t;
  if (id == 4u) return t * t * t;
  if (id == 5u) { float u = t - 1.0; return u * u * u + 1.0; }
  if (id == 6u) {
    if (t < 0.5) return 4.0 * t * t * t;
    float u = 2.0 * t - 2.0;
    return (t - 1.0) * u * u + 1.0;
  }
  if (id == 7u) return pow(2.0, 10.0 * (t - 1.0));
  if (id == 8u) return 1.0 - pow(2.0, -10.0 * t);
  if (id == 9u) return t < 0.5 ? 0.5 * pow(2.0, 20.0 * t - 10.0) : 1.0 - 0.5 * pow(2.0, -20.0 * t + 10.0);
  if (id == 10u) { float s = 1.70158; return t * t * ((s + 1.0) * t - s); }
  if (id == 11u) { float s = 1.70158; float u = t - 1.0; return u * u * ((s + 1.0) * u + s) + 1.0; }
  if (id == 12u) {
    float s = 1.70158 * 1.525;
    if (t < 0.5) { float u = t * 2.0; return 0.5 * (u * u * ((s + 1.0) * u - s)); }
    float u = t * 2.0 - 2.0;
    return 0.5 * (u * u * ((s + 1.0) * u + s) + 2.0);
  }
  if (id == 13u) {
    float n1 = 7.5625;
    float d1 = 2.75;
    if (t < 1.0 / d1) return n1 * t * t;
    if (t < 2.0 / d1) { float u = t - 1.5 / d1; return n1 * u * u + 0.75; }
    if (t < 2.5 / d1) { float u = t - 2.25 / d1; return n1 * u * u + 0.9375; }
    float u = t - 2.625 / d1;
    return n1 * u * u + 0.984375;
  }
  return t;
}

// Position after t frames with acceleration a and drag d per frame (semi-implicit Euler's closed form without drag).
float travel(float p0, float v0, float a, float d, float t) {
  if (d < 1e-5) return p0 + v0 * t + a * (t * t + t) * 0.5;
  float terminal = a / d;
  return p0 + terminal * t + (v0 - terminal) * (1.0 - exp(-d * t)) / d;
}

vec3 rgbOf(uint bits) {
  return vec3(float((bits >> 16u) & 255u), float((bits >> 8u) & 255u), float(bits & 255u)) / 255.0;
}

void main() {
  vLocal = aQuad;
  vColor = vec4(0.0);
  vAtlasUV = vec4(0.0);
  float age = uGpuParticles.x - aTime.x;
  if (age < 0.0 || age >= aTime.y) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // unborn or dead: outside clip space, no fragments
    return;
  }
  uint bits = floatBitsToUint(aSpin.z);
  float lp = age / aTime.y;
  float t = age / 16.67;
  bool heighted = (bits & 0x1000000u) != 0u;
  float d = aHeight.w;
  float g = aHeight.z;
  float x = travel(aMove.x, aMove.z, 0.0, d, t);
  float y = travel(aMove.y, aMove.w, heighted ? 0.0 : g, d, t);
  float z = heighted ? min(travel(aHeight.x, aHeight.y, g, d, t), 0.0) : 0.0;

  float sx = mix(aScale.x, aScale.y, easeOf(lp, (bits >> 4u) & 15u));
  float sy = mix(aScale.z, aScale.w, easeOf(lp, (bits >> 8u) & 15u));
  if ((bits & 0x2000000u) != 0u) sx = -sx;
  if ((bits & 0x4000000u) != 0u) sy = -sy;
  float alpha = mix(aColor.x, aColor.y, easeOf(lp, bits & 15u));
  vec3 rgb = mix(rgbOf(floatBitsToUint(aColor.z)), rgbOf(floatBitsToUint(aColor.w)), easeOf(lp, (bits >> 12u) & 15u));
  float angle = mix(aTime.z, aTime.w, easeOf(lp, (bits >> 16u) & 15u))
    + mix(aSpin.x, aSpin.y, easeOf(lp, (bits >> 20u) & 15u)) * age;

  uint frames = ((bits >> 27u) & 7u) + 1u;
  uint f = min(uint(lp * float(frames)), frames - 1u);
  uint word = f < 2u ? floatBitsToUint(aSpin.w) : (f < 4u ? floatBitsToUint(aFrames.x) : (f < 6u ? floatBitsToUint(aFrames.y) : floatBitsToUint(aFrames.z)));
  int anim = int((f & 1u) == 1u ? (word >> 16u) : (word & 65535u));
  // Animation index (as CPU particles store it) -> the atlas lookup's texture id.
  ivec2 animSize = textureSize(uAnimStart, 0);
  int tid = -1;
  if (anim < animSize.x * animSize.y) tid = int(texelFetch(uAnimStart, ivec2(anim % animSize.x, anim / animSize.x), 0).r + 0.5);
  ivec2 lutSize = textureSize(uTexLut, 0);
  vec2 size = vec2(0.0);
  vec4 uv = vec4(0.0);
  vec4 trim = vec4(0.0);
  if (tid >= 0 && tid < lutSize.y) {
    vec4 t0 = texelFetch(uTexLut, ivec2(0, tid), 0);
    vec4 t1 = texelFetch(uTexLut, ivec2(1, tid), 0);
    vec4 t2 = texelFetch(uTexLut, ivec2(2, tid), 0);
    size = t0.xy;
    uv = vec4(t0.zw, t1.xy);
    trim = vec4(t1.zw, t2.xy);
  }

  vec2 center = vec2(x, y + z);
  if (uGpuParticles.y > 0.5) center = floor(center) + 0.5;
  vec2 content = trim.xy + aQuad * trim.zw;
  vec2 local = (content - 0.5 * size) * vec2(sx, sy);
  float c = cos(angle);
  float s = sin(angle);
  vec2 world = vec2(local.x * c - local.y * s, local.x * s + local.y * c) + center;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 clip = mvp * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  vColor = vec4(rgb, alpha * uColor.a);
  vAtlasUV = uv;
}
