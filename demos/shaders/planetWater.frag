precision mediump float;

varying vec2 vTextureCoord;
uniform sampler2D uTexture;

uniform float uCutoff;
uniform float uRim;
uniform float uDepth;
uniform float uBodyAlpha;
uniform float uEdgeAlpha;

void main() {
    float dens = texture2D(uTexture, vTextureCoord).a;
    if (dens < uCutoff) discard;

    vec3 rimCol = vec3(0.82, 0.94, 1.0);
    if (dens < uRim) {
        float t = smoothstep(uCutoff, uRim, dens);
        float a = mix(uEdgeAlpha * 0.45, uEdgeAlpha, t);
        gl_FragColor = vec4(mix(rimCol, vec3(0.45, 0.75, 0.98), t), a);
        return;
    }

    float depth = smoothstep(uRim, uRim + max(uDepth, 0.001), dens);
    vec3 edgeCol = vec3(0.35, 0.72, 0.98);
    vec3 midCol = vec3(0.08, 0.38, 0.82);
    vec3 coreCol = vec3(0.02, 0.10, 0.38);
    vec3 col = mix(mix(edgeCol, midCol, depth), coreCol, depth * depth);
    float a = mix(uEdgeAlpha, uBodyAlpha, depth);
    gl_FragColor = vec4(col, a);
}
