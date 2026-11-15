/**
 * DX-SHADOW3D (F6, F7): VolumeShadowCaster's volumes in the shadow maps. Their batch (MeshUvFillBatch: meshUvFill.vert.glsl
 * and meshUvFill.wgsl) already moves each vertex by its height (the U column, screen px) times uSunShadow.xy; drawn again
 * with these programs, max blending, it writes the heights its vertices carry:
 * - into the sun's map (WebGL: sunShadowMap.js volumeMapVertex and VOLUME_MAP_FRAGMENT; WebGPU: volumeMapWgsl), each
 *   vertex landing by the map's shift, its height in the map's units (uSunShadow.w: 1 / heightScaleY);
 * - into the lamps' map (lampShadowMap.js), once a tile in use (volumeLampVertex / volumeLampWgsl): uSunShadow.xy 0, so the
 *   vertex stays on its floor point P = (x, screen y / groundScaleY), which lands along the tile's lamp's ray at
 *   L + (P - L) · E / (E - z) (the stretch capped at LAMP_MAP_MAX_STRETCH), in the tile, drawn with w = (E - z) / E so the
 *   heights spread over the shadow as the rays carry them, cut to the tile by the fragment. The tile's lamp is the tiles'
 *   texture's (writeLampTile: its floor point, height and reach), read by uLampVolume.x. A triangle whose floor footprint
 *   lies past one edge of the tile is left out in its vertices: its landing lies further past it.
 */

import { SUN_MAP_ZMAX } from './sunShadowMap.js';
import { LAMP_MAP_MAX_STRETCH, LAMP_MAP_ZMAX } from './lampShadowMap.js';
import { gpuStageF, gpuStageVF } from './webgpu/pixiMeshWgsl.js';

/** The source with `add` after its one `find`, or a clear error. */
function after(source, find, add, what) {
  if (typeof source !== 'string' || source.split(find).length !== 2) {
    throw new Error(`WeedJS: ${what} needs the volumes' mesh shader (${find.trim()})`);
  }
  return source.replace(find, () => find + add);
}

/** The smallest w (1 / the stretch) a vertex under a lamp is drawn with. */
const MIN_W = (1 / LAMP_MAP_MAX_STRETCH).toFixed(6);

