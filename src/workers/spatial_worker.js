self.postMessage({
  msg: "log",
  message: "js loaded",
  when: Date.now(),
});
// Spatial Worker - Builds spatial hash grid and finds neighbors
// Now uses per-entity visual ranges and accurate distance checking

// Import engine dependencies
import { GameObject } from "../core/gameObject.js";
import { Transform } from "../components/Transform.js";
import { Collider } from "../components/Collider.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { AbstractWorker } from "./AbstractWorker.js";
import { getCellIndex } from "../core/utils.js";

// Note: Spatial worker doesn't need game-specific entity classes
// It only works with GameObject and component arrays for spatial partitioning

/**
 * SpatialWorker - Handles spatial partitioning and neighbor detection
 * Uses a spatial hash grid to efficiently find nearby entities
 * Extends AbstractWorker for common worker functionality
 */
class SpatialWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Spatial worker is generic - doesn't need game-specific classes
    this.needsGameScripts = false;

    // Grid parameters - set during initialization
    this.cellSize = 0;
    this.gridCols = 0;
    this.gridRows = 0;
    this.totalCells = 0;
    this.maxNeighborsPerEntity = 0;

    // OPTIMIZED: Flat grid structure using pooled arrays for zero-allocation rebuilds
    // Structure: [cell0_count, cell0_entity0, cell0_entity1, ..., cell1_count, ...]
    // Each cell has a fixed size slot: 1 (count) + maxEntitiesPerCell
    this.gridData = null; // Int32Array for the flat grid
    this.maxEntitiesPerCell = 0; // Maximum entities per cell (computed from entity density)
    this.cellStride = 0; // Size of each cell slot (1 + maxEntitiesPerCell)

    // Update frequency (rebuild grid every N frames)
    this.spatialUpdateInterval = 2;

    // Collision pair sharing
    this.collisionData = null;
    this.maxCollisionPairs = 0;
    this.collisionPairCount = 0;
  }

  /**
   * Initialize spatial worker (implementation of AbstractWorker.initialize)
   */
  initialize(data) {
    // console.log("SPATIAL WORKER: Initializing with SharedArrayBuffer");

    // Initialize component arrays
    Transform.initializeArrays(
      data.buffers.componentData.Transform,
      this.entityCount
    );
    if (data.buffers.componentData.Collider) {
      Collider.initializeArrays(
        data.buffers.componentData.Collider,
        data.componentPools.Collider.count
      );
    }
    if (data.buffers.componentData.SpriteRenderer) {
      SpriteRenderer.initializeArrays(
        data.buffers.componentData.SpriteRenderer,
        data.componentPools.SpriteRenderer.count
      );
    }

    // Calculate grid parameters from config
    // Check spatial-specific config first, then fall back to root for backwards compatibility
    this.cellSize = this.config.spatial?.cellSize || this.config.cellSize;
    this.gridCols = Math.ceil(this.config.worldWidth / this.cellSize);
    this.gridRows = Math.ceil(this.config.worldHeight / this.cellSize);
    this.totalCells = this.gridCols * this.gridRows;
    this.maxNeighborsPerEntity =
      this.config.spatial?.maxNeighbors || this.config.maxNeighbors;

    // Store viewport dimensions for screen visibility checks
    this.canvasWidth = this.config.canvasWidth;
    this.canvasHeight = this.config.canvasHeight;

    // Calculate maxEntitiesPerCell based on entity density
    // Average density = entities / cells, then add 3x headroom for clustering
    const averageDensity = Math.ceil(this.entityCount / this.totalCells);
    this.maxEntitiesPerCell = Math.max(
      32, // Minimum per cell
      Math.min(256, averageDensity * 3) // 3x headroom, cap at 256
    );
    this.cellStride = 1 + this.maxEntitiesPerCell; // count + entities

    // OPTIMIZED: Flat grid structure - single Int32Array, zero allocation per frame
    // Layout: [cell0_count, cell0_ent0, cell0_ent1, ..., cell1_count, ...]
    const gridBufferSize = this.totalCells * this.cellStride;
    this.gridData = new Int32Array(gridBufferSize);

    console.log(
      `SPATIAL WORKER: Flat grid initialized - ${this.totalCells} cells, ` +
        `${this.maxEntitiesPerCell} max entities/cell, ` +
        `${((gridBufferSize * 4) / 1024 / 1024).toFixed(2)} MB`
    );

    // Initialize collision buffer view if provided
    if (data.buffers?.collisionData) {
      this.collisionData = new Int32Array(data.buffers.collisionData);
      this.maxCollisionPairs = (this.collisionData.length - 1) / 2;
      this.collisionData[0] = 0;
    }

    console.log(
      "SPATIAL WORKER: Initialization complete, waiting for start signal..."
    );
    // Note: Game loop will start when "start" message is received from main thread
  }

  /**
   * Get cell index from world position (delegates to utils.js)
   */
  getCellIndex(x, y) {
    return getCellIndex(x, y, this.cellSize, this.gridCols, this.gridRows);
  }

  /**
   * Clear and rebuild spatial grid
   * OPTIMIZED: Uses flat array structure with no allocations
   */
  rebuildGrid() {
    // Clear all cell counts (single linear pass, very cache-friendly)
    // We only need to zero the count field, not the entity data
    for (let cellIdx = 0; cellIdx < this.totalCells; cellIdx++) {
      this.gridData[cellIdx * this.cellStride] = 0;
    }

    // Insert only active entities into grid
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;

    for (let i = 0; i < this.entityCount; i++) {
      // Skip inactive entities - they don't participate in spatial queries
      if (!active[i]) continue;

      // Skip entities with invalid positions (race condition during initialization)
      const posX = x[i];
      const posY = y[i];
      if (isNaN(posX) || isNaN(posY)) continue;

      const cellIndex = this.getCellIndex(posX, posY);
      const cellOffset = cellIndex * this.cellStride;
      const count = this.gridData[cellOffset];

      // Check for cell overflow (rare, but handle gracefully)
      if (count >= this.maxEntitiesPerCell) {
        // Silently skip - cell is full. This is a design trade-off.
        // Could log warning once per frame if needed for debugging
        continue;
      }

      // Add entity to cell: [count, ent0, ent1, ...]
      this.gridData[cellOffset + 1 + count] = i;
      this.gridData[cellOffset]++; // Increment count
    }
  }

  /**
   * Find neighbors for all entities using spatial grid
   * Uses per-entity visual ranges and checks actual distances
   */
  findAllNeighbors() {
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const visualRange = Collider.visualRange;
    const radius = Collider.radius;

    if (this.collisionData) {
      this.collisionPairCount = 0;
    }

    for (let i = 0; i < this.entityCount; i++) {
      // Skip inactive entities - they don't need neighbor updates
      if (!active[i]) continue;

      // Skip entities with invalid positions
      if (isNaN(x[i]) || isNaN(y[i])) continue;

      this.findNeighborsForEntity(i, x, y, visualRange, radius);
    }

    if (this.collisionData) {
      this.collisionData[0] = this.collisionPairCount;
      // DEBUG: Log collision count occasionally
      if (this.frameCount % 60 === 0 && this.collisionPairCount > 0) {
        console.log(
          `[Spatial] Frame ${this.frameCount}: ${this.collisionPairCount} collision pairs detected`
        );
      }
    }
  }

  /**
   * Find neighbors for a single entity
   * Now also stores squared distances to eliminate duplicate calculations
   * OPTIMIZED: Uses flat grid structure for cache-friendly access
   */
  findNeighborsForEntity(i, x, y, visualRange, radius) {
    const myX = x[i];
    const myY = y[i];
    const myVisualRange = visualRange[i];
    const visualRangeSq = myVisualRange * myVisualRange;

    // Calculate how many cells we need to check based on visual range
    // If visual range is 25 and cell size is 50, we check 1 cell in each direction (3x3)
    // If visual range is 75 and cell size is 50, we check 2 cells in each direction (5x5)
    const cellRadius = Math.ceil(myVisualRange / this.cellSize);

    // Get entity's cell coordinates
    const col = Math.floor(myX / this.cellSize);
    const row = Math.floor(myY / this.cellSize);

    // Buffer offset for this entity's neighbor list
    const offset = i * (1 + this.maxNeighborsPerEntity);
    let neighborCount = 0;

    // Check grid cells within cellRadius
    for (let rowOffset = -cellRadius; rowOffset <= cellRadius; rowOffset++) {
      for (let colOffset = -cellRadius; colOffset <= cellRadius; colOffset++) {
        const checkCol = col + colOffset;
        const checkRow = row + rowOffset;

        // Skip if out of bounds
        if (
          checkCol < 0 ||
          checkCol >= this.gridCols ||
          checkRow < 0 ||
          checkRow >= this.gridRows
        ) {
          continue;
        }

        const cellIndex = checkRow * this.gridCols + checkCol;

        // OPTIMIZED: Read from flat grid structure
        const cellOffset = cellIndex * this.cellStride;
        const cellLength = this.gridData[cellOffset]; // First element is count

        // Skip empty cells - common case optimization
        if (cellLength === 0) continue;

        // Check all entities in this cell
        // Entities start at cellOffset + 1
        for (let k = 0; k < cellLength; k++) {
          const j = this.gridData[cellOffset + 1 + k];

          // Skip self
          if (i === j) continue;

          // Stop if we've hit the neighbor limit
          if (neighborCount >= this.maxNeighborsPerEntity) break;

          // Calculate squared distance (fixed variable names to avoid shadowing)
          const deltaX = x[j] - myX;
          const deltaY = y[j] - myY;
          const distSq = deltaX * deltaX + deltaY * deltaY;

          // Only add if within visual range (allow zero distance for stacked entities)
          if (distSq < visualRangeSq) {
            // Store both neighbor ID and squared distance
            this.neighborData[offset + 1 + neighborCount] = j;
            this.distanceData[offset + 1 + neighborCount] = distSq;
            neighborCount++;

            // Write collision pair if overlapping (spatial worker owns collision buffer now)
            if (
              this.collisionData &&
              j > i &&
              this.collisionPairCount < this.maxCollisionPairs
            ) {
              const radiusSum = radius[i] + radius[j];
              if (distSq < radiusSum * radiusSum) {
                const outIndex = 1 + this.collisionPairCount * 2;
                this.collisionData[outIndex] = i;
                this.collisionData[outIndex + 1] = j;
                this.collisionPairCount++;
                // DEBUG: Log first few collisions
                if (
                  this.collisionPairCount <= 3 &&
                  this.frameCount % 60 === 0
                ) {
                  const dist = Math.sqrt(distSq);
                  console.log(
                    `[Spatial] Collision: entity ${i} (radius ${
                      radius[i]
                    }) <-> entity ${j} (radius ${
                      radius[j]
                    }), dist=${dist.toFixed(2)}, minDist=${radiusSum}`
                  );
                }
              }
            }
          }
        }

        if (neighborCount >= this.maxNeighborsPerEntity) break;
      }
      if (neighborCount >= this.maxNeighborsPerEntity) break;
    }

    // Store neighbor count at the beginning (both buffers use same count)
    this.neighborData[offset] = neighborCount;
    this.distanceData[offset] = neighborCount;

    // ===== CACHE OPTIMIZATION: Sort neighbors by index =====
    // When game logic accesses component arrays (Transform.x[j], RigidBody.vx[j], etc.),
    // random neighbor indices cause cache thrashing. Sorting by index makes memory
    // access more sequential, dramatically improving cache hit rates.
    // Cost: O(n log n) sort vs. benefit: ~100 CPU cycles saved per cache miss avoided
    if (neighborCount > 1) {
      this.sortNeighborsByIndex(offset, neighborCount);
    }
  }

  /**
   * Sort neighbors by index for cache-friendly memory access
   * Uses insertion sort for small arrays (fast for n < 32)
   * Maintains parallel arrays: neighborData and distanceData stay in sync
   */
  sortNeighborsByIndex(offset, count) {
    const neighbors = this.neighborData;
    const distances = this.distanceData;
    const start = offset + 1; // Skip the count field

    // Insertion sort - optimal for small arrays, in-place, stable
    for (let i = 1; i < count; i++) {
      const neighborIdx = neighbors[start + i];
      const distVal = distances[start + i];

      let j = i - 1;
      // Shift elements that are greater than neighborIdx
      while (j >= 0 && neighbors[start + j] > neighborIdx) {
        neighbors[start + j + 1] = neighbors[start + j];
        distances[start + j + 1] = distances[start + j];
        j--;
      }
      neighbors[start + j + 1] = neighborIdx;
      distances[start + j + 1] = distVal;
    }
  }

  /**
   * Update isItOnScreen property for all entities
   * Checks if each entity's position is within the visible viewport
   * Uses the same transformation as pixi_worker.isSpriteVisible()
   */
  updateScreenVisibility() {
    if (!this.cameraData) return;

    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const isItOnScreen = SpriteRenderer.isItOnScreen;
    const screenX = SpriteRenderer.screenX;
    const screenY = SpriteRenderer.screenY;
    // Read camera data: [zoom, cameraX, cameraY]
    const zoom = this.cameraData[0];
    const cameraX = this.cameraData[1];
    const cameraY = this.cameraData[2];

    // Calculate screen margins (15% on each side)
    const marginX = this.canvasWidth * 0.1;
    const marginY = this.canvasHeight * 0.1;

    // Check all entities
    for (let i = 0; i < this.entityCount; i++) {
      // Only check active entities
      if (!active[i]) {
        isItOnScreen[i] = 0;
        continue;
      }

      // Transform world coordinates to screen coordinates
      // Same as pixi_worker.worldToScreenPosition()
      // mainContainer.x = -cameraX * zoom, so screenX = worldX * zoom + (-cameraX * zoom)
      screenX[i] = x[i] * zoom - cameraX * zoom;
      screenY[i] = y[i] * zoom - cameraY * zoom;

      // Check if screen position is within viewport bounds (with margin)
      // Same as pixi_worker.isSpriteVisible()
      const onScreen =
        screenX[i] > -marginX &&
        screenX[i] < this.canvasWidth + marginX &&
        screenY[i] > -marginY &&
        screenY[i] < this.canvasHeight + marginY;

      isItOnScreen[i] = onScreen ? 1 : 0;
    }
  }

  /**
   * Update method called each frame (implementation of AbstractWorker.update)
   */
  update(deltaTime, dtRatio, resuming) {
    // Rebuild spatial grid and find neighbors every frame for physics stability!
    // Was previously skipping frames which causes physics objects to "pass through" each other
    // if they move fast enough to cross cells in the skipped frames.
    this.rebuildGrid();
    this.findAllNeighbors();

    // Update screen visibility for all entities every frame
    this.updateScreenVisibility();
  }
}

// Create singleton instance and setup message handler
const spatialWorker = new SpatialWorker(self);
