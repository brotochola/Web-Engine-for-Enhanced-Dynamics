// explosionField.frag – look shader for the explosionField layer.
//
// The layer draws every field puff additively into uTexture, one texel per
// world pixel. Each channel is an amount: red = heat, green = smoke,
// blue = dust (see fieldColor() in explosions.js). This shader turns those
// amounts into pixel art:
//   - each amount picks a color band from the palette (7 fire, 5 smoke, 4 dust),
//   - a 4×4 Bayer pattern dithers the band edges,
//   - the slope of each amount lights it from uLightDirection,
//   - thin smoke gets a dark outline, and smoke glows where hidden fire is,
//   - shockwave rings shift whole pixels, and blast lights lift smoke and dust, as on the ground (blastGround.js).
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 vTextureCoord;
uniform sampler2D uTexture;

// Set by the engine every frame
uniform vec2 uCanvasSize;
uniform vec2 uCameraPos;        // world position of the view's top-left
uniform vec2 uViewSize;         // the view in world px

// The ground's lights and shockwaves (blastGround.js), in world px
uniform vec4 uLight0; uniform vec4 uLight1; uniform vec4 uLight2; uniform vec4 uLight3;
uniform vec4 uLight4; uniform vec4 uLight5; uniform vec4 uLight6; uniform vec4 uLight7; // x, y, radius, intensity
uniform vec4 uWave0; uniform vec4 uWave1; uniform vec4 uWave2; uniform vec4 uWave3;
uniform vec4 uWave4; uniform vec4 uWave5;                                                 // x, y, ring radius, strength

// Layer uniforms (explosionLayers() in explosions.js)
uniform float uLayerResolution; // the layer's resolution, to find texel size
uniform float uFieldScale;      // puffs were written at 1/uFieldScale of their strength
uniform float uDither;          // 0 = hard band edges, 1 = full dither
uniform float uOutline;         // 1 = dark outline on thin smoke
uniform vec2 uLightDirection;   // where the light comes from, screen space
uniform float uShowField;       // 1 = show the raw amounts instead (debug)
uniform vec3 uFire0; uniform vec3 uFire1; uniform vec3 uFire2; uniform vec3 uFire3;
uniform vec3 uFire4; uniform vec3 uFire5; uniform vec3 uFire6;
uniform vec3 uSmoke0; uniform vec3 uSmoke1; uniform vec3 uSmoke2; uniform vec3 uSmoke3; uniform vec3 uSmoke4;
uniform vec3 uDust0; uniform vec3 uDust1; uniform vec3 uDust2; uniform vec3 uDust3;

// 4×4 ordered dither, -0.47..0.47
float bayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }

vec3 fireColor(float heat) {
  return heat > 0.86 ? uFire6 : heat > 0.68 ? uFire5 : heat > 0.52 ? uFire4 : heat > 0.38 ? uFire3
       : heat > 0.26 ? uFire2 : heat > 0.16 ? uFire1 : uFire0;
}
vec3 smokeColor(float shade) {
  return shade < 0.2 ? uSmoke0 : shade < 0.4 ? uSmoke1 : shade < 0.6 ? uSmoke2 : shade < 0.8 ? uSmoke3 : uSmoke4;
}
vec3 dustColor(float shade) {
  return shade < 0.25 ? uDust0 : shade < 0.5 ? uDust1 : shade < 0.75 ? uDust2 : uDust3;
}

vec3 amountsAt(vec2 uv) { return texture2D(uTexture, uv).rgb * uFieldScale; }

// A shockwave's push at world px p: along the ring, falling off a few pixels either side.
vec2 wavePush(vec4 w, vec2 p) {
  if (w.w <= 0.0) return vec2(0.0);
  vec2 dv = (p - w.xy) * vec2(1.0, 1.18);
  float d = length(dv);
  float k = (d - w.z) / 5.0;
  return (dv / max(d, 0.001)) * w.w * exp(-k * k);
}

float lightAt(vec4 l, vec2 p) {
  if (l.w <= 0.0 || l.z <= 0.0) return 0.0;
  float q = max(0.0, 1.0 - length((p - l.xy) * vec2(1.0, 1.18)) / l.z);
  return l.w * q * q;
}

