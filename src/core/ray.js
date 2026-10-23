// Ray.js - Raycasting system using spatial grid
// Uses DDA (Digital Differential Analyzer) to traverse only cells the ray passes through
// Uses Grid class for spatial data and utils for geometric intersections

import { Transform } from '../components/transform.js';
import { Collider } from '../components/collider.js';
import { ColliderFixture } from './colliderFixture.js';
import { Grid } from './grid.js';
import { rayPolygonIntersect } from '../util/utils.js';
import { MAX_POLYGON_VERTICES, ShapeType } from '../util/configDefaults.js';
import { ChainPoints } from './chainPoints.js';

// The ray being traced, and the hits, live in typed arrays (E-85). _traverseGrid, _castUnitDir,
// _checkCellEntities and _shapeRayDistance are too big for TurboFan to inline, and a double passed
// to a call that is not inlined, returned from one, or stored in a shared object field became a
// heap number: per ray, per cell visited and per candidate, 272 MB/s in bulletStressScene. Their
// callers write the ray into RAY and pass only integers (entity, cell, mask) and objects.
const RAY = new Float64Array(9);
const RAY_X = 0;
const RAY_Y = 1;
const RAY_DIR_X = 2; // unit direction
const RAY_DIR_Y = 3;
const RAY_LEN = 4;
const RAY_TO_X = 5; // where the traversal stops
const RAY_TO_Y = 6;
const RAY_MAX = 7; // _traverseGrid: farthest hit kept; _checkCellEntities: the closest hit so far
const RAY_SHAPE_MAX = 8; // the bound of one shape test
// Infinity for the branches that almost never run (an axis-aligned ray). The global `Infinity` in a
// branch that never ran is a load without feedback, and TurboFan then boxed the double the other
// branch computed into the same variable: four heap numbers per traversal (tMaxX, tDeltaX, ...).
const INF = Infinity;
// [entity, fixture] and the distance, per cell and per traversal; one shape's distance.
const CELL_HIT = new Int32Array(2);
const CELL_HIT_DIST = new Float64Array(1);
const TRAVERSE_HIT = new Int32Array(2);
const TRAVERSE_DIST = new Float64Array(1);
const SHAPE_DIST = new Float64Array(1);

/** castAll: the farthest of the hits it keeps, or -1 before the first. */
const TOP_FAR = new Float64Array(1);

/**
 * Ray - Static class for raycasting against entities in the spatial grid
 *
 * All methods accept an optional `mask` parameter (Uint32 bitmask, default 0xFFFFFFFF).
 * Only entities whose collisionLayer bit is set in the mask are considered.
 * Object/array-returning methods use borrowed static results by default; pass
 * the optional `out` argument when you need to keep a result across later Ray calls.
 *
 * Methods:
 *   - cast(x1, y1, x2, y2, maxDist, mask)              → entityIndex or -1
 *   - castDir(x, y, dirX, dirY, maxDist, mask)         → entityIndex or -1 (unit dir; skip sqrt)
 *   - castWithInfo(x1, y1, x2, y2, maxDist, mask, out, exclude)  → { hit, entityIndex, distance, hitX, hitY }
 *   - castAll(x1, y1, x2, y2, maxDist, maxHits, mask, out) → Array<{ entityIndex, distance, hitX, hitY }>
 *   - linecast(x1, y1, x2, y2, exclude, mask, out)      → { blocked, entityIndex, distance }
 *   - linecastDir(x1, y1, dirX, dirY, len, exclude, mask, out) → same; skip sqrt when dir is unit
 *   - linecastBetweenEntities(a, b, mask, out)           → { blocked, entityIndex, distance }
 *   - hasLineOfSight(a, b, mask)                         → boolean (true if clear)
 *   - getLineOfSightInfo(a, b, mask, out)                → { blocked, entityIndex, distance }
 *
 * @example Basic raycast
 *   const hit = Ray.cast(player.x, player.y, mouseX, mouseY);
 *   if (hit !== -1) damageEntity(hit);
 *
 * @example Raycast filtered by collision layer (only hit layers 2 and 4)
 *   const hit = Ray.cast(x, y, tx, ty, Infinity, (1 << 2) | (1 << 4));
 *
 * @example Line of sight ignoring bullets (layer 2)
 *   if (Ray.hasLineOfSight(enemy, player, ~(1 << 2))) {
 *     enemy.shoot(player);
 *   }
 *
 * @example Penetrating shot
 *   const hits = Ray.castAll(gun.x, gun.y, targetX, targetY);
 *   hits.forEach(h => spawnBulletHole(h.hitX, h.hitY));
 */

export class Ray {
  // Shape type constants (must match Collider.js / ShapeType enum)
  static SHAPE_BOX = ShapeType.Box;
  static SHAPE_CIRCLE = ShapeType.Circle;
  static SHAPE_POLYGON = ShapeType.Polygon;
  static SHAPE_CHAIN = ShapeType.Chain;

  // GC Optimization: Reusable objects to avoid GC pressure
  // The traced ray and the per-cell, per-traversal and per-shape results are the typed arrays at the
  // top of this file (E-85); these statics name the same arrays for tests.
  static _traverseHit = TRAVERSE_HIT;
  static _traverseDist = TRAVERSE_DIST;
  static _tempHitInfo = {
    hit: false,
    entityIndex: -1,
    distance: Infinity,
    hitX: 0,
    hitY: 0,
    fixtureIndex: -1,
  };
  static _lastFixtureIndex = -1;
  static _tempLinecastResult = {
    blocked: false,
    entityIndex: -1,
    distance: Infinity,
  };
  static _tempHitsArray = []; // Reusable array for castAll
  /** castAll's result objects, kept across calls (the borrowed array is cut to each call's count). */
  static _tempHitSlots = [];
  // H1: castAll keeps its closest hits (at most maxHits) in typed arrays, entity and distance: as
  // fields of hit objects the distances were heap numbers (E-85). Grown when maxHits is larger.
  static _topEntity = new Int32Array(16);
  static _topDist = new Float64Array(16);
  static _tempAllHitsCount = 0;
  // Per-cast generation stamp (skip entities already shape-tested this ray)
  static _rayGen = 1;
  static _rayGenStamp = new Uint32Array(0);

