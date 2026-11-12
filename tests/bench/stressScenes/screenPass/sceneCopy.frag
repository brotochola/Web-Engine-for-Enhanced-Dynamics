precision mediump float;

// DX-POST measurement pass: uScene, the frame before the first pass, whatever the passes before did.
varying vec2 vTextureCoord;
uniform sampler2D uTexture;
uniform sampler2D uScene;

void main() {
    gl_FragColor = texture2D(uScene, vTextureCoord);
}
