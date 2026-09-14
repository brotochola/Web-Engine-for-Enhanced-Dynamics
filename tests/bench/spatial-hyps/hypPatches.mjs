/**
 * Apply / restore patches for spatial_worker hypothesis campaign.
 * Each hyp mutates working tree files from snapshotted baselines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

export const PATHS = {
  spatial: path.join(repoRoot, 'src/workers/spatialWorker.js'),
  balls: path.join(repoRoot, 'demos/ballsScene/ballsScene.js'),
  predator: path.join(repoRoot, 'demos/predatorScene/predatorScene.js'),
  baselineSpatial: path.join(here, 'baselineSpatialWorker.js'),
  baselineBalls: path.join(here, 'baselineBallsScene.js'),
  baselinePredator: path.join(here, 'baselinePredatorScene.js'),
};

export function restoreAll() {
  fs.copyFileSync(PATHS.baselineSpatial, PATHS.spatial);
  fs.copyFileSync(PATHS.baselineBalls, PATHS.balls);
  fs.copyFileSync(PATHS.baselinePredator, PATHS.predator);
}

function readSpatial() {
  return fs.readFileSync(PATHS.baselineSpatial, 'utf8');
}

function writeSpatial(src) {
  fs.writeFileSync(PATHS.spatial, src);
}

function mustInclude(src, needle, hyp) {
  if (!src.includes(needle)) throw new Error(`${hyp}: patch anchor missing: ${needle.slice(0, 80)}`);
}

function replaceOnce(src, from, to, hyp) {
  mustInclude(src, from, hyp);
  const out = src.replace(from, to);
  if (out === src) throw new Error(`${hyp}: replace had no effect`);
  return out;
}

function setSpatialCellSize(filePath, cellSize) {
  const src = fs.readFileSync(filePath, 'utf8');
  const spatialBlock = /spatial:\s*\{[\s\S]*?\n\s*\},/;
  const m = src.match(spatialBlock);
  if (!m) throw new Error(`spatial block not found in ${filePath}`);
  const patchedBlock = m[0].replace(/cellSize:\s*\d+/, `cellSize: ${cellSize}`);
  fs.writeFileSync(filePath, src.replace(spatialBlock, patchedBlock));
}

function setPredatorMaxNeighbors(n) {
  const src = fs.readFileSync(PATHS.baselinePredator, 'utf8');
  const spatialBlock = /spatial:\s*\{[\s\S]*?\n\s*\},/;
  const m = src.match(spatialBlock);
  if (!m) throw new Error('predator spatial block missing');
  const patched = m[0].replace(/maxNeighbors:\s*\d+/, `maxNeighbors: ${n}`);
  fs.writeFileSync(PATHS.predator, src.replace(spatialBlock, patched));
}

/** H1: skip re-insert into cells marked sleeping (keep prior SAB contents). */
function applyH1() {
  let s = readSpatial();
  s = replaceOnce(
    s,
    `    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;

      for (let col = 0; col < gridWidth; col++) {
        const cellIndex = rowBase + col;
        localCounts[cellIndex] = 0;
        localHashes[cellIndex] = 2166136261;
      }
    }`,
    `    const cellSleeping = Grid._cellSleepingData;
    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;

      for (let col = 0; col < gridWidth; col++) {
        const cellIndex = rowBase + col;
        if (cellSleeping && cellSleeping[cellIndex] === 1) {
          // H1: keep prior membership for sleeping cells
          localCounts[cellIndex] = gridCounts[cellIndex * Grid.cellByteSize];
          localHashes[cellIndex] = this._cellHashes[cellIndex] || 2166136261;
          continue;
        }
        localCounts[cellIndex] = 0;
        localHashes[cellIndex] = 2166136261;
      }
    }`,
    'H1'
  );
  s = replaceOnce(
    s,
    `      if (!colliderActive[i] && !spriteRendererActive[i]) continue;

      let posX;`,
    `      if (!colliderActive[i] && !spriteRendererActive[i]) continue;

      // H1: entities only touching sleeping cells are still inserted via preserved counts;
      // we still insert movers into non-sleeping cells below.

      let posX;`,
    'H1'
  );
  s = replaceOnce(
    s,
    `        for (let col = minCol; col <= maxColBB; col++) {
          const cellIndex = rowBase + col;
          const localCount = localCounts[cellIndex];

          if (localCount < Grid.maxEntitiesPerCell) {
            gridEntities[Grid.getCellBase(cellIndex) + localCount] = i;
            localCounts[cellIndex] = localCount + 1;
            localHashes[cellIndex] = Math.imul(localHashes[cellIndex] ^ (i + 1), 16777619) >>> 0;
          }
        }`,
    `        for (let col = minCol; col <= maxColBB; col++) {
          const cellIndex = rowBase + col;
          if (cellSleeping && cellSleeping[cellIndex] === 1) continue;
          const localCount = localCounts[cellIndex];

          if (localCount < Grid.maxEntitiesPerCell) {
            gridEntities[Grid.getCellBase(cellIndex) + localCount] = i;
            localCounts[cellIndex] = localCount + 1;
            localHashes[cellIndex] = Math.imul(localHashes[cellIndex] ^ (i + 1), 16777619) >>> 0;
          }
        }`,
    'H1'
  );
  writeSpatial(s);
}

