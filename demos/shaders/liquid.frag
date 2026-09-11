precision mediump float;

varying vec2 vTextureCoord;
uniform sampler2D uTexture;

uniform float uCutoff;
uniform float uFoam;
uniform float uDepth;
uniform float uBodyAlpha;
uniform float uEdgeAlpha;

void main() {
    vec4 sample = texture2D(uTexture, vTextureCoord);
    float dens = sample.a;

    if (dens < uCutoff) discard;

    if (dens < uFoam) {
        gl_FragColor = vec4(1.0);
        return;
    }

    // Soft depth: bright cyan near foam, deep navy in dense core.
    float depth = smoothstep(uFoam, uFoam + max(uDepth, 0.001), dens);
    vec3 edgeCol = sample.rgb * vec3(0.85, 1.05, 1.35);
    vec3 coreCol = sample.rgb * vec3(0.35, 0.55, 1.05);
    vec3 col = mix(edgeCol, coreCol, depth);
    float a = mix(uEdgeAlpha, uBodyAlpha, depth);

    gl_FragColor = vec4(col, a);
}
