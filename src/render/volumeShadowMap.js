/**
 * DX-SHADOW3D (F6, F7): VolumeShadowCaster's volumes in the shadow maps. Their batch (MeshUvFillBatch: meshUvFill.vert.glsl
 * and meshUvFill.wgsl) already moves each vertex by its height (the U column, screen px) times uSunShadow.xy; drawn again
 * with these programs, max blending, it writes the heights its vertices carry:
 * - into the sun's map (WebGL: sunShadowMap.js volumeMapVertex and VOLUME_MAP_FRAGMENT; WebGPU: volumeMapWgsl), each
 *   vertex landing by the map's shift, its height in the map's units (uSunShadow.w: 1 / heightScaleY);
 * - into the lamps' map (lampShadowMap.js), each row's triangle once a tile in use, in one draw (volumeLampVertex /
 *   volumeLampWgsl; E-389: three vertices a tile, vertex v (aLampVertex) corner v % 3 of tile v / 3): uSunShadow.xy 0, so
 *   the vertex stays on its floor point P = (x, screen y / groundScaleY), which lands along the tile's lamp's ray at
 *   L + (P - L) · E / (E - z) (DX-LAMPPANO: compressed into the floor's half of the tile out to the horizon, the stretch
 *   drawn at most LAMP_MAP_MAX_STRETCH), in the tile, drawn with w = (E - z) / E so the
 *   heights spread over the shadow as the rays carry them, cut to the tile by the fragment. The tile's lamp is the tiles'
 *   texture's row 0 (writeLampTile: its floor point, height and reach). A triangle whose floor footprint lies past one
 *   edge of the tile is left out in its vertices: its landing lies further past it. So is one of the lamp's own entity
 *   (the tiles' texture's row 1, writeLampTileOwner; the rows' aInstBody is their entity), as pre-render drops a lamp's
 *   own stamp rows: a car's headlights are not shaded by the car's volume.
 */

import { MAP_TEXEL_WGSL, SUN_MAP_ZMAX } from './sunShadowMap.js';
import { LAMP_MAP_MAX_STRETCH, LAMP_MAP_ZMAX, LAMP_PANO_GLSL, LAMP_PANO_WGSL, lampClipZGlsl, lampClipZWgsl } from './lampShadowMap.js';
import { gpuStageF, gpuStageVF } from './webgpu/pixiMeshWgsl.js';

/** The source with `add` after its one `find`, or a clear error. */
function after(source, find, add, what) {
  if (typeof source !== 'string' || source.split(find).length !== 2) {
    throw new Error(`WeedJS: ${what} needs the volumes' mesh shader (${find.trim()})`);
  }
  return source.replace(find, () => find + add);
}

/** The source with its one `find` replaced by `put`, or a clear error. */
function swap(source, find, put, what) {
  if (typeof source !== 'string' || source.split(find).length !== 2) {
    throw new Error(`WeedJS: ${what} needs the volumes' mesh shader (${find.trim()})`);
  }
  return source.replace(find, () => put);
}

// E-389: meshUvFill takes an instance's corner from the vertex index (E-419: 0, 1, 2 in each instance of 3 vertices). The
// lamps' map draws three vertices a tile in use, numbered by an attribute (aLampVertex: a geometry whose only vertex
// attribute the program does not read makes Pixi warn, a geometry a count of tiles), so the corner is that number mod 3
// and the tile that number over 3.
const CORNER_GLSL = 'vec2 aTri = vec2(gl_VertexID == 1 ? 1.0 : 0.0, gl_VertexID == 2 ? 1.0 : 0.0);';
const LAMP_CORNER_GLSL =
  'int lampVertex = int(aLampVertex + 0.5);\n  int lampCorner = lampVertex % 3;\n  vec2 aTri = vec2(lampCorner == 1 ? 1.0 : 0.0, lampCorner == 2 ? 1.0 : 0.0);';
