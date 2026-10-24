// MeshGeometry — one explicit triangle mesh per entity, independent of Collider.
// SAB arenas: local verts, optional UVs, optional indices. Pixi reads. Gameplay writes.
// The Box2D worker does not bind this pool.
//
// ponytail: first-fit spans fragment if replace churns different sizes.
// Upgrade: one shared asset id when many entities draw the same mesh.
//
// E-130: the per-mesh vertex counts and the triangle indices are Uint16 while the vertex arena
// (renderer.maxMeshVerts) is at most 65535, and Uint32 past that, up to MAX_MESH_VERTS_U32. Every thread
// that binds the arena derives the width from the same maxVerts (meshIndexWidth), once; the code that reads
// the columns is the same for both widths.

export const MESH_INDEX_WIDTH_16 = 16;
export const MESH_INDEX_WIDTH_32 = 32;
/** The largest vertex arena with 16-bit counts and indices, and the most vertices one mesh has there. */
export const MAX_MESH_VERTS_U16 = 65535;
/** The largest vertex arena at 32 bits, and the most vertices one mesh has there. */
export const MAX_MESH_VERTS_U32 = 1048576;
/**
 * renderer.maxMeshIndices' cap at either width. At the 32-bit vertex cap with these indices, one MESH layer's
 * batches and the arena still fit the corner kernel's memory (meshMemory.js, 512 MB).
 */
export const MAX_MESH_INDICES = 4194304;
/** setPlane's cells per axis: (254 + 1)^2 vertices fit 16 bits, and (1023 + 1)^2 is MAX_MESH_VERTS_U32. */
export const MAX_PLANE_SEGMENTS_U16 = 254;
export const MAX_PLANE_SEGMENTS_U32 = 1023;

/** The arena's index width for a vertex arena of `maxVerts`: 16 up to 65535, 32 past it. */
export function meshIndexWidth(maxVerts) {
  return (maxVerts | 0) > MAX_MESH_VERTS_U16 ? MESH_INDEX_WIDTH_32 : MESH_INDEX_WIDTH_16;
}

/** The width an arena binds: meshIndexWidth(maxVerts), or 32 when the caller asks for it (tests do). */
function arenaWidth(maxVerts, indexWidth) {
  return indexWidth === MESH_INDEX_WIDTH_32 ? MESH_INDEX_WIDTH_32 : meshIndexWidth(maxVerts);
}

let _warnedPool = false;
let _warnedIndices = false;
let _warnedExhausted = false;
let _warnedPolygon = false;

export function resetMeshGeometryWarns() {
  _warnedPool = false;
  _warnedIndices = false;
  _warnedExhausted = false;
  _warnedPolygon = false;
}

function warnOnce(flag, msg) {
  if (flag === 'pool') {
    if (_warnedPool) return;
    _warnedPool = true;
  } else if (flag === 'indices') {
    if (_warnedIndices) return;
    _warnedIndices = true;
  } else if (flag === 'full') {
    if (_warnedExhausted) return;
    _warnedExhausted = true;
  } else if (flag === 'poly') {
    if (_warnedPolygon) return;
    _warnedPolygon = true;
  }
  console.warn(msg);
}

function align4(o) {
  return (o + 3) & ~3;
}

/**
 * @param {ArrayBuffer|SharedArrayBuffer|null} buffer null = size only
 * @param {number} width 16 or 32 (arenaWidth): the class of vertCount and indices
 */
