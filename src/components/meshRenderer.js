// MeshRenderer — LAYER_KIND.MESH draw.
// Explicit setMesh geometry wins. Otherwise the collider (fixtures or primary shape).
// Color, atlas tile, and visual outset live here. Pose is Transform + local verts.
// visualOutset applies to the collider fill only.

import { Component } from '../core/component.js';
import { MeshGeometry } from '../core/meshGeometry.js';
import { SpriteSheetRegistry } from '../core/spriteSheetRegistry.js';
import { SPRITE_TILE_MODE } from '../util/configDefaults.js';
import { triangulateSimplePolygon } from '../render/meshTriangulate.js';
import { packTileOffset01, unpackTileOffset01 } from './spriteRenderer.js';

/** Stored in textureId: no atlas sample, solid tint. Anim 0 is a valid texture. */
export const MESH_NO_TEXTURE = 0xffff;

let _warnedDrawable = false;

export function resetMeshRendererFixtureWarn() {
  _warnedDrawable = false;
}

export function resetMeshRendererDrawableWarn() {
  _warnedDrawable = false;
}

/** Once: MeshRenderer is on but the collider has nothing to fill. */
export function warnMeshRendererNeedsDrawableCollider() {
  if (_warnedDrawable) return;
  _warnedDrawable = true;
  console.warn(
    'WeedJS: MeshRenderer has no drawable collider (fixtures or primary box/circle/polygon)',
  );
}

/** @deprecated use warnMeshRendererNeedsDrawableCollider */
export function warnMeshRendererNeedsFixtures() {
  warnMeshRendererNeedsDrawableCollider();
}

let _pointXY = null;
let _ropeDist = null;

function pointScratch(nFloats) {
  const n = nFloats | 0;
  if (!_pointXY || _pointXY.length < n) _pointXY = new Float32Array(n);
  return _pointXY;
}

/** Flat x,y or {x,y}[]. Returns vertex count, or -1 when a value is not finite. */
function copyPointList(points) {
  if (!points || points.length == null) return 0;
  const p0 = points[0];
  if (p0 != null && typeof p0 === 'object') {
    const n = points.length | 0;
    const dst = pointScratch(n * 2);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      if (!p) return -1;
      const x = +p.x;
      const y = +p.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
      dst[i * 2] = x;
      dst[i * 2 + 1] = y;
    }
    return n;
  }
  const floats = points.length | 0;
  if (floats < 2 || (floats & 1)) return -1;
  const n = floats >> 1;
  const dst = pointScratch(floats);
  for (let i = 0; i < floats; i++) {
    const v = +points[i];
    if (!Number.isFinite(v)) return -1;
    dst[i] = v;
  }
  return n;
}

function resolveMeshTextureId(name) {
  if (!name) return MESH_NO_TEXTURE;
  const atlas = SpriteSheetRegistry.spritesheets?.get?.('bigAtlas');
  const anim = atlas?.animations?.[name];
  if (anim && anim.index != null) return anim.index | 0;
  const decal = SpriteSheetRegistry.decalFrameNameToId;
  if (decal && decal[name] !== undefined) return decal[name] | 0;
  console.warn(`MeshRenderer.setTexture: "${name}" not found`);
  return MESH_NO_TEXTURE;
}

function bumpPaintEpoch() {
  const ep = MeshRenderer.paintEpoch;
  if (ep) ep[0] = (ep[0] + 1) >>> 0;
}

function markPaint(i) {
  if (MeshRenderer.renderDirty[i]) return;
  MeshRenderer.renderDirty[i] = 1;
  bumpPaintEpoch();
}

