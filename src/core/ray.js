// Ray.js - Raycasting system using spatial grid
// Uses DDA (Digital Differential Analyzer) to traverse only cells the ray passes through
// Now uses Grid class for spatial data and utils for geometric intersections

import { Transform } from '../components/Transform.js';
import { Collider } from '../components/Collider.js';
import { Grid } from './Grid.js';
import { rayCircleIntersect, rayBoxIntersect, rayPolygonIntersect } from './utils.js';
import { MAX_POLYGON_VERTICES, ShapeType } from './ConfigDefaults.js';

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
 *   - castWithInfo(x1, y1, x2, y2, maxDist, mask, out)  → { hit, entityIndex, distance, hitX, hitY }
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

  // GC Optimization: Reusable objects to avoid GC pressure
  static _tempResult = { entityIndex: -1, distance: Infinity };
  static _tempHitInfo = {
    hit: false,
    entityIndex: -1,
    distance: Infinity,
    hitX: 0,
    hitY: 0,
  };
  static _tempLinecastResult = {
    blocked: false,
    entityIndex: -1,
    distance: Infinity,
  };
  static _tempHitsArray = []; // Reusable array for castAll
  static _tempAllHitsArray = []; // Reusable array for castAll internal hits
  static _tempAllHitsCount = 0; // Reused counter to avoid allocations
  static _tempAllHitsFarthest = -1; // H1: farthest distance among top-N castAll hits
  static _checkedEntities = new Set(); // Reused Set for castAll
  static _traverseResult = { entityIndex: -1, distance: Infinity }; // Reused by _traverseGrid
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

  /** Fold external cast time (e.g. Box2D SAB ray) into RAYCAST_MS for L2 A/B. */
  static noteExternalWork(ms, count = 1) {
    if (!this.collectDetailedStats) return;
    this._statsMs += ms;
    this._statsCount += count;
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
      const xTo = x + dirX * maxDist;
      const yTo = y + dirY * maxDist;
      return Ray._castUnitDir(x, y, xTo, yTo, dirX, dirY, maxDist, mask);
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
    const xEnd = capped < rayLength ? xFrom + dirX * capped : xTo;
    const yEnd = capped < rayLength ? yFrom + dirY * capped : yTo;
    return Ray._castUnitDir(xFrom, yFrom, xEnd, yEnd, dirX, dirY, capped, mask);
  }

  static _castUnitDir(xFrom, yFrom, xTo, yTo, dirX, dirY, rayLength, mask) {
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
      tMaxX = Infinity;
    }

    if (dirY !== 0) {
      const nextBoundaryY =
        (stepY > 0 ? Math.floor(yFrom * invCellSize) + 1 : Math.ceil(yFrom * invCellSize) - 1) *
        cellSize;
      tMaxY = Math.abs((nextBoundaryY - yFrom) / dirY);
    } else {
      tMaxY = Infinity;
    }

    // Distance to cross one cell
    const tDeltaX = dirX !== 0 ? cellSize / Math.abs(dirX) : Infinity;
    const tDeltaY = dirY !== 0 ? cellSize / Math.abs(dirY) : Infinity;

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
        Ray._checkCellEntities(cellIndex, xFrom, yFrom, dirX, dirY, rayLength, closestDist, null, mask);

        const result = Ray._tempResult;

        if (result.entityIndex !== -1) {
          closestHit = result.entityIndex;
          closestDist = result.distance;
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
   * @returns {Object} { hit: boolean, entityIndex: number, distance: number, hitX: number, hitY: number }
   *   Borrowed by default: consume immediately or pass `out` if you need to store it.
   *
   * @example
   *   const result = Ray.castWithInfo(player.x, player.y, targetX, targetY);
   *   if (result.hit) {
   *     spawnBulletHole(result.hitX, result.hitY);
   *     damageEntity(result.entityIndex);
   *   }
   */
  static castWithInfo(xFrom, yFrom, xTo, yTo, maxDist = Infinity, mask = 0xFFFFFFFF, out = null) {
    Ray._enterStats();
    try {
      // Reset temp result
      const info = out || Ray._tempHitInfo;
      info.hit = false;
      info.entityIndex = -1;
      info.distance = Infinity;
      info.hitX = xTo;
      info.hitY = yTo;

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
      const result = Ray._traverseGrid(xFrom, yFrom, xTo, yTo, dirX, dirY, rayLength, maxDist, null, mask);

      if (result.entityIndex !== -1) {
        info.hit = true;
        info.entityIndex = result.entityIndex;
        info.distance = result.distance;
        info.hitX = xFrom + dirX * result.distance;
        info.hitY = yFrom + dirY * result.distance;
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
      return Ray._linecastDirImpl(x1, y1, x2, y2, dirX, dirY, rayLength, excludeEntities, mask, result);
    } finally {
      Ray._leaveStats();
    }
  }

  /** @private */
  static _linecastDirImpl(x1, y1, x2, y2, dirX, dirY, rayLength, excludeEntities, mask, result) {
    const hitResult = Ray._traverseGrid(
      x1, y1, x2, y2,
      dirX, dirY, rayLength, rayLength,
      excludeEntities, mask
    );
    if (hitResult.entityIndex !== -1) {
      result.blocked = true;
      result.entityIndex = hitResult.entityIndex;
      result.distance = hitResult.distance;
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
    const dirX = dx / rayLength;
    const dirY = dy / rayLength;

    const hitResult = Ray._traverseGrid(
      x1,
      y1,
      x2,
      y2,
      dirX,
      dirY,
      rayLength,
      rayLength,
      null,
      mask,
      entityIndexA,
      entityIndexB
    );

    if (hitResult.entityIndex !== -1) {
      result.blocked = true;
      result.entityIndex = hitResult.entityIndex;
      result.distance = hitResult.distance;
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
    outHits.length = 0;
    Ray._tempAllHitsArray.length = 0;
    Ray._tempAllHitsCount = 0;
    Ray._tempAllHitsFarthest = -1;
    Ray._beginRayGen();

    const dx = xTo - xFrom;
    const dy = yTo - yFrom;
    const distSq = dx * dx + dy * dy;

    if (distSq === 0 || (maxDist !== Infinity && distSq > maxDist * maxDist)) {
      return outHits;
    }

    const rayLength = Math.sqrt(distSq);
    const dirX = dx / rayLength;
    const dirY = dy / rayLength;
    const hitCap = maxHits > 0 ? maxHits : 1;

    const invCellSize = Grid.invCellSize;
    const gridCols = Grid.gridWidth;
    const gridRows = Grid.gridHeight;
    const cellSize = Grid.cellSize;

    const allHits = Ray._tempAllHitsArray;

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
      tMaxX = Infinity;
    }

    if (dirY !== 0) {
      const nextBoundaryY =
        (stepY > 0 ? Math.floor(yFrom * invCellSize) + 1 : Math.ceil(yFrom * invCellSize) - 1) *
        cellSize;
      tMaxY = Math.abs((nextBoundaryY - yFrom) / dirY);
    } else {
      tMaxY = Infinity;
    }

    const tDeltaX = dirX !== 0 ? cellSize / Math.abs(dirX) : Infinity;
    const tDeltaY = dirY !== 0 ? cellSize / Math.abs(dirY) : Infinity;

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
        Ray._collectCellHitsTopN(
          cellIndex,
          xFrom,
          yFrom,
          dirX,
          dirY,
          rayLength,
          allHits,
          mask,
          hitCap
        );
      }

      const cellExit = tMaxX < tMaxY ? tMaxX : tMaxY;
      if (Ray._tempAllHitsCount >= hitCap && Ray._tempAllHitsFarthest <= cellExit) {
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

    allHits.length = Ray._tempAllHitsCount;
    allHits.sort((a, b) => a.distance - b.distance);

    const count = allHits.length;
    for (let i = 0; i < count; i++) {
      const hit = allHits[i];
      let slot = outHits[i];
      if (!slot) {
        slot = { entityIndex: -1, distance: 0, hitX: 0, hitY: 0 };
        outHits[i] = slot;
      }
      slot.entityIndex = hit.entityIndex;
      slot.distance = hit.distance;
      slot.hitX = xFrom + dirX * hit.distance;
      slot.hitY = yFrom + dirY * hit.distance;
    }
    outHits.length = count;

    return outHits;
  }

  /**
   * Internal: Traverse grid and find first hit
   * Shared logic for cast, castWithInfo, linecast
   * @private
   */
  static _traverseGrid(
    xFrom,
    yFrom,
    xTo,
    yTo,
    dirX,
    dirY,
    rayLength,
    maxDist,
    excludeEntities = null,
    rayMask = 0xFFFFFFFF,
    excludeA = -1,
    excludeB = -1
  ) {
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
      tMaxX = Infinity;
    }

    if (dirY !== 0) {
      const nextBoundaryY =
        (stepY > 0 ? Math.floor(yFrom * invCellSize) + 1 : Math.ceil(yFrom * invCellSize) - 1) *
        cellSize;
      tMaxY = Math.abs((nextBoundaryY - yFrom) / dirY);
    } else {
      tMaxY = Infinity;
    }

    const tDeltaX = dirX !== 0 ? cellSize / Math.abs(dirX) : Infinity;
    const tDeltaY = dirY !== 0 ? cellSize / Math.abs(dirY) : Infinity;

    let currentCellX = startCellX;
    let currentCellY = startCellY;

    let closestHit = -1;
    let closestDist = maxDist;

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

        Ray._checkCellEntities(
          cellIndex,
          xFrom,
          yFrom,
          dirX,
          dirY,
          rayLength,
          closestDist,
          excludeEntities,
          rayMask,
          excludeA,
          excludeB
        );

        const result = Ray._tempResult;

        if (result.entityIndex !== -1) {
          closestHit = result.entityIndex;
          closestDist = result.distance;
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

    // Borrowed static result: consumed immediately by castWithInfo/linecast
    const out = Ray._traverseResult;
    out.entityIndex = closestHit;
    out.distance = closestDist;
    return out;
  }

  /**
   * Ray vs one collider shape. Returns distance along ray, or -1 if miss.
   * @private
   */
  static _shapeRayDistance(entityIndex, rayX, rayY, dirX, dirY, rayLength) {
    const shapeType = Collider.shapeType[entityIndex];
    const ox = Collider.offsetX[entityIndex] || 0;
    const oy = Collider.offsetY[entityIndex] || 0;
    const tx = Transform.x[entityIndex];
    const ty = Transform.y[entityIndex];

    if (shapeType === Ray.SHAPE_POLYGON) {
      const c = Transform.rotC ? Transform.rotC[entityIndex] : 1;
      const s = Transform.rotS ? Transform.rotS[entityIndex] : 0;
      const entityX = tx + c * ox - s * oy;
      const entityY = ty + s * ox + c * oy;
      const count = Collider.polyCount[entityIndex];
      if (count < 3) return -1;
      const base = entityIndex * MAX_POLYGON_VERTICES;
      return rayPolygonIntersect(
        rayX, rayY, dirX, dirY,
        entityX, entityY, c, s,
        Collider.polyVertexX, Collider.polyVertexY,
        Collider.polyNormalX, Collider.polyNormalY,
        count, base, rayLength
      );
    }

    const entityX = tx + ox;
    const entityY = ty + oy;
    if (shapeType === Ray.SHAPE_CIRCLE) {
      return rayCircleIntersect(
        rayX, rayY, dirX, dirY, entityX, entityY, Collider.radius[entityIndex], rayLength
      );
    }
    if (shapeType === Ray.SHAPE_BOX) {
      return rayBoxIntersect(
        rayX, rayY, dirX, dirY,
        entityX, entityY, Collider.width[entityIndex], Collider.height[entityIndex], rayLength
      );
    }
    return -1;
  }

  /**
   * H1: Collect hits into a top-N buffer (closest maxHits only), deduped via generation stamp.
   * @private
   */
  static _collectCellHitsTopN(cellIndex, rayX, rayY, dirX, dirY, rayLength, allHits, rayMask, maxHits) {
    const count = Grid.getCellCount(cellIndex);
    if (count === 0) return;

    const cellBase = Grid.getCellBase(cellIndex);
    const gridEntities = Grid._gridEntities;
    const active = Transform.active;
    const colliderActive = Collider.active;
    const cCollisionLayer = Collider.collisionLayer;
    const stamp = Ray._rayGenStamp;
    const gen = Ray._rayGen;

    for (let i = 0; i < count; i++) {
      const entityIndex = gridEntities[cellBase + i];

      if (stamp[entityIndex] === gen) continue;
      stamp[entityIndex] = gen;

      if (!active[entityIndex]) continue;
      if (!colliderActive[entityIndex]) continue;
      if (!((1 << (cCollisionLayer[entityIndex] & 31)) & rayMask)) continue;

      const shapeMax =
        Ray._tempAllHitsCount >= maxHits && Ray._tempAllHitsFarthest >= 0
          ? Ray._tempAllHitsFarthest
          : rayLength;
      const distance = Ray._shapeRayDistance(entityIndex, rayX, rayY, dirX, dirY, shapeMax);
      if (distance < 0) continue;

      let hitCount = Ray._tempAllHitsCount;
      if (hitCount < maxHits) {
        let hit = allHits[hitCount];
        if (!hit) {
          hit = { entityIndex: -1, distance: 0 };
          allHits[hitCount] = hit;
        }
        hit.entityIndex = entityIndex;
        hit.distance = distance;
        Ray._tempAllHitsCount = hitCount + 1;
        if (distance > Ray._tempAllHitsFarthest) Ray._tempAllHitsFarthest = distance;
      } else if (distance < Ray._tempAllHitsFarthest) {
        let worst = 0;
        let worstDist = allHits[0].distance;
        for (let h = 1; h < maxHits; h++) {
          const d = allHits[h].distance;
          if (d > worstDist) {
            worstDist = d;
            worst = h;
          }
        }
        allHits[worst].entityIndex = entityIndex;
        allHits[worst].distance = distance;
        let far = allHits[0].distance;
        for (let h = 1; h < maxHits; h++) {
          const d = allHits[h].distance;
          if (d > far) far = d;
        }
        Ray._tempAllHitsFarthest = far;
      }
    }
  }

  /**
   * Internal: Collect ALL hits in a cell (for castAll)
   * @private
   */
  static _collectCellHits(cellIndex, rayX, rayY, dirX, dirY, rayLength, checkedEntities, allHits, rayMask = 0xFFFFFFFF) {
    const count = Grid.getCellCount(cellIndex);
    if (count === 0) return;

    const cellBase = Grid.getCellBase(cellIndex);
    const gridEntities = Grid._gridEntities;

    const active = Transform.active;
    const colliderActive = Collider.active;
    const cCollisionLayer = Collider.collisionLayer;

    const stamp = Ray._rayGenStamp;
    const gen = Ray._rayGen;

    for (let i = 0; i < count; i++) {
      const entityIndex = gridEntities[cellBase + i];

      if (stamp[entityIndex] === gen) continue;
      stamp[entityIndex] = gen;

      if (!active[entityIndex]) continue;
      if (!colliderActive[entityIndex]) continue;
      if (!((1 << (cCollisionLayer[entityIndex] & 31)) & rayMask)) continue;

      const distance = Ray._shapeRayDistance(entityIndex, rayX, rayY, dirX, dirY, rayLength);

      if (distance >= 0) {
        const hitIndex = Ray._tempAllHitsCount++;
        let hit = allHits[hitIndex];
        if (!hit) {
          hit = { entityIndex: -1, distance: 0 };
          allHits[hitIndex] = hit;
        }
        hit.entityIndex = entityIndex;
        hit.distance = distance;
      }
    }
  }

  /**
   * Check all entities in a cell for ray collision
   * Mutates Ray._tempResult with entity index and distance, or {-1, Infinity} if no hit
   * @private
   */
  static _checkCellEntities(
    cellIndex,
    rayX,
    rayY,
    dirX,
    dirY,
    rayLength,
    currentClosest,
    excludeEntities = null,
    rayMask = 0xFFFFFFFF,
    excludeA = -1,
    excludeB = -1
  ) {
    Ray._tempResult.entityIndex = -1;
    Ray._tempResult.distance = Infinity;

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

    const useScalarExclude = excludeA >= 0 || excludeB >= 0;
    let excludeSet = null;
    let excludeArr = null;
    if (!useScalarExclude && excludeEntities) {
      if (excludeEntities instanceof Set) excludeSet = excludeEntities;
      else if (Array.isArray(excludeEntities)) excludeArr = excludeEntities;
    }

    for (let i = 0; i < count; i++) {
      const entityIndex = gridEntities[cellBase + i];

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
      const shapeMax = closestDist < rayLength ? closestDist : rayLength;
      const distance = Ray._shapeRayDistance(entityIndex, rayX, rayY, dirX, dirY, shapeMax);

      // Track closest hit in this cell
      if (distance >= 0 && distance < closestDist) {
        closestDist = distance;
        closestIndex = entityIndex;
      }
    }

    Ray._tempResult.entityIndex = closestIndex;
    Ray._tempResult.distance = closestDist;
  }
}
