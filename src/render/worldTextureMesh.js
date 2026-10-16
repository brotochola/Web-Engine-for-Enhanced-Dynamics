// One world rectangle. The engine vertex passes world position through.
// The scene fragment samples pictures by name. The camera moves the mesh.

import {
  Geometry,
  Mesh,
  Shader,
  GlProgram,
  GpuProgram,
  TextureSource,
} from '../vendor/pixi.min.js';
import { bytesPerTexel } from '../core/layerTextureUpload.js';
import { gpuStageF, gpuStageVF } from './webgpu/pixiMeshWgsl.js';
import { pinGpuTexture } from './webgpu/pinGpuTexture.js';
import { buildWorldRectWgsl, findWgslUseBeforeDeclare } from './webgpu/wgslPrelude.js';

const VERT_GLSL = `#version 300 es
in vec2 aPosition;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vWorld;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vWorld = aPosition;
}
`;

function sampleType(format) {
  if (format === 'r8uint' || format === 'rgba8uint') return 'uint';
  if (format === 'rgba8unorm' || format === 'bgra8unorm') return 'float';
  return 'unfilterable-float';
}

export function createSharedTextureSource(spec, renderer, useWebGpu) {
  const w = spec.width | 0;
  const h = spec.height | 0;
  const bpp = bytesPerTexel(spec.format);
  const source = TextureSource.from({
    resource: new Uint8Array(Math.max(4, w * h * bpp)),
    width: Math.max(1, w),
    height: Math.max(1, h),
    format: spec.format || 'r8unorm',
    scaleMode: 'nearest',
    addressMode: 'clamp-to-edge',
    autoGenerateMipmaps: false,
    alphaMode: 'no-premultiply-alpha',
  });
  source.autoGarbageCollect = false;
  const device = renderer && renderer.gpu && renderer.gpu.device;
  if (useWebGpu && device && w > 0 && h > 0) {
    const gpuTex = device.createTexture({
      label: spec.name || 'shared-picture',
      size: { width: w, height: h },
      format: spec.format || 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    pinGpuTexture(renderer, source, gpuTex);
    source.uploadMethodId = 'external';
  }
  return source;
}

export function createWorldRectMesh(opts) {
  const pictures = opts.pictures || [];
  const uniformDefs = opts.uniformDefs || {};
  let shader;
  if (opts.useWebGpu) {
    const wgsl = buildWorldRectWgsl(
      opts.fragmentSource,
      opts.uniformMap,
      opts.uniformTypes,
      pictures,
    );
    const early = findWgslUseBeforeDeclare(wgsl);
    if (early.length) {
      throw new Error(
        early.map((e) => `'${e.name}' used before declaration (line ${e.line})`).join('; '),
      );
    }
    const vf = gpuStageVF();
    const f = gpuStageF();
    const layout2 = { customUniforms: 0 };
    const gpuGroup = [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }];
    const resources = { customUniforms: uniformDefs };
    for (let i = 0; i < pictures.length; i++) {
      const pic = pictures[i];
      layout2[pic.name] = i + 1;
      gpuGroup.push({
        binding: i + 1,
        visibility: f,
        texture: { sampleType: sampleType(pic.format), viewDimension: '2d', multisampled: false },
      });
      resources[pic.name] = pic.source;
    }
    const gpuProgram = GpuProgram.from({
      name: opts.name || 'world-rect',
      vertex: { source: wgsl, entryPoint: 'mainVert' },
      fragment: { source: wgsl, entryPoint: 'mainFrag' },
      layout: {
        0: { globalUniforms: 0 },
        1: { localUniforms: 0 },
        2: layout2,
      },
      gpuLayout: [
        [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
        [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
        gpuGroup,
      ],
    });
    shader = new Shader({ gpuProgram, resources });
  } else {
    const resources = { customUniforms: uniformDefs };
    for (let i = 0; i < pictures.length; i++) resources[pictures[i].name] = pictures[i].source;
    const glProgram = GlProgram.from({
      name: opts.name || 'world-rect',
      vertex: VERT_GLSL,
      fragment: opts.fragmentSource,
    });
    shader = new Shader({ glProgram, resources });
  }
  const worldW = opts.worldW | 0;
  const worldH = opts.worldH | 0;
  const geometry = new Geometry({
    attributes: {
      aPosition: [0, 0, worldW, 0, worldW, worldH, 0, worldH],
    },
    indexBuffer: [0, 1, 2, 0, 2, 3],
  });
  const mesh = new Mesh({ geometry, shader });
  mesh.eventMode = 'none';
  mesh.cullable = false;
  return { mesh, shader };
}