/** H2: full rebuild every 8 frames; otherwise only re-insert moved bodies. */
function applyH2() {
  let s = readSpatial();
  s = replaceOnce(
    s,
    `import { getColliderBounds, getCellRange, _boundsResult, _cellRangeResult } from '../util/colliderUtils.js';`,
    `import { getColliderBounds, getCellRange, _boundsResult, _cellRangeResult } from '../util/colliderUtils.js';
import { getMovedBodiesViews } from './box2dMovedBodies.js';`,
    'H2'
  );
  s = replaceOnce(
    s,
    `    this.neighborsReusedThisFrame = 0;

  }`,
    `    this.neighborsReusedThisFrame = 0;
    this._rebuildFrameCounter = 0;
    this._movedScratch = null;

  }`,
    'H2'
  );
  s = replaceOnce(
    s,
    `  rebuildOwnedRows() {
    const x = Transform.x;
    const y = Transform.y;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;
    const colliderActive = Collider.active;
    const spriteRendererActive = SpriteRenderer.active;

    const gridWidth = this.gridWidth;
    const invCellSize = this.invCellSize;
    const workerId = this.workerId;

    const entityPosData = this.entityPosData;
    const gridCounts = Grid._gridCounts;
    const gridEntities = Grid._gridEntities;

    const maxCol = gridWidth - 1;
    const maxRow = this.gridHeight - 1;

    const ownedRows = this.ownedRows;
    const ownedRowCount = this.ownedRowCount;
    const rowOwnership = this.rowOwnership;

    const localCounts = this._localCellCounts;
    const localHashes = this._localCellHashes;

    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;

      for (let col = 0; col < gridWidth; col++) {
        const cellIndex = rowBase + col;
        localCounts[cellIndex] = 0;
        localHashes[cellIndex] = 2166136261;
      }
    }

    const activeEntitiesData = this.activeEntitiesData;
    const totalActiveEntities = activeEntitiesData ? activeEntitiesData[0] : 0;

    for (let activeIdx = 0; activeIdx < totalActiveEntities; activeIdx++) {
      const i = activeEntitiesData[1 + activeIdx];`,
    `  rebuildOwnedRows() {
    const x = Transform.x;
    const y = Transform.y;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;
    const colliderActive = Collider.active;
    const spriteRendererActive = SpriteRenderer.active;

    const gridWidth = this.gridWidth;
    const invCellSize = this.invCellSize;
    const workerId = this.workerId;

    const entityPosData = this.entityPosData;
    const gridCounts = Grid._gridCounts;
    const gridEntities = Grid._gridEntities;

    const maxCol = gridWidth - 1;
    const maxRow = this.gridHeight - 1;

    const ownedRows = this.ownedRows;
    const ownedRowCount = this.ownedRowCount;
    const rowOwnership = this.rowOwnership;

    const localCounts = this._localCellCounts;
    const localHashes = this._localCellHashes;

    this._rebuildFrameCounter++;
    const movers = getMovedBodiesViews();
    const forceFull = (this._rebuildFrameCounter & 7) === 1 || !movers || movers.count <= 0;
    let iterateList = null;
    let iterateCount = 0;
    if (forceFull) {
      const activeEntitiesData = this.activeEntitiesData;
      iterateCount = activeEntitiesData ? activeEntitiesData[0] : 0;
      iterateList = activeEntitiesData;
    } else {
      // H2: only re-insert movers; seed local counts from previous published grid
      for (let r = 0; r < ownedRowCount; r++) {
        const row = ownedRows[r];
        const rowBase = row * gridWidth;
        for (let col = 0; col < gridWidth; col++) {
          const cellIndex = rowBase + col;
          const byteOffset = cellIndex * Grid.cellByteSize;
          const prevCount = gridCounts[byteOffset];
          localCounts[cellIndex] = 0;
          localHashes[cellIndex] = 2166136261;
          const cellEntityBase = Grid.getCellBase(cellIndex);
          for (let k = 0; k < prevCount; k++) {
            const ent = gridEntities[cellEntityBase + k];
            if (movers.movedBits[ent]) continue; // drop movers; re-insert below
            if (localCounts[cellIndex] < Grid.maxEntitiesPerCell) {
              const lc = localCounts[cellIndex];
              gridEntities[cellEntityBase + lc] = ent;
              localCounts[cellIndex] = lc + 1;
              localHashes[cellIndex] = Math.imul(localHashes[cellIndex] ^ (ent + 1), 16777619) >>> 0;
            }
          }
        }
      }
      iterateCount = movers.count;
      iterateList = null;
      if (!this._movedScratch || this._movedScratch.length < iterateCount) {
        this._movedScratch = new Uint32Array(Math.max(iterateCount, 64));
      }
      for (let mi = 0; mi < iterateCount; mi++) this._movedScratch[mi] = movers.movedList[mi];
    }

    if (forceFull) {
      for (let r = 0; r < ownedRowCount; r++) {
        const row = ownedRows[r];
        const rowBase = row * gridWidth;
        for (let col = 0; col < gridWidth; col++) {
          const cellIndex = rowBase + col;
          localCounts[cellIndex] = 0;
          localHashes[cellIndex] = 2166136261;
        }
      }
    }

    for (let activeIdx = 0; activeIdx < iterateCount; activeIdx++) {
      const i = forceFull ? iterateList[1 + activeIdx] : this._movedScratch[activeIdx];`,
    'H2'
  );
  writeSpatial(s);
}