const CORNER_WGSL = 'let aTri = vec2<f32>(select(0.0, 1.0, vertexIndex == 1u), select(0.0, 1.0, vertexIndex == 2u));';
const LAMP_CORNER_WGSL =
  'let lampVertex = u32(aLampVertex + 0.5);\n  let lampCorner = lampVertex % 3u;\n  let aTri = vec2<f32>(select(0.0, 1.0, lampCorner == 1u), select(0.0, 1.0, lampCorner == 2u));';

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
    '  out.position = vec4<f32>(clip.xy, aInstDepth, 1.0);\n',
    `  out.vSunZ = height * sunShadow.uSunShadow.w;\n  out.position.z = 1.0 - clamp(out.vSunZ / ${SUN_MAP_ZMAX}.0, 0.0, 1.0);\n${VOLUME_ID_WGSL}`,
    what,
  );
  return out + SUN_FRAGMENT_WGSL;
}

// DX-GBUF: a volume's entity is its row's body (the pose table's index), as the G-buffer's id (gbufWord.js).
const VOLUME_ID_GLSL = '  vSunId = float(int(aInstBody + 0.5) % 65535 + 1);';
const VOLUME_ID_WGSL = '  out.vSunId = f32(u32(aInstBody + 0.5) % 65535u + 1u);\n';

// The lamp's landing in GLSL, after meshUvFill.vert.glsl's gl_Position (its xy, f, world and mvp in scope).
const LAMP_GLSL = `
  // DX-SHADOW3D (F7): towards this vertex's lamp (volumeShadowMap.js): the floor point under the vertex lands along the
  // lamp's ray, in its tile, drawn with w = 1 / its stretch. A triangle past an edge of the tile is left out.
${VOLUME_ID_GLSL}
  vSunZ = 0.0;
  vTileUvW = vec3(-1.0, -1.0, 1.0);
  vLampE = 1.0;
  // E-389: one draw for every tile, three vertices a tile (LAMP_CORNER_GLSL).
  int lampTile = lampVertex / 3;
  vec4 lamp = texelFetch(uLampTiles, ivec2(lampTile, 0), 0);
  float lampOwner = texelFetch(uLampTiles, ivec2(lampTile, 1), 0).x;
  float lampZ = max(aUV0.x + aTri.x * (aUV1.x - aUV0.x) + aTri.y * (aUV2.x - aUV0.x), 0.0) * uSunShadow.w;
  // How far a corner can stand from the anchor on the floor: turned (a pose's rotation, unit or not), the floor's f, y
  // over groundScaleY.
  float lampPad = max(max(length(aV0), length(aV1)), length(aV2)) * max(1.0, length(cs)) * max(1.0, f) * max(1.0, uLampVolume.w);
  vec2 lampOff = vec2(xy.x, xy.y * uLampVolume.w) - lamp.xy;
  bool lampOwn = abs(aInstBody - lampOwner) < 0.5;
  if (lampTile >= int(uLampVolume.x + 0.5) || lampOwn || lamp.z <= 0.0 || lamp.w <= 0.0 || max(abs(lampOff.x), abs(lampOff.y)) > lamp.w + lampPad) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    return;
  }
  float lampRoom = lamp.z - lampZ;
  float lampW = lampRoom > lamp.z * ${MIN_W} ? lampRoom / lamp.z : ${MIN_W};
  vec2 lampLand = lamp.xy + (vec2(world.x, world.y * uLampVolume.w) - lamp.xy) / lampW;
  // DX-LAMPPANO: into the floor's half of the lamp's 2S x S tile, compressed out to the horizon (lampPanoUv); a volume
  // higher than its lamp stays on the floor's half (the ceiling's takes the cards and the columns).
  vec2 lampUv = lampPanoUv(lampLand - lamp.xy, lamp.w);
  int lampPerRow = max(int(uLampVolume.y + 0.5), 1);
  vec2 lampPx = (vec2(float(lampTile % lampPerRow) * 2.0, float(lampTile / lampPerRow)) + lampUv) * uLampVolume.z;
  vec3 lampClip = mvp * vec3(lampPx, 1.0);
  gl_Position = vec4(lampClip.xy * lampW, ${lampClipZGlsl('lampW')}, lampW);
  vTileUvW = vec3(lampUv * lampW, lampW);
  vSunZ = lampZ;
  vLampE = lamp.z;`;