function bindMeshGeom(buffer, maxVerts, maxIndices, entityCount, width) {
  const V = maxVerts | 0;
  const I = maxIndices | 0;
  const E = entityCount | 0;
  const F = (E + 1) | 0;
  const IndexArray = width === MESH_INDEX_WIDTH_32 ? Uint32Array : Uint16Array;
  const ib = IndexArray.BYTES_PER_ELEMENT;
  let offset = 0;
  const view = (ctor, count, bytes) => {
    const v = buffer ? new ctor(buffer, offset, count) : null;
    offset += bytes;
    return v;
  };
  const vertOffset = view(Int32Array, E, E * 4);
  const vertCount = view(IndexArray, E, E * ib);
  offset = align4(offset);
  const indexOffset = view(Int32Array, E, E * 4);
  const indexCount = view(Uint32Array, E, E * 4);
  const hasUv = view(Uint8Array, E, E);
  offset = align4(offset);
  const vertexX = view(Float32Array, V, V * 4);
  const vertexY = view(Float32Array, V, V * 4);
  const uvU = view(Float32Array, V, V * 4);
  const uvV = view(Float32Array, V, V * 4);
  const indices = view(IndexArray, I, I * ib);
  offset = align4(offset);
  const revision = view(Uint32Array, 1, 4);
  const vertEpoch = view(Uint32Array, 1, 4);
  const vertGen = view(Uint32Array, E, E * 4);
  // E-118: bumped by in-place writes that store UVs (setMesh, setPlane, setRope), not by setVertices.
  const uvGen = view(Uint32Array, E, E * 4);
  const lock = view(Int32Array, 1, 4);
  const vertFreeCount = view(Int32Array, 1, 4);
  const indexFreeCount = view(Int32Array, 1, 4);
  const vertFreeOff = view(Int32Array, F, F * 4);
  const vertFreeLen = view(Int32Array, F, F * 4);
  const indexFreeOff = view(Int32Array, F, F * 4);
  const indexFreeLen = view(Int32Array, F, F * 4);
  return {
    byteLength: offset,
    vertOffset,
    vertCount,
    indexOffset,
    indexCount,
    hasUv,
    vertexX,
    vertexY,
    uvU,
    uvV,
    indices,
    revision,
    vertEpoch,
    vertGen,
    uvGen,
    lock,
    vertFreeCount,
    indexFreeCount,
    vertFreeOff,
    vertFreeLen,
    indexFreeOff,
    indexFreeLen,
    maxVerts: V,
    maxIndices: I,
    entityCount: E,
    maxFree: F,
    indexWidth: width === MESH_INDEX_WIDTH_32 ? MESH_INDEX_WIDTH_32 : MESH_INDEX_WIDTH_16,
    IndexArray,
  };
}

function finitePairs(src, nFloats) {
  for (let i = 0; i < nFloats; i++) {
    if (!Number.isFinite(+src[i])) return false;
  }
  return true;
}

export class MeshGeometry {
  static vertOffset = null;
  static vertCount = null;
  static indexOffset = null;
  static indexCount = null;
  static hasUv = null;
  static vertexX = null;
  static vertexY = null;
  static uvU = null;
  static uvV = null;
  static indices = null;
  static revision = null;
  /** E-118: per-entity UV generation (u32), bumped by _publishUv. */
  static uvGen = null;
  static lock = null;
  static vertFreeCount = null;
  static indexFreeCount = null;
  static vertFreeOff = null;
  static vertFreeLen = null;
  static indexFreeOff = null;
  static indexFreeLen = null;
  static maxVerts = 0;
  static maxIndices = 0;
  static entityCount = 0;
  static _maxFree = 0;
  static _xy = null;
  static _uv = null;
  static _idx = null;
  /** E-130: 16 or 32, the width of vertCount and indices; what an unbound arena reports is 16. */
  static indexWidth = MESH_INDEX_WIDTH_16;
  /** The class of vertCount and indices. */
  static IndexArray = Uint16Array;
  /** The most vertices replace takes for one mesh at this width. */
  static vertLimit = MAX_MESH_VERTS_U16;
  /** setPlane's cells per axis at this width. */
  static planeSegments = MAX_PLANE_SEGMENTS_U16;
  /** renderer.maxMeshVerts' and renderer.maxMeshIndices' caps (sceneSharedBuffers asserts them). */
  static VERT_CAP = MAX_MESH_VERTS_U32;
  static INDEX_CAP = MAX_MESH_INDICES;

