/**
 * DX-SHADOW3D (F6, F7): VolumeShadowCaster's volumes in the shadow maps. Their batch (MeshUvFillBatch: meshUvFill.vert.glsl
 * and meshUvFill.wgsl) already moves each vertex by its height (the U column, screen px) times uSunShadow.xy; drawn again
 * with these programs, max blending, it writes the heights its vertices carry:
 * - into the sun's map (WebGL: sunShadowMap.js volumeMapVertex and VOLUME_MAP_FRAGMENT; WebGPU: volumeMapWgsl), each
 *   vertex landing by the map's shift, its height in the map's units (uSunShadow.w: 1 / heightScaleY);
 * - into the lamps' map (lampShadowMap.js), each mesh once a tile in use, in one draw (volumeLampVertex / volumeLampWgsl;
 *   E-389, E-453: the batch's vertices and index buffer drawn with an instance a tile, the instance's number the tile's):
 *   uSunShadow.xy 0, so the vertex stays on its floor point P = (x, screen y / groundScaleY), which lands along the tile's
 *   lamp's ray at
 *   L + (P - L) · E / (E - z) (DX-LAMPPANO: compressed into the floor's half of the tile out to the horizon, the stretch
 *   drawn at most LAMP_MAP_MAX_STRETCH), in the tile, drawn with w = (E - z) / E so the
 *   heights spread over the shadow as the rays carry them, cut to the tile by the fragment. N-276: each fragment then takes
 *   its texel and its depth from where its own ray meets the volume's face (lampVolumeRayT), since the vertices'
 *   interpolation is the projection only within the reach. The tile's lamp is the tiles'
 *   texture's row 0 (writeLampTile: its floor point, height and reach). A mesh whose floor footprint (its anchor, give or
 *   take its reach: the farthest of its vertices, MESH_UV_VERT.REACH) lies past one edge of the tile is left out in its
 *   vertices, every one of them alike: its landing lies further past it. So is one of the lamp's own entity (the tiles'
 *   texture's row 1, writeLampTileOwner; a vertex's aInstBody is its entity), as pre-render drops a lamp's own stamp rows:
 *   a car's headlights are not shaded by the car's volume.
 */

import { MAP_TEXEL_WGSL, SUN_MAP_ZMAX } from './sunShadowMap.js';
import {
  LAMP_MAP_MAX_STRETCH, LAMP_MAP_ZMAX, LAMP_PANO_GLSL, LAMP_PANO_INNER, LAMP_PANO_WGSL, lampClipZGlsl, lampClipZWgsl,
} from './lampShadowMap.js';
import { gpuStageF, gpuStageVF } from './webgpu/pixiMeshWgsl.js';
import { hasOnce } from './shaderEdit.js';

/** The source with `add` after its one `find`, or a clear error. */
function after(source, find, add, what) {
  if (typeof source !== 'string' || !hasOnce(source, find)) {
    throw new Error(`WeedJS: ${what} needs the volumes' mesh shader (${find.trim()})`);
  }
  return source.replace(find, () => find + add);
}

// E-453: the batch draws each mesh's vertices once through its index buffer, and the lamps' map draws that once a tile in
// use, instanced: the instance is the tile (E-389 drew three vertices a tile over the rows, the tile their number over 3).
// The fill shader writes no depth (0.5); the maps write their own.
const POSITION_GLSL = 'gl_Position = vec4(clip.xy, 0.5, 1.0);';
const POSITION_WGSL = '  out.position = vec4<f32>(clip.xy, 0.5, 1.0);\n';

/** The smallest w (1 / the stretch) a vertex under a lamp is drawn with. */
const MIN_W = (1 / LAMP_MAP_MAX_STRETCH).toFixed(6);

const SUN_FRAGMENT_WGSL = `
${MAP_TEXEL_WGSL}
// DX-SHADOW3D (F6): a volume's height where its sun ray lands, the highest kept by its depth (which its vertices write)
// with the volume's entity (sunShadowMap.js VOLUME_MAP_FRAGMENT).
@fragment
fn mainFragMap(in: VertexOut) -> @location(0) vec4<f32> {
  return weedMapTexel(in.vSunZ, in.vSunId, 1.0);
}
`;

