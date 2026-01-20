self.postMessage({
    msg: "log",
    message: "nav_worker.js loaded",
    when: Date.now(),
});

// nav_worker.js - Dedicated navigation worker for pathfinding calculations
// Handles flowfield and A* computations in background
//
// Architecture:
// - Receives requests from logic workers via MessagePort
// - Computes flowfields (Dijkstra) and A* paths
// - Writes results to shared NavGrid SAB
// - Logic workers read results next frame

import { AbstractWorker } from "./AbstractWorker.js";
import { NavGrid, DIRECTION } from "../core/NavGrid.js";
import { NAVIGATION_STATS, createStatsWriter } from "./workers-utils.js";
import { getColliderBounds, getCellRange, _boundsResult, _cellRangeResult } from "../core/ColliderUtils.js";

/**
 * NavScratch - Reusable buffers for pathfinding algorithms
 * Single set per nav worker, reused across all calculations
 */
class NavScratch {
    constructor(totalCells, maxPathLength) {
        // Common buffers
        this.visited = new Uint8Array(totalCells);
        this.stamp = new Uint32Array(totalCells);
        this.currentStamp = 0;

        // Flowfield (Dijkstra) buffers
        this.distance = new Uint16Array(totalCells);
        this.direction = new Uint8Array(totalCells); // Output directions

        // Bucket queue for O(1) Dijkstra
        // Max distance is ~sqrt(totalCells) * 1.414 for diagonal, capped at 65535
        this.maxDistance = Math.min(65535, Math.ceil(Math.sqrt(totalCells) * 2));
        this.bucketQueue = new Array(this.maxDistance + 1);
        for (let i = 0; i <= this.maxDistance; i++) {
            this.bucketQueue[i] = [];
        }
        this.bucketHead = 0;
        this.bucketCount = 0;

        // A* buffers
        this.heapCell = new Uint32Array(totalCells);
        this.heapFCost = new Uint32Array(totalCells); // f = g + h
        this.heapGCost = new Uint32Array(totalCells);
        this.heapSize = 0;
        this.cameFrom = new Uint32Array(totalCells);
        this.inOpenSet = new Uint8Array(totalCells);
        this.pathResult = new Uint32Array(maxPathLength);
    }

    /**
     * Reset for new calculation using stamp technique (O(1) reset)
     */
    reset() {
        this.currentStamp++;
        // If stamp wraps around (very unlikely), do full reset
        if (this.currentStamp === 0) {
            this.stamp.fill(0);
            this.currentStamp = 1;
        }

        // Reset bucket queue
        this.bucketHead = 0;
        this.bucketCount = 0;

        // Reset A* heap
        this.heapSize = 0;
    }

    /**
     * Check if cell was visited this calculation
     */
    isVisited(cell) {
        return this.stamp[cell] === this.currentStamp;
    }

    /**
     * Mark cell as visited
     */
    markVisited(cell) {
        this.stamp[cell] = this.currentStamp;
    }
}

/**
 * NavWorker - Handles pathfinding calculations
 * Extends AbstractWorker for common worker functionality
 */
class NavWorker extends AbstractWorker {
    constructor(selfRef) {
        super(selfRef);

        // Nav worker doesn't need game scripts or GameObject instances
        this.needsGameScripts = false;

        // Scratch buffers (initialized after we know grid size)
        this.scratch = null;

        // Request queues (populated from MessagePort, processed in update)
        this.flowfieldRequests = new Set();
        this.pathRequests = new Map(); // key -> {fromCell, toCell}

        // Grid metadata
        this.gridWidth = 0;
        this.gridHeight = 0;
        this.totalCells = 0;
        this.maxFlowfields = 0;
        this.maxPaths = 0;

        // Performance tracking
        this.flowfieldsComputedThisFrame = 0;
        this.pathsComputedThisFrame = 0;

        // Cache counters (avoid iterating all slots to count)
        this.cachedFlowfieldsCount = 0;
        this.cachedPathsCount = 0;
    }

