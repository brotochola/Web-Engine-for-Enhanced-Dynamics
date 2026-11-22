/**
 * DX-FACES: a sprite that is a flat face of a volume. A decoration can say where its surface looks and how high it is, and
 * the light pass then lights it as a surface in 3D instead of as the floor under its pixels.
 *
 * What a face carries, in two u32 columns that reach the GPU in the row's tile offsets as code / FACE_CODE_SCALE (a face is
 * never a tiled sprite), 24 bits each (N-271: pieces on one wall but anchored apart must land on one plane, so the depth
 * reads them finer than the face map's bytes):
 * - its normal, octahedral, 12 bits each from 1 to 4093 (±1/2 falls on a step: walls turned 45 degrees are common), so
 *   that 0 reads "no face";
 * - the height of the sprite's position above the floor, in steps of 1/FACE_ROW_Z_UNITS px, in its low FACE_INNER_Z_SHIFT
 *   bits (up to 32 767 px), and in its top 3 its innerZ (DX-FACEDEPTH: 0 a wall, 1 to 7 what is stuck on it, in stacking
 *   order: the depth's tie on a shared plane, pixelDepth.js).
 *
 * The frame's picture of them is the face map: the same instances drawn again at the light pass's resolution in painter
 * order, RGBA8: the normal's two bytes, then the height's two. A sprite that is no face writes 0, so a person in front of a
 * wall takes the wall out of the picture there.
 *
 * Space: the scene's floor. x along the screen, y across the floor towards the camera (screen y / groundScaleY), z up. A
 * px of height rises heightScaleY px on the screen.
 */

import { resolveHeightScaleY } from '../util/cameraView.js';
import { MAPS_MARKS_GLSL, MAPS_TABLE_GLSL, MAPS_TABLE_WGSL, twinGlsl, twinWgsl, withTwinGlsl } from './twinTexel.js';
import { hasOnce, requireMarks } from './shaderEdit.js';

/** The face map texel's height steps a px (15 bits: 4 095 px). */
export const FACE_Z_UNITS = 8;
/** N-271: a face row's codes reach the GPU as code / FACE_CODE_SCALE in its tile offsets: exact in a float32 to 2^24. */
export const FACE_CODE_SCALE = 65536;
/** N-271: the normal's octahedral u and v in a face row, 12 bits each: FACE_OCT_MID + FACE_OCT_HALF · u. */
export const FACE_OCT_MID = 2047;
export const FACE_OCT_HALF = 2046;
/** N-271: a face row's height steps a px. */
export const FACE_ROW_Z_UNITS = 64;
/** DX-FACEDEPTH: where a face's innerZ starts in its height code; the heights below it, up to FACE_Z_HEIGHT_MAX_CODE. */
export const FACE_INNER_Z_SHIFT = 21;
export const FACE_Z_HEIGHT_MAX_CODE = (1 << FACE_INNER_Z_SHIFT) - 1;
/** The highest innerZ a face carries (a wall's things stacked on it). */
export const FACE_INNER_Z_MAX = 7;

/**
 * DX-BARRIOS: faces have no switch: the G-buffer turns on by itself when a decoration carries a normal (DecorationPool's
 * faces-in-use word). The sun's share from the sky is Sun.skyLight (lighting.sun.skyLight); `wrap` and `gain` went (a
 * light's own brightness covers gain); a px of height rises the camera's heightScaleY.
 */
export const FACE_DEFAULTS = Object.freeze({
  enabled: false,
  /** Screen px a px of height rises: config.camera.heightScaleY (resolveFaces fills it in). */
  heightScaleY: 1,
});

/**
 * DX-GBUF (plan §6.4): the face map's codes beyond a normal. A normal's bytes are 1..253, so (0, 0) is "no face" (the
 * floor), (1, 0) an unshaded pixel (DX-UNSHADED, where no unshaded pass draws it) and (254, 254) a pixel lit as drawn at its place in 3D (FLAT: a sprite
 * with normals 'flat', or a standing card). A height's top bit (FACE_K_BIT, of its 16) marks a sprite's own normal (its
 * map's or its heights'), which shows as much as the lamps' share of the light (plan §5.4): heights hold 15 bits.
 */
export const FACE_FLAT_CODE = 254;
export const FACE_K_BIT = 32768;
export const FACE_Z_MAX_CODE = FACE_K_BIT - 1;

/**
 * DX-GBUF (plan §6.4): the G-buffer's second target, the entity ids map (RGBA8, the face map's size). R·256 + G: the
 * entity whose sprite covers the pixel (gbufWord.js gbufEntityId), 0 where none does (the floor, a decoration, a face);
 * B: its flags (FACE_IDS_SELF: it shades itself, DX-SELFSHADOW); A: 1 where written. Written in painter order with the
 * face map's coverage (alpha 0.5 and up), by a pass of its own (lighting.gbuffer 'pass') or in the face map's (MRT). The
 * light pass reads it for a pixel's self-shadow (its own heights alone) and to skip its own entity's shadow in the maps,
 * which keep their highest caster's id: a caster's own shadow never paints its own sprite.
 */
export const FACE_IDS_SELF = 1;

const WEED_UV_GLSL = `vec2 weedUv() {
  vec2 t = vLocal;
  if (vTileInv.x > 0.0) t.x = fract(vWorld.x * vTileInv.x + vTileOff.x);
  else if (vTileInv.x < 0.0) t.x = fract(vLocal.x * (-vTileInv.x) + vTileOff.x);
  if (vTileInv.y > 0.0) t.y = fract(vWorld.y * vTileInv.y + vTileOff.y);
  else if (vTileInv.y < 0.0) t.y = fract(vLocal.y * (-vTileInv.y) + vTileOff.y);
  return mix(vAtlasUV.xy, vAtlasUV.zw, t);
}`;

/**
 * The ids map's texel of a word (GLSL 300, after weedUv's alpha test): the entity's id and its flags. A word's own
 * selfShadow (gbufWord.js bits 22-23: 0 the asset's way, 1 on, 2 off) decides FACE_IDS_SELF, the asset's way being a
 * render's (its frame's base a contact: `render`).
 */