/**
 * volumeMapVertex's WGSL form (WebGPU): meshUvFill.wgsl passing its height on in the map's units (uSunShadow.w), and the
 * map's fragment entry `mainFragMap`.
 * @param {string} source meshUvFill.wgsl
 * @returns {string}
 */
export function volumeMapWgsl(source) {
  const what = "the sun map's volumes";
  let out = after(
    source,
    '  @location(7) vMeshUV: vec2<f32>,\n',
    '  @location(8) vSunZ: f32,\n  @location(10) @interpolate(flat) vSunId: f32,\n',
    what,
  );
  out = after(
    out,
    POSITION_WGSL,
    `  out.vSunZ = height * sunShadow.uSunShadow.w;\n  out.position.z = 1.0 - clamp(out.vSunZ / ${SUN_MAP_ZMAX}.0, 0.0, 1.0);\n${VOLUME_ID_WGSL}`,
    what,
  );
  return out + SUN_FRAGMENT_WGSL;
}

// DX-GBUF: a volume's entity is its vertices' body (the pose table's index), as the G-buffer's id (gbufWord.js).
const VOLUME_ID_GLSL = '  vSunId = float(int(aInstBody + 0.5) % 65535 + 1);';
const VOLUME_ID_WGSL = '  out.vSunId = f32(u32(aInstBody + 0.5) % 65535u + 1u);\n';

// The lamp's landing in GLSL, after meshUvFill.vert.glsl's gl_Position (its xy, f, world and mvp in scope).
const LAMP_GLSL = `
  // DX-SHADOW3D (F7): towards this vertex's lamp (volumeShadowMap.js): the floor point under the vertex lands along the
  // lamp's ray, in its tile, drawn with w = 1 / its stretch. A mesh past an edge of the tile is left out.
${VOLUME_ID_GLSL}
  vLampP = vec3(0.0);
  vTileUvW = vec3(-1.0, -1.0, 1.0);
  vLamp = vec4(0.0, 0.0, 1.0, 1.0);
  // E-389, E-453: one draw for every tile, an instance a tile. E-508: the instance's entry in its draw's list (the tiles'
  // texture's row 2, from uLampVolume.x): the tile whose lamp it lands towards, and the half tile it draws into.
  vec4 lampEntry = texelFetch(uLampTiles, ivec2(int(uLampVolume.x + 0.5) + gl_InstanceID, 2), 0);
  int lampTile = int(lampEntry.x + 0.5);
  vec4 lamp = texelFetch(uLampTiles, ivec2(lampTile, 0), 0);
  float lampOwner = texelFetch(uLampTiles, ivec2(lampTile, 1), 0).x;
  float lampZ = max(height, 0.0) * uSunShadow.w;
  // How far a vertex of the mesh can stand from the anchor on the floor: its reach (the same in each of its vertices, so a
  // triangle is kept or left out whole), turned (a pose's rotation, unit or not), the floor's f, y over groundScaleY.
  float lampPad = aInstReach * max(1.0, length(cs)) * max(1.0, f) * max(1.0, uLampVolume.w);
  vec2 lampOff = vec2(xy.x, xy.y * uLampVolume.w) - lamp.xy;
  bool lampOwn = abs(aInstBody - lampOwner) < 0.5;
  if (lampOwn || lamp.z <= 0.0 || lamp.w <= 0.0 || max(abs(lampOff.x), abs(lampOff.y)) > lamp.w + lampPad) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    return;
  }
  float lampRoom = lamp.z - lampZ;
  float lampW = lampRoom > lamp.z * ${MIN_W} ? lampRoom / lamp.z : ${MIN_W};
  vec2 lampLand = lamp.xy + (vec2(world.x, world.y * uLampVolume.w) - lamp.xy) / lampW;
  // DX-LAMPPANO: into the floor's half of the lamp's 2S x S tile, compressed out to the horizon (lampPanoUv); a volume
  // higher than its lamp stays on the floor's half (the ceiling's takes the cards and the columns).
  vec2 lampUv = lampPanoUv(lampLand - lamp.xy, lamp.w);
  vec2 lampPx = (lampEntry.yz + lampUv) * uLampVolume.z;
  vec3 lampClip = mvp * vec3(lampPx, 1.0);
  gl_Position = vec4(lampClip.xy * lampW, ${lampClipZGlsl('lampW')}, lampW);
  vTileUvW = vec3(lampUv * lampW, lampW);
  // N-276: the vertex's point in 3D (floor x, y; height) and its lamp (floor x, y; height; reach), for the fragment's ray.
  vLampP = vec3(world.x, world.y * uLampVolume.w, lampZ);
  vLamp = lamp;`;

