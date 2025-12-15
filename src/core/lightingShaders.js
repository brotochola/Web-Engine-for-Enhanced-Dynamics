// lightingShaders.js - Shader code for the lighting system
// Contains both GLSL (WebGL fallback) and WGSL (WebGPU) versions

/**
 * Maximum number of lights supported by shaders
 * This value is baked into shader code at compile time
 */
export const DEFAULT_MAX_LIGHTS = 128;

/**
 * Build the lighting vertex shader (GLSL for WebGL)
 */
export function buildVertexShaderGLSL() {
  return `
in vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;
}

/**
 * Build the lighting fragment shader (GLSL for WebGL)
 * @param {number} maxLights - Maximum number of lights to support
 */
export function buildFragmentShaderGLSL(maxLights = DEFAULT_MAX_LIGHTS) {
  return `
precision mediump float;

uniform vec2 uCameraPos;
uniform float uZoom;
uniform vec2 uViewport;

uniform float uLightX[${maxLights}];
uniform float uLightY[${maxLights}];
uniform float uLightIntensity[${maxLights}];
uniform float uLightR[${maxLights}];
uniform float uLightG[${maxLights}];
uniform float uLightB[${maxLights}];
uniform int uLightCount;
uniform float uAmbient;

void main() {
  // Convert fragment to WORLD SPACE
  // gl_FragCoord.y is 0 at bottom, but game Y is 0 at top - flip it
  vec2 screenPos = vec2(gl_FragCoord.x, uViewport.y - gl_FragCoord.y);
  vec2 fragWorld = (screenPos / uZoom) + uCameraPos;
  
  vec3 totalLight = vec3(uAmbient);
  
  for (int i = 0; i < ${maxLights}; i++) {
    if (i >= uLightCount) break;
    
    vec2 lightWorld = vec2(uLightX[i], uLightY[i]);
    float intensity = uLightIntensity[i];
    vec3 color = vec3(uLightR[i], uLightG[i], uLightB[i]);
    
    float d = length(fragWorld - lightWorld);
    // Formula: intensity / (intensity + d²) → caps at 1.0 when d=0, falls off with distance
    // Higher intensity = light reaches farther, but max brightness is always 1.0
    float attenuation = intensity / (intensity + d*d);
    
    totalLight += color * attenuation;
  }
  
  totalLight = min(totalLight, vec3(1.0));
  gl_FragColor = vec4(totalLight, 1.0);
}
`;
}

/**
 * Build the lighting vertex shader (WGSL for WebGPU)
 */
export function buildVertexShaderWGSL() {
  return `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

@vertex
fn main(@location(0) aPosition: vec2<f32>) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(aPosition, 0.0, 1.0);
  return output;
}
`;
}

/**
 * Build the lighting fragment shader (WGSL for WebGPU)
 * @param {number} maxLights - Maximum number of lights to support
 */
export function buildFragmentShaderWGSL(maxLights = DEFAULT_MAX_LIGHTS) {
  return `
struct Uniforms {
  cameraPos: vec2<f32>,
  zoom: f32,
  ambient: f32,
  viewport: vec2<f32>,
  lightCount: i32,
  _padding: i32,
};

struct LightData {
  x: array<f32, ${maxLights}>,
  y: array<f32, ${maxLights}>,
  intensity: array<f32, ${maxLights}>,
  r: array<f32, ${maxLights}>,
  g: array<f32, ${maxLights}>,
  b: array<f32, ${maxLights}>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> lights: LightData;

@fragment
fn main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  // Convert fragment to WORLD SPACE
  // In WebGPU, fragCoord.y is 0 at top (matches game coordinates)
  let screenPos = vec2<f32>(fragCoord.x, uniforms.viewport.y - fragCoord.y);
  let fragWorld = (screenPos / uniforms.zoom) + uniforms.cameraPos;
  
  var totalLight = vec3<f32>(uniforms.ambient, uniforms.ambient, uniforms.ambient);
  
  for (var i: i32 = 0; i < uniforms.lightCount; i++) {
    if (i >= ${maxLights}) { break; }
    
    let lightWorld = vec2<f32>(lights.x[i], lights.y[i]);
    let intensity = lights.intensity[i];
    let color = vec3<f32>(lights.r[i], lights.g[i], lights.b[i]);
    
    let d = length(fragWorld - lightWorld);
    // Formula: intensity / (intensity + d²) → caps at 1.0 when d=0, falls off with distance
    let attenuation = intensity / (intensity + d * d);
    
    totalLight += color * attenuation;
  }
  
  totalLight = min(totalLight, vec3<f32>(1.0, 1.0, 1.0));
  return vec4<f32>(totalLight, 1.0);
}
`;
}

/**
 * Shader source collection for easy access
 */
export const LightingShaders = {
  glsl: {
    vertex: buildVertexShaderGLSL,
    fragment: buildFragmentShaderGLSL,
  },
  wgsl: {
    vertex: buildVertexShaderWGSL,
    fragment: buildFragmentShaderWGSL,
  },
  DEFAULT_MAX_LIGHTS,
};

export default LightingShaders;
