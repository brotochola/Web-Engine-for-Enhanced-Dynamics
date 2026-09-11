precision mediump float;

varying vec2 vTextureCoord;
uniform sampler2D uTexture;

uniform float uThreshold;
uniform float uIntensity;
uniform float uBlurSize;     // StackBlur radius in pixels (1–8)
uniform vec2 uTexelSize;     // 1/rtWidth, 1/rtHeight (injected by pixi_worker)

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const int STACKBLUR_MAX_R = 8;

vec2 texelStep() {
    if (uTexelSize.x > 1e-6 && uTexelSize.y > 1e-6) {
        return uTexelSize;
    }
    return vec2(1.0 / 1024.0, 1.0 / 768.0);
}

float luma(vec3 c) {
    return dot(c, LUMA);
}

vec3 extractBright(vec3 c) {
    float b = luma(c);
    float knee = max(uThreshold * 0.35, 0.005);
    float w = smoothstep(uThreshold - knee, uThreshold + knee, b);
    float excess = max(b - uThreshold, 0.0) / max(b, 0.001);
    return c * w * excess;
}

vec3 brightAt(vec2 uv) {
    return extractBright(texture2D(uTexture, uv).rgb);
}

// Triangular weight — same kernel shape as StackBlur (radius+1-|i|)
float triWeight(float i, float rad) {
    return max(rad + 1.0 - abs(i), 0.0);
}

// Horizontal pass (processImageDataRGB row pass)
vec3 stackBlurH(vec2 uv, vec2 px, float rad) {
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int i = -STACKBLUR_MAX_R; i <= STACKBLUR_MAX_R; i++) {
        float fi = float(i);
        float w = triWeight(fi, rad);
        if (w <= 0.0) continue;
        acc += brightAt(uv + vec2(fi, 0.0) * px) * w;
        wsum += w;
    }
    return acc / max(wsum, 0.001);
}

// Vertical pass on horizontal result (full separable StackBlur)
vec3 stackBlurHV(vec2 uv, vec2 px, float rad) {
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int j = -STACKBLUR_MAX_R; j <= STACKBLUR_MAX_R; j++) {
        float fj = float(j);
        float w = triWeight(fj, rad);
        if (w <= 0.0) continue;
        acc += stackBlurH(uv + vec2(0.0, fj) * px, px, rad) * w;
        wsum += w;
    }
    return acc / max(wsum, 0.001);
}

void main() {
    vec4 scene = texture2D(uTexture, vTextureCoord);
    vec3 base = scene.rgb;

    float rad = clamp(floor(uBlurSize + 0.5), 1.0, float(STACKBLUR_MAX_R));
    vec3 glow = stackBlurHV(vTextureCoord, texelStep(), rad);
    glow *= uIntensity;

    gl_FragColor = vec4(base + glow, scene.a);
}
