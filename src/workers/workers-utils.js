// workers-utils.js - Shared utilities and schemas for worker statistics
// Single source of truth for stat buffer layouts across all workers

/**
 * Format a number with underscore thousand separators
 * @param {number} num - Number to format
 * @returns {string} Formatted number (e.g., "1_000_000")
 */
function formatNumber(num) {
  if (num === null || num === undefined || Number.isNaN(num)) return '--';
  const rounded = Math.round(num);
  return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}

/**
 * Renderer Worker Stats Schema
 * Single renderer worker with draw call and visibility metrics
 */
export const RENDERER_STATS = {
  FPS: 0,
  DRAW_CALLS: 1,
  VISIBLE_SPRITES: 2, // Total visible sprites (entities + particles + decorations)
  SPRITES_CREATED: 3, // Total PIXI.Particle objects created (from centralized pool)
  DECORATION_SPRITES: 4, // For DebugUI decoration stats (same as SPRITES_CREATED)
  VISIBLE_DECORATIONS: 5, // For DebugUI decoration stats
  VISIBLE_ENTITIES: 6, // Visible GameObjects (not particles/decorations)
  VISIBLE_PARTICLES: 7, // Visible particles only
  ACTIVE_DECORATIONS: 8, // Active decorations (from DecorationComponent.active loop)
  // Reserve space for future stats
  STRIDE_FLOATS: 16, // 64 bytes = 1 cache line
  BUFFER_SIZE: 16 * 4, // 64 bytes
};

/**
 * Particle Worker Stats Schema
 * Single particle worker with particle counts
 */
export const PARTICLE_STATS = {
  FPS: 0,
  ACTIVE_PARTICLES: 1,
  TOTAL_PARTICLES: 2,
  PARTICLES_STAMPED: 3,
  FLASHES_UPDATED: 4,
  SHADOWS_UPDATED: 5,
  ACTIVE_ENTITIES: 6, // Active GameObjects (from buildActiveEntityList)
  TOTAL_ENTITIES: 7, // Total entity pool size
  // Reserve space for future stats
  STRIDE_FLOATS: 16,
  BUFFER_SIZE: 16 * 4,
};

/**
 * Physics Worker Stats Schema
 * Single physics worker with collision metrics
 */
export const PHYSICS_STATS = {
  FPS: 0,
  COLLISION_CHECKS: 1,
  COLLISIONS_RESOLVED: 2,
  COLLISION_PAIRS: 3,
  // Reserve space for future stats
  STRIDE_FLOATS: 16,
  BUFFER_SIZE: 16 * 4,
};

/**
 * Spatial Worker Stats Schema (Multi-worker)
 * Multiple spatial workers with neighbor query metrics
 */
export const SPATIAL_STATS = {
  FPS: 0,
  NEIGHBOR_CHECKS: 1,
  GRID_CELLS_CHECKED: 2,
  ENTITIES_PROCESSED: 3,
  // Reserve space for future stats
  STRIDE_FLOATS: 16, // Each worker gets 64 bytes
  BUFFER_SIZE_PER_WORKER: 16 * 4,
};

/**
 * Logic Worker Stats Schema (Multi-worker)
 * Multiple logic workers with system execution metrics
 */
export const LOGIC_STATS = {
  FPS: 0,
  ENTITIES_PROCESSED: 1,
  SYSTEMS_EXECUTED: 2,
  // Reserve space for future stats
  STRIDE_FLOATS: 16, // Each worker gets 64 bytes
  BUFFER_SIZE_PER_WORKER: 16 * 4,
};

/**
 * Navigation Worker Stats Schema
 * Single navigation worker with pathfinding metrics
 */
export const NAVIGATION_STATS = {
  FPS: 0,
  FLOWFIELDS_COMPUTED: 1, // Flowfields calculated this frame
  PATHS_COMPUTED: 2, // A* paths calculated this frame
  FLOWFIELDS_CACHED: 3, // Total flowfields in cache
  PATHS_CACHED: 4, // Total A* paths in cache
  PENDING_FLOWFIELDS: 5, // Flowfield requests waiting
  PENDING_PATHS: 6, // Path requests waiting
  GRID_WIDTH: 7, // Grid dimensions for reference
  GRID_HEIGHT: 8,
  // Reserve space for future stats
  STRIDE_FLOATS: 16,
  BUFFER_SIZE: 16 * 4,
};

/**
 * Display configuration for worker stats
 * Defines which stats to show in DebugUI and how to format them
 */
