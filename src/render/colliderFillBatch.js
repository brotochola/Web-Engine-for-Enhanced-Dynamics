/**
 * Instanced solid fill of this entity's collider.
 * Fixtures first; else primary polygon / box / display 8-gon for a physics circle.
 * One PIXI.Mesh per LAYER_KIND.MESH slot. VS applies packed pose
 * (published display pose when pixi latched it, else live Transform).
 * Pixi can skip pack+upload when ColliderFixture.revision and mesh pose match last frame.
 *
 * Instance floats (12): v0, v1, v2, xy, rotCS, tintBits, depth.
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
} from '../vendor/pixi.min.js';

import { MAX_POLYGON_VERTICES, ShapeType } from '../util/configDefaults.js';
import { colliderFillGpuProgram } from './webgpu/colliderFillWgsl.js';
import { colliderFillGlProgram } from './webgl/colliderFillGlsl.js';

export const COLLIDER_FILL_FLOATS = 12;
export const COLLIDER_FILL_STRIDE = COLLIDER_FILL_FLOATS * 4;
/** lastRevision < 0 means no packed frame yet (always pack). */
export const COLLIDER_FILL_PACK_FIRST_FRAME = -1;

const INV = 0xffff;
const TWO_PI = Math.PI * 2;

let _warnedMeshLayer = false;
let _warnedNoDrawable = false;

export function resetColliderFillMeshLayerWarn() {
  _warnedMeshLayer = false;
  _warnedNoDrawable = false;
}

function entityHasDrawableCollider(i, views) {
  if ((views.fixtureCount[i] | 0) >= 1) return true;
  const st = views.primaryShapeType ? views.primaryShapeType[i] | 0 : -1;
  if (st === ShapeType.Polygon && views.primaryPolyCount && (views.primaryPolyCount[i] | 0) >= 3) {
    return true;
  }
  if (st === ShapeType.Box && views.primaryWidth && views.primaryHeight) {
    return views.primaryWidth[i] > 0 && views.primaryHeight[i] > 0;
  }
  if (st === ShapeType.Circle && views.primaryRadius) {
    return views.primaryRadius[i] > 0;
  }
  return false;
}

/**
 * Write one fan triangle. Returns new written count, or -1 if cap hit.
 */
function writeFillTri(out, outU32, base, written, maxOut, depthDenom, x0, y0, x1, y1, x2, y2, wx, wy, c, s, packed) {
  if (written >= maxOut) return -1;
  out[base] = x0;
  out[base + 1] = y0;
  out[base + 2] = x1;
  out[base + 3] = y1;
  out[base + 4] = x2;
  out[base + 5] = y2;
  out[base + 6] = wx;
  out[base + 7] = wy;
  out[base + 8] = c;
  out[base + 9] = s;
  outU32[base + 10] = packed >>> 0;
  out[base + 11] = 1.0 - (written + 1) / depthDenom;
  return written + 1;
}

const _fanOut = { written: 0, base: 0, full: false };

function fanLocalVerts(out, outU32, base, written, maxOut, depthDenom, vx, vy, vb, n, wx, wy, c, s, packed) {
  const x0 = vx[vb];
  const y0 = vy[vb];
  const fans = n - 2;
  for (let t = 0; t < fans; t++) {
    const next = writeFillTri(
      out, outU32, base, written, maxOut, depthDenom,
      x0, y0, vx[vb + t + 1], vy[vb + t + 1], vx[vb + t + 2], vy[vb + t + 2],
      wx, wy, c, s, packed,
    );
    if (next < 0) {
      _fanOut.written = written;
      _fanOut.base = base;
      _fanOut.full = true;
      return _fanOut;
    }
    written = next;
    base += COLLIDER_FILL_FLOATS;
  }
  _fanOut.written = written;
  _fanOut.base = base;
  _fanOut.full = false;
  return _fanOut;
}

/**
 * Grow reused pose/presence scratch for MF4 skip. No alloc when already large enough.
 * @param {object} prevPose
 * @param {number} entityCount
 */
