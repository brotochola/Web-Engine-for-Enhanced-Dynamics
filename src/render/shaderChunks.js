/**
 * N-303 CR-15: shader text that the engine's programs share, written once. A file of src/shaders names a chunk on a
 * line of its own, `// #include <name>`, and withShaderChunks puts the chunk there when the renderer loads the file
 * (fetchEngineShader, from a fetch or from a bundle's embed alike). The programs the engine writes in JS take the
 * constants.
 */

/**
 * Pixi's mesh groups as every engine WGSL mesh program declares them: group 0, the renderer's globals; group 1, the
 * mesh's transform, colour and rounding (pixiGroupsLayout in webgpu/pixiMeshWgsl.js lays them out).
 */
export const PIXI_GROUPS_WGSL = `struct GlobalUniforms {
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
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;`;

/**
 * A sprite pixel's atlas UV (GLSL 300, from the varyings): its place in the frame, or a tiled place, world-anchored
 * where vTileInv is positive and local where it is negative.
 */
export const WEED_UV_GLSL = `vec2 weedUv() {
  vec2 t = vLocal;
  if (vTileInv.x > 0.0) t.x = fract(vWorld.x * vTileInv.x + vTileOff.x);
  else if (vTileInv.x < 0.0) t.x = fract(vLocal.x * (-vTileInv.x) + vTileOff.x);
  if (vTileInv.y > 0.0) t.y = fract(vWorld.y * vTileInv.y + vTileOff.y);
  else if (vTileInv.y < 0.0) t.y = fract(vLocal.y * (-vTileInv.y) + vTileOff.y);
  return mix(vAtlasUV.xy, vAtlasUV.zw, t);
}`;

/** WEED_UV_GLSL's WGSL twin, the varyings passed in. */
export const WEED_UV_WGSL = `fn weedUv(vLocal: vec2<f32>, vWorld: vec2<f32>, vAtlasUV: vec4<f32>, vTileInv: vec2<f32>, vTileOff: vec2<f32>) -> vec2<f32> {
  var t = vLocal;
  if (vTileInv.x > 0.0) { t.x = fract(vWorld.x * vTileInv.x + vTileOff.x); }
  else if (vTileInv.x < 0.0) { t.x = fract(vLocal.x * (-vTileInv.x) + vTileOff.x); }
  if (vTileInv.y > 0.0) { t.y = fract(vWorld.y * vTileInv.y + vTileOff.y); }
  else if (vTileInv.y < 0.0) { t.y = fract(vLocal.y * (-vTileInv.y) + vTileOff.y); }
  return mix(vAtlasUV.xy, vAtlasUV.zw, t);
}`;

/** The chunks a shader file can include, by the name its include line gives. */
const SHADER_CHUNKS = { 'pixiGroups.wgsl': PIXI_GROUPS_WGSL, 'weedUv.glsl': WEED_UV_GLSL, 'weedUv.wgsl': WEED_UV_WGSL };

const INCLUDE_LINE = /^\/\/ #include ([\w.]+)$/gm;

/**
 * `source` (LF) with each `// #include <name>` line replaced by that chunk; a name that is not a chunk throws.
 * @param {string} source
 * @returns {string}
 */
export function withShaderChunks(source) {
  if (source.indexOf('// #include ') < 0) return source;
  return source.replace(INCLUDE_LINE, (line, name) => {
    const chunk = SHADER_CHUNKS[name];
    if (chunk === undefined) {
      throw new Error(`WeedJS: a shader includes "${name}", which is not an engine chunk (${Object.keys(SHADER_CHUNKS).join(', ')})`);
    }
    return chunk;
  });
}
