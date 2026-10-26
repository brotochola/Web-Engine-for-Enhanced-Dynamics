// The spatial neighbour search in JavaScript: SpatialWorker.findNeighborsForOwnedEntities, its _getNeighborCells and the
// JS range filter of _publishFilteredNeighbors, as the spatial worker ran them until spatialGather.wasm and
// spatialPublish.wasm (E-76 W5, E-78) became its only search. Kept as the parity reference the kernels are tested
// against (WASM_HYPOTHESES L12), and the subject of the search's semantic tests; the engine does not use it.
//
// spatialJsClass(Base, { publish }) gives the worker class these methods, the search going through them: publish 'js'
// filters in JS into the rows (the old plain buffers' path), 'kernel' queues each entity for the kernel publish (the
// old wasm.spatialGather off). The methods are spelled and indented as they were in the worker, so source patches
// (methodVariant.mjs) still apply.
import { Collider } from '../../src/components/collider.js';
import { Transform } from '../../src/components/transform.js';
import { Grid } from '../../src/core/grid.js';
import { packSpatialPairStamp, SPATIAL_STAMP_FRAME_MASK } from '../../src/util/entityIdWidth.js';

class SpatialJsMethods {
  /**
   * Get cached neighbor cells for a cell+radius combination, or generate and cache it
   * @param {number} cellIndex - Source cell index
   * @param {number} cellRadius - Search radius in cells
   * @param {number} centerRow - Center row of the entity's cell
   * @param {number} centerCol - Center column of the entity's cell
   * @returns {Uint16Array|Uint32Array} Neighbor cell indices
   */
  _getNeighborCells(cellIndex, cellRadius, centerRow, centerCol) {
    const clampedRadius = cellRadius > this._maxCellRadius ? this._maxCellRadius : cellRadius;
    // Cache key: cellIndex * MAX_RADIUS + cellRadius
    const cacheKey = cellIndex * (this._maxCellRadius + 1) + clampedRadius;

    // Single lookup avoids an extra Map probe in the hot path.
    const cached = this._cellNeighborCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Generate neighbor cells from pattern
    const pattern = this._circlePatterns[clampedRadius];
    const patternLength = pattern.length;
    const maxNeighborCells = this._patternLengths[clampedRadius] || (patternLength >> 1);

    // Pre-allocate array (worst case: all cells in pattern are valid)
    const neighborCells = new this._cellIndexArray(maxNeighborCells);
    let count = 0;

    const gridWidth = this.gridWidth;
    const gridHeight = this.gridHeight;

    for (let i = 0; i < patternLength; i += 2) {
      const dr = pattern[i];
      const dc = pattern[i + 1];

      const checkRow = centerRow + dr;
      const checkCol = centerCol + dc;

      // Bounds check (optimized: check both axes in single condition)
      if (checkRow >= 0 && checkRow < gridHeight && checkCol >= 0 && checkCol < gridWidth) {
        neighborCells[count++] = checkRow * gridWidth + checkCol;
      }
    }

    // Return subarray if we didn't use full allocation (creates view, no copy)
    const result = count === maxNeighborCells
      ? neighborCells
      : neighborCells.subarray(0, count);

    // Bound cache growth: this memoization is only a performance hint.
    if (this._cellNeighborCache.size >= this._maxNeighborCacheEntries) {
      this._cellNeighborCache.clear();
    }
    this._cellNeighborCache.set(cacheKey, result);
    return result;
  }

  /**
   * Filter expanded candidate list into published neighborData at exact visualRange.
   * @returns {number} published count
   */
  _publishFilteredNeighbors(entityA, myX, myY, myVisualRange, neighborOffset, maxNeighbors, entityPosData, neighborData) {
    const candStride = 1 + maxNeighbors;
    const candBase = entityA * candStride;
    const cand = this._neighborCandidateData;
    const candCount = cand[candBase];
    let published = 0;
    for (let i = 0; i < candCount; i++) {
      const entityB = cand[candBase + 1 + i];
      const baseIdxB = entityB * 4;
      const bX = entityPosData[baseIdxB];
      const bY = entityPosData[baseIdxB + 1];
      const bHalfExtent = entityPosData[baseIdxB + 2];
      const dx = bX - myX;
      const dy = bY - myY;
      const effectiveRange = myVisualRange + bHalfExtent;
      if (dx * dx + dy * dy < effectiveRange * effectiveRange) {
        if (published < maxNeighbors) {
          neighborData[neighborOffset + 1 + published] = entityB;
          published++;
          this.neighborsFoundThisFrame++;
        }
      }
    }
    neighborData[neighborOffset] = published;
    return published;
  }

