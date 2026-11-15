/**
 * DX-SHADOW3D (plan §6.6, F7; option C): a lamp's shadow map in the floor's terms, the sun map's idea with a point light.
 * A point (x, y, z) under a lamp at floor point L and height E lands on the floor along the lamp's ray at
 *   L + ((x, y) - L) · E / (E - z),
 * and every point of one ray lands on the same floor point, the one nearest the lamp highest: a map that keeps the
 * highest caster point landing at each texel (max blending) holds what the lamp sees first, as the sun's does. A point
 * of the world is in the lamp's shadow when the map, where its own ray lands, holds something higher than it.
 *
 * One square tile a lamp (its radius around it, on the floor) in an atlas of tiles, instead of the five faces of a cube
 * (option A): a caster at or above the lamp's height lands at infinity and is left out (it cannot shade anything below
 * the lamp's height from it). The casters are pre-render's stamp rows, already picked for each lamp.
 */

/** The highest height a tile's 8 bits span, as the sun map's (2 px a step). */
export const LAMP_MAP_ZMAX = 512;
/** A caster point this close under the lamp's height (px) lands no farther than this many radii (a stretch cap). */
export const LAMP_MAP_MAX_STRETCH = 8;

/**
 * Where a point lands on the floor along a lamp's ray, in the floor's space (x, y on the floor, z up).
 * @param {number} x
 * @param {number} y
 * @param {number} z the point's height (px); at or above the lamp's height it lands at its own floor point, stretched
 *   no more than LAMP_MAP_MAX_STRETCH (callers leave such points out)
 * @param {number} lx the lamp's floor point
 * @param {number} ly
 * @param {number} elevation the lamp's height (px)
 * @param {Float64Array|number[]} out x, y
 */
export function lampLanding(x, y, z, lx, ly, elevation, out) {
  const room = elevation - z;
  const k = room > elevation / LAMP_MAP_MAX_STRETCH ? elevation / room : LAMP_MAP_MAX_STRETCH;
  out[0] = lx + (x - lx) * k;
  out[1] = ly + (y - ly) * k;
  return out;
}

/**
 * The lamps' tile atlas: `count` square tiles of `size` texels, as many a row as fit `maxSide`.
 * @returns {{ perRow: number, width: number, height: number, size: number }}
 */
export function lampTileLayout(count, size, maxSide = 4096) {
  const n = Math.max(1, count | 0);
  const s = Math.max(1, size | 0);
  const perRow = Math.max(1, Math.min(n, Math.floor(maxSide / s)));
  return { perRow, width: perRow * s, height: Math.ceil(n / perRow) * s, size: s };
}

/**
 * A floor point's texel in lamp `slot`'s tile (its radius `range` around the lamp, floor px): the tile's own 0..1
 * coordinates, or null outside it.
 * @returns {[number, number] | null}
 */
export function lampTileUv(x, y, lx, ly, range) {
  const u = (x - lx) / (2 * range) + 0.5;
  const v = (y - ly) / (2 * range) + 0.5;
  return u < 0 || v < 0 || u >= 1 || v >= 1 ? null : [u, v];
}

/** Cells across (and down) a render's frame when it casts columns towards a lamp: the sun's grid. */
export const LAMP_MAP_COLUMNS = 24;

/**
 * Whether a lamp casts its shadows into the lamps' map: it has a tile, a height and a reach. The light pass's twin of the
 * programs' early out (a lamp at the floor's height lights everything that has height from below: it casts none).
 * @param {number} tile the stamp light index (-1: none)
 * @param {number} elevation
 * @param {number} reach
 */
export function lampCasts(tile, elevation, reach) {
  return tile >= 0 && elevation > 0 && reach > 0;
}

/**
 * The lamps' tile data texel of tile `t` (RGBA32F, one texel a tile, uLampTiles): the lamp's floor point (y over
 * groundScaleY), its height and its reach (floor px); a tile that casts nothing has 0 reach.
 * @param {Float32Array} out
 * @param {number} t
 */
export function writeLampTile(out, t, x, floorY, elevation, reach) {
  const at = t * 4;
  const casts = elevation > 0 && reach > 0;
  out[at] = x;
  out[at + 1] = floorY;
  out[at + 2] = casts ? elevation : 0;
  out[at + 3] = casts ? reach : 0;
}

