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
export const RENDERER_STATS = Object.freeze({
  FPS: 0,
  DRAW_CALLS: 1,
  VISIBLE_SPRITES: 2,
  SPRITES_CREATED: 3,
  DECORATION_SPRITES: 4,
  VISIBLE_DECORATIONS: 5,
  VISIBLE_ENTITIES: 6,
  VISIBLE_PARTICLES: 7,
  ACTIVE_DECORATIONS: 8,
  MSG_MS: 9,
  STRIDE_FLOATS: 16,
  BUFFER_SIZE: 16 * 4,
});

/**
 * Particle Worker Stats Schema
 * Single particle worker with particle counts
 */
export const PARTICLE_STATS = Object.freeze({
  FPS: 0,
  ACTIVE_PARTICLES: 1,
  TOTAL_PARTICLES: 2,
  PARTICLES_STAMPED: 3,
  FLASHES_UPDATED: 4,
  SHADOWS_UPDATED: 5,
  ACTIVE_ENTITIES: 6,
  TOTAL_ENTITIES: 7,
  MSG_MS: 8,
  BUILD_ACTIVE_VISIBLE_MS: 9,
  PARTICLE_PHYSICS_MS: 10,
  STRIDE_FLOATS: 16,
  BUFFER_SIZE: 16 * 4,
});

/**
 * Physics Worker Stats Schema
 * Single physics worker with collision metrics
 */
export const PHYSICS_STATS = Object.freeze({
  FPS: 0,
  COLLISION_CHECKS: 1,
  COLLISIONS_RESOLVED: 2,
  COLLISION_PAIRS: 3,
  CONSTRAINT_MS: 4,
  MSG_MS: 5,
  MOVE_MS: 6,
  COLLISION_MS: 7,
  STRIDE_FLOATS: 16,
  BUFFER_SIZE: 16 * 4,
});

/**
 * Spatial Worker Stats Schema (Multi-worker)
 * Multiple spatial workers with neighbor query metrics
 */
export const SPATIAL_STATS = Object.freeze({
  FPS: 0,
  NEIGHBOR_CHECKS: 1,
  GRID_CELLS_CHECKED: 2,
  ENTITIES_PROCESSED: 3,
  REBUILD_MS: 4,
  NEIGHBOR_MS: 5,
  MSG_MS: 6,
  STRIDE_FLOATS: 16,
  BUFFER_SIZE_PER_WORKER: 16 * 4,
});

/**
 * Logic Worker Stats Schema (Multi-worker)
 * Multiple logic workers with system execution metrics
 */
export const LOGIC_STATS = Object.freeze({
  FPS: 0,
  ENTITIES_PROCESSED: 1,
  SYSTEMS_EXECUTED: 2,
  MSG_MS: 3,
  STRIDE_FLOATS: 16,
  BUFFER_SIZE_PER_WORKER: 16 * 4,
});

/**
 * Navigation Worker Stats Schema (DEPRECATED - merged into particle_worker)
 * Kept for backwards compatibility, now handled by particle_worker
 */
export const NAVIGATION_STATS = Object.freeze({
  FPS: 0,
  FLOWFIELDS_COMPUTED: 1,
  PATHS_COMPUTED: 2,
  FLOWFIELDS_CACHED: 3,
  PATHS_CACHED: 4,
  PENDING_FLOWFIELDS: 5,
  PENDING_PATHS: 6,
  GRID_WIDTH: 7,
  GRID_HEIGHT: 8,
  SHADOWS_UPDATED: 9,
  STRIDE_FLOATS: 16,
  BUFFER_SIZE: 16 * 4,
});

/**
 * Pre-Render Worker Stats Schema
 * Single pre-render worker with visibility and render queue metrics
 */
export const PRE_RENDER_STATS = Object.freeze({
  FPS: 0,
  VISIBLE_ENTITIES: 1,
  VISIBLE_PARTICLES: 2,
  VISIBLE_DECORATIONS: 3,
  SHADOWS_UPDATED: 4,
  RENDER_QUEUE_SIZE: 5,
  MSG_MS: 6,
  SKIPPED_FRAMES: 7,
  STRIDE_FLOATS: 16,
  BUFFER_SIZE: 16 * 4,
});

/**
 * Display configuration for worker stats
 * Defines which stats to show in DebugUI and how to format them
 */
export const WORKER_DISPLAY_CONFIG = Object.freeze({
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
      {
        key: 'MSG_MS',
        format: (v) => v.toFixed(2) + 'ms',
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
      {
        key: 'MSG_MS',
        format: (v) => v.toFixed(2) + 'ms',
      },
      {
        key: 'BUILD_ACTIVE_VISIBLE_MS',
        format: (v) => v.toFixed(2) + 'ms',
      },
      {
        key: 'PARTICLE_PHYSICS_MS',
        format: (v) => v.toFixed(2) + 'ms',
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
      {
        key: 'CONSTRAINT_MS',
        format: (v) => v.toFixed(2) + 'ms',
      },
      {
        key: 'MSG_MS',
        format: (v) => v.toFixed(2) + 'ms',
      },
      {
        key: 'MOVE_MS',
        format: (v) => v.toFixed(2) + 'ms',
      },
      {
        key: 'COLLISION_MS',
        format: (v) => v.toFixed(2) + 'ms',
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
      {
        key: 'REBUILD_MS',
        format: (v) => v.toFixed(2) + 'ms',
      },
      {
        key: 'NEIGHBOR_MS',
        format: (v) => v.toFixed(2) + 'ms',
      },
      {
        key: 'MSG_MS',
        format: (v) => v.toFixed(2) + 'ms',
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
      {
        key: 'MSG_MS',
        format: (v) => v.toFixed(2) + 'ms',
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
  preRender: {
    label: 'PreRender',
    color: 'preRender',
    stats: [
      { key: 'FPS', format: (v) => v.toFixed(2) },
      {
        key: 'VISIBLE_ENTITIES',
        format: (v) => formatNumber(v),
        label: 'Vis Entities',
      },
      {
        key: 'VISIBLE_PARTICLES',
        format: (v) => formatNumber(v),
        label: 'Vis Particles',
      },
      {
        key: 'SHADOWS_UPDATED',
        format: (v) => formatNumber(v),
        label: 'Shadows',
      },
      {
        key: 'RENDER_QUEUE_SIZE',
        format: (v) => formatNumber(v),
        label: 'Queue Size',
      },
      {
        key: 'SKIPPED_FRAMES',
        format: (v) => formatNumber(v),
        label: 'Skipped',
      },
      {
        key: 'MSG_MS',
        format: (v) => v.toFixed(2) + 'ms',
      },
    ],
  },
});

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