/**
 * The lamps' map's vertex shader for the volumes (WebGL): meshUvFill.vert.glsl landing each vertex towards the lamp of
 * its tile, the instance (E-389, E-453: the batch's vertices drawn once a tile in use), the tile's lamp and owner read
 * from the tiles' texture (uLampVolume: the draw's list's first entry (E-508: lampVolumeCache.js), tiles a row, a tile's
 * texels, 1 / groundScaleY; uSunShadow: 0, 0, 1 for the volumes' floor, 1 / heightScaleY), its point in 3D and its lamp out (vLampP, vLamp: N-276) and the
 * tile's own coordinates for the fragment's clip.
 * @param {string} source meshUvFill.vert.glsl
 * @returns {string}
 */
export function volumeLampVertex(source) {
  const what = "the lamps' map's volumes";
  const decl =
    'out vec3 vLampP;\nout vec3 vTileUvW;\nflat out float vSunId;\nflat out vec4 vLamp;\n' +
    "// DX-SHADOW3D (F7): uLampVolume: the list's first entry, tiles a row, a tile's texels, 1 / groundScaleY; uLampTiles:\n" +
    "// the tiles' lamps (row 0), their owners (row 1: the entity whose own volume casts nothing for the lamp) and the\n" +
    "// draws' lists (row 2, E-508: an instance's tile and the half tile it draws into).\n" +
    'uniform vec4 uLampVolume;\nuniform sampler2D uLampTiles;\n' + LAMP_PANO_GLSL;
  const out = after(source, 'out vec2 vMeshUV;\n', decl, what);
  return after(out, POSITION_GLSL, LAMP_GLSL, what);
}

const INNER = LAMP_PANO_INNER.toFixed(2);
const OUTER = (1 - LAMP_PANO_INNER).toFixed(2);
const MIN_T = (1 / LAMP_MAP_MAX_STRETCH).toFixed(6);
const STRETCH = LAMP_MAP_MAX_STRETCH.toFixed(1);
const STRETCH_LESS = (LAMP_MAP_MAX_STRETCH - 1).toFixed(1);

// N-276: lampVolumeRayT in GLSL, its normal from the point's screen derivatives (q lies on its triangle wherever the
// triangle was drawn, so its steps across the screen lie in the face's plane).
const LAMP_VOLUME_T_GLSL = `
float lampVolumeT(vec3 q, vec3 dqx, vec3 dqy, vec2 tuv, vec4 lamp) {
  vec3 n = cross(dqx, dqy);
  vec2 d = tuv - 0.5;
  float c = 2.0 * length(d);
  float k = c <= ${INNER} ? c / ${INNER} : ${OUTER} / max(1.0 - c, 1e-4);
  vec3 dir = vec3(c > 1e-6 ? d * (2.0 * k * lamp.w / c) : vec2(0.0), -lamp.z);
  float den = dot(n, dir);
  if (abs(den) <= 1e-4 * length(n) * length(dir)) return (lamp.z - q.z) / lamp.z;
  return dot(n, q - lamp.xyz) / den;
}
`;

