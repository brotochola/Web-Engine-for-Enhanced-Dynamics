/**
 * DX-FACES: a sprite that is a flat face of a volume. A decoration can say where its surface looks and how high it is, and
 * the light pass then lights it as a surface in 3D instead of as the floor under its pixels.
 *
 * What a face carries, in two u16 columns that reach the GPU in the row's tile offsets (a face is never a tiled sprite):
 * - its normal, octahedral, one byte each from 1 to 253 (±1/2 falls on a byte: walls turned 45 degrees are common), so that
 *   0 reads "no face";
 * - the height of the sprite's position above the floor, in steps of 1/FACE_Z_UNITS px.
 *
 * The frame's picture of them is the face map: the same instances drawn again at the light pass's resolution in painter
 * order, RGBA8: the normal's two bytes, then the height's two. A sprite that is no face writes 0, so a person in front of a
 * wall takes the wall out of the picture there.
 *
 * Space: the scene's floor. x along the screen, y across the floor towards the camera (screen y / groundScaleY), z up. A
 * px of height rises heightScaleY px on the screen.
 */

/** Height steps a px. 16 bits hold 8 191 px. */
import { resolveHeightScaleY } from '../util/cameraView.js';

export const FACE_Z_UNITS = 8;

export const FACE_DEFAULTS = Object.freeze({
  enabled: false,
  /** Screen px a px of height rises: config.camera.heightScaleY (resolveFaces fills it in). */
  heightScaleY: 1,
  /** A light's cosine lifted past the terminator: 0 = hard Lambert, 1 = half-Lambert. */
  wrap: 0,
  /** A light's strength on a face against the floor's. */
  gain: 1,
  /** How much of the sun's term depends on where a face looks; the rest is its sky, the same on every face. */
  sunDirect: 0.6,
});

/**
 * DX-GBUF (plan §6.4): the face map's codes beyond a normal. A normal's bytes are 1..253, so (0, 0) is "no face" (the
 * floor), (1, 0) a glowing pixel (DX-EMISSIVE v1) and (254, 254) a pixel lit as drawn at its place in 3D (FLAT: a sprite
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
const IDS_TEXEL_GLSL = `vec4 idsTexel(vec2 gbuf, bool render) {
  uint word = uint(gbuf.x + 0.5);
  uint id = word & 65535u;
  uint selfMode = (word >> 22u) & 3u;
  bool selfOn = id != 0u && (selfMode == 1u || (selfMode == 0u && render));
  return vec4(float(id >> 8u) / 255.0, float(id & 255u) / 255.0, selfOn ? ${FACE_IDS_SELF}.0 / 255.0 : 0.0, 1.0);
}`;

/**
 * The ids map's fragment shader (WebGL): over faceMapVertex's outputs with words, the face map's coverage, the ids texel.
 * @returns {string}
 */
export function faceIdsFragment() {
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
uniform sampler2D uTexture;
out vec4 finalColor;

${WEED_UV_GLSL}

${IDS_TEXEL_GLSL}

// DX-GBUF: the entity ids map (faceMap.js FACE_IDS_SELF): what entity covers this pixel, in painter order.
void main() {
  if (texture(uTexture, weedUv()).a * vColor.a < 0.5) discard;
  finalColor = idsTexel(vGbuf, vRender > 0.5);
}
`;
}

/**
 * DX-GBUF (plan §6.4, lighting.gbuffer 'mrt'): faceMap.frag.glsl writing the face map and the entity ids map in one pass,
 * two colour targets (WebGL 2's draw buffers): the face texel at location 0 as faceMap.frag.glsl writes it, the ids texel
 * at 1 (faceIdsFragment's), for the same coverage.
 * @param {string} faceFrag faceMap.frag.glsl
 * @returns {string}
 */
export function faceGbufFragment(faceFrag) {
  const src = shaderWithFlag(faceFrag, 'GBUF', true);
  const out = 'out vec4 finalColor;\n';
  const cut = '  if (texture(uTexture, uv).a * vColor.a < 0.5) discard;\n';
  for (const mark of [out, cut]) {
    if (src.split(mark).length !== 2) throw new Error(`WeedJS: the G-buffer's one pass needs faceMap.frag.glsl (${mark.trim()})`);
  }
  return src
    .replace(
      out,
      () => `layout(location = 0) out vec4 finalColor;\nlayout(location = 1) out vec4 finalIds;\nflat in float vRender;\n\n${IDS_TEXEL_GLSL}\n`,
    )
    .replace(cut, () => `${cut}  finalIds = idsTexel(vGbuf, vRender > 0.5);\n`);
}