/** H3: Verlet-style reuse skin = 0.25 * visualRange */
function applyH3() {
  let s = readSpatial();
  s = replaceOnce(
    s,
    `  _canReuseNeighbors(entityId, myX, myY, myHalfExtent, myVisualRange, entityCellIndex, cellRadius, dependencyHash) {
    return (
      this._entityReuseInitialized[entityId] === 1 &&
      this._entityLastX[entityId] === myX &&
      this._entityLastY[entityId] === myY &&
      this._entityLastHalfExtent[entityId] === myHalfExtent &&
      this._entityLastVisualRange[entityId] === myVisualRange &&
      this._entityLastCellIndex[entityId] === entityCellIndex &&
      this._entityLastCellRadius[entityId] === cellRadius &&
      this._entityLastDependencyHash[entityId] === dependencyHash
    );
  }`,
    `  _canReuseNeighbors(entityId, myX, myY, myHalfExtent, myVisualRange, entityCellIndex, cellRadius, dependencyHash) {
    if (this._entityReuseInitialized[entityId] !== 1) return false;
    if (this._entityLastHalfExtent[entityId] !== myHalfExtent) return false;
    if (this._entityLastVisualRange[entityId] !== myVisualRange) return false;
    if (this._entityLastCellIndex[entityId] !== entityCellIndex) return false;
    if (this._entityLastCellRadius[entityId] !== cellRadius) return false;
    if (this._entityLastDependencyHash[entityId] !== dependencyHash) return false;
    // H3: Verlet-like positional skin (25% of visualRange)
    const skin = myVisualRange * 0.25;
    const skinSq = skin * skin;
    const dx = myX - this._entityLastX[entityId];
    const dy = myY - this._entityLastY[entityId];
    return dx * dx + dy * dy <= skinSq;
  }`,
    'H3'
  );
  writeSpatial(s);
}

