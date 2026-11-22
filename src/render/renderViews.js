/**
 * DBG-5: render views. The debug UI's Render tab asks the Pixi worker (setRenderView) to draw one of the buffers the
 * frame is made of over the picture, decoded: the G-buffer's normals, heights, entity ids and flags, the light buffer,
 * the unshaded colours, the casted shadows and the sun's and the lamps' shadow maps. The worker keeps one integer for it
 * (Final, 0, the default); only while it is not 0 does it bind the buffer to one full-screen quad on top of the stage, made
 * on first use and released when the view goes back to Final. One decode shader serves every view (a branch on the view).
 *
 * What each buffer holds (the decode follows the light pass's, lightingBasic.frag.glsl):
 * - faceRT (faceMap.js), RGBA8 at the light pass's size: R, G the normal, octahedral, bytes 1..253 ((0, 0) no face,
 *   (1, 0) an unshaded pixel, (254, 254) a pixel lit as drawn); B·256 + A the height, 15 bits in eighths of a px, the top
 *   bit (FACE_K_BIT) a sprite's own normal.
 * - faceIdsRT (DX-GBUF): R·256 + G the entity id (0 none), B bit 0 the pixel shades itself (FACE_IDS_SELF).
 * - lightingRT, unshadedRT, shadowRT: colours, shown as drawn (the shadows on white, as the layer multiplies them).
 * - sunMapRT, lampMapRT: heights in R (the sun's map spans SUN_MAP_ZMAX px), shown as a ramp.
 *
 * Not views: the lamps' volume cache (E-508's targets hold colour and depth per lamp tile, which needs its own layout
 * view) and pixel depth (the canvas's depth cannot be sampled without a copy each frame).
 */

import { gpuStageF, gpuStageVF } from './webgpu/pixiMeshWgsl.js';

export const RENDER_VIEW = Object.freeze({
  FINAL: 0,
  NORMALS: 1,
  HEIGHT: 2,
  IDS: 3,
  FLAGS: 4,
  LIGHT: 5,
  UNSHADED: 6,
  SHADOWS: 7,
  SUN_MAP: 8,
  LAMP_MAP: 9,
});

/** The views in the Render tab's order: label, and the config that makes the buffer when a scene has none. */
export const RENDER_VIEWS = Object.freeze([
  { id: RENDER_VIEW.FINAL, label: 'Final', needs: '' },
  { id: RENDER_VIEW.NORMALS, label: 'G-buffer normals', needs: 'a decoration with a normal, or sprites with normal or height maps' },
  { id: RENDER_VIEW.HEIGHT, label: 'G-buffer height', needs: 'a decoration with a normal, or sprites with height maps' },
  { id: RENDER_VIEW.IDS, label: 'Entity ids', needs: "the G-buffer, with lighting.selfShadow, a shadow map ('map') or lighting.walls" },
  { id: RENDER_VIEW.FLAGS, label: 'G-buffer flags', needs: 'the G-buffer (as the normals view)' },
  { id: RENDER_VIEW.LIGHT, label: 'Light buffer', needs: 'lighting.enabled' },
  { id: RENDER_VIEW.UNSHADED, label: 'Unshaded', needs: 'lighting.unshaded (or an unshaded sprite)' },
  { id: RENDER_VIEW.SHADOWS, label: 'Casted shadows', needs: "lighting.shadowsEnabled with a shadows layer (sunShadows or lampShadows 'layer')" },
  { id: RENDER_VIEW.SUN_MAP, label: 'Sun shadow map', needs: "lighting.sunShadows: 'map'" },
  { id: RENDER_VIEW.LAMP_MAP, label: 'Lamp shadow atlas', needs: "lighting.lampShadows: 'map'" },
]);

/** zIndex of the view's quad: over every layer of the stage. */
export const RENDER_VIEW_Z = 1e9;
/** The height view's ramp: 0 to this many px. */
export const RENDER_VIEW_HEIGHT_PX = 256;

/**
 * The textures a view samples, from the worker's targets (null where the scene has none), into `out` ([main, second]);
 * out[0] null: the view has nothing to show now.
 * @param {{ faceRT?: object|null, faceIdsRT?: object|null, lightingRT?: object|null, unshadedRT?: object|null,
 *   shadowRT?: object|null, sunMapRT?: object|null, lampMapRT?: object|null }} w
 * @param {number} view
 * @param {Array<object|null>} out
 */