  static _beginRayGen() {
    let gen = (Ray._rayGen + 1) >>> 0;
    if (gen === 0) {
      Ray._rayGenStamp.fill(0);
      gen = 1;
    }
    Ray._rayGen = gen;
    const need = Transform.active ? Transform.active.length : 0;
    if (Ray._rayGenStamp.length < need) {
      Ray._rayGenStamp = new Uint32Array(Math.max(need, 256));
    }
    return gen;
  }

  // Per-worker SAB stats (outermost public call only — nested Ray.* not double-counted)
  /** Set from worker init via config.debug.collectDetailedStats */
  static collectDetailedStats = false;
  /** Warn when linecastDir gets a non-unit dir (config.debug.assertRotCSUnit) */
  static assertRotCSUnit = false;
  static _statsMs = 0;
  static _statsCount = 0;
  static _statsDepth = 0;
  static _statsT0 = 0;
  static _statsOut = { ms: 0, count: 0 };

  static beginFrame() {
    this._statsMs = 0;
    this._statsCount = 0;
    this._statsDepth = 0;
  }

  /** @returns {{ ms: number, count: number }} borrowed — consume before next consumeStats */
  static consumeStats() {
    const out = this._statsOut;
    out.ms = this._statsMs;
    out.count = this._statsCount;
    this._statsMs = 0;
    this._statsCount = 0;
    this._statsDepth = 0;
    return out;
  }

  static _enterStats() {
    if (!this.collectDetailedStats) return;
    if (this._statsDepth++ === 0) this._statsT0 = performance.now();
  }

  static _leaveStats() {
    if (!this.collectDetailedStats) return;
    if (--this._statsDepth === 0) {
      this._statsMs += performance.now() - this._statsT0;
      this._statsCount++;
    }
  }

  /**
   * Cast a ray from (xFrom, yFrom) to (xTo, yTo)
   * Returns the index of the first entity hit, or -1 if no collision
   *
   * @param {number} xFrom - Ray start X
   * @param {number} yFrom - Ray start Y
   * @param {number} xTo - Ray end X
   * @param {number} yTo - Ray end Y
   * @param {number} maxDist - Maximum ray distance (optional)
   * @param {number} mask - Collision layer bitmask (default 0xFFFFFFFF = hit all layers)
   * @returns {number} Entity index or -1
   */
  static cast(xFrom, yFrom, xTo, yTo, maxDist = Infinity, mask = 0xFFFFFFFF) {
    Ray._enterStats();
    try {
      return Ray._castImpl(xFrom, yFrom, xTo, yTo, maxDist, mask);
    } finally {
      Ray._leaveStats();
    }
  }

  /**
   * Cast with pre-normalized unit dir + length (skip sqrt).
   * @param {number} maxDist must be finite and > 0
   */
  static castDir(x, y, dirX, dirY, maxDist, mask = 0xFFFFFFFF) {
    Ray._enterStats();
    try {
      if (!(maxDist > 0) || maxDist === Infinity) return -1;
      if (Ray.assertRotCSUnit) {
        const n = dirX * dirX + dirY * dirY;
        if (!(n > 0.998 && n < 1.002) || !Number.isFinite(dirX) || !Number.isFinite(dirY)) {
          console.warn('Ray.castDir: non-unit dir', dirX, dirY, 'normSq=', n);
        }
      }
      const ray = RAY;
      ray[RAY_X] = x;
      ray[RAY_Y] = y;
      ray[RAY_DIR_X] = dirX;
      ray[RAY_DIR_Y] = dirY;
      ray[RAY_LEN] = maxDist;
      ray[RAY_TO_X] = x + dirX * maxDist;
      ray[RAY_TO_Y] = y + dirY * maxDist;
      return Ray._castUnitDir(mask);
    } finally {
      Ray._leaveStats();
    }
  }

  static _castImpl(xFrom, yFrom, xTo, yTo, maxDist, mask) {
    // Calculate ray direction and length
    const dx = xTo - xFrom;
    const dy = yTo - yFrom;
    const distSq = dx * dx + dy * dy; // OPTIMIZED: Calculate distSq first for early exit check

    // Early exit if ray is too short or too long (avoid sqrt if possible)
    if (distSq === 0 || (maxDist !== Infinity && distSq > maxDist * maxDist)) {
      return -1;
    }

    // Calculate length only if we pass the early exit (OPTIMIZED: avoid sqrt in early exit path)
    const rayLength = Math.sqrt(distSq);

    // Normalize direction
    const dirX = dx / rayLength;
    const dirY = dy / rayLength;
    const capped = maxDist !== Infinity && maxDist < rayLength ? maxDist : rayLength;
    const ray = RAY;
    ray[RAY_X] = xFrom;
    ray[RAY_Y] = yFrom;
    ray[RAY_DIR_X] = dirX;
    ray[RAY_DIR_Y] = dirY;
    ray[RAY_LEN] = capped;
    ray[RAY_TO_X] = capped < rayLength ? xFrom + dirX * capped : xTo;
    ray[RAY_TO_Y] = capped < rayLength ? yFrom + dirY * capped : yTo;
    return Ray._castUnitDir(mask);
  }