/** H4: tighter cellRadius without +1 overshoot */
function applyH4() {
  let s = readSpatial();
  s = replaceOnce(
    s,
    `          // Calculate cell search radius (bitwise ceiling - avoids Math.ceil overhead in hot path)
          // Using (x | 0) + 1 always rounds up, may add one extra cell ring but negligible impact
          const cellRadius = ((myVisualRange * invCellSize) | 0) + 1;`,
    `          // H4: ceil without forced +1 overshoot
          const cellRadiusRaw = myVisualRange * invCellSize;
          const cellRadiusFloor = cellRadiusRaw | 0;
          const cellRadius = cellRadiusRaw > cellRadiusFloor ? cellRadiusFloor + 1 : cellRadiusFloor;`,
    'H4'
  );
  writeSpatial(s);
}

/** H5: dependency hash samples every 2nd neighbor cell */
function applyH5() {
  let s = readSpatial();
  s = replaceOnce(
    s,
    `  _computeDependencyHash(neighborCells) {
    const versions = Grid._cellVersionData;
    if (!versions) return 0;

    let hash = 2166136261;
    for (let i = 0; i < neighborCells.length; i++) {
      const cellIndex = neighborCells[i];
      hash = Math.imul(hash ^ versions[cellIndex], 16777619) >>> 0;
    }
    return hash;
  }`,
    `  _computeDependencyHash(neighborCells) {
    const versions = Grid._cellVersionData;
    if (!versions) return 0;

    let hash = 2166136261;
    // H5: sample every 2nd cell (cheaper; slightly coarser invalidation)
    const len = neighborCells.length;
    for (let i = 0; i < len; i += 2) {
      const cellIndex = neighborCells[i];
      hash = Math.imul(hash ^ versions[cellIndex], 16777619) >>> 0;
    }
    if (len > 0) {
      hash = Math.imul(hash ^ versions[neighborCells[len - 1]], 16777619) >>> 0;
    }
    return hash;
  }`,
    'H5'
  );
  writeSpatial(s);
}

/** H6: inline circle bounds in rebuild */
function applyH6() {
  let s = readSpatial();
  s = replaceOnce(
    s,
    `import { getColliderBounds, getCellRange, _boundsResult, _cellRangeResult } from '../util/colliderUtils.js';`,
    `import { getColliderBounds, getCellRange, _boundsResult, _cellRangeResult, SHAPE_CIRCLE } from '../util/colliderUtils.js';`,
    'H6'
  );
  s = replaceOnce(
    s,
    `      if (colliderActive[i]) {
        getColliderBounds(i, _boundsResult);
        posX = _boundsResult.posX;
        posY = _boundsResult.posY;
        halfW = _boundsResult.halfW;
        halfH = _boundsResult.halfH;
      } else {
        posX = x[i] + offsetX[i];
        posY = y[i] + offsetY[i];
      }`,
    `      if (colliderActive[i]) {
        // H6: fast-path circles (Balls-dominated)
        if (Collider.shapeType[i] === SHAPE_CIRCLE) {
          const ox = offsetX[i] || 0;
          const oy = offsetY[i] || 0;
          posX = x[i] + ox;
          posY = y[i] + oy;
          const r = Collider.radius[i] || 0;
          halfW = r;
          halfH = r;
        } else {
          getColliderBounds(i, _boundsResult);
          posX = _boundsResult.posX;
          posY = _boundsResult.posY;
          halfW = _boundsResult.halfW;
          halfH = _boundsResult.halfH;
        }
      } else {
        posX = x[i] + offsetX[i];
        posY = y[i] + offsetY[i];
      }`,
    'H6'
  );
  writeSpatial(s);
}