// The lamps' map volumes' fragment's body (WebGL): the texel's ray against the face (lampVolumeT), discarded past the tile
// or at or above the lamp (nothing for the floor's half), its depth written (N-276: no longer the vertices').
const VOLUME_LAMP_BODY_GLSL = `  vec3 dqx = dFdx(vLampP);
  vec3 dqy = dFdy(vLampP);
  vec2 tuv = vTileUvW.xy / vTileUvW.z;
  if (tuv.x < 0.0 || tuv.y < 0.0 || tuv.x >= 1.0 || tuv.y >= 1.0) discard;
  float t = lampVolumeT(vLampP, dqx, dqy, tuv, vLamp);
  if (t <= 0.0) discard;
  t = clamp(t, ${MIN_T}, 1.0);
  float depth = (${STRETCH} - 1.0 / t) / ${STRETCH_LESS};
  gl_FragDepth = depth;
  // N-211: the point's place along its lamp's ray (tests/reference/lightMapsJs.mjs lampRayDepth), not its height.
  float h = 1.0 / (1.0 + t);
  int id = int(vSunId + 0.5);
  finalColor = vec4(h, 1.0, float(id >> 8) / 255.0, float(id & 255) / 255.0);`;

/**
 * The volumes' fragment in the lamps' map (WebGL): the height and the volume's entity, cut to the draw's tile; the depth
 * that keeps the highest, from where the texel's own ray meets the face (N-276: lampVolumeRayT).
 */
export const VOLUME_LAMP_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vLampP;
in vec3 vTileUvW;
flat in float vSunId;
flat in vec4 vLamp;
out vec4 finalColor;
${LAMP_VOLUME_T_GLSL}
void main() {
${VOLUME_LAMP_BODY_GLSL}
}
`;

/**
 * E-508: VOLUME_LAMP_FRAGMENT for the lamps' volumes' cache (lampVolumeCache.js), a target of two colours: the texel, and
 * its depth's float as four bytes (the high first), which the copy writes back (LAMP_CACHE_COPY_FRAGMENT).
 */
export const VOLUME_LAMP_CACHE_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
in vec3 vLampP;
in vec3 vTileUvW;
flat in float vSunId;
flat in vec4 vLamp;
layout(location = 0) out vec4 finalColor;
layout(location = 1) out vec4 depthBits;
${LAMP_VOLUME_T_GLSL}
void main() {
${VOLUME_LAMP_BODY_GLSL}
  uint b = floatBitsToUint(depth);
  depthBits = vec4(float(b >> 24u), float((b >> 16u) & 255u), float((b >> 8u) & 255u), float(b & 255u)) / 255.0;
}
`;

// LAMP_GLSL in WGSL, after meshUvFill.wgsl's out.position (its xy, f, height, world and mvp in scope).
const LAMP_WGSL = `  // DX-SHADOW3D (F7): towards this vertex's lamp (volumeShadowMap.js): the floor point under the vertex lands along the
  // lamp's ray, in its tile, drawn with w = 1 / its stretch. A mesh past an edge of the tile is left out.
${VOLUME_ID_WGSL}  out.vTileUvW = vec3<f32>(-1.0, -1.0, 1.0);
  // E-389, E-453: one draw for every tile, an instance a tile. E-508: the instance's entry in its draw's list (LAMP_GLSL).
  let lampEntry = textureLoad(uLampTiles, vec2<i32>(i32(sunShadow.uLampVolume.x + 0.5) + i32(lampInstance), 2), 0);
  let lampTile = i32(lampEntry.x + 0.5);
  let lamp = textureLoad(uLampTiles, vec2<i32>(lampTile, 0), 0);
  let lampOwner = textureLoad(uLampTiles, vec2<i32>(lampTile, 1), 0).x;
  let lampZ = max(height, 0.0) * sunShadow.uSunShadow.w;
  let lampInvG = sunShadow.uLampVolume.w;
  // How far a vertex of the mesh can stand from the anchor on the floor (LAMP_GLSL says how).
  let lampPad = aInstReach * max(1.0, length(cs)) * max(1.0, f) * max(1.0, lampInvG);
  let lampOff = vec2<f32>(xy.x, xy.y * lampInvG) - lamp.xy;
  let lampOwn = abs(aInstBody - lampOwner) < 0.5;
  if (lampOwn || lamp.z <= 0.0 || lamp.w <= 0.0 || max(abs(lampOff.x), abs(lampOff.y)) > lamp.w + lampPad) {
    out.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
    return out;
  }
  let lampRoom = lamp.z - lampZ;
  let lampW = select(${MIN_W}, lampRoom / lamp.z, lampRoom > lamp.z * ${MIN_W});
  let lampLand = lamp.xy + (vec2<f32>(world.x, world.y * lampInvG) - lamp.xy) / lampW;
  // DX-LAMPPANO: into the floor's half of the lamp's tile, compressed (LAMP_GLSL says how).
  let lampUv = lampPanoUv(lampLand - lamp.xy, lamp.w);
  let lampPx = (lampEntry.yz + lampUv) * sunShadow.uLampVolume.z;
  let lampClip = mvp * vec3<f32>(lampPx, 1.0);
  out.position = vec4<f32>(lampClip.xy * lampW, ${lampClipZWgsl('lampW')}, lampW);
  out.vTileUvW = vec3<f32>(lampUv * lampW, lampW);
  // N-276: the vertex's point in 3D and its lamp, for the fragment's ray (LAMP_GLSL).
  out.vLampP = vec3<f32>(world.x, world.y * lampInvG, lampZ);
  out.vLamp = lamp;
`;