export const WORKER_DISPLAY_CONFIG = {
  renderer: {
    label: 'Render',
    color: 'renderer',
    stats: [
      { key: 'FPS', format: (v) => v.toFixed(2) },
      { key: 'DRAW_CALLS', format: (v) => formatNumber(v) },
      {
        key: 'SPRITES_CREATED',
        format: (v) => formatNumber(v),
      },
      {
        key: 'VISIBLE_SPRITES',
        format: (v) => formatNumber(v),
      },
    ],
  },
  particle: {
    label: 'Particle',
    color: 'particle',
    stats: [
      { key: 'FPS', format: (v) => v.toFixed(2) },
      {
        key: 'PARTICLES_STAMPED',
        format: (v) => formatNumber(v),
      },
      {
        key: 'FLASHES_UPDATED',
        format: (v) => formatNumber(v),
      },
      {
        key: 'SHADOWS_UPDATED',
        format: (v) => formatNumber(v),
      },
    ],
  },
  physics: {
    label: 'Physics',
    color: 'physics',
    stats: [
      { key: 'FPS', format: (v) => v.toFixed(2) },
      {
        key: 'COLLISION_CHECKS',
        format: (v) => formatNumber(v),
      },
      {
        key: 'COLLISIONS_RESOLVED',
        format: (v) => formatNumber(v),
      },
      {
        key: 'COLLISION_PAIRS',
        format: (v) => formatNumber(v),
      },
    ],
  },
  spatial: {
    label: 'Spatial',
    color: 'spatial',
    stats: [
      { key: 'FPS', format: (v) => v.toFixed(2) },
      {
        key: 'NEIGHBOR_CHECKS',
        format: (v) => formatNumber(v),
      },
      {
        key: 'GRID_CELLS_CHECKED',
        format: (v) => formatNumber(v),
      },
      {
        key: 'ENTITIES_PROCESSED',
        format: (v) => formatNumber(v),
      },
    ],
  },
  logic: {
    label: 'Logic',
    color: 'logic',
    stats: [
      { key: 'FPS', format: (v) => v.toFixed(2) },
      {
        key: 'ENTITIES_PROCESSED',
        format: (v) => formatNumber(v),
      },
    ],
  },
  navigation: {
    label: 'NavGrid',
    color: 'navigation',
    stats: [
      { key: 'FPS', format: (v) => v.toFixed(2) },
      {
        key: 'FLOWFIELDS_COMPUTED',
        format: (v) => formatNumber(v),
        label: 'FF/frame',
      },
      {
        key: 'PATHS_COMPUTED',
        format: (v) => formatNumber(v),
        label: 'A*/frame',
      },
      {
        key: 'FLOWFIELDS_CACHED',
        format: (v) => formatNumber(v),
        label: 'FF cached',
      },
      {
        key: 'PATHS_CACHED',
        format: (v) => formatNumber(v),
        label: 'A* cached',
      },
    ],
  },
};

/**
 * Create a stats writer view for a single worker
 * @param {SharedArrayBuffer} buffer - The stats buffer
 * @param {Object} statsSchema - Schema object (e.g., RENDERER_STATS)
 * @returns {Float32Array} Typed array view for writing stats
 */
export function createStatsWriter(buffer, statsSchema) {
  return new Float32Array(buffer, 0, statsSchema.STRIDE_FLOATS);
}

/**
 * Create a stats writer view for a multi-worker buffer (strided access)
 * @param {SharedArrayBuffer} buffer - The stats buffer
 * @param {Object} statsSchema - Schema object (e.g., SPATIAL_STATS)
 * @param {number} workerIndex - Index of this worker (0-based)
 * @returns {Float32Array} Typed array view for writing stats
 */
export function createMultiWorkerStatsWriter(buffer, statsSchema, workerIndex) {
  const offset = workerIndex * statsSchema.STRIDE_FLOATS;
  return new Float32Array(
    buffer,
    offset * 4, // byte offset
    statsSchema.STRIDE_FLOATS // length in floats
  );
}

/**
 * Create stats reader views for all workers in a multi-worker buffer
 * @param {SharedArrayBuffer} buffer - The stats buffer
 * @param {Object} statsSchema - Schema object (e.g., SPATIAL_STATS)
 * @param {number} workerCount - Number of workers
 * @returns {Float32Array[]} Array of typed array views for reading stats
 */
export function createMultiWorkerStatsReaderArray(buffer, statsSchema, workerCount) {
  const views = [];
  for (let i = 0; i < workerCount; i++) {
    const offset = i * statsSchema.STRIDE_FLOATS;
    views.push(new Float32Array(buffer, offset * 4, statsSchema.STRIDE_FLOATS));
  }
  return views;
}

