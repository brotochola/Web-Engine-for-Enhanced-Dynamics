/**
 * DX-MAPS: what a shader asks of a texel of the atlas's twin page (spriteMaps.js), in one place for every reader (the
 * G-buffer's passes, pixel depth, the sun's and the lamps' columns, the unshaded pass). A texel holds a map where its
 * frame's colour was opaque when the page was made. So:
 * - twinPresent: the texel holds a map;
 * - twinZ: the height above the floor it holds, in px;
 * - twinStoredNormal: the normal the page keeps for it (a normal map's, or its heights' Sobel at load), where the format
 *   keeps one (TWIN_NORMALS);
 * - twinRaw(c): the texel at full-resolution twin coordinate c, as a vec4 that twinPresent and twinZ read whatever the format.
 * E-496: a frame's texels are in its window of the twin page, which the maps table (mapsTable.js) gives a textureId
 * (twinWindow, in the vertex stage: the offset from the frame's atlas rectangle and its marks); a reader passes it on to
 * its fragment stage, and reads a texel at an atlas UV through it (twinCoord, twinTexel: zeros for a frame without maps).
 *
 * E-497: the page's format, a tournament behind assets.twinFormat (the atlas's json meta.mapsFormat tells the renderer:
 * setTwinFormat before any reader's program is made):
 * - 'A' (default): RGBA8, the height in R·256 + G (1/HEIGHT_UNITS px) and the octahedral normal in B, A (bytes 1..253,
 *   both 0 where there is no map).
 * - 'B': heights alone, 2 bytes a texel: two texels to an RGBA8 texel (x even in R, G; x odd in B, A), each the height's
 *   code + 1 (0: no map), so a height-0 opaque pixel still counts. The normals are the shader's Sobel of the heights. Not
 *   for sheets with a normal map (the atlas keeps 'A' then).
 * - 'C': B's heights, and below them (the page's last third of rows) the normals at half resolution, the octahedral bytes of
 *   twin texel (x >> 1, y >> 1), two to an RGBA8 texel as B packs heights.
 * GLSL (twinGlsl, MAPS_TABLE_GLSL) and WGSL (twinWgsl, MAPS_TABLE_WGSL) alike; twinPresent and twinZ read a format-A texel
 * of RGBA bytes on the CPU (spriteMaps.js twinPageTexel reads any format).
 */

import { HEIGHT_UNITS } from './spriteMaps.js';
import { MAPS_HEIGHTS, MAPS_RELIEF, MAPS_TWIN, MAPS_UNSHADED } from './mapsTable.js';

/** The maps table's binding in a WGSL program's group 2 (the twin page is 5; the shadow programs take 6 and 7). */
export const MAPS_TABLE_BINDING = 8;

/** E-497: the twin page's formats. */
export const TWIN_FORMATS = Object.freeze(['A', 'B', 'C']);

/** The format the readers' programs are made for (this worker's atlas's: setTwinFormat). */
let currentFormat = 'A';

/**
 * E-497: the format of this worker's atlas's twin page (its json's meta.mapsFormat; 'A' without one), set before any
 * reader's program is made.
 * @param {string|undefined|null} format
 */
export function setTwinFormat(format) {
  currentFormat = TWIN_FORMATS.includes(format) ? format : 'A';
}

/** E-497: the twin page's format the readers' programs are made for now. */
export function twinFormat() {
  return currentFormat;
}

/** E-497: whether a format keeps normals ('A' at full resolution, 'C' at half); 'B' has heights alone. */
export function twinKeepsNormals(format = currentFormat) {
  return format !== 'B';
}

/**
 * E-496: a frame's marks in GLSL 300 (twinWindow's z: mapsTable.js MAPS_*): a window in the twin page, heights, relief,
 * unshaded. twinGlsl holds them; a stage that reads no twin texel takes them alone.
 */
export const MAPS_MARKS_GLSL = `// E-496: a frame's marks (twinWindow's z: mapsTable.js MAPS_*): a window in the twin page, heights, relief, unshaded.
bool twinHas(vec4 win) {
  return (uint(win.z + 0.5) & ${MAPS_TWIN}u) != 0u;
}
bool twinHeights(vec4 win) {
  return (uint(win.z + 0.5) & ${MAPS_HEIGHTS}u) != 0u;
}
bool twinRelief(vec4 win) {
  return (uint(win.z + 0.5) & ${MAPS_RELIEF}u) != 0u;
}
bool twinUnshaded(vec4 win) {
  return (uint(win.z + 0.5) & ${MAPS_UNSHADED}u) != 0u;
}
`;