const IDS_TEXEL_GLSL = `vec4 idsTexel(vec2 gbuf, bool isRender) {
  uint word = uint(gbuf.x + 0.5);
  uint id = word & 65535u;
  uint selfMode = (word >> 22u) & 3u;
  bool selfOn = id != 0u && (selfMode == 1u || (selfMode == 0u && isRender));
  return vec4(float(id >> 8u) / 255.0, float(id & 255u) / 255.0, selfOn ? ${FACE_IDS_SELF}.0 / 255.0 : 0.0, 1.0);
}`;

/**
 * DX-UNSHADED (GLSL 300): 1 for an unshaded pixel, its entity's (its word's unshaded bit, gbufWord.js GBUF_UNSHADED_BIT)
 * or its sheet's (the maps table's mark, its instance's vMapsWin); 0 for any other.
 */
const UNSHADED_OF_GLSL = `float unshadedOf(vec2 gbuf) {
  return ((uint(gbuf.x + 0.5) >> 21u) & 1u) != 0u || twinUnshaded(vMapsWin) ? 1.0 : 0.0;
}`;

/**
 * The ids map's fragment shader (WebGL): over faceMapVertex's outputs with words, the face map's coverage, the ids texel.
 * With `unshaded` (DX-UNSHADED, the unshaded pass on) an unshaded pixel writes nothing, as in the face map: what is behind
 * it is lit.
 * @param {{ unshaded?: boolean }} [opts]
 * @returns {string}
 */
export function faceIdsFragment({ unshaded = false } = {}) {
  return `#version 300 es
precision highp float;
in vec2 vLocal;
in vec4 vColor;
in vec2 vWorld;
in vec4 vAtlasUV;
in vec2 vTileInv;
in vec2 vTileOff;
flat in vec2 vGbuf;
flat in float vRender;
flat in vec4 vMapsWin;
uniform sampler2D uTexture;
uniform sampler2D uMaps;
out vec4 finalColor;

${WEED_UV_GLSL}

${twinGlsl()}
${IDS_TEXEL_GLSL}

${UNSHADED_OF_GLSL}

// DX-GBUF: the entity ids map (faceMap.js FACE_IDS_SELF): what entity covers this pixel, in painter order.
void main() {
  vec2 uv = weedUv();
  if (texture(uTexture, uv).a * vColor.a < 0.5) discard;
${unshaded ? '  if (unshadedOf(vGbuf) > 0.0) discard;\n' : ''}  finalColor = idsTexel(vGbuf, vRender > 0.5);
}
`;
}

/**
 * faceMap.frag.glsl with its blocks for a batch's options: GBUF (the words: normals and surface) and UNSHADED / !UNSHADED
 * (DX-UNSHADED: an unshaded pixel writes nothing, the unshaded pass draws it; without the pass, the face map's code), and
 * the twin texel's helpers (twinTexel.js) at its "// weed:twin" line.
 * @param {string} faceFrag
 * @param {{ gbuf?: boolean, unshaded?: boolean }} [opts]
 */
export function faceFragmentGlsl(faceFrag, { gbuf = false, unshaded = false } = {}) {
  const flagged = shaderWithFlag(shaderWithFlag(faceFrag, 'UNSHADED', unshaded), '!UNSHADED', !unshaded);
  return withTwinGlsl(shaderWithFlag(flagged, 'GBUF', gbuf));
}

/**
 * DX-UNSHADED (was DX-EMISSIVE v2, plan §6.9, F10): the unshaded pass's fragment shader (WebGL), over faceMapVertex's
 * outputs with words: an unshaded pixel writes its colour, any other black with its alpha, both premultiplied and blended
 * normally in painter order, so a sprite in front of a flame covers it in proportion to its alpha. The unshaded layer adds
 * it where the light is short (unshadedComposite.js). N-266: with `depth` (the batch's pixel depth) it is drawn as the
 * canvas is, in two passes with the colour pass's depth (pixelDepth.js gbufDepthFragment): the opaque one (`edge` false)
 * keeps the solid pixels that are not unshaded, black, writing the depth; the edge one (`edge` true) the soft and the
 * unshaded ones, testing it. So a lit sprite in front of an unshaded one covers it there as on the canvas, whichever the
 * painter drew last.
 * @param {{ depth?: boolean, edge?: boolean }} [opts]
 * @returns {string}
 */
export function faceUnshadedFragment({ depth = false, edge = false } = {}) {
  const cut = !depth
    ? ''
    : edge
      ? '  float ad = t.a * vColor.a;\n  if (ad <= 0.0 || (ad >= 0.5 && unshadedOf(vGbuf) <= 0.0)) discard;\n  // weed:depth\n'
      : '  if (texture(uTexture, uv).a * vColor.a < 0.5) discard;\n  if (unshadedOf(vGbuf) > 0.0) discard;\n';
  return `#version 300 es
precision highp float;
in vec2 vLocal;
in vec4 vColor;
in vec2 vWorld;
in vec4 vAtlasUV;
in vec2 vTileInv;
in vec2 vTileOff;
flat in vec2 vGbuf;
flat in vec4 vMapsWin;
${depth ? 'flat in float vMapScale;\nuniform vec4 uFaceSpace;\n' : ''}uniform sampler2D uTexture;
uniform sampler2D uMaps;
out vec4 finalColor;

${WEED_UV_GLSL}

${twinGlsl()}
${UNSHADED_OF_GLSL}

void main() {
  vec2 uv = weedUv();
  vec4 t = texture(uTexture, uv);
${cut}  float s = unshadedOf(vGbuf);
  finalColor = vec4(t.rgb * vColor.rgb * vColor.a * s, t.a * vColor.a);
}
`;
}

/**
 * E-457: the unshaded mask's fragment shader (WebGL), over unshadedMaskVertex's outputs: each instance that can be
 * unshaded marks its whole quad in the stencil, with no colour (the mask's colour mask is off) and no work a pixel, so
 * the GPU marks it as it rasterizes. The unshaded pass then draws every instance only where it is marked: elsewhere none
 * adds anything to its colour (a pixel that is not unshaded writes black with its alpha, which the unshaded layer does not
 * read), so the target's colour is what drawing them all everywhere gave. A mask cut to the unshaded pixels (a texture
 * read and a discard a pixel), and Pixi's mask, which draws it again to pop it, cost the stress scene more than they saved.
 * @returns {string}
 */
export function faceUnshadedMaskFragment() {
  return `#version 300 es
precision highp float;
out vec4 finalColor;

void main() {
  finalColor = vec4(0.0);
}
`;
}