  /**
   * @param {number} maxVerts
   * @param {number} maxIndices
   * @param {number} entityCount
   * @param {number} [indexWidth] 32 binds 32-bit columns below 65536 vertices too (tests); omitted, the width
   *   is meshIndexWidth(maxVerts), as every thread of a scene binds it
   */
  static getBufferSize(maxVerts, maxIndices, entityCount, indexWidth) {
    return bindMeshGeom(null, maxVerts, maxIndices, entityCount, arenaWidth(maxVerts, indexWidth)).byteLength;
  }

  static initializeArrays(buffer, maxVerts, maxIndices, entityCount, indexWidth) {
    const g = bindMeshGeom(buffer, maxVerts, maxIndices, entityCount, arenaWidth(maxVerts, indexWidth));
    this.vertOffset = g.vertOffset;
    this.vertCount = g.vertCount;
    this.indexOffset = g.indexOffset;
    this.indexCount = g.indexCount;
    this.hasUv = g.hasUv;
    this.vertexX = g.vertexX;
    this.vertexY = g.vertexY;
    this.uvU = g.uvU;
    this.uvV = g.uvV;
    this.indices = g.indices;
    this.revision = g.revision;
    this.vertEpoch = g.vertEpoch;
    this.vertGen = g.vertGen;
    this.uvGen = g.uvGen;
    this.lock = g.lock;
    this.vertFreeCount = g.vertFreeCount;
    this.indexFreeCount = g.indexFreeCount;
    this.vertFreeOff = g.vertFreeOff;
    this.vertFreeLen = g.vertFreeLen;
    this.indexFreeOff = g.indexFreeOff;
    this.indexFreeLen = g.indexFreeLen;
    this.maxVerts = g.maxVerts;
    this.maxIndices = g.maxIndices;
    this.entityCount = g.entityCount;
    this._maxFree = g.maxFree;
    const wide = g.indexWidth === MESH_INDEX_WIDTH_32;
    this.indexWidth = g.indexWidth;
    this.IndexArray = g.IndexArray;
    this.vertLimit = wide ? MAX_MESH_VERTS_U32 : MAX_MESH_VERTS_U16;
    this.planeSegments = wide ? MAX_PLANE_SEGMENTS_U32 : MAX_PLANE_SEGMENTS_U16;

    this.vertOffset.fill(-1);
    this.vertCount.fill(0);
    this.indexOffset.fill(-1);
    this.indexCount.fill(0);
    this.hasUv.fill(0);
    this.revision[0] = 0;
    if (this.vertEpoch) this.vertEpoch[0] = 0;
    if (this.vertGen) this.vertGen.fill(0);
    if (this.uvGen) this.uvGen.fill(0);
    this.lock[0] = 0;
    this.vertFreeCount[0] = 1;
    this.vertFreeOff[0] = 0;
    this.vertFreeLen[0] = g.maxVerts;
    this.indexFreeCount[0] = g.maxIndices > 0 ? 1 : 0;
    this.indexFreeOff[0] = 0;
    this.indexFreeLen[0] = g.maxIndices;
  }

  static reset() {
    this.vertOffset = null;
    this.vertCount = null;
    this.indexOffset = null;
    this.indexCount = null;
    this.hasUv = null;
    this.vertexX = null;
    this.vertexY = null;
    this.uvU = null;
    this.uvV = null;
    this.indices = null;
    this.revision = null;
    this.vertEpoch = null;
    this.vertGen = null;
    this.uvGen = null;
    this.lock = null;
    this.vertFreeCount = null;
    this.indexFreeCount = null;
    this.vertFreeOff = null;
    this.vertFreeLen = null;
    this.indexFreeOff = null;
    this.indexFreeLen = null;
    this.maxVerts = 0;
    this.maxIndices = 0;
    this.entityCount = 0;
    this._maxFree = 0;
    this.indexWidth = MESH_INDEX_WIDTH_16;
    this.IndexArray = Uint16Array;
    this.vertLimit = MAX_MESH_VERTS_U16;
    this.planeSegments = MAX_PLANE_SEGMENTS_U16;
    resetMeshGeometryWarns();
  }