const LAMP_FRAGMENT_WGSL = `
${MAP_TEXEL_WGSL}
// N-276: lampVolumeRayT in WGSL (LAMP_VOLUME_T_GLSL), its normal from the point's screen derivatives.
fn lampVolumeT(q: vec3<f32>, dqx: vec3<f32>, dqy: vec3<f32>, tuv: vec2<f32>, lamp: vec4<f32>) -> f32 {
  let n = cross(dqx, dqy);
  let d = tuv - 0.5;
  let c = 2.0 * length(d);
  let k = select(${OUTER} / max(1.0 - c, 1e-4), c / ${INNER}, c <= ${INNER});
  var off = vec2<f32>(0.0);
  if (c > 1e-6) { off = d * (2.0 * k * lamp.w / c); }
  let dir = vec3<f32>(off, -lamp.z);
  let den = dot(n, dir);
  if (abs(den) <= 1e-4 * length(n) * length(dir)) { return (lamp.z - q.z) / lamp.z; }
  return dot(n, q - lamp.xyz) / den;
}

// A volume's texel in its lamp's tile (x: 1 / (1 + t)) and its depth (y), from where the texel's own ray meets the face
// (N-276); w < 0 for none (past the tile, or at or above the lamp).
fn lampVolumeTexel(in: VertexOut) -> vec4<f32> {
  let dqx = dpdx(in.vLampP);
  let dqy = dpdy(in.vLampP);
  let tuv = in.vTileUvW.xy / in.vTileUvW.z;
  if (tuv.x < 0.0 || tuv.y < 0.0 || tuv.x >= 1.0 || tuv.y >= 1.0) { return vec4<f32>(-1.0); }
  let t0 = lampVolumeT(in.vLampP, dqx, dqy, tuv, in.vLamp);
  if (t0 <= 0.0) { return vec4<f32>(-1.0); }
  let t = clamp(t0, ${MIN_T}, 1.0);
  return vec4<f32>(1.0 / (1.0 + t), (${STRETCH} - 1.0 / t) / ${STRETCH_LESS}, 0.0, 1.0);
}

struct LampVolumeOut {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}

// DX-SHADOW3D (F7): a volume's place where its lamp's ray lands, in that lamp's tile, the nearest the lamp kept by its
// depth with the volume's entity.
@fragment
fn mainFragLamp(in: VertexOut) -> LampVolumeOut {
  let texel = lampVolumeTexel(in);
  if (texel.w < 0.0) { discard; }
  var o: LampVolumeOut;
  // N-211: the point's place along its lamp's ray (lampRayDepth).
  o.color = weedMapTexel(${LAMP_MAP_ZMAX}.0 * texel.x, in.vSunId, 1.0);
  o.depth = texel.y;
  return o;
}

// E-508: mainFragLamp for the lamps' volumes' cache, a target of two colours: the texel, and its depth's float as four
// bytes, the high first (VOLUME_LAMP_CACHE_FRAGMENT's twin).
struct LampCacheOut {
  @location(0) color: vec4<f32>,
  @location(1) depthBits: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}

@fragment
fn mainFragLampCache(in: VertexOut) -> LampCacheOut {
  let texel = lampVolumeTexel(in);
  if (texel.w < 0.0) { discard; }
  var o: LampCacheOut;
  o.color = weedMapTexel(${LAMP_MAP_ZMAX}.0 * texel.x, in.vSunId, 1.0);
  o.depth = texel.y;
  let b = bitcast<u32>(texel.y);
  o.depthBits = vec4<f32>(f32(b >> 24u), f32((b >> 16u) & 255u), f32((b >> 8u) & 255u), f32(b & 255u)) / 255.0;
  return o;
}
`;