/**
 * E-457: which instances the unshaded mask draws (GLSL, in faceMapVertex's main with words): one whose word is unshaded
 * (gbufWord.js GBUF_UNSHADED_BIT) or whose frame's sheet is (DX-UNSHADED: the maps table's mark). Any other goes off the
 * target, so the mask fills the unshaded instances' quads alone.
 */
const UNSHADED_MASK_CUT_GLSL = `  if (((uint(aInstGbuf.x + 0.5) >> 21u) & 1u) == 0u && !twinUnshaded(twinWindow(int(aInstTexId + 0.5)))) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
`;

/**
 * E-457: faceMapVertex's output (with words) as the unshaded mask's vertex shader: the instances that cannot be unshaded
 * go off the target (UNSHADED_MASK_CUT_GLSL). Their place is computed as the unshaded pass's, so the mask covers the
 * pixels it draws.
 * @param {string} source faceMapVertex(..., { gbuf: true })
 * @returns {string}
 */
export function unshadedMaskVertex(source) {
  const end = 'vTileOff = aInstTileOff;\n';
  if (!hasOnce(source, end)) throw new Error('WeedJS: the unshaded mask needs one vTileOff in the sprite vertex shader');
  return source.replace(end, () => end + UNSHADED_MASK_CUT_GLSL);
}

/**
 * DX-GBUF (plan §6.4, lighting.gbuffer 'mrt'): faceMap.frag.glsl writing the face map and the entity ids map in one pass,
 * two colour targets (WebGL 2's draw buffers): the face texel at location 0 as faceMap.frag.glsl writes it, the ids texel
 * at 1 (faceIdsFragment's), for the same coverage.
 * @param {string} faceFrag faceMap.frag.glsl
 * @returns {string}
 */
export function faceGbufFragment(faceFrag, { unshaded = false } = {}) {
  const src = faceFragmentGlsl(faceFrag, { gbuf: true, unshaded });
  const out = 'out vec4 finalColor;\n';
  const cut = '  if (texture(uTexture, uv).a * vColor.a < 0.5) discard;\n';
  requireMarks(src, [out, cut], `the G-buffer's one pass needs faceMap.frag.glsl`);
  return src
    .replace(
      out,
      () => `layout(location = 0) out vec4 finalColor;\nlayout(location = 1) out vec4 finalIds;\nflat in float vRender;\n\n${IDS_TEXEL_GLSL}\n`,
    )
    .replace(cut, () => `${cut}  finalIds = idsTexel(vGbuf, vRender > 0.5);\n`);
}

/** The words' input of a sprite WGSL's mainVert (DX-GBUF, gbufWord.js): a free location, read or not. */
const GBUF_ATTRIBUTE_WGSL = '  @location(12) aInstGbuf: vec3<f32>,\n';

/**
 * DX-GBUF: a sprite WGSL (instancedSprite.wgsl, its pose form, or either after faceMapWgsl) taking the G-buffer words'
 * stream (aInstGbuf), which every geometry of a batch with words carries: Pixi lays a program's vertex buffers out by the
 * inputs its WGSL declares, and warns of a geometry attribute it does not.
 * @param {string} source
 * @returns {string}
 */
export function gbufAttributeWgsl(source) {
  if (source.includes('aInstGbuf:')) return source;
  const at = '  @location(1) aInstXY: vec2<f32>,\n';
  if (!hasOnce(source, at)) throw new Error('WeedJS: the G-buffer words need the sprite WGSL (aInstXY)');
  return source.replace(at, () => at + GBUF_ATTRIBUTE_WGSL);
}

/**
 * DX-GBUF: gbufAttributeWgsl's twin for a sprite vertex shader in GLSL (instancedSprite.vert.glsl, its pose form, indexed
 * or not): it takes the words' stream whether or not it reads it. WebGL drops an input the program never reads, and Pixi
 * then warned of the geometry's aInstGbuf ("not present in the shader") for every colour program without pixel depth.
 * The words' x (an id + 1 and flags) is never negative, so the kept line never moves a vertex.
 * @param {string} source
 * @returns {string}
 */
export function gbufAttributeGlsl(source) {
  if (source.includes('in vec3 aInstGbuf;')) return source;
  const main = 'void main() {\n';
  const at = '  gl_Position = vec4(clip.xy, aInstDepth, 1.0);\n';
  if (!hasOnce(source, main) || !hasOnce(source, at)) {
    throw new Error('WeedJS: the G-buffer words need the sprite vertex shader (main, its gl_Position)');
  }
  return source
    .replace(main, () => `in vec3 aInstGbuf;\n${main}`)
    .replace(at, () => `${at}  if (aInstGbuf.x < -1.0) gl_Position.x += aInstGbuf.y;\n`);
}

/**
 * The sprite vertex shader for the face map: instancedSprite.vert.glsl or its pose form, indexed or not (spriteIndexed.js
 * keeps these lines). A face's height at each corner comes from its plane: the row holds the height at the sprite's
 * position, and a corner dx, dy px from it is on the plane through there with the row's normal, seen from this view:
 * dy = groundScaleY * dY - heightScaleY * dZ on the screen, dX = dx.
 * DX-GBUF: with `gbuf`, the instance's words (vGbuf, gbufWord.js) and its foot's world y (vFootY: under its lowest row,
 * as a standing card's height counts from there) go on to faceMap.frag.glsl's GBUF block.
 * @param {string} source
 * @param {{ gbuf?: boolean }} [opts]
 * @returns {string}
 */
