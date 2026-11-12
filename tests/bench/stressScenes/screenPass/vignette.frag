precision mediump float;

// DX-POST measurement pass: the frame below, darkened toward the corners by uAmount (0 = a copy).
varying vec2 vTextureCoord;
uniform sampler2D uTexture;
uniform float uAmount;

void main() {
    vec4 c = texture2D(uTexture, vTextureCoord);
    vec2 d = vTextureCoord - 0.5;
    float v = 1.0 - uAmount * dot(d, d) * 2.0;
    gl_FragColor = vec4(c.rgb * v, c.a);
}
