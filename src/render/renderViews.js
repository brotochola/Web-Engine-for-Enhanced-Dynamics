/**
 * DBG-5: render views. The debug UI's Render tab asks the Pixi worker (setRenderView) to draw one of the buffers the
 * frame is made of over the picture, decoded: the G-buffer's normals, heights, entity ids and flags, the light buffer,
 * the unshaded colours and the sun's and the lamps' shadow maps. The worker keeps one integer for it
 * (Final, 0, the default); only while it is not 0 does it bind the buffer to one full-screen quad on top of the stage, made
 * on first use and released when the view goes back to Final. One decode shader serves every view (a branch on the view).
 *
 * What each buffer holds (the decode follows the light pass's, lightingBasic.frag.glsl):
 * - faceRT (faceMap.js), RGBA8 at the light pass's size: R, G the normal, octahedral, bytes 1..253 ((0, 0) no face,
 *   (1, 0) an unshaded pixel, (254, 254) a pixel lit as drawn); B·256 + A the height, 15 bits in eighths of a px, the top
 *   bit (FACE_K_BIT) a sprite's own normal.
 * - faceIdsRT (DX-GBUF): R·256 + G the entity id (0 none), B bit 0 the pixel shades itself (FACE_IDS_SELF).
 * - lightingRT, unshadedRT: colours, shown as drawn.
 * - sunMapRT, lampMapRT: heights in R (the sun's map spans SUN_MAP_ZMAX px), shown as a ramp.
 *
 * Not views: the lamps' volume cache (E-508's targets hold colour and depth per lamp tile, which needs its own layout
 * view) and pixel depth (the canvas's depth cannot be sampled without a copy each frame).
 */

import { gpuStageF, gpuStageVF, pixiGroupsGpuLayout, pixiGroupsLayout } from './webgpu/pixiMeshWgsl.js';
import { PIXI_GROUPS_WGSL } from './shaderChunks.js';

export const RENDER_VIEW = Object.freeze({
  FINAL: 0,
  NORMALS: 1,
  HEIGHT: 2,
  IDS: 3,
  FLAGS: 4,
  LIGHT: 5,
  UNSHADED: 6,
  SUN_MAP: 7,
  LAMP_MAP: 8,
  LIGHT_TILES: 9,
});

/** The views in the Render tab's order: label, and the config that makes the buffer when a scene has none. */
export const RENDER_VIEWS = Object.freeze([
  { id: RENDER_VIEW.FINAL, label: 'Final', needs: '' },
  { id: RENDER_VIEW.NORMALS, label: 'G-buffer normals', needs: 'a decoration with a normal, or sprites with normal or height maps' },
  { id: RENDER_VIEW.HEIGHT, label: 'G-buffer height', needs: 'a decoration with a normal, or sprites with height maps' },
  { id: RENDER_VIEW.IDS, label: 'Entity ids', needs: 'the G-buffer, with lighting.selfShadow, lighting.shadowsEnabled or lighting.walls' },
  { id: RENDER_VIEW.FLAGS, label: 'G-buffer flags', needs: 'the G-buffer (as the normals view)' },
  { id: RENDER_VIEW.LIGHT, label: 'Light buffer', needs: 'lighting.enabled' },
  { id: RENDER_VIEW.UNSHADED, label: 'Unshaded', needs: 'lighting.unshaded (or an unshaded sprite)' },
  { id: RENDER_VIEW.SUN_MAP, label: 'Sun shadow map', needs: 'lighting.shadowsEnabled and a sun' },
  { id: RENDER_VIEW.LAMP_MAP, label: 'Lamp shadow atlas', needs: 'lighting.shadowsEnabled and a lamp with castShadows' },
  { id: RENDER_VIEW.LIGHT_TILES, label: 'Light tiles', needs: 'the light pass by tiles (lighting.enabled; E-205)' },
]);

/** zIndex of the view's quad: over every layer of the stage. */
export const RENDER_VIEW_Z = 1e9;
/** The height view's ramp: 0 to this many px. */
export const RENDER_VIEW_HEIGHT_PX = 256;

/** A worker without a light pass (a test's): no light targets. */
const NO_LIGHTING = Object.freeze({});