/** H7: dense array neighbor-cell cache instead of Map */
function applyH7() {
  let s = readSpatial();
  s = replaceOnce(
    s,
    `    // Cached neighbor cells: (cellIndex * MAX_CELL_RADIUS + cellRadius) -> Uint16Array of neighbor cell indices
    // Uint16Array since cell indices are always positive and < 65535
    this._cellNeighborCache = new Map();
    this._maxNeighborCacheEntries = 8192;`,
    `    // H7: dense array cache keyed by cellIndex * (maxRadius+1) + cellRadius
    this._cellNeighborCacheDense = null;`,
    'H7'
  );
  s = replaceOnce(
    s,
    `    // Precompute circle patterns for all possible cellRadius values (0 to maxCellRadius)
    this._precomputeCirclePatterns();`,
    `    // Precompute circle patterns for all possible cellRadius values (0 to maxCellRadius)
    this._precomputeCirclePatterns();
    this._cellNeighborCacheDense = new Array(Math.max(1, this.totalCells * (this._maxCellRadius + 1)));`,
    'H7'
  );
  s = replaceOnce(
    s,
    `  _getNeighborCells(cellIndex, cellRadius, centerRow, centerCol) {
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
    const neighborCells = new Uint16Array(maxNeighborCells);
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
  }`,
    `  _getNeighborCells(cellIndex, cellRadius, centerRow, centerCol) {
    const clampedRadius = cellRadius > this._maxCellRadius ? this._maxCellRadius : cellRadius;
    const denseKey = cellIndex * (this._maxCellRadius + 1) + clampedRadius;
    const cached = this._cellNeighborCacheDense[denseKey];
    if (cached) return cached;

    const pattern = this._circlePatterns[clampedRadius];
    const patternLength = pattern.length;
    const maxNeighborCells = this._patternLengths[clampedRadius] || (patternLength >> 1);
    const neighborCells = new Uint16Array(maxNeighborCells);
    let count = 0;
    const gridWidth = this.gridWidth;
    const gridHeight = this.gridHeight;
    for (let i = 0; i < patternLength; i += 2) {
      const checkRow = centerRow + pattern[i];
      const checkCol = centerCol + pattern[i + 1];
      if (checkRow >= 0 && checkRow < gridHeight && checkCol >= 0 && checkCol < gridWidth) {
        neighborCells[count++] = checkRow * gridWidth + checkCol;
      }
    }
    const result = count === maxNeighborCells ? neighborCells : neighborCells.subarray(0, count);
    this._cellNeighborCacheDense[denseKey] = result;
    return result;
  }`,
    'H7'
  );
  writeSpatial(s);
}

/** H8: earlier visualRange<=0 skip (before homeCol / pattern) — already mostly present; skip entityPos halfExtent use for zero-range after ownership */
function applyH8() {
  let s = readSpatial();
  // Move visualRange check to immediately after ownership, before cellsChecked path — already there.
  // Strengthen: skip dependency hash / pattern by checking before any neighborCells fetch (already).
  // Extra: if visualRange<=0, don't increment entitiesProcessed for search accounting? Keep as-is.
  // Implement: check visualRange using Collider before reading entityPos when possible — unsafe for ownership.
  // Instead: batch-zero neighbor slots for owned home-row entities with vr=0 without pattern.
  s = replaceOnce(
    s,
    `          this.entitiesProcessedThisFrame++;

          const stampedA = processedFrameStamp | entityA;
          const myVisualRange = visualRange[entityA];

          // Neighbor write offset
          const neighborOffset = entityA * stride;

          // Skip entities with no visual range
          if (myVisualRange <= 0) {
            neighborData[neighborOffset] = 0; // totalCount
            continue;
          }`,
    `          const myVisualRange = visualRange[entityA];
          const neighborOffset = entityA * stride;

          // H8: skip zero-range before counting as processed search work
          if (myVisualRange <= 0) {
            neighborData[neighborOffset] = 0;
            continue;
          }

          this.entitiesProcessedThisFrame++;
          const stampedA = processedFrameStamp | entityA;`,
    'H8'
  );
  writeSpatial(s);
}

/** H9: Predator maxNeighbors 512 + ensure early exit (already has break) */
function applyH9() {
  fs.copyFileSync(PATHS.baselineSpatial, PATHS.spatial);
  setPredatorMaxNeighbors(512);
}

