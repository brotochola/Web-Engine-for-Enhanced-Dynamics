precision mediump float;

varying vec2 vTextureCoord;
uniform sampler2D uTexture;

uniform float uThreshold;
uniform vec3 uWaterColor;

void main() {
    vec4 acc = texture2D(uTexture, vTextureCoord);
    float density = acc.a;

    // Metaball isosurface edge
    float edge = smoothstep(uThreshold - 0.03, uThreshold + 0.03, density);

    // Recover the average sprite color from the additive accumulation.
    // If balls are white this is ~(1,1,1); colored balls keep their tints.
    vec3 spriteColor = density > 0.001 ? acc.rgb / density : vec3(1.0);

    // Density-based depth gradient: shallow edges are brighter,
    // dense overlap areas look deeper/richer.
    float depth = smoothstep(uThreshold, uThreshold + 0.6, density);
    vec3 shallow = uWaterColor * 1.3;
    vec3 deep    = uWaterColor * 0.45;
    vec3 waterGradient = mix(shallow, deep, depth);

    gl_FragColor = vec4(spriteColor * waterGradient * edge, edge);
}