void main() {
  vec2 texels = max(uCanvasSize * uLayerResolution, vec2(1.0));
  vec2 texel = 1.0 / texels;
  vec2 pixel = floor(vTextureCoord * texels);
  float dither = bayer4(pixel) - 0.46875;

  // The texel's world pixel: shockwaves shift the field there, and lights lift its smoke and dust.
  vec2 world = floor(uCameraPos + (pixel + 0.5) * texel * uViewSize);
  vec2 push = wavePush(uWave0, world) + wavePush(uWave1, world) + wavePush(uWave2, world) + wavePush(uWave3, world)
            + wavePush(uWave4, world) + wavePush(uWave5, world);
  float lit = lightAt(uLight0, world) + lightAt(uLight1, world) + lightAt(uLight2, world) + lightAt(uLight3, world)
            + lightAt(uLight4, world) + lightAt(uLight5, world) + lightAt(uLight6, world) + lightAt(uLight7, world);
  float groundLight = floor(clamp(lit + dither * 0.3, 0.0, 1.25) * 4.0) / 4.0;
  vec2 uv = (pixel - floor(push * texels / uViewSize + 0.5) + 0.5) * texel;

  vec3 here = amountsAt(uv);
  if (uShowField > 0.5) { gl_FragColor = vec4(clamp(here * 0.5, 0.0, 1.0), 1.0); return; }

  // Slope of each amount, three texels apart, lit from uLightDirection.
  vec3 left = amountsAt(uv - vec2(3.0 * texel.x, 0.0));
  vec3 right = amountsAt(uv + vec2(3.0 * texel.x, 0.0));
  vec3 up = amountsAt(uv - vec2(0.0, 3.0 * texel.y));
  vec3 down = amountsAt(uv + vec2(0.0, 3.0 * texel.y));
  vec2 light = normalize(uLightDirection);
  float heat = here.r, smoke = here.g, dust = here.b;
  float heatLight = clamp(dot(-vec2(right.r - left.r, down.r - up.r), light) * 1.4, -0.3, 0.3);
  float smokeLight = clamp(dot(-vec2(right.g - left.g, down.g - up.g), light) / (0.3 + smoke) * 1.05, -0.4, 0.4);
  float dustLight = clamp(dot(-vec2(right.b - left.b, down.b - up.b), light) / (0.25 + dust) * 1.6, -0.5, 0.5);

  vec3 color = vec3(0.0);
  float alpha = 0.0;

  // Dust, at the bottom
  float dustEdge = dust + dither * uDither * 0.28;
  if (dustEdge > 0.13) {
    float shade = clamp(0.58 + dustLight - (min(dust, 1.2) - 0.13) * 0.4 + dither * uDither * 0.3 + groundLight * 0.15, 0.0, 0.999);
    color = dustColor(shade);
    if (uOutline > 0.5 && dustEdge < 0.17) color = uDust0;
    alpha = 1.0;
  }

  // Smoke over the dust
  float smokeEdge = smoke + dither * uDither * 0.3;
  if (smokeEdge > 0.14) {
    float shade = clamp(0.47 + smokeLight - (min(smoke, 1.2) - 0.14) * 0.22 + dither * uDither * 0.32 + groundLight * 0.18, 0.0, 0.999);
    vec3 smokeTone = smokeColor(shade);
    if (uOutline > 0.5 && smokeEdge < 0.185) smokeTone = uSmoke0;
    // Fire hidden inside the smoke glows through its shadow side.
    float glow = smoothstep(0.06, 0.32, heat + dither * 0.06);
    if (glow > 0.0 && shade < 0.16 + glow * 0.3) smokeTone = glow > 0.55 ? uFire1 : uFire0;
    color = smokeTone;
    alpha = 1.0;
  }

  // Fire on top, unless thick smoke covers it
  float heatEdge = heat + heatLight * 0.12 + dither * uDither * 0.12;
  if (heatEdge > 0.08 && (heatEdge > smoke * 0.45 || heatEdge > 0.3)) {
    color = fireColor(heatEdge);
    alpha = 1.0;
  }

  gl_FragColor = vec4(color * alpha, alpha);
}
