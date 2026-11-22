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
import { SETTER_ARGS as SETTER_ARGSImport, SETTER_ARGS64 as SETTER_ARGS64Import } from '../core/setterArgs.js';

// E-474: the setters' double hand-over as module consts, not imports (setterArgs.js is outside this module's cycle).
const SETTER_ARGS = SETTER_ARGSImport;
const SETTER_ARGS64 = SETTER_ARGS64Import;

/** Stored in textureId: no atlas sample, solid tint. Anim 0 is a valid texture. */
export const MESH_NO_TEXTURE = 0xffff;

let _warnedDrawable = false;
let _warnedVolume = false;

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

export function resolveMeshTextureId(name) {
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

function bumpOutsetEpoch() {
  const ep = MeshRenderer.outsetEpoch;
  if (ep) ep[0] = (ep[0] + 1) >>> 0;
}

function markPaint(i) {
  if (MeshRenderer.renderDirty[i]) return;
  MeshRenderer.renderDirty[i] = 1;
  bumpPaintEpoch();
}

/** This entity's row needs packing again: a column the row reads changed. */
export const markMeshPaint = markPaint;

/** MeshGeometry holds one mesh an entity, and while its ShadowCaster holds a volume it is the volume's (DX-VOLUME). */
function heldByVolume(i) {
  const held = MeshRenderer.volumeColumn;
  if (held === null || !(held[i] > 0)) return false;
  if (!_warnedVolume) {
    _warnedVolume = true;
    console.warn(
      'WeedJS: an entity whose ShadowCaster holds a volume (setBox, addLevel, setHull) has no mesh of its own to set: its one ' +
        'mesh is the volume',
    );
  }
  return true;
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

  /** VolumeShadowCaster.floorScaleY while that column is bound (a scene with lighting.maxVolumes): above 0 where the mesh is a volume. */
  static volumeColumn = null;

  static getBufferSize(count) {
    return super.getBufferSize(count) + 8;
  }

  static initializeArrays(buffer, count, byteOffset = 0) {
    super.initializeArrays(buffer, count, byteOffset);
    if (this.layerMask) this.layerMask.fill(0);
    if (this.tint) this.tint.fill(0xffffff);
    if (this.alpha) this.alpha.fill(1);
    if (this.renderVisible) this.renderVisible.fill(1);
    if (this.renderDirty) this.renderDirty.fill(1);
    if (this.textureId) this.textureId.fill(MESH_NO_TEXTURE);
    const tail = byteOffset + super.getBufferSize(count);
    this.paintEpoch = new Uint32Array(buffer, tail, 1);
    this.outsetEpoch = new Uint32Array(buffer, tail + 4, 1);
  }

  static clearArrays() {
    super.clearArrays();
    this.paintEpoch = null;
    this.outsetEpoch = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // E-537: the mesh's setters and methods by entity index (MeshRenderer.setTint(i, v) is meshRenderer.tint = v), for
  // code that holds an index and no instance. A setter and its static call the same work (the ...At functions below the
  // class); a double goes through SETTER_ARGS (SETTER_ARGS64 where it is computed with), so the work takes ints only.
  // The statics return nothing.
  // ═══════════════════════════════════════════════════════════════════════════

  /** Entity i's mesh tint, 0xRRGGBB (meshRenderer.tint). */
  static setTint(i, tint) {
    tintAt(i, tint >>> 0);
  }

  /** Entity i's mesh alpha, clamped to 0-1 (meshRenderer.alpha). */
  static setAlpha(i, alpha) {
    SETTER_ARGS64[0] = alpha;
    alphaAt(i);
  }

  /** Entity i's mesh texture by its atlas id, MESH_NO_TEXTURE for a solid tint (meshRenderer.textureId). */
  static setTextureId(i, textureId) {
    textureIdAt(i, textureId & 0xffff);
  }

  /** Entity i's mesh texture by name; a falsy name clears it to a solid tint (meshRenderer.setTexture). */
  static setTexture(i, name) {
    textureIdAt(i, resolveMeshTextureId(name));
  }

  /** Entity i's mesh SPRITE_TILE_MODE (meshRenderer.tileMode). */
  static setTileMode(i, mode) {
    tileModeAt(i, mode & 255);
  }

  /** Entity i's world px per texture repeat across, 0 (stretch) to 65535 (meshRenderer.repeatX). */
  static setRepeatX(i, value) {
    repeatXAt(i, value | 0);
  }

  /** Entity i's world px per texture repeat down (meshRenderer.repeatY). */
  static setRepeatY(i, value) {
    repeatYAt(i, value | 0);
  }

  /** Entity i's tile phase across, its fraction 0..1 (meshRenderer.tileOffsetU). */
  static setTileOffsetU(i, value) {
    tileOffsetUAt(i, packTileOffset01(value));
  }

  /** Entity i's tile phase down, its fraction 0..1 (meshRenderer.tileOffsetV). */
  static setTileOffsetV(i, value) {
    tileOffsetVAt(i, packTileOffset01(value));
  }

  /** How far entity i's collider fill grows past its shape, px, 0 or more (meshRenderer.visualOutset). */
  static setVisualOutset(i, value) {
    SETTER_ARGS[0] = value;
    visualOutsetAt(i);
  }

  /** Entity i's local triangle mesh (meshRenderer.setMesh): positions flat x,y; indices null fans from vertex 0. */
  static setMesh(i, positions, indices, uvs) {
    setMeshAt(i, positions, indices, uvs);
  }

  /** Entity i's mesh positions rewritten, the same count (meshRenderer.setVertices). */
  static setVertices(i, positions) {
    setVerticesAt(i, positions);
  }

  /** Entity i's vertex heights for a sunProjected layer, one per vertex (meshRenderer.setHeights). */
  static setHeights(i, heights) {
    setHeightsAt(i, heights);
  }

  /** Entity i's explicit mesh dropped: its collider fills again (meshRenderer.clearMesh). */
  static clearMesh(i) {
    clearMeshAt(i);
  }

  /** Entity i's mesh a subdivided quad centred on its origin, UVs 0..1 (meshRenderer.setPlane). */
  static setPlane(i, width, height, segX, segY) {
    SETTER_ARGS64[0] = width;
    SETTER_ARGS64[1] = height;
    setPlaneAt(i, segX, segY);
  }

  /** Entity i's mesh a strip through control points, flat x,y or {x,y}[] (meshRenderer.setRope). */
  static setRope(i, points, halfWidth) {
    SETTER_ARGS64[0] = halfWidth;
    setRopeAt(i, points);
  }

  /** Entity i's mesh a simple outline, ear-clipped once (meshRenderer.setPolygon). */
  static setPolygon(i, points) {
    setPolygonAt(i, points);
  }

  get tint() {
    return MeshRenderer.tint[this.index] >>> 0;
  }
  set tint(value) {
    tintAt(this.index, value >>> 0);
  }

  get alpha() {
    return MeshRenderer.alpha[this.index];
  }
  set alpha(value) {
    SETTER_ARGS64[0] = value;
    alphaAt(this.index);
  }

  get textureId() {
    return MeshRenderer.textureId[this.index];
  }
  set textureId(value) {
    textureIdAt(this.index, value & 0xffff);
  }

  get tileMode() {
    return MeshRenderer.tileMode[this.index];
  }
  set tileMode(value) {
    tileModeAt(this.index, value & 255);
  }

  get repeatX() {
    return MeshRenderer.repeatX[this.index];
  }
  set repeatX(value) {
    repeatXAt(this.index, value | 0);
  }

  get repeatY() {
    return MeshRenderer.repeatY[this.index];
  }
  set repeatY(value) {
    repeatYAt(this.index, value | 0);
  }

  get tileOffsetU() {
    return unpackTileOffset01(MeshRenderer.tileOffsetU[this.index]);
  }
  set tileOffsetU(value) {
    tileOffsetUAt(this.index, packTileOffset01(value));
  }

  get tileOffsetV() {
    return unpackTileOffset01(MeshRenderer.tileOffsetV[this.index]);
  }
  set tileOffsetV(value) {
    tileOffsetVAt(this.index, packTileOffset01(value));
  }

  get visualOutset() {
    return MeshRenderer.visualOutset[this.index];
  }
  set visualOutset(value) {
    SETTER_ARGS[0] = value;
    visualOutsetAt(this.index);
  }

  /**
   * Atlas animation / simple texture. Falsy name clears to solid tint.
   * @param {string|null|undefined} name
   * @returns {this}
   */
  setTexture(name) {
    textureIdAt(this.index, resolveMeshTextureId(name));
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
    setMeshAt(this.index, positions, indices, uvs);
    return this;
  }

  /**
   * Rewrite local positions. Count must match the current mesh.
   * @param {ArrayLike<number>} positions flat x,y
   * @returns {this}
   */
  setVertices(positions) {
    setVerticesAt(this.index, positions);
    return this;
  }

  /**
   * Height of each vertex, in screen px, on a `sunProjected` layer: the sun moves a vertex as far as it moves the point
   * that high on a ShadowCaster's sprite. Call after setMesh, with one height per vertex; setMesh without UVs drops them.
   * @param {ArrayLike<number>} heights
   * @returns {this}
   */
  setHeights(heights) {
    setHeightsAt(this.index, heights);
    return this;
  }

  /** Drop the explicit mesh and fall back to collider fill. */
  clearMesh() {
    clearMeshAt(this.index);
    return this;
  }

  /**
   * Subdivided quad centered on the local origin, UVs 0..1.
   * segX / segY are cell counts (at least 1; at most 254, or 1023 when renderer.maxMeshVerts passes 65535).
   * @returns {this}
   */
  setPlane(width, height, segX, segY) {
    SETTER_ARGS64[0] = width;
    SETTER_ARGS64[1] = height;
    setPlaneAt(this.index, segX, segY);
    return this;
  }

  /**
   * Strip through control points. `points` is flat x,y or `{x,y}[]`.
   * @param {ArrayLike<number>|Array<{x:number,y:number}>} points
   * @param {number} halfWidth
   * @returns {this}
   */
  setRope(points, halfWidth) {
    SETTER_ARGS64[0] = halfWidth;
    setRopeAt(this.index, points);
    return this;
  }

  /**
   * Simple outline, ear-clipped once. No holes. Tile / stretch UVs.
   * @param {ArrayLike<number>|Array<{x:number,y:number}>} points
   * @returns {this}
   */
  setPolygon(points) {
    setPolygonAt(this.index, points);
    return this;
  }

  static packTileOffset01 = packTileOffset01;
  static unpackTileOffset01 = unpackTileOffset01;
  static TILE_MODE = SPRITE_TILE_MODE;
  static NO_TEXTURE = MESH_NO_TEXTURE;
}

// ═══════════════════════════════════════════════════════════════════════════
// E-537: the mesh's work by entity index, for its setters and its statics. Ints only: a double is read from
// SETTER_ARGS (float32, what its column holds) or SETTER_ARGS64 (computed with, or clamped before it is rounded), first.
// ═══════════════════════════════════════════════════════════════════════════

/** tint: v a uint32; the same tint again marks nothing. */
function tintAt(i, v) {
  if (MeshRenderer.tint[i] === v) return;
  MeshRenderer.tint[i] = v;
  markPaint(i);
}

/**
 * alpha: in SETTER_ARGS64[0], clamped to 0-1 before the column rounds it (a tiny negative is 0, not -0); the same alpha
 * again marks nothing.
 */
function alphaAt(i) {
  let a = SETTER_ARGS64[0];
  if (a < 0) a = 0;
  else if (a > 1) a = 1;
  if (MeshRenderer.alpha[i] === Math.fround(a)) return;
  MeshRenderer.alpha[i] = a;
  markPaint(i);
}

/** textureId and setTexture: v a uint16. */
function textureIdAt(i, v) {
  if (MeshRenderer.textureId[i] === v) return;
  MeshRenderer.textureId[i] = v;
  markPaint(i);
}

/** tileMode: v a uint8. */
function tileModeAt(i, v) {
  if (MeshRenderer.tileMode[i] === v) return;
  MeshRenderer.tileMode[i] = v;
  markPaint(i);
}

/** repeatX: v an int, clamped to 0..65535. */
function repeatXAt(i, v) {
  const n = v < 0 ? 0 : v > 65535 ? 65535 : v;
  if (MeshRenderer.repeatX[i] === n) return;
  MeshRenderer.repeatX[i] = n;
  markPaint(i);
}

/** repeatY: v an int, clamped to 0..65535. */
function repeatYAt(i, v) {
  const n = v < 0 ? 0 : v > 65535 ? 65535 : v;
  if (MeshRenderer.repeatY[i] === n) return;
  MeshRenderer.repeatY[i] = n;
  markPaint(i);
}

/** tileOffsetU: p packed (packTileOffset01). */
function tileOffsetUAt(i, p) {
  if (MeshRenderer.tileOffsetU[i] === p) return;
  MeshRenderer.tileOffsetU[i] = p;
  markPaint(i);
}

/** tileOffsetV: p packed (packTileOffset01). */
function tileOffsetVAt(i, p) {
  if (MeshRenderer.tileOffsetV[i] === p) return;
  MeshRenderer.tileOffsetV[i] = p;
  markPaint(i);
}

/** visualOutset: in SETTER_ARGS[0], 0 when not above 0; the outset epoch moves. */
function visualOutsetAt(i) {
  let v = SETTER_ARGS[0];
  if (!(v > 0)) v = 0;
  if (MeshRenderer.visualOutset[i] === v) return;
  MeshRenderer.visualOutset[i] = v;
  bumpOutsetEpoch();
}

function setMeshAt(i, positions, indices, uvs) {
  if (heldByVolume(i)) return;
  MeshGeometry.replace(i, positions, indices || null, uvs || null);
}

function setVerticesAt(i, positions) {
  if (heldByVolume(i)) return;
  MeshGeometry.writeVertices(i, positions);
}

function setHeightsAt(i, heights) {
  if (heldByVolume(i)) return;
  MeshGeometry.writeHeights(i, heights);
}

function clearMeshAt(i) {
  if (heldByVolume(i)) return;
  MeshGeometry.clearEntity(i);
}

/** setPlane: width and height in SETTER_ARGS64[0] and [1]. */
function setPlaneAt(entity, segX, segY) {
  const w = +SETTER_ARGS64[0];
  const h = +SETTER_ARGS64[1];
  if (heldByVolume(entity)) return;
  let sx = segX | 0;
  let sy = segY | 0;
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return;
  // E-130: the arena's width bounds the cells and the vertices.
  const segMax = MeshGeometry.planeSegments;
  if (sx < 1) sx = 1;
  if (sy < 1) sy = 1;
  if (sx > segMax) sx = segMax;
  if (sy > segMax) sy = segMax;
  const vx = sx + 1;
  const vy = sy + 1;
  const vertN = vx * vy;
  if (vertN > MeshGeometry.vertLimit) return;
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
  MeshGeometry.replace(entity, pos, idx, uv, vertN, wri);
}

/** setRope: the half width in SETTER_ARGS64[0]. */
function setRopeAt(entity, points) {
  const hw = +SETTER_ARGS64[0];
  if (heldByVolume(entity)) return;
  if (!(hw > 0) || !Number.isFinite(hw)) return;
  const n = copyPointList(points);
  if (n < 2) return;
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
    // H-03: sqrt, not Math.hypot. Overflow is unreachable for world px.
    total += Math.sqrt(dx * dx + dy * dy);
    dist[i] = total;
  }
  if (!(total > 0)) return;
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
    const len = Math.sqrt(dx * dx + dy * dy);
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
  MeshGeometry.replace(entity, pos, idx, uv, vertN, wri);
}

function setPolygonAt(i, points) {
  if (heldByVolume(i)) return;
  const n = copyPointList(points);
  if (n < 3) return;
  const xy = _pointXY;
  const idx = MeshGeometry.scratchIdx((n - 2) * 3);
  const ic = triangulateSimplePolygon(xy, n, idx, MeshGeometry.vertLimit);
  if (ic < 0) {
    MeshGeometry.warnPolygon();
    return;
  }
  MeshGeometry.replace(i, xy, idx, null, n, ic);
}
