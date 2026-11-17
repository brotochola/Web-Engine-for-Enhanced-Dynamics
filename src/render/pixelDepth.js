/**
 * DX-DEPTH (plan §6.5, F5): depth that corrects the painter. The painter still orders the entities by their feet, in one
 * pass with blending; the depth each pixel tests is its place on the floor instead of its row's place in that order:
 * a pixel of a sprite with a height map (the atlas's twin page, DX-MAPS) at its own height,
 *   floor y = (screen y + heightScaleY · z) / floorScaleY,
 * a pixel of a sprite flat on the floor (surface 'floor', DX-GBUF) its own screen y's, every other pixel its sprite's foot.
 * Nearer the camera (further down the floor) is less deep, so with the depth test (less) a pixel the painter drew late but
 * that stands behind another is not drawn: a person behind the barn's roof is hidden by it even when their feet are
 * further south than the barn's anchor.
 *
 * Only opaque pixels write it (alpha 0.5 and up), every pixel compares. One pass cannot choose per pixel whether to write
 * depth, so the entities draw in two (F5 v2): the opaque pass (the batch's own mesh) draws the opaque pixels, writing
 * depth; the edge pass (its edge mesh, right after it, the same instances) draws the soft edges and the unshaded pixels,
 * testing depth without writing it, blended over what is there in painter order. A soft edge of a sprite behind is then
 * hidden by an opaque one in front whatever the painter's order, and one in front blends over it.
 *
 * The depth's 23 bits, nearer first: the zIndex band (3 bits, DX-GBUF's word: a higher zIndex is always in front, as the
 * painter has it, R-0169), the floor place (13 bits over the view's floor span and a margin), then the painter's order in
 * 7 bits (the instance index's low bits: rows on the same floor place tie in painter order, a later one in front). Without
 * the words every band is 0.
 *
 * DX-FACEDEPTH: where faces are on (a decoration carries a normal), a face writes the depth of its plane, worked out in the
 * vertex (a plane is linear on the screen), brought nearer by its innerZ · FACE_INNER_Z_TIE floor px (the wall 0, what is
 * stuck on it 1 to 7, carried in its row; N-271), and its painter step is 0. Every depth is then continuous (no floor() of the floor place), so a face and a height map's
 * pixel meet on one scale. The opaque pass is two programs over the same instances: the frames with heights write their
 * pixels' depth (gl_FragDepth), every other instance the depth its vertices wrote, so its fragments keep the early depth
 * test (E-378). The batch draws the vertex-depth one first (InstancedSpriteBatch's vdepthMesh).
 *
 * WebGL (pixelDepthVertex, pixelDepthFragment) and WebGPU (pixelDepthWgsl).
 */

import { TEX_LUT_FLAG_BITS, TEX_LUT_FLAGS_PER_ROW } from './frameBase.js';
import { FACE_CODE_SCALE, FACE_INNER_Z_SHIFT, FACE_OCT_HALF, FACE_OCT_MID, FACE_ROW_Z_UNITS, FACE_Z_HEIGHT_MAX_CODE } from './faceMap.js';
import { MAPS_MARKS_GLSL, MAPS_TABLE_GLSL, MAPS_TABLE_WGSL, twinGlsl, twinWgsl } from './twinTexel.js';

/** The floor span's margin past the view, floor px: a tall object's top in view stands this far past its floor place. */
export const PIXEL_DEPTH_MARGIN = 1024;
/** Floor places the depth tells apart (13 bits), zIndex bands (3 bits) and painter steps (7 bits): 23 bits in all. */
export const PIXEL_DEPTH_FLOOR_STEPS = 8192;
export const PIXEL_DEPTH_BANDS = 8;
export const PIXEL_DEPTH_PAINTER_STEPS = 128;
/**
 * DX-FACEDEPTH, N-271: how much nearer each step of innerZ (a wall's things stacked on it: 1 to 7) brings a face, in floor
 * px. It was 16 of the painter's 128 steps, 0.05 floor px at zoom 1.2 and less zoomed in, under the plane's own rounding:
 * a piece anchored apart on its wall lands up to ~0.07 floor px off it with exact data (faceMap.js's 24-bit codes). At
 * innerZ 7 a piece stands 1.75 floor px off its wall, under a px of the world: nothing that is not stuck on the wall
 * stands that close to it.
 */
export const FACE_INNER_Z_TIE = 0.25;

/** The terms the programs read (uDepth): 1 / floorScaleY, heightScaleY, the view's nearest-to-north floor y, 1 / range. */
export function pixelDepthTerms(out, floorScaleY, heightScaleY, viewTopY, viewHeight, margin = PIXEL_DEPTH_MARGIN) {
  const invG = floorScaleY > 0 ? 1 / floorScaleY : 1;
  const top = viewTopY * invG - margin;
  const range = viewHeight * invG + 2 * margin;
  out[0] = invG;
  out[1] = heightScaleY;
  out[2] = top;
  out[3] = range > 0 ? 1 / range : 0;
  return out;
}

/**
 * A pixel's depth as the programs write it (for tests): band (0 back to 7 front), the floor place's u (0 north of the
 * view's span, 1 south), the painter step (an instance index). DX-FACEDEPTH: with `faces`, the continuous form (no floor()
 * of the floor place) and the painter step as given (a face's is 0; its innerZ is in u: FACE_INNER_Z_TIE).
 */
