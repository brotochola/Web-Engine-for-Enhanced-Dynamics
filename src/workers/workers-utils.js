// workers-utils.js - Shared utilities and schemas for worker statistics
// Single source of truth for stat buffer layouts across all workers

/**
 * Format a number with underscore thousand separators
 * @param {number} num - Number to format
 * @returns {string} Formatted number (e.g., "1_000_000")
 */
function formatNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return "--";
  const rounded = Math.round(num);
  return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_");
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
  JOBS_STOLEN: 3,
  // Reserve space for future stats
  STRIDE_FLOATS: 16, // Each worker gets 64 bytes
  BUFFER_SIZE_PER_WORKER: 16 * 4,
};

/**
 * Display configuration for worker stats
 * Defines which stats to show in DebugUI and how to format them
 */
export const WORKER_DISPLAY_CONFIG = {
  renderer: {
    label: "Render",
    color: "renderer",
    stats: [
      { key: "FPS", format: (v) => v.toFixed(2) },
      { key: "DRAW_CALLS", format: (v) => formatNumber(v) },
      {
        key: "SPRITES_CREATED",
        format: (v) => formatNumber(v),
      },
      {
        key: "VISIBLE_SPRITES",
        format: (v) => formatNumber(v),
      },
    ],
  },
  particle: {
    label: "Particle",
    color: "particle",
    stats: [
      { key: "FPS", format: (v) => v.toFixed(2) },
      {
        key: "PARTICLES_STAMPED",
        format: (v) => formatNumber(v),
      },
      {
        key: "FLASHES_UPDATED",
        format: (v) => formatNumber(v),
      },
      {
        key: "SHADOWS_UPDATED",
        format: (v) => formatNumber(v),
      },
    ],
  },
  physics: {
    label: "Physics",
    color: "physics",
    stats: [
      { key: "FPS", format: (v) => v.toFixed(2) },
      {
        key: "COLLISION_CHECKS",
        format: (v) => formatNumber(v),
      },
      {
        key: "COLLISIONS_RESOLVED",
        format: (v) => formatNumber(v),
      },
      {
        key: "COLLISION_PAIRS",
        format: (v) => formatNumber(v),
      },
    ],
  },
  spatial: {
    label: "Spatial",
    color: "spatial",
    stats: [
      { key: "FPS", format: (v) => v.toFixed(2) },
      {
        key: "NEIGHBOR_CHECKS",
        format: (v) => formatNumber(v),
      },
      {
        key: "GRID_CELLS_CHECKED",
        format: (v) => formatNumber(v),
      },
      {
        key: "ENTITIES_PROCESSED",
        format: (v) => formatNumber(v),
      },
    ],
  },
  logic: {
    label: "Logic",
    color: "logic",
    stats: [
      { key: "FPS", format: (v) => v.toFixed(2) },
      {
        key: "ENTITIES_PROCESSED",
        format: (v) => formatNumber(v),
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
export function createMultiWorkerStatsReaderArray(
  buffer,
  statsSchema,
  workerCount
) {
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