  /** The first entity on the ray in RAY (origin, unit direction, length, end), or -1. */
  static _castUnitDir(mask) {
    const ray = RAY;
    const xFrom = ray[RAY_X];
    const yFrom = ray[RAY_Y];
    const dirX = ray[RAY_DIR_X];
    const dirY = ray[RAY_DIR_Y];
    const rayLength = ray[RAY_LEN];
    const xTo = ray[RAY_TO_X];
    const yTo = ray[RAY_TO_Y];
    Ray._beginRayGen();
    // Get grid data from Grid class
    const invCellSize = Grid.invCellSize;
    const gridCols = Grid.gridWidth;
    const gridRows = Grid.gridHeight;
    const cellSize = Grid.cellSize;

    // DDA traversal - find all cells the ray passes through
    const startCellX = Math.floor(xFrom * invCellSize);
    const startCellY = Math.floor(yFrom * invCellSize);
    const endCellX = Math.floor(xTo * invCellSize);
    const endCellY = Math.floor(yTo * invCellSize);

    // Ray step direction
    const stepX = dirX >= 0 ? 1 : -1;
    const stepY = dirY >= 0 ? 1 : -1;

    // Calculate distance to next cell boundary
    let tMaxX, tMaxY;
    if (dirX !== 0) {
      const nextBoundaryX =
        (stepX > 0 ? Math.floor(xFrom * invCellSize) + 1 : Math.ceil(xFrom * invCellSize) - 1) *
        cellSize;
      tMaxX = Math.abs((nextBoundaryX - xFrom) / dirX);
    } else {
      tMaxX = INF;
    }

    if (dirY !== 0) {
      const nextBoundaryY =
        (stepY > 0 ? Math.floor(yFrom * invCellSize) + 1 : Math.ceil(yFrom * invCellSize) - 1) *
        cellSize;
      tMaxY = Math.abs((nextBoundaryY - yFrom) / dirY);
    } else {
      tMaxY = INF;
    }

    // Distance to cross one cell
    const tDeltaX = dirX !== 0 ? cellSize / Math.abs(dirX) : INF;
    const tDeltaY = dirY !== 0 ? cellSize / Math.abs(dirY) : INF;

    // Current cell position
    let currentCellX = startCellX;
    let currentCellY = startCellY;

    // Track closest hit
    let closestHit = -1;
    let closestDist = rayLength;

    // Traverse cells using DDA
    const maxSteps = gridCols + gridRows; // Safety limit
    let steps = 0;

    while (steps++ < maxSteps) {
      // Check if current cell is valid
      if (
        currentCellX >= 0 &&
        currentCellX < gridCols &&
        currentCellY >= 0 &&
        currentCellY < gridRows
      ) {
        // Get entities in this cell
        const cellIndex = currentCellY * gridCols + currentCellX;
        ray[RAY_MAX] = closestDist;
        Ray._checkCellEntities(cellIndex, null, mask);

        const hitE = CELL_HIT[0];
        if (hitE !== -1) {
          closestHit = hitE;
          closestDist = CELL_HIT_DIST[0];
        }
      }

      // EARLY-OUT: spatial workers insert entities into every cell their AABB
      // overlaps, so any hit at t < exit-of-current-cell is already found.
      // Once the closest hit (or maxDist) is not past the current cell's exit
      // boundary, later cells cannot contain a closer hit.
      if (closestDist <= (tMaxX < tMaxY ? tMaxX : tMaxY)) {
        break;
      }

      // Check if we've reached the end cell
      if (currentCellX === endCellX && currentCellY === endCellY) {
        break;
      }

      // Step to next cell
      if (tMaxX < tMaxY) {
        currentCellX += stepX;
        tMaxX += tDeltaX;
      } else {
        currentCellY += stepY;
        tMaxY += tDeltaY;
      }
    }

    if (closestHit !== -1 && closestDist !== 0) {
      return closestHit;
    }

    return -1;
  }

  /**
   * Cast a ray and return detailed hit information
   * Like cast() but returns hit point coordinates and distance
   *
   * @param {number} xFrom - Ray start X
   * @param {number} yFrom - Ray start Y
   * @param {number} xTo - Ray end X
   * @param {number} yTo - Ray end Y
   * @param {number} maxDist - Maximum ray distance (optional)
   * @param {number} mask - Collision layer bitmask (default 0xFFFFFFFF = hit all layers)
   * @param {Object} [out] - Optional stable output object. Defaults to a borrowed static object.
   * @param {number} [excludeEntity=-1] - Entity index to ignore (shooter).
   * @returns {Object} { hit, entityIndex, distance, hitX, hitY, fixtureIndex }
   *   fixtureIndex is the closest ColliderFixture, or -1 if the hit is the primary shape.
   *   Borrowed by default: consume immediately or pass `out` if you need to store it.
   *
   * @example
   *   const result = Ray.castWithInfo(player.x, player.y, targetX, targetY);
   *   if (result.hit) {
   *     spawnBulletHole(result.hitX, result.hitY);
   *     damageEntity(result.entityIndex);
   *   }
   */
  static castWithInfo(xFrom, yFrom, xTo, yTo, maxDist = Infinity, mask = 0xFFFFFFFF, out = null, excludeEntity = -1) {
    Ray._enterStats();
    try {
      // Reset temp result
      const info = out || Ray._tempHitInfo;
      info.hit = false;
      info.entityIndex = -1;
      info.distance = Infinity;
      info.hitX = xTo;
      info.hitY = yTo;
      info.fixtureIndex = -1;

      // Calculate ray direction and length
      const dx = xTo - xFrom;
      const dy = yTo - yFrom;
      const distSq = dx * dx + dy * dy; // OPTIMIZED: Calculate distSq first for early exit check

      // Early exit if ray is too short or too long (avoid sqrt if possible)
      if (distSq === 0 || (maxDist !== Infinity && distSq > maxDist * maxDist)) {
        return info;
      }

      // Calculate length only if we pass the early exit (OPTIMIZED: avoid sqrt in early exit path)
      const rayLength = Math.sqrt(distSq);

      // Normalize direction
      const dirX = dx / rayLength;
      const dirY = dy / rayLength;

      // Use internal traversal
      const ray = RAY;
      ray[RAY_X] = xFrom;
      ray[RAY_Y] = yFrom;
      ray[RAY_DIR_X] = dirX;
      ray[RAY_DIR_Y] = dirY;
      ray[RAY_LEN] = rayLength;
      ray[RAY_TO_X] = xTo;
      ray[RAY_TO_Y] = yTo;
      ray[RAY_MAX] = maxDist;
      Ray._traverseGrid(null, mask, excludeEntity);

      const hitE = TRAVERSE_HIT[0];
      if (hitE !== -1) {
        const distance = TRAVERSE_DIST[0];
        info.hit = true;
        info.entityIndex = hitE;
        info.distance = distance;
        info.hitX = xFrom + dirX * distance;
        info.hitY = yFrom + dirY * distance;
        info.fixtureIndex = TRAVERSE_HIT[1];
      }

      return info;
    } finally {
      Ray._leaveStats();
    }
  }