/**
 * volumeLampVertex's WGSL form (WebGPU): meshUvFill.wgsl with uLampVolume after uSunShadow in its group (the order Pixi
 * lays the group out in), the tile from the instance's entry in its draw's list (E-389, E-453, E-508), the tiles' texture as
 * group 2's binding 6, and the fragment entries `mainFragLamp` and `mainFragLampCache` (E-508: the cache's two colours).
 * @param {string} source meshUvFill.wgsl
 * @returns {string}
 */
export function volumeLampWgsl(source) {
  const what = "the lamps' map's volumes";
  let out = after(
    source,
    '  uSunShadow: vec4<f32>,\n',
    "  // DX-SHADOW3D (F7): the draw's list's first entry (E-508), tiles a row, a tile's texels, 1 / groundScaleY.\n" +
      '  uLampVolume: vec4<f32>,\n',
    what,
  );
  out = after(
    out,
    '@group(2) @binding(4) var<uniform> sunShadow: SunShadowUniforms;\n',
    "// DX-SHADOW3D (F7): the tiles' lamps: floor point, height and reach (row 0, lampShadowMap.js writeLampTile); row 1\n" +
      "// the owner, whose own volume casts nothing for the lamp (writeLampTileOwner); row 2 the draws' lists (E-508).\n" +
      '@group(2) @binding(6) var uLampTiles: texture_2d<f32>;\n' + LAMP_PANO_WGSL,
    what,
  );
  out = after(
    out,
    '  @location(7) vMeshUV: vec2<f32>,\n',
    '  @location(8) vLampP: vec3<f32>,\n  @location(9) vTileUvW: vec3<f32>,\n  @location(10) @interpolate(flat) vSunId: f32,\n  @location(11) @interpolate(flat) vLamp: vec4<f32>,\n',
    what,
  );
  // E-389, E-453: the instance's number (its entry in the draw's list, E-508), after the record's four vec4.
  out = after(out, '  @location(3) aVert3: vec4<f32>,\n', '  @builtin(instance_index) lampInstance: u32,\n', what);
  out = after(out, POSITION_WGSL, LAMP_WGSL, what);
  return out + LAMP_FRAGMENT_WGSL;
}

/**
 * A lamps' map volumes draw's terms, written when they differ: uSunShadow (no sun shift, the volumes' floor, 1 /
 * heightScaleY) and uLampVolume (the draw's list's first entry, tiles a row, a tile's texels, 1 / groundScaleY). The tiles'
 * lamps and owners, and the draws' lists, are the tiles' texture's (E-389: one draw for every tile; E-508: an instance an
 * entry of the list).
 * @param {Float32Array} sun
 * @param {Float32Array} lamp
 * @param {number} listStart the draw's list's first entry in the tiles' texture's row 2
 * @param {Float64Array} scales [1 / heightScaleY, 1 / groundScaleY]: in an array, since a double passed to a call
 *   TurboFan leaves out is boxed (a layer a frame, CLAUDE.md's E-85)
 * @returns {boolean} whether any changed (the group needs an update)
 */
