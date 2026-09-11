precision mediump float;

varying vec2 vTextureCoord;
uniform sampler2D uTexture;

uniform float uCutoff;
uniform float uRimWidth;
uniform vec3 uRimColor;
uniform float uRimAlpha;

void main() {
    vec4 c = texture2D(uTexture, vTextureCoord);
    if (c.a < uCutoff) discard;

    float aL = texture2D(uTexture, vTextureCoord + vec2(-uRimWidth, 0.0)).a;
    float aR = texture2D(uTexture, vTextureCoord + vec2(uRimWidth, 0.0)).a;
    float aT = texture2D(uTexture, vTextureCoord + vec2(0.0, -uRimWidth)).a;
    float aB = texture2D(uTexture, vTextureCoord + vec2(0.0, uRimWidth)).a;
    float edge = step(aL, uCutoff) + step(aR, uCutoff) + step(aT, uCutoff) + step(aB, uCutoff);
    vec3 rgb = mix(c.rgb, uRimColor, min(edge, 1.0) * uRimAlpha);
    gl_FragColor = vec4(rgb, c.a);
}