  /**
   * Check if the path between two points is blocked.
   *
   * @param {number} x1 - Start point X
   * @param {number} y1 - Start point Y
   * @param {number} x2 - End point X
   * @param {number} y2 - End point Y
   * @param {Set<number>|Array<number>} excludeEntities - Optional entity indices to ignore
   * @param {number} mask - Collision layer bitmask (default 0xFFFFFFFF = hit all layers)
   * @param {Object} [out] - Optional stable output object. Defaults to a borrowed static object.
   * @returns {Object} { blocked: boolean, entityIndex: number (-1 if clear), distance: number }
   *   Borrowed by default: consume immediately or pass `out` if you need to store it.
   *
   * @example
   *   // Check if enemy can shoot player
   *   const los = Ray.linecast(enemy.x, enemy.y, player.x, player.y);
   *   if (!los.blocked) {
   *     // Clear shot!
   *     enemy.shoot(player);
   *   }
   */
  static linecast(x1, y1, x2, y2, excludeEntities = null, mask = 0xFFFFFFFF, out = null) {
    Ray._enterStats();
    try {
      const result = out || Ray._tempLinecastResult;
      result.blocked = false;
      result.entityIndex = -1;
      result.distance = Infinity;

      const dx = x2 - x1;
      const dy = y2 - y1;
      const distSq = dx * dx + dy * dy;

      if (distSq === 0) {
        return result;
      }

      const rayLength = Math.sqrt(distSq);
      return Ray._linecastDirImpl(
        x1, y1, x2, y2,
        dx / rayLength, dy / rayLength, rayLength,
        excludeEntities, mask, result
      );
    } finally {
      Ray._leaveStats();
    }
  }

  /**
   * Linecast with pre-normalized unit dir + length (skip sqrt).
   * Caller must pass unit (dirX,dirY) and rayLength > 0.
   * `excludeEntities` may be a Set, an array, or a single entity index (number).
   */
  static linecastDir(x1, y1, dirX, dirY, rayLength, excludeEntities = null, mask = 0xFFFFFFFF, out = null) {
    Ray._enterStats();
    try {
      const result = out || Ray._tempLinecastResult;
      result.blocked = false;
      result.entityIndex = -1;
      result.distance = Infinity;
      if (!(rayLength > 0)) return result;
      if (Ray.assertRotCSUnit) {
        const n = dirX * dirX + dirY * dirY;
        if (!(n > 0.998 && n < 1.002) || !Number.isFinite(dirX) || !Number.isFinite(dirY)) {
          console.warn('Ray.linecastDir: non-unit dir', dirX, dirY, 'normSq=', n);
        }
      }
      const x2 = x1 + dirX * rayLength;
      const y2 = y1 + dirY * rayLength;
      let excludeA = -1;
      let excludeObj = excludeEntities;
      if (typeof excludeEntities === 'number') {
        excludeA = excludeEntities;
        excludeObj = null;
      }
      return Ray._linecastDirImpl(
        x1, y1, x2, y2, dirX, dirY, rayLength, excludeObj, mask, result, excludeA
      );
    } finally {
      Ray._leaveStats();
    }
  }

  /** @private */
  static _linecastDirImpl(
    x1, y1, x2, y2, dirX, dirY, rayLength, excludeEntities, mask, result, excludeA = -1, excludeB = -1
  ) {
    const ray = RAY;
    ray[RAY_X] = x1;
    ray[RAY_Y] = y1;
    ray[RAY_DIR_X] = dirX;
    ray[RAY_DIR_Y] = dirY;
    ray[RAY_LEN] = rayLength;
    ray[RAY_TO_X] = x2;
    ray[RAY_TO_Y] = y2;
    ray[RAY_MAX] = rayLength;
    Ray._traverseGrid(excludeEntities, mask, excludeA, excludeB);
    const hitE = TRAVERSE_HIT[0];
    if (hitE !== -1) {
      result.blocked = true;
      result.entityIndex = hitE;
      result.distance = TRAVERSE_DIST[0];
    }
    return result;
  }

  /**
   * Check if there's a clear line of sight between two entities
   * Automatically excludes both entities from the check
   *
   * @param {number} entityIndexA - First entity index
   * @param {number} entityIndexB - Second entity index
   * @param {number} mask - Collision layer bitmask (default 0xFFFFFFFF = hit all layers)
   * @param {Object} [out] - Optional stable output object. Defaults to a borrowed static object.
   * @returns {Object} { blocked: boolean, entityIndex: number (-1 if clear), distance: number }
   *   Borrowed by default: consume immediately or pass `out` if you need to store it.
   *
   * @example
   *   // Can predator see prey?
   *   const los = Ray.linecastBetweenEntities(predatorIdx, preyIdx);
   *   if (!los.blocked) {
   *     // Predator has line of sight to prey
   *     predator.chase(preyIdx);
   *   }
   */
  /**
   * Entity↔entity linecast without stats wrap. Scalar excludeA/B (no Set).
   * @private
   */
  static _linecastBetweenEntitiesImpl(entityIndexA, entityIndexB, mask, out) {
    const result = out || Ray._tempLinecastResult;
    result.blocked = false;
    result.entityIndex = -1;
    result.distance = Infinity;

    const x1 = Transform.x[entityIndexA];
    const y1 = Transform.y[entityIndexA];
    const x2 = Transform.x[entityIndexB];
    const y2 = Transform.y[entityIndexB];

    const dx = x2 - x1;
    const dy = y2 - y1;
    const distSq = dx * dx + dy * dy;
    if (distSq === 0) return result;

    const rayLength = Math.sqrt(distSq);
    const ray = RAY;
    ray[RAY_X] = x1;
    ray[RAY_Y] = y1;
    ray[RAY_DIR_X] = dx / rayLength;
    ray[RAY_DIR_Y] = dy / rayLength;
    ray[RAY_LEN] = rayLength;
    ray[RAY_TO_X] = x2;
    ray[RAY_TO_Y] = y2;
    ray[RAY_MAX] = rayLength;
    Ray._traverseGrid(null, mask, entityIndexA, entityIndexB);

    const hitE = TRAVERSE_HIT[0];
    if (hitE !== -1) {
      result.blocked = true;
      result.entityIndex = hitE;
      result.distance = TRAVERSE_DIST[0];
    }
    return result;
  }

  static linecastBetweenEntities(entityIndexA, entityIndexB, mask = 0xFFFFFFFF, out = null) {
    Ray._enterStats();
    try {
      return Ray._linecastBetweenEntitiesImpl(entityIndexA, entityIndexB, mask, out);
    } finally {
      Ray._leaveStats();
    }
  }