  static scratchXY(nFloats) {
    const n = nFloats | 0;
    if (!this._xy || this._xy.length < n) this._xy = new Float32Array(n);
    return this._xy;
  }

  static scratchUV(nFloats) {
    const n = nFloats | 0;
    if (!this._uv || this._uv.length < n) this._uv = new Float32Array(n);
    return this._uv;
  }

  static scratchIdx(n) {
    const c = n | 0;
    if (!this._idx || this._idx.length < c) this._idx = new Uint32Array(c);
    return this._idx;
  }

  static bumpRevision() {
    const rev = this.revision;
    if (rev) rev[0] = (rev[0] + 1) >>> 0;
  }

  /**
   * E-118. In-place write that stored UVs (and maybe new indices): bump the entity's UV generation, so
   * Pixi rewrites the UV batch's corners of this mesh. Call after the stores and before _publishVert,
   * whose epoch bump tells Pixi to look. setVertices stores positions only and does not call it.
   */
  static _publishUv(i) {
    const g = this.uvGen;
    if (!g) return;
    const next = (Atomics.load(g, i) + 1) >>> 0;
    Atomics.store(g, i, next === 0 ? 1 : next);
  }

  /** In-place vert/UV write. Call after the stores. Does not bump topology revision. */
  static _publishVert(i) {
    const g = this.vertGen;
    const ep = this.vertEpoch;
    if (!g || !ep) return;
    const cur = Atomics.load(g, i);
    const next = (cur + 1) >>> 0;
    Atomics.store(g, i, next === 0 ? 1 : next);
    Atomics.add(ep, 0, 1);
  }

  static _lock() {
    const lock = this.lock;
    if (!lock) return false;
    while (Atomics.compareExchange(lock, 0, 0, 1) !== 0) {
      // setMesh is rare. Same short spin as Joint add/remove.
    }
    return true;
  }

  static _unlock() {
    if (this.lock) Atomics.store(this.lock, 0, 0);
  }

  static _allocSpan(off, len, count, need) {
    const n = count[0] | 0;
    const want = need | 0;
    if (want <= 0) return -1;
    for (let i = 0; i < n; i++) {
      const L = len[i] | 0;
      if (L < want) continue;
      const o = off[i] | 0;
      if (L === want) {
        off[i] = off[n - 1];
        len[i] = len[n - 1];
        count[0] = n - 1;
      } else {
        off[i] = o + want;
        len[i] = L - want;
      }
      return o;
    }
    return -1;
  }

  static _freeSpan(off, len, count, at, size) {
    const sz = size | 0;
    if (sz <= 0) return;
    let start = at | 0;
    let end = start + sz;
    let n = count[0] | 0;
    let i = 0;
    while (i < n) {
      const s = off[i] | 0;
      const e = s + (len[i] | 0);
      if (e < start || s > end) {
        i++;
        continue;
      }
      const grew = s < start || e > end;
      if (s < start) start = s;
      if (e > end) end = e;
      n--;
      off[i] = off[n];
      len[i] = len[n];
      if (grew) i = 0;
    }
    const cap = this._maxFree | 0;
    if (n >= cap) {
      count[0] = n;
      warnOnce('full', 'WeedJS: MeshGeometry span table is full');
      return;
    }
    off[n] = start;
    len[n] = end - start;
    count[0] = n + 1;
  }

  static _copyVerts(at, positions, vertN, uvs) {
    const x = this.vertexX;
    const y = this.vertexY;
    for (let v = 0; v < vertN; v++) {
      x[at + v] = +positions[v * 2];
      y[at + v] = +positions[v * 2 + 1];
    }
    if (uvs) {
      const u = this.uvU;
      const vv = this.uvV;
      for (let v = 0; v < vertN; v++) {
        u[at + v] = +uvs[v * 2];
        vv[at + v] = +uvs[v * 2 + 1];
      }
    }
  }

