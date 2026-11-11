precision mediump float;

// Sun Street's vignette, a LAYER_KIND.SCREEN pass after the grading: the corners darker by uAmount, round on any
// canvas (uCanvasSize is one of the engine's look uniforms).
varying vec2 vTextureCoord;
uniform sampler2D uTexture;
uniform float uAmount;
uniform vec2 uCanvasSize;

void main() {
    vec4 c = texture2D(uTexture, vTextureCoord);
    vec2 d = vTextureCoord - 0.5;
    d.x *= uCanvasSize.x / max(uCanvasSize.y, 1.0);
    float v = 1.0 - uAmount * smoothstep(0.3, 0.95, length(d));
    gl_FragColor = vec4(c.rgb * v, c.a);
}