    /**
     * Initialize the nav worker
     */
    async initialize(data) {
        this.reportLog("initializing navigation worker");

        // Get navigation config
        const navConfig = data.config?.navigation;
        if (!navConfig?.enabled) {
            this.reportLog("navigation disabled, worker will idle");
            return;
        }

        // Check for noLimitFPS setting (defaults to true for nav worker)
        if (navConfig.noLimitFPS !== undefined) {
            this.noLimitFPS = navConfig.noLimitFPS;
        } else {
            this.noLimitFPS = true; // Nav worker runs fast by default
        }

        // Initialize stats buffer for DebugUI
        if (data.buffers?.navigationStats) {
            this.stats = createStatsWriter(data.buffers.navigationStats, NAVIGATION_STATS);
        }

        // Initialize NavGrid from SAB
        if (data.buffers?.navigationData) {
            NavGrid.initialize(data.buffers.navigationData, {
                worldWidth: data.config.worldWidth,
                worldHeight: data.config.worldHeight,
            });

            // Cache grid metadata
            const gridInfo = NavGrid.getGridInfo();
            this.gridWidth = gridInfo.width;
            this.gridHeight = gridInfo.height;
            this.totalCells = gridInfo.totalCells;
            this.maxFlowfields = navConfig.maxFlowfields || 16;
            this.maxPaths = navConfig.maxPaths || 64;

            // Create scratch buffers
            this.scratch = new NavScratch(
                this.totalCells,
                navConfig.maxPathLength || 128
            );

            this.reportLog(
                `initialized with ${this.gridWidth}x${this.gridHeight} grid (${this.totalCells} cells)`
            );
        } else {
            this.reportLog("no navigation buffer provided");
        }
    }

    /**
     * Handle messages from other workers via MessagePort
     * Receives pathfinding requests from logic workers
     */
    handleWorkerMessage(fromWorker, data) {
        const { type } = data;

        switch (type) {
            case "REQUEST_FLOWFIELD": {
                const { targetCell } = data;
                if (targetCell >= 0 && targetCell < this.totalCells) {
                    // Check if flowfield already exists - if so, just update LRU
                    const existingSlot = this._findExistingFlowfieldSlot(targetCell);
                    if (existingSlot >= 0) {
                        this._updateFlowfieldLRU(existingSlot);
                    } else {
                        // Queue for computation
                        this.flowfieldRequests.add(targetCell);
                    }
                }
                break;
            }

            case "REQUEST_PATH": {
                const { fromCell, toCell } = data;
                if (fromCell >= 0 && fromCell < this.totalCells &&
                    toCell >= 0 && toCell < this.totalCells) {
                    // Check if path already exists - if so, just update LRU
                    const existingSlot = this._findExistingPathSlot(fromCell, toCell);
                    if (existingSlot >= 0) {
                        this._updatePathLRU(existingSlot);
                    } else {
                        // Queue for computation (deduplicates via Map key)
                        const key = `${fromCell}_${toCell}`;
                        this.pathRequests.set(key, { fromCell, toCell });
                    }
                }
                break;
            }

            case "REBUILD": {
                // Rebuild walkability grid from static entities
                this.rebuildWalkability(data.staticEntities || []);
                break;
            }

            case "REBUILD_FROM_INDICES": {
                // Rebuild walkability grid from entity indices (reads from component SABs)
                this.rebuildWalkabilityFromIndices(data.entityIndices || []);
                break;
            }
        }
    }

    /**
     * Find existing flowfield slot (without allocating)
     */
    _findExistingFlowfieldSlot(targetCell) {
        const sab = NavGrid._sab;
        const headerOffset = NavGrid._flowfieldHeadersOffset;
        const headerSize = NavGrid._FLOWFIELD_HEADER_SIZE;
        const maxFlowfields = NavGrid._maxFlowfields;

        for (let i = 0; i < maxFlowfields; i++) {
            const offset = headerOffset + (i * headerSize);
            const view = new Uint32Array(sab, offset, 3);
            if (view[0] === targetCell && view[2] === 2) { // 2 = READY
                return i;
            }
        }
        return -1;
    }

    /**
     * Update LRU timestamp for flowfield slot
     */
    _updateFlowfieldLRU(slotIndex) {
        const sab = NavGrid._sab;
        const headerOffset = NavGrid._flowfieldHeadersOffset + (slotIndex * NavGrid._FLOWFIELD_HEADER_SIZE);
        const view = new Uint32Array(sab, headerOffset, 3);
        view[1] = this.frameNumber;
    }