export function ensureMeshFillPoseScratch(prevPose, entityCount) {
  const n = entityCount | 0;
  if (!prevPose.x || prevPose.x.length < n) {
    prevPose.x = new Float32Array(n);
    prevPose.y = new Float32Array(n);
    prevPose.rotC = new Float32Array(n);
    prevPose.rotS = new Float32Array(n);
    prevPose.active = new Uint8Array(n);
    prevPose.visible = new Uint8Array(n);
  }
  return prevPose;
}

/**
 * Copy current mesh pose + presence into prevPose after a successful pack.
 * @param {object} views
 * @param {object} prevPose
 */
export function copyMeshFillPoseScratch(views, prevPose) {
  const n = views.entityCount | 0;
  ensureMeshFillPoseScratch(prevPose, n);
  const px = prevPose.x;
  const py = prevPose.y;
  const pc = prevPose.rotC;
  const ps = prevPose.rotS;
  const pa = prevPose.active;
  const pv = prevPose.visible;
  const x = views.x;
  const y = views.y;
  const c = views.rotC;
  const s = views.rotS;
  const active = views.meshActive;
  const visible = views.meshVisible;
  for (let i = 0; i < n; i++) {
    px[i] = x[i];
    py[i] = y[i];
    pc[i] = c ? c[i] : 1;
    ps[i] = s ? s[i] : 0;
    pa[i] = active[i];
    pv[i] = visible[i];
  }
}

/**
 * True if any mesh-active/visible bit or Transform pose drifted vs prevPose.
 * @param {object} views
 * @param {object} prevPose
 */
export function meshFillPoseOrPresenceChanged(views, prevPose) {
  const n = views.entityCount | 0;
  const px = prevPose && prevPose.x;
  if (!px || px.length < n) return true;
  const py = prevPose.y;
  const pc = prevPose.rotC;
  const ps = prevPose.rotS;
  const pa = prevPose.active;
  const pv = prevPose.visible;
  const active = views.meshActive;
  const visible = views.meshVisible;
  const x = views.x;
  const y = views.y;
  const c = views.rotC;
  const s = views.rotS;
  for (let i = 0; i < n; i++) {
    const a = active[i] | 0;
    const vis = visible[i] | 0;
    if ((pa[i] | 0) !== a || (pv[i] | 0) !== vis) return true;
    if (!a || !vis) continue;
    if (x[i] !== px[i] || y[i] !== py[i]) return true;
    const rc = c ? c[i] : 1;
    const rs = s ? s[i] : 0;
    if (rc !== pc[i] || rs !== ps[i]) return true;
  }
  return false;
}

function readFixtureRevision(views) {
  return views.fixtureRevision ? (views.fixtureRevision[0] | 0) : 0;
}

/**
 * True when pack+upload can be skipped.
 * ponytail: first frame and any fixture replace always pack; moving mesh always pack.
 * @param {object} views
 * @param {number} lastRevision
 * @param {object} prevPose
 */
export function colliderFillCanSkipPack(views, lastRevision, prevPose) {
  if ((lastRevision | 0) < 0 || !prevPose) return false;
  if (readFixtureRevision(views) !== (lastRevision | 0)) return false;
  return !meshFillPoseOrPresenceChanged(views, prevPose);
}

/**
 * Pack collider fans for one MESH layer bit into `out`.
 * Fixtures win; else primary polygon, box (two tris), or a display regular 8-gon
 * for a physics circle. Circle physics stays a true circle.
 * @param {Float32Array} out
 * @param {number} cap
 * @param {number} layerId
 * @param {object} views
 * @returns {number} instance count
 */