  static _copyIndices(at, indices, indexN) {
    const dst = this.indices;
    for (let t = 0; t < indexN; t++) dst[at + t] = indices[t] | 0;
  }

  static _publish(i, vAt, vertN, iAt, indexN, useUv) {
    this.vertOffset[i] = vAt;
    this.vertCount[i] = vertN;
    this.indexOffset[i] = iAt;
    this.indexCount[i] = indexN;
    this.hasUv[i] = useUv;
  }

  /**
   * @param {number} entity
   * @param {ArrayLike<number>} positions flat x,y
   * @param {ArrayLike<number>|null|undefined} indices null = convex fan
   * @param {ArrayLike<number>|null|undefined} uvs null = tile / stretch from position
   * @param {number} [vertCount] vertex count; omit to use positions.length / 2
   * @param {number} [indexCount] index count; omit to use indices.length
   * @returns {boolean}
   */
  static replace(entity, positions, indices, uvs, vertCount, indexCount) {
    if (!this.vertOffset || !this.lock) {
      warnOnce('pool', 'WeedJS: MeshRenderer.setMesh needs renderer.maxMeshVerts > 0');
      return false;
    }
    const i = entity | 0;
    if (i < 0 || i >= (this.entityCount | 0)) return false;
    if (!positions || positions.length == null) return false;
    let vertN;
    let floats;
    if (vertCount == null) {
      floats = positions.length | 0;
      vertN = floats >> 1;
      if (floats !== vertN * 2) return false;
    } else {
      vertN = vertCount | 0;
      floats = vertN * 2;
      if ((positions.length | 0) < floats) return false;
    }
    if (vertN < 3 || vertN > this.vertLimit) return false;
    if (!finitePairs(positions, floats)) return false;

    let indexN = 0;
    if (indices) {
      indexN = indexCount == null ? (indices.length | 0) : (indexCount | 0);
      if ((indices.length | 0) < indexN) return false;
      if (indexN < 3 || (indexN % 3) !== 0) return false;
      if (!this.indices || (this.maxIndices | 0) <= 0) {
        warnOnce('indices', 'WeedJS: MeshRenderer.setMesh indices need renderer.maxMeshIndices > 0');
        return false;
      }
      for (let t = 0; t < indexN; t++) {
        const ix = indices[t];
        if ((ix | 0) !== ix || ix < 0 || ix >= vertN) return false;
      }
    }
    let useUv = 0;
    if (uvs) {
      if ((uvs.length | 0) < floats || !finitePairs(uvs, floats)) return false;
      if (vertCount == null && (uvs.length | 0) !== floats) return false;
      useUv = 1;
    }

    if (!this._lock()) return false;
    const oldV = this.vertOffset[i] | 0;
    const oldVC = this.vertCount[i] | 0;
    const oldI = this.indexOffset[i] | 0;
    const oldIC = this.indexCount[i] | 0;
    const same =
      oldV >= 0 &&
      oldVC === vertN &&
      (this.hasUv[i] | 0) === useUv &&
      ((indexN === 0 && oldI < 0) || (indexN > 0 && oldI >= 0 && (oldIC >>> 0) === indexN));
    if (same) {
      this._copyVerts(oldV, positions, vertN, useUv ? uvs : null);
      if (indexN > 0) this._copyIndices(oldI, indices, indexN);
      // A mesh with UVs rewrote them here (and its indices, which pick each corner's UV).
      if (useUv) this._publishUv(i);
      this._publishVert(i);
      this._unlock();
      return true;
    }

    let vAt = this._allocSpan(this.vertFreeOff, this.vertFreeLen, this.vertFreeCount, vertN);
    let iAt = -1;
    if (vAt >= 0 && indexN > 0) {
      iAt = this._allocSpan(this.indexFreeOff, this.indexFreeLen, this.indexFreeCount, indexN);
      if (iAt < 0) {
        this._freeSpan(this.vertFreeOff, this.vertFreeLen, this.vertFreeCount, vAt, vertN);
        vAt = -1;
      }
    }
    let freedOld = false;
    if (vAt < 0 && oldV >= 0) {
      this._freeSpan(this.vertFreeOff, this.vertFreeLen, this.vertFreeCount, oldV, oldVC);
      this.vertOffset[i] = -1;
      this.vertCount[i] = 0;
      if (oldI >= 0) {
        this._freeSpan(this.indexFreeOff, this.indexFreeLen, this.indexFreeCount, oldI, oldIC);
        this.indexOffset[i] = -1;
        this.indexCount[i] = 0;
      }
      this.hasUv[i] = 0;
      freedOld = true;
      vAt = this._allocSpan(this.vertFreeOff, this.vertFreeLen, this.vertFreeCount, vertN);
      if (vAt >= 0 && indexN > 0) {
        iAt = this._allocSpan(this.indexFreeOff, this.indexFreeLen, this.indexFreeCount, indexN);
        if (iAt < 0) {
          this._freeSpan(this.vertFreeOff, this.vertFreeLen, this.vertFreeCount, vAt, vertN);
          vAt = -1;
        }
      }
    }
    if (vAt < 0) {
      this._publish(i, -1, 0, -1, 0, 0);
      this.bumpRevision();
      this._unlock();
      warnOnce('full', 'WeedJS: MeshGeometry pool is full (renderer.maxMeshVerts / maxMeshIndices)');
      return false;
    }
    this._copyVerts(vAt, positions, vertN, useUv ? uvs : null);
    if (indexN > 0) this._copyIndices(iAt, indices, indexN);
    if (!freedOld && oldV >= 0) {
      this._freeSpan(this.vertFreeOff, this.vertFreeLen, this.vertFreeCount, oldV, oldVC);
      if (oldI >= 0) {
        this._freeSpan(this.indexFreeOff, this.indexFreeLen, this.indexFreeCount, oldI, oldIC);
      }
    }
    this._publish(i, vAt, vertN, indexN > 0 ? iAt : -1, indexN, useUv);
    this.bumpRevision();
    this._unlock();
    return true;
  }