    /**
     * Find existing path slot (without allocating)
     */
    _findExistingPathSlot(fromCell, toCell) {
        const sab = NavGrid._sab;
        const headerOffset = NavGrid._pathHeadersOffset;
        const headerSize = NavGrid._PATH_HEADER_SIZE;
        const maxPaths = NavGrid._maxPaths;

        for (let i = 0; i < maxPaths; i++) {
            const offset = headerOffset + (i * headerSize);
            const view = new Uint32Array(sab, offset, 5);
            if (view[0] === fromCell && view[1] === toCell && view[4] === 2) { // 2 = READY
                return i;
            }
        }
        return -1;
    }

    /**
     * Update LRU timestamp for path slot
     */
    _updatePathLRU(slotIndex) {
        const sab = NavGrid._sab;
        const headerOffset = NavGrid._pathHeadersOffset + (slotIndex * NavGrid._PATH_HEADER_SIZE);
        const view = new Uint32Array(sab, headerOffset, 5);
        view[2] = this.frameNumber;
    }

    /**
     * Update method called each frame
     * Processes queued pathfinding requests in batches
     */
    update(deltaTime, dtRatio, resuming) {
        if (!this.scratch) return;

        // Update NavGrid's frame counter for LRU tracking
        NavGrid._currentFrame = this.frameNumber;

        // Reset frame stats
        this.flowfieldsComputedThisFrame = 0;
        this.pathsComputedThisFrame = 0;

        // Process flowfield requests (higher priority, shared by many entities)
        for (const targetCell of this.flowfieldRequests) {
            this.computeFlowfield(targetCell);
            this.flowfieldsComputedThisFrame++;
        }
        this.flowfieldRequests.clear();

        // Process path requests
        for (const { fromCell, toCell } of this.pathRequests.values()) {
            this.computePath(fromCell, toCell);
            this.pathsComputedThisFrame++;
        }
        this.pathRequests.clear();

        // Write stats to SharedArrayBuffer for DebugUI
        this.reportFPS();
    }

    /**
     * Compute a flowfield using Dijkstra's algorithm with bucket queue
     * O(V) time complexity thanks to bucket queue
     */
    computeFlowfield(targetCell) {
        // Check if we'll use an empty slot (vs evicting an existing one)
        // If empty slot available: count++ after write
        // If evicting: net 0 change (remove one, add one)
        const willUseEmptySlot = this._hasEmptyFlowfieldSlot();

        const scratch = this.scratch;
        scratch.reset();

        const walkability = NavGrid.getWalkabilityArray();
        const gridWidth = this.gridWidth;
        const totalCells = this.totalCells;

        // Initialize distances to max
        scratch.distance.fill(65535);
        scratch.direction.fill(DIRECTION.NONE);

        // Target cell has distance 0
        scratch.distance[targetCell] = 0;
        scratch.bucketQueue[0].push(targetCell);
        scratch.bucketCount = 1;
        scratch.bucketHead = 0;

        // 8-directional neighbors
        const dx = [0, 1, 1, 1, 0, -1, -1, -1];
        const dy = [-1, -1, 0, 1, 1, 1, 0, -1];
        const cost = [10, 14, 10, 14, 10, 14, 10, 14]; // 10 = cardinal, 14 = diagonal (~sqrt(2)*10)
        const oppositeDir = [DIRECTION.S, DIRECTION.SW, DIRECTION.W, DIRECTION.NW,
        DIRECTION.N, DIRECTION.NE, DIRECTION.E, DIRECTION.SE];

        // Dijkstra with bucket queue
        while (scratch.bucketCount > 0) {
            // Find next non-empty bucket
            while (scratch.bucketQueue[scratch.bucketHead].length === 0) {
                scratch.bucketHead++;
                if (scratch.bucketHead > scratch.maxDistance) break;
            }
            if (scratch.bucketHead > scratch.maxDistance) break;

            const cell = scratch.bucketQueue[scratch.bucketHead].pop();
            scratch.bucketCount--;

            if (scratch.isVisited(cell)) continue;
            scratch.markVisited(cell);

            const cellDist = scratch.distance[cell];
            const cellX = cell % gridWidth;
            const cellY = Math.floor(cell / gridWidth);

            // Check all 8 neighbors
            for (let dir = 0; dir < 8; dir++) {
                const nx = cellX + dx[dir];
                const ny = cellY + dy[dir];

                // Bounds check
                if (nx < 0 || nx >= gridWidth || ny < 0 || ny >= this.gridHeight) continue;

                const neighbor = ny * gridWidth + nx;

                // Walkability check
                if (walkability[neighbor] === 0) continue;

                // Already visited?
                if (scratch.isVisited(neighbor)) continue;

                // Calculate new distance
                const newDist = cellDist + cost[dir];
                if (newDist < scratch.distance[neighbor]) {
                    scratch.distance[neighbor] = newDist;
                    scratch.direction[neighbor] = oppositeDir[dir]; // Point towards target

                    // Add to bucket queue
                    const bucket = Math.min(newDist, scratch.maxDistance);
                    scratch.bucketQueue[bucket].push(neighbor);
                    scratch.bucketCount++;
                }
            }
        }

        // Allocate slot and write results
        const slot = NavGrid.allocateFlowfieldSlot(targetCell);
        NavGrid.writeFlowfieldData(slot, scratch.direction);

        // Increment count only if we used an empty slot (not eviction)
        if (willUseEmptySlot) {
            this.cachedFlowfieldsCount++;
        }
    }