export function pixelDepthValue(band, u, instance, faces = false) {
  const b = Math.min(Math.max(band, 0), PIXEL_DEPTH_BANDS - 1);
  const uc = Math.min(Math.max(u, 0), 1) * (PIXEL_DEPTH_FLOOR_STEPS - 1);
  const q = faces ? uc : Math.floor(uc);
  const p = instance & (PIXEL_DEPTH_PAINTER_STEPS - 1);
  const d = (PIXEL_DEPTH_BANDS - 1 - b) * PIXEL_DEPTH_FLOOR_STEPS * PIXEL_DEPTH_PAINTER_STEPS
    + (PIXEL_DEPTH_FLOOR_STEPS - 1 - q) * PIXEL_DEPTH_PAINTER_STEPS
    + (PIXEL_DEPTH_PAINTER_STEPS - 1 - p);
  return d / (PIXEL_DEPTH_BANDS * PIXEL_DEPTH_FLOOR_STEPS * PIXEL_DEPTH_PAINTER_STEPS);
}

/**
 * H-EDGE: whether this instance's frame is plain (vPlain 1.0, GLSL): its soft-or-glow bit clear in its row's flags texel
 * (frameBase.js TEX_LUT_SOFT_OR_GLOW), read after the vertex shader's own LUT read (its tid, lutSize and lutPerRow), and
 * with `gbuf` no unshaded bit in its word (DX-UNSHADED). A table without the texel, or a slot past it, reads as not plain.
 */
function plainGlsl(gbuf) {
  return `
  vPlain = 0.0;
  if (tid >= 0 && tid < lutPerRow * lutSize.y && lutSize.x > 3 * lutPerRow) {
    int weedSlot = tid % lutPerRow;
    if (weedSlot < ${TEX_LUT_FLAGS_PER_ROW}) {
      vec4 weedFlags = texelFetch(uTexLut, ivec2(3 * lutPerRow, tid / lutPerRow), 0);
      int weedC = weedSlot / ${TEX_LUT_FLAG_BITS};
      float weedF = weedC == 0 ? weedFlags.x : (weedC == 1 ? weedFlags.y : (weedC == 2 ? weedFlags.z : weedFlags.w));
      if (((uint(weedF) >> uint(weedSlot - ${TEX_LUT_FLAG_BITS} * weedC)) & 1u) == 0u) vPlain = 1.0;
    }
  }${gbuf ? '\n  if (((uint(aInstGbuf.x + 0.5) >> 21u) & 1u) != 0u) vPlain = 0.0;' : ''}`;
}

/** DEPTH_BODY's depth from the floor place, the band and the painter step (GLSL and WGSL alike). */
const DEPTH_FORMULA = `((${PIXEL_DEPTH_BANDS - 1}.0 - band) * ${PIXEL_DEPTH_FLOOR_STEPS * PIXEL_DEPTH_PAINTER_STEPS}.0
      + (${PIXEL_DEPTH_FLOOR_STEPS - 1}.0 - floor(u * ${PIXEL_DEPTH_FLOOR_STEPS - 1}.0)) * ${PIXEL_DEPTH_PAINTER_STEPS}.0
      + (${PIXEL_DEPTH_PAINTER_STEPS - 1}.0 - painter)) / ${PIXEL_DEPTH_BANDS * PIXEL_DEPTH_FLOOR_STEPS * PIXEL_DEPTH_PAINTER_STEPS}.0`;

/**
 * DX-FACEDEPTH: DEPTH_FORMULA without the floor() of the floor place, where faces are on: a face's depth comes from its
 * vertices, interpolated, so every depth is on that one continuous scale.
 */
const DEPTH_FORMULA_FACES = `((${PIXEL_DEPTH_BANDS - 1}.0 - band) * ${PIXEL_DEPTH_FLOOR_STEPS * PIXEL_DEPTH_PAINTER_STEPS}.0
      + (${PIXEL_DEPTH_FLOOR_STEPS - 1}.0 - u * ${PIXEL_DEPTH_FLOOR_STEPS - 1}.0) * ${PIXEL_DEPTH_PAINTER_STEPS}.0
      + (${PIXEL_DEPTH_PAINTER_STEPS - 1}.0 - painter)) / ${PIXEL_DEPTH_BANDS * PIXEL_DEPTH_FLOOR_STEPS * PIXEL_DEPTH_PAINTER_STEPS}.0`;

/**
 * DX-FACEDEPTH (GLSL, in the vertex after its place): a face's floor place at this vertex, from its plane (the face map's
 * vFaceZ: faceMap.js faceMapVertex) brought nearer by innerZ · FACE_INNER_Z_TIE (the face height's top bits), and its
 * painter step 0. A
 * sprite that is no face keeps its foot's place, or with `gbuf` its own when it lies on the floor (surface 'floor'). All of
 * these are linear on the screen: the vertex writes them, the fragment interpolates them (vDepthFloor).
 */
function facesDepthGlsl(gbuf) {
  return `${facesDepthCoreGlsl(gbuf)}
  vDepthFloor = depthFloor;
  vPainter.x = depthPainter;`;
}

/**
 * facesDepthGlsl's work without its outputs (GLSL, in a sprite vertex after its place): the locals depthFloor and
 * depthPainter, from uDepth (x: 1 / floorScaleY, y: heightScaleY; a uniform, or a local of that name).
 */