/**
 * The lamps' map's vertex shader for the volumes (WebGL): meshUvFill.vert.glsl landing each vertex towards the lamp of
 * its tile, aLampVertex / 3 (E-389: drawn with three vertices a tile in use, numbered by aLampVertex, the corner its
 * number % 3), the tile's lamp and owner read from the tiles' texture (uLampVolume: the tiles in use, tiles a row, a tile's texels, 1 /
 * groundScaleY; uSunShadow: 0, 0, 1 for the volumes' floor, 1 / heightScaleY), its height out (vSunZ) and the tile's own
 * coordinates for the fragment's clip.
 * @param {string} source meshUvFill.vert.glsl
 * @returns {string}
 */
export function volumeLampVertex(source) {
  const what = "the lamps' map's volumes";
  const decl =
    'out float vSunZ;\nout vec3 vTileUvW;\nflat out float vSunId;\nflat out float vLampE;\n' +
    "// E-389: this vertex's number in the draw: tile number / 3, corner number % 3 (volumeLampVertexCount).\n" +
    'in float aLampVertex;\n' +
    "// DX-SHADOW3D (F7): uLampVolume: the tiles in use, tiles a row, a tile's texels, 1 / groundScaleY; uLampTiles: the\n" +
    "// tiles' lamps (row 0) and their owners (row 1: the entity whose own volume casts nothing for the lamp).\n" +
    'uniform vec4 uLampVolume;\nuniform sampler2D uLampTiles;\n' + LAMP_PANO_GLSL;
  let out = after(source, 'out vec2 vMeshUV;\n', decl, what);
  out = swap(out, CORNER_GLSL, LAMP_CORNER_GLSL, what);
  return after(out, 'gl_Position = vec4(clip.xy, aInstDepth, 1.0);', LAMP_GLSL, what);
}

/**
 * The volumes' fragment in the lamps' map (WebGL): the height and the volume's entity, cut to the draw's tile; the depth
 * that keeps the highest comes from the vertex (lampClipZGlsl).
 */
export const VOLUME_LAMP_FRAGMENT = `#version 300 es
precision highp float;
in float vSunZ;
in vec3 vTileUvW;
flat in float vSunId;
flat in float vLampE;
out vec4 finalColor;
void main() {
  vec2 tuv = vTileUvW.xy / vTileUvW.z;
  if (tuv.x < 0.0 || tuv.y < 0.0 || tuv.x >= 1.0 || tuv.y >= 1.0) discard;
  // N-211: the point's place along its lamp's ray (lampShadowMap.js lampRayDepth), not its height.
  float h = clamp(1.0 / (1.0 + abs(vLampE - vSunZ) / max(vLampE, 1e-3)), 0.0, 1.0);
  int id = int(vSunId + 0.5);
  finalColor = vec4(h, 1.0, float(id >> 8) / 255.0, float(id & 255) / 255.0);
}
`;

