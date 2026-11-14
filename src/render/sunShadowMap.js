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
 * A caster is a card standing on its foot that faces the sun: its picture's columns along the floor across the sun's
 * direction, its rows up (a px of the picture's height is 1 / heightScaleY px of height), its alpha the silhouette.
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
      'uniform vec4 uSunK;\nuniform vec4 uSunPerp;\nout float vSunZ;\n',
  );
  return `${head}  vec2 content = aInstTrim.xy + aQuad * aInstTrim.zw;
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
