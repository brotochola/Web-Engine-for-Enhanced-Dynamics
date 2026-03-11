precision mediump float;

varying vec2 vTextureCoord;
uniform sampler2D uTexture;

uniform float uThreshold;
uniform vec3 uWaterColor;
uniform float uFoamIntensity;
uniform float uFoamWidth;
uniform float uSampleStep;
uniform float uOpacity;
uniform float uTime;

#define TAU 6.28318530718
#define CAUSTIC_ITER 5

vec3 causticPattern(vec2 uv, float t) {
    float time = t * 0.5 + 23.0;
    vec2 p = mod(uv * TAU, TAU) - 250.0;
    vec2 i = p;
    float c = 1.0;
    float inten = 0.005;
    for (int n = 0; n < CAUSTIC_ITER; n++) {
        float nt = time * (1.0 - (3.5 / float(n + 1)));
        i = p + vec2(cos(nt - i.x) + sin(nt + i.y), sin(nt - i.y) + cos(nt + i.x));
        c += 1.0 / length(vec2(p.x / (sin(i.x + nt) / inten), p.y / (cos(i.y + nt) / inten)));
    }
    c = c / float(CAUSTIC_ITER);
    c = 1.17 - pow(abs(c), 1.4);
    vec3 col = vec3(pow(abs(c), 8.0));
    col = clamp(col + vec3(0.0, 0.35, 0.5), 0.0, 1.0);
    return col;
}

void main() {
    vec4 acc = texture2D(uTexture, vTextureCoord);
    float density = acc.a;

    vec2 dx = vec2(uSampleStep, 0.0);
    vec2 dy = vec2(0.0, uSampleStep);
    float dL = texture2D(uTexture, vTextureCoord - dx).a;
    float dR = texture2D(uTexture, vTextureCoord + dx).a;
    float dT = texture2D(uTexture, vTextureCoord - dy).a;
    float dB = texture2D(uTexture, vTextureCoord + dy).a;

    float edge = smoothstep(uThreshold - 0.03, uThreshold + 0.03, density);

    vec3 spriteColor = density > 0.001 ? acc.rgb / density : vec3(1.0, 1.0, 1.0);

    float depth = smoothstep(uThreshold, uThreshold + 0.6, density);
    vec3 shallow = uWaterColor * 1.3;
    vec3 deep    = uWaterColor * 0.45;
    vec3 waterGradient = mix(shallow, deep, depth);

    float surfaceBand = 1.0 - smoothstep(0.0, uFoamWidth, abs(density - uThreshold));
    vec2 fieldGrad = vec2(dR - dL, dB - dT);
    float slope = length(fieldGrad);
    float laplacian = abs((dL + dR + dT + dB) - 4.0 * density);
    float foamTurb = clamp(slope * 1.8 + laplacian * 2.2, 0.0, 1.0);
    float ripple = clamp(abs((dR + dB) - (dL + dT)) * 4.0, 0.0, 1.0);
    float foam = clamp(surfaceBand * foamTurb * uFoamIntensity * mix(0.85, 1.1, ripple), 0.0, 1.0);

    vec3 caustics = causticPattern(vTextureCoord * 3.0, uTime);

    vec3 baseColor = spriteColor * waterGradient * edge;
    baseColor = mix(baseColor, baseColor * caustics * 1.8, edge * 0.4);

    vec3 waterColorOut = mix(baseColor, vec3(1.0, 1.0, 1.0), foam);

    float densityAlpha = smoothstep(0.0, uThreshold + 0.6, density);
    float alpha = clamp(edge * densityAlpha * uOpacity + foam * 0.2, 0.0, 1.0);

    finalColor = vec4(waterColorOut, alpha);
}
