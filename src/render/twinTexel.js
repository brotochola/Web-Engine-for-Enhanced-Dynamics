/**
 * DX-MAPS: what a shader asks of a texel of the atlas's twin page (spriteMaps.js), in one place for every reader (the
 * G-buffer's passes, pixel depth, the sun's and the lamps' columns, the glow). A texel holds a map where its frame's colour
 * was opaque when the page was made: there its normal's two bytes are 1..253 each (spriteMaps.js encodeOctahedral), and
 * every byte is 0 elsewhere. So:
 * - twinPresent: the texel holds a map (its normal's bytes are not both 0);
 * - twinZ: the height above the floor it holds, R·256 + G in 1/HEIGHT_UNITS px.
 * E-496: a frame's texels are in its window of the twin page, which the maps table (mapsTable.js) gives a textureId
 * (twinWindow, in the vertex stage: the offset from the frame's atlas rectangle and its marks); a reader passes it on to
 * its fragment stage, and reads a texel at an atlas UV through it (twinCoord, twinTexel: zeros for a frame without maps).
 * GLSL (TWIN_GLSL, MAPS_TABLE_GLSL) and WGSL (TWIN_WGSL, MAPS_TABLE_WGSL) alike; twinPresent and twinZ read a texel of RGBA
 * bytes on the CPU.
 */

import { HEIGHT_UNITS } from './spriteMaps.js';
import { MAPS_HEIGHTS, MAPS_RELIEF, MAPS_TWIN, MAPS_UNSHADED } from './mapsTable.js';

/** The maps table's binding in a WGSL program's group 2 (the twin page is 5; the shadow programs take 6 and 7). */
export const MAPS_TABLE_BINDING = 8;

/**
 * E-496: a frame's marks in GLSL 300 (twinWindow's z: mapsTable.js MAPS_*): a window in the twin page, heights,
 * unshaded. TWIN_GLSL holds them; a stage that reads no twin texel takes them alone.
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

/**
 * The twin texel's helpers in GLSL 300 (a vec4 as texelFetch returns it from the RGBA8 page) and the marks
 * (MAPS_MARKS_GLSL), after the program's `uniform sampler2D uTexture;` (the atlas) and `uniform sampler2D uMaps;` (the
 * twin page).
 */
export const TWIN_GLSL = `// DX-MAPS (twinTexel.js): whether a twin texel holds a map, and the height it holds (px).
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
vec4 twinTexel(vec2 uv, vec4 win) {
  return twinHas(win) ? texelFetch(uMaps, twinCoord(uv, win), 0) : vec4(0.0);
}
`;

/** TWIN_GLSL in WGSL (its program declares uTexture and uMaps). */
export const TWIN_WGSL = `// DX-MAPS (twinTexel.js): whether a twin texel holds a map, and the height it holds (px).
fn twinPresent(m: vec4<f32>) -> bool {
  return m.b + m.a > 0.0;
}
fn twinZ(m: vec4<f32>) -> f32 {
  return (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / ${HEIGHT_UNITS}.0;
}
// E-496: a frame's marks (twinWindow's z: mapsTable.js MAPS_*): a window in the twin page, heights, relief, unshaded.
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
// E-496: the twin page's texel of the atlas's texel at uv, through its frame's window (twinWindow), and that texel.
fn twinCoord(uv: vec2<f32>, win: vec4<f32>) -> vec2<i32> {
  return vec2<i32>(uv * vec2<f32>(textureDimensions(uTexture, 0))) + vec2<i32>(win.xy);
}
fn twinTexel(uv: vec2<f32>, win: vec4<f32>) -> vec4<f32> {
  if (!twinHas(win)) { return vec4<f32>(0.0); }
  return textureLoad(uMaps, twinCoord(uv, win), 0);
}
`;

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

/** The line a GLSL source holds where TWIN_GLSL goes (faceMap.frag.glsl). */
export const TWIN_MARK_GLSL = '// weed:twin\n';

/**
 * A GLSL source with TWIN_GLSL in place of its TWIN_MARK_GLSL line.
 * @param {string} source
 * @returns {string}
 */
export function withTwinGlsl(source) {
  if (source.split(TWIN_MARK_GLSL).length !== 2) throw new Error('WeedJS: the twin page\'s readers need one "// weed:twin" line');
  return source.replace(TWIN_MARK_GLSL, () => TWIN_GLSL);
}

/**
 * twinPresent on the CPU: whether the RGBA texel at `at` holds a map.
 * @param {Uint8Array|Uint8ClampedArray} texels
 * @param {number} at the texel's first byte
 */
export function twinPresent(texels, at) {
  return texels[at + 2] + texels[at + 3] > 0;
}

/**
 * twinZ on the CPU: the height (px) the RGBA texel at `at` holds.
 * @param {Uint8Array|Uint8ClampedArray} texels
 * @param {number} at the texel's first byte
 */
export function twinZ(texels, at) {
  return (texels[at] * 256 + texels[at + 1]) / HEIGHT_UNITS;
}
