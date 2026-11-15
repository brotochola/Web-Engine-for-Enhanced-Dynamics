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

import { FOOTPRINT_MAX_VERTICES } from './frameBase.js';

/** Height (px) that the map's 8 bits span: 2 px a step. */
export const SUN_MAP_ZMAX = 512;
/** Below this, a sun ray is too flat to shift by its height (kx, ky are clamped). */
export const SUN_MAP_MIN_ELEVATION = 0.05;

/**
 * The sun's terms for a frame: the landing shift per px of height (kx, ky) and the floor direction a card's columns run
 * along: across the sun, to the right of someone at the sun looking at the caster (as the light bench's cards), so a
 * caster seen from the sun's side casts its picture the right way round, and one lit from behind the camera casts it as
 * the camera sees it.
 * @param {ArrayLike<number>} towardsSun the sun's direction in the floor's space (x, y, z), any length
 * @param {Float32Array|number[]} out kx, ky, perpX, perpY
 * @param {number} [maxLength] the longest shadow, in px per px of height (Sun.shadowMaxLengthRatio)
 */
export function sunMapTerms(towardsSun, out, maxLength = Infinity) {
  const x = towardsSun[0];
  const y = towardsSun[1];
  const z = Math.max(towardsSun[2], SUN_MAP_MIN_ELEVATION * Math.sqrt(x * x + y * y + towardsSun[2] * towardsSun[2]));
  const h = Math.sqrt(x * x + y * y);
  const k = h > maxLength * z ? maxLength / h : 1 / z;
  out[0] = x * k;
  out[1] = y * k;
  out[2] = h > 1e-9 ? y / h : 1;
  out[3] = h > 1e-9 ? -x / h : 0;
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
 * DX-GBUF: a caster row's entity as the G-buffer's id ((entity % 65535) + 1, gbufWord.js gbufEntityId), 0 for none. A full
 * caster row carries its entity in its tint float (pre-render's _tagCasterEntities, a stamp row copies it); a row the
 * frame could not match keeps its tint's bits there, which this reads as none unless they happen to be a whole number.
 * The shadow maps keep it with their highest caster (a depth test), and the light pass skips a pixel's own.
 */
export const CASTER_ID_GLSL = `float casterEntityId(float e) {
  return e >= 0.0 && e < 16777216.0 && e == floor(e) ? float(int(e) % 65535 + 1) : 0.0;
}
`;

/** CASTER_ID_GLSL's WGSL form. */
export const CASTER_ID_WGSL = `fn casterEntityId(e: f32) -> f32 {
  if (e >= 0.0 && e < 16777216.0 && e == floor(e)) { return f32(u32(e) % 65535u + 1u); }
  return 0.0;
}
`;

/** Cells across (and down) a frame when it casts columns: SUN_MAP_COLUMNS² columns a caster with a height map. */
export const SUN_MAP_COLUMNS = 24;

/**
 * The atlas's twin page (heights), which the columns read. Which frames cast columns is the frame's base's to say
 * (frameBase.js): a render with a height map has a contact (aInstBase.x < 0) and casts its solid; a picture of one view
 * (a person, a tree), maps or not, casts its card, as the light bench did (its solid would fill the light under a crown).
 */
const MAPPED_GLSL = 'uniform sampler2D uMaps;\n';

/**
 * DX-SHADOW3D: the column programs' footprint lookup (GLSL): the northmost floor y (floor px around the anchor) where
 * footprint row `slot`'s boundary crosses x, 1e9 when it does not (frameBase.js footprintNorthY, writeFootprintRow).
 */
export const FOOTPRINT_GLSL = `uniform sampler2D uFoot;
float footprintNorth(int slot, float x) {
  int count = int(texelFetch(uFoot, ivec2(0, slot), 0).x + 0.5);
  float ym = 1e9;
  for (int k = 0; k < ${FOOTPRINT_MAX_VERTICES}; k++) {
    if (k >= count) break;
    int k2 = k + 1 < count ? k + 1 : 0;
    vec4 tp = texelFetch(uFoot, ivec2(1 + k / 2, slot), 0);
    vec4 tq = texelFetch(uFoot, ivec2(1 + k2 / 2, slot), 0);
    vec2 p = k % 2 == 0 ? tp.xy : tp.zw;
    vec2 q = k2 % 2 == 0 ? tq.xy : tq.zw;
    if (x >= min(p.x, q.x) && x <= max(p.x, q.x) && abs(q.x - p.x) > 1e-4) ym = min(ym, p.y + (x - p.x) / (q.x - p.x) * (q.y - p.y));
  }
  return ym;
}
`;

/** FOOTPRINT_GLSL's WGSL form, with its binding (group 2, binding 7). */
export const FOOTPRINT_WGSL = `// DX-SHADOW3D: the renders' footprints (frameBase.js writeFootprintRow).
@group(2) @binding(7) var uFoot: texture_2d<f32>;
fn footprintNorth(slot: i32, x: f32) -> f32 {
  let count = i32(textureLoad(uFoot, vec2<i32>(0, slot), 0).x + 0.5);
  var ym = 1e9;
  for (var k = 0; k < ${FOOTPRINT_MAX_VERTICES}; k++) {
    if (k >= count) { break; }
    let k2 = select(0, k + 1, k + 1 < count);
    let tp = textureLoad(uFoot, vec2<i32>(1 + k / 2, slot), 0);
    let tq = textureLoad(uFoot, vec2<i32>(1 + k2 / 2, slot), 0);
    let p = select(tp.zw, tp.xy, k % 2 == 0);
    let q = select(tq.zw, tq.xy, k2 % 2 == 0);
    if (x >= min(p.x, q.x) && x <= max(p.x, q.x) && abs(q.x - p.x) > 1e-4) { ym = min(ym, p.y + (x - p.x) / (q.x - p.x) * (q.y - p.y)); }
  }
  return ym;
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
 * shadow, whatever way it is turned. Only a render's frames cast them (its base has a contact); transparent cells and
 * cells without a map draw nothing.
 * With `heights` (the sun's map) each column carries its height; without (the sprite shadows' layer, drawn with max
 * blending) it is the shadow's colour and opacity.
 * @param {string} source instancedSpriteShadow.vert.glsl
 * @param {number} [cells]
 * @param {{ heights?: boolean }} [opts]
 */
export function sunMapColumnsVertex(source, cells = SUN_MAP_COLUMNS, { heights = true } = {}) {
  const card = sunMapVertex(source, { heights });
  const quad = 'in vec2 aQuad;\n';
  const main = 'void main() {\n';
  const after = '  // weed:afterAnchor\n';
  if (card.split(quad).length !== 2 || card.split(main).length !== 2 || card.split(after).length !== 2) {
    throw new Error('WeedJS: the sun shadow map columns need the sprite shadow vertex shader (aQuad, main, weed:afterAnchor)');
  }
  const head = card
    .slice(0, card.indexOf(after))
    .replace(quad, 'in vec4 aCell; // the cell\'s centre in the frame, t (floor 0, top 1), side\nvec2 aQuad;\nuniform sampler2D uTexture;\n')
    .replace(main, `${FOOTPRINT_GLSL}${main}  aQuad = aCell.xy;\n`);
  return `${head}  vec2 uvc = mix(aInstUV.xy, aInstUV.zw, aQuad);
  vec4 m = texelFetch(uMaps, ivec2(uvc * vec2(textureSize(uMaps, 0))), 0);
  float cellAlpha = texelFetch(uTexture, ivec2(uvc * vec2(textureSize(uTexture, 0))), 0).a;
  float z = (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / 64.0 * height;
  bool solid = sunKind == 2 || (sunKind == 0 && aInstBase.x < 0.0 && aInstBase.y >= 0.0);
  if (!solid || m.b + m.a <= 0.0 || cellAlpha < 0.5 || z < 0.5) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);${heights ? '\n    vSunZ = 0.0;' : '\n    vColor = vec4(0.0);'}
    return;
  }
  vec2 content = aInstTrim.xy + aQuad * aInstTrim.zw;
  vec2 pix = aInstXY + (content - anchor * aInstSize) * aInstScale;
  vec2 base = vec2(pix.x, (pix.y + uSunK.w * z) * uGroundInvScaleY);
  vec2 cell = abs(aInstTrim.zw * aInstScale) / ${cells.toFixed(1)};
  float width = 1.1 * max(cell.x, cell.y * uGroundInvScaleY) + 1.0;
  // A column from the cell's floor point (height 0) to where its top lands; with a footprint, the cell swept north at
  // its own height to the footprint's edge, as the light bench's heightmap did (light passes under a belly, between
  // legs and rails).
  vec2 a = base;
  vec2 b = base - z * uSunK.xy;
  float zA = 0.0;
  if (aInstBase.y >= 1.0) {
    float north = aInstXY.y * uGroundInvScaleY
      + footprintNorth(int(aInstBase.y + 0.5) - 1, content.x - aInstAnchor.x * aInstSize.x) * abs(aInstScale.y);
    float halfCell = 0.5 * cell.y * uGroundInvScaleY + 0.5;
    a = vec2(base.x, base.y + halfCell) - z * uSunK.xy;
    b = vec2(base.x, min(north, base.y) - halfCell) - z * uSunK.xy;
    zA = z;
  }
  vec2 along = b - a;
  float len = length(along);
  vec2 across = len > 1e-3 ? vec2(-along.y, along.x) / len : vec2(1.0, 0.0);
  vec2 p = mix(a, b, aCell.z) + across * aCell.w * width;
  vec2 world = vec2(p.x, p.y / uGroundInvScaleY);
  vec2 screen = (world - uCam.xy) * uCam.z;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 clip = mvp * vec3(screen, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  // Never true (a cosine): keeps the rows' attributes in the program, which Pixi otherwise warns about (aInstLight).
  if (abs(aInstRotCS.x) > 2.0) gl_Position.x += aInstRotCS.y + aInstDepth + aInstTintBits + aInstLight.x;
  vLocal = aQuad;
  vColor = ${heights ? 'vec4(1.0, castOpacity, 1.0, 1.0)' : 'vec4(0.0, 0.0, 0.0, uSun.w * castOpacity)'};
  vWorld = world;
  vAtlasUV = aInstUV;
  vTileInv = aInstTileInv;
  vTileOff = aInstTileOff;${heights ? `\n  vSunZ = mix(zA, z, aCell.z);\n  gl_Position.z = 1.0 - 2.0 * clamp(vSunZ / ${SUN_MAP_ZMAX}.0, 0.0, 1.0);` : ''}
}
`;
}

/**
 * The map's vertex shader: instancedSpriteShadow.vert.glsl with its sun card kept (the same landing points the sprite
 * shadows draw) and its height passed on (vSunZ), so the map holds the highest caster point landing at each texel. Frames
 * with a height map skip the card: they cast columns (sunMapColumnsVertex). Same inputs, same early outs. Without
 * `heights` it is the sprite shadows' own program that only skips those frames (their columns draw them).
 * @param {string} source instancedSpriteShadow.vert.glsl
 * @param {{ heights?: boolean }} [opts]
 */
export function sunMapVertex(source, { heights = true } = {}) {
  const decl = 'uniform vec4 uSunPerp;\n';
  const main = 'void main() {\n';
  const card = '    // weed:sunCard\n';
  const out = '    // weed:sunOut\n';
  const color = '  vColor = vec4(0.0, 0.0, 0.0, alpha);\n';
  for (const mark of [decl, main, card, out, color]) {
    if (source.split(mark).length !== 2) {
      throw new Error(`WeedJS: the sun shadow map needs the sprite shadow vertex shader (${mark.trim()})`);
    }
  }
  const skipped = source.replace(
    card,
    `${card}    // A caster whose frame has a height map casts columns instead (sunMapColumnsVertex): its card would face the sun
    // whatever the object's shape (a crate's shadow turned with the sun). Unless its sheet casts its card for the sun
    // (frameBase.js lutBaseFloats: a negative second float), as the light bench's cow and cars did.
    if (sunKind >= 3 || sunKind == 2 || (sunKind == 0 && aInstBase.x < 0.0 && aInstBase.y >= 0.0)) {
      gl_Position = vec4(2.0, 2.0, 0.0, 1.0);${heights ? '' : '\n      vColor = vec4(0.0);'}
      return;
    }
`,
  );
  if (!heights) return skipped.replace(decl, `${decl}${MAPPED_GLSL}`);
  return skipped
    .replace(decl, `${decl}out float vSunZ;\nflat out float vSunId;\n${MAPPED_GLSL}${CASTER_ID_GLSL}`)
    .replace(main, `${main}  vSunZ = 0.0;\n  vSunId = casterEntityId(aInstTintBits);\n`)
    .replace(out, `${out}    vSunZ = sunZ;\n`)
    // The depth that keeps the highest point (sunShadowMap.frag.glsl), from the vertex: NDC z = 2 (1 - h) - 1.
    .replace(color, `  vColor = vec4(1.0, castOpacity, 1.0, 1.0);\n  gl_Position.z = 1.0 - 2.0 * clamp(vSunZ / ${SUN_MAP_ZMAX}.0, 0.0, 1.0);\n`);
}

/** A WGSL source with one occurrence of each mark, or a clear error. */
function wgslMarks(source, marks, what) {
  for (const mark of marks) {
    if (source.split(mark).length !== 2) throw new Error(`WeedJS: ${what} needs the sprite shadow WGSL (${mark.trim()})`);
  }
}

/**
 * DX-SHADOW3D: a shadow map's texel (sunShadowMap.frag.glsl): the height (R), the caster's opacity (G: how much light it
 * takes out, DX-CASTER) and its G-buffer id (B·256 + A). A depth test keeps the highest caster with its opacity and id;
 * the depth comes from the vertices (E-374: a fragment that writes its depth turns the early depth test off for the whole
 * pass): 1 - height / ZMAX on the sun's map, lampClipZ's on a lamp's.
 */
export const MAP_TEXEL_WGSL = `fn weedMapTexel(z: f32, idf: f32, opacity: f32) -> vec4<f32> {
  let h = clamp(z / ${SUN_MAP_ZMAX}.0, 0.0, 1.0);
  let id = u32(idf + 0.5);
  return vec4<f32>(h, clamp(opacity, 0.0, 1.0), f32(id >> 8u) / 255.0, f32(id & 255u) / 255.0);
}
`;

/** The map's fragment (sunShadowMap.frag.glsl's WGSL): the caster point's height where its ray lands, and its id. */
const MAP_FRAGMENT_WGSL = `
${CASTER_ID_WGSL}
${MAP_TEXEL_WGSL}
// DX-SHADOW3D: a caster point's height where its sun ray lands, the highest kept by its depth (sunShadowMap.frag.glsl),
// which its vertices write.
@fragment
fn mainFragMap(in: VertexOut) -> @location(0) vec4<f32> {
  let t = textureSampleLevel(uTexture, uSampler, mix(in.vAtlasUV.xy, in.vAtlasUV.zw, in.vLocal), 0.0);
  if (t.a < 0.5) { discard; }
  return weedMapTexel(in.vSunZ, in.vSunId, in.vColor.g);
}
`;

/**
 * sunMapVertex's WGSL form (WebGPU): instancedSpriteShadow.wgsl with its card skipping a render's frames (its columns
 * cast it) and, with `heights`, its height passed on (vSunZ) and the map's fragment entry `mainFragMap`. Without, the
 * sprite shadows' own program that only skips those frames.
 * @param {string} source instancedSpriteShadow.wgsl
 * @param {{ heights?: boolean }} [opts]
 */
export function sunMapWgsl(source, { heights = true } = {}) {
  const struct = '  @location(5) vTileOff: vec2<f32>,\n';
  const card = '    // weed:sunCard\n';
  const out = '    // weed:sunOut\n';
  const color = '  out.vColor = vec4<f32>(0.0, 0.0, 0.0, alpha);\n';
  wgslMarks(source, [struct, card, out, color], 'the sun shadow map');
  const skipped = source.replace(
    card,
    `${card}    // A render's frame casts columns instead (sunMapColumnsWgsl), unless its sheet casts its card for the sun.
    if (sunKind >= 3 || sunKind == 2 || (sunKind == 0 && aInstBase.x < 0.0 && aInstBase.y >= 0.0)) {
      clipOff(&out, aQuad, aInstXY, aInstUV, aInstTileInv, aInstTileOff);
      return out;
    }
`,
  );
  if (!heights) return skipped;
  const body = ') -> VertexOut {\n  var out: VertexOut;\n';
  if (skipped.split(body).length !== 2) throw new Error('WeedJS: the sun shadow map needs the sprite shadow WGSL (mainVert)');
  return (
    skipped
      .replace(struct, `${struct}  @location(6) vSunZ: f32,\n  @location(8) @interpolate(flat) vSunId: f32,\n`)
      .replace(body, `${body}  out.vSunId = casterEntityId(aInstTintBits);\n`)
      .replace(out, `${out}    out.vSunZ = sunZ;\n`)
      .replace(color, `  out.vColor = vec4<f32>(1.0, castOpacity, 1.0, 1.0);\n  out.position.z = 1.0 - clamp(out.vSunZ / ${SUN_MAP_ZMAX}.0, 0.0, 1.0);\n`) + MAP_FRAGMENT_WGSL
  );
}

/**
 * sunMapColumnsVertex's WGSL form: a render's frame cast as columns, one a cell of the SUN_MAP_COLUMNS² grid (aCell
 * instead of aQuad), each where its cell is in 3D, down to the floor. With `heights` for the map (vSunZ, `mainFragMap`),
 * without for the sprite shadows' layer (the shadow's colour and opacity, the shadow program's `mainFrag`).
 * @param {string} source instancedSpriteShadow.wgsl
 * @param {number} [cells]
 * @param {{ heights?: boolean }} [opts]
 */
export function sunMapColumnsWgsl(source, cells = SUN_MAP_COLUMNS, { heights = true } = {}) {
  const card = sunMapWgsl(source, { heights });
  const quad = '  @location(0) aQuad: vec2<f32>,\n';
  const body = ') -> VertexOut {\n  var out: VertexOut;\n';
  const after = '  // weed:afterAnchor\n';
  const end = '  out.vTileOff = aInstTileOff;\n  return out;\n}\n';
  wgslMarks(card, [quad, body, after], 'the sun shadow map columns');
  const from = card.indexOf(after);
  const to = card.indexOf(end, from);
  if (to < 0) throw new Error('WeedJS: the sun shadow map columns need the sprite shadow WGSL (mainVert\'s end)');
  const head = card
    .slice(0, from)
    .replace(quad, "  @location(0) aCell: vec4<f32>, // the cell's centre in the frame, t (floor 0, top 1), side\n")
    .replace(body, `${body}  let aQuad = aCell.xy;\n`);
  const columns = `  let uvc = mix(aInstUV.xy, aInstUV.zw, aQuad);
  let m = textureLoad(uMaps, vec2<i32>(uvc * vec2<f32>(textureDimensions(uMaps, 0))), 0);
  let cellAlpha = textureLoad(uTexture, vec2<i32>(uvc * vec2<f32>(textureDimensions(uTexture, 0))), 0).a;
  let z = (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / 64.0 * height;
  let solid = sunKind == 2 || (sunKind == 0 && aInstBase.x < 0.0 && aInstBase.y >= 0.0);
  if (!solid || m.b + m.a <= 0.0 || cellAlpha < 0.5 || z < 0.5) {
    clipOff(&out, aQuad, aInstXY, aInstUV, aInstTileInv, aInstTileOff);
    return out;
  }
  let content = aInstTrim.xy + aQuad * aInstTrim.zw;
  let pix = aInstXY + (content - anchor * aInstSize) * aInstScale;
  let base = vec2<f32>(pix.x, (pix.y + uniforms.uSunK.w * z) * uniforms.uGroundInvScaleY);
  let cell = abs(aInstTrim.zw * aInstScale) / ${cells.toFixed(1)};
  let width = 1.1 * max(cell.x, cell.y * uniforms.uGroundInvScaleY) + 1.0;
  // A column, or with a footprint the cell swept north at its own height (sunMapColumnsVertex says why).
  var a = base;
  var b = base - z * uniforms.uSunK.xy;
  var zA = 0.0;
  if (aInstBase.y >= 1.0) {
    let north = aInstXY.y * uniforms.uGroundInvScaleY
      + footprintNorth(i32(aInstBase.y + 0.5) - 1, content.x - aInstAnchor.x * aInstSize.x) * abs(aInstScale.y);
    let halfCell = 0.5 * cell.y * uniforms.uGroundInvScaleY + 0.5;
    a = vec2<f32>(base.x, base.y + halfCell) - z * uniforms.uSunK.xy;
    b = vec2<f32>(base.x, min(north, base.y) - halfCell) - z * uniforms.uSunK.xy;
    zA = z;
  }
  let along = b - a;
  let len = length(along);
  var across = vec2<f32>(1.0, 0.0);
  if (len > 1e-3) { across = vec2<f32>(-along.y, along.x) / len; }
  let p = mix(a, b, aCell.z) + across * aCell.w * width;
  let world = vec2<f32>(p.x, p.y / uniforms.uGroundInvScaleY);
  let screen = (world - uniforms.uCam.xy) * uniforms.uCam.z;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let clip = mvp * vec3<f32>(screen, 1.0);
  out.position = vec4<f32>(clip.xy, 0.0, 1.0);
  if (abs(aInstRotCS.x) > 2.0) {
    out.position.x += aInstRotCS.y + aInstDepth + aInstTintBits;
  }
  out.vLocal = aQuad;
  out.vColor = ${heights ? 'vec4<f32>(1.0, castOpacity, 1.0, 1.0)' : 'vec4<f32>(0.0, 0.0, 0.0, uniforms.uSun.w * castOpacity)'};
  out.vWorld = world;
  out.vAtlasUV = aInstUV;
  out.vTileInv = aInstTileInv;
  out.vTileOff = aInstTileOff;${heights ? `\n  out.vSunZ = mix(zA, z, aCell.z);\n  out.position.z = 1.0 - clamp(out.vSunZ / ${SUN_MAP_ZMAX}.0, 0.0, 1.0);` : ''}
  return out;
}
`;
  return `${head}${columns}${card.slice(to + end.length)}`.replace(
    '@group(2) @binding(3) var<uniform> uniforms: ShadowUniforms;\n',
    `@group(2) @binding(3) var<uniform> uniforms: ShadowUniforms;\n// DX-MAPS: the atlas's twin page (a column's height).\n@group(2) @binding(5) var uMaps: texture_2d<f32>;\n${FOOTPRINT_WGSL}`,
  );
}

