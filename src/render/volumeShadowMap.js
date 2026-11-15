/**
 * DX-SHADOW3D (F6): VolumeShadowCaster's volumes in the shadow maps. Their batch (MeshUvFillBatch: meshUvFill.vert.glsl
 * and meshUvFill.wgsl) already moves each vertex by its height (the U column, screen px) times uSunShadow.xy; drawn again
 * with these programs, max blending, it writes the heights its vertices carry into the sun's map (WebGL: sunShadowMap.js
 * volumeMapVertex and VOLUME_MAP_FRAGMENT; WebGPU: volumeMapWgsl), each vertex landing by the map's shift, its height in
 * the map's units (uSunShadow.w: 1 / heightScaleY).
 */

import { SUN_MAP_ZMAX } from './sunShadowMap.js';
import { gpuStageF, gpuStageVF } from './webgpu/pixiMeshWgsl.js';

/** The source with `add` after its one `find`, or a clear error. */
function after(source, find, add, what) {
  if (typeof source !== 'string' || source.split(find).length !== 2) {
    throw new Error(`WeedJS: ${what} needs the volumes' mesh shader (${find.trim()})`);
  }
  return source.replace(find, () => find + add);
}

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

/**
 * The volumes' map programs on WebGPU (volumeMapWgsl): MeshUvFillBatch's bindings (colliderFillGpuProgram's, with its
 * sunShadow group).
 * @param {string} fragEntry 'mainFragMap' (the sun's map)
 */
export function volumeMapGpuProgram(GpuProgram, source, fragEntry, name) {
  if (!source) throw new Error("WeedJS: the volumes' mesh WGSL was not loaded before GpuProgram creation.");
  const vf = gpuStageVF();
  const f = gpuStageF();
  const data = { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false };
  return GpuProgram.from({
    name,
    vertex: { source, entryPoint: 'mainVert' },
    fragment: { source, entryPoint: fragEntry },
    layout: {
      0: { globalUniforms: 0 },
      1: { localUniforms: 0 },
      2: { uTexture: 0, uSampler: 1, uTexLut: 2, uPoseTable: 3, sunShadow: 4 },
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
      ],
    ],
  });
}
