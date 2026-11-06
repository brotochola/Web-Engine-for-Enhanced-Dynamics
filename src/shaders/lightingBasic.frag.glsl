precision highp float;

uniform vec2 uCameraPos;
uniform float uZoom;
uniform vec2 uViewport;
uniform vec2 uFullCanvasSize;
uniform vec2 uCameraRot;

uniform sampler2D uLightData;
uniform float uLightTexWidth;
uniform int uLightCount;
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

// #if FACES
// DX-FACES: this pixel's face, in the face map, drawn at this pass's size.
uniform sampler2D uFaceMap;
uniform vec4 uFaceLight; // heightScaleY, wrap, gain, sunDirect
uniform vec4 uFaceSun; // towards the sun in the floor's space; w: 1 / its height, so a flat surface reads as the floor

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
  vec3 total = vec3(uBaseAmbient) + vec3(uNightR, uNightG, uNightB);
  total += vec3(uSunR, uSunG, uSunB) * uSunIntensity * (1.0 - uFaceLight.w + uFaceLight.w * sunDirect);
  const float DISTANCE_SCALE = 1.0 / 1024.0;
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;
    float u = (float(i) + 0.5) / uLightTexWidth;
    vec4 posInt = texture2D(uLightData, vec2(u, 0.25));
    if (posInt.z <= 0.0) continue;
    vec4 col = texture2D(uLightData, vec2(u, 0.75));
    vec3 toLight = vec3(posInt.xy, col.a) - p;
    float d = length(toLight);
    float cosine = (dot(n, toLight) / max(d, 0.001) + uFaceLight.y) / (1.0 + uFaceLight.y);
    if (cosine <= 0.0) continue;
    // The source's height is folded into I' and the colour (I' = I + h²): I / (I + d²) = k I' / (I' - h² + d²).
    float scaled = DISTANCE_SCALE * DISTANCE_SCALE;
    float intensityScaled = posInt.z * scaled;
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
  totalLight += sunColor * uSunIntensity;
  totalLight += vec3(uNightR, uNightG, uNightB);

  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;

    float u = (float(i) + 0.5) / uLightTexWidth;
    vec4 posInt = texture2D(uLightData, vec2(u, 0.25));
    vec4 col = texture2D(uLightData, vec2(u, 0.75));

    vec2 lightWorld = posInt.xy;
    float intensity = posInt.z;
    vec3 color = col.rgb;

    if (intensity > 0.0) {
      const float DISTANCE_SCALE = 1.0 / 1024.0;
      vec2 deltaScaled = (fragWorld - lightWorld) * DISTANCE_SCALE;
      float d2Scaled = dot(deltaScaled, deltaScaled);
      float intensityScaled = intensity * DISTANCE_SCALE * DISTANCE_SCALE;
      float attenuation = intensityScaled / (intensityScaled + d2Scaled);
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