    /**
     * Compute A* path between two cells
     */
    computePath(fromCell, toCell) {
        // Check if we'll use an empty slot (vs evicting an existing one)
        const willUseEmptySlot = this._hasEmptyPathSlot();

        const scratch = this.scratch;
        scratch.reset();

        const walkability = NavGrid.getWalkabilityArray();
        const gridWidth = this.gridWidth;
        const gridHeight = this.gridHeight;

        // Clear open set tracking
        scratch.inOpenSet.fill(0);

        // Target coordinates for heuristic
        const targetX = toCell % gridWidth;
        const targetY = Math.floor(toCell / gridWidth);

        // Heuristic function (octile distance)
        const heuristic = (cell) => {
            const cx = cell % gridWidth;
            const cy = Math.floor(cell / gridWidth);
            const dx = Math.abs(cx - targetX);
            const dy = Math.abs(cy - targetY);
            // Octile: 10 * max(dx, dy) + 4 * min(dx, dy) (approximates 14 for diagonal)
            return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy);
        };

        // Initialize start node
        scratch.heapGCost[fromCell] = 0;
        const startH = heuristic(fromCell);
        scratch.heapFCost[fromCell] = startH;
        scratch.cameFrom[fromCell] = fromCell;

        // Binary heap operations
        const heapPush = (cell) => {
            const idx = scratch.heapSize++;
            scratch.heapCell[idx] = cell;
            // Bubble up
            let i = idx;
            while (i > 0) {
                const parent = (i - 1) >> 1;
                if (scratch.heapFCost[scratch.heapCell[i]] < scratch.heapFCost[scratch.heapCell[parent]]) {
                    // Swap
                    const tmp = scratch.heapCell[i];
                    scratch.heapCell[i] = scratch.heapCell[parent];
                    scratch.heapCell[parent] = tmp;
                    i = parent;
                } else {
                    break;
                }
            }
        };

        const heapPop = () => {
            if (scratch.heapSize === 0) return -1;
            const result = scratch.heapCell[0];
            scratch.heapSize--;
            if (scratch.heapSize > 0) {
                scratch.heapCell[0] = scratch.heapCell[scratch.heapSize];
                // Bubble down
                let i = 0;
                while (true) {
                    const left = 2 * i + 1;
                    const right = 2 * i + 2;
                    let smallest = i;
                    if (left < scratch.heapSize &&
                        scratch.heapFCost[scratch.heapCell[left]] < scratch.heapFCost[scratch.heapCell[smallest]]) {
                        smallest = left;
                    }
                    if (right < scratch.heapSize &&
                        scratch.heapFCost[scratch.heapCell[right]] < scratch.heapFCost[scratch.heapCell[smallest]]) {
                        smallest = right;
                    }
                    if (smallest !== i) {
                        const tmp = scratch.heapCell[i];
                        scratch.heapCell[i] = scratch.heapCell[smallest];
                        scratch.heapCell[smallest] = tmp;
                        i = smallest;
                    } else {
                        break;
                    }
                }
            }
            return result;
        };

        // Add start to open set
        heapPush(fromCell);
        scratch.inOpenSet[fromCell] = 1;

        // 8-directional neighbors
        const dx = [0, 1, 1, 1, 0, -1, -1, -1];
        const dy = [-1, -1, 0, 1, 1, 1, 0, -1];
        const cost = [10, 14, 10, 14, 10, 14, 10, 14];

        let found = false;

