/**
 * Pixel snap (renderer.atlasScaleMode 'nearest'): each sprite's origin lands on the screen's pixel grid in the sprite
 * vertex shaders, where it is drawn, not on the CPU. Before, the packs rounded every row's pose, so every pass read the
 * rounded place: pixel depth then put a window's plane up to a pixel off its wall's, by a different amount each frame
 * as the camera moved, and the window flickered behind its wall (N-271). Now aInstXY keeps the true place: pixel depth,
 * the G-buffer's heights and the shadow maps read it, and only the drawn corners move to the grid. An interpolated pose
 * snaps after its blend, so a moving sprite lands on a pixel in every drawn frame.
 *
 * The snap rounds in the stage's pixels (uWorldTransformMatrix · uTransformMatrix: the camera's zoom and place, a parallax
 * layer's own), as the packs did with the camera's: round((x - camera) · zoom). N-302: an axis-aligned sprite (no turn,
 * no shear) rounds each corner, so two sprites that share an edge (a floor of tiles) share its pixel; rounding only its
 * origin kept its fractional size on screen, and wherever that size's fraction was under a half (16 px pieces at zoom
 * 1.2 or 1.45) neighbours left a column of background between them, every few pieces. Such a sprite is a pixel wider or
 * narrower from place to place, as pixel art at a fractional zoom has to be. A turned or sheared sprite still rounds its
 * origin and keeps its shape.
 */
import { replaceOnce } from './shaderEdit.js';

/**
 * N-302: a sprite counts as axis-aligned below this |sin| of its turn (0.006°: a 100 px sprite's corners move a hundredth of
 * a pixel), so a body that drifts by a float's error from 0 still snaps its corners.
 */
const SNAP_SQUARE_SIN = '1e-4';

/** The shaders' test for a sprite whose corners snap (renderer.pixelSnapCorners); false: every sprite snaps its origin. */
function squareTest(corners) {
  return corners ? `!isShear && abs(s) < ${SNAP_SQUARE_SIN}` : 'false';
}

/** The GLSL snap: v moved by the rounding of its place on the stage, brought back through the transform's inverse. */
const SNAP_GLSL = `
// Pixel snap (pixelSnap.js): this origin on the stage's pixel grid; aInstXY keeps the true place.
vec2 weedSnapXY(vec2 v) {
  mat3 m = uWorldTransformMatrix * uTransformMatrix;
  vec2 p = (m * vec3(v, 1.0)).xy;
  vec2 d = floor(p + 0.5) - p;
  float det = m[0][0] * m[1][1] - m[1][0] * m[0][1];
  return det != 0.0 ? v + vec2(m[1][1] * d.x - m[1][0] * d.y, m[0][0] * d.y - m[0][1] * d.x) / det : v;
}
// N-302: an axis-aligned sprite's corner on the grid (its neighbours' shared edges land on the same pixel); a turned or
// sheared one's origin.
vec2 weedSnapWorld(vec2 origin, vec2 corner, bool square) {
  return square ? weedSnapXY(origin + corner) : weedSnapXY(origin) + corner;
}
`;

const SNAP_WGSL = `
// Pixel snap (pixelSnap.js): this origin on the stage's pixel grid; aInstXY keeps the true place.
fn weedSnapXY(v: vec2<f32>) -> vec2<f32> {
  let m = globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let p = (m * vec3<f32>(v, 1.0)).xy;
  let d = floor(p + 0.5) - p;
  let det = m[0][0] * m[1][1] - m[1][0] * m[0][1];
  if (det == 0.0) { return v; }
  return v + vec2<f32>(m[1][1] * d.x - m[1][0] * d.y, m[0][0] * d.y - m[0][1] * d.x) / det;
}
// N-302: an axis-aligned sprite's corner on the grid; a turned or sheared one's origin.
fn weedSnapWorld(origin: vec2<f32>, corner: vec2<f32>, square: bool) -> vec2<f32> {
  if (square) { return weedSnapXY(origin + corner); }
  return weedSnapXY(origin) + corner;
}
`;

/**
 * instancedSprite.vert.glsl on the pixel grid (an axis-aligned sprite's corners, another's origin).
 * @param {string} source
 * @returns {string}
 */
export function pixelSnapGlsl(source, corners = true) {
  let out = replaceOnce(source, 'void main() {', `${SNAP_GLSL}\nvoid main() {`, 'the pixel snap (a sprite vertex shader)');
  out = replaceOnce(out, 'vec2 world = (isShear ? sheared : spun) + aInstXY;',
    `vec2 world = weedSnapWorld(aInstXY, isShear ? sheared : spun, ${squareTest(corners)});`, 'the pixel snap (the corner)');
  return out;
}

/**
 * instancedSprite.wgsl on the pixel grid (an axis-aligned sprite's corners, another's origin).
 * @param {string} source
 * @returns {string}
 */
export function pixelSnapWgsl(source, corners = true) {
  let out = replaceOnce(source, '@vertex', `${SNAP_WGSL}\n@vertex`, 'the pixel snap (a sprite WGSL)');
  out = replaceOnce(out, 'let world = select(spun, sheared, isShear) + aInstXY;',
    `let world = weedSnapWorld(aInstXY, select(spun, sheared, isShear), ${squareTest(corners)});`, 'the pixel snap (the corner)');
  return out;
}

/**
 * The engine's sprite source with the snap, in place: WebGL's spriteVert, WebGPU's sprite. Every sprite program (indexed,
 * by row, G-buffer, pixel depth, the opaque pass) is made from it.
 * @param {Record<string, string>} shaders the Pixi worker's engine shaders
 * @param {boolean} webgpu
 * @param {boolean} [corners] renderer.pixelSnapCorners: an axis-aligned sprite's corners on the grid (default), else its origin
 */
export function applyPixelSnap(shaders, webgpu, corners = true) {
  const key = webgpu ? 'sprite' : 'spriteVert';
  if (typeof shaders[key] !== 'string' || shaders[key].includes('weedSnapXY')) return;
  shaders[key] = webgpu ? pixelSnapWgsl(shaders[key], corners) : pixelSnapGlsl(shaders[key], corners);
}
