/**
 * DX-SHADOW3D (the sun, first version): a shadow map in the floor's terms. Each texel holds the height of the highest
 * caster point whose sun ray lands on the floor there; a point of the world is in the sun's shadow when the map, where
 * its own ray lands, holds something higher than it. One map for every caster, whatever their number, drawn each frame
 * with max blending from the caster rows the sprite shadows already use.
 *
 * Space: the floor's (x along the screen, y across the floor towards the camera, z up). A point (x, y, z) lands at
 * (x - z·kx, y - z·ky) with (kx, ky) = the sun's horizontal direction over its height. The map is laid out on the screen
 * as the sprite shadows' layer is (that landing point drawn where the floor there is drawn), so the light pass samples it
 * with the same coordinates.
 *
 * A caster without a height map is a card standing on its foot that faces the sun: its picture's columns along the floor
 * across the sun's direction, its rows up (a px of the picture's height is 1 / heightScaleY px of height), its alpha the
 * silhouette. A caster with one casts columns (sunMapColumnsVertex): each cell of its picture where it is in 3D, with
 * the column under it, so its shadow is its solid's, turned as it is.
 */

/** Height (px) that the map's 8 bits span: 2 px a step. */
export const SUN_MAP_ZMAX = 512;
/** Below this, a sun ray is too flat to shift by its height (kx, ky are clamped). */
export const SUN_MAP_MIN_ELEVATION = 0.05;

/**
 * The sun's terms for a frame: the landing shift per px of height (kx, ky) and the floor direction a card's columns run
 * along (across the sun, to the right on the screen when it can be).
 * @param {ArrayLike<number>} towardsSun the sun's direction in the floor's space (x, y, z), any length
 * @param {Float32Array|number[]} out kx, ky, perpX, perpY
 */
export function sunMapTerms(towardsSun, out) {
  const x = towardsSun[0];
  const y = towardsSun[1];
  const z = Math.max(towardsSun[2], SUN_MAP_MIN_ELEVATION * Math.sqrt(x * x + y * y + towardsSun[2] * towardsSun[2]));
  out[0] = x / z;
  out[1] = y / z;
  const h = Math.sqrt(x * x + y * y);
  let px = h > 1e-9 ? -y / h : 1;
  let py = h > 1e-9 ? x / h : 0;
  if (px < 0 || (px === 0 && py < 0)) {
    px = -px;
    py = -py;
  }
  out[2] = px;
  out[3] = py;
  return out;
}

/**
 * Where a caster's picture point lands, in the floor's space (what the map's vertex shader does), for tests.
 * @param {{ footX: number, footY: number, localX: number, localY: number, heightScaleY: number, height?: number }} p
 *   the foot in world px (y on the screen), the picture point's offset from it in screen px (y down)
 * @param {ArrayLike<number>} terms sunMapTerms
 * @param {number} groundScaleY
 * @returns {{ x: number, y: number, z: number }} y in world px (on the screen), z the point's height
 */
export function sunMapLanding({ footX, footY, localX, localY, heightScaleY, height = 1 }, terms, groundScaleY) {
  const z = (Math.max(-localY, 0) * height) / heightScaleY;
  const fx = footX + localX * terms[2] - z * terms[0];
  const fy = footY / groundScaleY + localX * terms[3] - z * terms[1];
  return { x: fx, y: fy * groundScaleY, z };
}

/** Cells across (and down) a frame when it casts columns: SUN_MAP_COLUMNS² columns a caster with a height map. */
export const SUN_MAP_COLUMNS = 24;

/** Whether a frame (its atlas UV rectangle) has a height map: the twin page at three points down its middle. */
const MAPPED_GLSL = `uniform sampler2D uMaps;
bool sunMapped(vec4 uv) {
  vec2 size = vec2(textureSize(uMaps, 0));
  for (int k = 0; k < 3; k++) {
    vec4 m = texelFetch(uMaps, ivec2(mix(uv.xy, uv.zw, vec2(0.5, 0.3 + 0.2 * float(k))) * size), 0);
    if (m.b + m.a > 0.0) return true;
  }
  return false;
}
`;

/**
 * The grid sunMapColumnsVertex draws over a frame, SUN_MAP_COLUMNS² cells of two triangles: per vertex the cell's centre
 * (u, v in the frame), t (0 at the floor, 1 at the column's top) and its side (-1, 1).
 * @returns {Float32Array}
 */
export function sunMapColumnGrid(cells = SUN_MAP_COLUMNS) {
  const corners = [[0, -1], [1, -1], [1, 1], [0, -1], [1, 1], [0, 1]];
  const out = new Float32Array(cells * cells * corners.length * 4);
  let at = 0;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      for (const [tt, side] of corners) {
        out[at++] = (i + 0.5) / cells;
        out[at++] = (j + 0.5) / cells;
        out[at++] = tt;
        out[at++] = side;
      }
    }
  }
  return out;
}

/**
 * The columns' vertex shader: a frame with a height map stands each of its cells where it is in 3D (its screen place and
 * its height: floor y = (screen y + heightScaleY · z) / groundScaleY) and casts the column under it: a strip from that
 * floor point (height 0) to where the cell's sun ray lands (height z). The union of the columns is the object's solid
 * shadow, whatever way it is turned. Transparent cells and cells without a map draw nothing (the card pass casts those).
 * @param {string} source instancedSpriteShadow.vert.glsl
 */