/**
 * Create a stats reader view for a single worker
 * @param {SharedArrayBuffer} buffer - The stats buffer
 * @param {Object} statsSchema - Schema object (e.g., RENDERER_STATS)
 * @returns {Float32Array} Typed array view for reading stats
 */
export function createStatsReader(buffer, statsSchema) {
  return new Float32Array(buffer, 0, statsSchema.STRIDE_FLOATS);
}

/**
 * Calculate which cells an entity spans based on its position and half-extent
 * Pure function, zero allocation, writes result to provided Int32Array
 *
 * @param {number} posX - Entity center X position
 * @param {number} posY - Entity center Y position
 * @param {number} halfW - Half width of entity bounding box
 * @param {number} halfH - Half height of entity bounding box
 * @param {number} invCellSize - Inverse of cell size (1 / cellSize)
 * @param {number} gridWidth - Grid width in cells
 * @param {number} gridHeight - Grid height in cells
 * @param {Int32Array} result - Pre-allocated array to write [minCol, maxCol, minRow, maxRow]
 * @returns {boolean} True if entity spans at least one cell, false otherwise
 */
export function getEntityCellRange(posX, posY, halfW, halfH, invCellSize, gridWidth, gridHeight, result) {
  // Calculate cell range this entity's bounding box covers
  let minCol = ((posX - halfW) * invCellSize) | 0;
  let maxCol = ((posX + halfW) * invCellSize) | 0;
  let minRow = ((posY - halfH) * invCellSize) | 0;
  let maxRow = ((posY + halfH) * invCellSize) | 0;

  // Clamp to grid bounds
  const maxColBound = gridWidth - 1;
  const maxRowBound = gridHeight - 1;
  minCol = minCol < 0 ? 0 : minCol > maxColBound ? maxColBound : minCol;
  maxCol = maxCol < 0 ? 0 : maxCol > maxColBound ? maxColBound : maxCol;
  minRow = minRow < 0 ? 0 : minRow > maxRowBound ? maxRowBound : minRow;
  maxRow = maxRow < 0 ? 0 : maxRow > maxRowBound ? maxRowBound : maxRow;

  // Write to result array
  result[0] = minCol;
  result[1] = maxCol;
  result[2] = minRow;
  result[3] = maxRow;

  // Return true if entity spans at least one cell
  return minCol <= maxCol && minRow <= maxRow;
}

/**
 * Check if all cells an entity spans are sleeping
 * Pure function, zero allocation
 *
 * @param {number} minCol - Minimum column index entity spans
 * @param {number} maxCol - Maximum column index entity spans
 * @param {number} minRow - Minimum row index entity spans
 * @param {number} maxRow - Maximum row index entity spans
 * @param {number} gridWidth - Grid width in cells
 * @param {Uint8Array} cellSleepingData - Cell sleeping state array (0=awake, 1=sleeping)
 * @returns {boolean} True if ALL cells entity spans are sleeping, false otherwise
 */
export function areAllEntityCellsSleeping(minCol, maxCol, minRow, maxRow, gridWidth, cellSleepingData) {
  // Iterate through all cells entity spans
  for (let row = minRow; row <= maxRow; row++) {
    const rowBase = row * gridWidth;
    for (let col = minCol; col <= maxCol; col++) {
      const cellIndex = rowBase + col;
      // If any cell is awake, entity is not fully in sleeping cells
      if (cellSleepingData[cellIndex] === 0) {
        return false;
      }
    }
  }
  // All cells are sleeping
  return true;
}

/**
 * Get the cell index containing an entity's center position
 * Pure function, zero allocation
 *
 * @param {number} posX - Entity center X position
 * @param {number} posY - Entity center Y position
 * @param {number} invCellSize - Inverse of cell size (1 / cellSize)
 * @param {number} gridWidth - Grid width in cells
 * @param {number} gridHeight - Grid height in cells
 * @returns {number} Cell index containing entity center, or -1 if out of bounds
 */
export function getEntityHomeCellIndex(posX, posY, invCellSize, gridWidth, gridHeight) {
  const col = (posX * invCellSize) | 0;
  const row = (posY * invCellSize) | 0;

  // Clamp to grid bounds
  const maxCol = gridWidth - 1;
  const maxRow = gridHeight - 1;
  const clampedCol = col < 0 ? 0 : col > maxCol ? maxCol : col;
  const clampedRow = row < 0 ? 0 : row > maxRow ? maxRow : row;

  // Check if out of bounds
  if (col < 0 || col > maxCol || row < 0 || row > maxRow) {
    return -1;
  }

  return clampedRow * gridWidth + clampedCol;
}