/** H10: iterate active entities by home-row ownership instead of all owned cells */
function applyH10() {
  let s = readSpatial();
  s = replaceOnce(
    s,
    `    // =========================================================================
    // Iterate through all owned cells
    // =========================================================================
    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;

      for (let col = 0; col < gridWidth; col++) {
        const cellIndex = rowBase + col;
        const byteOffset = cellIndex * Grid.cellByteSize;
        const cellCount = gridCounts[byteOffset];

        // Skip empty cells
        if (cellCount === 0) continue;

        // Process each entity in this cell
        const cellEntityBase = Grid.getCellBase(cellIndex);

        for (let k = 0; k < cellCount; k++) {
          const entityA = gridEntities[cellEntityBase + k];

          // Sanity check (shouldn't happen but safety)
          if (!active[entityA]) continue;

          // O(1) deduplication: skip if this entity was already processed this frame
          // (entity can appear in multiple cells due to bounding box spanning cells)
          if (entityProcessedMarker[entityA] === entityFrameMarker) continue;
          entityProcessedMarker[entityA] = entityFrameMarker;

          // =====================================================================
          // ENTITY OWNERSHIP CHECK: Only process if this worker owns entity's home row
          // This prevents race conditions when entities span multiple rows
          // Home row = row containing entity's center Y position
          // =====================================================================
          // Read perfectly contiguous cache (built immediately prior by this worker)
          const baseIdxA = entityA * 4;
          const myX = entityPosData[baseIdxA];
          const myY = entityPosData[baseIdxA + 1];
          const myHalfExtent = entityPosData[baseIdxA + 2];

          let homeRow = (myY * invCellSize) | 0;
          // Clamp to grid bounds
          homeRow = homeRow < 0 ? 0 : homeRow > maxRow ? maxRow : homeRow;

          // Skip if another worker owns this entity's home row (O(1) lookup)
          if (rowOwnership[homeRow] !== workerId) continue;

          this.entitiesProcessedThisFrame++;

          const stampedA = processedFrameStamp | entityA;
          const myVisualRange = visualRange[entityA];`,
    `    // H10: iterate active list; only home-row-owned entities
    const activeEntitiesData = this.activeEntitiesData;
    const totalActiveEntities = activeEntitiesData ? activeEntitiesData[0] : 0;
    for (let activeIdx = 0; activeIdx < totalActiveEntities; activeIdx++) {
          const entityA = activeEntitiesData[1 + activeIdx];

          if (!active[entityA]) continue;

          if (entityProcessedMarker[entityA] === entityFrameMarker) continue;
          entityProcessedMarker[entityA] = entityFrameMarker;

          const baseIdxA = entityA * 4;
          let myX = entityPosData[baseIdxA];
          let myY = entityPosData[baseIdxA + 1];
          let myHalfExtent = entityPosData[baseIdxA + 2];
          // If this worker never wrote entityPos (entity not in owned rows), derive from Transform
          if (myX === 0 && myY === 0 && !Collider.active[entityA] && !SpriteRenderer.active[entityA]) continue;
          if (!(myX === myX) || (myX === 0 && myY === 0 && Transform.x[entityA] !== 0)) {
            myX = Transform.x[entityA] + (Collider.offsetX[entityA] || 0);
            myY = Transform.y[entityA] + (Collider.offsetY[entityA] || 0);
            myHalfExtent = Collider.radius[entityA] || 0;
            entityPosData[baseIdxA] = myX;
            entityPosData[baseIdxA + 1] = myY;
            entityPosData[baseIdxA + 2] = myHalfExtent;
          }

          let homeRow = (myY * invCellSize) | 0;
          homeRow = homeRow < 0 ? 0 : homeRow > maxRow ? maxRow : homeRow;
          if (rowOwnership[homeRow] !== workerId) continue;

          this.entitiesProcessedThisFrame++;

          const stampedA = processedFrameStamp | entityA;
          const myVisualRange = visualRange[entityA];`,
    'H10'
  );
  // Close the loops: remove extra closing braces from old cell iteration
  s = replaceOnce(
    s,
          `          );
        }
      }
    }
  }`,
    `          );
    }
  }`,
    'H10'
  );
  writeSpatial(s);
}