const SUN_FRAGMENT_WGSL = `
// DX-SHADOW3D (F6): a volume's height where its sun ray lands, max blending (sunShadowMap.js VOLUME_MAP_FRAGMENT).
@fragment
fn mainFragMap(in: VertexOut) -> @location(0) vec4<f32> {
  return vec4<f32>(clamp(in.vSunZ / ${SUN_MAP_ZMAX}.0, 0.0, 1.0), 0.0, 0.0, 1.0);
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
  let out = after(source, '  @location(7) vMeshUV: vec2<f32>,\n', '  @location(8) vSunZ: f32,\n', what);
  out = after(out, '  out.position = vec4<f32>(clip.xy, aInstDepth, 1.0);\n', '  out.vSunZ = height * sunShadow.uSunShadow.w;\n', what);
  return out + SUN_FRAGMENT_WGSL;
}

// The lamp's landing in GLSL, after meshUvFill.vert.glsl's gl_Position (its xy, f, world and mvp in scope).
const LAMP_GLSL = `
  // DX-SHADOW3D (F7): towards this draw's lamp (volumeShadowMap.js): the floor point under the vertex lands along the
  // lamp's ray, in its tile, drawn with w = 1 / its stretch. A triangle past an edge of the tile is left out.
  vSunZ = 0.0;
  vTileUvW = vec3(-1.0, -1.0, 1.0);
  int lampTile = int(uLampVolume.x + 0.5);
  vec4 lamp = texelFetch(uLampTiles, ivec2(max(lampTile, 0), 0), 0);
  float lampZ = max(aUV0.x + aTri.x * (aUV1.x - aUV0.x) + aTri.y * (aUV2.x - aUV0.x), 0.0) * uSunShadow.w;
  float lampPad = max(max(length(aV0), length(aV1)), length(aV2)) * max(1.0, f) * max(1.0, uLampVolume.w);
  vec2 lampOff = vec2(xy.x, xy.y * uLampVolume.w) - lamp.xy;
  if (lampTile < 0 || lamp.z <= 0.0 || lamp.w <= 0.0 || max(abs(lampOff.x), abs(lampOff.y)) > lamp.w + lampPad) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    return;
  }
  float lampRoom = lamp.z - lampZ;
  float lampW = lampRoom > lamp.z * ${MIN_W} ? lampRoom / lamp.z : ${MIN_W};
  vec2 lampLand = lamp.xy + (vec2(world.x, world.y * uLampVolume.w) - lamp.xy) / lampW;
  vec2 lampUv = (lampLand - lamp.xy) / (2.0 * lamp.w) + 0.5;
  int lampPerRow = max(int(uLampVolume.y + 0.5), 1);
  vec2 lampPx = (vec2(float(lampTile % lampPerRow), float(lampTile / lampPerRow)) + lampUv) * uLampVolume.z;
  vec3 lampClip = mvp * vec3(lampPx, 1.0);
  gl_Position = vec4(lampClip.xy * lampW, 0.0, lampW);
  vTileUvW = vec3(lampUv * lampW, lampW);
  vSunZ = lampZ;`;

/**
 * The lamps' map's vertex shader for the volumes (WebGL): meshUvFill.vert.glsl landing each vertex towards the lamp of
 * tile uLampVolume.x (uLampVolume: the tile, tiles a row, a tile's texels, 1 / groundScaleY; uSunShadow: 0, 0, 1 for the
 * volumes' floor, 1 / heightScaleY), its height out (vSunZ) and the tile's own coordinates for the fragment's clip.
 * @param {string} source meshUvFill.vert.glsl
 * @returns {string}
 */
export function volumeLampVertex(source) {
  const what = "the lamps' map's volumes";
  const decl =
    'out float vSunZ;\nout vec3 vTileUvW;\n' +
    "// DX-SHADOW3D (F7): this draw's tile, tiles a row, a tile's texels, 1 / groundScaleY; the tiles' lamps.\n" +
    'uniform vec4 uLampVolume;\nuniform sampler2D uLampTiles;\n';
  const out = after(source, 'out vec2 vMeshUV;\n', decl, what);
  return after(out, 'gl_Position = vec4(clip.xy, aInstDepth, 1.0);', LAMP_GLSL, what);
}

/** The volumes' fragment in the lamps' map (WebGL): the height, max blending, cut to the draw's tile. */
export const VOLUME_LAMP_FRAGMENT = `#version 300 es
precision highp float;
in float vSunZ;
in vec3 vTileUvW;
out vec4 finalColor;
void main() {
  vec2 tuv = vTileUvW.xy / vTileUvW.z;
  if (tuv.x < 0.0 || tuv.y < 0.0 || tuv.x >= 1.0 || tuv.y >= 1.0) discard;
  finalColor = vec4(clamp(vSunZ / ${LAMP_MAP_ZMAX}.0, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

// LAMP_GLSL in WGSL, after meshUvFill.wgsl's out.position (its xy, f, height, world and mvp in scope).
const LAMP_WGSL = `  // DX-SHADOW3D (F7): towards this draw's lamp (volumeShadowMap.js): the floor point under the vertex lands along the
  // lamp's ray, in its tile, drawn with w = 1 / its stretch. A triangle past an edge of the tile is left out.
  out.vTileUvW = vec3<f32>(-1.0, -1.0, 1.0);
  let lampTile = i32(sunShadow.uLampVolume.x + 0.5);
  let lamp = textureLoad(uLampTiles, vec2<i32>(max(lampTile, 0), 0), 0);
  let lampZ = max(height, 0.0) * sunShadow.uSunShadow.w;
  let lampInvG = sunShadow.uLampVolume.w;
  let lampPad = max(max(length(aV0), length(aV1)), length(aV2)) * max(1.0, f) * max(1.0, lampInvG);
  let lampOff = vec2<f32>(xy.x, xy.y * lampInvG) - lamp.xy;
  if (lampTile < 0 || lamp.z <= 0.0 || lamp.w <= 0.0 || max(abs(lampOff.x), abs(lampOff.y)) > lamp.w + lampPad) {
    out.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
    return out;
  }
  let lampRoom = lamp.z - lampZ;
  let lampW = select(${MIN_W}, lampRoom / lamp.z, lampRoom > lamp.z * ${MIN_W});
  let lampLand = lamp.xy + (vec2<f32>(world.x, world.y * lampInvG) - lamp.xy) / lampW;
  let lampUv = (lampLand - lamp.xy) / (2.0 * lamp.w) + 0.5;
  let lampPerRow = max(i32(sunShadow.uLampVolume.y + 0.5), 1);
  let lampPx = (vec2<f32>(f32(lampTile % lampPerRow), f32(lampTile / lampPerRow)) + lampUv) * sunShadow.uLampVolume.z;
  let lampClip = mvp * vec3<f32>(lampPx, 1.0);
  out.position = vec4<f32>(lampClip.xy * lampW, 0.0, lampW);
  out.vTileUvW = vec3<f32>(lampUv * lampW, lampW);
  out.vSunZ = lampZ;
`;

const LAMP_FRAGMENT_WGSL = `
// DX-SHADOW3D (F7): a volume's height where its lamp's ray lands, in that lamp's tile, max blending.
@fragment
fn mainFragLamp(in: VertexOut) -> @location(0) vec4<f32> {
  let tuv = in.vTileUvW.xy / in.vTileUvW.z;
  if (tuv.x < 0.0 || tuv.y < 0.0 || tuv.x >= 1.0 || tuv.y >= 1.0) { discard; }
  return vec4<f32>(clamp(in.vSunZ / ${LAMP_MAP_ZMAX}.0, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

/**
 * volumeLampVertex's WGSL form (WebGPU): meshUvFill.wgsl with uLampVolume after uSunShadow in its group (the order Pixi
 * lays the group out in), the tiles' texture as group 2's binding 6, and the fragment entry `mainFragLamp`.
 * @param {string} source meshUvFill.wgsl
 * @returns {string}
 */
export function volumeLampWgsl(source) {
  const what = "the lamps' map's volumes";
  let out = after(
    source,
    '  uSunShadow: vec4<f32>,\n',
    "  // DX-SHADOW3D (F7): this draw's tile, tiles a row, a tile's texels, 1 / groundScaleY.\n  uLampVolume: vec4<f32>,\n",
    what,
  );
  out = after(
    out,
    '@group(2) @binding(4) var<uniform> sunShadow: SunShadowUniforms;\n',
    "// DX-SHADOW3D (F7): the tiles' lamps: floor point, height and reach (lampShadowMap.js writeLampTile).\n" +
      '@group(2) @binding(6) var uLampTiles: texture_2d<f32>;\n',
    what,
  );
  out = after(out, '  @location(7) vMeshUV: vec2<f32>,\n', '  @location(8) vSunZ: f32,\n  @location(9) vTileUvW: vec3<f32>,\n', what);
  out = after(out, '  out.position = vec4<f32>(clip.xy, aInstDepth, 1.0);\n', LAMP_WGSL, what);
  return out + LAMP_FRAGMENT_WGSL;
}

/**
 * A lamps' map volumes draw's terms, written when they differ: uSunShadow (no sun shift, the volumes' floor, 1 /
 * heightScaleY) and uLampVolume (the tile, tiles a row, a tile's texels, 1 / groundScaleY).
 * @param {Float32Array} sun
 * @param {Float32Array} lamp
 * @returns {boolean} whether any changed (the group needs an update)
 */
export function writeVolumeLampTerms(sun, lamp, tile, perRow, tileSize, invHeightScaleY, invGroundScaleY) {
  if (
    sun[0] === 0 && sun[1] === 0 && sun[2] === 1 && sun[3] === Math.fround(invHeightScaleY)
    && lamp[0] === tile && lamp[1] === perRow && lamp[2] === tileSize && lamp[3] === Math.fround(invGroundScaleY)
  ) {
    return false;
  }
  sun[0] = 0;
  sun[1] = 0;
  sun[2] = 1;
  sun[3] = invHeightScaleY;
  lamp[0] = tile;
  lamp[1] = perRow;
  lamp[2] = tileSize;
  lamp[3] = invGroundScaleY;
  return true;
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