const MAPS_MARKS_WGSL = `// E-496: a frame's marks (twinWindow's z: mapsTable.js MAPS_*): a window in the twin page, heights, relief, unshaded.
fn twinHas(win: vec4<f32>) -> bool {
  return (u32(win.z + 0.5) & ${MAPS_TWIN}u) != 0u;
}
fn twinHeights(win: vec4<f32>) -> bool {
  return (u32(win.z + 0.5) & ${MAPS_HEIGHTS}u) != 0u;
}
fn twinRelief(win: vec4<f32>) -> bool {
  return (u32(win.z + 0.5) & ${MAPS_RELIEF}u) != 0u;
}
fn twinUnshaded(win: vec4<f32>) -> bool {
  return (u32(win.z + 0.5) & ${MAPS_UNSHADED}u) != 0u;
}
`;

/** twinRaw in GLSL for a format: format A's texel itself, or B's and C's packed height as an A texel (the normal 1, 0). */
function rawGlsl(format) {
  if (format === 'A') {
    return `vec4 twinRaw(ivec2 c) {
  return texelFetch(uMaps, c, 0);
}
`;
  }
  return `vec4 twinRaw(ivec2 c) {
  vec4 q = texelFetch(uMaps, ivec2(c.x >> 1, c.y), 0);
  vec2 v = (c.x & 1) != 0 ? q.ba : q.rg;
  float code = floor(v.x * 255.0 + 0.5) * 256.0 + floor(v.y * 255.0 + 0.5);
  if (code < 0.5) return vec4(0.0);
  code -= 1.0;
  return vec4(floor(code / 256.0) / 255.0, mod(code, 256.0) / 255.0, 1.0 / 255.0, 0.0);
}
`;
}

/** twinStoredNormal in GLSL for a format (B keeps none: a facing normal, which TWIN_NORMALS tells the reader not to use). */
function normalGlsl(format) {
  const decode = `vec3 twinOct(vec2 bytes) {
  vec2 f = (bytes - 127.0) / 126.0;
  vec3 n = vec3(f, 1.0 - abs(f.x) - abs(f.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}
`;
  if (format === 'A') return `${decode}vec3 twinStoredNormal(vec4 m, ivec2 c) {
  return twinOct(floor(m.ba * 255.0 + 0.5));
}
`;
  if (format === 'C') return `${decode}vec3 twinStoredNormal(vec4 m, ivec2 c) {
  int top = (textureSize(uMaps, 0).y * 2) / 3;
  ivec2 h = c >> 1;
  vec4 q = texelFetch(uMaps, ivec2(h.x >> 1, top + h.y), 0);
  return twinOct(floor(((h.x & 1) != 0 ? q.ba : q.rg) * 255.0 + 0.5));
}
`;
  return `vec3 twinStoredNormal(vec4 m, ivec2 c) {
  return vec3(0.0, 0.0, 1.0);
}
`;
}

/**
 * The twin texel's helpers in GLSL 300 for a format (E-497; the current one by default) and the marks (MAPS_MARKS_GLSL),
 * after the program's `uniform sampler2D uTexture;` (the atlas) and `uniform sampler2D uMaps;` (the twin page).
 * @param {string} [format]
 */
export function twinGlsl(format = currentFormat) {
  return `// DX-MAPS (twinTexel.js): whether a twin texel holds a map, and the height it holds (px). E-497: format ${format}.
const bool TWIN_NORMALS = ${twinKeepsNormals(format)};
bool twinPresent(vec4 m) {
  return m.b + m.a > 0.0;
}
float twinZ(vec4 m) {
  return (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / ${HEIGHT_UNITS}.0;
}
${MAPS_MARKS_GLSL}// E-496: the twin page's texel of the atlas's texel at uv, through its frame's window (twinWindow), and that texel.
ivec2 twinCoord(vec2 uv, vec4 win) {
  return ivec2(uv * vec2(textureSize(uTexture, 0))) + ivec2(win.xy);
}
${rawGlsl(format)}vec4 twinTexel(vec2 uv, vec4 win) {
  return twinHas(win) ? twinRaw(twinCoord(uv, win)) : vec4(0.0);
}
${normalGlsl(format)}`;
}

/** rawGlsl in WGSL. */
function rawWgsl(format) {
  if (format === 'A') {
    return `fn twinRaw(c: vec2<i32>) -> vec4<f32> {
  return textureLoad(uMaps, c, 0);
}
`;
  }
  return `fn twinRaw(c: vec2<i32>) -> vec4<f32> {
  let q = textureLoad(uMaps, vec2<i32>(c.x >> 1u, c.y), 0);
  let v = select(q.rg, q.ba, (c.x & 1) != 0);
  var code = floor(v.x * 255.0 + 0.5) * 256.0 + floor(v.y * 255.0 + 0.5);
  if (code < 0.5) { return vec4<f32>(0.0); }
  code -= 1.0;
  return vec4<f32>(floor(code / 256.0) / 255.0, (code % 256.0) / 255.0, 1.0 / 255.0, 0.0);
}
`;
}