function facesDepthCoreGlsl(gbuf) {
  return `
  float depthFloor = aInstXY.y * uDepth.x;
  float depthPainter = float(gl_InstanceID & ${PIXEL_DEPTH_PAINTER_STEPS - 1});
  {
    uint dfCode = uint(aInstTileOff.x * ${FACE_CODE_SCALE}.0 + 0.5);
    if (dfCode != 0u && aInstTileInv == vec2(0.0)) {
      vec2 dfF = (vec2(float(dfCode >> 12u), float(dfCode & 4095u)) - ${FACE_OCT_MID}.0) / ${FACE_OCT_HALF}.0;
      vec3 dfN = vec3(dfF, 1.0 - abs(dfF.x) - abs(dfF.y));
      float dfT = max(-dfN.z, 0.0);
      dfN.x += dfN.x >= 0.0 ? -dfT : dfT;
      dfN.y += dfN.y >= 0.0 ? -dfT : dfT;
      uint dfHeight = uint(aInstTileOff.y * ${FACE_CODE_SCALE}.0 + 0.5);
      float dfInner = float(dfHeight >> ${FACE_INNER_Z_SHIFT}u);
      vec2 dfD = world - aInstXY;
      float dfSlope = dfN.z + dfN.y * uDepth.y * uDepth.x;
      float dfDz = abs(dfSlope) > 0.02 ? -(dfN.x * dfD.x + dfN.y * dfD.y * uDepth.x) / dfSlope : 0.0;
      float dfZ = float(dfHeight & ${FACE_Z_HEIGHT_MAX_CODE}u) / ${FACE_ROW_Z_UNITS}.0 + dfDz;
      depthFloor = (world.y + uDepth.y * dfZ) * uDepth.x + dfInner * ${FACE_INNER_Z_TIE.toFixed(4)};
      depthPainter = 0.0;
    }${gbuf ? ` else {
      uint dfw = uint(aInstGbuf.x + 0.5);
      if ((dfw & 65535u) != 0u && ((dfw >> 18u) & 1u) != 0u) depthFloor = world.y * uDepth.x;
    }` : ''}
  }`;
}

/**
 * DX-FACEDEPTH's opaque pass in two programs over the same instances (GLSL, after facesDepthGlsl): `cull` 'flat' keeps the
 * instances whose frames have heights (they write gl_FragDepth, a pixel's own height), 'heights' the others, whose depth
 * the vertex writes (gl_Position.z: a face's plane, a foot, the floor), so their fragments keep the early depth test
 * (E-378). 'none': every instance (the edge pass).
 */
function cullGlsl(cull, gbuf) {
  if (cull === 'flat') return '\n  if (!twinHeights(vMapsWin)) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);';
  if (cull !== 'heights') return '';
  return `
  if (twinHeights(vMapsWin)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  } else {
    float band = ${gbuf ? `min(aInstGbuf.y, ${PIXEL_DEPTH_BANDS - 1}.0)` : '0.0'};
    float u = clamp((depthFloor - uDepth.z) * uDepth.w, 0.0, 1.0);
    float painter = depthPainter;
    gl_Position.z = (${DEPTH_FORMULA_FACES}) * 2.0 - 1.0;
  }`;
}

/**
 * A sprite vertex shader (instancedSprite.vert.glsl, or its indexed forms) passing on its foot's floor y, its painter step
 * (the instance index's low bits), with `gbuf` its words (the zIndex band and the surface), and H-EDGE's vPlain.
 * DX-FACEDEPTH: with `faces`, each vertex's floor place (vDepthFloor: facesDepthGlsl) and a face's innerZ as its painter
 * step; `cull` ('flat', 'heights', with `faces`) one of the opaque pass's two programs (cullGlsl).
 * @param {string} source
 * @param {{ gbuf?: boolean, faces?: boolean, cull?: 'none'|'flat'|'heights' }} [opts]
 */
export function pixelDepthVertex(source, { gbuf = false, faces = false, cull = 'none' } = {}) {
  const decl = 'out vec2 vTileOff;\n';
  const pos = 'gl_Position = vec4(clip.xy, aInstDepth, 1.0);';
  for (const mark of [decl, pos]) {
    if (source.split(mark).length !== 2) throw new Error(`WeedJS: pixel depth needs the sprite vertex shader (${mark.trim()})`);
  }
  const words = gbuf
    ? `${source.includes('in vec3 aInstGbuf;') ? '' : 'in vec3 aInstGbuf;\n'}flat out vec2 vDepthWord;\n`
    : '';
  const facesDecl = faces ? `out float vDepthFloor;\n${MAPS_MARKS_GLSL}` : '';
  // N-194: vPainter's y is the sprite's |scale y|, by which its twin's heights (frame px) become world heights.
  return source
    .replace(
      decl,
      () => `${decl}out float vFootFloor;\nflat out vec2 vPainter;\nflat out float vPlain;\nflat out vec4 vMapsWin;\nuniform vec4 uDepth;\n${words}${MAPS_TABLE_GLSL}${facesDecl}`,
    )
    .replace(
      pos,
      () => `${pos}\n  vFootFloor = aInstXY.y * uDepth.x;\n  vPainter = vec2(float(gl_InstanceID & ${PIXEL_DEPTH_PAINTER_STEPS - 1}), abs(aInstScale.y));\n  vMapsWin = twinWindow(tid);` +
        (gbuf ? '\n  vDepthWord = aInstGbuf.xy;' : '') + plainGlsl(gbuf) + (faces ? facesDepthGlsl(gbuf) + cullGlsl(cull, gbuf) : ''),
    );
}

/**
 * H-EDGE: the pixels a pass draws nothing for, known from the texture's alpha times the tint's (`ad`, GLSL and WGSL alike),
 * so they leave before the twin page and the depth. The opaque pass keeps none under 0.5 (whether it glows or not). The
 * edge pass draws a pixel of alpha 0 as nothing: its colour is premultiplied 0 (the atlas's alpha is premultiplied on
 * upload, and the tint's alpha scales the colour too), it writes no depth, and a zero blends to the pixel under it. Nor
 * does it draw a solid one (alpha 0.5 and up) unless it glows, which an instance of a plain frame (`plain`, the vertex
 * stage's vPlain: no soft texel, no unshaded sheet or word) never does.
 */
