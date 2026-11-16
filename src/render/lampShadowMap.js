/**
 * DX-SHADOW3D (plan §6.6, F7; option C): a lamp's shadow map in the floor's terms, the sun map's idea with a point light.
 * A point (x, y, z) under a lamp at floor point L and height E lands on the floor along the lamp's ray at
 *   L + ((x, y) - L) · E / (E - z),
 * and every point of one ray lands on the same floor point, the one nearest the lamp highest: a map that keeps the
 * highest caster point landing at each texel (max blending) holds what the lamp sees first, as the sun's does. A point
 * of the world is in the lamp's shadow when the map, where its own ray lands, holds something higher than it.
 *
 * DX-LAMPPANO (plan §17.8): a panorama of the lamp in two halves. Each lamp's tile is 2S x S texels: its left half (the
 * floor) for what is lower than the lamp, as above; its right half (the ceiling) for what is higher, the same map for the
 * world mirrored in the lamp's height (a point at z > E drawn at z' = 2E - z, its ray the mirror of an upward one). There
 * the depth test keeps the point nearest the lamp's height, the lowest, and the texel its real height: a point above the
 * lamp is in its shadow when something lower than it lands where its own mirrored ray does. A landing R from the lamp goes
 * into its half linearly to LAMP_PANO_INNER of the half's radius within the reach, and the rest of the world, out to the
 * horizon, into the ring left (lampPanoUv): no stretch cap, a point at the lamp's height lands at the half's edge. The
 * casters are pre-render's stamp rows, already picked for each lamp.
 */

import { CASTER_ID_GLSL, CASTER_ID_WGSL, MAP_TEXEL_WGSL } from './sunShadowMap.js';

/** The highest height a tile's 8 bits spanned, as the sun map's (2 px a step); N-211: the volumes' fragment scale. */
export const LAMP_MAP_ZMAX = 512;

/**
 * N-211: what a lamps' map texel keeps of a caster point: its place along its lamp's ray, 1 / (1 + |E - z| / E) (1 at the
 * lamp's height, 1/2 on the floor, falling away from the lamp's height on both halves), in 8 bits. The point nearest the
 * lamp on a ray keeps the most; a point is in a caster's shade when its texel holds more than its own. Near the lamp's
 * height the rays are nearly level, where heights in 2 px steps could not tell a person from the wall behind them; there
 * this spends its steps (a 20 px lamp: 0.13 px a step around its height).
 * @param {number} z the point's height
 * @param {number} elevation the lamp's height
 */
export function lampRayDepth(z, elevation) {
  return 1 / (1 + Math.abs(elevation - z) / elevation);
}
/**
 * DX-LAMPPANO: the most a vertex's landing is drawn stretched (w at least its inverse), which also spans the depth that
 * keeps the point nearest the lamp's height: points nearer to it than 1/64 of its height tie.
 */
export const LAMP_MAP_MAX_STRETCH = 64;
/** DX-LAMPPANO: the share of a half tile's radius the lamp's reach takes; the ring left holds the world out to the horizon. */
export const LAMP_PANO_INNER = 0.8;

/**
 * E-374: the clip z that keeps a tile's highest caster point by the depth test, for a vertex drawn with w (a point at
 * height z under a lamp at height E: w = (E - z) / E, at least 1 / LAMP_MAP_MAX_STRETCH; in the ceiling half z is the
 * mirrored height). The rasterizer interpolates 1 / w exactly across a card, so a depth affine in 1 / w is each fragment's
 * own, (S - 1 / w) / (S - 1): 1 on the floor, 0 at the lamp's height. DX-LAMPPANO: within the reach a landing is the
 * projection; in the ring past it the vertices' depths are interpolated (its rows are not one projective map). The
 * fragments then write no depth, which would turn the early depth test off for the whole pass. NDC z is 2 depth - 1 on
 * WebGL and the depth on WebGPU; clip z is that times w.
 * @param {string} w the vertex's w (a GLSL or WGSL expression)
 */
export function lampClipZGlsl(w) {
  const s = LAMP_MAP_MAX_STRETCH;
  return `(${(s + 1).toFixed(1)} * ${w} - 2.0) / ${(s - 1).toFixed(1)}`;
}