  /**
   * Check if entity A has clear line of sight to entity B
   * Convenience method that returns just a boolean
   *
   * @param {number} entityIndexA - Source entity index
   * @param {number} entityIndexB - Target entity index
   * @returns {boolean} true if clear line of sight, false if blocked
   */
  static hasLineOfSight(entityIndexA, entityIndexB, mask = 0xFFFFFFFF) {
    Ray._enterStats();
    try {
      return !Ray._linecastBetweenEntitiesImpl(entityIndexA, entityIndexB, mask, null).blocked;
    } finally {
      Ray._leaveStats();
    }
  }

  /**
   * Check line of sight and return blocker info (zero-allocation)
   * Useful when you need to know WHAT blocked the line of sight
   *
   * @param {number} entityIndexA - Source entity index
   * @param {number} entityIndexB - Target entity index
   * @param {number} mask - Collision layer bitmask (default 0xFFFFFFFF = hit all layers)
   * @param {Object} [out] - Optional stable output object. Defaults to a borrowed static object.
   * @returns {Object} { blocked: boolean, entityIndex: number (-1 if clear), distance: number }
   *   Borrowed by default: consume immediately or pass `out` if you need to store it.
   */
  static getLineOfSightInfo(entityIndexA, entityIndexB, mask = 0xFFFFFFFF, out = null) {
    return Ray.linecastBetweenEntities(entityIndexA, entityIndexB, mask, out);
  }

  /**
   * Cast a ray and return ALL entities hit along the path (not just the first)
   * Useful for penetrating shots, showing bullet holes on all surfaces, etc.
   *
   * @param {number} xFrom - Ray start X
   * @param {number} yFrom - Ray start Y
   * @param {number} xTo - Ray end X
   * @param {number} yTo - Ray end Y
   * @param {number} maxDist - Maximum ray distance (optional)
   * @param {number} maxHits - Maximum number of hits to return (default: 10)
   * @param {number} mask - Collision layer bitmask (default 0xFFFFFFFF = hit all layers)
   * @param {Array} [out] - Optional stable output array. Defaults to a borrowed static array.
   * @returns {Array<{entityIndex: number, distance: number, hitX: number, hitY: number}>}
   *   Borrowed by default: returned array and hit objects are reused on the next call.
   *
   * @example
   *   // Penetrating railgun shot
   *   const hits = Ray.castAll(gun.x, gun.y, targetX, targetY, Infinity, 5);
   *   for (const hit of hits) {
   *     damageEntity(hit.entityIndex, railgunDamage * (1 - hit.distance / maxRange));
   *     spawnBulletHole(hit.hitX, hit.hitY);
   *   }
   */
  static castAll(xFrom, yFrom, xTo, yTo, maxDist = Infinity, maxHits = 10, mask = 0xFFFFFFFF, out = null) {
    Ray._enterStats();
    try {
      return Ray._castAllImpl(xFrom, yFrom, xTo, yTo, maxDist, maxHits, mask, out);
    } finally {
      Ray._leaveStats();
    }
  }

  static _castAllImpl(xFrom, yFrom, xTo, yTo, maxDist, maxHits, mask, out) {
    const outHits = out || Ray._tempHitsArray;
    Ray._tempAllHitsCount = 0;
    TOP_FAR[0] = -1;
    Ray._beginRayGen();

    const dx = xTo - xFrom;
    const dy = yTo - yFrom;
    const distSq = dx * dx + dy * dy;

    if (distSq === 0 || (maxDist !== Infinity && distSq > maxDist * maxDist)) {
      outHits.length = 0;
      return outHits;
    }

    const rayLength = Math.sqrt(distSq);
    const dirX = dx / rayLength;
    const dirY = dy / rayLength;
    const hitCap = maxHits > 0 ? maxHits : 1;
    if (Ray._topEntity.length < hitCap) {
      Ray._topEntity = new Int32Array(hitCap);
      Ray._topDist = new Float64Array(hitCap);
    }
    const ray = RAY;
    ray[RAY_X] = xFrom;
    ray[RAY_Y] = yFrom;
    ray[RAY_DIR_X] = dirX;
    ray[RAY_DIR_Y] = dirY;
    ray[RAY_LEN] = rayLength;

    const invCellSize = Grid.invCellSize;
    const gridCols = Grid.gridWidth;
    const gridRows = Grid.gridHeight;
    const cellSize = Grid.cellSize;

    const startCellX = Math.floor(xFrom * invCellSize);
    const startCellY = Math.floor(yFrom * invCellSize);
    const endCellX = Math.floor(xTo * invCellSize);
    const endCellY = Math.floor(yTo * invCellSize);

    const stepX = dirX >= 0 ? 1 : -1;
    const stepY = dirY >= 0 ? 1 : -1;

    let tMaxX, tMaxY;
    if (dirX !== 0) {
      const nextBoundaryX =
        (stepX > 0 ? Math.floor(xFrom * invCellSize) + 1 : Math.ceil(xFrom * invCellSize) - 1) *
        cellSize;
      tMaxX = Math.abs((nextBoundaryX - xFrom) / dirX);
    } else {
      tMaxX = INF;
    }

    if (dirY !== 0) {
      const nextBoundaryY =
        (stepY > 0 ? Math.floor(yFrom * invCellSize) + 1 : Math.ceil(yFrom * invCellSize) - 1) *
        cellSize;
      tMaxY = Math.abs((nextBoundaryY - yFrom) / dirY);
    } else {
      tMaxY = INF;
    }

    const tDeltaX = dirX !== 0 ? cellSize / Math.abs(dirX) : INF;
    const tDeltaY = dirY !== 0 ? cellSize / Math.abs(dirY) : INF;

    let currentCellX = startCellX;
    let currentCellY = startCellY;
    const maxSteps = gridCols + gridRows;
    let steps = 0;

    // H1: keep at most hitCap closest hits; stop DDA once farthest kept <= cell exit.
    while (steps++ < maxSteps) {
      if (
        currentCellX >= 0 &&
        currentCellX < gridCols &&
        currentCellY >= 0 &&
        currentCellY < gridRows
      ) {
        const cellIndex = currentCellY * gridCols + currentCellX;
        Ray._collectCellHitsTopN(cellIndex, mask, hitCap);
      }

      const cellExit = tMaxX < tMaxY ? tMaxX : tMaxY;
      if (Ray._tempAllHitsCount >= hitCap && TOP_FAR[0] <= cellExit) {
        break;
      }

      if (currentCellX === endCellX && currentCellY === endCellY) {
        break;
      }

      if (tMaxX < tMaxY) {
        currentCellX += stepX;
        tMaxX += tDeltaX;
      } else {
        currentCellY += stepY;
        tMaxY += tDeltaY;
      }
    }

    // The kept hits nearest first. Insertion sort: as stable as the Array sort it replaces, and
    // there are at most maxHits of them.
    const count = Ray._tempAllHitsCount;
    const topEntity = Ray._topEntity;
    const topDist = Ray._topDist;
    for (let i = 1; i < count; i++) {
      const e = topEntity[i];
      const d = topDist[i];
      let j = i - 1;
      while (j >= 0 && topDist[j] > d) {
        topEntity[j + 1] = topEntity[j];
        topDist[j + 1] = topDist[j];
        j--;
      }
      topEntity[j + 1] = e;
      topDist[j + 1] = d;
    }

    // Result objects are reused: the borrowed array's from the slot pool, a caller's `out` its own.
    const pool = out ? null : Ray._tempHitSlots;
    for (let i = 0; i < count; i++) {
      let slot = pool ? pool[i] : outHits[i];
      if (typeof slot !== 'object' || slot === null) {
        // Doubles from the start, so the fields never change representation.
        slot = { entityIndex: -1, distance: NaN, hitX: NaN, hitY: NaN };
        if (pool) pool[i] = slot;
      }
      const distance = topDist[i];
      slot.entityIndex = topEntity[i];
      slot.distance = distance;
      slot.hitX = xFrom + dirX * distance;
      slot.hitY = yFrom + dirY * distance;
      outHits[i] = slot;
    }
    outHits.length = count;

    return outHits;
  }

