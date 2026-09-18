/**
 * Instanced solid fill of ColliderFixture fans.
 * One PIXI.Mesh per LAYER_KIND.MESH slot. VS applies Transform pose.
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

import { MAX_POLYGON_VERTICES } from '../util/configDefaults.js';
import { colliderFillGpuProgram } from './webgpu/colliderFillWgsl.js';
import { colliderFillGlProgram } from './webgl/colliderFillGlsl.js';

export const COLLIDER_FILL_FLOATS = 12;
export const COLLIDER_FILL_STRIDE = COLLIDER_FILL_FLOATS * 4;

const INV = 0xffff;

let _warnedMeshLayer = false;

export function resetColliderFillMeshLayerWarn() {
  _warnedMeshLayer = false;
}

/**
 * Pack fixture fans for one MESH layer bit into `out`.
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
  const outU32 = views.outU32 || new Uint32Array(out.buffer, out.byteOffset, out.length);

  const bit = 1 << (layerId | 0);
  const depthDenom = maxOut + 1;
  let written = 0;
  let base = 0;

  for (let i = 0; i < entityCount; i++) {
    if (!meshActive[i] || !meshVisible[i]) continue;
    const mask = meshMask[i] | 0;
    if (!(mask & meshBits)) {
      if (!_warnedMeshLayer && (fixtureCount[i] | 0) >= 1) {
        _warnedMeshLayer = true;
        console.warn('WeedJS: MeshRenderer requires setLayer on a LAYER_KIND.MESH layer');
      }
      continue;
    }
    if (!(mask & bit)) continue;
    if ((fixtureCount[i] | 0) < 1) continue;
    if (!head) continue;

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
      const vb = cur * MAX_POLYGON_VERTICES;
      const x0 = vx[vb];
      const y0 = vy[vb];
      const fans = n - 2;
      for (let t = 0; t < fans; t++) {
        if (written >= maxOut) return written;
        const i1 = t + 1;
        const i2 = t + 2;
        out[base] = x0;
        out[base + 1] = y0;
        out[base + 2] = vx[vb + i1];
        out[base + 3] = vy[vb + i1];
        out[base + 4] = vx[vb + i2];
        out[base + 5] = vy[vb + i2];
        out[base + 6] = wx;
        out[base + 7] = wy;
        out[base + 8] = c;
        out[base + 9] = s;
        outU32[base + 10] = packed >>> 0;
        out[base + 11] = 1.0 - (written + 1) / depthDenom;
        base += COLLIDER_FILL_FLOATS;
        written++;
      }
      cur = next[cur];
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
