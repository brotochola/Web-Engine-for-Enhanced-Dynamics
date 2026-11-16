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
 * depth; the edge pass (its edge mesh, right after it, the same instances) draws the soft edges and the glowing pixels,
 * testing depth without writing it, blended over what is there in painter order. A soft edge of a sprite behind is then
 * hidden by an opaque one in front whatever the painter's order, and one in front blends over it.
 *
 * The depth's 23 bits, nearer first: the zIndex band (3 bits, DX-GBUF's word: a higher zIndex is always in front, as the
 * painter has it, R-0169), the floor place (13 bits over the view's floor span and a margin), then the painter's order in
 * 7 bits (the instance index's low bits: rows on the same floor place tie in painter order, a later one in front). Without
 * the words every band is 0.
 *
 * WebGL (pixelDepthVertex, pixelDepthFragment) and WebGPU (pixelDepthWgsl).
 */

import { TEX_LUT_FLAG_BITS, TEX_LUT_FLAGS_PER_ROW } from './frameBase.js';

/** The floor span's margin past the view, floor px: a tall object's top in view stands this far past its floor place. */
export const PIXEL_DEPTH_MARGIN = 1024;
/** Floor places the depth tells apart (13 bits), zIndex bands (3 bits) and painter steps (7 bits): 23 bits in all. */
export const PIXEL_DEPTH_FLOOR_STEPS = 8192;
export const PIXEL_DEPTH_BANDS = 8;
export const PIXEL_DEPTH_PAINTER_STEPS = 128;

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
 * view's span, 1 south), the painter step (an instance index).
 */
export function pixelDepthValue(band, u, instance) {
  const b = Math.min(Math.max(band, 0), PIXEL_DEPTH_BANDS - 1);
  const q = Math.floor(Math.min(Math.max(u, 0), 1) * (PIXEL_DEPTH_FLOOR_STEPS - 1));
  const p = instance & (PIXEL_DEPTH_PAINTER_STEPS - 1);
  const d = (PIXEL_DEPTH_BANDS - 1 - b) * PIXEL_DEPTH_FLOOR_STEPS * PIXEL_DEPTH_PAINTER_STEPS
    + (PIXEL_DEPTH_FLOOR_STEPS - 1 - q) * PIXEL_DEPTH_PAINTER_STEPS
    + (PIXEL_DEPTH_PAINTER_STEPS - 1 - p);
  return d / (PIXEL_DEPTH_BANDS * PIXEL_DEPTH_FLOOR_STEPS * PIXEL_DEPTH_PAINTER_STEPS);
}

/**
 * H-EDGE: whether this instance's frame is plain (vPlain 1.0, GLSL): its soft-or-glow bit clear in its row's flags texel
 * (frameBase.js TEX_LUT_SOFT_OR_GLOW), read after the vertex shader's own LUT read (its tid, lutSize and lutPerRow), and
 * with `gbuf` no emissive level in its word. A table without the texel, or a slot past it, reads as not plain.
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
  }${gbuf ? '\n  if (((uint(aInstGbuf.x + 0.5) >> 19u) & 7u) != 0u) vPlain = 0.0;' : ''}`;
}

/**
 * A sprite vertex shader (instancedSprite.vert.glsl, or its indexed forms) passing on its foot's floor y, its painter step
 * (the instance index's low bits), with `gbuf` its words (the zIndex band and the surface), and H-EDGE's vPlain.
 * @param {string} source
 * @param {{ gbuf?: boolean }} [opts]
 */
export function pixelDepthVertex(source, { gbuf = false } = {}) {
  const decl = 'out vec2 vTileOff;\n';
  const pos = 'gl_Position = vec4(clip.xy, aInstDepth, 1.0);';
  for (const mark of [decl, pos]) {
    if (source.split(mark).length !== 2) throw new Error(`WeedJS: pixel depth needs the sprite vertex shader (${mark.trim()})`);
  }
  const words = gbuf
    ? `${source.includes('in vec2 aInstGbuf;') ? '' : 'in vec2 aInstGbuf;\n'}flat out vec2 vDepthWord;\n`
    : '';
  // N-194: vPainter's y is the sprite's |scale y|, by which its twin's heights (frame px) become world heights.
  return source
    .replace(decl, () => `${decl}out float vFootFloor;\nflat out vec2 vPainter;\nflat out float vPlain;\nuniform vec4 uDepth;\n${words}`)
    .replace(
      pos,
      () => `${pos}\n  vFootFloor = aInstXY.y * uDepth.x;\n  vPainter = vec2(float(gl_InstanceID & ${PIXEL_DEPTH_PAINTER_STEPS - 1}), abs(aInstScale.y));` +
        (gbuf ? '\n  vDepthWord = aInstGbuf;' : '') + plainGlsl(gbuf),
    );
}

/**
 * H-EDGE: the pixels a pass draws nothing for, known from the texture's alpha times the tint's (`ad`, GLSL and WGSL alike),
 * so they leave before the twin page and the depth. The opaque pass keeps none under 0.5 (whether it glows or not). The
 * edge pass draws a pixel of alpha 0 as nothing: its colour is premultiplied 0 (the atlas's alpha is premultiplied on
 * upload, and the tint's alpha scales the colour too), it writes no depth, and a zero blends to the pixel under it. Nor
 * does it draw a solid one (alpha 0.5 and up) unless it glows, which an instance of a plain frame (`plain`, the vertex
 * stage's vPlain: no soft or glowing texel, no emissive word) never does.
 */
const EARLY_DISCARD = (edge, plain = 'vPlain') => (edge ? `ad <= 0.0 || (ad >= 0.5 && ${plain} > 0.5)` : 'ad < 0.5');

/** DEPTH_BODY's depth from the floor place, the band and the painter step (GLSL and WGSL alike). */
const DEPTH_FORMULA = `(${PIXEL_DEPTH_BANDS - 1}.0 - band) * ${PIXEL_DEPTH_FLOOR_STEPS * PIXEL_DEPTH_PAINTER_STEPS}.0
      + (${PIXEL_DEPTH_FLOOR_STEPS - 1}.0 - floor(u * ${PIXEL_DEPTH_FLOOR_STEPS - 1}.0)) * ${PIXEL_DEPTH_PAINTER_STEPS}.0
      + (${PIXEL_DEPTH_PAINTER_STEPS - 1}.0 - painter)) / ${PIXEL_DEPTH_BANDS * PIXEL_DEPTH_FLOOR_STEPS * PIXEL_DEPTH_PAINTER_STEPS}.0`;

/**
 * The fragment's depth body (GLSL): the floor place, the depth, and the pass's pixels: `edge` false (the opaque pass)
 * keeps the opaque pixels that do not glow, true (the edge pass) the others. H-EDGE: the texture's alpha comes first, and
 * a pixel the pass draws nothing for leaves before the twin page and the depth (EARLY_DISCARD).
 */
function depthBodyGlsl({ edge, gbuf }) {
  return `  {
    // DX-DEPTH: this pixel's place on the floor: at its own height when its frame has a height map, its own when the
    // sprite lies flat, else its sprite's foot; the zIndex band first and the painter's order last (pixelDepth.js).
    vec2 uvd = weedUv();
    float ad = texture(uTexture, uvd).a * vColor.a;
    if (${EARLY_DISCARD(edge)}) discard;
    vec4 md = texelFetch(uMaps, ivec2(uvd * vec2(textureSize(uMaps, 0))), 0);
    float zd = (floor(md.r * 255.0 + 0.5) * 256.0 + floor(md.g * 255.0 + 0.5)) / 64.0 * vPainter.y;
    bool glow = md.b < 0.5 / 255.0 && md.a > 254.5 / 255.0;
    float band = 0.0;
    float floorY = vFootFloor;
${gbuf
    ? `    uint dw = uint(vDepthWord.x + 0.5);
    glow = glow || ((dw >> 19u) & 7u) != 0u;
    band = min(vDepthWord.y, ${PIXEL_DEPTH_BANDS - 1}.0);
    if ((dw & 65535u) != 0u && ((dw >> 18u) & 1u) != 0u) floorY = vWorld.y * uDepth.x;
`
    : ''}    if (md.b + md.a > 0.0 && !glow) floorY = (vWorld.y + uDepth.y * zd) * uDepth.x;
    float u = clamp((floorY - uDepth.z) * uDepth.w, 0.0, 1.0);
    float painter = vPainter.x;
    gl_FragDepth = (${DEPTH_FORMULA};
    // F5 v2: only opaque pixels write depth; the edge pass draws the soft and the glowing ones, testing it.
    bool solid = ad >= 0.5 && !glow;
    if (${edge ? 'solid' : '!solid'}) discard;
  }
`;
}

/**
 * A sprite fragment shader writing that depth (gl_FragDepth, first thing, so every path that draws writes it) and keeping
 * its pass's pixels: `edge` false, the opaque pass (alpha 0.5 and up, not glowing); true, the edge pass (the others).
 * @param {string} source
 * @param {{ edge?: boolean, gbuf?: boolean }} [opts]
 */
export function pixelDepthFragment(source, { edge = false, gbuf = false } = {}) {
  const decl = 'uniform sampler2D uTexture;\n';
  const main = 'void main() {\n';
  for (const mark of [decl, main]) {
    if (source.split(mark).length !== 2) throw new Error(`WeedJS: pixel depth needs the sprite fragment shader (${mark.trim()})`);
  }
  return source
    .replace(
      decl,
      () => `${decl}uniform sampler2D uMaps;\nuniform vec4 uDepth;\nin float vFootFloor;\nflat in vec2 vPainter;\n${edge ? 'flat in float vPlain;\n' : ''}${gbuf ? 'flat in vec2 vDepthWord;\n' : ''}`,
    )
    .replace(main, () => `${main}${depthBodyGlsl({ edge, gbuf })}`);
}

// DX-DEPTH: the depth body in WGSL, a function of the fragment's inputs (vDepthFoot: the foot's floor y, the painter step;
// vDepthWord: the words), returning the depth and whether the pixel is the opaque pass's (1) or the edge pass's (0).
const depthWgsl = ({ gbuf }) => `
// DX-DEPTH: the atlas's twin page (spriteMaps.js), read where the colour is (pixelDepth.js).
@group(2) @binding(5) var uMaps: texture_2d<f32>;

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
  let md = textureLoad(uMaps, vec2<i32>(uvd * vec2<f32>(textureDimensions(uMaps, 0))), 0);
  let zd = (floor(md.r * 255.0 + 0.5) * 256.0 + floor(md.g * 255.0 + 0.5)) / 64.0 * in.vDepthFoot.z;
  var glow = md.b < 0.5 / 255.0 && md.a > 254.5 / 255.0;
  var band = 0.0;
  var floorY = in.vDepthFoot.x;
${gbuf
    ? `  let dw = u32(in.vDepthWord.x + 0.5);
  glow = glow || ((dw >> 19u) & 7u) != 0u;
  band = min(in.vDepthWord.y, ${PIXEL_DEPTH_BANDS - 1}.0);
  if ((dw & 65535u) != 0u && ((dw >> 18u) & 1u) != 0u) { floorY = in.vWorld.y * uniforms.uDepth.x; }
`
    : ''}  if (md.b + md.a > 0.0 && !glow) { floorY = (in.vWorld.y + uniforms.uDepth.y * zd) * uniforms.uDepth.x; }
  let u = clamp((floorY - uniforms.uDepth.z) * uniforms.uDepth.w, 0.0, 1.0);
  let painter = in.vDepthFoot.y;
  let depth = (${DEPTH_FORMULA};
  return vec2<f32>(depth, select(0.0, 1.0, ad >= 0.5 && !glow));
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
${gbuf ? '  if (((u32(aInstGbuf.x + 0.5) >> 19u) & 7u) != 0u) { out.vPlain = 0.0; }\n' : ''}`;
}

/**
 * pixelDepthVertex and pixelDepthFragment in one, for the sprite WGSL (instancedSprite.wgsl or instancedSpritePose.wgsl,
 * after spriteIndexedWgsl for the indexed program, after gbufAttributeWgsl with `gbuf`): uDepth closes the sprite uniform
 * group's struct (Pixi lays a group out in its entries' order, and the batch adds uDepth last), the foot's floor y, the
 * painter step (the instance index) and the words go to the fragment, and every fragment entry keeps its name for the
 * opaque pass and gets one `<name>Edge` for the edge pass, each writing the floor depth (@builtin(frag_depth): a depth
 * attachment in the target) and discarding the other pass's pixels. The twin page is group 2's binding 5 (`maps`).
 * @param {string} source
 * @param {{ poseAlpha?: boolean, gbuf?: boolean }} [opts] `poseAlpha`: the group holds uPoseAlpha before uDepth though
 *   this source does not read it (the indexed program over a split batch's group); `gbuf`: the source takes aInstGbuf
 * @returns {string}
 */
export function pixelDepthWgsl(source, { poseAlpha = false, gbuf = false } = {}) {
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
      '  @location(14) @interpolate(flat) vPlain: f32,\n',
    'vTileOff',
  );
  out = once(out, '  @location(1) aInstXY: vec2<f32>,\n', '  @builtin(instance_index) weedInstance: u32,\n', 'aInstXY');
  out = once(
    out,
    '  out.position = vec4<f32>(clip.xy, aInstDepth, 1.0);\n',
    // N-194: z, the sprite's |scale y|, by which its twin's heights (frame px) become world heights.
    `  out.vDepthFoot = vec3<f32>(aInstXY.y * uniforms.uDepth.x, f32(weedInstance & ${PIXEL_DEPTH_PAINTER_STEPS - 1}u), abs(aInstScale.y));\n` +
      (gbuf ? '  out.vDepthWord = aInstGbuf;\n' : '') + plainWgsl(gbuf),
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
  return out + depthWgsl({ gbuf }) + wrappers;
}