  /**
   * Internal: Traverse grid and find first hit
   * Shared logic for castWithInfo and the linecasts. Traces the ray in RAY (origin, unit direction,
   * length, end, and RAY_MAX, the farthest hit kept); the hit goes to TRAVERSE_HIT and TRAVERSE_DIST.
   * @private
   */
  static _traverseGrid(excludeEntities = null, rayMask = 0xFFFFFFFF, excludeA = -1, excludeB = -1) {
    const ray = RAY;
    const xFrom = ray[RAY_X];
    const yFrom = ray[RAY_Y];
    const dirX = ray[RAY_DIR_X];
    const dirY = ray[RAY_DIR_Y];
    const xTo = ray[RAY_TO_X];
    const yTo = ray[RAY_TO_Y];
    const maxDist = ray[RAY_MAX];
    Ray._beginRayGen();
    const invCellSize = Grid.invCellSize;
    const gridCols = Grid.gridWidth;
    const gridRows = Grid.gridHeight;
    const cellSize = Grid.cellSize;

    const startCellX = Math.floor(xFrom * invCellSize);
    const startCellY = Math.floor(yFrom * invCellSize);
    const endCellX = Math.floor(xTo * invCellSize);
    const endCellY = Math.floor(yTo * invCellSize);

    const stepX = dirX >= 0 ? 1 : -1;
    const stepY = dirY >= 0 ? 1 : -1;

    let tMaxX, tMaxY;
    if (dirX !== 0) {
      const nextBoundaryX =
        (stepX > 0 ? Math.floor(xFrom * invCellSize) + 1 : Math.ceil(xFrom * invCellSize) - 1) *
        cellSize;
      tMaxX = Math.abs((nextBoundaryX - xFrom) / dirX);
    } else {
      tMaxX = INF;
    }

    if (dirY !== 0) {
      const nextBoundaryY =
        (stepY > 0 ? Math.floor(yFrom * invCellSize) + 1 : Math.ceil(yFrom * invCellSize) - 1) *
        cellSize;
      tMaxY = Math.abs((nextBoundaryY - yFrom) / dirY);
    } else {
      tMaxY = INF;
    }

    const tDeltaX = dirX !== 0 ? cellSize / Math.abs(dirX) : INF;
    const tDeltaY = dirY !== 0 ? cellSize / Math.abs(dirY) : INF;

    let currentCellX = startCellX;
    let currentCellY = startCellY;

    let closestHit = -1;
    let closestDist = maxDist;
    let closestFi = -1;

    const maxSteps = gridCols + gridRows;
    let steps = 0;

    while (steps++ < maxSteps) {
      if (
        currentCellX >= 0 &&
        currentCellX < gridCols &&
        currentCellY >= 0 &&
        currentCellY < gridRows
      ) {
        const cellIndex = currentCellY * gridCols + currentCellX;

        ray[RAY_MAX] = closestDist;
        Ray._checkCellEntities(cellIndex, excludeEntities, rayMask, excludeA, excludeB);

        const hitE = CELL_HIT[0];
        if (hitE !== -1) {
          closestHit = hitE;
          closestDist = CELL_HIT_DIST[0];
          closestFi = CELL_HIT[1];
        }
      }

      // EARLY-OUT: spatial workers insert entities into every cell their AABB
      // overlaps, so any hit at t < exit-of-current-cell is already found.
      if (closestDist <= (tMaxX < tMaxY ? tMaxX : tMaxY)) {
        break;
      }

      if (currentCellX === endCellX && currentCellY === endCellY) {
        break;
      }

      if (tMaxX < tMaxY) {
        currentCellX += stepX;
        tMaxX += tDeltaX;
      } else {
        currentCellY += stepY;
        tMaxY += tDeltaY;
      }
    }

    // Read at once by castWithInfo and the linecasts.
    TRAVERSE_HIT[0] = closestHit;
    TRAVERSE_HIT[1] = closestFi;
    TRAVERSE_DIST[0] = closestDist;
  }

