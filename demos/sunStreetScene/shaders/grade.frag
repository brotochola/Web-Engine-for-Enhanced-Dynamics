precision mediump float;

// Sun Street's grading, a pointwise LAYER_KIND.SCREEN pass over the whole frame: warmer at golden hour, cooler and less
// saturated at night. uWarm and uNight (0 to 1) come from the scene's update, by the hour. The engine reads the frame
// and writes the colour: the vignette after it runs in the same draw.
uniform float uWarm;
uniform float uNight;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec4 weedPass(vec4 color, vec2 uv) {
    vec3 rgb = color.rgb;
    vec3 warm = rgb * vec3(1.10, 0.96, 0.78);
    warm = mix(warm, warm * warm * 1.3, 0.2);
    rgb = mix(rgb, warm, uWarm);
    float l = dot(rgb, LUMA);
    vec3 night = mix(vec3(l), rgb, 0.55) * vec3(0.80, 0.92, 1.15) + vec3(0.0, 0.008, 0.025);
    rgb = mix(rgb, night, uNight);
    return vec4(rgb, color.a);
}