/**
 * The textures a view samples, from the worker's targets (null where the scene has none), into `out` ([main, second]);
 * out[0] null: the view has nothing to show now. N-256 PW-6: the light pass's targets are the worker's lighting's
 * (src/render/pixi/lighting.js); the sun map's stays the worker's.
 * @param {{ lighting?: { faceRT?: object|null, faceIdsRT?: object|null, lightingRT?: object|null, unshadedRT?: object|null,
 *   lampMapRT?: object|null }, sunMapRT?: object|null }} w
 * @param {number} view
 * @param {Array<object|null>} out
 */
export function renderViewTextures(w, view, out) {
  const l = w.lighting ?? NO_LIGHTING;
  out[0] = null;
  out[1] = null;
  switch (view) {
    case RENDER_VIEW.NORMALS:
    case RENDER_VIEW.HEIGHT:
      out[0] = l.faceRT ?? null;
      break;
    case RENDER_VIEW.IDS:
      out[0] = l.faceIdsRT ?? null;
      break;
    case RENDER_VIEW.FLAGS:
      out[0] = l.faceRT ?? null;
      out[1] = l.faceIdsRT ?? null;
      break;
    case RENDER_VIEW.LIGHT:
      out[0] = l.lightingRT ?? null;
      break;
    case RENDER_VIEW.UNSHADED:
      out[0] = l.unshadedRT ?? null;
      break;
    case RENDER_VIEW.SUN_MAP:
      out[0] = w.sunMapRT ?? null;
      break;
    case RENDER_VIEW.LAMP_MAP:
      out[0] = l.lampMapRT ?? null;
      break;
    case RENDER_VIEW.LIGHT_TILES:
      // DBG-7: the tiles' R32UI texture itself (a TextureSource, not a target), while the light pass bins by tile and has
      // made it (WebGL: allocated; WebGPU, which keeps no such flag: the grid laid out, its texture made at that upload).
      // The worker draws this view with a program of its own (RENDER_TILES_*).
      out[0] = w._lightTilesOn && l.lightTilesSource
        && (l.lightTilesMade || (w._useWebGpu === true && l.lightTiles.texWidth > 0)) ? l.lightTilesSource : null;
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
  } else if (view == 7 || view == 8) {
    c = t.r <= 0.0 ? vec3(0.0) : weedRamp(t.r);
  }
  finalColor = vec4(c * uView.y, uView.y);
}
`;

export const RENDER_VIEW_WGSL = `${PIXI_GROUPS_WGSL}

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
  } else if (view == 7 || view == 8) {
    c = select(weedRamp(t.r), vec3<f32>(0.0), t.r <= 0.0);
  }
  return vec4<f32>(c * u.y, u.y);
}
`;

/**
 * DBG-7: the light tiles view. Each pixel of the canvas finds its tile of the light pass's grid (lightTiles.js: tiles of
 * tilePx px of the light pass's target, x right and y down, `border` tiles past every edge) and counts the lights of
 * that tile, the set bits of its words (word k of tile (x, y) is texel (x, y + k · rowsPerWord)). The count reads as a
 * ramp (uCanvas.z lights read white), no light as black, and the grid's lines are drawn over it.
 */
export const RENDER_TILES_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform highp usampler2D uTiles;
uniform vec4 uGrid; // tilePx, border, cols, rows
uniform vec4 uWords; // wordsUsed, rowsPerWord, the light pass's resolution, opacity
uniform vec4 uCanvas; // the canvas's width and height (px), the count that reads white
out vec4 finalColor;

vec3 weedRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  return t < 0.5 ? mix(vec3(0.05, 0.05, 0.35), vec3(1.0, 0.45, 0.05), t * 2.0) : mix(vec3(1.0, 0.45, 0.05), vec3(1.0), t * 2.0 - 1.0);
}

// GLSL ES 3.00 has no bitCount: the set bits of a word, by halves.
uint weedBitCount(uint v) {
  v = v - ((v >> 1u) & 0x55555555u);
  v = (v & 0x33333333u) + ((v >> 2u) & 0x33333333u);
  return (((v + (v >> 4u)) & 0x0F0F0F0Fu) * 0x01010101u) >> 24u;
}

// DBG-7: the lights of this pixel's tile (renderViews.js).
void main() {
  vec2 px = vUV * uCanvas.xy * uWords.z;
  vec2 cell = floor(px / uGrid.x) + uGrid.y;
  float op = uWords.w;
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= uGrid.z || cell.y >= uGrid.w) {
    finalColor = vec4(0.0);
    return;
  }
  int words = int(uWords.x + 0.5);
  int band = int(uWords.y + 0.5);
  uint n = 0u;
  for (int k = 0; k < 64; k++) {
    if (k >= words) break;
    n += weedBitCount(texelFetch(uTiles, ivec2(int(cell.x), int(cell.y) + k * band), 0).r);
  }
  vec2 f = fract(px / uGrid.x);
  float line = (f.x * uGrid.x < 1.0 || f.y * uGrid.x < 1.0) ? 0.6 : 0.0;
  vec3 c = n == 0u ? vec3(0.0) : weedRamp(float(n) / max(uCanvas.z, 1.0));
  c = mix(c, vec3(0.35), line);
  finalColor = vec4(c * op, op);
}
`;

