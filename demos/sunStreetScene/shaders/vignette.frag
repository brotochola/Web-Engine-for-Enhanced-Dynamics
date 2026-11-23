precision mediump float;

// Sun Street's vignette, a pointwise LAYER_KIND.SCREEN pass after the grading: the corners darker by uAmount, round on any
// canvas (uCanvasSize is one of the engine's look uniforms).
uniform float uAmount;
uniform vec2 uCanvasSize;

vec4 weedPass(vec4 color, vec2 uv) {
    vec2 d = uv - 0.5;
    d.x *= uCanvasSize.x / max(uCanvasSize.y, 1.0);
    float v = 1.0 - uAmount * smoothstep(0.3, 0.95, length(d));
    return vec4(color.rgb * v, color.a);
}