/** The light data's tag for a light with a tile in the lamps' map: its first row's w, -(tile + 1) (rangeSq otherwise). */
export function lampTileTag(tile) {
  return -(tile + 1);
}

const LAMP_DECL_GLSL = 'out float vSunZ;\nout vec3 vTileUvW;\nuniform sampler2D uLampTiles;\n';

// The tile, its lamp and the early out, in GLSL; `extra` adds conditions (the columns' cell tests).
const lampTileGlsl = (extra) => `  // DX-SHADOW3D (F7): this row's lamp (lampShadowMap.js). The stamp row's light z holds its tile + 1 (Pixi writes it), and
  // uLampTiles the tile's lamp: its floor point (y over groundScaleY), height and reach (floor px).
  int tile = int(aInstLight.z + 0.5) - 1;
  vec4 lamp = tile >= 0 ? texelFetch(uLampTiles, ivec2(tile, 0), 0) : vec4(0.0);
  if (tile < 0 || lamp.z <= 0.0 || lamp.w <= 0.0${extra}) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    vColor = vec4(0.0);
    vLocal = aQuad;
    vWorld = aInstXY;
    vAtlasUV = aInstUV;
    vTileInv = aInstTileInv;
    vTileOff = aInstTileOff;
    return;
  }
`;

// A landed point into the lamp's tile of the atlas (uTileWorld: tiles a row, a tile's texels), drawn with w = 1 / its
// stretch: the lamp's rays make a projective map, and with w the picture (and the height between its rows) spreads over
// its shadow as they carry it. vTileUvW keeps the tile's own coordinates for the fragment's clip, read as screen-linear.
const LAMP_OUT_GLSL = `  vec2 tuv = (land - lamp.xy) / (2.0 * lamp.w) + 0.5;
  int perRow = int(uTileWorld.x);
  vec2 px = (vec2(float(tile % perRow), float(tile / perRow)) + tuv) * uTileWorld.y;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 clip = mvp * vec3(px, 1.0);
  gl_Position = vec4(clip.xy * w, 0.0, w);
  if (abs(aInstRotCS.x) > 2.0) gl_Position.x += aInstRotCS.y + aInstDepth + aInstTintBits;
  vTileUvW = vec3(tuv * w, w);
  vColor = vec4(1.0);
  vLocal = aQuad;
  vWorld = aInstXY;
  vAtlasUV = aInstUV;
  vTileInv = aInstTileInv;
  vTileOff = aInstTileOff;
}
`;

/** The source's head up to its anchor, with the lamp map's declarations and the outputs' defaults. */
function lampHeadGlsl(source, what) {
  const decl = 'uniform vec4 uSunPerp;\n';
  const main = 'void main() {\n';
  const after = '  // weed:afterAnchor\n';
  for (const mark of [decl, main, after]) {
    if (source.split(mark).length !== 2) throw new Error(`WeedJS: ${what} needs the sprite shadow vertex shader (${mark.trim()})`);
  }
  return source
    .slice(0, source.indexOf(after))
    .replace(decl, `${decl}${LAMP_DECL_GLSL}`)
    .replace(main, `${main}  vSunZ = 0.0;\n  vTileUvW = vec3(-1.0, -1.0, 1.0);\n`);
}

/**
 * The lamps' map's vertex shader for cards (instancedSpriteShadow.vert.glsl's head, its own body): each stamp row's
 * caster as a card standing on its base (frameBase.js), facing its lamp, each point of the picture landing on the floor
 * along the lamp's ray (lampLanding), in the lamp's tile; its height passed on (vSunZ) for the max blending. A render's
 * frame (its base a contact) casts columns instead (lampMapColumnsVertex).
 * @param {string} source instancedSpriteShadow.vert.glsl
 */
