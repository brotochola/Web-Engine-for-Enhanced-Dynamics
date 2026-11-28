/**
 * Second mesh for explicit geometry that carries per-vertex UVs.
 * Created only after a MESH layer actually has one. Collider-fill stride stays 18.
 *
 * E-453: it draws each mesh's vertices once, through an index buffer (packMeshUvVerts): a vertex record
 * (MESH_UV_VERT_FLOATS) a vertex, read as 4 vec4 (aVert0..aVert3), and each triangle 3 indices, in the order the rows of
 * packMeshUvFill drew them. The geometry's instanceCount is 1 while it has triangles and 0 when it has none
 * (emptyInstancedMesh); the lamps' map draws the same buffers once a tile in use (instanceCount the tiles).
 */

import { Geometry, Shader, GpuProgram, GlProgram, Buffer, BufferUsage, Texture } from '../vendor/pixi.min.js';

import { colliderFillGpuProgram } from './webgpu/colliderFillWgsl.js';
import { glProgramFrom } from './webgl/glProgram.js';
import { dummyLutSource } from './instancedSpriteBatch.js';
import { FillBatchBase, MESH_UV_VERT_FLOATS, MESH_UV_VERT_STRIDE } from './colliderFillBatch.js';

/**
 * The batch's program as a Shader's options. On WebGL it comes from GlProgram.from, one program for every layer's batch
 * (the first one's name): E-494 makes it at the renderer's init, and a batch made on a layer's first UV mesh finds it linked.
 * @param {boolean} useWebGpu
 * @param {object|null} shaders the engine shaders (meshUvFill, or meshUvFillVert and meshUvFillFrag)
 * @param {string} name
 */
export function meshUvFillProgram(useWebGpu, shaders, name) {
  if (useWebGpu) return { gpuProgram: colliderFillGpuProgram(GpuProgram, shaders?.meshUvFill, name, true) };
  return { glProgram: glProgramFrom(GlProgram, shaders?.meshUvFillVert, shaders?.meshUvFillFrag, name) };
}

/** The vec4 attributes a vertex record is read as (aVert0..aVert3): MESH_UV_VERT_FLOATS / 4. */
export const MESH_UV_VERT_VEC4 = MESH_UV_VERT_FLOATS / 4;

export class MeshUvFillBatch extends FillBatchBase {
  /**
   * @param {object} opts
   * @param {number} opts.capacity vertex records
   * @param {number} [opts.indexCapacity] indices, 3 a triangle (default 3 × capacity)
   * @param {number} [opts.entities] the entities an indexSpan of the batch's own covers (2 values each)
   * @param {Float32Array|null} [opts.data] where the records are written, capacity × MESH_UV_VERT_FLOATS: a region of
   *   the mesh memory (meshMemory.js, E-76 W11), where the corner kernel rewrites them; any other length, none. As in
   *   ColliderFillBatch, the Pixi Buffers upload arrays of their own (E-123), and the uploads copy into them what they
   *   send.
   * @param {Uint32Array|null} [opts.vertexEntity] each record's entity (capacity of them), in the mesh memory with `data`
   * @param {Uint32Array|null} [opts.indices] where the packs write the triangles' indices (indexCapacity), there too
   * @param {Uint32Array|null} [opts.indexSpan] each entity's first index and count (packMeshUvVerts), there too
   * @param {{ updateBuffer: (buffer: object) => unknown }|null} [opts.bufferSystem] the renderer's: see _send
   * @param {{ unbind?: () => void }|null} [opts.geometrySystem] the renderer's: see _sendIndices
   */
  constructor({
    capacity,
    indexCapacity = 0,
    entities = 0,
    label,
    useWebGpu = true,
    shaders = null,
    atlasSource = null,
    lutSource = null,
    data = null,
    vertexEntity = null,
    indices = null,
    indexSpan = null,
    bufferSystem = null,
    geometrySystem = null,
  }) {
    super(bufferSystem);
    this.capacity = Math.max(1, capacity | 0);
    this.indexCapacity = Math.max(3, (indexCapacity | 0) > 0 ? indexCapacity | 0 : this.capacity * 3);
    this._geometrySystem = geometrySystem;
    const floats = this.capacity * MESH_UV_VERT_FLOATS;
    this.data = new Float32Array(floats);
    this.dataU32 = new Uint32Array(this.data.buffer);
    const shared = data instanceof Float32Array && data.length === floats ? data : null;
    // Where the packs and the corner rewrite write the records: the mesh memory's region when there is one, and upload
    // copies the records it sends from there; else this.data (ColliderFillBatch's rows say why).
    this.verts = shared || this.data;
    this.vertsU32 = shared ? new Uint32Array(shared.buffer, shared.byteOffset, shared.length) : this.dataU32;
    this.vertexEntity = vertexEntity instanceof Uint32Array && vertexEntity.length >= this.capacity
      ? vertexEntity
      : new Uint32Array(this.capacity);
    this.indices = indices instanceof Uint32Array && indices.length >= this.indexCapacity
      ? indices
      : new Uint32Array(this.indexCapacity);
    this.indexSpan = indexSpan instanceof Uint32Array ? indexSpan : new Uint32Array(Math.max(0, entities | 0) * 2);
    // E-466: STATIC on WebGL. ANGLE (Direct3D 11) binds only a STATIC buffer directly; a DYNAMIC one it copies whole into a
    // streaming buffer at every draw (Buffer11::supportsDirectBinding), and these hold tens of MB of which a frame changes
    // a few hundred KB. A STATIC one is copied on the GPU when it changes, whole: E-477, on WebGL the Buffer's data is a view
    // over the records in use (_fitBuffer), and shrinkToFit off keeps a shorter view from making a new buffer.
    this.buffer = new Buffer({
      data: this.data,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST | (useWebGpu ? 0 : BufferUsage.STATIC),
      label: label || 'mesh-uv-fill',
      shrinkToFit: false,
    });
    this._fitGl = !useWebGpu;
    // The index buffer's own array. Pixi draws data.length indices, so the buffer's data is a view of the first
    // indexCount (_setIndexView); with shrinkToFit off a shorter view keeps the buffer the GPU has.
    this.indexData = new Uint32Array(this.indexCapacity);
    this._indexView = this.indexData;
    this.indexBuffer = new Buffer({
      data: this.indexData,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST | (useWebGpu ? 0 : BufferUsage.STATIC),
      label: `${label || 'mesh-uv-fill'}-indices`,
      shrinkToFit: false,
    });
    this.indexCount = 0;
    /**
     * E-508: moves on every upload of the records, the indices or the poses: the lamps' volumes' cache was painted from
     * what the batch draws while it holds.
     */
    this.version = 0;

    const stride = MESH_UV_VERT_STRIDE;
    const buf = this.buffer;
    // A record as MESH_UV_VERT_VEC4 vec4 in MESH_UV_VERT's order, one a vertex, which the shaders name field by field
    // (meshUvFill.vert.glsl).
    const attributes = {};
    for (let k = 0; k < MESH_UV_VERT_VEC4; k++) {
      attributes[`aVert${k}`] = { buffer: buf, format: 'float32x4', stride, offset: k * 16 };
    }
    this.geometry = new Geometry({ attributes, indexBuffer: this.indexBuffer });
    this.geometry.instanceCount = 0;

    const atlas = atlasSource || Texture.WHITE.source;
    const lut = lutSource || dummyLutSource(useWebGpu);
    this._sunShadow = new Float32Array(4);
    const resources = {
      uTexture: atlas,
      uSampler: atlas.style,
      uTexLut: lut,
      uPoseTable: this._poseSource,
      sunShadow: { uSunShadow: { value: this._sunShadow, type: 'vec4<f32>' } },
    };

    const name = label || 'mesh-uv-fill';
    this._makeMesh(this.geometry, new Shader({ ...meshUvFillProgram(useWebGpu, shaders, name), resources }), name);
  }

