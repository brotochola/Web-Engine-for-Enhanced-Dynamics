/**
 * DX-MAPS: what a shader asks of a texel of the atlas's twin page (spriteMaps.js), in one place for every reader (the
 * G-buffer's passes, pixel depth, the sun's and the lamps' columns). A texel holds a map where its frame's colour was
 * opaque when the page was made: there its normal's two bytes are 1..253 each (spriteMaps.js encodeOctahedral), and
 * every byte is 0 elsewhere. So:
 * - twinPresent: the texel holds a map (its normal's bytes are not both 0);
 * - twinZ: the height above the floor it holds, R·256 + G in 1/HEIGHT_UNITS px.
 * GLSL (TWIN_GLSL) and WGSL (TWIN_WGSL) declare both; twinPresent and twinZ read a texel of RGBA bytes on the CPU.
 */

import { HEIGHT_UNITS } from './spriteMaps.js';

/** The twin texel's helpers in GLSL 300 (a vec4 as texelFetch returns it from the RGBA8 page). */
export const TWIN_GLSL = `// DX-MAPS (twinTexel.js): whether a twin texel holds a map, and the height it holds (px).
bool twinPresent(vec4 m) {
  return m.b + m.a > 0.0;
}
float twinZ(vec4 m) {
  return (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / ${HEIGHT_UNITS}.0;
}
`;

/** TWIN_GLSL in WGSL. */
export const TWIN_WGSL = `// DX-MAPS (twinTexel.js): whether a twin texel holds a map, and the height it holds (px).
fn twinPresent(m: vec4<f32>) -> bool {
  return m.b + m.a > 0.0;
}
fn twinZ(m: vec4<f32>) -> f32 {
  return (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / ${HEIGHT_UNITS}.0;
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