export function faceMapVertex(source, { gbuf = false } = {}) {
  const main = 'void main() {\n';
  const end = 'vTileOff = aInstTileOff;\n';
  if (!hasOnce(source, main) || !hasOnce(source, end)) {
    throw new Error('WeedJS: the face map needs one main and one vTileOff in the sprite vertex shader');
  }
  const gbufDecl = gbuf ? 'in vec3 aInstGbuf;\nflat out vec2 vGbuf;\nout float vFootY;\nflat out float vRender;\n' : '';
  // vRender: the frame is a render (its base a contact, frameBase.js lutBaseFloats: the table's third texel's z below 0),
  // whose selfShadow the asset's way is on (plan §5.5).
  const gbufOut = gbuf
    ? `  vGbuf = aInstGbuf.xy;
  // N-275: a decoration that is part of an entity stands on the entity's foot (the words' z), as a card rising from it.
  vFootY = aInstGbuf.z > -1.0e29 ? aInstGbuf.z
    : world.y - (isShear ? sheared.y : spun.y) + (aInstTrim.y + aInstTrim.w - aInstAnchor.y * aInstSize.y) * abs(aInstScale.y);
  vRender = 0.0;
  {
    int gbufTid = int(aInstTexId + 0.5);
    ivec2 gbufLut = textureSize(uTexLut, 0);
    int gbufPer = gbufLut.x / 3;
    if (gbufTid >= 0 && gbufTid < gbufPer * gbufLut.y) {
      vRender = texelFetch(uTexLut, ivec2(3 * (gbufTid % gbufPer) + 2, gbufTid / gbufPer), 0).z < 0.0 ? 1.0 : 0.0;
    }
  }
`
    : '';
  return source
    .replace(
      main,
      'uniform vec4 uFaceSpace; // heightScaleY, groundScaleY\nflat out vec2 vFaceOct;\nout float vFaceZ;\nflat out float vMapScale;\n' +
        'flat out vec4 vMapsWin;\nflat out vec4 vNormalTurn;\n' + MAPS_MARKS_GLSL + MAPS_TABLE_GLSL + gbufDecl + '\n' + main,
    )
    .replace(
      end,
      end +
        gbufOut +
        `  uint faceCode = uint(aInstTileOff.x * ${FACE_CODE_SCALE}.0 + 0.5);
  vFaceOct = vec2(0.0);
  vFaceZ = 0.0;
  // N-194: a sprite drawn at a scale stands that much taller, so its twin's heights (frame px) scale with it.
  vMapScale = abs(aInstScale.y);
  // E-496: where its frame's maps are in the twin page.
  vMapsWin = twinWindow(int(aInstTexId + 0.5));
  // N-258: its normals turn with it and mirror with a negative scale (a shear turns none: DX-DECOSKEW's marker).
  vNormalTurn = vec4(isShear ? 1.0 : c, isShear ? 0.0 : s, aInstScale.x < 0.0 ? -1.0 : 1.0, aInstScale.y < 0.0 ? -1.0 : 1.0);
  if (faceCode != 0u && aInstTileInv == vec2(0.0)) {
    vec2 faceF = (vec2(float(faceCode >> 12u), float(faceCode & 4095u)) - ${FACE_OCT_MID}.0) / ${FACE_OCT_HALF}.0;
    // The face map keeps the normal in bytes, 127 + 126 u (the texel rounds them).
    vFaceOct = (faceF * 126.0 + 127.0) / 255.0;
    vec3 faceN = vec3(faceF, 1.0 - abs(faceF.x) - abs(faceF.y));
    float faceT = max(-faceN.z, 0.0);
    faceN.x += faceN.x >= 0.0 ? -faceT : faceT;
    faceN.y += faceN.y >= 0.0 ? -faceT : faceT;
    vec2 faceD = world - aInstXY;
    float faceSlope = faceN.z + faceN.y * uFaceSpace.x / uFaceSpace.y;
    float faceDz = abs(faceSlope) > 0.02 ? -(faceN.x * faceD.x + faceN.y * faceD.y / uFaceSpace.y) / faceSlope : 0.0;
    // DX-FACEDEPTH: the height code's low bits; innerZ is in its top ones.
    uint faceHeight = uint(aInstTileOff.y * ${FACE_CODE_SCALE}.0 + 0.5);
    vFaceZ = float(faceHeight & ${FACE_Z_HEIGHT_MAX_CODE}u) / ${FACE_ROW_Z_UNITS}.0 + faceDz;
  }
`,
    );
}

/**
 * faceMapVertex's WGSL form, on the sprite program before spriteIndexedWgsl if it is the indexed one, with the fragment
 * entry `mainFragFace` that writes the map (its texel from weedFace, faceFunctionsWgsl).
 * DX-GBUF: with `gbuf`, the instance's words (vGbuf) and its foot's world y (vFootY), as faceMapVertex passes them.
 * E-457: with `unshadedMask` (and `gbuf`), the unshaded mask's vertex half (unshadedMaskVertex's cut); its entry is
 * mainFragUnshadedMask. DX-UNSHADED: with `unshaded`, the unshaded pass draws the unshaded pixels, so the G-buffer's
 * entries leave them out.
 * @param {string} source instancedSprite.wgsl or its pose variant (shaderVariants.js)
 * @param {{ gbuf?: boolean, unshaded?: boolean, unshadedMask?: boolean }} [opts]
 * @returns {string}
 */
export function faceMapWgsl(source, { gbuf = false, unshaded = false, unshadedMask = false } = {}) {
  return `${faceVertexWgsl(source, { gbuf, unshadedMask })}${faceFunctionsWgsl({ gbuf, unshaded })}
// DX-FACES: faceMap.frag.glsl
@fragment
fn mainFragFace(in: VertexOut) -> @location(0) vec4<f32> {
  return weedFace(in);
}
${gbuf ? faceIdsEntryWgsl({ unshaded }) : ''}`;
}

/**
 * DX-GBUF: the ids map's texel and its fragment entry (faceIdsFragment's WGSL), the one pass's entry (MRT) and the
 * unshaded pass's (faceUnshadedFragment's), in a face module with words.
 */
const faceIdsEntryWgsl = ({ unshaded }) => `
// DX-UNSHADED: 1 for an unshaded pixel (faceMap.js UNSHADED_OF_GLSL), 0 for any other.
fn unshadedOf(gbuf: vec2<f32>, win: vec4<f32>) -> f32 {
  return select(0.0, 1.0, ((u32(gbuf.x + 0.5) >> 21u) & 1u) != 0u || twinUnshaded(win));
}
${FACE_IDS_ENTRY_WGSL.replace(
    '  if (t.a * in.vColor.a < 0.5) { discard; }\n  return idsTexel(',
    unshaded
      ? '  if (t.a * in.vColor.a < 0.5) { discard; }\n  if (unshadedOf(in.vGbuf, in.vMapsWin) > 0.0) { discard; }\n  return idsTexel('
      : '  if (t.a * in.vColor.a < 0.5) { discard; }\n  return idsTexel(',
  )}
// DX-UNSHADED (faceUnshadedFragment): an unshaded pixel's colour, any other black with its alpha.
@fragment
fn mainFragUnshaded(in: VertexOut) -> @location(0) vec4<f32> {
  let uv = weedUv(in.vLocal, in.vWorld, in.vAtlasUV, in.vTileInv, in.vTileOff);
  let t = textureSample(uTexture, uSampler, uv);
  let s = unshadedOf(in.vGbuf, in.vMapsWin);
  return vec4<f32>(t.rgb * in.vColor.rgb * in.vColor.a * s, t.a * in.vColor.a);
}
// E-457 (faceUnshadedMaskFragment): the quad of an instance that can be unshaded, marked in the stencil, no colour.
@fragment
fn mainFragUnshadedMask(in: VertexOut) -> @location(0) vec4<f32> {
  return vec4<f32>(0.0);
}
`;