export function packColliderFill(out, cap, layerId, views) {
  const maxOut = cap | 0;
  if (!out || maxOut <= 0) return 0;

  const entityCount = views.entityCount | 0;
  const meshActive = views.meshActive;
  const meshVisible = views.meshVisible;
  const meshMask = views.meshLayerMask;
  const meshTint = views.meshTint;
  const meshAlpha = views.meshAlpha;
  const fixtureCount = views.fixtureCount;
  const head = views.fixtureHead;
  const next = views.fixtureNext;
  const fxActive = views.fixtureActive;
  const vertCount = views.vertCount;
  const vx = views.vertexX;
  const vy = views.vertexY;
  const tx = views.x;
  const ty = views.y;
  const rotC = views.rotC;
  const rotS = views.rotS;
  const offsetX = views.offsetX;
  const offsetY = views.offsetY;
  const meshBits = views.meshBits | 0;
  const maxFx = views.maxFixtures | 0;
  const primaryShapeType = views.primaryShapeType;
  const primaryPolyCount = views.primaryPolyCount;
  const primaryPolyVertexX = views.primaryPolyVertexX;
  const primaryPolyVertexY = views.primaryPolyVertexY;
  const primaryWidth = views.primaryWidth;
  const primaryHeight = views.primaryHeight;
  const primaryRadius = views.primaryRadius;
  const outU32 = views.outU32 || new Uint32Array(out.buffer, out.byteOffset, out.length);

  const bit = 1 << (layerId | 0);
  const depthDenom = maxOut + 1;
  let written = 0;
  let base = 0;

  for (let i = 0; i < entityCount; i++) {
    if (!meshActive[i] || !meshVisible[i]) continue;
    const mask = meshMask[i] | 0;
    const drawable = entityHasDrawableCollider(i, views);
    if (!(mask & meshBits)) {
      if (!_warnedMeshLayer && drawable) {
        _warnedMeshLayer = true;
        console.warn('WeedJS: MeshRenderer requires setLayer on a LAYER_KIND.MESH layer');
      }
      continue;
    }
    if (!(mask & bit)) continue;
    if (!drawable) {
      if (!_warnedNoDrawable) {
        _warnedNoDrawable = true;
        console.warn('WeedJS: MeshRenderer has no drawable collider (fixtures or primary box/circle/polygon)');
      }
      continue;
    }

    const c = rotC ? rotC[i] : 1;
    const s = rotS ? rotS[i] : 0;
    const ox = offsetX ? offsetX[i] : 0;
    const oy = offsetY ? offsetY[i] : 0;
    const wx = tx[i] + c * ox - s * oy;
    const wy = ty[i] + s * ox + c * oy;

    let a = meshAlpha ? meshAlpha[i] : 1;
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    const a8 = (a * 255 + 0.5) | 0;
    const packed = ((a8 & 255) << 24) | ((meshTint[i] >>> 0) & 0xffffff);

    if ((fixtureCount[i] | 0) >= 1 && head) {
      let cur = head[i];
      let guard = 0;
      while (cur !== INV && guard++ < maxFx) {
        if (!fxActive[cur]) {
          cur = next[cur];
          continue;
        }
        const n = vertCount[cur] | 0;
        if (n < 3 || n > MAX_POLYGON_VERTICES) {
          cur = next[cur];
          continue;
        }
        const fan = fanLocalVerts(
          out, outU32, base, written, maxOut, depthDenom,
          vx, vy, cur * MAX_POLYGON_VERTICES, n, wx, wy, c, s, packed,
        );
        written = fan.written;
        base = fan.base;
        if (fan.full) return written;
        cur = next[cur];
      }
      continue;
    }

    const st = primaryShapeType ? primaryShapeType[i] | 0 : -1;
    if (st === ShapeType.Polygon && primaryPolyCount && (primaryPolyCount[i] | 0) >= 3) {
      const n = primaryPolyCount[i] | 0;
      const fan = fanLocalVerts(
        out, outU32, base, written, maxOut, depthDenom,
        primaryPolyVertexX, primaryPolyVertexY, i * MAX_POLYGON_VERTICES, n,
        wx, wy, c, s, packed,
      );
      written = fan.written;
      base = fan.base;
      if (fan.full) return written;
      continue;
    }

    if (st === ShapeType.Box && primaryWidth && primaryHeight) {
      const hw = primaryWidth[i] * 0.5;
      const hh = primaryHeight[i] * 0.5;
      if (hw > 0 && hh > 0) {
        let nextW = writeFillTri(
          out, outU32, base, written, maxOut, depthDenom,
          -hw, -hh, hw, -hh, hw, hh, wx, wy, c, s, packed,
        );
        if (nextW < 0) return written;
        written = nextW;
        base += COLLIDER_FILL_FLOATS;
        nextW = writeFillTri(
          out, outU32, base, written, maxOut, depthDenom,
          -hw, -hh, hw, hh, -hw, hh, wx, wy, c, s, packed,
        );
        if (nextW < 0) return written;
        written = nextW;
        base += COLLIDER_FILL_FLOATS;
      }
      continue;
    }

    if (st === ShapeType.Circle && primaryRadius) {
      const r = primaryRadius[i];
      if (r > 0) {
        // Display regular 8-gon. Physics stays a true circle.
        const n = MAX_POLYGON_VERTICES;
        const step = TWO_PI / n;
        const x0 = r;
        const y0 = 0;
        for (let t = 0; t < n - 2; t++) {
          const a1 = (t + 1) * step;
          const a2 = (t + 2) * step;
          const nextW = writeFillTri(
            out, outU32, base, written, maxOut, depthDenom,
            x0, y0, r * Math.cos(a1), r * Math.sin(a1), r * Math.cos(a2), r * Math.sin(a2),
            wx, wy, c, s, packed,
          );
          if (nextW < 0) return written;
          written = nextW;
          base += COLLIDER_FILL_FLOATS;
        }
      }
    }
  }

  return written;
}

