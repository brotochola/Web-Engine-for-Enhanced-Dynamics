// Ray.js - Raycasting system using spatial grid
// Uses DDA (Digital Differential Analyzer) to traverse only cells the ray passes through
// Now uses Grid class for spatial data and utils for geometric intersections

import { Transform } from '../components/Transform.js';
import { Collider } from '../components/Collider.js';
import { Grid } from './Grid.js';
import { rayCircleIntersect, rayBoxIntersect } from './utils.js';

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
 *   - castWithInfo(x1, y1, x2, y2, maxDist, mask, out)  → { hit, entityIndex, distance, hitX, hitY }
 *   - castAll(x1, y1, x2, y2, maxDist, maxHits, mask, out) → Array<{ entityIndex, distance, hitX, hitY }>
 *   - linecast(x1, y1, x2, y2, exclude, mask, out)      → { blocked, entityIndex, distance }
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
  // Shape type constants (must match Collider.js)
  static SHAPE_CIRCLE = 0;
  static SHAPE_BOX = 1;

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
  static _checkedEntities = new Set(); // Reused Set for castAll
  static _traverseResult = { entityIndex: -1, distance: Infinity }; // Reused by _traverseGrid

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
    let closestDist = maxDist;

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
    const result = out || Ray._tempLinecastResult;
    result.blocked = false;
    result.entityIndex = -1;
    result.distance = Infinity;

    const dx = x2 - x1;
    const dy = y2 - y1;
    const distSq = dx * dx + dy * dy; // OPTIMIZED: Calculate distSq first

    if (distSq === 0) {
      return result;
    }

    // Calculate length only if we pass the early exit (OPTIMIZED: avoid sqrt in early exit path)
    const rayLength = Math.sqrt(distSq);

    const dirX = dx / rayLength;
    const dirY = dy / rayLength;

    // Use traversal with exclusion set
    const hitResult = Ray._traverseGrid(
      x1,
      y1,
      x2,
      y2,
      dirX,
      dirY,
      rayLength,
      rayLength,
      excludeEntities,
      mask
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
  // Static reusable Set for zero-allocation linecast between entities
  static _excludeSet = new Set();

  static linecastBetweenEntities(entityIndexA, entityIndexB, mask = 0xFFFFFFFF, out = null) {
    const x1 = Transform.x[entityIndexA];
    const y1 = Transform.y[entityIndexA];
    const x2 = Transform.x[entityIndexB];
    const y2 = Transform.y[entityIndexB];

    Ray._excludeSet.clear();
    Ray._excludeSet.add(entityIndexA);
    Ray._excludeSet.add(entityIndexB);

    return Ray.linecast(x1, y1, x2, y2, Ray._excludeSet, mask, out);
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
    return !Ray.linecastBetweenEntities(entityIndexA, entityIndexB, mask).blocked;
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
    const outHits = out || Ray._tempHitsArray;
    outHits.length = 0;
    Ray._tempAllHitsArray.length = 0;
    Ray._tempAllHitsCount = 0;
    Ray._checkedEntities.clear();

    const dx = xTo - xFrom;
    const dy = yTo - yFrom;
    const distSq = dx * dx + dy * dy; // OPTIMIZED: Calculate distSq first for early exit check

    // Early exit if ray is too short or too long (avoid sqrt if possible)
    if (distSq === 0 || (maxDist !== Infinity && distSq > maxDist * maxDist)) {
      return outHits;
    }

    // Calculate length only if we pass the early exit (OPTIMIZED: avoid sqrt in early exit path)
    const rayLength = Math.sqrt(distSq);

    const dirX = dx / rayLength;
    const dirY = dy / rayLength;

    // Get grid params
    const invCellSize = Grid.invCellSize;
    const gridCols = Grid.gridWidth;
    const gridRows = Grid.gridHeight;
    const cellSize = Grid.cellSize;

    // Collect all hits across the entire ray path
    const checkedEntities = Ray._checkedEntities;
    const allHits = Ray._tempAllHitsArray;

    // DDA setup
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

    // Traverse all cells
    while (steps++ < maxSteps) {
      if (
        currentCellX >= 0 &&
        currentCellX < gridCols &&
        currentCellY >= 0 &&
        currentCellY < gridRows
      ) {
        const cellIndex = currentCellY * gridCols + currentCellX;

        // Check all entities in this cell
        Ray._collectCellHits(
          cellIndex,
          xFrom,
          yFrom,
          dirX,
          dirY,
          rayLength,
          checkedEntities,
          allHits,
          mask
        );
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

    // Finalize hit list and sort by distance
    allHits.length = Ray._tempAllHitsCount;
    allHits.sort((a, b) => a.distance - b.distance);

    // Copy to output array (limited by maxHits)
    const count = Math.min(allHits.length, maxHits);
    for (let i = 0; i < count; i++) {
      const hit = allHits[i];
      let out = outHits[i];
      if (!out) {
        out = {
          entityIndex: -1,
          distance: 0,
          hitX: 0,
          hitY: 0,
        };
        outHits[i] = out;
      }
      out.entityIndex = hit.entityIndex;
      out.distance = hit.distance;
      out.hitX = xFrom + dirX * hit.distance;
      out.hitY = yFrom + dirY * hit.distance;
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
    rayMask = 0xFFFFFFFF
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
          rayMask
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
   * Internal: Collect ALL hits in a cell (for castAll)
   * @private
   */
  static _collectCellHits(cellIndex, rayX, rayY, dirX, dirY, rayLength, checkedEntities, allHits, rayMask = 0xFFFFFFFF) {
    const count = Grid.getCellEntityCount(cellIndex);
    if (count === 0) return;

    const cellBase = Grid.getCellBase(cellIndex);
    const gridEntities = Grid._gridEntities;

    const active = Transform.active;
    const colliderActive = Collider.active;
    const tx = Transform.x;
    const ty = Transform.y;
    const cOffsetX = Collider.offsetX;
    const cOffsetY = Collider.offsetY;
    const cRadius = Collider.radius;
    const cWidth = Collider.width;
    const cHeight = Collider.height;
    const cShapeParams = Collider.shapeType;
    const cCollisionLayer = Collider.collisionLayer;

    for (let i = 0; i < count; i++) {
      const entityIndex = gridEntities[cellBase + i];

      if (checkedEntities.has(entityIndex)) continue;
      checkedEntities.add(entityIndex);

      if (!active[entityIndex]) continue;
      if (!colliderActive[entityIndex]) continue;
      if (!((1 << (cCollisionLayer[entityIndex] & 31)) & rayMask)) continue;

      const entityX = tx[entityIndex] + (cOffsetX[entityIndex] || 0);
      const entityY = ty[entityIndex] + (cOffsetY[entityIndex] || 0);
      const shapeType = cShapeParams[entityIndex];

      let distance = -1;

      if (shapeType === Ray.SHAPE_CIRCLE) {
        const radius = cRadius[entityIndex];
        distance = rayCircleIntersect(rayX, rayY, dirX, dirY, entityX, entityY, radius, rayLength);
      } else if (shapeType === Ray.SHAPE_BOX) {
        const width = cWidth[entityIndex];
        const height = cHeight[entityIndex];
        distance = rayBoxIntersect(
          rayX,
          rayY,
          dirX,
          dirY,
          entityX,
          entityY,
          width,
          height,
          rayLength
        );
      }

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
    rayMask = 0xFFFFFFFF
  ) {
    Ray._tempResult.entityIndex = -1;
    Ray._tempResult.distance = Infinity;

    const count = Grid.getCellEntityCount(cellIndex);
    if (count === 0) {
      return;
    }

    const cellBase = Grid.getCellBase(cellIndex);
    const gridEntities = Grid._gridEntities;

    const active = Transform.active;
    const colliderActive = Collider.active;
    const tx = Transform.x;
    const ty = Transform.y;
    const cOffsetX = Collider.offsetX;
    const cOffsetY = Collider.offsetY;
    const cRadius = Collider.radius;
    const cWidth = Collider.width;
    const cHeight = Collider.height;
    const cShapeParams = Collider.shapeType;
    const cCollisionLayer = Collider.collisionLayer;

    let closestIndex = -1;
    let closestDist = currentClosest;

    for (let i = 0; i < count; i++) {
      const entityIndex = gridEntities[cellBase + i];

      if (excludeEntities) {
        if (excludeEntities instanceof Set) {
          if (excludeEntities.has(entityIndex)) continue;
        } else if (Array.isArray(excludeEntities)) {
          if (excludeEntities.includes(entityIndex)) continue;
        }
      }

      if (!active[entityIndex]) continue;
      if (!colliderActive[entityIndex]) continue;
      if (!((1 << (cCollisionLayer[entityIndex] & 31)) & rayMask)) continue;

      // Get entity collider position
      const entityX = tx[entityIndex] + (cOffsetX[entityIndex] || 0);
      const entityY = ty[entityIndex] + (cOffsetY[entityIndex] || 0);
      const shapeType = cShapeParams[entityIndex];

      let distance = -1;

      // Check collision based on shape type using utils functions
      if (shapeType === Ray.SHAPE_CIRCLE) {
        const radius = cRadius[entityIndex];
        distance = rayCircleIntersect(rayX, rayY, dirX, dirY, entityX, entityY, radius, rayLength);
      } else if (shapeType === Ray.SHAPE_BOX) {
        const width = cWidth[entityIndex];
        const height = cHeight[entityIndex];
        distance = rayBoxIntersect(
          rayX,
          rayY,
          dirX,
          dirY,
          entityX,
          entityY,
          width,
          height,
          rayLength
        );
      }

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