  static writeVertices(entity, positions) {
    if (!this.vertOffset || !this.lock) return false;
    const i = entity | 0;
    if (i < 0 || i >= (this.entityCount | 0)) return false;
    if (!positions || positions.length == null) return false;
    const n = this.vertCount[i] | 0;
    const floats = n * 2;
    const off = this.vertOffset[i] | 0;
    if (off < 0 || (positions.length | 0) !== floats || !finitePairs(positions, floats)) return false;
    if (!this._lock()) return false;
    const offNow = this.vertOffset[i] | 0;
    const nNow = this.vertCount[i] | 0;
    if (offNow < 0 || nNow !== n) {
      this._unlock();
      return false;
    }
    this._copyVerts(offNow, positions, n, null);
    this._publishVert(i);
    this._unlock();
    return true;
  }

  static clearEntity(entity) {
    const off = this.vertOffset;
    if (!off || !this.lock) return;
    const i = entity | 0;
    if (i < 0 || i >= (this.entityCount | 0)) return;
    if ((off[i] | 0) < 0 && (this.indexOffset[i] | 0) < 0) return;
    if (!this._lock()) return;
    const vAt = this.vertOffset[i] | 0;
    if (vAt >= 0) {
      this._freeSpan(this.vertFreeOff, this.vertFreeLen, this.vertFreeCount, vAt, this.vertCount[i] | 0);
    }
    const iAt = this.indexOffset[i] | 0;
    if (iAt >= 0) {
      this._freeSpan(
        this.indexFreeOff,
        this.indexFreeLen,
        this.indexFreeCount,
        iAt,
        this.indexCount[i] >>> 0,
      );
    }
    this._publish(i, -1, 0, -1, 0, 0);
    this.bumpRevision();
    this._unlock();
  }

  static warnPolygon() {
    warnOnce('poly', 'WeedJS: MeshRenderer.setPolygon needs a simple outline (no holes)');
  }
}