export class MeshRenderer extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array,
    tint: Uint32Array,
    alpha: Float32Array,
    layerMask: Uint16Array,
    renderVisible: Uint8Array,
    renderDirty: Uint8Array,
    textureId: Uint16Array,
    tileMode: Uint8Array,
    repeatX: Uint16Array,
    repeatY: Uint16Array,
    tileOffsetU: Uint16Array,
    tileOffsetV: Uint16Array,
    visualOutset: Float32Array,
  };

  static getBufferSize(count) {
    return super.getBufferSize(count) + 4;
  }

  static initializeArrays(buffer, count) {
    super.initializeArrays(buffer, count);
    if (this.layerMask) this.layerMask.fill(0);
    if (this.tint) this.tint.fill(0xffffff);
    if (this.alpha) this.alpha.fill(1);
    if (this.renderVisible) this.renderVisible.fill(1);
    if (this.renderDirty) this.renderDirty.fill(1);
    if (this.textureId) this.textureId.fill(MESH_NO_TEXTURE);
    this.paintEpoch = new Uint32Array(buffer, super.getBufferSize(count), 1);
  }

  static clearArrays() {
    super.clearArrays();
    this.paintEpoch = null;
  }

  get tint() {
    return MeshRenderer.tint[this.index] >>> 0;
  }
  set tint(value) {
    const v = value >>> 0;
    if (MeshRenderer.tint[this.index] === v) return;
    MeshRenderer.tint[this.index] = v;
    markPaint(this.index);
  }

  get alpha() {
    return MeshRenderer.alpha[this.index];
  }
  set alpha(value) {
    let a = +value;
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    if (MeshRenderer.alpha[this.index] === a) return;
    MeshRenderer.alpha[this.index] = a;
    markPaint(this.index);
  }

  get textureId() {
    return MeshRenderer.textureId[this.index];
  }
  set textureId(value) {
    const v = value & 0xffff;
    if (MeshRenderer.textureId[this.index] === v) return;
    MeshRenderer.textureId[this.index] = v;
    markPaint(this.index);
  }

  get tileMode() {
    return MeshRenderer.tileMode[this.index];
  }
  set tileMode(value) {
    const v = value & 255;
    if (MeshRenderer.tileMode[this.index] === v) return;
    MeshRenderer.tileMode[this.index] = v;
    markPaint(this.index);
  }

  get repeatX() {
    return MeshRenderer.repeatX[this.index];
  }
  set repeatX(value) {
    const v = value | 0;
    const n = v < 0 ? 0 : v > 65535 ? 65535 : v;
    if (MeshRenderer.repeatX[this.index] === n) return;
    MeshRenderer.repeatX[this.index] = n;
    markPaint(this.index);
  }

  get repeatY() {
    return MeshRenderer.repeatY[this.index];
  }
  set repeatY(value) {
    const v = value | 0;
    const n = v < 0 ? 0 : v > 65535 ? 65535 : v;
    if (MeshRenderer.repeatY[this.index] === n) return;
    MeshRenderer.repeatY[this.index] = n;
    markPaint(this.index);
  }

  get tileOffsetU() {
    return unpackTileOffset01(MeshRenderer.tileOffsetU[this.index]);
  }
  set tileOffsetU(value) {
    const p = packTileOffset01(value);
    if (MeshRenderer.tileOffsetU[this.index] === p) return;
    MeshRenderer.tileOffsetU[this.index] = p;
    markPaint(this.index);
  }

  get tileOffsetV() {
    return unpackTileOffset01(MeshRenderer.tileOffsetV[this.index]);
  }
  set tileOffsetV(value) {
    const p = packTileOffset01(value);
    if (MeshRenderer.tileOffsetV[this.index] === p) return;
    MeshRenderer.tileOffsetV[this.index] = p;
    markPaint(this.index);
  }

  get visualOutset() {
    return MeshRenderer.visualOutset[this.index];
  }
  set visualOutset(value) {
    let v = +value;
    if (!(v > 0)) v = 0;
    if (MeshRenderer.visualOutset[this.index] === v) return;
    MeshRenderer.visualOutset[this.index] = v;
    markPaint(this.index);
  }

  /**
   * Atlas animation / simple texture. Falsy name clears to solid tint.
   * @param {string|null|undefined} name
   * @returns {this}
   */
  setTexture(name) {
    const id = resolveMeshTextureId(name);
    if (MeshRenderer.textureId[this.index] === id) return this;
    MeshRenderer.textureId[this.index] = id;
    markPaint(this.index);
    return this;
  }

  /**
   * Local triangle mesh. `indices` null fans from vertex 0 (convex).
   * `uvs` null keeps tile / stretch sampling. Replaces any collider fill.
   * @param {ArrayLike<number>} positions flat x,y
   * @param {ArrayLike<number>|null} [indices]
   * @param {ArrayLike<number>|null} [uvs]
   * @returns {this}
   */
  setMesh(positions, indices, uvs) {
    MeshGeometry.replace(this.index, positions, indices || null, uvs || null);
    return this;
  }

  /**
   * Rewrite local positions. Count must match the current mesh.
   * @param {ArrayLike<number>} positions flat x,y
   * @returns {this}
   */
  setVertices(positions) {
    MeshGeometry.writeVertices(this.index, positions);
    return this;
  }

  /** Drop the explicit mesh and fall back to collider fill. */
  clearMesh() {
    MeshGeometry.clearEntity(this.index);
    return this;
  }

  /**
   * Subdivided quad centered on the local origin, UVs 0..1.
   * segX / segY are cell counts (at least 1).
   * @returns {this}
   */
  setPlane(width, height, segX, segY) {
    const w = +width;
    const h = +height;
    let sx = segX | 0;
    let sy = segY | 0;
    if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return this;
    if (sx < 1) sx = 1;
    if (sy < 1) sy = 1;
    if (sx > 254) sx = 254;
    if (sy > 254) sy = 254;
    const vx = sx + 1;
    const vy = sy + 1;
    const vertN = vx * vy;
    if (vertN > 65535) return this;
    const pos = MeshGeometry.scratchXY(vertN * 2);
    const uv = MeshGeometry.scratchUV(vertN * 2);
    const idx = MeshGeometry.scratchIdx(sx * sy * 6);
    const x0 = -w * 0.5;
    const y0 = -h * 0.5;
    for (let j = 0; j < vy; j++) {
      const v = j / sy;
      const y = y0 + h * v;
      for (let i = 0; i < vx; i++) {
        const u = i / sx;
        const p = j * vx + i;
        pos[p * 2] = x0 + w * u;
        pos[p * 2 + 1] = y;
        uv[p * 2] = u;
        uv[p * 2 + 1] = v;
      }
    }
    let wri = 0;
    for (let j = 0; j < sy; j++) {
      for (let i = 0; i < sx; i++) {
        const a = j * vx + i;
        const b = a + 1;
        const c = a + vx;
        const d = c + 1;
        idx[wri++] = a;
        idx[wri++] = b;
        idx[wri++] = d;
        idx[wri++] = a;
        idx[wri++] = d;
        idx[wri++] = c;
      }
    }
    MeshGeometry.replace(
      this.index,
      pos.subarray(0, vertN * 2),
      idx.subarray(0, wri),
      uv.subarray(0, vertN * 2),
    );
    return this;
  }

  /**
   * Strip through control points. `points` is flat x,y or `{x,y}[]`.
   * @param {ArrayLike<number>|Array<{x:number,y:number}>} points
   * @param {number} halfWidth
   * @returns {this}
   */
  setRope(points, halfWidth) {
    const hw = +halfWidth;
    if (!(hw > 0) || !Number.isFinite(hw)) return this;
    const n = copyPointList(points);
    if (n < 2) return this;
    const src = _pointXY;
    const vertN = n * 2;
    const pos = MeshGeometry.scratchXY(vertN * 2);
    const uv = MeshGeometry.scratchUV(vertN * 2);
    const idx = MeshGeometry.scratchIdx((n - 1) * 6);
    if (!_ropeDist || _ropeDist.length < n) _ropeDist = new Float32Array(n);
    const dist = _ropeDist;
    let total = 0;
    dist[0] = 0;
    for (let i = 1; i < n; i++) {
      const dx = src[i * 2] - src[(i - 1) * 2];
      const dy = src[i * 2 + 1] - src[(i - 1) * 2 + 1];
      total += Math.hypot(dx, dy);
      dist[i] = total;
    }
    if (!(total > 0)) return this;
    for (let i = 0; i < n; i++) {
      let dx;
      let dy;
      if (i === 0) {
        dx = src[2] - src[0];
        dy = src[3] - src[1];
      } else if (i === n - 1) {
        dx = src[i * 2] - src[(i - 1) * 2];
        dy = src[i * 2 + 1] - src[(i - 1) * 2 + 1];
      } else {
        dx = src[(i + 1) * 2] - src[(i - 1) * 2];
        dy = src[(i + 1) * 2 + 1] - src[(i - 1) * 2 + 1];
      }
      const len = Math.hypot(dx, dy);
      const nx = len < 1e-8 ? 0 : -dy / len;
      const ny = len < 1e-8 ? 1 : dx / len;
      const x = src[i * 2];
      const y = src[i * 2 + 1];
      const L = i * 2;
      const R = L + 1;
      pos[L * 2] = x + nx * hw;
      pos[L * 2 + 1] = y + ny * hw;
      pos[R * 2] = x - nx * hw;
      pos[R * 2 + 1] = y - ny * hw;
      const u = dist[i] / total;
      uv[L * 2] = u;
      uv[L * 2 + 1] = 0;
      uv[R * 2] = u;
      uv[R * 2 + 1] = 1;
    }
    let wri = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      idx[wri++] = a;
      idx[wri++] = c;
      idx[wri++] = b;
      idx[wri++] = b;
      idx[wri++] = c;
      idx[wri++] = d;
    }
    MeshGeometry.replace(
      this.index,
      pos.subarray(0, vertN * 2),
      idx.subarray(0, wri),
      uv.subarray(0, vertN * 2),
    );
    return this;
  }

  /**
   * Simple outline, ear-clipped once. No holes. Tile / stretch UVs.
   * @param {ArrayLike<number>|Array<{x:number,y:number}>} points
   * @returns {this}
   */
  setPolygon(points) {
    const n = copyPointList(points);
    if (n < 3) return this;
    const xy = _pointXY;
    const idx = MeshGeometry.scratchIdx((n - 2) * 3);
    const ic = triangulateSimplePolygon(xy, n, idx);
    if (ic < 0) {
      MeshGeometry.warnPolygon();
      return this;
    }
    MeshGeometry.replace(this.index, xy.subarray(0, n * 2), idx.subarray(0, ic), null);
    return this;
  }

  static packTileOffset01 = packTileOffset01;
  static unpackTileOffset01 = unpackTileOffset01;
  static TILE_MODE = SPRITE_TILE_MODE;
  static NO_TEXTURE = MESH_NO_TEXTURE;
}