/** normalGlsl in WGSL. */
function normalWgsl(format) {
  const decode = `fn twinOct(bytes: vec2<f32>) -> vec3<f32> {
  let f = (bytes - 127.0) / 126.0;
  var n = vec3<f32>(f, 1.0 - abs(f.x) - abs(f.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}
`;
  if (format === 'A') return `${decode}fn twinStoredNormal(m: vec4<f32>, c: vec2<i32>) -> vec3<f32> {
  return twinOct(floor(m.ba * 255.0 + 0.5));
}
`;
  if (format === 'C') return `${decode}fn twinStoredNormal(m: vec4<f32>, c: vec2<i32>) -> vec3<f32> {
  let top = (i32(textureDimensions(uMaps, 0).y) * 2) / 3;
  let h = c >> vec2<u32>(1u);
  let q = textureLoad(uMaps, vec2<i32>(h.x >> 1u, top + h.y), 0);
  return twinOct(floor(select(q.rg, q.ba, (h.x & 1) != 0) * 255.0 + 0.5));
}
`;
  return `fn twinStoredNormal(m: vec4<f32>, c: vec2<i32>) -> vec3<f32> {
  return vec3<f32>(0.0, 0.0, 1.0);
}
`;
}

/** twinGlsl in WGSL (its program declares uTexture and uMaps). */
export function twinWgsl(format = currentFormat) {
  return `// DX-MAPS (twinTexel.js): whether a twin texel holds a map, and the height it holds (px). E-497: format ${format}.
const TWIN_NORMALS: bool = ${twinKeepsNormals(format)};
fn twinPresent(m: vec4<f32>) -> bool {
  return m.b + m.a > 0.0;
}
fn twinZ(m: vec4<f32>) -> f32 {
  return (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / ${HEIGHT_UNITS}.0;
}
${MAPS_MARKS_WGSL}// E-496: the twin page's texel of the atlas's texel at uv, through its frame's window (twinWindow), and that texel.
fn twinCoord(uv: vec2<f32>, win: vec4<f32>) -> vec2<i32> {
  return vec2<i32>(uv * vec2<f32>(textureDimensions(uTexture, 0))) + vec2<i32>(win.xy);
}
${rawWgsl(format)}fn twinTexel(uv: vec2<f32>, win: vec4<f32>) -> vec4<f32> {
  if (!twinHas(win)) { return vec4<f32>(0.0); }
  return twinRaw(twinCoord(uv, win));
}
${normalWgsl(format)}`;
}

/** Format A's helpers (the default; tests and readers that strip them compare against these). */
export const TWIN_GLSL = twinGlsl('A');
export const TWIN_WGSL = twinWgsl('A');

/**
 * E-496: the maps table in GLSL 300 (its uniform and twinWindow): textureId tid's texel (mapsTable.js), zeros past it.
 */
export const MAPS_TABLE_GLSL = `// E-496: the maps table (mapsTable.js): a frame's window in the twin page and its marks, a texel a textureId.
uniform sampler2D uMapsLut;
vec4 twinWindow(int tid) {
  ivec2 size = textureSize(uMapsLut, 0);
  return tid >= 0 && tid < size.x * size.y ? texelFetch(uMapsLut, ivec2(tid % size.x, tid / size.x), 0) : vec4(0.0);
}
`;

/** MAPS_TABLE_GLSL in WGSL, with its binding (group 2, MAPS_TABLE_BINDING). */
export const MAPS_TABLE_WGSL = `// E-496: the maps table (mapsTable.js): a frame's window in the twin page and its marks, a texel a textureId.
@group(2) @binding(${MAPS_TABLE_BINDING}) var uMapsLut: texture_2d<f32>;
fn twinWindow(tid: i32) -> vec4<f32> {
  let size = vec2<i32>(textureDimensions(uMapsLut, 0));
  if (tid < 0 || tid >= size.x * size.y) { return vec4<f32>(0.0); }
  return textureLoad(uMapsLut, vec2<i32>(tid % size.x, tid / size.x), 0);
}
`;

/** The line a GLSL source holds where twinGlsl goes (faceMap.frag.glsl). */
export const TWIN_MARK_GLSL = '// weed:twin\n';

/**
 * A GLSL source with twinGlsl (the current format's) in place of its TWIN_MARK_GLSL line.
 * @param {string} source
 * @returns {string}
 */
export function withTwinGlsl(source) {
  if (source.split(TWIN_MARK_GLSL).length !== 2) throw new Error('WeedJS: the twin page\'s readers need one "// weed:twin" line');
  const twin = twinGlsl();
  return source.replace(TWIN_MARK_GLSL, () => twin);
}

/**
 * twinPresent on the CPU: whether the format-A RGBA texel at `at` holds a map.
 * @param {Uint8Array|Uint8ClampedArray} texels
 * @param {number} at the texel's first byte
 */
export function twinPresent(texels, at) {
  return texels[at + 2] + texels[at + 3] > 0;
}

/**
 * twinZ on the CPU: the height (px) the format-A RGBA texel at `at` holds.
 * @param {Uint8Array|Uint8ClampedArray} texels
 * @param {number} at the texel's first byte
 */
export function twinZ(texels, at) {
  return (texels[at] * 256 + texels[at + 1]) / HEIGHT_UNITS;
}