export function lampMapVertex(source) {
  return `${lampHeadGlsl(source, 'the lamps\' shadow map')}${lampTileGlsl(' || lampKind >= 3 || lampKind == 2 || (lampKind == 0 && aInstBase.x < 0.0)')}  vec2 content = aInstTrim.xy + aQuad * aInstTrim.zw;
  float bottom = aInstTrim.y + aInstTrim.w;
  float z = max(bottom - content.y, 0.0) * abs(aInstScale.y) / uSunK.w * height;
  // The picture's column at the card's foot, and the foot: under the lowest row, or the base's edge towards the lamp.
  float footCol = anchor.x * aInstSize.x;
  vec2 foot = vec2(aInstXY.x, (aInstXY.y + (bottom - aInstAnchor.y * aInstSize.y) * aInstScale.y) * uGroundInvScaleY);
  if (aInstBase.x >= 1.0) {
    float rx = abs(aInstBase.y) * abs(aInstScale.x);
    float ry = (aInstBase.y < 0.0 ? -aInstBase.y : 0.6 * aInstBase.y) * abs(aInstScale.y);
    footCol = aInstBase.x - 1.0;
    foot.x = aInstXY.x + (footCol - aInstAnchor.x * aInstSize.x) * aInstScale.x;
    foot.y -= ry;
    vec2 tc = lamp.xy - foot;
    float tl = length(tc);
    vec2 u = tl > 1e-3 ? tc / tl : vec2(0.0, -1.0);
    foot += u * sqrt(rx * rx * u.x * u.x + ry * ry * u.y * u.y);
  } else if (aInstBase.x < 0.0) {
    // A render asked to cast its card (DX-CASTER): on its contact, that far from the anchor towards the lamp.
    vec2 anchorFloor = vec2(aInstXY.x, aInstXY.y * uGroundInvScaleY);
    vec2 tl = lamp.xy - anchorFloor;
    float tlen = length(tl);
    float reach = (-aInstBase.x - 1.0 - aInstAnchor.y * aInstSize.y) * abs(aInstScale.y) * uGroundInvScaleY;
    foot = anchorFloor + (tlen > 1e-3 ? tl / tlen : vec2(0.0, -1.0)) * reach;
  }
  // Its columns run across the lamp (to the right of someone at the lamp looking at it).
  if (castFixed) {
    // DX-CASTER: a fixed card stands along the object through its anchor.
    foot = vec2(aInstXY.x, aInstXY.y * uGroundInvScaleY);
    footCol = aInstAnchor.x * aInstSize.x;
  }
  vec2 toLamp = lamp.xy - foot;
  float dl = length(toLamp);
  vec2 dir = dl > 1e-3 ? toLamp / dl : vec2(0.0, -1.0);
  vec2 p = foot + (content.x - footCol) * aInstScale.x * (castFixed ? castAxis : vec2(dir.y, -dir.x));
  float room = lamp.z - z;
  float w = room > lamp.z * ${(1 / LAMP_MAP_MAX_STRETCH).toFixed(6)} ? room / lamp.z : ${(1 / LAMP_MAP_MAX_STRETCH).toFixed(6)};
  vec2 land = lamp.xy + (p - lamp.xy) / w;
  vSunZ = z;
${LAMP_OUT_GLSL}`;
}

/**
 * The lamps' map's vertex shader for a render's columns (sunMapColumnsVertex's grid): each cell of the frame where it is
 * in 3D, the column under it from its floor point to where its top lands along the lamp's ray.
 * @param {string} source instancedSpriteShadow.vert.glsl
 * @param {number} [cells]
 */
export function lampMapColumnsVertex(source, cells = LAMP_MAP_COLUMNS) {
  const quad = 'in vec2 aQuad;\n';
  const main = 'void main() {\n';
  const head = lampHeadGlsl(source, 'the lamps\' shadow map columns');
  if (head.split(quad).length !== 2 || head.split(main).length !== 2) {
    throw new Error('WeedJS: the lamps\' shadow map columns need the sprite shadow vertex shader (aQuad, main)');
  }
  const top = head
    .replace(quad, 'in vec4 aCell; // the cell\'s centre in the frame, t (floor 0, top 1), side\nvec2 aQuad;\nuniform sampler2D uTexture;\nuniform sampler2D uMaps;\n')
    .replace(main, `${main}  aQuad = aCell.xy;\n`);
  const k = (1 / LAMP_MAP_MAX_STRETCH).toFixed(6);
  return `${top}  vec2 uvc = mix(aInstUV.xy, aInstUV.zw, aQuad);
  vec4 m = texelFetch(uMaps, ivec2(uvc * vec2(textureSize(uMaps, 0))), 0);
  float cellAlpha = texelFetch(uTexture, ivec2(uvc * vec2(textureSize(uTexture, 0))), 0).a;
  float z = (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / 64.0 * height;
${lampTileGlsl(' || lampKind >= 3 || lampKind == 1 || (lampKind == 0 && aInstBase.x >= 0.0) || m.b + m.a <= 0.0 || cellAlpha < 0.5 || z < 0.5')}  vec2 content = aInstTrim.xy + aQuad * aInstTrim.zw;
  vec2 pix = aInstXY + (content - anchor * aInstSize) * aInstScale;
  vec2 base = vec2(pix.x, (pix.y + uSunK.w * z) * uGroundInvScaleY);
  float roomTop = lamp.z - z;
  vec2 tip = lamp.xy + (base - lamp.xy) / (roomTop > lamp.z * ${k} ? roomTop / lamp.z : ${k});
  vec2 along = tip - base;
  float len = length(along);
  vec2 across = len > 1e-3 ? vec2(-along.y, along.x) / len : vec2(1.0, 0.0);
  vec2 cell = abs(aInstTrim.zw * aInstScale) / ${cells.toFixed(1)};
  float width = 1.1 * max(cell.x, cell.y * uGroundInvScaleY) + 1.0;
  float h = z * aCell.z;
  float room = lamp.z - h;
  float w = room > lamp.z * ${k} ? room / lamp.z : ${k};
  vec2 land = lamp.xy + (base - lamp.xy) / w + across * aCell.w * width;
  vSunZ = h;
${LAMP_OUT_GLSL}`;
}