// LAMP_GLSL in WGSL, after meshUvFill.wgsl's out.position (its xy, f, height, world and mvp in scope).
const LAMP_WGSL = `  // DX-SHADOW3D (F7): towards this vertex's lamp (volumeShadowMap.js): the floor point under the vertex lands along the
  // lamp's ray, in its tile, drawn with w = 1 / its stretch. A triangle past an edge of the tile is left out.
${VOLUME_ID_WGSL}  out.vTileUvW = vec3<f32>(-1.0, -1.0, 1.0);
  // E-389: one draw for every tile, three vertices a tile (LAMP_CORNER_WGSL).
  let lampTile = i32(lampVertex / 3u);
  let lamp = textureLoad(uLampTiles, vec2<i32>(lampTile, 0), 0);
  let lampOwner = textureLoad(uLampTiles, vec2<i32>(lampTile, 1), 0).x;
  let lampZ = max(height, 0.0) * sunShadow.uSunShadow.w;
  let lampInvG = sunShadow.uLampVolume.w;
  // How far a corner can stand from the anchor on the floor (LAMP_GLSL says how).
  let lampPad = max(max(length(aV0), length(aV1)), length(aV2)) * max(1.0, length(cs)) * max(1.0, f) * max(1.0, lampInvG);
  let lampOff = vec2<f32>(xy.x, xy.y * lampInvG) - lamp.xy;
  let lampOwn = abs(aInstBody - lampOwner) < 0.5;
  if (lampTile >= i32(sunShadow.uLampVolume.x + 0.5) || lampOwn || lamp.z <= 0.0 || lamp.w <= 0.0 || max(abs(lampOff.x), abs(lampOff.y)) > lamp.w + lampPad) {
    out.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
    return out;
  }
  let lampRoom = lamp.z - lampZ;
  let lampW = select(${MIN_W}, lampRoom / lamp.z, lampRoom > lamp.z * ${MIN_W});
  let lampLand = lamp.xy + (vec2<f32>(world.x, world.y * lampInvG) - lamp.xy) / lampW;
  // DX-LAMPPANO: into the floor's half of the lamp's tile, compressed (LAMP_GLSL says how).
  let lampUv = lampPanoUv(lampLand - lamp.xy, lamp.w);
  let lampPerRow = max(i32(sunShadow.uLampVolume.y + 0.5), 1);
  let lampPx = (vec2<f32>(f32(lampTile % lampPerRow) * 2.0, f32(lampTile / lampPerRow)) + lampUv) * sunShadow.uLampVolume.z;
  let lampClip = mvp * vec3<f32>(lampPx, 1.0);
  out.position = vec4<f32>(lampClip.xy * lampW, ${lampClipZWgsl('lampW')}, lampW);
  out.vTileUvW = vec3<f32>(lampUv * lampW, lampW);
  out.vSunZ = lampZ;
  out.vLampE = lamp.z;
`;

const LAMP_FRAGMENT_WGSL = `
${MAP_TEXEL_WGSL}
// DX-SHADOW3D (F7): a volume's height where its lamp's ray lands, in that lamp's tile, the highest kept by its depth
// (which its vertices write: lampClipZWgsl) with the volume's entity.
@fragment
fn mainFragLamp(in: VertexOut) -> @location(0) vec4<f32> {
  let tuv = in.vTileUvW.xy / in.vTileUvW.z;
  if (tuv.x < 0.0 || tuv.y < 0.0 || tuv.x >= 1.0 || tuv.y >= 1.0) { discard; }
  // N-211: the point's place along its lamp's ray (lampRayDepth).
  return weedMapTexel(${LAMP_MAP_ZMAX}.0 / (1.0 + abs(in.vLampE - in.vSunZ) / max(in.vLampE, 1e-3)), in.vSunId, 1.0);
}
`;

/**
 * volumeLampVertex's WGSL form (WebGPU): meshUvFill.wgsl with uLampVolume after uSunShadow in its group (the order Pixi
 * lays the group out in), the corner and the tile from the vertex index (E-389), the tiles' texture as group 2's binding
 * 6, and the fragment entry `mainFragLamp`.
 * @param {string} source meshUvFill.wgsl
 * @returns {string}
 */