const EARLY_DISCARD = (edge, plain = 'vPlain') => (edge ? `ad <= 0.0 || (ad >= 0.5 && ${plain} > 0.5)` : 'ad < 0.5');

/**
 * The fragment's depth body (GLSL): the floor place, the depth, and the pass's pixels: `edge` false (the opaque pass)
 * keeps the opaque pixels that do not glow, true (the edge pass) the others. H-EDGE: the texture's alpha comes first, and
 * a pixel the pass draws nothing for leaves before the twin page and the depth (EARLY_DISCARD). DX-FACEDEPTH: with
 * `faces`, the floor place the vertex wrote (vDepthFloor) unless the pixel has its own height, without floor().
 */
function depthBodyGlsl({ edge, gbuf, faces }) {
  const surface = gbuf && !faces ? '    if ((dw & 65535u) != 0u && ((dw >> 18u) & 1u) != 0u) floorY = vWorld.y * uDepth.x;\n' : '';
  return `  {
    // DX-DEPTH: this pixel's place on the floor: at its own height when its frame has a height map, its own when the
    // sprite lies flat, else its sprite's foot; the zIndex band first and the painter's order last (pixelDepth.js).
    vec2 uvd = weedUv();
    float ad = texture(uTexture, uvd).a * vColor.a;
    if (${EARLY_DISCARD(edge)}) discard;
    vec4 md = twinTexel(uvd, vMapsWin);
    float zd = twinZ(md) * vPainter.y;
    // DX-UNSHADED: an unshaded sheet's pixel (the maps table's mark) or entity's writes no depth: the edge pass draws it.
    bool glow = twinUnshaded(vMapsWin);
    float band = 0.0;
    float floorY = ${faces ? 'vDepthFloor' : 'vFootFloor'};
${gbuf
    ? `    uint dw = uint(vDepthWord.x + 0.5);
    glow = glow || ((dw >> 21u) & 1u) != 0u;
    band = min(vDepthWord.y, ${PIXEL_DEPTH_BANDS - 1}.0);
${surface}`
    : ''}    // N-257: a frame without heights (a normal or relief map alone) keeps its surface's place, as one without maps.
    if (twinPresent(md) && twinHeights(vMapsWin) && !glow) floorY = (vWorld.y + uDepth.y * zd) * uDepth.x;
    float u = clamp((floorY - uDepth.z) * uDepth.w, 0.0, 1.0);
    float painter = vPainter.x;
    gl_FragDepth = (${faces ? DEPTH_FORMULA_FACES : DEPTH_FORMULA});
    // F5 v2: only opaque pixels write depth; the edge pass draws the soft and the unshaded ones, testing it.
    bool solid = ad >= 0.5 && !glow;
    if (${edge ? 'solid' : '!solid'}) discard;
  }
`;
}

/**
 * DX-FACEDEPTH (E-378): the opaque pass's fragment for the instances whose depth the vertex wrote (pixelDepthVertex with
 * cull 'heights'): it keeps the opaque pixels that are not unshaded and writes no depth of its own.
 */
function vertexDepthBodyGlsl(gbuf) {
  return `  {
    float ad = texture(uTexture, weedUv()).a * vColor.a;
    bool glow = twinUnshaded(vMapsWin)${gbuf ? ' || ((uint(vDepthWord.x + 0.5) >> 21u) & 1u) != 0u' : ''};
    if (ad < 0.5 || glow) discard;
  }
`;
}

/**
 * A sprite fragment shader writing that depth (gl_FragDepth, first thing, so every path that draws writes it) and keeping
 * its pass's pixels: `edge` false, the opaque pass (alpha 0.5 and up, not glowing); true, the edge pass (the others).
 * DX-FACEDEPTH: `faces` reads the vertex's floor place; `vertexDepth` is the opaque program whose depth the vertex wrote
 * (cull 'heights'), without gl_FragDepth.
 * @param {string} source
 * @param {{ edge?: boolean, gbuf?: boolean, faces?: boolean, vertexDepth?: boolean }} [opts]
 */
export function pixelDepthFragment(source, { edge = false, gbuf = false, faces = false, vertexDepth = false } = {}) {
  const decl = 'uniform sampler2D uTexture;\n';
  const main = 'void main() {\n';
  for (const mark of [decl, main]) {
    if (source.split(mark).length !== 2) throw new Error(`WeedJS: pixel depth needs the sprite fragment shader (${mark.trim()})`);
  }
  if (vertexDepth) {
    return source
      .replace(decl, () => `${decl}uniform sampler2D uMaps;\n${gbuf ? 'flat in vec2 vDepthWord;\n' : ''}flat in vec4 vMapsWin;\n${twinGlsl()}`)
      .replace(main, () => `${main}${vertexDepthBodyGlsl(gbuf)}`);
  }
  const inputs = `uniform sampler2D uMaps;\nuniform vec4 uDepth;\nin float vFootFloor;\n${faces ? 'in float vDepthFloor;\n' : ''}flat in vec2 vPainter;\n`
    + `${edge ? 'flat in float vPlain;\n' : ''}${gbuf ? 'flat in vec2 vDepthWord;\n' : ''}flat in vec4 vMapsWin;\n`;
  return source
    .replace(decl, () => `${decl}${inputs}${twinGlsl()}`)
    .replace(main, () => `${main}${depthBodyGlsl({ edge, gbuf, faces })}`);
}