        while (scratch.heapSize > 0) {
            const current = heapPop();
            scratch.inOpenSet[current] = 0;

            // Found target?
            if (current === toCell) {
                found = true;
                break;
            }

            // Already processed?
            if (scratch.isVisited(current)) continue;
            scratch.markVisited(current);

            const currentG = scratch.heapGCost[current];
            const currentX = current % gridWidth;
            const currentY = Math.floor(current / gridWidth);

            // Check all 8 neighbors
            for (let dir = 0; dir < 8; dir++) {
                const nx = currentX + dx[dir];
                const ny = currentY + dy[dir];

                // Bounds check
                if (nx < 0 || nx >= gridWidth || ny < 0 || ny >= gridHeight) continue;

                const neighbor = ny * gridWidth + nx;

                // Walkability check
                if (walkability[neighbor] === 0) continue;

                // Already in closed set?
                if (scratch.isVisited(neighbor)) continue;

                const tentativeG = currentG + cost[dir];

                // Better path?
                if (!scratch.inOpenSet[neighbor] || tentativeG < scratch.heapGCost[neighbor]) {
                    scratch.cameFrom[neighbor] = current;
                    scratch.heapGCost[neighbor] = tentativeG;
                    scratch.heapFCost[neighbor] = tentativeG + heuristic(neighbor);

                    if (!scratch.inOpenSet[neighbor]) {
                        heapPush(neighbor);
                        scratch.inOpenSet[neighbor] = 1;
                    }
                }
            }
        }

        // Reconstruct path
        let pathLength = 0;
        if (found) {
            // Build path backwards
            let current = toCell;
            while (current !== fromCell && pathLength < scratch.pathResult.length) {
                scratch.pathResult[pathLength++] = current;
                current = scratch.cameFrom[current];
            }
            scratch.pathResult[pathLength++] = fromCell;

            // Reverse path
            for (let i = 0; i < pathLength / 2; i++) {
                const tmp = scratch.pathResult[i];
                scratch.pathResult[i] = scratch.pathResult[pathLength - 1 - i];
                scratch.pathResult[pathLength - 1 - i] = tmp;
            }
        }

        // Allocate slot and write results
        const slot = NavGrid.allocatePathSlot(fromCell, toCell);

        // Create a properly sized array for the path
        const pathCells = [];
        for (let i = 0; i < pathLength; i++) {
            pathCells.push(scratch.pathResult[i]);
        }

        NavGrid.writePathData(slot, pathCells);

