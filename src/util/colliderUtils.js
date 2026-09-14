// ColliderUtils.js - Utilities for collider cell calculations
//
// PERFORMANCE NOTES:
// - Zero allocations: Uses pre-allocated result objects (safe in single-threaded workers)
// - Caller should pre-compute invariants (invCellSize, maxCol, maxRow) outside loops
// - For ultra-hot paths (every frame, thousands of entities), inline the math instead

import { Transform } from '../components/Transform.js';
import { Collider } from '../components/Collider.js';
import { MAX_POLYGON_VERTICES, ShapeType } from './ConfigDefaults.js';

/**
 * Shape type constants — aliases for ShapeType (Box2D / WASM C numbers).
 */
export { ShapeType };
export const SHAPE_BOX = ShapeType.Box;
export const SHAPE_CIRCLE = ShapeType.Circle;
export const SHAPE_POLYGON = ShapeType.Polygon;

/**
 * Pre-allocated result objects for zero-GC operations
 * Safe to reuse since workers are single-threaded
 */
export const _boundsResult = { posX: 0, posY: 0, halfW: 0, halfH: 0 };
export const _cellRangeResult = { minCol: 0, maxCol: 0, minRow: 0, maxRow: 0 };

/**
 * Get collider bounds (position and half-extents) for an entity
 * ZERO ALLOCATION - mutates result object
 *
 * Circle / AABB Box: offset added axis-aligned.
 * Polygon: offset rotated; half-extents = AABB of transformed local verts (+ skin radius).
 *
 * @param {number} idx - Entity index
 * @param {Object} result - Result object to mutate {posX, posY, halfW, halfH}
 * @returns {Object} The result object
 */
export function getColliderBounds(idx, result) {
  const shape = Collider.shapeType[idx];
  const ox = Collider.offsetX[idx] || 0;
  const oy = Collider.offsetY[idx] || 0;
  const tx = Transform.x[idx];
  const ty = Transform.y[idx];

  if (shape === SHAPE_CIRCLE) {
    result.posX = tx + ox;
    result.posY = ty + oy;
    const r = Collider.radius[idx] || 0;
    result.halfW = r;
    result.halfH = r;
  } else if (shape === SHAPE_POLYGON) {
    const c = Transform.rotC ? Transform.rotC[idx] : 1;
    const s = Transform.rotS ? Transform.rotS[idx] : 0;
    const originX = tx + c * ox - s * oy;
    const originY = ty + s * ox + c * oy;

    const count = Collider.polyCount[idx];
    const skin = Collider.radius[idx] || 0;
    if (count >= 3) {
      const base = idx * MAX_POLYGON_VERTICES;
      const vx = Collider.polyVertexX;
      const vy = Collider.polyVertexY;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < count; i++) {
        const lx = vx[base + i];
        const ly = vy[base + i];
        const wx = originX + c * lx - s * ly;
        const wy = originY + s * lx + c * ly;
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
      }
      result.posX = (minX + maxX) * 0.5;
      result.posY = (minY + maxY) * 0.5;
      result.halfW = (maxX - minX) * 0.5 + skin;
      result.halfH = (maxY - minY) * 0.5 + skin;
    } else {
      result.posX = originX;
      result.posY = originY;
      const hw = (Collider.width[idx] || 0) * 0.5;
      const hh = (Collider.height[idx] || 0) * 0.5;
      const ac = c < 0 ? -c : c;
      const as = s < 0 ? -s : s;
      result.halfW = ac * hw + as * hh + skin;
      result.halfH = as * hw + ac * hh + skin;
    }
  } else {
    // Box — world AABB of oriented width×height (Box2D rotates boxes)
    const c = Transform.rotC ? Transform.rotC[idx] : 1;
    const s = Transform.rotS ? Transform.rotS[idx] : 0;
    result.posX = tx + c * ox - s * oy;
    result.posY = ty + s * ox + c * oy;
    const hw = (Collider.width[idx] || 0) * 0.5;
    const hh = (Collider.height[idx] || 0) * 0.5;
    const ac = c < 0 ? -c : c;
    const as = s < 0 ? -s : s;
    result.halfW = ac * hw + as * hh;
    result.halfH = as * hw + ac * hh;
  }

  return result;
}