export function writeVolumeLampTerms(sun, lamp, listStart, perRow, tileSize, scales) {
  const invHeightScaleY = scales[0];
  const invGroundScaleY = scales[1];
  if (
    sun[0] === 0 && sun[1] === 0 && sun[2] === 1 && sun[3] === Math.fround(invHeightScaleY)
    && lamp[0] === listStart && lamp[1] === perRow && lamp[2] === tileSize && lamp[3] === Math.fround(invGroundScaleY)
  ) {
    return false;
  }
  sun[0] = 0;
  sun[1] = 0;
  sun[2] = 1;
  sun[3] = invHeightScaleY;
  lamp[0] = listStart;
  lamp[1] = perRow;
  lamp[2] = tileSize;
  lamp[3] = invGroundScaleY;
  return true;
}

/**
 * The volumes' map programs on WebGPU (volumeMapWgsl, volumeLampWgsl): MeshUvFillBatch's bindings
 * (colliderFillGpuProgram's, with its sunShadow group) and, with `lampTiles`, the tiles' texture as binding 6.
 * @param {string} fragEntry 'mainFragMap' (the sun's map), 'mainFragLamp' (the lamps') or 'mainFragLampCache' (E-508: the
 *   lamps' volumes' cache, two colours)
 */
export function volumeMapGpuProgram(GpuProgram, source, fragEntry, name, { lampTiles = false } = {}) {
  if (!source) throw new Error("WeedJS: the volumes' mesh WGSL was not loaded before GpuProgram creation.");
  const vf = gpuStageVF();
  const f = gpuStageF();
  const group2 = { uTexture: 0, uSampler: 1, uTexLut: 2, uPoseTable: 3, sunShadow: 4 };
  if (lampTiles) group2.uLampTiles = 6;
  const data = { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false };
  return GpuProgram.from({
    name,
    vertex: { source, entryPoint: 'mainVert' },
    fragment: { source, entryPoint: fragEntry },
    layout: {
      0: { globalUniforms: 0 },
      1: { localUniforms: 0 },
      2: group2,
    },
    gpuLayout: [
      [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
      [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
      [
        { binding: 0, visibility: f, texture: { sampleType: 'float', viewDimension: '2d', multisampled: false } },
        { binding: 1, visibility: f, sampler: { type: 'filtering' } },
        { binding: 2, visibility: vf, texture: { ...data } },
        { binding: 3, visibility: vf, texture: { ...data } },
        { binding: 4, visibility: vf, buffer: { type: 'uniform' } },
        ...(lampTiles ? [{ binding: 6, visibility: vf, texture: { ...data } }] : []),
      ],
    ],
  });
}

/**
 * E-508: the copy of the lamps' volumes' cache into the lamps' map (lampVolumeCache.js), WebGL: an instance a cached lamp,
 * its entry in the tiles' texture's row 2 (from uLampVolume.x: the tile, and its cache slot's column and row in tiles); a
 * quad (aPosition 0..1) over the floor's half of the lamp's tile (uLampVolume.y tiles a row, uLampVolume.z a tile's
 * texels), reading the slot's texel for each of its texels (vSrc).
 */
export const LAMP_CACHE_COPY_VERTEX = `#version 300 es
precision highp float;
precision highp int;
in vec2 aPosition;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uLampVolume;
uniform sampler2D uLampTiles;
out vec2 vSrc;
void main() {
  vec4 e = texelFetch(uLampTiles, ivec2(int(uLampVolume.x + 0.5) + gl_InstanceID, 2), 0);
  int tile = int(e.x + 0.5);
  int perRow = max(int(uLampVolume.y + 0.5), 1);
  vec2 dst = (vec2(float(tile % perRow) * 2.0, float(tile / perRow)) + aPosition) * uLampVolume.z;
  vSrc = (e.yz + aPosition) * uLampVolume.z;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(dst, 1.0)).xy, 0.0, 1.0);
}
`;

/**
 * E-508: the copy's fragment (WebGL): the cached texel where a volume drew (its g, the opacity, 1), with the depth it was
 * drawn at (its float's four bytes), so the map's depth test keeps it or the card in front of it as drawing the volume
 * there would have; nothing elsewhere.
 */
export const LAMP_CACHE_COPY_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
in vec2 vSrc;
uniform sampler2D uCacheColor;
uniform sampler2D uCacheDepth;
out vec4 finalColor;
void main() {
  ivec2 p = ivec2(vSrc);
  vec4 c = texelFetch(uCacheColor, p, 0);
  if (c.g < 0.5) discard;
  uvec4 q = uvec4(texelFetch(uCacheDepth, p, 0) * 255.0 + 0.5);
  gl_FragDepth = uintBitsToFloat((q.x << 24u) | (q.y << 16u) | (q.z << 8u) | q.w);
  finalColor = c;
}
`;

/** E-508: the copy in WGSL (WebGPU), LAMP_CACHE_COPY_VERTEX's and LAMP_CACHE_COPY_FRAGMENT's twin. */
export const LAMP_CACHE_COPY_WGSL = `struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
}
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;

struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
}
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;