// DX-DEPTH: the depth body in WGSL, a function of the fragment's inputs (vDepthFoot: the foot's floor y, the painter step;
// vDepthWord: the words; DX-FACEDEPTH vDepthFloor), returning the depth and whether the pixel is the opaque pass's (1) or
// the edge pass's (0).
const depthWgsl = ({ gbuf, faces }) => `
// DX-DEPTH: the atlas's twin page (spriteMaps.js), read where the colour is (pixelDepth.js).
@group(2) @binding(5) var uMaps: texture_2d<f32>;

${twinWgsl()}
${MAPS_TABLE_WGSL}
struct WeedDepthOut {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}

// DX-DEPTH: this pixel's depth (its floor place, its zIndex band, its painter step: pixelDepth.js) and whether it is opaque
// and does not glow (the opaque pass's pixels; the edge pass draws the others). H-EDGE: a pixel the pass draws nothing for
// (EARLY_DISCARD; edge: the pass) leaves before the twin page and the depth.
fn weedPixelDepth(in: VertexOut, edge: bool) -> vec2<f32> {
  let uvd = weedUv(in.vLocal, in.vWorld, in.vAtlasUV, in.vTileInv, in.vTileOff);
  let ad = textureSample(uTexture, uSampler, uvd).a * in.vColor.a;
  if (select(${EARLY_DISCARD(false)}, ${EARLY_DISCARD(true, 'in.vPlain')}, edge)) { discard; }
  let md = twinTexel(uvd, in.vMapsWin);
  let zd = twinZ(md) * in.vDepthFoot.z;
  var glow = twinUnshaded(in.vMapsWin);
  var band = 0.0;
  var floorY = ${faces ? 'in.vDepthFloor' : 'in.vDepthFoot.x'};
${gbuf
    ? `  let dw = u32(in.vDepthWord.x + 0.5);
  glow = glow || ((dw >> 21u) & 1u) != 0u;
  band = min(in.vDepthWord.y, ${PIXEL_DEPTH_BANDS - 1}.0);
${faces ? '' : '  if ((dw & 65535u) != 0u && ((dw >> 18u) & 1u) != 0u) { floorY = in.vWorld.y * uniforms.uDepth.x; }\n'}`
    : ''}  if (twinPresent(md) && twinHeights(in.vMapsWin) && !glow) { floorY = (in.vWorld.y + uniforms.uDepth.y * zd) * uniforms.uDepth.x; }
  let u = clamp((floorY - uniforms.uDepth.z) * uniforms.uDepth.w, 0.0, 1.0);
  let painter = in.vDepthFoot.y;
  let depth = (${faces ? DEPTH_FORMULA_FACES : DEPTH_FORMULA});
  return vec2<f32>(depth, select(0.0, 1.0, ad >= 0.5 && !glow));
}

// DX-FACEDEPTH (E-378): whether a pixel of an instance whose depth the vertex wrote is the opaque pass's: opaque, and not
// unshaded (vertexDepthBodyGlsl's WGSL).
fn weedVertexDepthKeep(in: VertexOut) -> bool {
  let ad = textureSample(uTexture, uSampler, weedUv(in.vLocal, in.vWorld, in.vAtlasUV, in.vTileInv, in.vTileOff)).a * in.vColor.a;
  var glow = twinUnshaded(in.vMapsWin);
${gbuf ? '  glow = glow || ((u32(in.vDepthWord.x + 0.5) >> 21u) & 1u) != 0u;\n' : ''}  return ad >= 0.5 && !glow;
}
`;

