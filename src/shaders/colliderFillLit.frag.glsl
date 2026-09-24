#version 300 es
precision highp float;
in vec4 vColor;
in vec2 vLocal;
in vec2 vWorld;
in vec4 vAtlasUV;
in vec2 vTileInv;
in vec2 vTileOff;
in float vHasTex;
in vec4 vTangent;
uniform sampler2D uTexture;
uniform sampler2D uNormalMap;
uniform sampler2D uLightData;
uniform float uLightTexWidth;
uniform int uLightCount;
uniform float uBaseAmbient;
uniform float uSunIntensity;
uniform float uSunR;
uniform float uSunG;
uniform float uSunB;
uniform vec4 uSunDir;
uniform float uNormalLightZ;
uniform float uNormalStrength;
out vec4 finalColor;

vec2 weedUv() {
  vec2 t = vLocal;
  if (vTileInv.x > 0.0) t.x = fract(vWorld.x * vTileInv.x + vTileOff.x);
  else if (vTileInv.x < 0.0) t.x = fract(vLocal.x * (-vTileInv.x) + vTileOff.x);
  if (vTileInv.y > 0.0) t.y = fract(vWorld.y * vTileInv.y + vTileOff.y);
  else if (vTileInv.y < 0.0) t.y = fract(vLocal.y * (-vTileInv.y) + vTileOff.y);
  return mix(vAtlasUV.xy, vAtlasUV.zw, t);
}

float wrapNL(vec3 n, vec3 L) {
  float denom = max(L.z, 0.0001);
  return clamp(dot(n, L) / denom, 0.0, 4.0);
}

vec3 bumpLightRatio(vec3 nWorld) {
  vec3 Lflat = vec3(uBaseAmbient);
  vec3 sunColor = vec3(uSunR, uSunG, uSunB);
  Lflat += sunColor * uSunIntensity;
  vec3 Lbump = vec3(uBaseAmbient);
  Lbump += sunColor * uSunIntensity * wrapNL(nWorld, uSunDir.xyz);

  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;
    float u = (float(i) + 0.5) / uLightTexWidth;
    vec4 posInt = texture(uLightData, vec2(u, 0.25));
    vec4 col = texture(uLightData, vec2(u, 0.75));
    float intensity = posInt.z;
    if (intensity <= 0.0) continue;
    const float DISTANCE_SCALE = 1.0 / 1024.0;
    vec2 deltaScaled = (vWorld - posInt.xy) * DISTANCE_SCALE;
    float d2Scaled = dot(deltaScaled, deltaScaled);
    float intensityScaled = intensity * DISTANCE_SCALE * DISTANCE_SCALE;
    float attenuation = intensityScaled / (intensityScaled + d2Scaled);
    vec3 L = normalize(vec3(posInt.xy - vWorld, uNormalLightZ));
    Lflat += col.rgb * attenuation;
    Lbump += col.rgb * attenuation * wrapNL(nWorld, L);
  }

  return Lbump / max(Lflat, vec3(0.0001));
}

void main() {
  if (vHasTex < 0.5) {
    if (vColor.a < 0.01) discard;
    finalColor = vec4(vColor.rgb * vColor.a, vColor.a);
    return;
  }
  vec2 uv = weedUv();
  vec4 t = texture(uTexture, uv);
  float a = t.a * vColor.a;
  if (a < 0.01) discard;
  vec3 albedo = t.rgb * vColor.rgb * vColor.a;

  vec2 nxy = texture(uNormalMap, uv).xy * 2.0 - 1.0;
  nxy *= uNormalStrength;
  if (dot(nxy, nxy) < 1e-6) {
    finalColor = vec4(albedo, a);
    return;
  }
  vec3 nLocal = normalize(vec3(nxy, 1.0));
  vec3 nWorld = normalize(vec3(
    nLocal.x * vTangent.x + nLocal.y * vTangent.z,
    nLocal.x * vTangent.y + nLocal.y * vTangent.w,
    nLocal.z
  ));
  finalColor = vec4(albedo * bumpLightRatio(nWorld), a);
}