/** H11: skip entityB when entityPos looks unset (0,0) and Transform inactive mismatch — refresh B from Transform if same worker wrote nothing */
function applyH11() {
  let s = readSpatial();
  s = replaceOnce(
    s,
    `              const baseIdxB = entityB * 4;
              const bX = entityPosData[baseIdxB];
              const bY = entityPosData[baseIdxB + 1];
              const bHalfExtent = entityPosData[baseIdxB + 2];

              const dxAB = bX - myX;
              const dyAB = bY - myY;
              const distSq = dxAB * dxAB + dyAB * dyAB;`,
    `              const baseIdxB = entityB * 4;
              let bX = entityPosData[baseIdxB];
              let bY = entityPosData[baseIdxB + 1];
              let bHalfExtent = entityPosData[baseIdxB + 2];
              // H11: if B pos never published (cross-worker), fall back to Transform
              if (bX === 0 && bY === 0) {
                const tx = Transform.x[entityB];
                const ty = Transform.y[entityB];
                if (tx !== 0 || ty !== 0) {
                  bX = tx + (Collider.offsetX[entityB] || 0);
                  bY = ty + (Collider.offsetY[entityB] || 0);
                  bHalfExtent = Collider.radius[entityB] || 0;
                }
              }

              const dxAB = bX - myX;
              const dyAB = bY - myY;
              const distSq = dxAB * dxAB + dyAB * dyAB;`,
    'H11'
  );
  writeSpatial(s);
}

/** H12: pack cell index via bit shift when gridWidth is power of two; else keep mul — use shift for rowBase when possible */
function applyH12() {
  let s = readSpatial();
  // Add gridWidthShift in initialize
  s = replaceOnce(
    s,
    `    this.gridWidth = gridMetadata.gridCols;
    this.gridHeight = gridMetadata.gridRows;
    this.totalCells = gridMetadata.totalCells;`,
    `    this.gridWidth = gridMetadata.gridCols;
    this.gridHeight = gridMetadata.gridRows;
    this.totalCells = gridMetadata.totalCells;
    // H12: pack helper — shift if power-of-two width
    this._gridWidthShift = (this.gridWidth & (this.gridWidth - 1)) === 0
      ? Math.log2(this.gridWidth) | 0
      : -1;`,
    'H12'
  );
  s = replaceOnce(
    s,
    `          const entityCellIndex = homeRow * gridWidth + homeCol;`,
    `          // H12: pack when width is power of two
          const entityCellIndex = this._gridWidthShift >= 0
            ? (homeRow << this._gridWidthShift) | homeCol
            : homeRow * gridWidth + homeCol;`,
    'H12'
  );
  writeSpatial(s);
}

/** H13: stagger neighbor search for visualRange >= 300 (every 2nd frame) */
function applyH13() {
  let s = readSpatial();
  s = replaceOnce(
    s,
    `    this.neighborsReusedThisFrame = 0;

  }`,
    `    this.neighborsReusedThisFrame = 0;
    this._neighborFrameCounter = 0;

  }`,
    'H13'
  );
  s = replaceOnce(
    s,
    `    // Frame counter for entityA deduplication (avoids fill() every frame)
    this._entityFrameCounter++;
    const entityFrameMarker = this._entityFrameCounter;
    const entityProcessedMarker = this._entityProcessedMarker;`,
    `    // Frame counter for entityA deduplication (avoids fill() every frame)
    this._entityFrameCounter++;
    this._neighborFrameCounter++;
    const entityFrameMarker = this._entityFrameCounter;
    const entityProcessedMarker = this._entityProcessedMarker;
    const staggerPhase = this._neighborFrameCounter & 1;`,
    'H13'
  );
  s = replaceOnce(
    s,
    `          // Skip entities with no visual range
          if (myVisualRange <= 0) {
            neighborData[neighborOffset] = 0; // totalCount
            continue;
          }

          // Calculate cell search radius`,
    `          // Skip entities with no visual range
          if (myVisualRange <= 0) {
            neighborData[neighborOffset] = 0; // totalCount
            continue;
          }

          // H13: stagger large visualRange casters (lights/houses)
          if (myVisualRange >= 300 && ((entityA + staggerPhase) & 1) === 1) {
            continue; // keep previous neighborData
          }

          // Calculate cell search radius`,
    'H13'
  );
  writeSpatial(s);
}