  /**
   * Ray vs one collider shape: the ray in RAY, bounded by RAY_SHAPE_MAX. The distance along the
   * ray, or -1 for a miss, goes to SHAPE_DIST[0]; a compound polygon's fixture to _lastFixtureIndex.
   * One function per shape, each called with the entity alone: whichever of them TurboFan inlines
   * here (or into _checkCellEntities), no call on the way passes a double. Inlined together, the
   * tests overran the inlining budget and the one left out boxed its nine doubles per candidate.
   * @private
   */
  static _shapeRayDistance(entityIndex) {
    Ray._lastFixtureIndex = -1;
    const shapeType = Collider.shapeType[entityIndex];
    if (shapeType === Ray.SHAPE_CIRCLE) Ray._circleRayDistance(entityIndex);
    else if (shapeType === Ray.SHAPE_BOX) Ray._boxRayDistance(entityIndex);
    else if (shapeType === Ray.SHAPE_POLYGON) Ray._polygonRayDistance(entityIndex);
    else if (shapeType === Ray.SHAPE_CHAIN) Ray._chainRayDistance(entityIndex);
    else SHAPE_DIST[0] = -1;
  }

  /**
   * _shapeRayDistance for a circle: rayCircleIntersect (util/utils.js) on the ray in RAY, its math
   * copied here so no call takes the ray's doubles (rayShapeParity.test.js holds them equal).
   * @private
   */
  static _circleRayDistance(entityIndex) {
    const ray = RAY;
    const rayX = ray[RAY_X];
    const rayY = ray[RAY_Y];
    const dirX = ray[RAY_DIR_X];
    const dirY = ray[RAY_DIR_Y];
    const maxDist = ray[RAY_SHAPE_MAX];
    const circleX = Transform.x[entityIndex] + (Collider.offsetX[entityIndex] || 0);
    const circleY = Transform.y[entityIndex] + (Collider.offsetY[entityIndex] || 0);
    const radius = Collider.radius[entityIndex];
    SHAPE_DIST[0] = -1;

    const toCircleX = circleX - rayX;
    const toCircleY = circleY - rayY;
    const distToCircleSq = toCircleX * toCircleX + toCircleY * toCircleY;
    const maxPossibleDist = maxDist + radius;
    if (distToCircleSq > maxPossibleDist * maxPossibleDist) return;

    const projection = toCircleX * dirX + toCircleY * dirY;
    if (projection < 0) return;

    const closestX = rayX + dirX * projection;
    const closestY = rayY + dirY * projection;
    const distX = circleX - closestX;
    const distY = circleY - closestY;
    const distSq = distX * distX + distY * distY;
    const radiusSq = radius * radius;
    if (distSq > radiusSq) return;

    const distance = projection - Math.sqrt(radiusSq - distSq);
    if (distance > maxDist || distance < 0) return;
    SHAPE_DIST[0] = distance;
  }

  /**
   * _shapeRayDistance for an axis-aligned box: rayBoxIntersect (util/utils.js) on the ray in RAY,
   * copied for the same reason as _circleRayDistance.
   * @private
   */
  static _boxRayDistance(entityIndex) {
    const ray = RAY;
    const rayX = ray[RAY_X];
    const rayY = ray[RAY_Y];
    const dirX = ray[RAY_DIR_X];
    const dirY = ray[RAY_DIR_Y];
    const maxDist = ray[RAY_SHAPE_MAX];
    const boxX = Transform.x[entityIndex] + (Collider.offsetX[entityIndex] || 0);
    const boxY = Transform.y[entityIndex] + (Collider.offsetY[entityIndex] || 0);
    const halfW = Collider.width[entityIndex] * 0.5;
    const halfH = Collider.height[entityIndex] * 0.5;
    SHAPE_DIST[0] = -1;

    const minX = boxX - halfW;
    const maxX = boxX + halfW;
    const minY = boxY - halfH;
    const maxY = boxY + halfH;
    const invDirX = dirX !== 0 ? 1 / dirX : INF;
    const invDirY = dirY !== 0 ? 1 / dirY : INF;
    const t1 = (minX - rayX) * invDirX;
    const t2 = (maxX - rayX) * invDirX;
    const t3 = (minY - rayY) * invDirY;
    const t4 = (maxY - rayY) * invDirY;
    const tmin = Math.max(Math.min(t1, t2), Math.min(t3, t4));
    const tmax = Math.min(Math.max(t1, t2), Math.max(t3, t4));
    if (tmax < 0 || tmin > tmax) return;

    const distance = tmin >= 0 ? tmin : tmax;
    if (distance > maxDist || distance < 0) return;
    SHAPE_DIST[0] = distance;
  }

  /** @private _shapeRayDistance for a chain. */
  static _chainRayDistance(entityIndex) {
    const ray = RAY;
    SHAPE_DIST[0] = ChainPoints.rayDistance(
      entityIndex, ray[RAY_X], ray[RAY_Y], ray[RAY_DIR_X], ray[RAY_DIR_Y], ray[RAY_SHAPE_MAX]
    );
  }

  /** @private _shapeRayDistance for a polygon, single or compound (one convex ColliderFixture each). */
  static _polygonRayDistance(entityIndex) {
    const ray = RAY;
    const rayX = ray[RAY_X];
    const rayY = ray[RAY_Y];
    const dirX = ray[RAY_DIR_X];
    const dirY = ray[RAY_DIR_Y];
    const rayLength = ray[RAY_SHAPE_MAX];
    const out = SHAPE_DIST;
    const ox = Collider.offsetX[entityIndex] || 0;
    const oy = Collider.offsetY[entityIndex] || 0;
    const c = Transform.rotC ? Transform.rotC[entityIndex] : 1;
    const s = Transform.rotS ? Transform.rotS[entityIndex] : 0;
    const entityX = Transform.x[entityIndex] + c * ox - s * oy;
    const entityY = Transform.y[entityIndex] + s * ox + c * oy;
    const fixtureCount = Collider.fixtureCount ? Collider.fixtureCount[entityIndex] : 0;
    if (fixtureCount > 0 && ColliderFixture.active) {
      let best = -1;
      let bestFi = -1;
      const fxActive = ColliderFixture.active;
      const fxNext = ColliderFixture.next;
      const fxVertCount = ColliderFixture.vertCount;
      const vx = ColliderFixture.vertexX;
      const vy = ColliderFixture.vertexY;
      const nx = ColliderFixture.normalX;
      const ny = ColliderFixture.normalY;
      const fxMax = ColliderFixture.maxCount | 0;
      let fi = ColliderFixture.headOf(entityIndex);
      let guard = 0;
      while (fi !== 0xffff && guard++ < fxMax) {
        if (fxActive[fi]) {
          const count = fxVertCount[fi] | 0;
          if (count >= 3) {
            const base = fi * MAX_POLYGON_VERTICES;
            const d = rayPolygonIntersect(
              rayX, rayY, dirX, dirY,
              entityX, entityY, c, s,
              vx, vy, nx, ny,
              count, base, rayLength
            );
            if (d >= 0 && (best < 0 || d < best)) {
              best = d;
              bestFi = fi;
            }
          }
        }
        fi = fxNext[fi];
      }
      Ray._lastFixtureIndex = bestFi;
      out[0] = best;
      return;
    }
    const count = Collider.polyCount[entityIndex];
    if (count < 3) {
      out[0] = -1;
      return;
    }
    const base = entityIndex * MAX_POLYGON_VERTICES;
    out[0] = rayPolygonIntersect(
      rayX, rayY, dirX, dirY,
      entityX, entityY, c, s,
      Collider.polyVertexX, Collider.polyVertexY,
      Collider.polyNormalX, Collider.polyNormalY,
      count, base, rayLength
    );
  }