  findNeighborsForOwnedEntities() {
    const visualRange = Collider.visualRange;
    const active = Transform.active;

    const gridWidth = this.gridWidth;
    const gridHeight = this.gridHeight;
    const invCellSize = this.invCellSize;
    const maxNeighbors = Grid.maxNeighbors;
    const stride = Grid._stride;
    const cellStride = Grid._cellIdStride;
    const cellHeader = Grid._headerIds;
    const workerId = this.workerId;
    const skinFrac = this._neighborReuseSkin;
    const tickInterval = this._neighborTickInterval;
    const nextTick = this._entityNeighborNextTick;
    const maxReuseFrames = this._maxReuseFrames;
    const framesSinceBuild = this._entityFramesSinceBuild;
    const candStride = 1 + maxNeighbors;
    const candData = this._neighborCandidateData;
    const candCountOf = this._candidateCountOf;

    const neighborData = Grid.neighborData;
    const entityPosData = this.entityPosData;
    const gridCounts = Grid._gridCounts;
    const gridEntities = Grid._gridEntities;

    const processedMarker = this.processedMarker;
    this._processedFrameCounter++;
    if (this._processedFrameCounter > SPATIAL_STAMP_FRAME_MASK) {
      this._processedFrameCounter = 1;
      processedMarker.fill(0);
    }
    const stampFrame = this._processedFrameCounter;

    const maxRow = gridHeight - 1;

    // Built by rebuildOwnedRows this frame: each entity once, home row owned here.
    const ownedList = this._ownedEntityList;
    const ownedCount = this._ownedEntityCount;
    for (let oi = 0; oi < ownedCount; oi++) {
      const entityA = ownedList[oi];
      if (!active[entityA]) continue;

      const baseIdxA = entityA * 4;
      const myX = entityPosData[baseIdxA];
      const myY = entityPosData[baseIdxA + 1];
      const myHalfExtent = entityPosData[baseIdxA + 2];

      let homeRow = (myY * invCellSize) | 0;
      homeRow = homeRow < 0 ? 0 : homeRow > maxRow ? maxRow : homeRow;

      this.entitiesProcessedThisFrame++;

      const stampedA = packSpatialPairStamp(stampFrame, entityA);
      const myVisualRange = visualRange[entityA];
      const neighborOffset = entityA * stride;

      if (myVisualRange <= 0) {
        neighborData[neighborOffset] = 0;
        continue;
      }

      const skin = myVisualRange * skinFrac;
      const searchRange = myVisualRange + 2 * skin;

      let homeCol = (myX * invCellSize) | 0;
      const maxCol = gridWidth - 1;
      homeCol = homeCol < 0 ? 0 : homeCol > maxCol ? maxCol : homeCol;
      const entityCellIndex = homeRow * gridWidth + homeCol;
      const cellRadius = ((searchRange * invCellSize) | 0) + 1;

      // Schedule stagger: only ~1/tickInterval entities full-rebuild per frame
      let scheduleSkipRebuild = false;
      if (tickInterval > 1) {
        if (--nextTick[entityA] > 0) {
          scheduleSkipRebuild = true;
        } else {
          nextTick[entityA] = tickInterval;
        }
      }

      // True tickInterval: off-tick keeps last neighborData (no cell-walk, no re-filter).
      // Logic already decimates AI; stale neighbors for N frames is the point.
      if (
        scheduleSkipRebuild &&
        candCountOf[entityA] > 0 &&
        framesSinceBuild[entityA] < maxReuseFrames
      ) {
        this.neighborsReusedThisFrame++;
        framesSinceBuild[entityA]++;
        continue;
      }

      // Verlet skin reuse: re-filter expanded candidates into published set
      const skinCanReuse =
        skinFrac > 0 &&
        this._canReuseNeighbors(
          entityA,
          myX,
          myY,
          myHalfExtent,
          myVisualRange
        );

      if (skinCanReuse) {
        this.neighborsReusedThisFrame++;
        framesSinceBuild[entityA]++;
        this._publishFilteredNeighbors(
          entityA,
          myX,
          myY,
          myVisualRange,
          neighborOffset,
          maxNeighbors,
          entityPosData,
          neighborData
        );
      } else {
        const neighborCells = this._getNeighborCells(entityCellIndex, cellRadius, homeRow, homeCol);
        const neighborCellsLength = neighborCells.length;

        // Miss: rebuild expanded candidate list at searchRange
        const candBase = entityA * candStride;
        let candCount = 0;
        let truncated = false;
        const searchRangeWithExtentBase = searchRange;

        for (let i = 0; i < neighborCellsLength; i++) {
          const checkCellIndex = neighborCells[i];
          const checkByteOffset = checkCellIndex * Grid.cellByteSize;
          const checkCellCount = gridCounts[checkByteOffset];
          if (checkCellCount === 0) continue;

          this.cellsCheckedThisFrame++;
          const checkEntityBase = checkCellIndex * cellStride + cellHeader;

          for (let j = 0; j < checkCellCount; j++) {
            const entityB = gridEntities[checkEntityBase + j];
            if (entityA === entityB) continue;
            if (processedMarker[entityB] === stampedA) continue;
            processedMarker[entityB] = stampedA;

            const baseIdxB = entityB * 4;
            const bX = entityPosData[baseIdxB];
            const bY = entityPosData[baseIdxB + 1];
            const bHalfExtent = entityPosData[baseIdxB + 2];
            const dxAB = bX - myX;
            const dyAB = bY - myY;
            const effectiveRange = searchRangeWithExtentBase + bHalfExtent;
            if (dxAB * dxAB + dyAB * dyAB < effectiveRange * effectiveRange) {
              if (candCount < maxNeighbors) {
                candData[candBase + 1 + candCount] = entityB;
                candCount++;
              } else {
                truncated = true;
                break;
              }
            }
          }
          if (truncated) break;
        }

        candData[candBase] = candCount;
        candCountOf[entityA] = candCount;
        this._neighborCandidateTruncated[entityA] = truncated ? 1 : 0;

        this._publishFilteredNeighbors(
          entityA,
          myX,
          myY,
          myVisualRange,
          neighborOffset,
          maxNeighbors,
          entityPosData,
          neighborData
        );

        if (!truncated) {
          this._storeNeighborReuseSignature(entityA, myX, myY, myHalfExtent, myVisualRange);
        } else {
          // Skin reuse stays off (incomplete list), but schedule stagger needs age reset
          this._entityReuseInitialized[entityA] = 0;
          framesSinceBuild[entityA] = 0;
        }
      }
    }
    this._flushWasmPublish();
  }
}

