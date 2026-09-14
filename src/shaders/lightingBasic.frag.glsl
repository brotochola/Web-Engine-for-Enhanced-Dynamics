precision highp float;

uniform vec2 uCameraPos;
uniform float uZoom;
uniform vec2 uViewport;
uniform vec2 uFullCanvasSize;

uniform sampler2D uLightData;
uniform float uLightTexWidth;
uniform int uLightCount;
uniform float uBaseAmbient;
uniform float uSunIntensity;
uniform float uSunR;
uniform float uSunG;
uniform float uSunB;

void main() {
  vec2 normCoord = gl_FragCoord.xy / uViewport;
  vec2 screenPos = normCoord * uFullCanvasSize;
  vec2 fragWorld = (screenPos / uZoom) + uCameraPos;
  vec3 totalLight = vec3(uBaseAmbient);
  vec3 sunColor = vec3(uSunR, uSunG, uSunB);
  totalLight += sunColor * uSunIntensity;

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

  totalLight = min(totalLight, vec3(1.0));
  gl_FragColor = vec4(totalLight, 1.0);
}
