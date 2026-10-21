/**
 * Second instanced mesh for explicit geometry that carries per-vertex UVs.
 * Created only after a MESH layer actually has one. Collider-fill stride stays 18.
 */

import {
  Geometry,
  Mesh,
  Shader,
  GpuProgram,
  GlProgram,
  Buffer,
  BufferUsage,
  State,
  Texture,
  TextureSource,
} from '../vendor/pixi.min.js';

import { colliderFillGpuProgram } from './webgpu/colliderFillWgsl.js';
import { colliderFillGlProgram } from './webgl/colliderFillGlsl.js';
import { dummyLutSource } from './instancedSpriteBatch.js';
import { FILL_ROW, MESH_UV_FILL_FLOATS, MESH_UV_FILL_STRIDE, sampleMeshFillPose } from './colliderFillBatch.js';

export class MeshUvFillBatch {
  constructor({ capacity, label, useWebGpu = true, shaders = null, atlasSource = null, lutSource = null }) {
    this.capacity = Math.max(1, capacity | 0);
    this.data = new Float32Array(this.capacity * MESH_UV_FILL_FLOATS);
    this.dataU32 = new Uint32Array(this.data.buffer);
    this.buffer = new Buffer({
      data: this.data,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      label: label || 'mesh-uv-fill',
    });

    const tri = new Float32Array([0, 0, 1, 0, 0, 1]);
    const stride = MESH_UV_FILL_STRIDE;
    const buf = this.buffer;

    this.geometry = new Geometry({
      attributes: {
        aTri: { buffer: tri, format: 'float32x2' },
        aV0: { buffer: buf, format: 'float32x2', stride, offset: FILL_ROW.V0 * 4, instance: true },
        aV1: { buffer: buf, format: 'float32x2', stride, offset: FILL_ROW.V1 * 4, instance: true },
        aV2: { buffer: buf, format: 'float32x2', stride, offset: FILL_ROW.V2 * 4, instance: true },
        aInstXY: { buffer: buf, format: 'float32x2', stride, offset: FILL_ROW.POS * 4, instance: true },
        aInstRotCS: { buffer: buf, format: 'float32x2', stride, offset: FILL_ROW.ROT * 4, instance: true },
        aInstTintBits: { buffer: buf, format: 'float32', stride, offset: FILL_ROW.TINT_BITS * 4, instance: true },
        aInstDepth: { buffer: buf, format: 'float32', stride, offset: FILL_ROW.DEPTH * 4, instance: true },
        aInstTexId: { buffer: buf, format: 'float32', stride, offset: FILL_ROW.TEX_ID * 4, instance: true },
        aInstTileInv: { buffer: buf, format: 'float32x2', stride, offset: FILL_ROW.TILE_INV * 4, instance: true },
        aInstTileOff: { buffer: buf, format: 'float32x2', stride, offset: FILL_ROW.TILE_OFF * 4, instance: true },
        aInstBody: { buffer: buf, format: 'float32', stride, offset: FILL_ROW.BODY * 4, instance: true },
        aUV0: { buffer: buf, format: 'float32x2', stride, offset: FILL_ROW.UV0 * 4, instance: true },
        aUV1: { buffer: buf, format: 'float32x2', stride, offset: FILL_ROW.UV1 * 4, instance: true },
        aUV2: { buffer: buf, format: 'float32x2', stride, offset: FILL_ROW.UV2 * 4, instance: true },
      },
    });
    this.geometry.instanceCount = 0;

    const atlas = atlasSource || Texture.WHITE.source;
    const lut = lutSource || dummyLutSource(useWebGpu);
    const posePx = new Float32Array(4);
    this._poseSource = TextureSource.from({
      resource: posePx,
      width: 1,
      height: 1,
      format: 'rgba32float',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
    });
    this._poseSource.uploadMethodId = 'external';
    this.poseTable = new Float32Array(256 * 4);
    const resources = {
      uTexture: atlas,
      uSampler: atlas.style,
      uTexLut: lut,
      uPoseTable: this._poseSource,
    };

    const name = label || 'mesh-uv-fill';
    if (useWebGpu) {
      const gpuProgram = colliderFillGpuProgram(GpuProgram, shaders?.meshUvFill, name);
      this.shader = new Shader({ gpuProgram, resources });
    } else {
      const glProgram = colliderFillGlProgram(
        GlProgram,
        shaders?.meshUvFillVert,
        shaders?.meshUvFillFrag,
        name,
      );
      this.shader = new Shader({ glProgram, resources });
    }

    const state = new State();
    state.blend = true;
    state.blendMode = 'normal';
    state.depthTest = true;
    state.depthMask = true;
    state.culling = false;

    this.mesh = new Mesh({
      geometry: this.geometry,
      shader: this.shader,
      state,
      label: name,
    });
    this.mesh.blendMode = 'normal';
    this.mesh.visible = false;
    this.mesh.cullable = false;
  }

  setAtlasSource(source) {
    if (!source) return;
    this.shader.resources.uTexture = source;
    this.shader.resources.uSampler = source.style;
  }

  setLutSource(source) {
    if (source) this.shader.resources.uTexLut = source;
  }

  upload(count) {
    const n = count | 0;
    if (n <= 0) {
      this.geometry.instanceCount = 0;
      this.mesh.visible = false;
      return 0;
    }
    this.mesh.visible = true;
    this.buffer.update(n * MESH_UV_FILL_STRIDE);
    this.geometry.instanceCount = n;
    return n;
  }

  uploadPoseTable(instanceEntity, count, views) {
    const n = count | 0;
    if (n <= 0 || !instanceEntity) return 0;
    const entityCount = views.entityCount | 0;
    const width = 256;
    const height = Math.max(1, ((entityCount + width - 1) / width) | 0);
    const need = width * height * 4;
    if (!this.poseTable || this.poseTable.length < need) this.poseTable = new Float32Array(need);
    if (!this._poseGen || this._poseGen.length < entityCount) this._poseGen = new Int32Array(entityCount);
    const table = this.poseTable;
    const gen = this._poseGen;
    const stamp = (this._poseStamp + 1) | 0 || 1;
    this._poseStamp = stamp;
    let k = 0;
    while (k < n) {
      const i = instanceEntity[k] | 0;
      let end = k + 1;
      while (end < n && (instanceEntity[end] | 0) === i) end++;
      k = end;
      if (i < 0 || i >= entityCount || gen[i] === stamp) continue;
      gen[i] = stamp;
      const pose = sampleMeshFillPose(i, views);
      const o = i * 4;
      table[o] = pose.x;
      table[o + 1] = pose.y;
      table[o + 2] = pose.c;
      table[o + 3] = pose.s;
    }
    this._poseWidth = width;
    this._poseHeight = height;
    this._poseDirty = true;
    this.mesh.visible = true;
    return n;
  }
}