export function sunMapColumnsVertex(source, cells = SUN_MAP_COLUMNS) {
  const card = sunMapVertex(source);
  const quad = 'in vec2 aQuad;\n';
  const main = 'void main() {\n';
  const tail = '  // A caster whose frame has a height map casts columns instead';
  if (card.split(quad).length !== 2 || card.split(main).length !== 2 || card.split(tail).length !== 2) {
    throw new Error('WeedJS: the sun shadow map columns need the sprite shadow vertex shader (aQuad, main)');
  }
  const head = card
    .slice(0, card.indexOf(tail))
    .replace(quad, 'in vec4 aCell; // the cell\'s centre in the frame, t (floor 0, top 1), side\nvec2 aQuad;\nuniform sampler2D uTexture;\n')
    .replace(main, `${main}  aQuad = aCell.xy;\n`);
  return `${head}  vec2 uvc = mix(aInstUV.xy, aInstUV.zw, aQuad);
  vec4 m = texelFetch(uMaps, ivec2(uvc * vec2(textureSize(uMaps, 0))), 0);
  float cellAlpha = texelFetch(uTexture, ivec2(uvc * vec2(textureSize(uTexture, 0))), 0).a;
  float z = (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / 64.0 * height;
  if (m.b + m.a <= 0.0 || cellAlpha < 0.5 || z < 0.5) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    vSunZ = 0.0;
    return;
  }
  vec2 content = aInstTrim.xy + aQuad * aInstTrim.zw;
  vec2 pix = aInstXY + (content - anchor * aInstSize) * aInstScale;
  vec2 base = vec2(pix.x, (pix.y + uSunK.w * z) * uGroundInvScaleY);
  vec2 tip = base - z * uSunK.xy;
  vec2 along = tip - base;
  float len = length(along);
  vec2 across = len > 1e-3 ? vec2(-along.y, along.x) / len : vec2(1.0, 0.0);
  vec2 cell = abs(aInstTrim.zw * aInstScale) / ${cells.toFixed(1)};
  float width = 1.1 * max(cell.x, cell.y * uGroundInvScaleY) + 1.0;
  vec2 p = mix(base, tip, aCell.z) + across * aCell.w * width;
  vec2 world = vec2(p.x, p.y / uGroundInvScaleY);
  vec2 screen = (world - uCam.xy) * uCam.z;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 clip = mvp * vec3(screen, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  if (abs(aInstRotCS.x) > 2.0) gl_Position.x += aInstRotCS.y + aInstDepth + aInstTintBits;
  vLocal = aQuad;
  vColor = vec4(1.0);
  vWorld = world;
  vAtlasUV = aInstUV;
  vTileInv = aInstTileInv;
  vTileOff = aInstTileOff;
  vSunZ = z * aCell.z;
}
`;
}

/**
 * The map's vertex shader: instancedSpriteShadow.vert.glsl with its last part (a skewed sprite on the screen) turned into
 * the card's landing points and their heights (vSunZ). Same inputs, same early outs, same screen mapping.
 * @param {string} source instancedSpriteShadow.vert.glsl
 */
export function sunMapVertex(source) {
  const decl = 'uniform float uGroundInvScaleY;\n';
  const tailStart = '  vec2 content = aInstTrim.xy + aQuad * aInstTrim.zw;\n';
  if (source.split(decl).length !== 2 || source.split(tailStart).length !== 2) {
    throw new Error('WeedJS: the sun shadow map needs the sprite shadow vertex shader (uGroundInvScaleY, content)');
  }
  const head = source.slice(0, source.indexOf(tailStart)).replace(
    decl,
    `${decl}// DX-SHADOW3D: kx, ky (a px of height's landing shift), 0, heightScaleY; a card's floor direction.\n` +
      'uniform vec4 uSunK;\nuniform vec4 uSunPerp;\nout float vSunZ;\n' + MAPPED_GLSL,
  );
  return `${head}  // A caster whose frame has a height map casts columns instead (sunMapColumnsVertex): its card would face the sun
  // whatever the object's shape (a crate's shadow turned with the sun).
  if (sunMapped(aInstUV)) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    vSunZ = 0.0;
    return;
  }
  vec2 content = aInstTrim.xy + aQuad * aInstTrim.zw;
  vec2 local = (content - anchor * aInstSize) * aInstScale;
  float z = max(-local.y, 0.0) * height / uSunK.w;
  vec2 foot = vec2(aInstXY.x, aInstXY.y * uGroundInvScaleY);
  vec2 land = foot + local.x * uSunPerp.xy - z * uSunK.xy;
  vec2 world = vec2(land.x, land.y / uGroundInvScaleY);
  vec2 screen = (world - uCam.xy) * uCam.z;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 clip = mvp * vec3(screen, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  if (abs(aInstRotCS.x) > 2.0) gl_Position.x += aInstRotCS.y + aInstDepth + aInstTintBits;
  vLocal = aQuad;
  vColor = vec4(1.0);
  vWorld = world;
  vAtlasUV = aInstUV;
  vTileInv = aInstTileInv;
  vTileOff = aInstTileOff;
  vSunZ = z;
}
`;
}