  /**
   * Send the first `count` records and `indexCount` indices the pack wrote: what the batch draws from now.
   * @param {number} count
   * @param {number} indexCount
   * @returns {number} the indices drawn
   */
  upload(count, indexCount) {
    this.version = (this.version + 1) | 0;
    const n = Math.min(count | 0, this.capacity);
    const m = Math.min(indexCount | 0, this.indexCapacity);
    if (n <= 0 || m < 3) {
      this.geometry.instanceCount = 0;
      this.mesh.visible = false;
      this.indexCount = 0;
      return 0;
    }
    this.mesh.visible = true;
    // E-123: what this upload sends, out of the mesh memory into the Buffers' own arrays.
    if (this.verts !== this.data) this.data.set(this.verts.subarray(0, n * MESH_UV_VERT_FLOATS));
    this._fitBuffer(n * MESH_UV_VERT_FLOATS);
    this.buffer.update(n * MESH_UV_VERT_STRIDE);
    this._send();
    this.indexData.set(this.indices.subarray(0, m));
    this._setIndexView(m);
    this._sendIndices();
    this.indexCount = m;
    this.geometry.instanceCount = 1;
    return m;
  }

  /** The index buffer's data: its array's first `m` (a new view only when the count moved). */
  _setIndexView(m) {
    if (this._indexView.length === m) {
      this.indexBuffer.update(m * 4);
      return;
    }
    this._indexView = m === this.indexData.length ? this.indexData : this.indexData.subarray(0, m);
    this.indexBuffer.setDataWithSize(this._indexView, m, true);
  }

  /**
   * _send for the index buffer. WebGL binds an index buffer into the vertex array bound, so Pixi's is unbound first (its
   * geometry system binds the next draw's again).
   */
  _sendIndices() {
    if (!this._bufferSystem) return;
    const geometry = this._geometrySystem;
    if (geometry && typeof geometry.unbind === 'function') geometry.unbind();
    this._bufferSystem.updateBuffer(this.indexBuffer);
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

  /** DX-VOLUME: this batch draws the volumes' layer: records that carry a floor scale, in black. */
  setVolumes() {
    this._sunShadow[2] = 1;
    const group = this.shader.resources.sunShadow;
    if (group && typeof group.update === 'function') group.update();
  }

  /** ColliderFillBatch.uploadRange for records [first, past), which an upload of the same layout already placed. */
  uploadRange(first, past) {
    this.version = (this.version + 1) | 0;
    const from = first * MESH_UV_VERT_FLOATS;
    if (this.verts !== this.data) this.data.set(this.verts.subarray(from, past * MESH_UV_VERT_FLOATS), from);
    this.buffer.update((past - first) * MESH_UV_VERT_STRIDE, first * MESH_UV_VERT_STRIDE);
    this._send();
  }

  /** Send indices [first, past) of the drawn ones, which the corner rewrite wrote again. */
  uploadIndexRange(first, past) {
    this.version = (this.version + 1) | 0;
    const from = first | 0;
    const end = Math.min(past | 0, this.indexCount);
    if (end <= from) return;
    this.indexData.set(this.indices.subarray(from, end), from);
    this.indexBuffer.update((end - from) * 4, from * 4);
    this._sendIndices();
  }

  /** FillBatchBase.uploadPoseTable for the records: `instanceEntity` is vertexEntity, `count` the records. */
  uploadPoseTable(instanceEntity, count, views, framePose = null) {
    this.version = (this.version + 1) | 0;
    return super.uploadPoseTable(instanceEntity, count, views, framePose);
  }
}