  /**
   * H1: Collect hits into the top-N buffer (_topEntity, _topDist: closest maxHits only), deduped
   * via generation stamp. The farthest kept hit is TOP_FAR[0].
   * @private
   */
  static _collectCellHitsTopN(cellIndex, rayMask, maxHits) {
    const count = Grid.getCellCount(cellIndex);
    if (count === 0) return;

    const ray = RAY;
    const rayLength = ray[RAY_LEN];
    const cellBase = Grid.getCellBase(cellIndex);
    const gridEntities = Grid._gridEntities;
    const active = Transform.active;
    const colliderActive = Collider.active;
    const cCollisionLayer = Collider.collisionLayer;
    const stamp = Ray._rayGenStamp;
    const gen = Ray._rayGen;
    const topEntity = Ray._topEntity;
    const topDist = Ray._topDist;
    const far = TOP_FAR;

    for (let i = 0; i < count; i++) {
      const entityIndex = gridEntities[cellBase + i];

      if (stamp[entityIndex] === gen) continue;
      stamp[entityIndex] = gen;

      if (!active[entityIndex]) continue;
      if (!colliderActive[entityIndex]) continue;
      if (!((1 << (cCollisionLayer[entityIndex] & 31)) & rayMask)) continue;

      const kept = Ray._tempAllHitsCount;
      ray[RAY_SHAPE_MAX] = kept >= maxHits && far[0] >= 0 ? far[0] : rayLength;
      Ray._shapeRayDistance(entityIndex);
      const distance = SHAPE_DIST[0];
      if (distance < 0) continue;

      if (kept < maxHits) {
        topEntity[kept] = entityIndex;
        topDist[kept] = distance;
        Ray._tempAllHitsCount = kept + 1;
        if (distance > far[0]) far[0] = distance;
      } else if (distance < far[0]) {
        let worst = 0;
        let worstDist = topDist[0];
        for (let h = 1; h < maxHits; h++) {
          const d = topDist[h];
          if (d > worstDist) {
            worstDist = d;
            worst = h;
          }
        }
        topEntity[worst] = entityIndex;
        topDist[worst] = distance;
        let farthest = topDist[0];
        for (let h = 1; h < maxHits; h++) {
          const d = topDist[h];
          if (d > farthest) farthest = d;
        }
        far[0] = farthest;
      }
    }
  }

  /**
   * Check all entities in a cell for ray collision: the ray in RAY, a hit counting only when it is
   * closer than RAY_MAX. Writes the closest hit into CELL_HIT ([entity, fixture]) and CELL_HIT_DIST,
   * or -1 and Infinity
   * @private
   */
  static _checkCellEntities(cellIndex, excludeEntities = null, rayMask = 0xFFFFFFFF, excludeA = -1, excludeB = -1) {
    const ray = RAY;
    const rayLength = ray[RAY_LEN];
    const currentClosest = ray[RAY_MAX];
    const cellHit = CELL_HIT;
    cellHit[0] = -1;
    cellHit[1] = -1;
    CELL_HIT_DIST[0] = Infinity;

    const count = Grid.getCellCount(cellIndex);
    if (count === 0) {
      return;
    }

    const cellBase = Grid.getCellBase(cellIndex);
    const gridEntities = Grid._gridEntities;

    const active = Transform.active;
    const colliderActive = Collider.active;
    const cCollisionLayer = Collider.collisionLayer;

    let closestIndex = -1;
    let closestDist = currentClosest;
    let closestFi = -1;

    const useScalarExclude = excludeA >= 0 || excludeB >= 0;
    let excludeSet = null;
    let excludeArr = null;
    if (!useScalarExclude && excludeEntities) {
      if (excludeEntities instanceof Set) excludeSet = excludeEntities;
      else if (Array.isArray(excludeEntities)) excludeArr = excludeEntities;
    }

    const stamp = Ray._rayGenStamp;
    const gen = Ray._rayGen;

    for (let i = 0; i < count; i++) {
      const entityIndex = gridEntities[cellBase + i];

      if (stamp[entityIndex] === gen) continue;
      stamp[entityIndex] = gen;

      if (useScalarExclude) {
        if (entityIndex === excludeA || entityIndex === excludeB) continue;
      } else if (excludeSet) {
        if (excludeSet.has(entityIndex)) continue;
      } else if (excludeArr) {
        if (excludeArr.includes(entityIndex)) continue;
      }

      if (!active[entityIndex]) continue;
      if (!colliderActive[entityIndex]) continue;
      if (!((1 << (cCollisionLayer[entityIndex] & 31)) & rayMask)) continue;

      // Tighten shape maxDist to running closest so later candidates early-out
      ray[RAY_SHAPE_MAX] = closestDist < rayLength ? closestDist : rayLength;
      Ray._shapeRayDistance(entityIndex);
      const distance = SHAPE_DIST[0];

      // Track closest hit in this cell
      if (distance >= 0 && distance < closestDist) {
        closestDist = distance;
        closestIndex = entityIndex;
        closestFi = Ray._lastFixtureIndex;
      }
    }

    cellHit[0] = closestIndex;
    cellHit[1] = closestFi;
    CELL_HIT_DIST[0] = closestDist;
  }
}