/** H14: Morton-reorder active list every 8 frames before rebuild (expected reject) */
function applyH14() {
  let s = readSpatial();
  s = replaceOnce(
    s,
    `    this.neighborsReusedThisFrame = 0;

  }`,
    `    this.neighborsReusedThisFrame = 0;
    this._mortonFrame = 0;
    this._mortonOrder = null;

  }`,
    'H14'
  );
  s = replaceOnce(
    s,
    `    const activeEntitiesData = this.activeEntitiesData;
    const totalActiveEntities = activeEntitiesData ? activeEntitiesData[0] : 0;

    for (let activeIdx = 0; activeIdx < totalActiveEntities; activeIdx++) {
      const i = activeEntitiesData[1 + activeIdx];`,
    `    const activeEntitiesData = this.activeEntitiesData;
    let totalActiveEntities = activeEntitiesData ? activeEntitiesData[0] : 0;

    // H14: periodic Morton reorder of active list (cache experiment)
    this._mortonFrame++;
    if (activeEntitiesData && totalActiveEntities > 1 && (this._mortonFrame & 7) === 1) {
      if (!this._mortonOrder || this._mortonOrder.length < totalActiveEntities) {
        this._mortonOrder = new Uint32Array(totalActiveEntities);
      }
      const morton = (x, y) => {
        const spread = (v) => {
          v = (v | (v << 8)) & 0x00FF00FF;
          v = (v | (v << 4)) & 0x0F0F0F0F;
          v = (v | (v << 2)) & 0x33333333;
          v = (v | (v << 1)) & 0x55555555;
          return v >>> 0;
        };
        return (spread(x & 0xFF) | (spread(y & 0xFF) << 1)) >>> 0;
      };
      const tmp = new Array(totalActiveEntities);
      for (let a = 0; a < totalActiveEntities; a++) {
        const id = activeEntitiesData[1 + a];
        const cx = (Transform.x[id] * this.invCellSize) | 0;
        const cy = (Transform.y[id] * this.invCellSize) | 0;
        tmp[a] = { id, m: morton(cx, cy) };
      }
      tmp.sort((u, v) => u.m - v.m);
      for (let a = 0; a < totalActiveEntities; a++) activeEntitiesData[1 + a] = tmp[a].id;
    }

    for (let activeIdx = 0; activeIdx < totalActiveEntities; activeIdx++) {
      const i = activeEntitiesData[1 + activeIdx];`,
    'H14'
  );
  writeSpatial(s);
}

/** H15: static alternate cellSize 96 both scenes */
function applyH15() {
  fs.copyFileSync(PATHS.baselineSpatial, PATHS.spatial);
  setSpatialCellSize(PATHS.balls, 96);
  setSpatialCellSize(PATHS.predator, 96);
}

export const HYPS = [
  { id: 'H1', title: 'Skip rebuild of sleeping cells', apply: applyH1 },
  { id: 'H2', title: 'Incremental rebuild via movedBodies', apply: applyH2 },
  { id: 'H3', title: 'Verlet-style neighbor reuse skin 0.25*vr', apply: applyH3 },
  { id: 'H4', title: 'Tighter cellRadius without +1 overshoot', apply: applyH4 },
  { id: 'H5', title: 'Sampled dependency hash (stride 2)', apply: applyH5 },
  { id: 'H6', title: 'Circle fast-path in rebuild', apply: applyH6 },
  { id: 'H7', title: 'Dense array neighbor-cell cache', apply: applyH7 },
  { id: 'H8', title: 'Earlier visualRange==0 skip', apply: applyH8 },
  { id: 'H9', title: 'Predator maxNeighbors 1024→512', apply: applyH9 },
  { id: 'H10', title: 'Iterate actives by home-row ownership', apply: applyH10 },
  { id: 'H11', title: 'Transform fallback for cross-worker B pos', apply: applyH11 },
  { id: 'H12', title: 'Pack cell index when width power-of-two', apply: applyH12 },
  { id: 'H13', title: 'Stagger large visualRange searches', apply: applyH13 },
  { id: 'H14', title: 'Periodic Morton reorder of actives', apply: applyH14 },
  { id: 'H15', title: 'Static cellSize=96 both scenes', apply: applyH15 },
];

export function applyHyp(id) {
  restoreAll();
  const hyp = HYPS.find((h) => h.id === id);
  if (!hyp) throw new Error(`Unknown hyp ${id}`);
  hyp.apply();
  return hyp;
}