export function renderViewTextures(w, view, out) {
  out[0] = null;
  out[1] = null;
  switch (view) {
    case RENDER_VIEW.NORMALS:
    case RENDER_VIEW.HEIGHT:
      out[0] = w.faceRT ?? null;
      break;
    case RENDER_VIEW.IDS:
      out[0] = w.faceIdsRT ?? null;
      break;
    case RENDER_VIEW.FLAGS:
      out[0] = w.faceRT ?? null;
      out[1] = w.faceIdsRT ?? null;
      break;
    case RENDER_VIEW.LIGHT:
      out[0] = w.lightingRT ?? null;
      break;
    case RENDER_VIEW.UNSHADED:
      out[0] = w.unshadedRT ?? null;
      break;
    case RENDER_VIEW.SHADOWS:
      out[0] = w.shadowRT ?? null;
      break;
    case RENDER_VIEW.SUN_MAP:
      out[0] = w.sunMapRT ?? null;
      break;
    case RENDER_VIEW.LAMP_MAP:
      out[0] = w.lampMapRT ?? null;
      break;
    default:
      break;
  }
  return out;
}

/** The views the worker can draw now: Final and every one whose buffer exists. */
export function availableRenderViews(w) {
  const pair = [null, null];
  const ids = [RENDER_VIEW.FINAL];
  for (const v of RENDER_VIEWS) {
    if (v.id !== RENDER_VIEW.FINAL && renderViewTextures(w, v.id, pair)[0] !== null) ids.push(v.id);
  }
  return ids;
}

export const RENDER_VIEW_VERT = `in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vUV;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}
`;

export const RENDER_VIEW_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform sampler2D uTex2;
uniform vec4 uView; // x: the view (renderViews.js RENDER_VIEW), y: opacity, z: the height ramp's top (px), w: uTex2 bound
out vec4 finalColor;

float weedByte(float c) { return floor(c * 255.0 + 0.5); }

// Dark blue through orange to white.
vec3 weedRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  return t < 0.5 ? mix(vec3(0.05, 0.05, 0.35), vec3(1.0, 0.45, 0.05), t * 2.0) : mix(vec3(1.0, 0.45, 0.05), vec3(1.0), t * 2.0 - 1.0);
}

vec3 weedIdColor(float id) {
  vec3 p = fract(vec3(id) * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.xxy + p.yzz) * p.zyx) * 0.75 + 0.25;
}

// DBG-5: one buffer of the frame, decoded (renderViews.js says what each holds).
void main() {
  vec4 t = textureLod(uTex, vUV, 0.0);
  int view = int(uView.x + 0.5);
  float r = weedByte(t.r);
  float g = weedByte(t.g);
  bool noFace = r == 0.0 && g == 0.0;
  vec3 c = t.rgb;
  if (view == 1) {
    if (noFace) c = vec3(0.0);
    else if (r == 1.0 && g == 0.0) c = vec3(1.0, 0.0, 1.0);
    else if (r >= 254.0 && g >= 254.0) c = vec3(0.5);
    else {
      vec2 f = (vec2(r, g) - 127.0) / 126.0;
      vec3 n = vec3(f, 1.0 - abs(f.x) - abs(f.y));
      float k = max(-n.z, 0.0);
      n.x += n.x >= 0.0 ? -k : k;
      n.y += n.y >= 0.0 ? -k : k;
      c = 0.5 + 0.5 * normalize(n);
    }
  } else if (view == 2) {
    float h = mod(weedByte(t.b) * 256.0 + weedByte(t.a), 32768.0) / 8.0;
    c = noFace ? vec3(0.0) : weedRamp(h / uView.z);
  } else if (view == 3) {
    float id = r * 256.0 + g;
    c = id < 0.5 ? vec3(0.0) : weedIdColor(id);
  } else if (view == 4) {
    float q = weedByte(t.b) * 256.0 + weedByte(t.a);
    c = noFace ? vec3(0.0) : vec3(0.25);
    if (r == 1.0 && g == 0.0) c = vec3(1.0, 0.0, 1.0);
    else if (r >= 254.0 && g >= 254.0) c = vec3(0.2, 0.5, 1.0);
    else if (q >= 32768.0) c = vec3(1.0, 0.85, 0.2);
    if (uView.w > 0.5 && mod(weedByte(textureLod(uTex2, vUV, 0.0).b), 2.0) > 0.5) c.g = max(c.g, 0.85);
  } else if (view == 7) {
    c = t.rgb + vec3(1.0 - t.a);
  } else if (view == 8 || view == 9) {
    c = t.r <= 0.0 ? vec3(0.0) : weedRamp(t.r);
  }
  finalColor = vec4(c * uView.y, uView.y);
}
`;

export const RENDER_VIEW_WGSL = `struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
}
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;

struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
}
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;

struct ViewUniforms {
  uView: vec4<f32>,
}
@group(2) @binding(0) var uTex: texture_2d<f32>;
@group(2) @binding(1) var uTexSampler: sampler;
@group(2) @binding(2) var uTex2: texture_2d<f32>;
@group(2) @binding(3) var uTex2Sampler: sampler;
@group(2) @binding(4) var<uniform> viewUniforms: ViewUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUV: vec2<f32>,
}