        // Increment count only if we used an empty slot (not eviction)
        if (willUseEmptySlot) {
            this.cachedPathsCount++;
        }
    }

    /**
     * Rebuild walkability grid from static entities
     * Called when scene changes (NOT hot path)
     */
    rebuildWalkability(staticEntities) {
        if (!this.scratch) return;

        const walkability = NavGrid.getWalkabilityArray();
        const cellSize = NavGrid._cellSize;
        const gridWidth = this.gridWidth;
        const gridHeight = this.gridHeight;

        // Start with all cells walkable
        walkability.fill(1);

        // Mark cells occupied by static entities as blocked
        for (let i = 0; i < staticEntities.length; i++) {
            const entity = staticEntities[i];
            const { x, y, width, height } = entity;

            // Calculate cell range
            const startCellX = Math.floor(x / cellSize);
            const startCellY = Math.floor(y / cellSize);
            const endCellX = Math.ceil((x + (width || cellSize)) / cellSize);
            const endCellY = Math.ceil((y + (height || cellSize)) / cellSize);

            for (let cy = startCellY; cy < endCellY; cy++) {
                for (let cx = startCellX; cx < endCellX; cx++) {
                    if (cx >= 0 && cx < gridWidth && cy >= 0 && cy < gridHeight) {
                        const cellId = cy * gridWidth + cx;
                        walkability[cellId] = 0; // blocked
                    }
                }
            }
        }

        // Invalidate all cached paths and flowfields
        NavGrid.invalidate();

        // Reset cache counters
        this.cachedFlowfieldsCount = 0;
        this.cachedPathsCount = 0;

        this.reportLog(`rebuilt walkability grid, ${staticEntities.length} static entities`);
    }

    /**
     * Rebuild walkability grid from entity indices
     * Reads positions from Transform component and sizes from Collider component
     * Handles both circle and box colliders via ColliderUtils
     * Called when entities change (NOT hot path)
     */
    rebuildWalkabilityFromIndices(entityIndices) {
        if (!this.scratch) return;

        const walkability = NavGrid.getWalkabilityArray();
        const cellSize = NavGrid._cellSize;
        const gridWidth = this.gridWidth;
        const gridHeight = this.gridHeight;

        // Pre-compute invariants outside loop (performance)
        const invCellSize = 1 / cellSize;
        const maxCol = gridWidth - 1;
        const maxRow = gridHeight - 1;

        // Start with all cells walkable
        walkability.fill(1);

        // Mark cells occupied by entities as blocked
        for (let i = 0; i < entityIndices.length; i++) {
            const idx = entityIndices[i];

            // Get collider bounds (handles circles, boxes, and offsets)
            getColliderBounds(idx, _boundsResult);

            // Calculate cell range covered by this collider
            getCellRange(
                _boundsResult.posX, _boundsResult.posY,
                _boundsResult.halfW, _boundsResult.halfH,
                invCellSize, maxCol, maxRow, _cellRangeResult
            );

            // Mark all cells in range as blocked
            for (let row = _cellRangeResult.minRow; row <= _cellRangeResult.maxRow; row++) {
                for (let col = _cellRangeResult.minCol; col <= _cellRangeResult.maxCol; col++) {
                    walkability[row * gridWidth + col] = 0; // blocked
                }
            }
        }

        // Invalidate all cached paths and flowfields
        NavGrid.invalidate();

        // Reset cache counters
        this.cachedFlowfieldsCount = 0;
        this.cachedPathsCount = 0;

        this.reportLog(`rebuilt walkability from ${entityIndices.length} entity indices`);
    }

    /**
     * Check if there's an empty flowfield slot available
     * Used to determine if we'll add to cache (empty slot) vs evict (no empty)
     */
    _hasEmptyFlowfieldSlot() {
        if (!NavGrid._initialized) return false;

        const sab = NavGrid._sab;
        const headerOffset = NavGrid._flowfieldHeadersOffset;
        const headerSize = NavGrid._FLOWFIELD_HEADER_SIZE;

        for (let i = 0; i < this.maxFlowfields; i++) {
            const offset = headerOffset + (i * headerSize);
            const view = new Uint32Array(sab, offset, 3);
            if (view[2] === 0) return true; // 0 = EMPTY
        }
        return false;
    }

    /**
     * Check if there's an empty path slot available
     */
    _hasEmptyPathSlot() {
        if (!NavGrid._initialized) return false;

        const sab = NavGrid._sab;
        const headerOffset = NavGrid._pathHeadersOffset;
        const headerSize = NavGrid._PATH_HEADER_SIZE;

        for (let i = 0; i < this.maxPaths; i++) {
            const offset = headerOffset + (i * headerSize);
            const view = new Uint32Array(sab, offset, 5);
            if (view[4] === 0) return true; // 0 = EMPTY
        }
        return false;
    }

    /**
     * Get cached flowfields count
     */
    _countCachedFlowfields() {
        return this.cachedFlowfieldsCount;
    }

    /**
     * Get cached paths count
     */
    _countCachedPaths() {
        return this.cachedPathsCount;
    }

    /**
     * Override reportFPS to write navigation-specific stats to SharedArrayBuffer
     */
    reportFPS() {
        if (!this.stats) return;

        this.stats[NAVIGATION_STATS.FPS] = this.currentFPS;
        this.stats[NAVIGATION_STATS.FLOWFIELDS_COMPUTED] = this.flowfieldsComputedThisFrame;
        this.stats[NAVIGATION_STATS.PATHS_COMPUTED] = this.pathsComputedThisFrame;
        this.stats[NAVIGATION_STATS.FLOWFIELDS_CACHED] = this._countCachedFlowfields();
        this.stats[NAVIGATION_STATS.PATHS_CACHED] = this._countCachedPaths();
        this.stats[NAVIGATION_STATS.PENDING_FLOWFIELDS] = this.flowfieldRequests.size;
        this.stats[NAVIGATION_STATS.PENDING_PATHS] = this.pathRequests.size;
        this.stats[NAVIGATION_STATS.GRID_WIDTH] = this.gridWidth;
        this.stats[NAVIGATION_STATS.GRID_HEIGHT] = this.gridHeight;
    }
}

// Create singleton instance
self.navWorker = new NavWorker(self);
