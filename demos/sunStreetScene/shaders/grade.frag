precision mediump float;

// Sun Street's grading, a LAYER_KIND.SCREEN pass over the whole frame: warmer at golden hour, cooler and less
// saturated at night. uWarm and uNight (0 to 1) come from the scene's update, by the hour.
varying vec2 vTextureCoord;
uniform sampler2D uTexture;
uniform float uWarm;
uniform float uNight;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main() {
    vec4 c = texture2D(uTexture, vTextureCoord);
    vec3 rgb = c.rgb;
    vec3 warm = rgb * vec3(1.10, 0.96, 0.78);
    warm = mix(warm, warm * warm * 1.3, 0.2);
    rgb = mix(rgb, warm, uWarm);
    float l = dot(rgb, LUMA);
    vec3 night = mix(vec3(l), rgb, 0.55) * vec3(0.80, 0.92, 1.15) + vec3(0.0, 0.008, 0.025);
    rgb = mix(rgb, night, uNight);
    gl_FragColor = vec4(rgb, c.a);
}