/**
 * The lamps' map's fragment (GLSL): the sun map's (sunShadowMap.frag.glsl: the silhouette's height, max blending), cut
 * to the row's tile.
 * @param {string} sunMapFrag sunShadowMap.frag.glsl
 */
export function lampMapFragment(sunMapFrag) {
  const varying = 'in float vSunZ;\n';
  const main = 'void main() {\n';
  for (const mark of [varying, main]) {
    if (sunMapFrag.split(mark).length !== 2) throw new Error(`WeedJS: the lamps' shadow map needs the sun map's fragment (${mark.trim()})`);
  }
  return sunMapFrag
    .replace(varying, `${varying}in vec3 vTileUvW;\n`)
    .replace(
      main,
      `${main}  vec2 tuv = vTileUvW.xy / vTileUvW.z;\n  if (tuv.x < 0.0 || tuv.y < 0.0 || tuv.x >= 1.0 || tuv.y >= 1.0) discard;\n`,
    );
}

const LAMP_FRAGMENT_WGSL = `
// DX-SHADOW3D (F7): a caster point's height where its lamp's ray lands, in that lamp's tile, max blending.
@fragment
fn mainFragLamp(in: VertexOut) -> @location(0) vec4<f32> {
  let tuv = in.vTileUvW.xy / in.vTileUvW.z;
  if (tuv.x < 0.0 || tuv.y < 0.0 || tuv.x >= 1.0 || tuv.y >= 1.0) { discard; }
  let t = textureSampleLevel(uTexture, uSampler, mix(in.vAtlasUV.xy, in.vAtlasUV.zw, in.vLocal), 0.0);
  if (t.a < 0.5) { discard; }
  return vec4<f32>(clamp(in.vSunZ / ${LAMP_MAP_ZMAX}.0, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

const lampTileWgsl = (extra) => `  // DX-SHADOW3D (F7): this row's lamp (lampMapVertex says how).
  let tile = i32(aInstLight.z + 0.5) - 1;
  var lamp = vec4<f32>(0.0);
  if (tile >= 0) { lamp = textureLoad(uLampTiles, vec2<i32>(tile, 0), 0); }
  if (tile < 0 || lamp.z <= 0.0 || lamp.w <= 0.0${extra}) {
    clipOff(&out, aQuad, aInstXY, aInstUV, aInstTileInv, aInstTileOff);
    out.vTileUvW = vec3<f32>(-1.0, -1.0, 1.0);
    return out;
  }
