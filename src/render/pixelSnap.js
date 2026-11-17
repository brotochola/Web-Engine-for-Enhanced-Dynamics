/**
 * Pixel snap (renderer.atlasScaleMode 'nearest'): each sprite's origin lands on the screen's pixel grid in the sprite
 * vertex shaders, where it is drawn, not on the CPU. Before, the packs rounded every row's pose, so every pass read the
 * rounded place: pixel depth then put a window's plane up to a pixel off its wall's, by a different amount each frame
 * as the camera moved, and the window flickered behind its wall (N-271). Now aInstXY keeps the true place: pixel depth,
 * the G-buffer's heights and the shadow maps read it, and only the drawn corners move to the grid. An interpolated pose
 * snaps after its blend, so a moving sprite lands on a pixel in every drawn frame.
 *
 * The snap rounds the origin in the stage's pixels (uWorldTransformMatrix · uTransformMatrix: the camera's zoom and
 * place, a parallax layer's own), as the packs did with the camera's: round((x - camera) · zoom).
 */

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
`;

/** `from` once in `source`, replaced by `to`; a source without it (or with two) throws. */
function once(source, from, to, what) {
  if (source.split(from).length !== 2) throw new Error(`WeedJS: the pixel snap needs ${what} (${from.trim()})`);
  return source.replace(from, () => to);
}

/**
 * instancedSprite.vert.glsl or its pose form, snapping its origin.
 * @param {string} source
 * @returns {string}
 */
export function pixelSnapGlsl(source) {
  const pose = source.includes('vec2 xy = mix(aInstPrevXY, aInstXY, uPoseAlpha);');
  let out = once(source, 'void main() {', `${SNAP_GLSL}\nvoid main() {`, 'a sprite vertex shader');
  out = pose
    ? once(out, 'vec2 xy = mix(aInstPrevXY, aInstXY, uPoseAlpha);', 'vec2 xy = weedSnapXY(mix(aInstPrevXY, aInstXY, uPoseAlpha));', 'the pose blend')
    : once(out, 'vec2 world = (isShear ? sheared : spun) + aInstXY;', 'vec2 world = (isShear ? sheared : spun) + weedSnapXY(aInstXY);', 'the corner');
  return out;
}

/**
 * instancedSprite.wgsl or its pose form, snapping its origin.
 * @param {string} source
 * @returns {string}
 */
export function pixelSnapWgsl(source) {
  const pose = source.includes('let xy = mix(aInstPrevXY, aInstXY, uniforms.uPoseAlpha);');
  let out = once(source, '@vertex', `${SNAP_WGSL}\n@vertex`, 'a sprite WGSL');
  out = pose
    ? once(out, 'let xy = mix(aInstPrevXY, aInstXY, uniforms.uPoseAlpha);', 'let xy = weedSnapXY(mix(aInstPrevXY, aInstXY, uniforms.uPoseAlpha));', 'the pose blend')
    : once(out, 'let world = select(spun, sheared, isShear) + aInstXY;', 'let world = select(spun, sheared, isShear) + weedSnapXY(aInstXY);', 'the corner');
  return out;
}

/**
 * The engine's sprite sources with the snap, in place: WebGL's spriteVert and spriteVertPose, WebGPU's sprite and
 * spritePose. Every sprite program (indexed, pose, G-buffer, pixel depth, the opaque pass) is made from these.
 * @param {Record<string, string>} shaders the Pixi worker's engine shaders
 * @param {boolean} webgpu
 */
export function applyPixelSnap(shaders, webgpu) {
  const keys = webgpu ? ['sprite', 'spritePose'] : ['spriteVert', 'spriteVertPose'];
  for (const key of keys) {
    if (typeof shaders[key] !== 'string' || shaders[key].includes('weedSnapXY')) continue;
    shaders[key] = webgpu ? pixelSnapWgsl(shaders[key]) : pixelSnapGlsl(shaders[key]);
  }
}
