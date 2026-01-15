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
 * Usage:
 *   const hitEntityIndex = Ray.cast(fromX, fromY, toX, toY, maxDistance);
 *   if (hitEntityIndex !== -1) {
 *     // Ray hit entity at index hitEntityIndex
 *   }
 */
export class Ray {
  // Shape type constants (must match Collider.js)
  static SHAPE_CIRCLE = 0;
  static SHAPE_BOX = 1;

  // Debug visualization
  static debugFlags = null; // DebugFlags instance (Uint8Array)
  static debugBuffer = null; // Float32Array - stores raycast visualization data
  static maxDebugRaycasts = 100;

  // GC Optimization: Reusable object for _checkCellEntities result
  static _tempResult = { entityIndex: -1, distance: Infinity };

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
    const gridCols = Grid.gridCols;
    const gridRows = Grid.gridRows;
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
    currentClosest
  ) {
    // Reset temp result
    Ray._tempResult.entityIndex = -1;
    Ray._tempResult.distance = Infinity;

    const count = Grid.getCellEntityCount(cellIndex);
    if (count === 0) {
      return;
    }

    const cellBase = Grid.getCellBase(cellIndex);
    const gridEntities = Grid.gridEntities;

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