/**
 * Point-in-collider test (zero alloc). Circle / OBB box / convex polygon.
 * Polygon skin radius is ignored (exact convex hull).
 *
 * @param {number} idx - Entity index
 * @param {number} x - World X
 * @param {number} y - World Y
 * @returns {boolean}
 */
export function pointInCollider(idx, x, y) {
  if (!Collider.active || !Collider.active[idx]) return false;

  const shape = Collider.shapeType[idx];
  const ox = Collider.offsetX[idx] || 0;
  const oy = Collider.offsetY[idx] || 0;
  const tx = Transform.x[idx];
  const ty = Transform.y[idx];

  if (shape === SHAPE_CIRCLE) {
    const r = Collider.radius[idx] || 0;
    if (!(r > 0)) return false;
    const dx = x - (tx + ox);
    const dy = y - (ty + oy);
    return dx * dx + dy * dy <= r * r;
  }

  const c = Transform.rotC ? Transform.rotC[idx] : 1;
  const s = Transform.rotS ? Transform.rotS[idx] : 0;
  const originX = tx + c * ox - s * oy;
  const originY = ty + s * ox + c * oy;
  const wx = x - originX;
  const wy = y - originY;
  const lx = c * wx + s * wy;
  const ly = -s * wx + c * wy;

  if (shape === SHAPE_POLYGON) {
    const count = Collider.polyCount[idx] | 0;
    if (count < 3) return false;
    const base = idx * MAX_POLYGON_VERTICES;
    const vx = Collider.polyVertexX;
    const vy = Collider.polyVertexY;
    let sign = 0;
    for (let i = 0; i < count; i++) {
      const x0 = vx[base + i];
      const y0 = vy[base + i];
      const i1 = (i + 1) % count;
      const x1 = vx[base + i1];
      const y1 = vy[base + i1];
      const cross = (x1 - x0) * (ly - y0) - (y1 - y0) * (lx - x0);
      if (cross === 0) continue;
      const next = cross > 0 ? 1 : -1;
      if (sign === 0) sign = next;
      else if (next !== sign) return false;
    }
    return sign !== 0;
  }

  const hw = (Collider.width[idx] || 0) * 0.5;
  const hh = (Collider.height[idx] || 0) * 0.5;
  if (!(hw > 0 && hh > 0)) return false;
  return lx <= hw && lx >= -hw && ly <= hh && ly >= -hh;
}

/**
 * Calculate cell range from position and half-extents
 * ZERO ALLOCATION - mutates result object
 *
 * Pure math function - no component dependencies
 * Can be inlined in hot paths if function call overhead matters
 *
 * @param {number} posX - Center X position
 * @param {number} posY - Center Y position
 * @param {number} halfW - Half width (or radius for circles)
 * @param {number} halfH - Half height (or radius for circles)
 * @param {number} invCellSize - 1/cellSize (pre-compute outside loops!)
 * @param {number} maxCol - gridCols - 1 (pre-compute outside loops!)
 * @param {number} maxRow - gridRows - 1 (pre-compute outside loops!)
 * @param {Object} result - Result object {minCol, maxCol, minRow, maxRow}
 * @returns {Object} The result object
 */
export function getCellRange(posX, posY, halfW, halfH, invCellSize, maxCol, maxRow, result) {
  // Fast floor using bitwise OR (only works for positive numbers, which grid coords are)
  let minCol = ((posX - halfW) * invCellSize) | 0;
  let maxColVal = ((posX + halfW) * invCellSize) | 0;
  let minRow = ((posY - halfH) * invCellSize) | 0;
  let maxRowVal = ((posY + halfH) * invCellSize) | 0;

  // Clamp to grid bounds (branchless using ternary)
  result.minCol = minCol < 0 ? 0 : minCol > maxCol ? maxCol : minCol;
  result.maxCol = maxColVal < 0 ? 0 : maxColVal > maxCol ? maxCol : maxColVal;
  result.minRow = minRow < 0 ? 0 : minRow > maxRow ? maxRow : minRow;
  result.maxRow = maxRowVal < 0 ? 0 : maxRowVal > maxRow ? maxRow : maxRowVal;

  return result;
}
