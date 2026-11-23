precision mediump float;

// The platformer's bloom, second of two passes: bloomRows' picture blurred along y and added to the layer's picture.

varying vec2 vTextureCoord;
uniform sampler2D uTexture;  // what bloomRows drew
uniform sampler2D uSource;   // the layer's picture, which bloomRows read

uniform float uIntensity;
uniform float uBlurSize;     // StackBlur radius in pixels (1 to 8)
uniform vec2 uTexelSize;     // the engine's: one over uTexture's size in texels
uniform vec2 uCanvasSize;    // the engine's: the layer's picture is the canvas's size

const int STACKBLUR_MAX_R = 8;
const int PAIR_TAPS = 4; // STACKBLUR_MAX_R / 2: texel pairs each side of the centre

float triWeight(float i, float rad) {
    return max(rad + 1.0 - abs(i), 0.0);
}

// As bloomRows': two texels a fetch.
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
    // The rows may be drawn at less than the layer's size (shader.passes' resolution): the radius in their texels.
    float texelPx = max(uTexelSize.y * uCanvasSize.y, 1.0);
    float rad = max(clamp(floor(uBlurSize + 0.5), 1.0, float(STACKBLUR_MAX_R)) / texelPx, 1.0);
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int j = -PAIR_TAPS; j <= PAIR_TAPS; j++) {
        vec2 t = pairTap(float(j), rad);
        if (t.x <= 0.0) continue;
        acc += texture2D(uTexture, vTextureCoord + vec2(0.0, t.y * uTexelSize.y)).rgb * t.x;
        wsum += t.x;
    }
    vec4 scene = texture2D(uSource, vTextureCoord);
    gl_FragColor = vec4(scene.rgb + acc / max(wsum, 0.001) * uIntensity, scene.a);
}