export function volumeLampWgsl(source) {
  const what = "the lamps' map's volumes";
  let out = after(
    source,
    '  uSunShadow: vec4<f32>,\n',
    "  // DX-SHADOW3D (F7): the tiles in use, tiles a row, a tile's texels, 1 / groundScaleY.\n" +
      '  uLampVolume: vec4<f32>,\n',
    what,
  );
  out = after(
    out,
    '@group(2) @binding(4) var<uniform> sunShadow: SunShadowUniforms;\n',
    "// DX-SHADOW3D (F7): the tiles' lamps: floor point, height and reach (row 0, lampShadowMap.js writeLampTile); row 1\n" +
      "// the owner, whose own volume casts nothing for the lamp (writeLampTileOwner).\n" +
      '@group(2) @binding(6) var uLampTiles: texture_2d<f32>;\n' + LAMP_PANO_WGSL,
    what,
  );
  out = after(
    out,
    '  @location(7) vMeshUV: vec2<f32>,\n',
    '  @location(8) vSunZ: f32,\n  @location(9) vTileUvW: vec3<f32>,\n  @location(10) @interpolate(flat) vSunId: f32,\n  @location(11) @interpolate(flat) vLampE: f32,\n',
    what,
  );
  // E-389: the vertex's number in the draw (LAMP_CORNER_WGSL), after the rows' six vec4.
  out = after(out, '  @location(5) aRow5: vec4<f32>,\n', '  @location(6) aLampVertex: f32,\n', what);
  out = swap(out, CORNER_WGSL, LAMP_CORNER_WGSL, what);
  out = after(out, '  out.position = vec4<f32>(clip.xy, aInstDepth, 1.0);\n', LAMP_WGSL, what);
  return out + LAMP_FRAGMENT_WGSL;
}

/**
 * A lamps' map volumes draw's terms, written when they differ: uSunShadow (no sun shift, the volumes' floor, 1 /
 * heightScaleY) and uLampVolume (the tiles in use, tiles a row, a tile's texels, 1 / groundScaleY). The tiles' lamps and
 * owners are the tiles' texture's (E-389: one draw for every tile).
 * @param {Float32Array} sun
 * @param {Float32Array} lamp
 * @param {Float64Array} scales [1 / heightScaleY, 1 / groundScaleY]: in an array, since a double passed to a call
 *   TurboFan leaves out is boxed (a layer a frame, CLAUDE.md's E-85)
 * @returns {boolean} whether any changed (the group needs an update)
 */
export function writeVolumeLampTerms(sun, lamp, tiles, perRow, tileSize, scales) {
  const invHeightScaleY = scales[0];
  const invGroundScaleY = scales[1];
  if (
    sun[0] === 0 && sun[1] === 0 && sun[2] === 1 && sun[3] === Math.fround(invHeightScaleY)
    && lamp[0] === tiles && lamp[1] === perRow && lamp[2] === tileSize && lamp[3] === Math.fround(invGroundScaleY)
  ) {
    return false;
  }
  sun[0] = 0;
  sun[1] = 0;
  sun[2] = 1;
  sun[3] = invHeightScaleY;
  lamp[0] = tiles;
  lamp[1] = perRow;
  lamp[2] = tileSize;
  lamp[3] = invGroundScaleY;
  return true;
}

/**
 * E-389: the vertices the lamps' map volumes' one draw runs an instance (a row) for `tiles` tiles in use: three a tile,
 * vertex v corner v % 3 of tile v / 3 (volumeLampVertex).
 * @param {number} tiles
 * @returns {number}
 */
export function volumeLampVertexCount(tiles) {
  return Math.max(1, tiles | 0) * 3;
}

/**
 * E-389: the lamps' map volumes' vertex numbers for `tiles` tiles (aLampVertex: 0, 1, 2, ... a vertex).
 * @param {number} tiles
 * @returns {Float32Array}
 */
export function volumeLampVertices(tiles) {
  const out = new Float32Array(volumeLampVertexCount(tiles));
  for (let v = 0; v < out.length; v++) out[v] = v;
  return out;
}

/**
 * The volumes' map programs on WebGPU (volumeMapWgsl, volumeLampWgsl): MeshUvFillBatch's bindings
 * (colliderFillGpuProgram's, with its sunShadow group) and, with `lampTiles`, the tiles' texture as binding 6.
 * @param {string} fragEntry 'mainFragMap' (the sun's map) or 'mainFragLamp' (the lamps')
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