/** The ids entry and the one pass's (faceIdsEntryWgsl adds the unshaded discard and the unshaded entry). */
const FACE_IDS_ENTRY_WGSL = `
// DX-GBUF: the ids map's texel of a word (faceMap.js IDS_TEXEL_GLSL).
fn idsTexel(gbuf: vec2<f32>, isRender: bool) -> vec4<f32> {
  let word = u32(gbuf.x + 0.5);
  let id = word & 65535u;
  let selfMode = (word >> 22u) & 3u;
  let selfOn = id != 0u && (selfMode == 1u || (selfMode == 0u && isRender));
  return vec4<f32>(f32(id >> 8u) / 255.0, f32(id & 255u) / 255.0, select(0.0, ${FACE_IDS_SELF}.0 / 255.0, selfOn), 1.0);
}

// DX-GBUF: the entity ids map (faceIdsFragment): what entity covers this pixel, in painter order.
@fragment
fn mainFragIds(in: VertexOut) -> @location(0) vec4<f32> {
  let t = textureSample(uTexture, uSampler, weedUv(in.vLocal, in.vWorld, in.vAtlasUV, in.vTileInv, in.vTileOff));
  if (t.a * in.vColor.a < 0.5) { discard; }
  return idsTexel(in.vGbuf, in.vRender > 0.5);
}

// DX-GBUF (lighting.gbuffer 'mrt'): the face map and the ids map in one pass, two colour targets (faceGbufFragment).
struct WeedGbufOut {
  @location(0) face: vec4<f32>,
  @location(1) ids: vec4<f32>,
}

@fragment
fn mainFragGbuf(in: VertexOut) -> WeedGbufOut {
  var o: WeedGbufOut;
  o.face = weedFace(in);
  o.ids = idsTexel(in.vGbuf, in.vRender > 0.5);
  return o;
}
`;

/**
 * The face map's vertex half in a sprite WGSL (faceMapWgsl's): its uniform, the face's octahedral bytes and height out,
 * and with `gbuf` the words' input (gbufAttributeWgsl) and outputs. E-457: with `unshadedMask` (and `gbuf`) the
 * unshaded mask's cut (unshadedMaskVertex's).
 * @param {string} source
 * @param {{ gbuf?: boolean, unshadedMask?: boolean }} [opts]
 * @returns {string}
 */
export function faceVertexWgsl(source, { gbuf = false, unshadedMask = false } = {}) {
  const once = (text, find, add) => {
    if (!hasOnce(text, find)) throw new Error(`WeedJS: the face map needs one "${find.trim()}" in the sprite WGSL`);
    return text.replace(find, () => find + add);
  };
  let out = once(source, '  uTileWorld: vec4<f32>,\n', '  uFaceSpace: vec4<f32>, // heightScaleY, groundScaleY\n');
  out = once(
    out,
    '  @location(5) vTileOff: vec2<f32>,\n',
    '  @location(6) @interpolate(flat) vFaceOct: vec2<f32>,\n  @location(7) vFaceZ: f32,\n' +
      '  @location(12) @interpolate(flat) vMapScale: f32,\n  @location(15) @interpolate(flat) vMapsWin: vec4<f32>,\n' +
      '  @location(13) @interpolate(flat) vNormalTurn: vec4<f32>,\n' +
      (gbuf
        ? '  @location(9) @interpolate(flat) vGbuf: vec2<f32>,\n  @location(10) vFootY: f32,\n' +
          '  @location(11) @interpolate(flat) vRender: f32,\n'
        : ''),
  );
  if (gbuf) out = gbufAttributeWgsl(out);
  const gbufOut = gbuf
    ? `  out.vGbuf = aInstGbuf.xy;
  // N-275: a decoration that is part of an entity stands on the entity's foot (the words' z: faceMapVertex).
  out.vFootY = select(world.y - select(spun, sheared, isShear).y
    + (aInstTrim.y + aInstTrim.w - aInstAnchor.y * aInstSize.y) * abs(aInstScale.y), aInstGbuf.z, aInstGbuf.z > -1.0e29);
  // A render (its base a contact: faceMapVertex says why).
  out.vRender = 0.0;
  if (tid >= 0 && tid < lutPerRow * i32(lutSize.y)) {
    out.vRender = select(0.0, 1.0, textureLoad(uTexLut, vec2<i32>(3 * (tid % lutPerRow) + 2, tid / lutPerRow), 0).z < 0.0);
  }
`
    : '';
  out = once(
    out,
    '  out.vTileOff = aInstTileOff;\n',
    gbufOut +
      (gbuf && unshadedMask ? UNSHADED_MASK_CUT_WGSL : '') +
      `  let faceCode = u32(aInstTileOff.x * ${FACE_CODE_SCALE}.0 + 0.5);
  out.vFaceOct = vec2<f32>(0.0);
  out.vFaceZ = 0.0;
  // N-194: a scaled sprite's twin heights scale with it (faceMapVertex).
  out.vMapScale = abs(aInstScale.y);
  // E-496: where its frame's maps are in the twin page.
  out.vMapsWin = twinWindow(tid);
  // N-258: its normals turn with it and mirror with a negative scale (faceMapVertex).
  out.vNormalTurn = vec4<f32>(select(c, 1.0, isShear), select(s, 0.0, isShear), select(1.0, -1.0, aInstScale.x < 0.0), select(1.0, -1.0, aInstScale.y < 0.0));
  if (faceCode != 0u && all(aInstTileInv == vec2<f32>(0.0))) {
    let faceF = (vec2<f32>(f32(faceCode >> 12u), f32(faceCode & 4095u)) - ${FACE_OCT_MID}.0) / ${FACE_OCT_HALF}.0;
    // The face map keeps the normal in bytes, 127 + 126 u (faceMapVertex).
    out.vFaceOct = (faceF * 126.0 + 127.0) / 255.0;
    var faceN = vec3<f32>(faceF, 1.0 - abs(faceF.x) - abs(faceF.y));
    let faceT = max(-faceN.z, 0.0);
    faceN.x += select(faceT, -faceT, faceN.x >= 0.0);
    faceN.y += select(faceT, -faceT, faceN.y >= 0.0);
    let faceD = world - aInstXY;
    let faceSlope = faceN.z + faceN.y * uniforms.uFaceSpace.x / uniforms.uFaceSpace.y;
    var faceDz = 0.0;
    if (abs(faceSlope) > 0.02) {
      faceDz = -(faceN.x * faceD.x + faceN.y * faceD.y / uniforms.uFaceSpace.y) / faceSlope;
    }
    // DX-FACEDEPTH: the height code's low bits (faceMapVertex).
    let faceHeight = u32(aInstTileOff.y * ${FACE_CODE_SCALE}.0 + 0.5);
    out.vFaceZ = f32(faceHeight & ${FACE_Z_HEIGHT_MAX_CODE}u) / ${FACE_ROW_Z_UNITS}.0 + faceDz;
  }
`,
  );
  return out;
}