export class ColliderFillBatch {
  /**
   * @param {object} opts
   * @param {number} opts.capacity
   * @param {string} [opts.label]
   * @param {boolean} [opts.useWebGpu=true]
   * @param {object} opts.shaders
   */
  constructor({ capacity, label, useWebGpu = true, shaders = null }) {
    this.capacity = Math.max(1, capacity | 0);
    this.data = new Float32Array(this.capacity * COLLIDER_FILL_FLOATS);
    this.dataU32 = new Uint32Array(this.data.buffer);
    this.buffer = new Buffer({
      data: this.data,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      label: label || 'collider-fill',
    });

    const tri = new Float32Array([0, 0, 1, 0, 0, 1]);
    const stride = COLLIDER_FILL_STRIDE;
    const buf = this.buffer;

    this.geometry = new Geometry({
      attributes: {
        aTri: { buffer: tri, format: 'float32x2' },
        aV0: { buffer: buf, format: 'float32x2', stride, offset: 0, instance: true },
        aV1: { buffer: buf, format: 'float32x2', stride, offset: 8, instance: true },
        aV2: { buffer: buf, format: 'float32x2', stride, offset: 16, instance: true },
        aInstXY: { buffer: buf, format: 'float32x2', stride, offset: 24, instance: true },
        aInstRotCS: { buffer: buf, format: 'float32x2', stride, offset: 32, instance: true },
        aInstTintBits: { buffer: buf, format: 'float32', stride, offset: 40, instance: true },
        aInstDepth: { buffer: buf, format: 'float32', stride, offset: 44, instance: true },
      },
    });
    this.geometry.instanceCount = 0;

    const name = label || 'collider-fill';
    if (useWebGpu) {
      const gpuProgram = colliderFillGpuProgram(GpuProgram, shaders?.colliderFill, name);
      this.shader = new Shader({ gpuProgram, resources: {} });
    } else {
      const glProgram = colliderFillGlProgram(
        GlProgram,
        shaders?.colliderFillVert,
        shaders?.colliderFillFrag,
        name
      );
      this.shader = new Shader({ glProgram, resources: {} });
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

  /**
   * @param {number} count packed instances already written into this.data
   * @returns {number}
   */
  upload(count) {
    const n = count | 0;
    if (n <= 0) {
      this.geometry.instanceCount = 0;
      this.mesh.visible = false;
      return 0;
    }
    this.mesh.visible = true;
    this.buffer.update(n * COLLIDER_FILL_STRIDE);
    this.geometry.instanceCount = n;
    return n;
  }
}
