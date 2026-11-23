precision mediump float;

// The platformer's bloom, first of two passes: what is bright in the layer's picture, blurred along x.
// bloomColumns blurs it along y and adds it to the picture.

varying vec2 vTextureCoord;
uniform sampler2D uTexture;  // the layer's picture

uniform float uThreshold;
uniform float uBlurSize;     // StackBlur radius in pixels (1 to 8)
uniform vec2 uTexelSize;     // the engine's: one over uTexture's size in texels

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const int STACKBLUR_MAX_R = 8;
const int PAIR_TAPS = 4; // STACKBLUR_MAX_R / 2: texel pairs each side of the centre

vec3 extractBright(vec3 c) {
    float b = dot(c, LUMA);
    float knee = max(uThreshold * 0.35, 0.005);
    float w = smoothstep(uThreshold - knee, uThreshold + knee, b);
    float excess = max(b - uThreshold, 0.0) / max(b, 0.001);
    return c * w * excess;
}

// The kernel's shape (a triangle, as StackBlur's: radius + 1 - |i|).
float triWeight(float i, float rad) {
    return max(rad + 1.0 - abs(i), 0.0);
}

// One of the 9 taps that cover 17 texels: tap 0 is the centre texel; tap k (1 to 4 each side) reads texels 2k-1 and 2k
// at once, at the point between them where their weights split, so the texture's linear filter returns their weighted
// average in one fetch. Returns (weight, offset in texels).
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

void main() {
    float rad = clamp(floor(uBlurSize + 0.5), 1.0, float(STACKBLUR_MAX_R));
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int i = -PAIR_TAPS; i <= PAIR_TAPS; i++) {
        vec2 t = pairTap(float(i), rad);
        if (t.x <= 0.0) continue;
        acc += extractBright(texture2D(uTexture, vTextureCoord + vec2(t.y * uTexelSize.x, 0.0)).rgb) * t.x;
        wsum += t.x;
    }
    gl_FragColor = vec4(acc / max(wsum, 0.001), 1.0);
}