/** E-457: UNSHADED_MASK_CUT_GLSL in WGSL (faceVertexWgsl's unshadedMask). */
const UNSHADED_MASK_CUT_WGSL = `  if (((u32(aInstGbuf.x + 0.5) >> 21u) & 1u) == 0u && !twinUnshaded(twinWindow(tid))) { out.position = vec4<f32>(2.0, 2.0, 2.0, 1.0); }
`;

/** DX-GBUF's WGSL helpers (faceMap.frag.glsl twinHeight and heightNormal): normals 'height', the heights' Sobel. */
const FACE_GBUF_HELPERS_WGSL = `
// DX-GBUF: a twin texel's height (px), or \`here\` where it has no map (faceMap.frag.glsl twinHeight).
fn faceTwinHeight(c: vec2<i32>, here: f32) -> f32 {
  let m = twinRaw(c);
  return select(here, twinZ(m), twinPresent(m));
}

// DX-GBUF: normals 'height', the Sobel of the heights around texel c (faceMap.frag.glsl heightNormal).
fn faceHeightNormal(c: vec2<i32>, z: f32) -> vec3<f32> {
  let a = faceTwinHeight(c + vec2<i32>(-1, -1), z);
  let b = faceTwinHeight(c + vec2<i32>(0, -1), z);
  let d = faceTwinHeight(c + vec2<i32>(1, -1), z);
  let l = faceTwinHeight(c + vec2<i32>(-1, 0), z);
  let r = faceTwinHeight(c + vec2<i32>(1, 0), z);
  let e = faceTwinHeight(c + vec2<i32>(-1, 1), z);
  let g = faceTwinHeight(c + vec2<i32>(0, 1), z);
  let h = faceTwinHeight(c + vec2<i32>(1, 1), z);
  let gx = (d + 2.0 * r + h - a - 2.0 * l - e) / 8.0;
  let gy = (e + 2.0 * g + h - a - 2.0 * b - d) / 8.0;
  return normalize(vec3<f32>(-gx, gy, 1.0));
}
`;

/**
 * The face map's fragment functions in WGSL (faceMap.frag.glsl): the twin page's binding (group 2, binding 5: the indexed
 * program takes 4), the octahedral codes, the texel, and weedFace, which discards what the map does not take and returns
 * the texel of what it does. DX-GBUF: with `gbuf`, an entity's sprite as its normals and surface say.
 * @param {{ gbuf?: boolean }} [opts]
 * @returns {string}
 */