`;

const LAMP_OUT_WGSL = `  let tuv = (land - lamp.xy) / (2.0 * lamp.w) + 0.5;
  let perRow = i32(uniforms.uTileWorld.x);
  let px = (vec2<f32>(f32(tile % perRow), f32(tile / perRow)) + tuv) * uniforms.uTileWorld.y;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let clip = mvp * vec3<f32>(px, 1.0);
  out.position = vec4<f32>(clip.xy * w, 0.0, w);
  if (abs(aInstRotCS.x) > 2.0) {
    out.position.x += aInstRotCS.y + aInstDepth + aInstTintBits;
  }
  out.vTileUvW = vec3<f32>(tuv * w, w);
  out.vColor = vec4<f32>(1.0);
  out.vLocal = aQuad;
  out.vWorld = aInstXY;
  out.vAtlasUV = aInstUV;
  out.vTileInv = aInstTileInv;
  out.vTileOff = aInstTileOff;
  return out;
}
`;

/** The WGSL source split around mainVert's body: its head to the anchor (lamp outputs and binding in), and its rest. */
function lampPartsWgsl(source, what) {
  const struct = '  @location(5) vTileOff: vec2<f32>,\n';
  const after = '  // weed:afterAnchor\n';
  const end = '  out.vTileOff = aInstTileOff;\n  return out;\n}\n';
  const binding = '@group(2) @binding(3) var<uniform> uniforms: ShadowUniforms;\n';
  for (const mark of [struct, after, binding]) {
    if (source.split(mark).length !== 2) throw new Error(`WeedJS: ${what} needs the sprite shadow WGSL (${mark.trim()})`);
  }
  const from = source.indexOf(after);
  const to = source.indexOf(end, from);
  if (to < 0) throw new Error(`WeedJS: ${what} needs the sprite shadow WGSL (mainVert's end)`);
  const head = source
    .slice(0, from)
    .replace(struct, `${struct}  @location(6) vSunZ: f32,\n  @location(7) vTileUvW: vec3<f32>,\n`)
    .replace(binding, `${binding}// DX-SHADOW3D (F7): the lamps' tiles: a lamp's floor point, height and reach (lampShadowMap.js).\n@group(2) @binding(6) var uLampTiles: texture_2d<f32>;\n`);
  return { head, rest: source.slice(to + end.length) };
}

/**
 * lampMapVertex's WGSL form (WebGPU): instancedSpriteShadow.wgsl's head with the lamp card, and the map's fragment entry
 * `mainFragLamp`.
 * @param {string} source instancedSpriteShadow.wgsl
 */
export function lampMapWgsl(source) {
  const { head, rest } = lampPartsWgsl(source, 'the lamps\' shadow map');
  const k = (1 / LAMP_MAP_MAX_STRETCH).toFixed(6);
  return `${head}${lampTileWgsl(' || lampKind >= 3 || lampKind == 2 || (lampKind == 0 && aInstBase.x < 0.0)')}  let content = aInstTrim.xy + aQuad * aInstTrim.zw;
  let bottom = aInstTrim.y + aInstTrim.w;
  let z = max(bottom - content.y, 0.0) * abs(aInstScale.y) / uniforms.uSunK.w * height;
  var footCol = anchor.x * aInstSize.x;
  var foot = vec2<f32>(aInstXY.x, (aInstXY.y + (bottom - aInstAnchor.y * aInstSize.y) * aInstScale.y) * uniforms.uGroundInvScaleY);
  if (aInstBase.x >= 1.0) {
    let rx = abs(aInstBase.y) * abs(aInstScale.x);
    let ry = select(0.6 * aInstBase.y, -aInstBase.y, aInstBase.y < 0.0) * abs(aInstScale.y);
    footCol = aInstBase.x - 1.0;
    foot.x = aInstXY.x + (footCol - aInstAnchor.x * aInstSize.x) * aInstScale.x;
    foot.y -= ry;
    let tc = lamp.xy - foot;
    let tl = length(tc);
    var u = vec2<f32>(0.0, -1.0);
    if (tl > 1e-3) { u = tc / tl; }
    foot += u * sqrt(rx * rx * u.x * u.x + ry * ry * u.y * u.y);
  } else if (aInstBase.x < 0.0) {
    // A render asked to cast its card (lampMapVertex says how).
    let anchorFloor = vec2<f32>(aInstXY.x, aInstXY.y * uniforms.uGroundInvScaleY);
    let tl = lamp.xy - anchorFloor;
    let tlen = length(tl);
    var tdir = vec2<f32>(0.0, -1.0);
    if (tlen > 1e-3) { tdir = tl / tlen; }
    let reach = (-aInstBase.x - 1.0 - aInstAnchor.y * aInstSize.y) * abs(aInstScale.y) * uniforms.uGroundInvScaleY;
    foot = anchorFloor + tdir * reach;
  }
  if (castFixed) {
    foot = vec2<f32>(aInstXY.x, aInstXY.y * uniforms.uGroundInvScaleY);
    footCol = aInstAnchor.x * aInstSize.x;
  }
  let toLamp = lamp.xy - foot;
  let dl = length(toLamp);
  var dir = vec2<f32>(0.0, -1.0);
  if (dl > 1e-3) { dir = toLamp / dl; }
  let p = foot + (content.x - footCol) * aInstScale.x * select(vec2<f32>(dir.y, -dir.x), castAxis, castFixed);
  let room = lamp.z - z;
  let w = select(${k}, room / lamp.z, room > lamp.z * ${k});
  let land = lamp.xy + (p - lamp.xy) / w;
  out.vSunZ = z;
${LAMP_OUT_WGSL}${rest}${LAMP_FRAGMENT_WGSL}`;
}

