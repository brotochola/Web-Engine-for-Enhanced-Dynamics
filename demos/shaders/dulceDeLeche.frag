precision mediump float;

varying vec2 vTextureCoord;
uniform sampler2D uTexture;

uniform float uCutoff;
uniform float uRim;
uniform float uDepth;
uniform float uBodyAlpha;
uniform float uEdgeAlpha;

void main() {
    vec4 sample = texture2D(uTexture, vTextureCoord);
    float dens = sample.a;

    if (dens < uCutoff) discard;

    // Soft cream/amber rim (no white foam).
    if (dens < uRim) {
        float t = smoothstep(uCutoff, uRim, dens);
        vec3 rimCol = mix(vec3(1.0, 0.92, 0.72), sample.rgb * vec3(1.15, 1.0, 0.75), t);
        float a = mix(uEdgeAlpha * 0.55, uEdgeAlpha, t);
        gl_FragColor = vec4(rimCol, a);
        return;
    }

    // Milk-caramel edge → burnt-sugar core.
    float depth = smoothstep(uRim, uRim + max(uDepth, 0.001), dens);
    vec3 edgeCol = sample.rgb * vec3(1.2, 1.05, 0.7);
    vec3 midCol = sample.rgb * vec3(1.05, 0.75, 0.4);
    vec3 coreCol = sample.rgb * vec3(0.55, 0.32, 0.12);
    vec3 warm = mix(edgeCol, midCol, depth);
    vec3 col = mix(warm, coreCol, depth * depth);
    float a = mix(uEdgeAlpha, uBodyAlpha, depth);

    gl_FragColor = vec4(col, a);
}