export function faceFunctionsWgsl({ gbuf = false, unshaded = false } = {}) {
  const flat = `vec2<f32>(${FACE_FLAT_CODE}.0 / 255.0)`;
  const gbufBlock = gbuf
    ? `  // DX-GBUF (plan §5.4): an entity's sprite as its normals and surface say (faceMap.frag.glsl's GBUF block).
  let word = u32(in.vGbuf.x + 0.5);
${unshaded ? '  // DX-UNSHADED: an unshaded entity writes nothing here.\n  if (((word >> 21u) & 1u) != 0u) { discard; }\n' : ''}  if (noFace && (word & 65535u) != 0u) {
    let flags = (word >> 16u) & 63u;
    let normals = flags & 3u;
    if (twinPresent(m)) {
      let zm = twinZ(m);
      // N-257: a frame without heights stands as its surface says (faceMap.frag.glsl).
      var zw = 0.0;
      if (twinHeights(in.vMapsWin)) { zw = zm * in.vMapScale; }
      else if ((flags & 4u) == 0u && uniforms.uFaceSpace.x > 0.0) { zw = max(in.vFootY - in.vWorld.y, 0.0) / uniforms.uFaceSpace.x; }
      if (normals == 3u) { return faceTexel(${flat}, zw, false); }
      var n = twinStoredNormal(m, tc);
      // The Sobel reads the frame's own heights or relief (DX-RELIEF); a normal map alone keeps its own normals. E-497:
      // a format that keeps no normals (B) always takes the Sobel.
      if ((normals == 2u || !TWIN_NORMALS) && (twinHeights(in.vMapsWin) || twinRelief(in.vMapsWin))) { n = faceHeightNormal(tc, zm); }
      n = turnNormal(n, in.vNormalTurn);
      return faceTexel(faceOctEncode(vec3<f32>(n.x, n.z * sc.y - n.y * sc.x, n.y * sc.y + n.z * sc.x)), zw, true);
    }
    // OL-4: where the camera shows no height (heightScaleY 0) nothing stands: the sprite lies on the floor.
    if ((flags & 4u) == 0u && uniforms.uFaceSpace.x > 0.0) {
      return faceTexel(${flat}, max(in.vFootY - in.vWorld.y, 0.0) / uniforms.uFaceSpace.x, false);
    }
    return vec4<f32>(0.0);
  }
`
    : '';
  return `
// DX-MAPS: the atlas's twin page (spriteMaps.js). Binding 5: the indexed program takes 4.
@group(2) @binding(5) var uMaps: texture_2d<f32>;

${twinWgsl()}
${MAPS_TABLE_WGSL}
fn faceOctDecode(bytes: vec2<f32>) -> vec3<f32> {
  let f = (bytes - 127.0) / 126.0;
  var n = vec3<f32>(f, 1.0 - abs(f.x) - abs(f.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}

fn faceOctEncode(v: vec3<f32>) -> vec2<f32> {
  let n = v / (abs(v.x) + abs(v.y) + abs(v.z));
  var p = n.xy;
  if (n.z < 0.0) {
    p = (1.0 - abs(p.yx)) * vec2<f32>(select(-1.0, 1.0, p.x >= 0.0), select(-1.0, 1.0, p.y >= 0.0));
  }
  return floor(p * 126.0 + 127.5) / 255.0;
}

// The face map's texel: a normal's bytes or a code, a height in eighths of a px (15 bits), the top bit a sprite's own
// normal (faceMap.frag.glsl faceTexel).
fn faceTexel(oct: vec2<f32>, z: f32, k: bool) -> vec4<f32> {
  let q = floor(clamp(z * ${FACE_Z_UNITS}.0, 0.0, ${FACE_Z_MAX_CODE}.0)) + select(0.0, ${FACE_K_BIT}.0, k);
  return vec4<f32>(oct, floor(q / 256.0) / 255.0, (q % 256.0) / 255.0);
}

// N-258: a frame's normal as its sprite draws it, mirrored and turned (faceMap.frag.glsl turnNormal; t: vNormalTurn).
fn turnNormal(n: vec3<f32>, t: vec4<f32>) -> vec3<f32> {
  let f = n.xy * t.zw;
  return vec3<f32>(f.x * t.x + f.y * t.y, f.y * t.x - f.x * t.y, n.z);
}
${FACE_GBUF_HELPERS_WGSL}
// DX-FACES (faceMap.frag.glsl): what this pixel is, in painter order, or a discard where the sprite is not opaque.
fn weedFace(in: VertexOut) -> vec4<f32> {
  let uv = weedUv(in.vLocal, in.vWorld, in.vAtlasUV, in.vTileInv, in.vTileOff);
  let t = textureSample(uTexture, uSampler, uv);
  let tc = twinCoord(uv, in.vMapsWin);
  let m = twinTexel(uv, in.vMapsWin);
  if (t.a * in.vColor.a < 0.5) { discard; }
  // DX-UNSHADED: a pixel of an unshaded sheet, face or not: (1/255, 0) in the face map, or nothing (unshaded: the unshaded
  // pass draws it).
  if (twinUnshaded(in.vMapsWin)) {
    ${unshaded ? 'discard;' : 'return vec4<f32>(1.0 / 255.0, 0.0, 0.0, 0.0);'}
  }
  var oct = in.vFaceOct;
  var z = in.vFaceZ;
  let noFace = all(oct == vec2<f32>(0.0));
  let sc = normalize(vec2<f32>(uniforms.uFaceSpace.y, uniforms.uFaceSpace.x));
${gbufBlock}  if (noFace && twinPresent(m)) {
    var stored = twinStoredNormal(m, tc);
    // E-497: a format that keeps no normals (B) takes the Sobel of the heights.
    if (!TWIN_NORMALS) { stored = faceHeightNormal(tc, twinZ(m)); }
    let n = turnNormal(stored, in.vNormalTurn);
    oct = faceOctEncode(vec3<f32>(n.x, n.z * sc.y - n.y * sc.x, n.y * sc.y + n.z * sc.x));
    // N-257: without words a frame without heights lies on the floor (faceMap.frag.glsl).
    z = select(0.0, twinZ(m) * in.vMapScale, twinHeights(in.vMapsWin));
  }
  return faceTexel(oct, z, false);
}
`;
}

/** A shader source with its `// #if NAME` ... `// #endif NAME` blocks kept (on) or cut (off). */
export function shaderWithFlag(source, name, on) {
  const block = new RegExp(`^[ \\t]*// #if ${name}\\s*\\n([\\s\\S]*?)^[ \\t]*// #endif ${name}[^\\n]*\\n`, 'gm');
  return source.replace(block, on ? '$1' : '');
}

/**
 * The light pass's source with its blocks kept or cut: FACES (DX-FACES and DX-MAPS), SUNMAP / !SUNMAP (DX-SHADOW3D's
 * sun map), SELFSHADOW (DX-SELFSHADOW, inside FACES), LAMPMAP (DX-SHADOW3D's lamps' map) and IDS (DX-GBUF's entity ids
 * map, with FACES: a pixel's self-shadow counts its own heights, and its own entity's shadow in the maps is skipped), in
 * the GLSL and the WGSL alike. DX-PIXELSHADOW: PIXELART / !PIXELART (lighting.pixelArt: each world pixel shaded whole at
 * its centre, the maps read with one tap). E-205: TILES / !TILES (a pixel loops over its tile's lights, src/render/
 * lightTiles.js, instead of every light). DX-LIGHTEDGES: EDGES / !EDGES (the floor's texels leave alpha 0, the rest 1,
 * for lightEdges.js; without it every texel's alpha is 1). N-277: DITHER / !DITHER (lighting.dither: half an 8-bit step of
 * noise on the light's output; without it, the light as it is). OL-4: WALLS (lighting.walls: each lamp's light times what
 * its row of the walls' texture lets through, src/render/visibility/lampWallRow.js; with FACES and IDS, since a wall's own
 * pixels are told by their id).
 * lighting.shadowSamples: the shadow maps' taps a point averages, 1 to 9 of the 3 x 3 texels around it (pixelArt takes 1),
 * kept by SHADOW_TAP_CENTER and the pairs SHADOW_TAPS_X, _Y, _DIAGONAL and _ANTIDIAGONAL, with SHADOW_TAP_WEIGHT written
 * as 1 over their count (shadowTapsOf says which taps each count takes).
 * @param {string} source lightingBasic.frag.glsl or lightingBasic.wgsl
 * @param {{ faces: boolean, sunMap: boolean, selfShadow?: boolean, lampMap?: boolean, ids?: boolean, pixelArt?: boolean,
 *   tiles?: boolean, edges?: boolean, dither?: boolean, walls?: boolean, shadowSamples?: number }} flags
 */