export const RENDER_TILES_WGSL = `${PIXI_GROUPS_WGSL}

struct TileUniforms {
  uGrid: vec4<f32>,
  uWords: vec4<f32>,
  uCanvas: vec4<f32>,
}
@group(2) @binding(0) var uTiles: texture_2d<u32>;
@group(2) @binding(1) var<uniform> tileUniforms: TileUniforms;

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

fn weedRamp(t0: f32) -> vec3<f32> {
  let t = clamp(t0, 0.0, 1.0);
  if (t < 0.5) { return mix(vec3<f32>(0.05, 0.05, 0.35), vec3<f32>(1.0, 0.45, 0.05), t * 2.0); }
  return mix(vec3<f32>(1.0, 0.45, 0.05), vec3<f32>(1.0), t * 2.0 - 1.0);
}

// DBG-7: the lights of this pixel's tile (the GLSL's twin).
@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let u = tileUniforms;
  let px = in.vUV * u.uCanvas.xy * u.uWords.z;
  let cell = floor(px / u.uGrid.x) + u.uGrid.y;
  let op = u.uWords.w;
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= u.uGrid.z || cell.y >= u.uGrid.w) {
    return vec4<f32>(0.0);
  }
  let words = i32(u.uWords.x + 0.5);
  let band = i32(u.uWords.y + 0.5);
  var n = 0u;
  for (var k = 0; k < 64; k++) {
    if (k >= words) { break; }
    n += countOneBits(textureLoad(uTiles, vec2<i32>(i32(cell.x), i32(cell.y) + k * band), 0).r);
  }
  let f = fract(px / u.uGrid.x);
  let line = select(0.0, 0.6, f.x * u.uGrid.x < 1.0 || f.y * u.uGrid.x < 1.0);
  var c = select(weedRamp(f32(n) / max(u.uCanvas.z, 1.0)), vec3<f32>(0.0), n == 0u);
  c = mix(c, vec3<f32>(0.35), line);
  return vec4<f32>(c * op, op);
}
`;

/** DBG-7's WebGPU program: Pixi's mesh groups, the tiles' r32uint texture (no sampler) and the view's uniforms. */
export function renderTilesGpuProgram(GpuProgram, name = 'weed-render-tiles') {
  const vf = gpuStageVF();
  const f = gpuStageF();
  return GpuProgram.from({
    name,
    vertex: { source: RENDER_TILES_WGSL, entryPoint: 'mainVert' },
    fragment: { source: RENDER_TILES_WGSL, entryPoint: 'mainFrag' },
    layout: pixiGroupsLayout({ uTiles: 0, tileUniforms: 1 }),
    gpuLayout: [
      ...pixiGroupsGpuLayout(),
      [
        { binding: 0, visibility: f, texture: { sampleType: 'uint', viewDimension: '2d', multisampled: false } },
        { binding: 1, visibility: vf, buffer: { type: 'uniform' } },
      ],
    ],
  });
}

/** The view quad's WebGPU program: Pixi's mesh groups, the two textures and their samplers and the view's uniforms. */
export function renderViewGpuProgram(GpuProgram, name = 'weed-render-view') {
  const vf = gpuStageVF();
  const f = gpuStageF();
  const tex = { sampleType: 'float', viewDimension: '2d', multisampled: false };
  return GpuProgram.from({
    name,
    vertex: { source: RENDER_VIEW_WGSL, entryPoint: 'mainVert' },
    fragment: { source: RENDER_VIEW_WGSL, entryPoint: 'mainFrag' },
    layout: pixiGroupsLayout({ uTex: 0, uTexSampler: 1, uTex2: 2, uTex2Sampler: 3, viewUniforms: 4 }),
    gpuLayout: [
      ...pixiGroupsGpuLayout(),
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