struct LampCopyUniforms {
  uLampVolume: vec4<f32>,
}
@group(2) @binding(0) var uLampTiles: texture_2d<f32>;
@group(2) @binding(1) var uCacheColor: texture_2d<f32>;
@group(2) @binding(2) var uCacheDepth: texture_2d<f32>;
@group(2) @binding(3) var<uniform> lampCopy: LampCopyUniforms;

struct CopyVertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vSrc: vec2<f32>,
}

@vertex
fn mainVert(@location(0) aPosition: vec2<f32>, @builtin(instance_index) instance: u32) -> CopyVertexOut {
  let v = lampCopy.uLampVolume;
  let e = textureLoad(uLampTiles, vec2<i32>(i32(v.x + 0.5) + i32(instance), 2), 0);
  let tile = i32(e.x + 0.5);
  let perRow = max(i32(v.y + 0.5), 1);
  let dst = (vec2<f32>(f32(tile % perRow) * 2.0, f32(tile / perRow)) + aPosition) * v.z;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  var out: CopyVertexOut;
  out.position = vec4<f32>((mvp * vec3<f32>(dst, 1.0)).xy, 0.0, 1.0);
  out.vSrc = (e.yz + aPosition) * v.z;
  return out;
}

struct CopyFragmentOut {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}

@fragment
fn mainFrag(in: CopyVertexOut) -> CopyFragmentOut {
  let p = vec2<i32>(in.vSrc);
  let c = textureLoad(uCacheColor, p, 0);
  if (c.g < 0.5) { discard; }
  let q = vec4<u32>(textureLoad(uCacheDepth, p, 0) * 255.0 + 0.5);
  var o: CopyFragmentOut;
  o.color = c;
  o.depth = bitcast<f32>((q.x << 24u) | (q.y << 16u) | (q.z << 8u) | q.w);
  return o;
}
`;

/**
 * E-508: the copy's program on WebGPU: the globals, the mesh's local uniforms, and group 2 the tiles' texture, the cache's
 * two colours and the copy's terms (lampCopy: uLampVolume).
 */
export function lampCacheCopyGpuProgram(GpuProgram, name) {
  const vf = gpuStageVF();
  const data = { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false };
  return GpuProgram.from({
    name,
    vertex: { source: LAMP_CACHE_COPY_WGSL, entryPoint: 'mainVert' },
    fragment: { source: LAMP_CACHE_COPY_WGSL, entryPoint: 'mainFrag' },
    layout: {
      0: { globalUniforms: 0 },
      1: { localUniforms: 0 },
      2: { uLampTiles: 0, uCacheColor: 1, uCacheDepth: 2, lampCopy: 3 },
    },
    gpuLayout: [
      [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
      [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
      [
        { binding: 0, visibility: vf, texture: { ...data } },
        { binding: 1, visibility: vf, texture: { ...data } },
        { binding: 2, visibility: vf, texture: { ...data } },
        { binding: 3, visibility: vf, buffer: { type: 'uniform' } },
      ],
    ],
  });
}
