// Ray.js - Raycasting system using spatial grid
// Uses DDA (Digital Differential Analyzer) to traverse only cells the ray passes through
// Now uses Grid class for spatial data and utils for geometric intersections

import { Transform } from "../components/Transform.js";
import { Collider } from "../components/Collider.js";
import { Grid } from "./Grid.js";
import { rayCircleIntersect, rayBoxIntersect } from "./utils.js";
import { DEBUG_FLAGS } from "./DebugFlags.js";

/**
 * Ray - Static class for raycasting against entities in the spatial grid
 *
 * Methods:
 *   - cast(x1, y1, x2, y2, maxDist)         → entityIndex or -1
 *   - castWithInfo(x1, y1, x2, y2, maxDist) → { hit, entityIndex, distance, hitX, hitY }
 *   - castAll(x1, y1, x2, y2, maxDist, max) → Array<{ entityIndex, distance, hitX, hitY }>
 *   - linecast(x1, y1, x2, y2, exclude)     → { blocked, entityIndex, distance }
 *   - linecastBetweenEntities(a, b)         → { blocked, entityIndex, distance }
 *   - hasLineOfSight(a, b)                  → boolean (true if clear)
 *
 * @example Basic raycast
 *   const hit = Ray.cast(player.x, player.y, mouseX, mouseY);
 *   if (hit !== -1) damageEntity(hit);
 *
 * @example Line of sight check
 *   if (Ray.hasLineOfSight(enemy, player)) {
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

  // Debug visualization
  static debugFlags = null; // DebugFlags instance (Uint8Array)
  static debugBuffer = null; // Float32Array - stores raycast visualization data
  static maxDebugRaycasts = 100;

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

  /**
   * Initialize Ray system with debug buffers
   * Grid data is accessed via Grid class (initialized separately by AbstractWorker)
   *
   * @param {SharedArrayBuffer} debugFlagsBuffer - Debug flags buffer
   * @param {SharedArrayBuffer} debugBuffer - Raycast visualization buffer
   * @param {number} maxDebugRaycasts - Max raycasts to store for debug
   */
  static initialize(
    debugFlagsBuffer = null,
    debugBuffer = null,
    maxDebugRaycasts = 100
  ) {
    // Debug visualization
    if (debugFlagsBuffer) {
      Ray.debugFlags = new Uint8Array(debugFlagsBuffer);
    }
    if (debugBuffer) {
      Ray.debugBuffer = new Float32Array(debugBuffer);
      Ray.maxDebugRaycasts = maxDebugRaycasts;
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
   * @returns {number} Entity index or -1
   */
  static cast(xFrom, yFrom, xTo, yTo, maxDist = Infinity) {
    // Calculate ray direction and length
    const dx = xTo - xFrom;
    const dy = yTo - yFrom;
    const rayLength = Math.sqrt(dx * dx + dy * dy);

    // Early exit if ray is too short or too long
    if (rayLength === 0 || rayLength > maxDist) {
      // Still log debug data for miss
      if (Ray._isDebugEnabled()) {
        Ray._addDebugRaycast(xFrom, yFrom, xTo, yTo, xTo, yTo, false);
      }
      return -1;
    }

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
        (stepX > 0
          ? Math.floor(xFrom * invCellSize) + 1
          : Math.ceil(xFrom * invCellSize) - 1) * cellSize;
      tMaxX = Math.abs((nextBoundaryX - xFrom) / dirX);
    } else {
      tMaxX = Infinity;
    }

    if (dirY !== 0) {
      const nextBoundaryY =
        (stepY > 0
          ? Math.floor(yFrom * invCellSize) + 1
          : Math.ceil(yFrom * invCellSize) - 1) * cellSize;
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
        // Optimization: _checkCellEntities mutates static _tempResult to avoid GC
        Ray._checkCellEntities(
          cellIndex,
          xFrom,
          yFrom,
          dirX,
          dirY,
          rayLength,
          closestDist
        );

        const result = Ray._tempResult;

        if (result.entityIndex !== -1) {
          closestHit = result.entityIndex;
          closestDist = result.distance;

          // Calculate hit point
          const hitX = xFrom + dirX * closestDist;
          const hitY = yFrom + dirY * closestDist;

          // Log debug data
          if (Ray._isDebugEnabled()) {
            Ray._addDebugRaycast(xFrom, yFrom, xTo, yTo, hitX, hitY, true);
          }

          // Early exit - we found a hit in this cell
          // Continue to check remaining cells in case there's a closer hit
        }
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

    // If we found a hit, we already logged debug data
    if (closestHit !== -1 && closestDist !== 0) {
      return closestHit;
    }

    // No hit - log debug data
    if (Ray._isDebugEnabled()) {
      Ray._addDebugRaycast(xFrom, yFrom, xTo, yTo, xTo, yTo, false);
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
   * @returns {Object} { hit: boolean, entityIndex: number, distance: number, hitX: number, hitY: number }
   *
   * @example
   *   const result = Ray.castWithInfo(player.x, player.y, targetX, targetY);
   *   if (result.hit) {
   *     spawnBulletHole(result.hitX, result.hitY);
   *     damageEntity(result.entityIndex);
   *   }
   */
  static castWithInfo(xFrom, yFrom, xTo, yTo, maxDist = Infinity) {
    // Reset temp result
    const info = Ray._tempHitInfo;
    info.hit = false;
    info.entityIndex = -1;
    info.distance = Infinity;
    info.hitX = xTo;
    info.hitY = yTo;

    // Calculate ray direction and length
    const dx = xTo - xFrom;
    const dy = yTo - yFrom;
    const rayLength = Math.sqrt(dx * dx + dy * dy);

    // Early exit if ray is too short or too long
    if (rayLength === 0 || rayLength > maxDist) {
      if (Ray._isDebugEnabled()) {
        Ray._addDebugRaycast(xFrom, yFrom, xTo, yTo, xTo, yTo, false);
      }
      return info;
    }

    // Normalize direction
    const dirX = dx / rayLength;
    const dirY = dy / rayLength;

    // Use internal traversal
    const result = Ray._traverseGrid(
      xFrom,
      yFrom,
      xTo,
      yTo,
      dirX,
      dirY,
      rayLength,
      maxDist
    );

    if (result.entityIndex !== -1) {
      info.hit = true;
      info.entityIndex = result.entityIndex;
      info.distance = result.distance;
      info.hitX = xFrom + dirX * result.distance;
      info.hitY = yFrom + dirY * result.distance;

      if (Ray._isDebugEnabled()) {
        Ray._addDebugRaycast(
          xFrom,
          yFrom,
          xTo,
          yTo,
          info.hitX,
          info.hitY,
          true
        );
      }
    } else {
      if (Ray._isDebugEnabled()) {
        Ray._addDebugRaycast(xFrom, yFrom, xTo, yTo, xTo, yTo, false);
      }
    }

    return info;
  }

  /**
   * Check if there's a clear line of sight between two points
   * Returns true if BLOCKED (something in the way), false if clear
   *
   * @param {number} x1 - Start point X
   * @param {number} y1 - Start point Y
   * @param {number} x2 - End point X
   * @param {number} y2 - End point Y
   * @param {Set<number>|Array<number>} excludeEntities - Optional entity indices to ignore
   * @returns {Object} { blocked: boolean, entityIndex: number (-1 if clear), distance: number }
   *
   * @example
   *   // Check if enemy can shoot player
   *   const los = Ray.linecast(enemy.x, enemy.y, player.x, player.y);
   *   if (!los.blocked) {
   *     // Clear shot!
   *     enemy.shoot(player);
   *   }
   */
  static linecast(x1, y1, x2, y2, excludeEntities = null) {
    const result = Ray._tempLinecastResult;
    result.blocked = false;
    result.entityIndex = -1;
    result.distance = Infinity;

    const dx = x2 - x1;
    const dy = y2 - y1;
    const rayLength = Math.sqrt(dx * dx + dy * dy);

    if (rayLength === 0) {
      return result;
    }

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
      excludeEntities
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
   * @returns {Object} { blocked: boolean, entityIndex: number (-1 if clear), distance: number }
   *
   * @example
   *   // Can predator see prey?
   *   const los = Ray.linecastBetweenEntities(predatorIdx, preyIdx);
   *   if (!los.blocked) {
   *     // Predator has line of sight to prey
   *     predator.chase(preyIdx);
   *   }
   */
  static linecastBetweenEntities(entityIndexA, entityIndexB) {
    // Get positions of both entities
    const x1 = Transform.x[entityIndexA];
    const y1 = Transform.y[entityIndexA];
    const x2 = Transform.x[entityIndexB];
    const y2 = Transform.y[entityIndexB];

    // Create exclusion set with both entities
    const exclude = new Set([entityIndexA, entityIndexB]);

    return Ray.linecast(x1, y1, x2, y2, exclude);
  }

  /**
   * Check if entity A has clear line of sight to entity B
   * Convenience method that returns just a boolean
   *
   * @param {number} entityIndexA - Source entity index
   * @param {number} entityIndexB - Target entity index
   * @returns {boolean} true if clear line of sight, false if blocked
   */
  static hasLineOfSight(entityIndexA, entityIndexB) {
    return !Ray.linecastBetweenEntities(entityIndexA, entityIndexB).blocked;
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
   * @returns {Array<{entityIndex: number, distance: number, hitX: number, hitY: number}>}
   *   Note: returned array and hit objects are reused on the next call.
   *
   * @example
   *   // Penetrating railgun shot
   *   const hits = Ray.castAll(gun.x, gun.y, targetX, targetY, Infinity, 5);
   *   for (const hit of hits) {
   *     damageEntity(hit.entityIndex, railgunDamage * (1 - hit.distance / maxRange));
   *     spawnBulletHole(hit.hitX, hit.hitY);
   *   }
   */
  static castAll(xFrom, yFrom, xTo, yTo, maxDist = Infinity, maxHits = 10) {
    // Clear and reuse the temp array
    Ray._tempHitsArray.length = 0;
    Ray._tempAllHitsArray.length = 0;
    Ray._tempAllHitsCount = 0;
    Ray._checkedEntities.clear();

    const dx = xTo - xFrom;
    const dy = yTo - yFrom;
    const rayLength = Math.sqrt(dx * dx + dy * dy);

    if (rayLength === 0 || rayLength > maxDist) {
      return Ray._tempHitsArray;
    }

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
        (stepX > 0
          ? Math.floor(xFrom * invCellSize) + 1
          : Math.ceil(xFrom * invCellSize) - 1) * cellSize;
      tMaxX = Math.abs((nextBoundaryX - xFrom) / dirX);
    } else {
      tMaxX = Infinity;
    }

    if (dirY !== 0) {
      const nextBoundaryY =
        (stepY > 0
          ? Math.floor(yFrom * invCellSize) + 1
          : Math.ceil(yFrom * invCellSize) - 1) * cellSize;
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
          allHits
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
    const outHits = Ray._tempHitsArray;
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

    // Debug visualization for first hit
    if (Ray._isDebugEnabled()) {
      if (Ray._tempHitsArray.length > 0) {
        const firstHit = Ray._tempHitsArray[0];
        Ray._addDebugRaycast(
          xFrom,
          yFrom,
          xTo,
          yTo,
          firstHit.hitX,
          firstHit.hitY,
          true
        );
      } else {
        Ray._addDebugRaycast(xFrom, yFrom, xTo, yTo, xTo, yTo, false);
      }
    }

    return Ray._tempHitsArray;
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
    excludeEntities = null
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
        (stepX > 0
          ? Math.floor(xFrom * invCellSize) + 1
          : Math.ceil(xFrom * invCellSize) - 1) * cellSize;
      tMaxX = Math.abs((nextBoundaryX - xFrom) / dirX);
    } else {
      tMaxX = Infinity;
    }

    if (dirY !== 0) {
      const nextBoundaryY =
        (stepY > 0
          ? Math.floor(yFrom * invCellSize) + 1
          : Math.ceil(yFrom * invCellSize) - 1) * cellSize;
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
          excludeEntities
        );

        const result = Ray._tempResult;

        if (result.entityIndex !== -1) {
          closestHit = result.entityIndex;
          closestDist = result.distance;
        }
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

    return { entityIndex: closestHit, distance: closestDist };
  }

  /**
   * Internal: Collect ALL hits in a cell (for castAll)
   * @private
   */
  static _collectCellHits(
    cellIndex,
    rayX,
    rayY,
    dirX,
    dirY,
    rayLength,
    checkedEntities,
    allHits
  ) {
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

    for (let i = 0; i < count; i++) {
      const entityIndex = gridEntities[cellBase + i];

      // Skip already checked entities (may appear in multiple cells)
      if (checkedEntities.has(entityIndex)) continue;
      checkedEntities.add(entityIndex);

      if (!active[entityIndex]) continue;
      if (!colliderActive[entityIndex]) continue;

      const entityX = tx[entityIndex] + (cOffsetX[entityIndex] || 0);
      const entityY = ty[entityIndex] + (cOffsetY[entityIndex] || 0);
      const shapeType = cShapeParams[entityIndex];

      let distance = -1;

      if (shapeType === Ray.SHAPE_CIRCLE) {
        const radius = cRadius[entityIndex];
        distance = rayCircleIntersect(
          rayX,
          rayY,
          dirX,
          dirY,
          entityX,
          entityY,
          radius,
          rayLength
        );
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
    excludeEntities = null
  ) {
    // Reset temp result
    Ray._tempResult.entityIndex = -1;
    Ray._tempResult.distance = Infinity;

    const count = Grid.getCellEntityCount(cellIndex);
    if (count === 0) {
      return;
    }

    const cellBase = Grid.getCellBase(cellIndex);
    const gridEntities = Grid._gridEntities;

    // CACHE: Component arrays to avoid property lookups in loop
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

    let closestIndex = -1;
    let closestDist = currentClosest;

    // Check all entities in this cell
    for (let i = 0; i < count; i++) {
      const entityIndex = gridEntities[cellBase + i];

      // Skip excluded entities (for linecast between entities)
      if (excludeEntities) {
        if (excludeEntities instanceof Set) {
          if (excludeEntities.has(entityIndex)) continue;
        } else if (Array.isArray(excludeEntities)) {
          if (excludeEntities.includes(entityIndex)) continue;
        }
      }

      // Skip inactive entities
      if (!active[entityIndex]) continue;
      if (!colliderActive[entityIndex]) continue;

      // Get entity collider position
      const entityX = tx[entityIndex] + (cOffsetX[entityIndex] || 0);
      const entityY = ty[entityIndex] + (cOffsetY[entityIndex] || 0);
      const shapeType = cShapeParams[entityIndex];

      let distance = -1;

      // Check collision based on shape type using utils functions
      if (shapeType === Ray.SHAPE_CIRCLE) {
        const radius = cRadius[entityIndex];
        distance = rayCircleIntersect(
          rayX,
          rayY,
          dirX,
          dirY,
          entityX,
          entityY,
          radius,
          rayLength
        );
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

  /**
   * Check if debug visualization is enabled
   * @private
   */
  static _isDebugEnabled() {
    return Ray.debugFlags && Ray.debugFlags[DEBUG_FLAGS.SHOW_RAYCASTS] === 1;
  }

  /**
   * Add raycast to debug buffer for visualization
   * @private
   */
  static _addDebugRaycast(startX, startY, endX, endY, hitX, hitY, didHit) {
    if (!Ray.debugBuffer) return;

    // Get current count (index 0)
    const count = Ray.debugBuffer[0];

    // Circular buffer - wrap around if full
    const index = Math.floor(count % Ray.maxDebugRaycasts);

    // Write raycast data (7 floats per raycast)
    // Layout: startX, startY, endX, endY, hitX, hitY, hit
    const offset = 1 + index * 7;
    Ray.debugBuffer[offset] = startX;
    Ray.debugBuffer[offset + 1] = startY;
    Ray.debugBuffer[offset + 2] = endX;
    Ray.debugBuffer[offset + 3] = endY;
    Ray.debugBuffer[offset + 4] = hitX;
    Ray.debugBuffer[offset + 5] = hitY;
    Ray.debugBuffer[offset + 6] = didHit ? 1 : 0;

    // Increment count (capped at maxDebugRaycasts for renderer to know limit)
    Ray.debugBuffer[0] = Math.min(count + 1, Ray.maxDebugRaycasts);
  }

  /**
   * Clear all debug raycasts (call at start of frame)
   * This is now called by pixi_worker at the start of each render frame
   */
  static clearDebugRaycasts() {
    if (Ray.debugBuffer) {
      Ray.debugBuffer[0] = 0; // Reset count
    }
  }
}