/** The JS search's publish step with the kernel publishing: each entity queued for publish_batch. */
function queueForKernelPublish(entityA, myX, myY, myVisualRange) {
  this._wasmPub.range[entityA] = myVisualRange;
  this._wasmPub.list[this._wasmPub.queued++] = entityA;
  return 0;
}

/** The worker class with the JS search in place of the kernels' (`publish`: 'js' or 'kernel'). */
export function spatialJsClass(Base, { publish = 'js' } = {}) {
  class SpatialJs extends Base {
    constructor(...args) {
      super(...args);
      // _getNeighborCells' cache: cell index and radius to the cells' index list.
      this._cellIndexArray = Uint16Array;
      this._cellNeighborCache = new Map();
      this._maxNeighborCacheEntries = 8192;
    }

    _findNeighbors() {
      if (this.totalCells > 65535 && this._cellIndexArray !== Uint32Array) this._cellIndexArray = Uint32Array;
      this.findNeighborsForOwnedEntities();
    }
  }
  for (const name of ['_getNeighborCells', '_publishFilteredNeighbors', 'findNeighborsForOwnedEntities']) {
    Object.defineProperty(SpatialJs.prototype, name, Object.getOwnPropertyDescriptor(SpatialJsMethods.prototype, name));
  }
  if (publish === 'kernel') SpatialJs.prototype._publishFilteredNeighbors = queueForKernelPublish;
  else if (publish !== 'js') throw new Error(`spatialJsClass: publish ${publish}`);
  return SpatialJs;
}

/** The JS range filter alone, for a caller with `_neighborCandidateData` and `neighborsFoundThisFrame` on `this`. */
export const publishFilteredNeighborsJs = SpatialJsMethods.prototype._publishFilteredNeighbors;