/**
 * lampMapColumnsVertex's WGSL form: a render's columns towards its lamp (aCell instead of aQuad), `mainFragLamp`.
 * @param {string} source instancedSpriteShadow.wgsl
 * @param {number} [cells]
 */
export function lampMapColumnsWgsl(source, cells = LAMP_MAP_COLUMNS) {
  const parts = lampPartsWgsl(source, 'the lamps\' shadow map columns');
  const quad = '  @location(0) aQuad: vec2<f32>,\n';
  const body = ') -> VertexOut {\n  var out: VertexOut;\n';
  if (parts.head.split(quad).length !== 2 || parts.head.split(body).length !== 2) {
    throw new Error('WeedJS: the lamps\' shadow map columns need the sprite shadow WGSL (aQuad, mainVert)');
  }
  const head = parts.head
    .replace(quad, "  @location(0) aCell: vec4<f32>, // the cell's centre in the frame, t (floor 0, top 1), side\n")
    .replace(body, `${body}  let aQuad = aCell.xy;\n`)
    .replace(
      '@group(2) @binding(6) var uLampTiles: texture_2d<f32>;\n',
      // uFoot is declared though no lamp column reads it: the program's layout names binding 7 (sunShadowGpuProgram with
      // maps), and Pixi files a resource by the WGSL's declarations. Undeclared, it went to a spare group and group 2
      // had no binding 7, which Pixi reports as "the resource bound as 'uFoot' was destroyed".
      "@group(2) @binding(6) var uLampTiles: texture_2d<f32>;\n// DX-MAPS: the atlas's twin page (a column's height).\n@group(2) @binding(5) var uMaps: texture_2d<f32>;\n// DX-SHADOW3D: the renders' footprints (the layout's binding 7; unread here).\n@group(2) @binding(7) var uFoot: texture_2d<f32>;\n",
    );
  const k = (1 / LAMP_MAP_MAX_STRETCH).toFixed(6);
  return `${head}  let uvc = mix(aInstUV.xy, aInstUV.zw, aQuad);
  let m = textureLoad(uMaps, vec2<i32>(uvc * vec2<f32>(textureDimensions(uMaps, 0))), 0);
  let cellAlpha = textureLoad(uTexture, vec2<i32>(uvc * vec2<f32>(textureDimensions(uTexture, 0))), 0).a;
  let z = (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / 64.0 * height;
${lampTileWgsl(' || lampKind >= 3 || lampKind == 1 || (lampKind == 0 && aInstBase.x >= 0.0) || m.b + m.a <= 0.0 || cellAlpha < 0.5 || z < 0.5')}  let content = aInstTrim.xy + aQuad * aInstTrim.zw;
  let pix = aInstXY + (content - anchor * aInstSize) * aInstScale;
  let base = vec2<f32>(pix.x, (pix.y + uniforms.uSunK.w * z) * uniforms.uGroundInvScaleY);
  let roomTop = lamp.z - z;
  let tip = lamp.xy + (base - lamp.xy) / select(${k}, roomTop / lamp.z, roomTop > lamp.z * ${k});
  let along = tip - base;
  let len = length(along);
  var across = vec2<f32>(1.0, 0.0);
  if (len > 1e-3) { across = vec2<f32>(-along.y, along.x) / len; }
  let cell = abs(aInstTrim.zw * aInstScale) / ${cells.toFixed(1)};
  let width = 1.1 * max(cell.x, cell.y * uniforms.uGroundInvScaleY) + 1.0;
  let h = z * aCell.z;
  let room = lamp.z - h;
  let w = select(${k}, room / lamp.z, room > lamp.z * ${k});
  let land = lamp.xy + (base - lamp.xy) / w + across * aCell.w * width;
  out.vSunZ = h;
${LAMP_OUT_WGSL}${parts.rest}${LAMP_FRAGMENT_WGSL}`;
}