/** The words' input of a sprite WGSL's mainVert (DX-GBUF, gbufWord.js): a free location, read or not. */
const GBUF_ATTRIBUTE_WGSL = '  @location(12) aInstGbuf: vec2<f32>,\n';

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
  if (source.split(at).length !== 2) throw new Error('WeedJS: the G-buffer words need the sprite WGSL (aInstXY)');
  return source.replace(at, () => at + GBUF_ATTRIBUTE_WGSL);
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
  if (source.split(main).length !== 2 || source.split(end).length !== 2) {
    throw new Error('WeedJS: the face map needs one main and one vTileOff in the sprite vertex shader');
  }
  const gbufDecl = gbuf ? 'in vec2 aInstGbuf;\nflat out vec2 vGbuf;\nout float vFootY;\nflat out float vRender;\n' : '';
  // vRender: the frame is a render (its base a contact, frameBase.js lutBaseFloats: the table's third texel's z below 0),
  // whose selfShadow the asset's way is on (plan §5.5).
  const gbufOut = gbuf
    ? `  vGbuf = aInstGbuf;
  vFootY = world.y - (isShear ? sheared.y : spun.y) + (aInstTrim.y + aInstTrim.w - aInstAnchor.y * aInstSize.y) * abs(aInstScale.y);
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
      'uniform vec4 uFaceSpace; // heightScaleY, groundScaleY\nflat out vec2 vFaceOct;\nout float vFaceZ;\n' + gbufDecl + '\n' + main,
    )
    .replace(
      end,
      end +
        gbufOut +
        `  uint faceCode = uint(aInstTileOff.x * 65535.0 + 0.5);
  vFaceOct = vec2(0.0);
  vFaceZ = 0.0;
  if (faceCode != 0u && aInstTileInv == vec2(0.0)) {
    vec2 faceBytes = vec2(float(faceCode >> 8u), float(faceCode & 255u));
    vFaceOct = faceBytes / 255.0;
    vec2 faceF = (faceBytes - 127.0) / 126.0;
    vec3 faceN = vec3(faceF, 1.0 - abs(faceF.x) - abs(faceF.y));
    float faceT = max(-faceN.z, 0.0);
    faceN.x += faceN.x >= 0.0 ? -faceT : faceT;
    faceN.y += faceN.y >= 0.0 ? -faceT : faceT;
    vec2 faceD = world - aInstXY;
    float faceSlope = faceN.z + faceN.y * uFaceSpace.x / uFaceSpace.y;
    float faceDz = abs(faceSlope) > 0.02 ? -(faceN.x * faceD.x + faceN.y * faceD.y / uFaceSpace.y) / faceSlope : 0.0;
    vFaceZ = aInstTileOff.y * ${(65535 / FACE_Z_UNITS).toFixed(4)} + faceDz;
  }
`,
    );
}

/**
 * faceMapVertex's WGSL form, on the sprite program before spriteIndexedWgsl if it is the indexed one, with the fragment
 * entry `mainFragFace` that writes the map (its texel from weedFace, faceFunctionsWgsl).
 * DX-GBUF: with `gbuf`, the instance's words (vGbuf) and its foot's world y (vFootY), as faceMapVertex passes them.
 * @param {string} source instancedSprite.wgsl or instancedSpritePose.wgsl
 * @param {{ gbuf?: boolean }} [opts]
 * @returns {string}
 */
export function faceMapWgsl(source, { gbuf = false } = {}) {
  return `${faceVertexWgsl(source, { gbuf })}${faceFunctionsWgsl({ gbuf })}