/** lampClipZGlsl's WGSL form (WebGPU's NDC z runs 0..1). */
export function lampClipZWgsl(w) {
  const s = LAMP_MAP_MAX_STRETCH;
  return `(${s.toFixed(1)} * ${w} - 1.0) / ${(s - 1).toFixed(1)}`;
}

/**
 * Where a point lands on the floor along a lamp's ray, in the floor's space (x, y on the floor, z up).
 * @param {number} x
 * @param {number} y
 * @param {number} z the point's height (px); DX-LAMPPANO: above the lamp it lands as its mirror (2E - z) does, and
 *   within 1/64 of the lamp's height LAMP_MAP_MAX_STRETCH times as far
 * @param {number} lx the lamp's floor point
 * @param {number} ly
 * @param {number} elevation the lamp's height (px)
 * @param {Float64Array|number[]} out x, y
 */
export function lampLanding(x, y, z, lx, ly, elevation, out) {
  const room = Math.abs(elevation - z);
  const k = room > elevation / LAMP_MAP_MAX_STRETCH ? elevation / room : LAMP_MAP_MAX_STRETCH;
  out[0] = lx + (x - lx) * k;
  out[1] = ly + (y - ly) * k;
  return out;
}

/**
 * DX-LAMPPANO: a landing's place in its half tile, 0..1 each way, from its offset (dx, dy) to the lamp on the floor:
 * linearly to LAMP_PANO_INNER of the half's radius within `reach`, beyond it LAMP_PANO_INNER + (1 - LAMP_PANO_INNER)
 * (1 - reach / R), the horizon at the half's edge. The shaders' lampPanoUv.
 * @param {Float64Array|number[]} out u, v
 */
export function lampPanoUv(dx, dy, reach, out) {
  const r = Math.sqrt(dx * dx + dy * dy);
  const q = r / reach;
  const c = q <= 1 ? LAMP_PANO_INNER * q : LAMP_PANO_INNER + (1 - LAMP_PANO_INNER) * (1 - 1 / q);
  const k = r > 1e-4 ? (0.5 * c) / r : 0;
  out[0] = 0.5 + dx * k;
  out[1] = 0.5 + dy * k;
  return out;
}

/**
 * DX-LAMPPANO: where a world point reads a lamp's tile: its half (0 the floor, lower than the lamp; 1 the ceiling, higher)
 * and its place there (lampPanoUv of its landing). The light pass's lookup, in JS.
 * @returns {{ half: number, u: number, v: number }}
 */
export function lampPanoTexel(x, y, z, lx, ly, elevation, reach) {
  const land = lampLanding(x, y, z, lx, ly, elevation, new Float64Array(2));
  const uv = lampPanoUv(land[0] - lx, land[1] - ly, reach, new Float64Array(2));
  return { half: z > elevation ? 1 : 0, u: uv[0], v: uv[1] };
}

/**
 * The lamps' tile atlas: `count` tiles of 2 `size` x `size` texels (DX-LAMPPANO: the floor half and the ceiling half),
 * as many a row as fit `maxSide`.
 * @returns {{ perRow: number, width: number, height: number, size: number }}
 */
export function lampTileLayout(count, size, maxSide = 4096) {
  const n = Math.max(1, count | 0);
  const s = Math.max(1, size | 0);
  const perRow = Math.max(1, Math.min(n, Math.floor(maxSide / (2 * s))));
  return { perRow, width: perRow * 2 * s, height: Math.ceil(n / perRow) * s, size: s };
}

/** N-196, lampShadowTile 'auto': the floor px a lamp map texel spans at most at lighting.shadowResolution 1. */
export const LAMP_TEXEL_FLOOR_PX = 2;
/** The lamps' map's texels at most with lampShadowTile 'auto' (its tiles together: a 4096 x 2048 atlas). */
export const LAMP_MAP_MAX_TEXELS = 4096 * 2048;