@vertex
fn mainVert(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> VertexOut {
  var out: VertexOut;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  out.position = vec4<f32>((mvp * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0);
  out.vUV = aUV;
  return out;
}

fn weedByte(c: f32) -> f32 { return floor(c * 255.0 + 0.5); }

fn weedRamp(t0: f32) -> vec3<f32> {
  let t = clamp(t0, 0.0, 1.0);
  if (t < 0.5) { return mix(vec3<f32>(0.05, 0.05, 0.35), vec3<f32>(1.0, 0.45, 0.05), t * 2.0); }
  return mix(vec3<f32>(1.0, 0.45, 0.05), vec3<f32>(1.0), t * 2.0 - 1.0);
}

fn weedIdColor(id: f32) -> vec3<f32> {
  var p = fract(vec3<f32>(id) * vec3<f32>(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.xxy + p.yzz) * p.zyx) * 0.75 + 0.25;
}

// DBG-5: one buffer of the frame, decoded (the GLSL's twin).
@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let u = viewUniforms.uView;
  let t = textureSampleLevel(uTex, uTexSampler, in.vUV, 0.0);
  let t2 = textureSampleLevel(uTex2, uTex2Sampler, in.vUV, 0.0);
  let view = i32(u.x + 0.5);
  let r = weedByte(t.r);
  let g = weedByte(t.g);
  let noFace = r == 0.0 && g == 0.0;
  var c = t.rgb;
  if (view == 1) {
    if (noFace) { c = vec3<f32>(0.0); }
    else if (r == 1.0 && g == 0.0) { c = vec3<f32>(1.0, 0.0, 1.0); }
    else if (r >= 254.0 && g >= 254.0) { c = vec3<f32>(0.5); }
    else {
      let f = (vec2<f32>(r, g) - 127.0) / 126.0;
      var n = vec3<f32>(f, 1.0 - abs(f.x) - abs(f.y));
      let k = max(-n.z, 0.0);
      n.x += select(k, -k, n.x >= 0.0);
      n.y += select(k, -k, n.y >= 0.0);
      c = 0.5 + 0.5 * normalize(n);
    }
  } else if (view == 2) {
    let h = (weedByte(t.b) * 256.0 + weedByte(t.a)) % 32768.0 / 8.0;
    c = select(weedRamp(h / u.z), vec3<f32>(0.0), noFace);
  } else if (view == 3) {
    let id = r * 256.0 + g;
    c = select(weedIdColor(id), vec3<f32>(0.0), id < 0.5);
  } else if (view == 4) {
    let q = weedByte(t.b) * 256.0 + weedByte(t.a);
    c = select(vec3<f32>(0.25), vec3<f32>(0.0), noFace);
    if (r == 1.0 && g == 0.0) { c = vec3<f32>(1.0, 0.0, 1.0); }
    else if (r >= 254.0 && g >= 254.0) { c = vec3<f32>(0.2, 0.5, 1.0); }
    else if (q >= 32768.0) { c = vec3<f32>(1.0, 0.85, 0.2); }
    if (u.w > 0.5 && weedByte(t2.b) % 2.0 > 0.5) { c.g = max(c.g, 0.85); }
  } else if (view == 7) {
    c = t.rgb + vec3<f32>(1.0 - t.a);
  } else if (view == 8 || view == 9) {
    c = select(weedRamp(t.r), vec3<f32>(0.0), t.r <= 0.0);
  }
  return vec4<f32>(c * u.y, u.y);
}
`;

/** The view quad's WebGPU program: Pixi's mesh groups, the two textures and their samplers and the view's uniforms. */
export function renderViewGpuProgram(GpuProgram, name = 'weed-render-view') {
  const vf = gpuStageVF();
  const f = gpuStageF();
  const tex = { sampleType: 'float', viewDimension: '2d', multisampled: false };
  return GpuProgram.from({
    name,
    vertex: { source: RENDER_VIEW_WGSL, entryPoint: 'mainVert' },
    fragment: { source: RENDER_VIEW_WGSL, entryPoint: 'mainFrag' },
    layout: {
      0: { globalUniforms: 0 },
      1: { localUniforms: 0 },
      2: { uTex: 0, uTexSampler: 1, uTex2: 2, uTex2Sampler: 3, viewUniforms: 4 },
    },
    gpuLayout: [
      [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
      [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
      [
        { binding: 0, visibility: f, texture: { ...tex } },
        { binding: 1, visibility: f, sampler: { type: 'filtering' } },
        { binding: 2, visibility: f, texture: { ...tex } },
        { binding: 3, visibility: f, sampler: { type: 'filtering' } },
        { binding: 4, visibility: vf, buffer: { type: 'uniform' } },
      ],
    ],
  });
}
