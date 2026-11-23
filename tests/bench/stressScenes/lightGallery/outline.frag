precision mediump float;

// DX-GBUFSHADER's example, a LAYER_KIND.SCREEN pass: a dark line where the entity under a pixel changes, read from the
// frame's G-buffer (the entity ids map, uGbufIds: R * 256 + G the entity, A 1 where written; uGbufSize its texels),
// read at gbufUv(uv), the engine's: the G-buffer's uv for a screen uv.
varying vec2 vTextureCoord;
uniform sampler2D uTexture;
uniform sampler2D uGbufIds;
uniform vec2 uGbufSize;

float entityAt(vec2 uv) {
    vec4 t = texture2D(uGbufIds, gbufUv(uv));
    return t.a > 0.5 ? floor(t.r * 255.0 + 0.5) * 256.0 + floor(t.g * 255.0 + 0.5) : 0.0;
}

void main() {
    vec4 c = texture2D(uTexture, vTextureCoord);
    if (uGbufSize.x < 1.0) {
        gl_FragColor = c;
        return;
    }
    vec2 texel = 1.0 / uGbufSize;
    float here = entityAt(vTextureCoord);
    float edge = step(0.5, abs(entityAt(vTextureCoord + vec2(texel.x, 0.0)) - here));
    edge = max(edge, step(0.5, abs(entityAt(vTextureCoord + vec2(0.0, texel.y)) - here)));
    gl_FragColor = vec4(c.rgb * (1.0 - 0.8 * edge), c.a);
}
