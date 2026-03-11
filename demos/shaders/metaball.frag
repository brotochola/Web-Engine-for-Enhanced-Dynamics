precision mediump float;

varying vec2 vTextureCoord;
uniform sampler2D uTexture;

uniform float uThreshold;
uniform vec3 uWaterColor;

void main() {
    vec4 sample = texture2D(uTexture, vTextureCoord);

    // The RenderTexture accumulates additive gradient sprites.
    // sample.a holds the summed density field:
    //   - Low alpha where balls are sparse
    //   - High alpha where balls overlap
    // smoothstep creates the blobby "isosurface" edge.
    float edge = smoothstep(uThreshold - 0.05, uThreshold + 0.05, sample.a);

    // Apply water color with the thresholded alpha
    gl_FragColor = vec4(uWaterColor * edge, edge);
}
