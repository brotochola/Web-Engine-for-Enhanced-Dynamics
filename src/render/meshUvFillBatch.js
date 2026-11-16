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
import { MESH_UV_FILL_FLOATS, MESH_UV_FILL_STRIDE, writeMeshPoseTable } from './colliderFillBatch.js';

/** The vec4 attributes a row is read as (aRow0..aRow5): MESH_UV_FILL_FLOATS / 4. */
export const MESH_UV_ROW_VEC4 = MESH_UV_FILL_FLOATS / 4;

export class MeshUvFillBatch {
  /**
   * `data`: where the rows are written, capacity × MESH_UV_FILL_FLOATS, a region of the mesh memory
   * (meshMemory.js, E-76 W11) where the corner kernel rewrites them; any other length, none. As in
   * ColliderFillBatch, the Pixi Buffer uploads an array of its own (E-123), and upload copies into it the
   * rows it sends.
   */
  constructor({ capacity, label, useWebGpu = true, shaders = null, atlasSource = null, lutSource = null, data = null, bufferSystem = null }) {
    this.capacity = Math.max(1, capacity | 0);
    this._bufferSystem = bufferSystem;
    const floats = this.capacity * MESH_UV_FILL_FLOATS;
    this.data = new Float32Array(floats);
    this.dataU32 = new Uint32Array(this.data.buffer);
    const shared = data instanceof Float32Array && data.length === floats ? data : null;
    this.rows = shared || this.data;
    this.rowsU32 = shared ? new Uint32Array(shared.buffer, shared.byteOffset, shared.length) : this.dataU32;
    this.buffer = new Buffer({
      data: this.data,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      label: label || 'mesh-uv-fill',
    });

    const stride = MESH_UV_FILL_STRIDE;
    const buf = this.buffer;
    // E-419: the row as MESH_UV_ROW_VEC4 vec4 in FILL_ROW's order (aRow0 floats 0-3, ...), which the shaders name field
    // by field: one attribute a field (14) made the vertex stage twice as slow (meshUvFill.vert.glsl). The shaders take
    // the corner from the vertex's index, and the index buffer [0, 1, 2] gives an instance its 3 vertices (N-228: an aTri
    // attribute that no shader reads made Pixi warn "Attribute aTri is not present in the shader").
    const attributes = {};
    for (let k = 0; k < MESH_UV_ROW_VEC4; k++) {
      attributes[`aRow${k}`] = { buffer: buf, format: 'float32x4', stride, offset: k * 16, instance: true };
    }
    // Uint32: 12 bytes (WebGPU makes no buffer whose size is not a multiple of 4; Uint16 [0, 1, 2] is 6).
    this.geometry = new Geometry({ attributes, indexBuffer: new Uint32Array([0, 1, 2]) });
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
    // ColliderFillBatch's uploadPoseTable state, declared here as there.
    this._poseGen = new Int32Array(0);
    this._poseStamp = 0;
    this._poseWidth = 0;
    this._poseHeight = 0;
    this._poseDirty = false;
    this._sunShadow = new Float32Array(4);
    const resources = {
      uTexture: atlas,
      uSampler: atlas.style,
      uTexLut: lut,
      uPoseTable: this._poseSource,
      sunShadow: { uSunShadow: { value: this._sunShadow, type: 'vec4<f32>' } },
    };

    const name = label || 'mesh-uv-fill';
    if (useWebGpu) {
      const gpuProgram = colliderFillGpuProgram(GpuProgram, shaders?.meshUvFill, name, true);
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
    // Rows paint in order and layers by zIndex. Every layer numbers its depth from 0 in one depth buffer: a test here
    // let a lower layer's late rows beat a higher layer's first ones (N-119).
    state.depthTest = false;
    state.depthMask = false;
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
    // E-123: the rows this upload sends, out of the mesh memory into the Buffer's own array.
    if (this.rows !== this.data) this.data.set(this.rows.subarray(0, n * MESH_UV_FILL_FLOATS));
    this.buffer.update(n * MESH_UV_FILL_STRIDE);
    this._send();
    this.geometry.instanceCount = n;
    return n;
  }

  /** ColliderFillBatch._send. */
  _send() {
    if (this._bufferSystem) this._bufferSystem.updateBuffer(this.buffer);
  }

  /**
   * DX-SUNMESH: how far a vertex moves per px of height this frame.
   * @returns {boolean} whether it differs from the last frame's
   */
  setSunShadow(x, y) {
    const s = this._sunShadow;
    if (s[0] === Math.fround(x) && s[1] === Math.fround(y)) return false;
    s[0] = x;
    s[1] = y;
    const group = this.shader.resources.sunShadow;
    if (group && typeof group.update === 'function') group.update();
    return true;
  }

  /** DX-VOLUME: this batch draws the volumes' layer: rows that carry a floor scale, in black. */
  setVolumes() {
    this._sunShadow[2] = 1;
    const group = this.shader.resources.sunShadow;
    if (group && typeof group.update === 'function') group.update();
  }

  /** ColliderFillBatch.uploadRange for the UV rows. */
  uploadRange(first, past) {
    const from = first * MESH_UV_FILL_FLOATS;
    if (this.rows !== this.data) this.data.set(this.rows.subarray(from, past * MESH_UV_FILL_FLOATS), from);
    this.buffer.update((past - first) * MESH_UV_FILL_STRIDE, first * MESH_UV_FILL_STRIDE);
    this._send();
  }

  /** ColliderFillBatch.uploadPoseTable for the UV rows. */
  uploadPoseTable(instanceEntity, count, views, framePose = null) {
    const n = count | 0;
    if (n <= 0 || !instanceEntity) return 0;
    const entityCount = views.entityCount | 0;
    const width = 256;
    const height = Math.max(1, ((entityCount + width - 1) / width) | 0);
    const need = width * height * 4;
    if (!this.poseTable || this.poseTable.length < need) this.poseTable = new Float32Array(need);
    if (!this._poseGen || this._poseGen.length < entityCount) this._poseGen = new Int32Array(entityCount);
    const stamp = (this._poseStamp + 1) | 0 || 1;
    this._poseStamp = stamp;
    writeMeshPoseTable(this.poseTable, this._poseGen, stamp, instanceEntity, n, entityCount, views, framePose);
    this._poseWidth = width;
    this._poseHeight = height;
    this._poseDirty = true;
    this.mesh.visible = true;
    return n;
  }
}