export function lightingSource(source, {
  faces, sunMap, selfShadow = false, lampMap = false, ids = false, pixelArt = false, tiles = false, edges = false, dither = false,
  walls = false, shadowSamples = 5,
}) {
  const withSun = shaderWithFlag(shaderWithFlag(shaderWithFlag(source, 'FACES', faces), 'SUNMAP', sunMap), '!SUNMAP', !sunMap);
  const withLamps = shaderWithFlag(shaderWithFlag(withSun, 'SELFSHADOW', faces && selfShadow), 'LAMPMAP', lampMap);
  const withIds = shaderWithFlag(shaderWithFlag(withLamps, 'IDS', faces && ids), '!IDS', !(faces && ids));
  const withTiles = shaderWithFlag(shaderWithFlag(withIds, 'TILES', tiles), '!TILES', !tiles);
  const withEdges = shaderWithFlag(shaderWithFlag(withTiles, 'EDGES', edges), '!EDGES', !edges);
  const withWalls = shaderWithFlag(withEdges, 'WALLS', walls && faces && ids);
  const withDither = shaderWithFlag(shaderWithFlag(withWalls, 'DITHER', dither), '!DITHER', !dither);
  const withPixelArt = shaderWithFlag(shaderWithFlag(withDither, 'PIXELART', pixelArt), '!PIXELART', !pixelArt);
  const taps = shadowTapsOf(pixelArt ? 1 : shadowSamples);
  let out = shaderWithFlag(withPixelArt, 'SHADOW_TAP_CENTER', taps.center);
  out = shaderWithFlag(out, 'SHADOW_TAPS_X', taps.x);
  out = shaderWithFlag(out, 'SHADOW_TAPS_Y', taps.y);
  out = shaderWithFlag(out, 'SHADOW_TAPS_DIAGONAL', taps.diagonal);
  out = shaderWithFlag(out, 'SHADOW_TAPS_ANTIDIAGONAL', taps.antidiagonal);
  // A literal with its point in GLSL and WGSL alike (GLSL ES has no int-to-float conversion): 1.000000000 for one tap.
  return out.replace(/SHADOW_TAP_WEIGHT/g, (1 / taps.count).toFixed(9));
}

/**
 * lighting.shadowSamples' taps of the 3 x 3 texels around a point, each count laid out as evenly as it can be, every one
 * symmetric about the point: 1 the centre; 2 its left and right; 3 those and the centre; 4 the cross's arms; 5 the cross
 * (arms and centre); 6 the arms and one diagonal pair; 7 those and the centre; 8 the ring; 9 every texel. 2, 3, 6 and 7
 * soften an edge more along their row or diagonal than across it. A count outside 1..9 is clamped, a fraction rounded.
 * @param {number} samples
 * @returns {{ count: number, center: boolean, x: boolean, y: boolean, diagonal: boolean, antidiagonal: boolean }}
 */
export function shadowTapsOf(samples) {
  const r = Math.round(Number(samples));
  const n = r >= 1 ? (r <= 9 ? r : 9) : 1;
  return { count: n, center: (n & 1) === 1, x: n >= 2, y: n >= 4, diagonal: n >= 6, antidiagonal: n >= 8 };
}

/**
 * Whether a scene's light can take faces (lit: `enabled`) and the px a px of height rises (the camera's).
 * DX-BARRIOS: no lighting.faces any more; whether faces are in use is DecorationPool.facesInUse().
 */
export function resolveFaces(lighting, camera = null) {
  const heightScaleY = resolveHeightScaleY(camera);
  return { enabled: !!(lighting && lighting.enabled), heightScaleY };
}

/**
 * @param {number} nx
 * @param {number} ny
 * @param {number} nz
 * @returns {number} faceOct, 24 bits (12 a component); 0 for a zero vector (no face)
 */
export function encodeFaceNormal(nx, ny, nz) {
  const sum = Math.abs(nx) + Math.abs(ny) + Math.abs(nz);
  if (!(sum > 0)) return 0;
  let u = nx / sum;
  let v = ny / sum;
  if (nz < 0) {
    const fu = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1);
    v = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1);
    u = fu;
  }
  return (Math.round(u * FACE_OCT_HALF + FACE_OCT_MID) << 12) | Math.round(v * FACE_OCT_HALF + FACE_OCT_MID);
}

/** What the shaders decode: a unit normal, in `out`. */
export function decodeFaceNormal(code, out) {
  const fx = (((code >>> 12) & 4095) - FACE_OCT_MID) / FACE_OCT_HALF;
  const fy = ((code & 4095) - FACE_OCT_MID) / FACE_OCT_HALF;
  let z = 1 - Math.abs(fx) - Math.abs(fy);
  const t = z < 0 ? -z : 0;
  const x = fx + (fx >= 0 ? -t : t);
  const y = fy + (fy >= 0 ? -t : t);
  const len = Math.sqrt(x * x + y * y + z * z);
  out[0] = x / len;
  out[1] = y / len;
  out[2] = (z = z / len);
  return out;
}

/**
 * @param {number} z the face's height at its position, px (0 to FACE_Z_HEIGHT_MAX_CODE / FACE_ROW_Z_UNITS)
 * @param {number} [innerZ] DX-FACEDEPTH: 0 a wall, 1 to FACE_INNER_Z_MAX what is stuck on it (clamped)
 * @returns {number} faceZ, 24 bits: the height in its low FACE_INNER_Z_SHIFT bits, innerZ above
 */
export function encodeFaceHeight(z, innerZ = 0) {
  const code = Math.round(z * FACE_ROW_Z_UNITS);
  const h = code < 0 ? 0 : code > FACE_Z_HEIGHT_MAX_CODE ? FACE_Z_HEIGHT_MAX_CODE : code;
  const k = innerZ | 0;
  return ((k < 0 ? 0 : k > FACE_INNER_Z_MAX ? FACE_INNER_Z_MAX : k) << FACE_INNER_Z_SHIFT) | h;
}

/** DX-FACEDEPTH: a faceZ's parts, { height (px), innerZ }. */
export function decodeFaceHeight(code) {
  return { height: (code & FACE_Z_HEIGHT_MAX_CODE) / FACE_ROW_Z_UNITS, innerZ: code >>> FACE_INNER_Z_SHIFT };
}