/**
 * N-196, lampShadowTile 'auto': a half tile's side, a power of two from 64 to 1024, at which the widest casting lamp's reach
 * (its diameter on LAMP_PANO_INNER of the half: DX-LAMPPANO) spans at most LAMP_TEXEL_FLOOR_PX / resolution floor px a
 * texel, as far as `tiles` such tiles (two halves each) fit LAMP_MAP_MAX_TEXELS and `maxSide`. A fixed 256 drew a lamp of reach 900 at 7 floor px a texel whatever the
 * shadows' resolution.
 * @param {number} maxReach the widest casting lamp's reach (floor px)
 * @param {number} resolution lighting.shadowResolution
 * @param {number} tiles the tiles the map holds
 */
export function autoLampTileSize(maxReach, resolution, tiles, maxSide = 4096) {
  const want = (2 * Math.max(0, maxReach) * Math.max(0.05, resolution)) / (LAMP_TEXEL_FLOOR_PX * LAMP_PANO_INNER);
  let size = 64;
  while (size < 1024 && size < want) size *= 2;
  for (;;) {
    if (size <= 64) return 64;
    const l = lampTileLayout(tiles, size, maxSide);
    if (l.height <= maxSide && l.width * l.height <= LAMP_MAP_MAX_TEXELS) return size;
    size /= 2;
  }
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
 * The lamps' tile data texel of tile `t` (RGBA32F, one texel a tile in row 0, uLampTiles): the lamp's floor point (y
 * over groundScaleY), its height and its reach (floor px); a tile that casts nothing has 0 reach.
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

/**
 * E-389: tile `t`'s owner, below its lamp in the tiles' texture (row 1 of a texture `width` texels wide): the entity
 * whose own volume casts nothing for the lamp (x; -1 none), read by the lamps' map volumes' one draw for every tile.
 * @param {Float32Array} out
 * @param {number} width the texture's width (its rows' texels)
 * @param {number} t
 * @param {number} entity
 */
export function writeLampTileOwner(out, width, t, entity) {
  const at = (width + t) * 4;
  out[at] = entity;
  out[at + 1] = 0;
  out[at + 2] = 0;
  out[at + 3] = 0;
}

/** The light data's tag for a light with a tile in the lamps' map: its first row's w, -(tile + 1) (rangeSq otherwise). */
export function lampTileTag(tile) {
  return -(tile + 1);
}

/** DX-LAMPPANO: lampPanoUv in GLSL (the light pass's lightingBasic.frag.glsl has its twin). */
export const LAMP_PANO_GLSL = `// DX-LAMPPANO: a landing (its offset from the lamp on the floor) into its half tile, 0..1: linearly to ${LAMP_PANO_INNER} of
// the half's radius within the reach, the rest of the world beyond it, the horizon at the half's edge (lampShadowMap.js).
vec2 lampPanoUv(vec2 v, float reach) {
  float r = length(v);
  float q = r / reach;
  float c = q <= 1.0 ? ${LAMP_PANO_INNER.toFixed(2)} * q : ${LAMP_PANO_INNER.toFixed(2)} + ${(1 - LAMP_PANO_INNER).toFixed(2)} * (1.0 - 1.0 / q);
  return vec2(0.5) + (r > 1e-4 ? v * (0.5 * c / r) : vec2(0.0));
}
`;

/** DX-LAMPPANO: lampPanoUv in WGSL. */
export const LAMP_PANO_WGSL = `// DX-LAMPPANO: a landing into its half tile, 0..1 (lampShadowMap.js lampPanoUv).
fn lampPanoUv(v: vec2<f32>, reach: f32) -> vec2<f32> {
  let r = length(v);
  let q = r / reach;
  let c = select(${LAMP_PANO_INNER.toFixed(2)} + ${(1 - LAMP_PANO_INNER).toFixed(2)} * (1.0 - 1.0 / q), ${LAMP_PANO_INNER.toFixed(2)} * q, q <= 1.0);
  var off = vec2<f32>(0.0);
  if (r > 1e-4) { off = v * (0.5 * c / r); }
  return vec2<f32>(0.5) + off;
}
`;

// DX-GBUF: the caster's entity goes on with its height (sunShadowMap.js CASTER_ID_GLSL), kept by the map's depth test.
const LAMP_DECL_GLSL = `out float vSunZ;\nout vec3 vTileUvW;\nflat out float vSunId;\nflat out float vLampE;\nuniform sampler2D uLampTiles;\n${CASTER_ID_GLSL}${LAMP_PANO_GLSL}`;

/**
 * DX-LAMPPANO: a caster's three rows in a half (GLSL and WGSL alike): from `zAll`, the height its picture or column
 * reaches, and `dist`, its floor point's distance to the lamp: the band of heights this half draws in its own terms (the
 * floor from 0 to the top or the lamp's height; the ceiling, mirrored z' = 2E - z, from the mirrored top to the lamp's
 * height) cut where its landing crosses the reach, so the band within the reach is the projection itself; `row` 0, 0.5 or
 * 1 picks the band's base, that cut or its top. Leaves `zm` (this half's height of the row) and `zReal` (its real one).
 */
function lampRowsGlsl(zAll, dist, row) {
  const near = (1 - 1 / LAMP_MAP_MAX_STRETCH).toFixed(6);
  return `  bool lampCeil = uTileWorld.z > 0.5;
  float lampNear = lamp.z * ${near};
  float zA = lampCeil ? 2.0 * lamp.z - ${zAll} : 0.0;
  float zB = lampCeil ? lampNear : min(${zAll}, lampNear);
  float zR = clamp(lamp.z * (1.0 - ${dist} / lamp.w), zA, zB);
  float zm = ${row} < 0.25 ? zA : (${row} < 0.75 ? zR : zB);
  float zReal = lampCeil ? 2.0 * lamp.z - zm : zm;
  float w = max(lamp.z - zm, lamp.z / ${LAMP_MAP_MAX_STRETCH.toFixed(1)}) / lamp.z;
`;
}

/** lampRowsGlsl in WGSL. */
function lampRowsWgsl(zAll, dist, row) {
  const near = (1 - 1 / LAMP_MAP_MAX_STRETCH).toFixed(6);
  return `  let lampCeil = uniforms.uTileWorld.z > 0.5;
  let lampNear = lamp.z * ${near};
  let zA = select(0.0, 2.0 * lamp.z - ${zAll}, lampCeil);
  let zB = select(min(${zAll}, lampNear), lampNear, lampCeil);
  let zR = clamp(lamp.z * (1.0 - ${dist} / lamp.w), zA, zB);
  let zm = select(select(zB, zR, ${row} < 0.75), zA, ${row} < 0.25);
  let zReal = select(zm, 2.0 * lamp.z - zm, lampCeil);
  let w = max(lamp.z - zm, lamp.z / ${LAMP_MAP_MAX_STRETCH.toFixed(1)}) / lamp.z;
`;
}

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

// A landed point into this pass's half of the lamp's tile (uTileWorld: tiles a row, a half's texels, the half: 0 the floor,
// 1 the ceiling; DX-LAMPPANO: a tile is 2S x S and a landing goes into its half by lampPanoUv), drawn with w = 1 / its
// stretch: the lamp's rays make a projective map, and with w the picture (and the height between its rows) spreads over
// its shadow as they carry it. vTileUvW keeps the half's own coordinates for the fragment's clip, read as screen-linear.
const LAMP_OUT_GLSL = `  vec2 tuv = lampPanoUv(land - lamp.xy, lamp.w);
  int perRow = int(uTileWorld.x);
  vec2 px = (vec2(float(tile % perRow) * 2.0 + uTileWorld.z, float(tile / perRow)) + tuv) * uTileWorld.y;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 clip = mvp * vec3(px, 1.0);
  gl_Position = vec4(clip.xy * w, ${lampClipZGlsl('w')}, w);
  if (abs(aInstRotCS.x) > 2.0) gl_Position.x += aInstRotCS.y + aInstDepth + aInstTintBits;
  vTileUvW = vec3(tuv * w, w);
  vLampE = lamp.z;
  vColor = vec4(1.0, castOpacity, 1.0, 1.0);
  vLocal = lampQuad;
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
    .replace(main, `${main}  vSunZ = 0.0;\n  vTileUvW = vec3(-1.0, -1.0, 1.0);\n  vSunId = casterEntityId(aInstTintBits);\n  vLampE = 1.0;\n`);
}

/**
 * The lamps' map's vertex shader for cards (instancedSpriteShadow.vert.glsl's head, its own body): each stamp row's
 * caster as a card standing on its base (frameBase.js), facing its lamp, each point of the picture landing on the floor
 * along the lamp's ray (lampLanding), in this pass's half of the lamp's tile; its height passed on (vSunZ) for the depth
 * test. A render's frame (its base a contact) casts columns instead (lampMapColumnsVertex). DX-LAMPPANO: drawn on a strip of
 * three rows (lampCardStrip: aQuad.y 0, 0.5, 1 the rows, lampRowsGlsl), the picture's row worked out from each vertex's
 * height; the ceiling pass (uTileWorld.z 1) draws the part above the lamp, mirrored.
 * @param {string} source instancedSpriteShadow.vert.glsl
 */
export function lampMapVertex(source) {
  return `${lampHeadGlsl(source, 'the lamps\' shadow map')}  float zPerRow = aInstTrim.w * abs(aInstScale.y) / uSunK.w * height;
${lampTileGlsl(' || lampKind >= 3 || lampKind == 2 || (lampKind == 0 && aInstBase.x < 0.0) || (uTileWorld.z > 0.5 && zPerRow <= lamp.z)')}  vec2 content = aInstTrim.xy + vec2(aQuad.x, 1.0) * aInstTrim.zw;
  float bottom = aInstTrim.y + aInstTrim.w;
  // The picture's column at the card's foot, and the foot: under the lowest row, or the base's edge towards the lamp.
  float footCol = anchor.x * aInstSize.x;
  vec2 foot = vec2(aInstXY.x, (aInstXY.y + (bottom - aInstAnchor.y * aInstSize.y) * aInstScale.y) * uGroundInvScaleY);
  if (aInstBase.x >= 1.0) {
    float rx = abs(aInstBase.y) * abs(aInstScale.x);
    float ry = (aInstBase.y < 0.0 ? -aInstBase.y : 0.6 * aInstBase.y) * abs(aInstScale.y);
    // DX-CASTER: the caster's baseRadius corrects the measured radius (instancedSpriteShadow.vert.glsl's castBaseRadius).
    if (castBaseRadius > 0.0) {
      ry = rx > 1e-3 ? ry * castBaseRadius / rx : (aInstBase.y < 0.0 ? castBaseRadius : 0.6 * castBaseRadius);
      rx = castBaseRadius;
    }
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
${lampRowsGlsl('zPerRow', 'length(p - lamp.xy)', 'aQuad.y')}  vec2 lampQuad = vec2(aQuad.x, 1.0 - zReal / max(zPerRow, 1e-3));
  vec2 land = lamp.xy + (p - lamp.xy) / w;
  vSunZ = zReal;
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
    .replace(quad, 'in vec4 aCell; // the cell\'s centre in the frame, t (floor 0, top 1), side\nin vec4 aBlock; // E-379: this instance\'s block of its frame (x, y) and the blocks a side (z, 0 or 1: one)\nvec2 aQuad;\nuniform sampler2D uTexture;\nuniform sampler2D uMaps;\n')
    .replace(main, `${main}  float blocks = max(aBlock.z, 1.0);\n  aQuad = (aBlock.xy + aCell.xy) / blocks;\n`);
  return `${top}  vec2 uvc = mix(aInstUV.xy, aInstUV.zw, aQuad);
  vec4 m = texelFetch(uMaps, ivec2(uvc * vec2(textureSize(uMaps, 0))), 0);
  float cellAlpha = texelFetch(uTexture, ivec2(uvc * vec2(textureSize(uTexture, 0))), 0).a;
  float z = (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / 64.0 * height * abs(aInstScale.y);
${lampTileGlsl(' || lampKind >= 3 || lampKind == 1 || (lampKind == 0 && aInstBase.x >= 0.0) || m.b + m.a <= 0.0 || cellAlpha < 0.5 || z < 0.5 || (uTileWorld.z > 0.5 && z <= lamp.z)')}  vec2 content = aInstTrim.xy + aQuad * aInstTrim.zw;
  vec2 pix = aInstXY + (content - anchor * aInstSize) * aInstScale;
  vec2 base = vec2(pix.x, (pix.y + uSunK.w * z) * uGroundInvScaleY);
  // The column runs from the lamp's way (radially), its width across.
  vec2 fromLamp = base - lamp.xy;
  float dist = length(fromLamp);
  vec2 across = dist > 1e-3 ? vec2(-fromLamp.y, fromLamp.x) / dist : vec2(1.0, 0.0);
  vec2 cell = abs(aInstTrim.zw * aInstScale) / (${cells.toFixed(1)} * blocks);
  float width = 1.1 * max(cell.x, cell.y * uGroundInvScaleY) + 1.0;
  // DX-LAMPPANO: its rows in this half (aCell.z 0, 0.5, 1: lampColumnGrid), as the cards' (lampRowsGlsl).
${lampRowsGlsl('z', 'dist', 'aCell.z')}  vec2 lampQuad = aQuad;
  vec2 land = lamp.xy + fromLamp / w + across * aCell.w * width;
  vSunZ = zReal;
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
  // N-211: the texel keeps the point's place along its lamp's ray (lampRayDepth), not its height.
  const height = '  float h = clamp(vSunZ / 512.0, 0.0, 1.0);\n';
  for (const mark of [varying, main, height]) {
    if (sunMapFrag.split(mark).length !== 2) throw new Error(`WeedJS: the lamps' shadow map needs the sun map's fragment (${mark.trim()})`);
  }
  return sunMapFrag
    .replace(varying, `${varying}in vec3 vTileUvW;\nflat in float vLampE;\n`)
    .replace(height, '  float h = clamp(1.0 / (1.0 + abs(vLampE - vSunZ) / max(vLampE, 1e-3)), 0.0, 1.0);\n')
    .replace(
      main,
      `${main}  vec2 tuv = vTileUvW.xy / vTileUvW.z;\n  if (tuv.x < 0.0 || tuv.y < 0.0 || tuv.x >= 1.0 || tuv.y >= 1.0) discard;\n`,
    );
}

const LAMP_FRAGMENT_WGSL = `
${CASTER_ID_WGSL}
${MAP_TEXEL_WGSL}
// DX-SHADOW3D (F7): a caster point's height where its lamp's ray lands, in that lamp's tile, the highest kept by its depth
// (which its vertices write: lampClipZWgsl) with its caster's id (sunShadowMap.frag.glsl).
@fragment
fn mainFragLamp(in: VertexOut) -> @location(0) vec4<f32> {
  let tuv = in.vTileUvW.xy / in.vTileUvW.z;
  if (tuv.x < 0.0 || tuv.y < 0.0 || tuv.x >= 1.0 || tuv.y >= 1.0) { discard; }
  let t = textureSampleLevel(uTexture, uSampler, mix(in.vAtlasUV.xy, in.vAtlasUV.zw, in.vLocal), 0.0);
  if (t.a < 0.5) { discard; }
  // N-211: the point's place along its lamp's ray (lampRayDepth), in the texel's 8 bits as weedMapTexel scales a height.
  return weedMapTexel(${LAMP_MAP_ZMAX}.0 / (1.0 + abs(in.vLampE - in.vSunZ) / max(in.vLampE, 1e-3)), in.vSunId, in.vColor.g);
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

const LAMP_OUT_WGSL = `  let tuv = lampPanoUv(land - lamp.xy, lamp.w);
  let perRow = i32(uniforms.uTileWorld.x);
  let px = (vec2<f32>(f32(tile % perRow) * 2.0 + uniforms.uTileWorld.z, f32(tile / perRow)) + tuv) * uniforms.uTileWorld.y;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let clip = mvp * vec3<f32>(px, 1.0);
  out.position = vec4<f32>(clip.xy * w, ${lampClipZWgsl('w')}, w);
  if (abs(aInstRotCS.x) > 2.0) {
    out.position.x += aInstRotCS.y + aInstDepth + aInstTintBits;
  }
  out.vTileUvW = vec3<f32>(tuv * w, w);
  out.vLampE = lamp.z;
  out.vColor = vec4<f32>(1.0, castOpacity, 1.0, 1.0);
  out.vLocal = lampQuad;
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
  const body = ') -> VertexOut {\n  var out: VertexOut;\n';
  if (source.split(body).length !== 2) throw new Error(`WeedJS: ${what} needs the sprite shadow WGSL (mainVert)`);
  const head = source
    .slice(0, from)
    .replace(struct, `${struct}  @location(6) vSunZ: f32,\n  @location(7) vTileUvW: vec3<f32>,\n  @location(8) @interpolate(flat) vSunId: f32,\n  @location(9) @interpolate(flat) vLampE: f32,\n`)
    .replace(body, `${body}  out.vSunId = casterEntityId(aInstTintBits);\n`)
    .replace(binding, `${binding}// DX-SHADOW3D (F7): the lamps' tiles: a lamp's floor point, height and reach (lampShadowMap.js).\n@group(2) @binding(6) var uLampTiles: texture_2d<f32>;\n${LAMP_PANO_WGSL}`);
  return { head, rest: source.slice(to + end.length) };
}

/**
 * lampMapVertex's WGSL form (WebGPU): instancedSpriteShadow.wgsl's head with the lamp card, and the map's fragment entry
 * `mainFragLamp`.
 * @param {string} source instancedSpriteShadow.wgsl
 */
export function lampMapWgsl(source) {
  const { head, rest } = lampPartsWgsl(source, 'the lamps\' shadow map');
  return `${head}  let zPerRow = aInstTrim.w * abs(aInstScale.y) / uniforms.uSunK.w * height;
${lampTileWgsl(' || lampKind >= 3 || lampKind == 2 || (lampKind == 0 && aInstBase.x < 0.0) || (uniforms.uTileWorld.z > 0.5 && zPerRow <= lamp.z)')}  let content = aInstTrim.xy + vec2<f32>(aQuad.x, 1.0) * aInstTrim.zw;
  let bottom = aInstTrim.y + aInstTrim.w;
  var footCol = anchor.x * aInstSize.x;
  var foot = vec2<f32>(aInstXY.x, (aInstXY.y + (bottom - aInstAnchor.y * aInstSize.y) * aInstScale.y) * uniforms.uGroundInvScaleY);
  if (aInstBase.x >= 1.0) {
    var rx = abs(aInstBase.y) * abs(aInstScale.x);
    var ry = select(0.6 * aInstBase.y, -aInstBase.y, aInstBase.y < 0.0) * abs(aInstScale.y);
    // DX-CASTER: the caster's baseRadius corrects the measured radius.
    if (castBaseRadius > 0.0) {
      ry = select(select(0.6 * castBaseRadius, castBaseRadius, aInstBase.y < 0.0), ry * castBaseRadius / rx, rx > 1e-3);
      rx = castBaseRadius;
    }
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
  // DX-LAMPPANO: the strip's three rows in this half (lampMapVertex says how).
${lampRowsWgsl('zPerRow', 'length(p - lamp.xy)', 'aQuad.y')}  let lampQuad = vec2<f32>(aQuad.x, 1.0 - zReal / max(zPerRow, 1e-3));
  let land = lamp.xy + (p - lamp.xy) / w;
  out.vSunZ = zReal;
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
    .replace(quad, "  @location(0) aCell: vec4<f32>, // the cell's centre in the frame, t (floor 0, top 1), side\n  @location(12) aBlock: vec4<f32>, // E-379: this instance's block of its frame (x, y) and the blocks a side (z)\n")
    .replace(body, `${body}  let blocks = max(aBlock.z, 1.0);\n  let aQuad = (aBlock.xy + aCell.xy) / blocks;\n`)
    .replace(
      '@group(2) @binding(6) var uLampTiles: texture_2d<f32>;\n',
      // uFoot is declared though no lamp column reads it: the program's layout names binding 7 (sunShadowGpuProgram with
      // maps), and Pixi files a resource by the WGSL's declarations. Undeclared, it went to a spare group and group 2
      // had no binding 7, which Pixi reports as "the resource bound as 'uFoot' was destroyed".
      "@group(2) @binding(6) var uLampTiles: texture_2d<f32>;\n// DX-MAPS: the atlas's twin page (a column's height).\n@group(2) @binding(5) var uMaps: texture_2d<f32>;\n// DX-SHADOW3D: the renders' footprints (the layout's binding 7; unread here).\n@group(2) @binding(7) var uFoot: texture_2d<f32>;\n",
    );
  return `${head}  let uvc = mix(aInstUV.xy, aInstUV.zw, aQuad);
  let m = textureLoad(uMaps, vec2<i32>(uvc * vec2<f32>(textureDimensions(uMaps, 0))), 0);
  let cellAlpha = textureLoad(uTexture, vec2<i32>(uvc * vec2<f32>(textureDimensions(uTexture, 0))), 0).a;
  let z = (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / 64.0 * height * abs(aInstScale.y);
${lampTileWgsl(' || lampKind >= 3 || lampKind == 1 || (lampKind == 0 && aInstBase.x >= 0.0) || m.b + m.a <= 0.0 || cellAlpha < 0.5 || z < 0.5 || (uniforms.uTileWorld.z > 0.5 && z <= lamp.z)')}  let content = aInstTrim.xy + aQuad * aInstTrim.zw;
  let pix = aInstXY + (content - anchor * aInstSize) * aInstScale;
  let base = vec2<f32>(pix.x, (pix.y + uniforms.uSunK.w * z) * uniforms.uGroundInvScaleY);
  let fromLamp = base - lamp.xy;
  let dist = length(fromLamp);
  var across = vec2<f32>(1.0, 0.0);
  if (dist > 1e-3) { across = vec2<f32>(-fromLamp.y, fromLamp.x) / dist; }
  let cell = abs(aInstTrim.zw * aInstScale) / (${cells.toFixed(1)} * blocks);
  let width = 1.1 * max(cell.x, cell.y * uniforms.uGroundInvScaleY) + 1.0;
  // DX-LAMPPANO: its rows in this half (lampMapColumnsVertex says how).
${lampRowsWgsl('z', 'dist', 'aCell.z')}  let lampQuad = aQuad;
  let land = lamp.xy + fromLamp / w + across * aCell.w * width;
  out.vSunZ = zReal;
${LAMP_OUT_WGSL}${parts.rest}${LAMP_FRAGMENT_WGSL}`;
}

/**
 * DX-LAMPPANO: the cards' strip, drawn instead of the sprite batch's quad: aQuad.x across the picture (0 or 1), aQuad.y the
 * row (0 the band's base, 0.5 where its landing crosses the reach, 1 its top: lampRowsGlsl), two triangles a band.
 * @returns {{ vertices: Float32Array, indices: Uint16Array }}
 */
export function lampCardStrip() {
  return {
    vertices: new Float32Array([0, 0, 1, 0, 0, 0.5, 1, 0.5, 0, 1, 1, 1]),
    indices: new Uint16Array([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4]),
  };
}

/**
 * DX-LAMPPANO: the lamps' columns' grid, sunMapColumnGrid's with three rows a cell side (aCell.z 0, 0.5, 1: the base, the
 * reach's cut, the top), six vertices a cell.
 * @param {number} [cells]
 * @returns {Float32Array}
 */
export function lampColumnGrid(cells = LAMP_MAP_COLUMNS) {
  const corners = [[0, -1], [0.5, -1], [1, -1], [1, 1], [0.5, 1], [0, 1]];
  const out = new Float32Array(cells * cells * corners.length * 4);
  let at = 0;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      for (const [t, side] of corners) {
        out[at++] = (i + 0.5) / cells;
        out[at++] = (j + 0.5) / cells;
        out[at++] = t;
        out[at++] = side;
      }
    }
  }
  return out;
}

/**
 * DX-LAMPPANO: lampColumnGrid's index buffer: each cell's lower band (rows 0 and 0.5) and upper band (0.5 and 1), two
 * triangles each over the corners they share.
 * @param {number} [cells]
 * @returns {Uint16Array}
 */
export function lampColumnIndex(cells = LAMP_MAP_COLUMNS) {
  const out = new Uint16Array(cells * cells * 12);
  for (let c = 0, at = 0; c < cells * cells; c++, at += 12) {
    const v = c * 6;
    out.set([v, v + 1, v + 4, v, v + 4, v + 5, v + 1, v + 2, v + 3, v + 1, v + 3, v + 4], at);
  }
  return out;
}