const FRAGMENT_ENTRY_WGSL = /@fragment\nfn (\w+)\(in: VertexOut\) -> @location\(0\) vec4<f32> \{/g;

/** H-EDGE: plainGlsl in WGSL (out.vPlain), after mainVert's own LUT read (its tid, lutSize and lutPerRow). */
function plainWgsl(gbuf) {
  return `  out.vPlain = 0.0;
  if (tid >= 0 && tid < lutPerRow * i32(lutSize.y) && i32(lutSize.x) > 3 * lutPerRow) {
    let weedSlot = tid % lutPerRow;
    if (weedSlot < ${TEX_LUT_FLAGS_PER_ROW}) {
      let weedFlags = textureLoad(uTexLut, vec2<i32>(3 * lutPerRow, tid / lutPerRow), 0);
      let weedC = weedSlot / ${TEX_LUT_FLAG_BITS};
      let weedF = select(select(select(weedFlags.w, weedFlags.z, weedC == 2), weedFlags.y, weedC == 1), weedFlags.x, weedC == 0);
      if (((u32(weedF) >> u32(weedSlot - ${TEX_LUT_FLAG_BITS} * weedC)) & 1u) == 0u) { out.vPlain = 1.0; }
    }
  }
${gbuf ? '  if (((u32(aInstGbuf.x + 0.5) >> 21u) & 1u) != 0u) { out.vPlain = 0.0; }\n' : ''}`;
}

/** DX-FACEDEPTH: facesDepthGlsl and cullGlsl in WGSL (after out.vMapsWin and out.vDepthFoot). */
function facesDepthWgsl(gbuf, cull) {
  const keep = cull === 'flat'
    ? '  if (!twinHeights(out.vMapsWin)) { out.position = vec4<f32>(2.0, 2.0, 2.0, 1.0); }\n'
    : cull === 'heights'
      ? `  if (twinHeights(out.vMapsWin)) {
    out.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  } else {
    let band = ${gbuf ? `min(aInstGbuf.y, ${PIXEL_DEPTH_BANDS - 1}.0)` : '0.0'};
    let u = clamp((depthFloor - uniforms.uDepth.z) * uniforms.uDepth.w, 0.0, 1.0);
    let painter = depthPainter;
    out.position.z = ${DEPTH_FORMULA_FACES};
  }
`
      : '';
  return `${facesDepthCoreWgsl(gbuf)}
  out.vDepthFloor = depthFloor;
  out.vDepthFoot.y = depthPainter;
${keep}`;
}

/** facesDepthCoreGlsl in WGSL: the locals depthFloor and depthPainter, from uniforms.uDepth (after the sprite's place). */
function facesDepthCoreWgsl(gbuf) {
  return `  var depthFloor = aInstXY.y * uniforms.uDepth.x;
  var depthPainter = f32(weedInstance & ${PIXEL_DEPTH_PAINTER_STEPS - 1}u);
  let dfCode = u32(aInstTileOff.x * ${FACE_CODE_SCALE}.0 + 0.5);
  if (dfCode != 0u && all(aInstTileInv == vec2<f32>(0.0))) {
    let dfF = (vec2<f32>(f32(dfCode >> 12u), f32(dfCode & 4095u)) - ${FACE_OCT_MID}.0) / ${FACE_OCT_HALF}.0;
    var dfN = vec3<f32>(dfF, 1.0 - abs(dfF.x) - abs(dfF.y));
    let dfT = max(-dfN.z, 0.0);
    dfN.x += select(dfT, -dfT, dfN.x >= 0.0);
    dfN.y += select(dfT, -dfT, dfN.y >= 0.0);
    let dfHeight = u32(aInstTileOff.y * ${FACE_CODE_SCALE}.0 + 0.5);
    let dfInner = f32(dfHeight >> ${FACE_INNER_Z_SHIFT}u);
    let dfD = world - aInstXY;
    let dfSlope = dfN.z + dfN.y * uniforms.uDepth.y * uniforms.uDepth.x;
    var dfDz = 0.0;
    if (abs(dfSlope) > 0.02) { dfDz = -(dfN.x * dfD.x + dfN.y * dfD.y * uniforms.uDepth.x) / dfSlope; }
    let dfZ = f32(dfHeight & ${FACE_Z_HEIGHT_MAX_CODE}u) / ${FACE_ROW_Z_UNITS}.0 + dfDz;
    depthFloor = (world.y + uniforms.uDepth.y * dfZ) * uniforms.uDepth.x + dfInner * ${FACE_INNER_Z_TIE.toFixed(4)};
    depthPainter = 0.0;
  }${gbuf ? ` else {
    let dfw = u32(aInstGbuf.x + 0.5);
    if ((dfw & 65535u) != 0u && ((dfw >> 18u) & 1u) != 0u) { depthFloor = world.y * uniforms.uDepth.x; }
  }` : ''}`;
}

/**
 * pixelDepthVertex and pixelDepthFragment in one, for the sprite WGSL (instancedSprite.wgsl or instancedSpritePose.wgsl,
 * after spriteIndexedWgsl for the indexed program, after gbufAttributeWgsl with `gbuf`): uDepth closes the sprite uniform
 * group's struct (Pixi lays a group out in its entries' order, and the batch adds uDepth last), the foot's floor y, the
 * painter step (the instance index) and the words go to the fragment, and every fragment entry keeps its name for the
 * opaque pass and gets one `<name>Edge` for the edge pass, each writing the floor depth (@builtin(frag_depth): a depth
 * attachment in the target) and discarding the other pass's pixels. The twin page is group 2's binding 5 (`maps`).
 * DX-FACEDEPTH: `faces` and `cull` as pixelDepthVertex's (vDepthFloor at location 6); with cull 'heights' each entry is
 * the vertex-depth opaque program's, writing no depth of its own (no `<name>Edge`).
 * @param {string} source
 * @param {{ poseAlpha?: boolean, gbuf?: boolean, faces?: boolean, cull?: 'none'|'flat'|'heights' }} [opts] `poseAlpha`:
 *   the group holds uPoseAlpha before uDepth though this source does not read it (the indexed program over a split
 *   batch's group); `gbuf`: the source takes aInstGbuf
 * @returns {string}
 */
export function pixelDepthWgsl(source, { poseAlpha = false, gbuf = false, faces = false, cull = 'none' } = {}) {
  const once = (text, find, add, what) => {
    if (text.split(find).length !== 2) throw new Error(`WeedJS: pixel depth needs the sprite WGSL (${what})`);
    return text.replace(find, () => find + add);
  };
  const pose = '  uPoseAlpha: f32,\n';
  const hasPose = source.split(pose).length === 2;
  let out = hasPose
    ? once(source, pose, '  uDepth: vec4<f32>,\n', 'uPoseAlpha')
    : once(source, '  uTileWorld: vec4<f32>,\n', `${poseAlpha ? pose : ''}  uDepth: vec4<f32>,\n`, 'uTileWorld');
  out = once(
    out,
    '  @location(5) vTileOff: vec2<f32>,\n',
    '  @location(8) @interpolate(flat) vDepthFoot: vec3<f32>,\n' +
      (gbuf ? '  @location(13) @interpolate(flat) vDepthWord: vec2<f32>,\n' : '') +
      '  @location(14) @interpolate(flat) vPlain: f32,\n  @location(15) @interpolate(flat) vMapsWin: vec4<f32>,\n' +
      (faces ? '  @location(6) vDepthFloor: f32,\n' : ''),
    'vTileOff',
  );
  out = once(out, '  @location(1) aInstXY: vec2<f32>,\n', '  @builtin(instance_index) weedInstance: u32,\n', 'aInstXY');
  out = once(
    out,
    '  out.position = vec4<f32>(clip.xy, aInstDepth, 1.0);\n',
    // N-194: z, the sprite's |scale y|, by which its twin's heights (frame px) become world heights.
    `  out.vDepthFoot = vec3<f32>(aInstXY.y * uniforms.uDepth.x, f32(weedInstance & ${PIXEL_DEPTH_PAINTER_STEPS - 1}u), abs(aInstScale.y));\n` +
      (gbuf ? '  out.vDepthWord = aInstGbuf.xy;\n' : '') + '  out.vMapsWin = twinWindow(tid);\n' + plainWgsl(gbuf) +
      (faces ? facesDepthWgsl(gbuf, cull) : ''),
    'out.position',
  );
  const entries = [];
  out = out.replace(FRAGMENT_ENTRY_WGSL, (whole, name) => {
    entries.push(name);
    return `fn ${name}Color(in: VertexOut) -> vec4<f32> {`;
  });
  if (entries.length === 0) throw new Error('WeedJS: pixel depth needs the sprite WGSL (a fragment entry)');
  let wrappers = '';
  for (const name of entries) {
    if (faces && cull === 'heights') {
      // The colour first: its textureSample comes before the discard, in uniform control flow.
      wrappers += `
@fragment
fn ${name}(in: VertexOut) -> @location(0) vec4<f32> {
  let c = ${name}Color(in);
  if (!weedVertexDepthKeep(in)) { discard; }
  return c;
}
`;
      continue;
    }
    for (const [entry, keep, edge] of [[name, 'd.y < 0.5', false], [`${name}Edge`, 'd.y > 0.5', true]]) {
      // The colour first: its textureSample comes before the discard, in uniform control flow.
      wrappers += `
@fragment
fn ${entry}(in: VertexOut) -> WeedDepthOut {
  var o: WeedDepthOut;
  o.color = ${name}Color(in);
  let d = weedPixelDepth(in, ${edge});
  if (${keep}) { discard; }
  o.depth = d.x;
  return o;
}
`;
    }
  }
  return out + depthWgsl({ gbuf, faces }) + wrappers;
}

/**
 * N-274: the G-buffer's one pass (faceMap.js's MRT: the face map and the ids map) takes the depth the colour pass takes, in
 * a depth attachment of its own at its size, tested (less) and written: each texel describes the surface the canvas
 * shows there, whatever order the painter drew them in. Before, the pass drew back to front with no depth, and where
 * pixel depth put a house in front of a wall the painter drew later, the light pass lit and shadowed the hidden wall over
 * the house. Its depth terms ride in uFaceSpace (x heightScaleY, y floorScaleY, z the view's top floor place, w 1 / its
 * span: pixelDepthTerms' third and fourth). N-266: with the colour pass's formula too: DEPTH_FORMULA_FACES (continuous) when
 * the batch's depth reads faces, else DEPTH_FORMULA, whose floor place goes in steps and leaves a tie within a step to the
 * painter's order; with the continuous one a near tie went the other way in rows, as the canvas never did (a lamp post
 * 3 px before a person, depthPairScene).
 */
const GBUF_DEPTH_TERMS_GLSL = 'vec4 uDepth = vec4(1.0 / uFaceSpace.y, uFaceSpace.x, uFaceSpace.z, uFaceSpace.w);';
const GBUF_DEPTH_TERMS_WGSL = 'let weedDepth = vec4<f32>(1.0 / uniforms.uFaceSpace.y, uniforms.uFaceSpace.x, uniforms.uFaceSpace.z, uniforms.uFaceSpace.w);';

/** `find` once in `text`, `add` after it; a source without it (or with two) throws. */
function gbufOnce(text, find, add, what) {
  if (text.split(find).length !== 2) throw new Error(`WeedJS: the G-buffer's depth needs the face map's shader (${what})`);
  return text.replace(find, () => find + add);
}

/**
 * N-274: the G-buffer's vertex shader (faceMap.js faceMapVertex with words) with each vertex's floor place and painter step
 * (vGbufFloor, vGbufPainter), as the colour pass's depth has them (facesDepthCoreGlsl).
 * @param {string} source
 * @returns {string}
 */
export function gbufDepthVertex(source) {
  const main = 'void main() {\n';
  if (source.split(main).length !== 2) throw new Error('WeedJS: the G-buffer\'s depth needs the face map\'s shader (main)');
  const out = source.replace(main, () => `out float vGbufFloor;\nflat out float vGbufPainter;\n${main}`);
  return gbufOnce(
    out,
    'vTileOff = aInstTileOff;\n',
    `  {\n    ${GBUF_DEPTH_TERMS_GLSL}${facesDepthCoreGlsl(true)}\n    vGbufFloor = depthFloor;\n    vGbufPainter = depthPainter;\n  }\n`,
    'vTileOff',
  );
}

/**
 * N-274: the G-buffer's fragment shader (faceMap.js faceGbufFragment) writing that depth for every texel it keeps: the
 * floor place its vertex wrote, or its own height where its frame has a height map, the zIndex band of its words.
 * @param {string} source
 * @param {{ faces?: boolean }} [opts] whether the batch's depth reads faces (the colour pass's formula, N-266)
 * @returns {string}
 */
export function gbufDepthFragment(source, { faces = true } = {}) {
  const main = 'void main() {\n';
  const cut = '  if (texture(uTexture, uv).a * vColor.a < 0.5) discard;\n';
  if (source.split(main).length !== 2) throw new Error('WeedJS: the G-buffer\'s depth needs the face map\'s fragment (main)');
  const depth = `in float vGbufFloor;
flat in float vGbufPainter;

// N-274: this texel's depth, as the colour pass's (pixelDepth.js depthBodyGlsl with faces).
float weedGbufDepth(vec2 uv) {
  ${GBUF_DEPTH_TERMS_GLSL}
  vec4 md = twinTexel(uv, vMapsWin);
  uint dw = uint(vGbuf.x + 0.5);
  bool glow = twinUnshaded(vMapsWin) || ((dw >> 21u) & 1u) != 0u;
  float floorY = vGbufFloor;
  if (twinPresent(md) && twinHeights(vMapsWin) && !glow) floorY = (vWorld.y + uDepth.y * twinZ(md) * vMapScale) * uDepth.x;
  float band = min(vGbuf.y, ${PIXEL_DEPTH_BANDS - 1}.0);
  float u = clamp((floorY - uDepth.z) * uDepth.w, 0.0, 1.0);
  float painter = vGbufPainter;
  return ${faces ? DEPTH_FORMULA_FACES : DEPTH_FORMULA};
}

`;
  return gbufOnce(source.replace(main, () => depth + main), cut, '  gl_FragDepth = weedGbufDepth(uv);\n', 'its alpha cut');
}

/** The unshaded pass's entry in a face module with words (faceMap.js faceIdsEntryWgsl), as N-266 replaces it. */
const UNSHADED_ENTRY_WGSL = `fn mainFragUnshaded(in: VertexOut) -> @location(0) vec4<f32> {
  let uv = weedUv(in.vLocal, in.vWorld, in.vAtlasUV, in.vTileInv, in.vTileOff);
  let t = textureSample(uTexture, uSampler, uv);
  let s = unshadedOf(in.vGbuf, in.vMapsWin);
  return vec4<f32>(t.rgb * in.vColor.rgb * in.vColor.a * s, t.a * in.vColor.a);
}
`;

/** N-266: the unshaded pass's entry with the colour pass's depth (faceMap.js faceUnshadedFragment with depth). */
const UNSHADED_DEPTH_ENTRY_WGSL = `fn mainFragUnshaded(in: VertexOut) -> WeedUnshadedOut {
  let uv = weedUv(in.vLocal, in.vWorld, in.vAtlasUV, in.vTileInv, in.vTileOff);
  let t = textureSample(uTexture, uSampler, uv);
  if (t.a * in.vColor.a < 0.5) { discard; }
  let s = unshadedOf(in.vGbuf, in.vMapsWin);
  var o: WeedUnshadedOut;
  o.color = vec4<f32>(t.rgb * in.vColor.rgb * in.vColor.a * s, t.a * in.vColor.a);
  o.depth = weedGbufDepth(in);
  return o;
}

struct WeedUnshadedOut {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}
`;

/**
 * N-274: gbufDepthVertex and gbufDepthFragment in WGSL, over faceMap.js faceMapWgsl with words (indexed or not): the
 * floor place and painter step out of the vertex (locations 8 and 14, free in the face map's), and the one pass's entry
 * (mainFragGbuf) writing the depth (@builtin(frag_depth)).
 * @param {string} source
 * @param {{ faces?: boolean }} [opts] whether the batch's depth reads faces (the colour pass's formula, N-266)
 * @returns {string}
 */
export function gbufDepthWgsl(source, { faces = true } = {}) {
  let out = gbufOnce(
    source,
    '  @location(5) vTileOff: vec2<f32>,\n',
    '  @location(8) vGbufFloor: f32,\n  @location(14) @interpolate(flat) vGbufPainter: f32,\n',
    'vTileOff',
  );
  if (!out.includes('@builtin(instance_index) weedInstance: u32')) {
    out = gbufOnce(out, '  @location(1) aInstXY: vec2<f32>,\n', '  @builtin(instance_index) weedInstance: u32,\n', 'aInstXY');
  }
  out = gbufOnce(
    out,
    '  out.position = vec4<f32>(clip.xy, aInstDepth, 1.0);\n',
    `  {\n    ${GBUF_DEPTH_TERMS_WGSL}\n${facesDepthCoreWgsl(true).split('uniforms.uDepth').join('weedDepth')}\n    out.vGbufFloor = depthFloor;\n    out.vGbufPainter = depthPainter;\n  }\n`,
    'out.position',
  );
  out = gbufOnce(out, '  @location(1) ids: vec4<f32>,\n', '  @builtin(frag_depth) depth: f32,\n', 'the one pass\'s outputs');
  out = gbufOnce(out, 'fn mainFragGbuf(in: VertexOut) -> WeedGbufOut {\n  var o: WeedGbufOut;\n', '  o.depth = weedGbufDepth(in);\n', 'mainFragGbuf');
  // N-266: the unshaded pass's entry, where the module has one, writes the same depth (a texel under half covered cut).
  if (out.split(UNSHADED_ENTRY_WGSL).length === 2) out = out.replace(UNSHADED_ENTRY_WGSL, () => UNSHADED_DEPTH_ENTRY_WGSL);
  return `${out}
// N-274: this texel's depth, as the colour pass's (pixelDepth.js weedPixelDepth with faces).
fn weedGbufDepth(in: VertexOut) -> f32 {
  ${GBUF_DEPTH_TERMS_WGSL}
  let uvd = weedUv(in.vLocal, in.vWorld, in.vAtlasUV, in.vTileInv, in.vTileOff);
  let md = twinTexel(uvd, in.vMapsWin);
  let dw = u32(in.vGbuf.x + 0.5);
  let glow = twinUnshaded(in.vMapsWin) || ((dw >> 21u) & 1u) != 0u;
  var floorY = in.vGbufFloor;
  if (twinPresent(md) && twinHeights(in.vMapsWin) && !glow) { floorY = (in.vWorld.y + weedDepth.y * twinZ(md) * in.vMapScale) * weedDepth.x; }
  let band = min(in.vGbuf.y, ${PIXEL_DEPTH_BANDS - 1}.0);
  let u = clamp((floorY - weedDepth.z) * weedDepth.w, 0.0, 1.0);
  let painter = in.vGbufPainter;
  return ${faces ? DEPTH_FORMULA_FACES : DEPTH_FORMULA};
}
`;
}
