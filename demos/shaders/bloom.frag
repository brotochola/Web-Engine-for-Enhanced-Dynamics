precision mediump float;

varying vec2 vTextureCoord;
uniform sampler2D uTexture;

uniform float uThreshold;
uniform float uIntensity;
uniform float uBlurSize;     // StackBlur radius in pixels (1–8)
uniform vec2 uTexelSize;     // 1/rtWidth, 1/rtHeight (injected by pixi_worker)

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const int STACKBLUR_MAX_R = 8;
const int PAIR_TAPS = 4; // STACKBLUR_MAX_R / 2: texel pairs each side of the centre

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

// One of the 9 taps that cover a 17-texel row of the kernel: tap 0 is the centre texel; tap k (1 to 4 each side)
// reads texels 2k-1 and 2k at once, at the point between them where their weights split, so the texture's linear
// filter returns their weighted average in one fetch. Returns (weight, offset in texels).
vec2 pairTap(float k, float rad) {
    float ak = abs(k);
    if (ak < 0.5) return vec2(rad + 1.0, 0.0);
    float a = 2.0 * ak - 1.0;
    float b = 2.0 * ak;
    float wa = triWeight(a, rad);
    float wb = triWeight(b, rad);
    float w = wa + wb;
    float o = w > 0.0 ? (a * wa + b * wb) / w : 0.0;
    return vec2(w, sign(k) * o);
}

// The whole 2D triangular kernel ((2 x 8 + 1)^2 = 289 texels) in 9 x 9 = 81 bilinear fetches (E-450: the 289-fetch
// loop took 11 ms of GPU a frame at 1080p). The colour of each 2 x 2 group is exact; the bright extract then runs on
// the group's average instead of on each texel, which a blur this wide does not show.
vec3 stackBlurHV(vec2 uv, vec2 px, float rad) {
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int j = -PAIR_TAPS; j <= PAIR_TAPS; j++) {
        vec2 ty = pairTap(float(j), rad);
        if (ty.x <= 0.0) continue;
        for (int i = -PAIR_TAPS; i <= PAIR_TAPS; i++) {
            vec2 tx = pairTap(float(i), rad);
            if (tx.x <= 0.0) continue;
            float w = tx.x * ty.x;
            acc += brightAt(uv + vec2(tx.y, ty.y) * px) * w;
            wsum += w;
        }
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