// DX-FACES: faceMap.frag.glsl
@fragment
fn mainFragFace(in: VertexOut) -> @location(0) vec4<f32> {
  return weedFace(in);
}
${gbuf ? FACE_IDS_ENTRY_WGSL : ''}`;
}

/** DX-GBUF: the ids map's texel and its fragment entry (faceIdsFragment's WGSL), in a face module with words. */
const FACE_IDS_ENTRY_WGSL = `
// DX-GBUF: the ids map's texel of a word (faceMap.js IDS_TEXEL_GLSL).
fn idsTexel(gbuf: vec2<f32>, render: bool) -> vec4<f32> {
  let word = u32(gbuf.x + 0.5);
  let id = word & 65535u;
  let selfMode = (word >> 22u) & 3u;
  let selfOn = id != 0u && (selfMode == 1u || (selfMode == 0u && render));
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
 * and with `gbuf` the words' input (gbufAttributeWgsl) and outputs.
 * @param {string} source
 * @param {{ gbuf?: boolean }} [opts]
 * @returns {string}
 */
export function faceVertexWgsl(source, { gbuf = false } = {}) {
  const once = (text, find, add) => {
    if (text.split(find).length !== 2) throw new Error(`WeedJS: the face map needs one "${find.trim()}" in the sprite WGSL`);
    return text.replace(find, () => find + add);
  };
  let out = once(source, '  uTileWorld: vec4<f32>,\n', '  uFaceSpace: vec4<f32>, // heightScaleY, groundScaleY\n');
  out = once(
    out,
    '  @location(5) vTileOff: vec2<f32>,\n',
    '  @location(6) @interpolate(flat) vFaceOct: vec2<f32>,\n  @location(7) vFaceZ: f32,\n' +
      (gbuf
        ? '  @location(9) @interpolate(flat) vGbuf: vec2<f32>,\n  @location(10) vFootY: f32,\n' +
          '  @location(11) @interpolate(flat) vRender: f32,\n'
        : ''),
  );
  if (gbuf) out = gbufAttributeWgsl(out);
  const gbufOut = gbuf
    ? `  out.vGbuf = aInstGbuf;
  out.vFootY = world.y - select(spun, sheared, isShear).y
    + (aInstTrim.y + aInstTrim.w - aInstAnchor.y * aInstSize.y) * abs(aInstScale.y);
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
      `  let faceCode = u32(aInstTileOff.x * 65535.0 + 0.5);
  out.vFaceOct = vec2<f32>(0.0);
  out.vFaceZ = 0.0;
  if (faceCode != 0u && all(aInstTileInv == vec2<f32>(0.0))) {
    let faceBytes = vec2<f32>(f32(faceCode >> 8u), f32(faceCode & 255u));
    out.vFaceOct = faceBytes / 255.0;
    let faceF = (faceBytes - 127.0) / 126.0;
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
    out.vFaceZ = aInstTileOff.y * ${(65535 / FACE_Z_UNITS).toFixed(4)} + faceDz;
  }
`,
  );
  return out;
}

/** DX-GBUF's WGSL helpers (faceMap.frag.glsl twinHeight and heightNormal): normals 'height', the heights' Sobel. */
const FACE_GBUF_HELPERS_WGSL = `
// DX-GBUF: a twin texel's height (px), or \`here\` where it has no map (faceMap.frag.glsl twinHeight).
fn faceTwinHeight(c: vec2<i32>, here: f32) -> f32 {
  let m = textureLoad(uMaps, c, 0);
  return select(here, (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / 64.0, m.b + m.a > 0.0);
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
export function faceFunctionsWgsl({ gbuf = false } = {}) {
  const flat = `vec2<f32>(${FACE_FLAT_CODE}.0 / 255.0)`;
  const gbufBlock = gbuf
    ? `  // DX-GBUF (plan §5.4): an entity's sprite as its normals and surface say (faceMap.frag.glsl's GBUF block).
  let word = u32(in.vGbuf.x + 0.5);
  if (noFace && (word & 65535u) != 0u) {
    let flags = (word >> 16u) & 63u;
    let normals = flags & 3u;
    if (m.b + m.a > 0.0) {
      let zm = (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / 64.0;
      if (normals == 3u) { return faceTexel(${flat}, zm, false); }
      var n = faceOctDecode(floor(m.ba * 255.0 + 0.5));
      if (normals == 2u) { n = faceHeightNormal(tc, zm); }
      return faceTexel(faceOctEncode(vec3<f32>(n.x, n.z * sc.y - n.y * sc.x, n.y * sc.y + n.z * sc.x)), zm, true);
    }
    if ((flags & 4u) == 0u) {
      return faceTexel(${flat}, max(in.vFootY - in.vWorld.y, 0.0) / uniforms.uFaceSpace.x, false);
    }
    return vec4<f32>(0.0);
  }
`
    : '';
  return `
// DX-MAPS: the atlas's twin page (spriteMaps.js). Binding 5: the indexed program takes 4.
@group(2) @binding(5) var uMaps: texture_2d<f32>;

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
${gbuf ? FACE_GBUF_HELPERS_WGSL : ''}
// DX-FACES (faceMap.frag.glsl): what this pixel is, in painter order, or a discard where the sprite is not opaque.
fn weedFace(in: VertexOut) -> vec4<f32> {
  let uv = weedUv(in.vLocal, in.vWorld, in.vAtlasUV, in.vTileInv, in.vTileOff);
  let t = textureSample(uTexture, uSampler, uv);
  let tc = vec2<i32>(uv * vec2<f32>(textureDimensions(uMaps, 0)));
  let m = textureLoad(uMaps, tc, 0);
  if (t.a * in.vColor.a < 0.5) { discard; }
  var oct = in.vFaceOct;
  var z = in.vFaceZ;
  let noFace = all(oct == vec2<f32>(0.0));
  // DX-EMISSIVE: a glowing pixel is (1/255, 0) in the face map (faceMap.frag.glsl).
  if (noFace && m.b < 0.5 / 255.0 && m.a > 254.5 / 255.0) {
    return vec4<f32>(1.0 / 255.0, 0.0, 0.0, 0.0);
  }
  let sc = normalize(vec2<f32>(uniforms.uFaceSpace.y, uniforms.uFaceSpace.x));
${gbufBlock}  if (noFace && m.b + m.a > 0.0) {
    let n = faceOctDecode(floor(m.ba * 255.0 + 0.5));
    oct = faceOctEncode(vec3<f32>(n.x, n.z * sc.y - n.y * sc.x, n.y * sc.y + n.z * sc.x));
    z = (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / 64.0;
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
 * the GLSL and the WGSL alike.
 * @param {string} source lightingBasic.frag.glsl or lightingBasic.wgsl
 * @param {{ faces: boolean, sunMap: boolean, selfShadow?: boolean, lampMap?: boolean, ids?: boolean }} flags
 */
export function lightingSource(source, { faces, sunMap, selfShadow = false, lampMap = false, ids = false }) {
  const withSun = shaderWithFlag(shaderWithFlag(shaderWithFlag(source, 'FACES', faces), 'SUNMAP', sunMap), '!SUNMAP', !sunMap);
  const withLamps = shaderWithFlag(shaderWithFlag(withSun, 'SELFSHADOW', faces && selfShadow), 'LAMPMAP', lampMap);
  return shaderWithFlag(shaderWithFlag(withLamps, 'IDS', faces && ids), '!IDS', !(faces && ids));
}

/** config.lighting.faces over its defaults. */
export function resolveFaces(lighting, camera = null) {
  const faces = lighting?.faces;
  const heightScaleY = resolveHeightScaleY(camera);
  if (!faces?.enabled || lighting.raycasted) return { ...FACE_DEFAULTS, heightScaleY };
  return { ...FACE_DEFAULTS, ...faces, heightScaleY };
}

/**
 * @param {number} nx
 * @param {number} ny
 * @param {number} nz
 * @returns {number} the u16 of faceOct; 0 for a zero vector (no face)
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
  return (Math.round(u * 126 + 127) << 8) | Math.round(v * 126 + 127);
}

/** What the shaders decode: a unit normal, in `out`. */
export function decodeFaceNormal(code, out) {
  const fx = (((code >> 8) & 255) - 127) / 126;
  const fy = ((code & 255) - 127) / 126;
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

/** @returns {number} the u16 of faceZ */
export function encodeFaceHeight(z) {
  const code = Math.round(z * FACE_Z_UNITS);
  return code < 0 ? 0 : code > 65535 ? 65535 : code;
}