/**
 * DX-SHADOW3D (F6): VolumeShadowCaster's volumes in the sun's map: meshUvFill.vert.glsl, whose vertices already move by
 * their height (the U column) times uSunShadow.xy, passing that height on in the map's units (uSunShadow.w: 1 /
 * heightScaleY, the volumes' heights being screen px). Pixi sets uSunShadow.xy to the map's own landing shift.
 * @param {string} source meshUvFill.vert.glsl
 */
export function volumeMapVertex(source) {
  const decl = 'out vec2 vMeshUV;\n';
  const pos = 'gl_Position = vec4(clip.xy, aInstDepth, 1.0);';
  for (const mark of [decl, pos]) {
    if (source.split(mark).length !== 2) throw new Error(`WeedJS: the sun map's volumes need the mesh vertex shader (${mark.trim()})`);
  }
  return source
    .replace(decl, `${decl}out float vSunZ;\nflat out float vSunId;\n`)
    .replace(
      pos,
      `${pos}\n  vSunZ = (aUV0.x + aTri.x * (aUV1.x - aUV0.x) + aTri.y * (aUV2.x - aUV0.x)) * uSunShadow.w;\n  vSunId = float(int(aInstBody + 0.5) % 65535 + 1);\n  gl_Position.z = 1.0 - 2.0 * clamp(vSunZ / ${SUN_MAP_ZMAX}.0, 0.0, 1.0);`,
    );
}

/**
 * The volumes' fragment in the sun's map: the height and the volume's entity (sunShadowMap.frag.glsl without the
 * picture); the depth that keeps the highest comes from volumeMapVertex.
 */
export const VOLUME_MAP_FRAGMENT = `#version 300 es
precision highp float;
in float vSunZ;
flat in float vSunId;
out vec4 finalColor;
void main() {
  float h = clamp(vSunZ / ${SUN_MAP_ZMAX}.0, 0.0, 1.0);
  int id = int(vSunId + 0.5);
  finalColor = vec4(h, 1.0, float(id >> 8) / 255.0, float(id & 255) / 255.0);
}
`;

